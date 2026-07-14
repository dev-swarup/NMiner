#pragma once
#include <mutex>
#include <atomic>
#include <chrono>
#include <thread>
#include <string>
#include <vector>
#include <napi.h>
#include <cstring>
#include <cstdint>
#include <algorithm>
#include <condition_variable>

#ifdef HAVE_HWLOC
    #include <hwloc.h>
#endif

template <typename T>
inline T readUnaligned(const T *ptr)
{
    static_assert(std::is_trivially_copyable<T>::value, "T must be trivially copyable");
    T result;
    std::memcpy(&result, ptr, sizeof(T));
    return result;
};

template <typename T>
inline void writeUnaligned(T *ptr, T data)
{
    static_assert(std::is_trivially_copyable<T>::value, "T must be trivially copyable");
    std::memcpy(ptr, &data, sizeof(T));
};

inline constexpr size_t kNonceSize   = 4;
inline constexpr size_t kNonceOffset = 39;
inline constexpr size_t kMaxSeedSize = 32;
inline constexpr size_t kMaxBlobSize = 408;

#include "rx.h"

struct JobResult {
    uint8_t nonce[4];
    uint8_t result[32];
};

class RxJob : public Napi::ObjectWrap<RxJob>
{
public:
    RxJob(const Napi::CallbackInfo& info);
    ~RxJob();

    static Napi::Object Init(Napi::Env env, Napi::Object exports);

    Napi::Value GetHashes(const Napi::CallbackInfo& info);
    Napi::Value Throttle(const Napi::CallbackInfo& info);
    Napi::Value SendJob(const Napi::CallbackInfo& info);
    Napi::Value Start(const Napi::CallbackInfo& info);
    Napi::Value Pause(const Napi::CallbackInfo& info);
    Napi::Value Stop(const Napi::CallbackInfo& info);

private:
    void Loop(uint32_t thread_index, uint32_t core_id, uint32_t numa_node);
    void StopLoop();

    Rx* rx = nullptr;
    Napi::ThreadSafeFunction tsfn;

#ifdef HAVE_HWLOC
    hwloc_topology_t topology = nullptr;
#endif
    std::atomic<bool> m_active {false};
    std::atomic<bool> m_paused {false};
    std::vector<std::thread> m_threads;

    std::mutex m_cv_mutex;
    std::condition_variable m_cv;

    std::mutex m_job_mutex;
    std::atomic<uint32_t> m_job_version {0};
    std::atomic<uint32_t> m_nonce_counter {0};
    std::atomic<uint64_t> m_hashes_calculated {0};

    std::atomic<uint32_t> m_throttle_time {0};
    std::atomic<uint32_t> m_throttle_count {0};

    uint8_t m_blob[kMaxBlobSize]{};
    size_t  m_size    = 0;
    bool    m_nicehash = false;

    uint64_t m_diff   = 0;
    uint64_t m_target = 0;
};