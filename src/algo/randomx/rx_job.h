#pragma once
#include <deque>
#include <mutex>
#include <atomic>
#include <chrono>
#include <thread>
#include <string>
#include <vector>
#include <cstring>
#include <cstdint>
#include <algorithm>
#include <type_traits>
#include <condition_variable>

#include <napi.h>

#ifdef HAVE_HWLOC
#include <hwloc.h>
#endif

#include "rx.h"

static constexpr size_t kNonceOffset = 39;
static constexpr size_t kMaxBlobSize = 408;
static constexpr uint32_t kNicehashMask = 0xFF000000u;
static constexpr uint32_t kNicehashLimit = 0x01000000u;

struct NonceRange
{
    uint32_t start;
    uint32_t limit;
};

inline uint64_t pack_range(uint32_t start, uint32_t limit)
{
    return (static_cast<uint64_t>(limit) << 32) | start;
};

template <typename T>
inline T read_unaligned(const T *ptr)
{
    static_assert(std::is_trivially_copyable<T>::value, "T must be trivially copyable");
    T result;
    std::memcpy(&result, ptr, sizeof(T));
    return result;
}

template <typename T>
inline void write_unaligned(T *ptr, T val)
{
    static_assert(std::is_trivially_copyable<T>::value, "T must be trivially copyable");
    std::memcpy(ptr, &val, sizeof(T));
}

struct JobResult
{
    uint8_t nonce[4];
    uint8_t result[32];
    uint32_t version;
};

class RxJob : public Napi::ObjectWrap<RxJob>
{
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);

    RxJob(const Napi::CallbackInfo &info);
    ~RxJob();

    Napi::Value GetHashes(const Napi::CallbackInfo &info);
    Napi::Value Throttle(const Napi::CallbackInfo &info);
    Napi::Value SendJob(const Napi::CallbackInfo &info);
    Napi::Value QueueRange(const Napi::CallbackInfo &info);
    Napi::Value PendingNonces(const Napi::CallbackInfo &info);
    Napi::Value Start(const Napi::CallbackInfo &info);
    Napi::Value Pause(const Napi::CallbackInfo &info);
    Napi::Value Stop(const Napi::CallbackInfo &info);

private:
    struct ThreadSlot
    {
        uint32_t core_id;
        uint32_t numa_node;
    };

    std::vector<ThreadSlot> PlanThreads(std::vector<uint32_t> counts);
    void BindThread(uint32_t core_id);

    void Loop(uint32_t core_id, uint32_t numa_node);
    void StopLoop();

    bool HasWork(size_t size);
    bool NextNonce(uint32_t &nonce);
    bool AdvanceRange(uint64_t exhausted);
    void WaitForWork(size_t size, uint32_t version);
    void ApplyThrottle();

    void WriteNonce(uint8_t *blob, uint32_t nonce) const;
    void SubmitShare(const uint8_t *hash, const uint8_t *blob, uint64_t target, uint32_t version);
    void FlushHash(const std::shared_ptr<RxVm> &vm, const uint8_t *blob, size_t size, uint64_t target, uint32_t version, bool &is_first);

    Rx *rx = nullptr;
    Napi::ObjectReference rx_ref;
    Napi::ThreadSafeFunction tsfn;

#ifdef HAVE_HWLOC
    hwloc_topology_t topology = nullptr;
#endif

    std::atomic<bool> m_active{false};
    std::atomic<bool> m_paused{false};
    std::vector<std::thread> m_threads;

    std::mutex m_cv_mutex;
    std::condition_variable m_cv;

    std::mutex m_job_mutex;
    std::atomic<uint32_t> m_job_version{0};
    std::atomic<uint64_t> m_hashes_done{0};

    std::mutex m_range_mutex;
    std::deque<NonceRange> m_queued;
    std::atomic<uint64_t> m_range{pack_range(0, 0xFFFFFFFFu)};

    std::atomic<uint32_t> m_throttle_ms{0};
    std::atomic<uint32_t> m_throttle_count{0};

    alignas(16) uint8_t m_blob[kMaxBlobSize]{};
    size_t m_size = 0;
    uint64_t m_target = 0;

    std::atomic<bool> m_ranged{false};
    std::atomic<bool> m_nicehash{false};
};