#pragma once
#include <mutex>
#include <string>
#include <atomic>
#include <memory>

#include <napi.h>
#include "randomx.h"
#include "configuration.h"

#ifdef HAVE_HWLOC
    #include <hwloc.h>
#endif

#include <vector>

inline std::vector<uint8_t> Buffer(const Napi::Buffer<uint8_t>& buf)
{
    return std::vector<uint8_t>(buf.Data(), buf.Data() + buf.Length());
};

typedef enum {
    RANDOMX_LIGHT = 0,
    RANDOMX_FAST = 1,
} randomx_mode;

bool LargePagesSupported();

randomx_flags build_flags(randomx_mode mode);
randomx_flags build_cache_flags();

struct randomx_numa 
{
    uint8_t *scratchpad {nullptr};
    randomx_vm *vm {nullptr};
    std::atomic<int>* active_vms_ptr {nullptr};

    randomx_numa(uint8_t* s, randomx_vm* v, std::atomic<int>* counter);
    ~randomx_numa();
};

class Rx : public Napi::ObjectWrap<Rx>
{
public:
    Rx(const Napi::CallbackInfo& info);
    ~Rx();

    Napi::Value allocate(const Napi::CallbackInfo& info);
    Napi::Value reallocate(const Napi::CallbackInfo& info);
    static Napi::Object Init(Napi::Env env, Napi::Object exports);

    std::mutex mutex;
    randomx_mode m_mode;
    randomx_cache *cache;
    randomx_dataset *dataset;
    std::atomic<bool> updating;
    std::atomic<int> active_vms {0};

    std::shared_ptr<randomx_numa> create_vm(uint32_t numa_node);
};