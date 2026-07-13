#include <iostream>
#include <iomanip>
#include <sstream>
#include <cstring>

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/mman.h>
#endif

#include "rx_job.h"

static std::string bytes_to_hex(const uint8_t* data, size_t len) 
{
    std::ostringstream oss;
    oss << std::hex << std::setfill('0');

    for (size_t i = 0; i < len; ++i) 
    {
        oss << std::setw(2) << static_cast<int>(data[i]);
    };

    return oss.str();
};


RxJob::RxJob(const Napi::CallbackInfo& info) : Napi::ObjectWrap<RxJob>(info)
{
    Napi::Env env = info.Env();
    if (info.Length() < 2 || !info[0].IsObject() || !info[1].IsFunction())
    {
        Napi::Error::New(env, "Expected Rx instance and submitFn").ThrowAsJavaScriptException();
        return;
    };

    rx = Rx::Unwrap(info[0].As<Napi::Object>());
    tsfn = Napi::ThreadSafeFunction::New(env, info[1].As<Napi::Function>(), "jsSubmit", 0, 1, [](Napi::Env) {});

#ifdef HAVE_HWLOC
    hwloc_topology_init(&topology);
    hwloc_topology_load(topology);
#endif
};

RxJob::~RxJob()
{
    StopLoop();

#ifdef HAVE_HWLOC
    if (topology) hwloc_topology_destroy(topology);
#endif
};

Napi::Object RxJob::Init(Napi::Env env, Napi::Object exports)
{
    Napi::Function Fn = DefineClass(env, "Job", {
        InstanceMethod("send_job", &RxJob::SendJob),
        InstanceMethod("start", &RxJob::Start),
        InstanceMethod("pause", &RxJob::Pause),
        InstanceMethod("stop", &RxJob::Stop)
    });

    exports.Set("Job", Fn);
    return exports;
};

Napi::Value RxJob::SendJob(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    Napi::Object exports = Napi::Object::New(env);

    if (info.Length() != 4 || !info[0].IsString() || !info[1].IsString() || !info[2].IsString() || !info[3].IsBoolean()) 
    {
        Napi::Error::New(env, "Expected job_id, blob, difficulty and reset nonce").ThrowAsJavaScriptException();
        return env.Null();
    };

    job_id = info[0].As<Napi::String>().Utf8Value();

    {
        std::string blob = info[0].As<Napi::String>();

        m_size = blob.size() / 2;
        if (hex2bin(m_blob, sizeof(m_blob), blob.c_str(), blob.size(), nullptr, nullptr, nullptr) == 0) 
        {
            m_nicehash = readUnaligned(reinterpret_cast<uint32_t *>(m_blob + kNonceOffset)) != 0;

            uint32_t num_transactions = 0;
            const size_t expected_tx_offset = 75;
            if (m_size > expected_tx_offset && m_size <= expected_tx_offset + 4)
            {
                for (size_t i = expected_tx_offset, k = 0; i < m_size; ++i, k += 7)
                {
                    const uint8_t b = m_blob[i];
                    num_transactions |= static_cast<uint32_t>(b & 0x7Fu) << k;
                    if ((b & 0x80u) == 0) break;
                };
            };

            exports.Set("txnCount", Napi::Number::New(env, num_transactions));
        };
    };

    {
        uint8_t raw[4];
        std::string target = info[1].As<Napi::String>();

        if (hex2bin(raw, sizeof(raw), target.c_str(), target.size(), nullptr, nullptr, nullptr) != 0)
        {
            m_target = 0xFFFFFFFFFFFFFFFFULL / (0xFFFFFFFFULL / uint64_t(*reinterpret_cast<const uint32_t *>(raw)));
            m_diff = static_cast<uint64_t>(0xFFFFFFFFFFFFFFFFULL / m_target);
        };

        exports.Set("diff", Napi::Number::New(env, m_diff));
    };

    if (info[3].As<Napi::Boolean>().Value())
    {

    };

    return Napi::Boolean::New(env, true);
};

Napi::Value RxJob::Start(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (m_active.load()) return Napi::Boolean::New(env, false);

    uint32_t thread_count = 0;
    if (info.Length() > 0 && info[0].IsNumber()) thread_count = info[0].As<Napi::Number>().Uint32Value();

    m_active.store(true);

#ifdef HAVE_HWLOC
    int num_pus = hwloc_get_nbobjs_by_type(topology, HWLOC_OBJ_PU);
    if (thread_count == 0 || thread_count > (uint32_t)num_pus) thread_count = num_pus;

    for (uint32_t i = 0; i < thread_count; ++i) 
    {
        hwloc_obj_t pu = hwloc_get_obj_by_type(topology, HWLOC_OBJ_PU, i % num_pus);
        uint32_t core_id = pu->os_index;
        
        hwloc_obj_t node_obj = hwloc_get_ancestor_obj_by_type(topology, HWLOC_OBJ_NUMANODE, pu);
        uint32_t numa_node = node_obj ? node_obj->os_index : 0;

        m_threads.push_back(std::thread(&RxJob::Loop, this, i, core_id, numa_node));
    };
#else
    if (thread_count == 0) thread_count = std::thread::hardware_concurrency();

    for (uint32_t i = 0; i < thread_count; ++i) 
    {
        m_threads.push_back(std::thread(&RxJob::Loop, this, i, i, 0));
    };
#endif

    return Napi::Boolean::New(env, true);
};

Napi::Value RxJob::Pause(const Napi::CallbackInfo& info)
{
    return Napi::Boolean::New(info.Env(), false);
};

Napi::Value RxJob::Stop(const Napi::CallbackInfo& info)
{
    StopLoop();
    return Napi::Boolean::New(info.Env(), true);
};

void RxJob::StopLoop()
{
    m_active.store(false);

    for (auto& t : m_threads) 
    {
        if (t.joinable()) t.join();
    };

    m_threads.clear();
};

void RxJob::Loop(uint32_t thread_index, uint32_t core_id, uint32_t numa_node)
{
#ifdef HAVE_HWLOC
    hwloc_obj_t pu = hwloc_get_obj_by_type(topology, HWLOC_OBJ_PU, core_id);
    if (pu) hwloc_set_cpubind(topology, pu->cpuset, HWLOC_CPUBIND_THREAD);
#endif

    std::shared_ptr<randomx_numa> vm = rx->create_vm(numa_node);
    if (!vm || !vm->vm) 
    {
        vm.reset();
        return;
    };

    while (m_active.load(std::memory_order_relaxed))
    {

    };

    vm.reset();
    return;
};