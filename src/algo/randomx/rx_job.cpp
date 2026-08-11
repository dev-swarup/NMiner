#include <cstring>
#include <algorithm>

#include "rx_job.h"

static uint32_t read_txn_count(const uint8_t *blob, size_t size)
{
    constexpr size_t offset = 75;
    uint32_t count = 0;

    for (size_t i = offset, shift = 0; i < size && i < offset + 4; ++i, shift += 7)
    {
        count |= static_cast<uint32_t>(blob[i] & 0x7Fu) << shift;
        if (!(blob[i] & 0x80u)) break;
    };

    return count;
};

RxJob::RxJob(const Napi::CallbackInfo &info) : Napi::ObjectWrap<RxJob>(info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction())
    {
        Napi::Error::New(env, "Expected Rx instance and submit callback").ThrowAsJavaScriptException();
        return;
    }

    rx = Rx::Unwrap(info[0].As<Napi::Object>());
    rx_ref = Napi::Persistent(info[0].As<Napi::Object>());

    tsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "submit", 0, 1, [](Napi::Env) {});

#ifdef HAVE_HWLOC
    hwloc_topology_init(&topology);
    hwloc_topology_load(topology);
#endif

    tsfn.Unref(env);
};

RxJob::~RxJob()
{
    StopLoop();

#ifdef HAVE_HWLOC
    if (topology) hwloc_topology_destroy(topology);
#endif
}

Napi::Object RxJob::Init(Napi::Env env, Napi::Object exports)
{
    Napi::Function Fn = DefineClass(env, "RxJob", 
    {
        InstanceMethod("get_hashes", &RxJob::GetHashes), 
        InstanceMethod("throttle", &RxJob::Throttle), 
        InstanceMethod("send_job", &RxJob::SendJob), 
        InstanceMethod("start", &RxJob::Start), 
        InstanceMethod("pause", &RxJob::Pause), 
        InstanceMethod("stop", &RxJob::Stop)
    });

    exports.Set("RxJob", Fn);
    return exports;
};

Napi::Value RxJob::GetHashes(const Napi::CallbackInfo &info)
{
    return Napi::Number::New(info.Env(), static_cast<double>(m_hashes_done.load(std::memory_order_relaxed)));
};

Napi::Value RxJob::Throttle(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber())
    {
        Napi::Error::New(env, "Expected (threads: number, duration_ms: number)").ThrowAsJavaScriptException();
        return env.Null();
    };

    m_throttle_ms.store(info[1].As<Napi::Number>().Uint32Value(), std::memory_order_relaxed);
    m_throttle_count.fetch_add(info[0].As<Napi::Number>().Uint32Value(), std::memory_order_relaxed);

    return env.Undefined();
};

Napi::Value RxJob::SendJob(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 4 || !info[0].IsBuffer() || !info[1].IsBuffer() || !info[2].IsBoolean() || !info[3].IsBoolean())
    {
        Napi::Error::New(env, "Expected (blob, target, nicehash, reset_nonce[, start_nonce, nonce_limit])").ThrowAsJavaScriptException();
        return env.Null();
    };

    const auto blob = ToVector(info[0].As<Napi::Buffer<uint8_t>>());
    const size_t blob_size = std::min<size_t>(blob.size(), kMaxBlobSize);

    if (blob_size <= kNonceOffset + 4)
    {
        Napi::Error::New(env, "Invalid blob: too short to hold a nonce").ThrowAsJavaScriptException();
        return env.Null();
    };

    uint8_t target_raw[4] = {};
    {
        const auto target = ToVector(info[1].As<Napi::Buffer<uint8_t>>());
        std::memcpy(target_raw, target.data(), std::min<size_t>(target.size(), sizeof(target_raw)));
    };

    const uint32_t target_u32 = read_unaligned(reinterpret_cast<const uint32_t *>(target_raw));
    if (target_u32 == 0)
    {
        Napi::Error::New(env, "Invalid target: expected a non-zero 4-byte target").ThrowAsJavaScriptException();
        return env.Null();
    };

    const uint64_t new_target = 0xFFFFFFFFFFFFFFFFULL / (0xFFFFFFFFULL / uint64_t(target_u32));
    const uint64_t new_diff = 0xFFFFFFFFFFFFFFFFULL / new_target;

    const bool nicehash = info[2].As<Napi::Boolean>().Value();
    const bool reset_nonce = info[3].As<Napi::Boolean>().Value();

    const uint32_t start_nonce = (info.Length() > 4 && info[4].IsNumber()) ? info[4].As<Napi::Number>().Uint32Value() : 0u;
    const uint32_t nonce_limit = (info.Length() > 5 && info[5].IsNumber()) ? info[5].As<Napi::Number>().Uint32Value() : 0xFFFFFFFFu;

    {
        std::lock_guard<std::mutex> lock(m_job_mutex);

        std::memcpy(m_blob, blob.data(), blob_size);

        m_size = blob_size;
        m_target = new_target;
        m_nicehash.store(nicehash || read_unaligned(reinterpret_cast<const uint32_t *>(m_blob + kNonceOffset)) != 0, std::memory_order_relaxed);

        if (info.Length() > 4)
        {
            m_nonce_counter.store(start_nonce, std::memory_order_relaxed);
            m_nonce_limit.store(nonce_limit, std::memory_order_relaxed);
        }
        else if (reset_nonce)
        {
            m_nonce_counter.store(0, std::memory_order_relaxed);
            m_nonce_limit.store(0xFFFFFFFFu, std::memory_order_relaxed);
        };

        m_job_version.fetch_add(1, std::memory_order_release);
    };

    m_cv.notify_all();

    const uint32_t txn_count = read_txn_count(blob.data(), blob_size);

    Napi::Object exports = Napi::Object::New(env);
    exports.Set("diff", Napi::Number::New(env, static_cast<double>(new_diff)));

    if (txn_count) exports.Set("txnCount", Napi::Number::New(env, txn_count));

    return exports;
};

Napi::Value RxJob::Start(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (m_active.load(std::memory_order_relaxed))
    {
        if (m_paused.exchange(false, std::memory_order_relaxed))
            m_cv.notify_all();

        return env.Undefined();
    };

    std::vector<uint32_t> counts;
    if (info.Length() > 0) counts = ParseThreads(info[0]);

    m_active.store(true, std::memory_order_relaxed);
    m_paused.store(false, std::memory_order_relaxed);

    for (const ThreadSlot &slot : PlanThreads(std::move(counts)))
        m_threads.emplace_back(&RxJob::Loop, this, slot.core_id, slot.numa_node);

    return env.Undefined();
};

Napi::Value RxJob::Pause(const Napi::CallbackInfo &info)
{
    m_paused.store(true, std::memory_order_relaxed);
    m_cv.notify_all();

    return info.Env().Undefined();
};

Napi::Value RxJob::Stop(const Napi::CallbackInfo &info)
{
    StopLoop();
    return info.Env().Undefined();
};

void RxJob::StopLoop()
{
    m_active.store(false, std::memory_order_relaxed);
    m_cv.notify_all();

    for (auto &t : m_threads)
        if (t.joinable()) t.join();

    m_threads.clear();
};

std::vector<RxJob::ThreadSlot> RxJob::PlanThreads(std::vector<uint32_t> counts)
{
    std::vector<ThreadSlot> slots;

#ifdef HAVE_HWLOC
    if (counts.empty())
    {
        const int pus = hwloc_get_nbobjs_by_type(topology, HWLOC_OBJ_PU);
        counts.push_back(static_cast<uint32_t>(pus > 0 ? pus : 1));
    };

    for (size_t n = 0; n < counts.size(); ++n)
    {
        if (counts[n] == 0) continue;

        hwloc_obj_t node = hwloc_get_obj_by_type(topology, HWLOC_OBJ_NUMANODE, static_cast<int>(n));
        const uint32_t numa_id = node ? node->os_index : 0u;

        int pus = node ? hwloc_get_nbobjs_inside_cpuset_by_type(topology, node->cpuset, HWLOC_OBJ_PU) : hwloc_get_nbobjs_by_type(topology, HWLOC_OBJ_PU);
        if (pus <= 0) pus = 1;

        for (uint32_t i = 0; i < counts[n]; ++i)
        {
            const int index = static_cast<int>(i % static_cast<uint32_t>(pus));
            hwloc_obj_t pu = node ? hwloc_get_obj_inside_cpuset_by_type(topology, node->cpuset, HWLOC_OBJ_PU, index) : hwloc_get_obj_by_type(topology, HWLOC_OBJ_PU, index);

            slots.push_back({pu ? pu->os_index : 0u, numa_id});
        };
    };
#else
    if (counts.empty())
    {
        const uint32_t hw = std::thread::hardware_concurrency();
        counts.push_back(hw > 0 ? hw : 1);
    };

    for (uint32_t count : counts)
        for (uint32_t i = 0; i < count; ++i)
            slots.push_back({static_cast<uint32_t>(slots.size()), 0u});
#endif

    return slots;
};

void RxJob::BindThread(uint32_t core_id)
{
#ifdef HAVE_HWLOC
    if (hwloc_obj_t pu = hwloc_get_pu_obj_by_os_index(topology, core_id))
        hwloc_set_cpubind(topology, pu->cpuset, HWLOC_CPUBIND_THREAD);
#else
    (void)core_id;
#endif
};

void RxJob::WriteNonce(uint8_t *blob, uint32_t nonce) const
{
    if (m_nicehash.load(std::memory_order_relaxed))
    {
        const uint32_t existing = read_unaligned(reinterpret_cast<const uint32_t *>(blob + kNonceOffset));
        nonce = (existing & 0xFF000000u) | (nonce & 0x00FFFFFFu);
    };

    write_unaligned(reinterpret_cast<uint32_t *>(blob + kNonceOffset), nonce);
};

void RxJob::SubmitShare(const uint8_t *hash, const uint8_t *blob, uint64_t target)
{
    if (read_unaligned(reinterpret_cast<const uint64_t *>(hash + 24)) > target) [[likely]]
        return;

    auto *r = new JobResult();
    std::memcpy(r->nonce, blob + kNonceOffset, sizeof(r->nonce));
    std::memcpy(r->result, hash, sizeof(r->result));

    const napi_status status = tsfn.BlockingCall(r, [](Napi::Env env, Napi::Function jsSubmit, JobResult *result)
    {
        jsSubmit.Call({
            Napi::Buffer<uint8_t>::Copy(env, result->nonce, sizeof(result->nonce)),
            Napi::Buffer<uint8_t>::Copy(env, result->result, sizeof(result->result)),
        });

        delete result; 
    });

    if (status != napi_ok)
        delete r;
};

void RxJob::FlushHash(const std::shared_ptr<RxVm> &vm, const uint8_t *blob, size_t size, uint64_t target, bool &is_first)
{
    if (is_first || size == 0 || !vm)
        return;

    uint8_t hash[RANDOMX_HASH_SIZE];
    randomx_calculate_hash_last(vm->vm, hash);

    SubmitShare(hash, blob, target);
    is_first = true;
};

bool RxJob::HasWork(size_t size) const
{
    if (size == 0 || m_paused.load(std::memory_order_relaxed))
        return false;

    return m_nonce_counter.load(std::memory_order_relaxed) < m_nonce_limit.load(std::memory_order_relaxed);
};

void RxJob::WaitForWork(size_t size, uint32_t version)
{
    std::unique_lock<std::mutex> lock(m_cv_mutex);

    m_cv.wait_for(lock, std::chrono::milliseconds(250), [&]
    {
        if (!m_active.load(std::memory_order_relaxed))                return true;
        if (rx->updating.load(std::memory_order_acquire))             return true;
        if (m_job_version.load(std::memory_order_acquire) != version) return true;

        return HasWork(size); 
    });
};

void RxJob::ApplyThrottle()
{
    uint32_t left = m_throttle_count.load(std::memory_order_relaxed);
    if (left == 0) [[likely]]
        return;

    while (left > 0 && !m_throttle_count.compare_exchange_weak(left, left - 1, std::memory_order_relaxed))
    {

    };

    if (left == 0) return;
    std::this_thread::sleep_for(std::chrono::milliseconds(m_throttle_ms.load(std::memory_order_relaxed)));
};

void RxJob::Loop(uint32_t core_id, uint32_t numa_node)
{
    BindThread(core_id);

    std::shared_ptr<RxVm> vm = rx->create_vm(numa_node);
    if (!vm) return;

    size_t size = 0;
    uint64_t target = 0;
    uint32_t version = 0;
    bool is_first = true;

    alignas(16) uint8_t cur[kMaxBlobSize]{};
    alignas(16) uint8_t nxt[kMaxBlobSize]{};

    while (m_active.load(std::memory_order_relaxed))
    {
        if (rx->updating.load(std::memory_order_acquire))
        {
            FlushHash(vm, cur, size, target, is_first);
            vm.reset();

            while (rx->updating.load(std::memory_order_acquire) && m_active.load(std::memory_order_relaxed))
                std::this_thread::sleep_for(std::chrono::milliseconds(10));

            if (!m_active.load(std::memory_order_relaxed))
                return;

            vm = rx->create_vm(numa_node);
            if (!vm) return;

            version = m_job_version.load(std::memory_order_acquire) - 1;
            continue;
        };

        if (version != m_job_version.load(std::memory_order_acquire))
        {
            FlushHash(vm, cur, size, target, is_first);

            std::lock_guard<std::mutex> lock(m_job_mutex);
            std::memcpy(cur, m_blob, m_size);

            size = m_size;
            target = m_target;
            version = m_job_version.load(std::memory_order_relaxed);
        };

        if (!HasWork(size))
        {
            FlushHash(vm, cur, size, target, is_first);
            WaitForWork(size, version);
            continue;
        };

        const uint32_t nonce = m_nonce_counter.fetch_add(1, std::memory_order_relaxed);

        if (is_first)
        {
            is_first = false;

            WriteNonce(cur, nonce);
            randomx_calculate_hash_first(vm->vm, cur, size);
            std::memcpy(nxt, cur, size);
            continue;
        };

        WriteNonce(nxt, nonce);

        uint8_t hash[RANDOMX_HASH_SIZE];
        randomx_calculate_hash_next(vm->vm, nxt, size, hash);

        m_hashes_done.fetch_add(1, std::memory_order_relaxed);

        SubmitShare(hash, cur, target);
        std::memcpy(cur, nxt, size);

        ApplyThrottle();
    };

    FlushHash(vm, cur, size, target, is_first);
};