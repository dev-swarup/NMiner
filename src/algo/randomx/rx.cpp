#include "rx.h"
#include "rx_worker.h"
#include "argon2.h"
#include "blake2/blake2.h"

#if defined(__i386__) || defined(__x86_64__) || defined(_M_IX86) || defined(_M_X64)
#define NMINER_X86 1
#endif

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif

#include <windows.h>
#include <memoryapi.h>
#ifdef NMINER_X86
#include <intrin.h>
#endif
#else
#include <sched.h>
#include <pthread.h>
#include <sys/mman.h>
#ifdef NMINER_X86
#include <cpuid.h>
#elif defined(__aarch64__)
#include <sys/auxv.h>
#include <asm/hwcap.h>
#endif
#endif

static bool has_aes()
{
#if defined(NMINER_X86)
    unsigned int regs[4] = {};
#ifdef _WIN32
    __cpuid(reinterpret_cast<int *>(regs), 1);
#else
    __get_cpuid(1, &regs[0], &regs[1], &regs[2], &regs[3]);
#endif
    return (regs[2] & (1u << 25)) != 0;
#elif defined(_WIN32) && defined(_M_ARM64)
    return IsProcessorFeaturePresent(PF_ARM_V8_CRYPTO_INSTRUCTIONS_AVAILABLE) != 0;
#elif defined(__aarch64__)
    return (getauxval(AT_HWCAP) & HWCAP_AES) != 0;
#else
    return false;
#endif
};

static bool has_sse41()
{
#if defined(NMINER_X86)
    unsigned int regs[4] = {};
#ifdef _WIN32
    __cpuid(reinterpret_cast<int *>(regs), 1);
#else
    __get_cpuid(1, &regs[0], &regs[1], &regs[2], &regs[3]);
#endif
    return (regs[2] & (1u << 19)) != 0;
#else
    return false;
#endif
};

static bool has_ssse3()
{
#if defined(NMINER_X86)
    unsigned int regs[4] = {};
#ifdef _WIN32
    __cpuid(reinterpret_cast<int *>(regs), 1);
#else
    __get_cpuid(1, &regs[0], &regs[1], &regs[2], &regs[3]);
#endif
    return (regs[2] & (1u << 9)) != 0;
#else
    return false;
#endif
};

static bool has_avx2()
{
#if defined(NMINER_X86)
    unsigned int regs[4] = {};
#ifdef _WIN32
    __cpuid(reinterpret_cast<int *>(regs), 1);
#else
    __get_cpuid(1, &regs[0], &regs[1], &regs[2], &regs[3]);
#endif

    // AVX2 is only usable once the OS has enabled the YMM state.
    if (!(regs[2] & (1u << 27)) || !(regs[2] & (1u << 28)))
        return false;

    unsigned int lo = 0;
#ifdef _WIN32
    lo = static_cast<unsigned int>(_xgetbv(0));
#else
    unsigned int hi = 0;
    __asm__ __volatile__("xgetbv" : "=a"(lo), "=d"(hi) : "c"(0));
#endif
    if ((lo & 0x6u) != 0x6u)
        return false;

#ifdef _WIN32
    __cpuidex(reinterpret_cast<int *>(regs), 7, 0);
#else
    __cpuid_count(7, 0, regs[0], regs[1], regs[2], regs[3]);
#endif
    return (regs[1] & (1u << 5)) != 0;
#else
    return false;
#endif
};

static bool has_vaes512()
{
#if defined(WITH_VAES) && defined(NMINER_X86)
    unsigned int regs[4] = {};
#ifdef _WIN32
    __cpuid(reinterpret_cast<int *>(regs), 1);
#else
    __get_cpuid(1, &regs[0], &regs[1], &regs[2], &regs[3]);
#endif
    if (!(regs[2] & (1u << 27)))
        return false;

    unsigned int lo = 0;
#ifdef _WIN32
    lo = static_cast<unsigned int>(_xgetbv(0));
#else
    unsigned int hi = 0;
    __asm__ __volatile__("xgetbv" : "=a"(lo), "=d"(hi) : "c"(0));
#endif

    // ZMM state (opmask + upper halves) must be OS-enabled or AVX-512 faults despite CPUID.
    if ((lo & 0xE6u) != 0xE6u)
        return false;

#ifdef _WIN32
    __cpuidex(reinterpret_cast<int *>(regs), 7, 0);
#else
    __cpuid_count(7, 0, regs[0], regs[1], regs[2], regs[3]);
#endif
    return (regs[1] & (1u << 16)) != 0 && (regs[2] & (1u << 9)) != 0;
#else
    return false;
#endif
};

bool aes_available = has_aes();
bool vaes512_available = has_vaes512();

static bool SelectBlake2Impl()
{
#ifdef WITH_SSE4_1
    if (has_sse41())
        randomx_blake2b_compress = rx_blake2b_compress_sse41;
#endif

#ifdef WITH_AVX2
    if (has_avx2())
        randomx_blake2b_simd = blake2b_avx2;
#endif

    return true;
};

static const bool blake2_selected = SelectBlake2Impl();

const char *Blake2ImplName()
{
    if (randomx_blake2b_simd)
        return "avx2";
    if (randomx_blake2b_compress != randomx_blake2b_compress_integer)
        return "sse41";

    return "reference";
};

const char *AesImplName()
{
    if (vaes512_available)
        return "vaes512";
    if (aes_available)
        return "aes-ni";

    return "soft";
};

static uint8_t *alloc_numa(size_t size, uint32_t numa_node)
{
#ifdef _WIN32
    HANDLE proc = GetCurrentProcess();
    void *ptr = VirtualAllocExNuma(proc, nullptr, size, MEM_RESERVE | MEM_COMMIT | MEM_LARGE_PAGES, PAGE_READWRITE, numa_node);

    if (!ptr) ptr = VirtualAllocExNuma(proc, nullptr, size, MEM_RESERVE | MEM_COMMIT, PAGE_READWRITE, numa_node);

    return static_cast<uint8_t *>(ptr);
#else
    (void)numa_node;

    void *ptr = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB, -1, 0);

    if (ptr == MAP_FAILED)
    {
        ptr = mmap(nullptr, size, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
        if (ptr == MAP_FAILED) return nullptr;

#ifdef MADV_HUGEPAGE
        madvise(ptr, size, MADV_HUGEPAGE);
#endif
    };

    return static_cast<uint8_t *>(ptr);
#endif
};

static void free_numa(uint8_t *ptr, size_t size)
{
    if (!ptr) return;
#ifdef _WIN32
    (void)size;
    VirtualFree(ptr, 0, MEM_RELEASE);
#else
    munmap(ptr, size);
#endif
};

static randomx_flags common_flags()
{
    uint32_t flags = RANDOMX_FLAG_JIT;

    if (aes_available)
        flags |= RANDOMX_FLAG_HARD_AES;

    if (LargePagesSupported())
        flags |= RANDOMX_FLAG_LARGE_PAGES;

    return static_cast<randomx_flags>(flags);
};

randomx_flags build_flags(RxMode mode, RxAlgoVersion version)
{
    uint32_t flags = common_flags();

    if (mode == RxMode::Fast)
        flags |= RANDOMX_FLAG_FULL_MEM;

    if (version == RxAlgoVersion::V2)
        flags |= RANDOMX_FLAG_V2;

    return static_cast<randomx_flags>(flags);
};

randomx_flags build_cache_flags()
{
    uint32_t flags = common_flags();

    if (randomx_argon2_impl_avx2() && has_avx2())
        flags |= RANDOMX_FLAG_ARGON2_AVX2;
    else if (randomx_argon2_impl_ssse3() && has_ssse3())
        flags |= RANDOMX_FLAG_ARGON2_SSSE3;

    return static_cast<randomx_flags>(flags);
};

RxVm::RxVm(uint8_t *scratchpad, randomx_vm *vm, std::atomic<int> &active) : scratchpad(scratchpad), vm(vm), active(active)
{
    active.fetch_add(1, std::memory_order_relaxed);
};

RxVm::~RxVm()
{
    randomx_destroy_vm(vm);
    free_numa(scratchpad, RANDOMX_SCRATCHPAD_L3);

    active.fetch_sub(1, std::memory_order_release);
};

Napi::Object Rx::Init(Napi::Env env, Napi::Object exports)
{
    Napi::Function Fn = DefineClass(env, "Rx", 
    {
        InstanceMethod("allocate", &Rx::allocate), 
        InstanceMethod("reallocate", &Rx::reallocate), 
        InstanceMethod("hash", &Rx::hash), 
        InstanceAccessor("variant", &Rx::GetVariant, nullptr)
    });

    exports.Set("Rx", Fn);
    return exports;
};

Rx::Rx(const Napi::CallbackInfo &info) : Napi::ObjectWrap<Rx>(info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 2 || !info[0].IsString() || !info[1].IsString())
    {
        Napi::Error::New(env, "Expected variant and mode ('FAST' or 'LIGHT') as arguments").ThrowAsJavaScriptException();
        return;
    };

    const std::string variant = info[0].As<Napi::String>().Utf8Value();
    RxAlgoVersion version;

    if (!ParseVariant(variant, version))
    {
        Napi::Error::New(env, kVariantError).ThrowAsJavaScriptException();
        return;
    };

    apply_variant(variant);
    m_mode = (info[1].As<Napi::String>().Utf8Value() == "FAST") ? RxMode::Fast : RxMode::Light;
};

void Rx::apply_variant(const std::string &variant)
{
    RxAlgoVersion version;
    if (!ParseVariant(variant, version))
        return;

    m_variant = variant;
    m_version.store(version, std::memory_order_relaxed);
};

Rx::~Rx()
{
    release();
};

void Rx::release()
{
    for (auto &[node, dataset] : datasets)
        if (dataset) randomx_release_dataset(dataset);

    datasets.clear();

    if (cache)
    {
        randomx_release_cache(cache);
        cache = nullptr;
    };
};

Napi::Value Rx::GetVariant(const Napi::CallbackInfo &info)
{
    return Napi::String::New(info.Env(), m_variant);
};

Napi::Value Rx::hash(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsBuffer())
    {
        Napi::Error::New(env, "Expected input as a Buffer").ThrowAsJavaScriptException();
        return env.Null();
    };

    const auto input = ToVector(info[0].As<Napi::Buffer<uint8_t>>());

    if (updating.load(std::memory_order_acquire))
    {
        Napi::Error::New(env, "Cache is being reallocated: await allocate() first").ThrowAsJavaScriptException();
        return env.Null();
    };

    std::shared_ptr<RxVm> vm = create_vm(0);
    if (!vm)
    {
        Napi::Error::New(env, "No cache allocated: call allocate() first").ThrowAsJavaScriptException();
        return env.Null();
    };

    uint8_t out[RANDOMX_HASH_SIZE];
    randomx_calculate_hash(vm->vm, input.data(), input.size(), out);

    return Napi::Buffer<uint8_t>::Copy(env, out, sizeof(out));
};

Napi::Value Rx::allocate(const Napi::CallbackInfo &info)
{
    return queue_allocate(info, "");
};

Napi::Value Rx::reallocate(const Napi::CallbackInfo &info)
{
    const std::string variant = (info.Length() > 1 && info[1].IsString()) ? info[1].As<Napi::String>().Utf8Value() : "";

    return queue_allocate(info, variant);
};

Napi::Value Rx::queue_allocate(const Napi::CallbackInfo &info, const std::string &variant)
{
    Napi::Env env = info.Env();

    if (info.Length() < 1 || !info[0].IsBuffer())
    {
        Napi::Error::New(env, "Expected seed_hash as a Buffer").ThrowAsJavaScriptException();
        return env.Null();
    };

    if (!variant.empty())
    {
        RxAlgoVersion version;
        if (!ParseVariant(variant, version))
        {
            Napi::Error::New(env, kVariantError).ThrowAsJavaScriptException();
            return env.Null();
        };

        apply_variant(variant);
    };

    auto seed_hash = ToVector(info[0].As<Napi::Buffer<uint8_t>>());

    {
        std::lock_guard<std::mutex> lock(mutex);
        updating = true;
    };

    auto *worker = new AllocateWorker(env, this, std::move(seed_hash));

    worker->Queue();
    return worker->GetPromise();
};

std::shared_ptr<RxVm> Rx::create_vm(uint32_t numa_node)
{
    if (!cache)
        return nullptr;

    randomx_dataset *dataset = nullptr;

    if (m_mode == RxMode::Fast)
    {
        auto it = datasets.find(numa_node);
        if (it == datasets.end() || !it->second)
            return nullptr;

        dataset = it->second;
    };

    uint8_t *scratch = alloc_numa(RANDOMX_SCRATCHPAD_L3, numa_node);
    if (!scratch) return nullptr;

    randomx_vm *vm = randomx_create_vm(build_flags(m_mode, algo_version()), cache, dataset, numa_node, scratch);
    if (!vm)
    {
        free_numa(scratch, RANDOMX_SCRATCHPAD_L3);
        return nullptr;
    };

    return std::make_shared<RxVm>(scratch, vm, active_vms);
};