#pragma once
#include <map>
#include <mutex>
#include <atomic>
#include <memory>
#include <string>
#include <vector>
#include <cstring>
#include <cstdint>

#include <napi.h>
#include "randomx.h"
#include "configuration.h"

#ifdef HAVE_HWLOC
#include <hwloc.h>
#endif

static constexpr size_t kMaxSeedSize = 32;

inline std::vector<uint8_t> ToVector(const Napi::Buffer<uint8_t> &buf)
{
    return std::vector<uint8_t>(buf.Data(), buf.Data() + buf.Length());
};

inline std::vector<uint32_t> ParseThreads(Napi::Value val)
{
    std::vector<uint32_t> threads;
    if (!val.IsArray()) return threads;

    Napi::Array arr = val.As<Napi::Array>();
    threads.reserve(arr.Length());

    for (uint32_t i = 0; i < arr.Length(); ++i)
        threads.push_back(arr.Get(i).As<Napi::Number>().Uint32Value());

    return threads;
};

inline uint64_t ParseTarget(const std::vector<uint8_t> &target)
{
    uint64_t value = 0;

    if (target.size() >= 8)
        std::memcpy(&value, target.data(), sizeof(value));
    else if (target.size() >= 4)
    {
        uint32_t compact = 0;
        std::memcpy(&compact, target.data(), sizeof(compact));

        if (compact) value = 0xFFFFFFFFFFFFFFFFULL / (0xFFFFFFFFULL / uint64_t(compact));
    };

    return value;
};

enum class RxAlgoVersion : uint8_t
{
    V1 = 1,
    V2 = 2,
};

constexpr const char *kVariantError = "Invalid variant: expected 'rx/0', 'rx/monero' or 'rx/v2'";

inline bool ParseVariant(const std::string &variant, RxAlgoVersion &version)
{
    if (variant == "rx/0" || variant == "rx/monero")
        version = RxAlgoVersion::V1;
    else if (variant == "rx/v2")
        version = RxAlgoVersion::V2;
    else
        return false;

    return true;
};

enum class RxMode : uint8_t
{
    Fast = 1,
    Light = 0,
};

bool LargePagesSupported();
const char *AesImplName();
const char *Blake2ImplName();

randomx_flags build_flags(RxMode mode, RxAlgoVersion version);
randomx_flags build_cache_flags();

struct RxVm
{
    RxVm(uint8_t *scratchpad, randomx_vm *vm, std::atomic<int> &active);
    ~RxVm();

    RxVm(const RxVm &) = delete;
    RxVm &operator=(const RxVm &) = delete;

    uint8_t *scratchpad;
    randomx_vm *vm;
    std::atomic<int> &active;
};

class Rx : public Napi::ObjectWrap<Rx>
{
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);

    Rx(const Napi::CallbackInfo &info);
    ~Rx();

    Napi::Value allocate(const Napi::CallbackInfo &info);
    Napi::Value reallocate(const Napi::CallbackInfo &info);
    Napi::Value GetVariant(const Napi::CallbackInfo &info);

    std::shared_ptr<RxVm> create_vm(uint32_t numa_node);
    void release();

    RxAlgoVersion algo_version() const { return m_version.load(std::memory_order_relaxed); };

    std::mutex lifecycle;
    std::atomic<int> active_vms { 0 };
    std::atomic<bool> updating { false };
    RxMode m_mode { RxMode::Light };
    randomx_cache *cache { nullptr };

    std::map<uint32_t, randomx_dataset *> datasets;

private:
    Napi::Value queue_allocate(const Napi::CallbackInfo &info, const std::string &variant);
    void apply_variant(const std::string &variant);

    std::string m_variant { "rx/0" };
    std::atomic<RxAlgoVersion> m_version { RxAlgoVersion::V1 };
};