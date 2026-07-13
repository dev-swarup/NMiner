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

#include <thread>
#include <vector>

static bool AESSupport()
{
    unsigned int cpuInfo[4] = {};
#ifdef _WIN32
    __cpuid(reinterpret_cast<int *>(cpuInfo), 1);
#else
    __get_cpuid(1, &cpuInfo[0], &cpuInfo[1], &cpuInfo[2], &cpuInfo[3]);
#endif
    return (cpuInfo[2] & (1u << 25)) != 0;
};

static bool LargePagesSupport()
{
#ifdef _WIN32
    void *ptr = VirtualAlloc(nullptr, 2u * 1024u * 1024u, MEM_RESERVE | MEM_COMMIT | MEM_LARGE_PAGES, PAGE_READWRITE);
    if (ptr)
    { 
        VirtualFree(ptr, 0, MEM_RELEASE); 
        return true; 
    };

    return false;
#else
    void *ptr = mmap(nullptr, 2u * 1024u * 1024u, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB, -1, 0);
    if (ptr == MAP_FAILED) return false;

    munmap(ptr, 2u * 1024u * 1024u);
    return true;
#endif
};

static uint8_t* AllocateNuma(size_t size, uint32_t numa_node) 
{
#ifdef _WIN32
    HANDLE hProcess = GetCurrentProcess();

    void* ptr = VirtualAllocExNuma(hProcess, nullptr, size, MEM_RESERVE | MEM_COMMIT | MEM_LARGE_PAGES, PAGE_READWRITE, numa_node);
    if (!ptr) ptr = VirtualAllocExNuma(hProcess, nullptr, size, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE, numa_node);

    return static_cast<uint8_t*>(ptr);
#else
    void* ptr = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB, -1, 0);
    if (ptr == MAP_FAILED) ptr = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);

    return static_cast<uint8_t*>(ptr);
#endif
};

static void FreeNuma(uint8_t* ptr, size_t size)
{
    if (!ptr) return;

#ifdef _WIN32
    VirtualFree(ptr, 0, MEM_RELEASE);
#else
    munmap(ptr, size);
#endif
};

randomx_flags build_flags(randomx_mode mode)
{
    uint32_t flags = RANDOMX_FLAG_DEFAULT | RANDOMX_FLAG_JIT;

    if (AESSupport())      
        flags |= RANDOMX_FLAG_HARD_AES;

    if (mode == RANDOMX_FAST)    
        flags |= RANDOMX_FLAG_FULL_MEM;
    
    if (LargePagesSupport())
        flags |= RANDOMX_FLAG_LARGE_PAGES;

    return (randomx_flags)flags;
};

randomx_flags build_cache_flags()
{
    uint32_t flags = RANDOMX_FLAG_DEFAULT | RANDOMX_FLAG_JIT;

    if (AESSupport())
        flags |= RANDOMX_FLAG_HARD_AES;

    if (LargePagesSupport())
        flags |= RANDOMX_FLAG_LARGE_PAGES;

    return (randomx_flags)flags;
};

randomx_numa::randomx_numa(uint8_t* s, randomx_vm* v, std::atomic<int>* counter = nullptr)  : scratchpad(s), vm(v), active_vms_ptr(counter)
{
    if (active_vms_ptr) active_vms_ptr->fetch_add(1, std::memory_order_relaxed);
};

randomx_numa::~randomx_numa()
{
    if (vm) 
    {
        randomx_destroy_vm(vm);
        vm = nullptr;
    };

    if (scratchpad)
    {
        size_t l3_size = RandomX_CurrentConfig.ScratchpadL3_Size;
        FreeNuma(scratchpad, l3_size == 0 ? 2097152 : l3_size);

        scratchpad = nullptr;
    };

    if (active_vms_ptr) active_vms_ptr->fetch_sub(1, std::memory_order_relaxed);
};

Napi::Object Rx::Init(Napi::Env env, Napi::Object exports)
{
    Napi::Function Fn = DefineClass(env, "Rx", {
        InstanceMethod("allocate", &Rx::allocate),
        InstanceMethod("reallocate", &Rx::reallocate)
    });

    exports.Set("Rx", Fn);
    return exports;
};

Rx::Rx(const Napi::CallbackInfo& info) : Napi::ObjectWrap<Rx>(info), cache(nullptr), dataset(nullptr), updating(false)
{
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString()) 
    {
        Napi::Error::New(env, "Expected variant and mode ('FAST' or 'LIGHT') as arguments").ThrowAsJavaScriptException();
        return;
    };

    std::string variant = info[0].As<Napi::String>().Utf8Value();

    if (variant == "rx/0" || variant == "rx/monero")
        randomx_apply_config(RandomX_MoneroConfig);
    else if (variant == "rx/wow") randomx_apply_config(RandomX_WowneroConfig);
    else if (variant == "rx/arq") randomx_apply_config(RandomX_ArqmaConfig);
    else if (variant == "rx/sfx") randomx_apply_config(RandomX_SafexConfig);
    else if (variant == "rx/yada") randomx_apply_config(RandomX_YadaConfig);
    else if (variant == "rx/graft") randomx_apply_config(RandomX_GraftConfig);
    else 
    {
        Napi::Error::New(env, "Invalid variant").ThrowAsJavaScriptException();
        return;
    };

    m_mode = (info[1].As<Napi::String>().Utf8Value() == "FAST") ? RANDOMX_FAST : RANDOMX_LIGHT;
};

Rx::~Rx()
{
    if (dataset) randomx_release_dataset(dataset);
    if (cache) randomx_release_cache(cache);
};

Napi::Value Rx::allocate(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) 
    {
        Napi::Error::New(env, "Expected seed_hash").ThrowAsJavaScriptException();
        return env.Null();
    };

    std::string seed_hash = info[0].As<Napi::String>().Utf8Value();

    {
        std::lock_guard<std::mutex> lock(mutex);
        updating = true;
    };

    AllocateWorker* worker = new AllocateWorker(env, this, seed_hash, "");

    worker->Queue();
    return worker->GetPromise();
};

Napi::Value Rx::reallocate(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 1 || !info[0].IsString()) 
    {
        Napi::Error::New(env, "Expected seed_hash").ThrowAsJavaScriptException();
        return env.Null();
    };

    std::string seed_hash = info[0].As<Napi::String>().Utf8Value();
    std::string variant = info.Length() > 1 && info[1].IsString() ? info[1].As<Napi::String>().Utf8Value() : "";

    {
        std::lock_guard<std::mutex> lock(mutex);
        updating = true;
    };

    AllocateWorker* worker = new AllocateWorker(env, this, seed_hash, variant);
    
    worker->Queue();
    return worker->GetPromise();
};

std::shared_ptr<randomx_numa> Rx::create_vm(uint32_t numa_node)
{
    if (!cache || (m_mode == RANDOMX_FAST && !dataset)) 
        return nullptr;

    size_t l3_size = RandomX_CurrentConfig.ScratchpadL3_Size;
    uint8_t* scratchpad = AllocateNuma(l3_size == 0 ? 2097152 : l3_size, numa_node);
    if (!scratchpad) return nullptr;

    randomx_flags flags = build_flags(m_mode);
    randomx_vm *vm = randomx_create_vm(flags, cache, dataset, scratchpad, numa_node);

    if (vm) return std::make_shared<randomx_numa>(scratchpad, vm, &active_vms);
    return nullptr;
};