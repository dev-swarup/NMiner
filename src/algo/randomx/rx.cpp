#include "rx.h"
#include "rx_worker.h"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <intrin.h>
#include <windows.h>
#include <memoryapi.h>
#else
#include <cpuid.h>
#include <sched.h>
#include <pthread.h>
#include <sys/mman.h>
#endif

static bool has_aes()
{
    unsigned int regs[4] = {};
#ifdef _WIN32
    __cpuid(reinterpret_cast<int *>(regs), 1);
#else
    __get_cpuid(1, &regs[0], &regs[1], &regs[2], &regs[3]);
#endif
    return (regs[2] & (1u << 25)) != 0;
}

static bool has_vaes512()
{
#ifdef WITH_VAES
    unsigned int regs[4] = {};
#ifdef _WIN32
    __cpuidex(reinterpret_cast<int *>(regs), 7, 0);
#else
    __cpuid_count(7, 0, regs[0], regs[1], regs[2], regs[3]);
#endif
    const bool vaes = (regs[2] & (1u << 9)) != 0;
    const bool avx512f = (regs[1] & (1u << 16)) != 0;
    return avx512f && vaes;
#else
    return false;
#endif
}

bool aes_available = has_aes();
bool vaes512_available = has_vaes512();

extern bool aes_available;
extern bool vaes512_available;

static uint8_t *alloc_numa(size_t size, uint32_t numa_node)
{
#ifdef _WIN32
    HANDLE proc = GetCurrentProcess();
    void *ptr = VirtualAllocExNuma(proc, nullptr, size, MEM_RESERVE | MEM_COMMIT | MEM_LARGE_PAGES, PAGE_READWRITE, numa_node);
    if (!ptr) ptr = VirtualAllocExNuma(proc, nullptr, size, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE, numa_node);

    return static_cast<uint8_t *>(ptr);
#else
    void *ptr = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB, -1, 0);
    if (ptr == MAP_FAILED) ptr = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

    return static_cast<uint8_t *>(ptr);
#endif
}

static void free_numa(uint8_t *ptr, size_t size)
{
    if (!ptr) return;
#ifdef _WIN32
    VirtualFree(ptr, 0, MEM_RELEASE);
#else
    munmap(ptr, size);
#endif
}

randomx_flags build_flags(RxMode mode)
{
    uint32_t flags = RANDOMX_FLAG_JIT;

    if (aes_available)
        flags |= RANDOMX_FLAG_HARD_AES;

    if (mode == RxMode::Fast)
        flags |= RANDOMX_FLAG_FULL_MEM;

    if (LargePagesSupported())
        flags |= RANDOMX_FLAG_LARGE_PAGES;

    return static_cast<randomx_flags>(flags);
}

randomx_flags build_cache_flags()
{
    uint32_t flags = RANDOMX_FLAG_JIT | RANDOMX_FLAG_ARGON2;

    if (aes_available)
        flags |= RANDOMX_FLAG_HARD_AES;

    if (LargePagesSupported())
        flags |= RANDOMX_FLAG_LARGE_PAGES;

    return static_cast<randomx_flags>(flags);
}

randomx_numa::randomx_numa(uint8_t *s, randomx_vm *v, std::atomic<int> *counter) : scratchpad(s), vm(v), active_vms_ptr(counter)
{
    if (active_vms_ptr) active_vms_ptr->fetch_add(1, std::memory_order_relaxed);
}

randomx_numa::~randomx_numa()
{
    if (vm)
    {
        randomx_destroy_vm(vm);
        vm = nullptr;
    }

    if (scratchpad)
    {
        free_numa(scratchpad, RANDOMX_SCRATCHPAD_L3);
        scratchpad = nullptr;
    }

    if (active_vms_ptr) active_vms_ptr->fetch_sub(1, std::memory_order_relaxed);
}

Napi::Object Rx::Init(Napi::Env env, Napi::Object exports)
{
    Napi::Function Fn = DefineClass(env, "Rx", {
        InstanceMethod("allocate", &Rx::allocate),
        InstanceMethod("reallocate", &Rx::reallocate)
    });

    exports.Set("Rx", Fn);
    return exports;
}

Rx::Rx(const Napi::CallbackInfo &info) : Napi::ObjectWrap<Rx>(info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString())
    {
        Napi::Error::New(env, "Expected variant and mode ('FAST' or 'LIGHT') as arguments").ThrowAsJavaScriptException();
        return;
    }

    const std::string variant = info[0].As<Napi::String>().Utf8Value();
    if (variant != "rx/0" && variant != "rx/monero")
    {
        Napi::Error::New(env, "Invalid variant: expected 'rx/0' or 'rx/monero'").ThrowAsJavaScriptException();
        return;
    }

    m_mode = (info[1].As<Napi::String>().Utf8Value() == "FAST") ? RxMode::Fast : RxMode::Light;
}

Rx::~Rx()
{
    for (auto &[key, dataset] : datasets)
        if (dataset) randomx_release_dataset(dataset);

    datasets.clear();

    if (cache) randomx_release_cache(cache);
}

Napi::Value Rx::allocate(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsBuffer())
    {
        Napi::Error::New(env, "Expected seed_hash as a Buffer").ThrowAsJavaScriptException();
        return env.Null();
    }

    auto seed_hash = ToVector(info[0].As<Napi::Buffer<uint8_t>>());

    {
        std::lock_guard<std::mutex> lock(mutex);
        updating = true;
    }

    auto *worker = new AllocateWorker(env, this, std::move(seed_hash), "");

    worker->Queue();
    return worker->GetPromise();
}

Napi::Value Rx::reallocate(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsBuffer())
    {
        Napi::Error::New(env, "Expected seed_hash as a Buffer").ThrowAsJavaScriptException();
        return env.Null();
    }

    auto seed_hash = ToVector(info[0].As<Napi::Buffer<uint8_t>>());
    std::string variant = (info.Length() > 1 && info[1].IsString()) ? info[1].As<Napi::String>().Utf8Value() : "";

    {
        std::lock_guard<std::mutex> lock(mutex);
        updating = true;
    }

    auto *worker = new AllocateWorker(env, this, std::move(seed_hash), std::move(variant));

    worker->Queue();
    return worker->GetPromise();
}

std::shared_ptr<randomx_numa> Rx::create_vm(uint32_t numa_node)
{
    randomx_dataset *dataset = nullptr;

    if (m_mode == RxMode::Fast)
    {
        auto it = datasets.find(numa_node);
        if (it == datasets.end()) return nullptr;

        dataset = it->second;
    }

    if (!cache || (m_mode == RxMode::Fast && !dataset))
        return nullptr;

    randomx_flags flags = build_flags(m_mode);
    uint8_t *scratch = alloc_numa(RANDOMX_SCRATCHPAD_L3, numa_node);
    randomx_vm *vm = randomx_create_vm(flags, cache, dataset, numa_node, scratch);

    if (vm)
        return std::make_shared<randomx_numa>(scratch, vm, &active_vms);

    free_numa(scratch, RANDOMX_SCRATCHPAD_L3);
    return nullptr;
}