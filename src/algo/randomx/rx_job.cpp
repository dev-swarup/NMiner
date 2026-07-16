#include <sstream>
#include <iomanip>
#include <cstring>
#include <algorithm>

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/mman.h>
#endif

#include "rx.h"
#include "rx_job.h"

RxJob::RxJob(const Napi::CallbackInfo &info) : Napi::ObjectWrap<RxJob>(info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction())
    {
        Napi::Error::New(env, "Expected Rx instance and submit callback").ThrowAsJavaScriptException();
        return;
    }

    rx = Rx::Unwrap(info[0].As<Napi::Object>());
    tsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "submit", 0, 1, [](Napi::Env) {});

#ifdef HAVE_HWLOC
    hwloc_topology_init(&topology);
    hwloc_topology_load(topology);
#endif

    tsfn.Unref(env);
}

RxJob::~RxJob()
{
    StopLoop();

#ifdef HAVE_HWLOC
    if (topology) hwloc_topology_destroy(topology);
#endif
}

Napi::Object RxJob::Init(Napi::Env env, Napi::Object exports)
{
    Napi::Function Fn = DefineClass(env, "RxJob", {
        InstanceMethod("get_hashes", &RxJob::GetHashes),
        InstanceMethod("throttle", &RxJob::Throttle),
        InstanceMethod("send_job", &RxJob::SendJob),
        InstanceMethod("start", &RxJob::Start),
        InstanceMethod("pause", &RxJob::Pause),
        InstanceMethod("stop", &RxJob::Stop)
    });

    exports.Set("RxJob", Fn);
    return exports;
}

Napi::Value RxJob::GetHashes(const Napi::CallbackInfo &info)
{
    return Napi::Number::New(info.Env(), m_hashes_done.load(std::memory_order_relaxed));
}

Napi::Value RxJob::Throttle(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsNumber() || !info[1].IsNumber())
    {
        Napi::Error::New(env, "Expected (threads: number, duration_ms: number)").ThrowAsJavaScriptException();
        return env.Null();
    }

    m_throttle_ms.store(info[1].As<Napi::Number>().Uint32Value(), std::memory_order_relaxed);
    m_throttle_count.fetch_add(info[0].As<Napi::Number>().Uint32Value(), std::memory_order_relaxed);

    return env.Undefined();
}

Napi::Value RxJob::SendJob(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 4 || !info[0].IsBuffer() || !info[1].IsBuffer() || !info[2].IsBoolean() || !info[3].IsBoolean())
    {
        Napi::Error::New(env, "Expected (blob, target, nicehash, reset_nonce[, start_nonce, nonce_limit])").ThrowAsJavaScriptException();
        return env.Null();
    }

    auto blob = ToVector(info[0].As<Napi::Buffer<uint8_t>>());
    size_t blob_size = std::min<size_t>(blob.size(), kMaxBlobSize);

    uint32_t txn_count = 0;
    const size_t tx_offset = 75;
    for (size_t i = tx_offset, shift = 0; i < blob_size && i < tx_offset + 4; ++i, shift += 7)
    {
        uint8_t b = blob[i];
        txn_count |= static_cast<uint32_t>(b & 0x7Fu) << shift;

        if (!(b & 0x80u))
            break;
    }

    uint8_t target_raw[4] = {};
    {
        auto target = ToVector(info[1].As<Napi::Buffer<uint8_t>>());
        std::memcpy(target_raw, target.data(), std::min<size_t>(target.size(), 4));
    }

    const uint64_t new_target = 0xFFFFFFFFFFFFFFFFULL / (0xFFFFFFFFULL / uint64_t(*reinterpret_cast<const uint32_t *>(target_raw)));
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
        m_nicehash = nicehash || (read_unaligned(reinterpret_cast<uint32_t *>(m_blob + kNonceOffset)) != 0);

        if (info.Length() > 4)
        {
            m_nonce_counter.store(start_nonce, std::memory_order_relaxed);
            m_nonce_limit.store(nonce_limit, std::memory_order_relaxed);
        }
        else if (reset_nonce)
        {
            m_nonce_counter.store(0, std::memory_order_relaxed);
            m_nonce_limit.store(0xFFFFFFFFu, std::memory_order_relaxed);
        }

        m_job_version.fetch_add(1, std::memory_order_release);
    }

    m_cv.notify_all();

    Napi::Object exports = Napi::Object::New(env);
    exports.Set("diff", Napi::Number::New(env, static_cast<double>(new_diff)));

    if (txn_count) exports.Set("txnCount", Napi::Number::New(env, txn_count));

    return exports;
}

Napi::Value RxJob::Start(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (m_active.load(std::memory_order_relaxed))
    {
        if (m_paused.load(std::memory_order_relaxed))
        {
            m_paused.store(false, std::memory_order_relaxed);
            m_cv.notify_all();
        }

        return env.Undefined();
    }

    std::vector<uint32_t> threads;
    if (info.Length() > 0) threads = ParseThreads(env, info[0]);

    m_active.store(true, std::memory_order_relaxed);
    m_paused.store(false, std::memory_order_relaxed);

#ifdef HAVE_HWLOC
    if (threads.empty())
    {
        int n = hwloc_get_nbobjs_by_type(topology, HWLOC_OBJ_PU);
        threads.push_back(static_cast<uint32_t>(n > 0 ? n : 1));
    }

    uint32_t thread_index = 0;
    for (size_t n = 0; n < threads.size(); ++n)
    {
        const uint32_t count = threads[n];
        if (count == 0) continue;

        hwloc_obj_t node = hwloc_get_obj_by_type(topology, HWLOC_OBJ_NUMANODE, static_cast<int>(n));
        const uint32_t numa_id = node ? node->os_index : 0u;

        int num_pus = node ? hwloc_get_nbobjs_inside_cpuset_by_type(topology, node->cpuset, HWLOC_OBJ_PU) : hwloc_get_nbobjs_by_type(topology, HWLOC_OBJ_PU);

        if (num_pus <= 0)
            num_pus = 1;

        for (uint32_t i = 0; i < count; ++i)
        {
            hwloc_obj_t pu = node ? hwloc_get_obj_inside_cpuset_by_type(topology, node->cpuset, HWLOC_OBJ_PU, i % num_pus) : hwloc_get_obj_by_type(topology, HWLOC_OBJ_PU, i % num_pus);
            const uint32_t core_id = pu ? pu->os_index : 0u;

            m_threads.emplace_back(&RxJob::Loop, this, thread_index++, core_id, numa_id);
        }
    }
#else
    if (threads.empty())
    {
        uint32_t hw = std::thread::hardware_concurrency();
        threads.push_back(hw > 0 ? hw : 1);
    }

    uint32_t thread_index = 0;
    for (uint32_t count : threads)
    {
        for (uint32_t i = 0; i < count; ++i) m_threads.emplace_back(&RxJob::Loop, this, thread_index++, thread_index, 0u);
    }
#endif

    return env.Undefined();
}

Napi::Value RxJob::Pause(const Napi::CallbackInfo &info)
{
    m_paused.store(true, std::memory_order_relaxed);
    m_cv.notify_all();

    return info.Env().Undefined();
}

Napi::Value RxJob::Stop(const Napi::CallbackInfo &info)
{
    StopLoop();
    return info.Env().Undefined();
}


void RxJob::StopLoop()
{
    m_active.store(false, std::memory_order_relaxed);
    m_cv.notify_all();

    for (auto &t : m_threads)
        if (t.joinable()) t.join();

    m_threads.clear();
}

inline void RxJob::flush_hash(std::shared_ptr<randomx_numa> &vm, const uint8_t *blob, size_t size, uint64_t target, bool &is_first)
{
    if (is_first || size == 0)
        return;

    uint8_t hash[RANDOMX_HASH_SIZE];
    randomx_calculate_hash_last(vm->vm, hash);

    const uint64_t h64 = read_unaligned(reinterpret_cast<const uint64_t *>(hash + 24));
    if (h64 <= target)
    {
        auto *r = new JobResult();
        std::memcpy(r->nonce, blob + kNonceOffset, 4);
        std::memcpy(r->result, hash, 32);

        SubmitJob(r);
    }

    is_first = true;
}

void RxJob::Loop(uint32_t thread_index, uint32_t core_id, uint32_t numa_node)
{
#ifdef HAVE_HWLOC
    hwloc_obj_t pu = hwloc_get_obj_by_type(topology, HWLOC_OBJ_PU, static_cast<int>(core_id));
    if (pu) hwloc_set_cpubind(topology, pu->cpuset, HWLOC_CPUBIND_THREAD);
#endif

    std::shared_ptr<randomx_numa> vm = rx->create_vm(numa_node);
    if (!vm || !vm->vm)
        return;

    size_t local_size = 0;
    uint64_t local_target = 0;
    uint32_t local_version = 0;

    bool is_first = true;
    alignas(16) uint8_t cur[kMaxBlobSize]{};
    alignas(16) uint8_t nxt[kMaxBlobSize]{};

    auto write_nonce = [&](uint8_t *blob_ptr, uint32_t nonce)
        {
            uint32_t n = nonce;
            if (m_nicehash)
            {
                const uint32_t existing = read_unaligned(reinterpret_cast<uint32_t *>(blob_ptr + kNonceOffset));
                n = (existing & 0xFF000000u) | (nonce & 0x00FFFFFFu);
            }

            write_unaligned(reinterpret_cast<uint32_t *>(blob_ptr + kNonceOffset), n);
        };

    while (m_active.load(std::memory_order_relaxed))
    {
        if (rx->updating.load(std::memory_order_acquire))
        {
            flush_hash(vm, cur, local_size, local_target, is_first);
            vm.reset();

            while (rx->updating.load(std::memory_order_acquire) && m_active.load(std::memory_order_relaxed))
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            }

            if (!m_active.load(std::memory_order_relaxed)) break;

            vm = rx->create_vm(numa_node);
            if (!vm || !vm->vm) break;

            local_version = m_job_version.load(std::memory_order_acquire) - 1;
            continue;
        }

        const uint32_t cur_version = m_job_version.load(std::memory_order_acquire);
        if (local_version != cur_version)
        {
            flush_hash(vm, cur, local_size, local_target, is_first);

            {
                std::lock_guard<std::mutex> lock(m_job_mutex);
                std::memcpy(cur, m_blob, m_size);

                local_size = m_size;
                local_target = m_target;
                local_version = m_job_version.load(std::memory_order_relaxed);
            }
        }

        const bool exhausted = m_nonce_counter.load(std::memory_order_relaxed) >= m_nonce_limit.load(std::memory_order_relaxed);
        if (m_paused.load(std::memory_order_relaxed) || local_size == 0 || exhausted)
        {
            flush_hash(vm, cur, local_size, local_target, is_first);

            std::unique_lock<std::mutex> lk(m_cv_mutex);
            m_cv.wait_for(lk, std::chrono::milliseconds(250), [this, local_version]
                        {
                            if (!m_active.load(std::memory_order_relaxed))                      return true;
                            if (rx->updating.load(std::memory_order_acquire))                   return true;
                            if (m_paused.load(std::memory_order_relaxed))                       return false;
                            if (m_size == 0)                                                    return false;
                            if (m_job_version.load(std::memory_order_acquire) != local_version) return true;
                            return m_nonce_counter.load(std::memory_order_relaxed) < m_nonce_limit.load(std::memory_order_relaxed);
                        });
            continue;
        }

        const uint32_t nonce = m_nonce_counter.fetch_add(1, std::memory_order_relaxed);

        if (is_first)
        {
            is_first = false;
            write_nonce(cur, nonce);

            randomx_calculate_hash_first(vm->vm, cur, local_size);

            std::memcpy(nxt, cur, local_size);
            continue;
        }

        write_nonce(nxt, nonce);

        uint8_t hash[RANDOMX_HASH_SIZE];
        randomx_calculate_hash_next(vm->vm, nxt, local_size, hash);

        m_hashes_done.fetch_add(1, std::memory_order_relaxed);

        const uint64_t h64 = read_unaligned(reinterpret_cast<const uint64_t *>(hash + 24));
        if (h64 <= local_target) [[unlikely]]
        {
            auto *r = new JobResult();
            std::memcpy(r->nonce, cur + kNonceOffset, 4);
            std::memcpy(r->result, hash, 32);

            SubmitJob(r);
        }

        std::memcpy(cur, nxt, local_size);

        if (m_throttle_count.load(std::memory_order_relaxed) > 0) [[unlikely]]
        {
            const uint32_t prev = m_throttle_count.fetch_sub(1, std::memory_order_relaxed);
            if (prev > 0)
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(m_throttle_ms.load(std::memory_order_relaxed)));
            }
            else
            {
                m_throttle_count.fetch_add(1, std::memory_order_relaxed);
            }
        }
    }

    flush_hash(vm, cur, local_size, local_target, is_first);
    vm.reset();
}

void RxJob::SubmitJob(JobResult *result)
{
    const napi_status status = tsfn.BlockingCall(result, [](Napi::Env env, Napi::Function jsSubmit, JobResult *r)
    {
        jsSubmit.Call({
            Napi::Buffer<uint8_t>::Copy(env, r->nonce, 4),
            Napi::Buffer<uint8_t>::Copy(env, r->result, 32),
        });
        
        delete r;
    });

    if (status != napi_ok)
        delete result;
}