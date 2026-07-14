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

static int bin2hex(char *const hex, const size_t hex_maxlen, const unsigned char *const bin, const size_t bin_len)
{
    size_t i = 0U;
    int b = 0, c = 0;
    unsigned int x = 0U;

    if (bin_len >= SIZE_MAX / 2 || hex_maxlen < bin_len * 2U)
        return -1;

    while (i < bin_len)
    {
        c = bin[i] & 0xf;
        b = bin[i] >> 4;
        x = (unsigned char)(87U + c + (((c - 10U) >> 8) & ~38U)) << 8 | (unsigned char)(87U + b + (((b - 10U) >> 8) & ~38U));
        hex[i * 2U]      = (char)x;
        x >>= 8;
        hex[i * 2U + 1U] = (char)x;
        i++;
    };

    if (i * 2U < hex_maxlen)
        hex[i * 2U] = 0U;

    return 0;
};

static int hex2bin(unsigned char *const bin, const size_t bin_maxlen, const char *const hex, const size_t hex_len, const char *const ignore, size_t *const bin_len, const char **const hex_end)
{
    int          ret      = 0;
    size_t       bin_pos  = 0U;
    size_t       hex_pos  = 0U;
    unsigned char c       = 0U, c_acc  = 0U;
    unsigned char c_num0  = 0U, c_num  = 0U;
    unsigned char c_val   = 0U, state  = 0U;
    unsigned char c_alpha0 = 0U, c_alpha = 0U;

    while (hex_pos < hex_len)
    {
        c       = (unsigned char)hex[hex_pos];
        c_num   = c ^ 48U;
        c_num0  = (c_num - 10U) >> 8;
        c_alpha = (c & ~32U) - 55U;
        c_alpha0 = ((c_alpha - 10U) ^ (c_alpha - 16U)) >> 8;

        if ((c_num0 | c_alpha0) == 0U)
        {
            if (ignore != nullptr && state == 0U && strchr(ignore, c) != nullptr)
            { 
                hex_pos++; 
                continue;
            };

            break;
        };

        c_val = (c_num0 & c_num) | (c_alpha0 & c_alpha);

        if (bin_pos >= bin_maxlen)
        { 
            ret = -1;
            errno = ERANGE; 
            break; 
        };

        if (state == 0U)
            c_acc = c_val * 16U;
        else
            bin[bin_pos++] = c_acc | c_val;

        state = ~state;
        hex_pos++;
    };

    if (state != 0U)
    { 
        hex_pos--; 
        errno = EINVAL; ret = -1; 
    };

    if (ret != 0)
        bin_pos = 0U;

    if (hex_end != nullptr)
        *hex_end = &hex[hex_pos];
    else if (hex_pos != hex_len)
    { 
        errno = EINVAL; ret = -1; 
    };

    if (bin_len != nullptr)
        *bin_len = bin_pos;

    return ret;
};

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

struct SubmitData {
    std::string job_id;
    std::string nonce;
    std::string result;
};

class RxJob : public Napi::ObjectWrap<RxJob>
{
public:
    RxJob(const Napi::CallbackInfo& info);
    ~RxJob();

    static Napi::Object Init(Napi::Env env, Napi::Object exports);

    Napi::Value GetHashes(const Napi::CallbackInfo& info);
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

    uint8_t m_blob[kMaxBlobSize]{};
    size_t  m_size    = 0;
    bool    m_nicehash = false;

    uint64_t m_diff   = 0;
    uint64_t m_target = 0;

    std::string m_job_id;
};