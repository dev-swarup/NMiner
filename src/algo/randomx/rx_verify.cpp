#include <cstring>
#include <algorithm>

#include "rx_verify.h"

RxVerify::RxVerify(const Napi::CallbackInfo &info) : Napi::ObjectWrap<RxVerify>(info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsObject())
    {
        Napi::Error::New(env, "Expected an Rx instance").ThrowAsJavaScriptException();
        return;
    };

    rx = Rx::Unwrap(info[0].As<Napi::Object>());
    rx_ref = Napi::Persistent(info[0].As<Napi::Object>());

    uint32_t count = (info.Length() > 1 && info[1].IsNumber()) ? info[1].As<Napi::Number>().Uint32Value() : 0u;
    if (count == 0)
    {
        const uint32_t hw = std::thread::hardware_concurrency();
        count = std::max<uint32_t>(1u, hw > 4 ? hw / 4 : 1u);
    };

    m_state = std::make_shared<State>();
    m_state->tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function::New(env, [](const Napi::CallbackInfo &) {}), "verify", 0, 1, [](Napi::Env) {});

    m_state->tsfn.Unref(env);

    m_env = env;
    napi_add_env_cleanup_hook(env, &RxVerify::CleanupTsfn, this);

    m_active.store(true, std::memory_order_relaxed);
    for (uint32_t i = 0; i < count; ++i) m_threads.emplace_back(&RxVerify::Loop, this, 0u);
};

void RxVerify::CleanupTsfn(void *arg)
{
    static_cast<RxVerify *>(arg)->ReleaseTsfn();
};

void RxVerify::ReleaseTsfn()
{
    if (m_released.exchange(true, std::memory_order_relaxed))
        return;

    StopLoop();
    if (m_state && m_state->tsfn) m_state->tsfn.Abort();
};

RxVerify::~RxVerify()
{
    if (m_env && !m_released.load(std::memory_order_relaxed))
        napi_remove_env_cleanup_hook(m_env, &RxVerify::CleanupTsfn, this);

    ReleaseTsfn();
};

Napi::Object RxVerify::Init(Napi::Env env, Napi::Object exports)
{
    Napi::Function Fn = DefineClass(env, "RxVerify",
    {
        InstanceMethod("stop", &RxVerify::Stop),
        InstanceMethod("verify", &RxVerify::Verify),
        InstanceMethod("pending", &RxVerify::Pending)
    });

    exports.Set("RxVerify", Fn);
    return exports;
};

Napi::Value RxVerify::Verify(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    auto deferred = Napi::Promise::Deferred::New(env);

    if (info.Length() < 5 || !info[0].IsBuffer() || !info[1].IsBuffer() || !info[2].IsBuffer() || !info[3].IsBuffer() || !info[4].IsBuffer())
    {
        deferred.Reject(Napi::Error::New(env, "Expected (blob, nonce, result, miner_target, pool_target)").Value());
        return deferred.Promise();
    };

    auto blob = ToVector(info[0].As<Napi::Buffer<uint8_t>>());
    const auto nonce = ToVector(info[1].As<Napi::Buffer<uint8_t>>());
    const auto result = ToVector(info[2].As<Napi::Buffer<uint8_t>>());

    if (blob.size() <= kNonceOffset + 4 || nonce.size() < 4 || result.size() < RANDOMX_HASH_SIZE)
    {
        deferred.Reject(Napi::Error::New(env, "Invalid blob, nonce or result length").Value());
        return deferred.Promise();
    };

    if (blob.size() > kMaxBlobSize) blob.resize(kMaxBlobSize);

    Task *task = new Task { blob, {}, {}, ParseTarget(ToVector(info[3].As<Napi::Buffer<uint8_t>>())), ParseTarget(ToVector(info[4].As<Napi::Buffer<uint8_t>>())), 0u, m_state, deferred };

    std::memcpy(task->nonce, nonce.data(), sizeof(task->nonce));
    std::memcpy(task->result, result.data(), sizeof(task->result));

    {
        std::lock_guard<std::mutex> lock(m_mutex);

        if (!m_active.load(std::memory_order_relaxed) || m_queue.size() >= kVerifyQueueLimit)
        {
            delete task;

            deferred.Resolve(Napi::Number::New(env, kVerifySkipped));
            return deferred.Promise();
        };

        if (m_state->inflight.fetch_add(1, std::memory_order_relaxed) == 0)
            m_state->tsfn.Ref(env);

        m_queue.push_back(task);
    };

    m_cv.notify_one();
    return deferred.Promise();
};

Napi::Value RxVerify::Pending(const Napi::CallbackInfo &info)
{
    std::lock_guard<std::mutex> lock(m_mutex);
    return Napi::Number::New(info.Env(), static_cast<double>(m_queue.size()));
};

Napi::Value RxVerify::Stop(const Napi::CallbackInfo &info)
{
    StopLoop();
    return info.Env().Undefined();
};

void RxVerify::StopLoop()
{
    if (!m_active.exchange(false, std::memory_order_relaxed))
        return;

    m_cv.notify_all();

    for (auto &t : m_threads)
        if (t.joinable()) t.join();

    m_threads.clear();

    std::deque<Task *> leftover;
    {
        std::lock_guard<std::mutex> lock(m_mutex);
        leftover.swap(m_queue);
    };

    for (Task *task : leftover)
    {
        task->flags = kVerifySkipped;
        Settle(task);
    };
};

void RxVerify::Settle(Task *task)
{
    const napi_status status = m_state->tsfn.BlockingCall(task, [](Napi::Env env, Napi::Function, Task *task)
    {
        task->deferred.Resolve(Napi::Number::New(env, task->flags));

        if (task->state->inflight.fetch_sub(1, std::memory_order_relaxed) == 1)
            task->state->tsfn.Unref(env);

        delete task;
    });

    if (status != napi_ok)
    {
        task->state->inflight.fetch_sub(1, std::memory_order_relaxed);
        delete task;
    };
};

void RxVerify::Loop(uint32_t numa_node)
{
    std::shared_ptr<RxVm> vm;

    while (m_active.load(std::memory_order_relaxed))
    {
        Task *task = nullptr;
        {
            std::unique_lock<std::mutex> lock(m_mutex);

            m_cv.wait_for(lock, std::chrono::milliseconds(250), [&]
            { 
                return !m_active.load(std::memory_order_relaxed) || !m_queue.empty(); 
            });

            if (!m_active.load(std::memory_order_relaxed))
                break;

            if (!m_queue.empty())
            {
                task = m_queue.front();
                m_queue.pop_front();
            };
        };

        if (rx->updating.load(std::memory_order_acquire))
        {
            vm.reset();

            if (task)
            {
                task->flags = kVerifySkipped;
                Settle(task);
            };

            continue;
        };

        if (!task)
            continue;

        if (!vm)
        {
            vm = rx->create_vm(numa_node);

            if (!vm)
            {
                task->flags = kVerifySkipped;
                Settle(task);

                continue;
            };
        };

        std::memcpy(task->blob.data() + kNonceOffset, task->nonce, sizeof(task->nonce));

        uint8_t hash[RANDOMX_HASH_SIZE];
        randomx_calculate_hash(vm->vm, task->blob.data(), task->blob.size(), hash);

        uint32_t flags = 0;
        if (std::memcmp(hash, task->result, RANDOMX_HASH_SIZE) == 0)
            flags |= kVerifyMatched;

        const uint64_t value = read_unaligned(reinterpret_cast<const uint64_t *>(hash + 24));

        if (task->miner_target && value <= task->miner_target)
            flags |= kVerifyMinerTarget;

        if (task->pool_target && value <= task->pool_target)
            flags |= kVerifyPoolTarget;

        task->flags = flags;
        Settle(task);
    };

    vm.reset();
};