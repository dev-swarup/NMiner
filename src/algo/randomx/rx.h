#pragma once
#include <mutex>
#include <string>
#include <atomic>
#include <memory>

#include <napi.h>
#include "randomx.h"

#ifdef HAVE_HWLOC
    #include <hwloc.h>
#endif

typedef enum {
    RANDOMX_SLOW = 0,
    RANDOMX_FAST = 1,
} randomx_mode;

struct randomx_numa 
{
    uint8_t *scratchpad {nullptr};
    randomx_vm *vm {nullptr};

    randomx_numa(uint8_t* s, randomx_vm* v) : scratchpad(s), vm(v) {}
    ~randomx_numa();
};

class Rx : public Napi::ObjectWrap<Rx>
{
private:
    randomx_mode m_mode;
    randomx_cache *cache;
    randomx_dataset *dataset;

public:
    Rx(const Napi::CallbackInfo& info);
    ~Rx();

    Napi::Value allocate(const Napi::CallbackInfo& info);
    static Napi::Object Init(Napi::Env env, Napi::Object exports);

    std::mutex mutex;
    std::atomic<bool> updating;

    std::shared_ptr<randomx_numa> create_vm(uint32_t numa_node);
};