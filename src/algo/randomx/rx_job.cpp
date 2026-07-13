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
    Napi::Function Fn = DefineClass(env, "RxJob", {
        InstanceMethod("send_job", &RxJob::SendJob),
        InstanceMethod("start", &RxJob::Start),
        InstanceMethod("pause", &RxJob::Pause),
        InstanceMethod("stop", &RxJob::Stop)
    });

    exports.Set("RxJob", Fn);
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

    std::string job_id = info[0].As<Napi::String>().Utf8Value();

    bool blob_changed;
    size_t new_blob_size;
    uint8_t new_blob[kMaxBlobSize]{};
    uint32_t num_transactions = 0;
    {
        std::string blob = info[1].As<Napi::String>();

        new_blob_size = blob.size() / 2;
        if (hex2bin(new_blob, sizeof(new_blob), blob.c_str(), blob.size(), nullptr, nullptr, nullptr) != 0) 
        {
            Napi::Error::New(env, "Failed to decode blob").ThrowAsJavaScriptException();
            return env.Null();
        };

        const size_t expected_tx_offset = 75;
        if (new_blob_size > expected_tx_offset && new_blob_size <= expected_tx_offset + 4)
        {
            for (size_t i = expected_tx_offset, k = 0; i < new_blob_size; ++i, k += 7)
            {
                const uint8_t b = new_blob[i];
                num_transactions |= static_cast<uint32_t>(b & 0x7Fu) << k;
                if ((b & 0x80u) == 0) break;
            };
        };

        if (new_blob_size != m_size)
            blob_changed = true;
        else {
            for (size_t i = 0; i < new_blob_size; ++i) {
                if (i >= kNonceOffset && i < kNonceOffset + 4) continue;
                    if (new_blob[i] != m_blob[i]) {
                        blob_changed = true;
                        break;
                    };
            };
        };
    };

    uint8_t raw[4];
    uint64_t new_diff = 0;
    uint64_t new_target = 0;
    {
        std::string difficulty = info[2].As<Napi::String>();

        if (hex2bin(raw, sizeof(raw), difficulty.c_str(), difficulty.size(), nullptr, nullptr, nullptr) == 0)
        {
            new_target = 0xFFFFFFFFFFFFFFFFULL / (0xFFFFFFFFULL / uint64_t(*reinterpret_cast<const uint32_t *>(raw)));
            new_diff = static_cast<uint64_t>(0xFFFFFFFFFFFFFFFFULL / new_target);
        };
    };

    exports.Set("txnCount", Napi::Number::New(env, num_transactions));
    exports.Set("diff", Napi::Number::New(env, new_diff));

    {
        std::lock_guard<std::mutex> lock(m_job_mutex);
        m_job_id = job_id;
        m_size = new_blob_size;
        memcpy(m_blob, new_blob, new_blob_size);
        m_target = new_target;
        m_diff = new_diff;
        m_nicehash = readUnaligned(reinterpret_cast<uint32_t *>(m_blob + kNonceOffset)) != 0;
        
        if (blob_changed) 
        {
            m_nonce_counter.store(0, std::memory_order_relaxed);
        };

        m_job_version.fetch_add(1, std::memory_order_release);
    };

    return exports;
};

Napi::Value RxJob::Start(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    if (m_active.load()) return env.Undefined();

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

    return env.Undefined();
};

Napi::Value RxJob::Pause(const Napi::CallbackInfo& info)
{
    
    return info.Env().Undefined();
};

Napi::Value RxJob::Stop(const Napi::CallbackInfo& info)
{
    StopLoop();
    return info.Env().Undefined();
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

    size_t local_size = 0;
    uint64_t local_target = 0;
    uint32_t local_version = 0;
    std::string local_job_id;

    bool is_first = true;
    alignas(16) uint8_t next_blob[kMaxBlobSize]{};
    alignas(16) uint8_t local_blob[kMaxBlobSize]{};
    
    while (m_active.load(std::memory_order_relaxed))
    {
        if (rx->updating.load(std::memory_order_acquire))
        {
            if (vm) vm.reset();
            
            while (rx->updating.load(std::memory_order_acquire) && m_active.load(std::memory_order_relaxed))
            {
                std::this_thread::sleep_for(std::chrono::milliseconds(10));
            };
            
            if (!m_active.load(std::memory_order_relaxed)) break;

            vm = rx->create_vm(numa_node);
            if (!vm || !vm->vm) break;
            
            is_first = true;
            local_version = m_job_version.load(std::memory_order_acquire) - 1;
            continue;
        };

        uint32_t current_version = m_job_version.load(std::memory_order_acquire);
        if (local_version != current_version) 
        {
            if (!is_first && local_size > 0) 
            {
                uint8_t hash[RANDOMX_HASH_SIZE];
                randomx_calculate_hash_last(vm->vm, hash);
                uint64_t hash64 = readUnaligned(reinterpret_cast<uint64_t*>(hash + 24));
                if (hash64 <= local_target) 
                {
                    char hex_nonce[9];
                    bin2hex(hex_nonce, sizeof(hex_nonce), local_blob + kNonceOffset, 4);
                    
                    char hex_hash[65];
                    bin2hex(hex_hash, sizeof(hex_hash), hash, 32);
                    
                    SubmitData* data = new SubmitData();
                    data->nonce = hex_nonce;
                    data->result = hex_hash;
                    data->job_id = local_job_id;

                    tsfn.BlockingCall(data, [](Napi::Env env, Napi::Function jsSubmit, SubmitData* data) 
                    {
                        jsSubmit.Call({ Napi::String::New(env, data->job_id), Napi::String::New(env, data->nonce), Napi::String::New(env, data->result) });
                        delete data;
                    });
                };
            };
            
            {
                std::lock_guard<std::mutex> lock(m_job_mutex);
                memcpy(local_blob, m_blob, m_size);
                local_size = m_size;
                local_target = m_target;
                local_job_id = m_job_id;
                local_version = m_job_version.load(std::memory_order_relaxed);
            };
            
            is_first = true; 
        };

        if (local_size == 0)
        {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            continue;
        };

        uint32_t nonce = m_nonce_counter.fetch_add(1, std::memory_order_relaxed);
        
        if (is_first) 
        {
            if (m_nicehash) 
            {
                uint32_t current_nonce = readUnaligned(reinterpret_cast<uint32_t*>(local_blob + kNonceOffset));
                current_nonce = (current_nonce & 0x000000FF) | (nonce << 8);

                writeUnaligned(reinterpret_cast<uint32_t*>(local_blob + kNonceOffset), current_nonce);
            } 
            else 
            {
                writeUnaligned(reinterpret_cast<uint32_t*>(local_blob + kNonceOffset), nonce);
            };

            is_first = false;
            randomx_calculate_hash_first(vm->vm, local_blob, local_size);
            memcpy(next_blob, local_blob, local_size);

            continue; 
        };

        if (m_nicehash) 
        {
            uint32_t current_nonce = readUnaligned(reinterpret_cast<uint32_t*>(next_blob + kNonceOffset));
            current_nonce = (current_nonce & 0x000000FF) | (nonce << 8);

            writeUnaligned(reinterpret_cast<uint32_t*>(next_blob + kNonceOffset), current_nonce);
        } 
        else 
        {
            writeUnaligned(reinterpret_cast<uint32_t*>(next_blob + kNonceOffset), nonce);
        };

        uint8_t hash[RANDOMX_HASH_SIZE];
        randomx_calculate_hash_next(vm->vm, next_blob, local_size, hash);

        uint64_t hash64 = readUnaligned(reinterpret_cast<uint64_t*>(hash + 24));
        if (hash64 <= local_target) 
        {
            char hex_nonce[9];
            bin2hex(hex_nonce, sizeof(hex_nonce), local_blob + kNonceOffset, 4);
            
            char hex_hash[65];
            bin2hex(hex_hash, sizeof(hex_hash), hash, 32);
            
            SubmitData* data = new SubmitData();
            data->nonce = hex_nonce;
            data->result = hex_hash;
            data->job_id = local_job_id;

            tsfn.BlockingCall(data, [](Napi::Env env, Napi::Function jsSubmit, SubmitData* data) 
            {
                jsSubmit.Call({ Napi::String::New(env, data->job_id), Napi::String::New(env, data->nonce), Napi::String::New(env, data->result) });
                delete data;
            });
        };

        memcpy(local_blob, next_blob, local_size);
    };

    if (!is_first && local_size > 0) 
    {
        uint8_t hash[RANDOMX_HASH_SIZE];
        randomx_calculate_hash_last(vm->vm, hash);
        uint64_t hash64 = readUnaligned(reinterpret_cast<uint64_t*>(hash + 24));
        if (hash64 <= local_target) 
        {
            char hex_nonce[9];
            bin2hex(hex_nonce, sizeof(hex_nonce), local_blob + kNonceOffset, 4);
            
            char hex_hash[65];
            bin2hex(hex_hash, sizeof(hex_hash), hash, 32);
            
            SubmitData* data = new SubmitData();
            data->nonce = hex_nonce;
            data->result = hex_hash;
            data->job_id = local_job_id;

            tsfn.BlockingCall(data, [](Napi::Env env, Napi::Function jsSubmit, SubmitData* data) 
            {
                jsSubmit.Call({ Napi::String::New(env, data->job_id), Napi::String::New(env, data->nonce), Napi::String::New(env, data->result) });
                delete data;
            });
        };
    };

    vm.reset();
    return;
};