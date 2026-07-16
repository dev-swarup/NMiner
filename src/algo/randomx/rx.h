#pragma once
#include <map>
#include <mutex>
#include <atomic>
#include <memory>
#include <string>
#include <vector>
#include <cstdint>

#include <napi.h>
#include "randomx.h"
#include "configuration.h"

#ifdef HAVE_HWLOC
#include <hwloc.h>
#endif

inline std::vector<uint8_t> ToVector(const Napi::Buffer<uint8_t> &buf)
{
    return std::vector<uint8_t>(buf.Data(), buf.Data() + buf.Length());
}

inline std::vector<uint32_t> ParseThreads(Napi::Env env, Napi::Value val)
{
    std::vector<uint32_t> threads;

    if (val.IsArray())
    {
        Napi::Array arr = val.As<Napi::Array>();

        for (uint32_t i = 0; i < arr.Length(); ++i)
            threads.push_back(arr.Get(i).As<Napi::Number>().Uint32Value());
    }

    return threads;
}

enum class RxMode : uint8_t
{
    Light = 0,
    Fast = 1,
};

bool LargePagesSupported();

randomx_flags build_flags(RxMode mode);
randomx_flags build_cache_flags();

struct randomx_numa
{
    uint8_t *scratchpad{nullptr};
    randomx_vm *vm{nullptr};
    std::atomic<int> *active_vms_ptr{nullptr};

    randomx_numa(uint8_t *scratchpad, randomx_vm *vm, std::atomic<int> *counter);
    ~randomx_numa();
};

class Rx : public Napi::ObjectWrap<Rx>
{
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);

    Rx(const Napi::CallbackInfo &info);
    ~Rx();

    Napi::Value allocate(const Napi::CallbackInfo &info);
    Napi::Value reallocate(const Napi::CallbackInfo &info);

    std::shared_ptr<randomx_numa> create_vm(uint32_t numa_node);

    std::mutex mutex;
    std::atomic<bool> updating{false};
    std::atomic<int> active_vms{0};
    RxMode m_mode;
    randomx_cache *cache{nullptr};

    std::map<uint32_t, randomx_dataset *> datasets;
};