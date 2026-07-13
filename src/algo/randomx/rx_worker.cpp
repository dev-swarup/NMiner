#include <thread>
#include <vector>
#include "rx_worker.h"

AllocateWorker::AllocateWorker(Napi::Env env, Rx* rx, std::string seed_hash, std::string variant) : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env)), rx(rx), seed_hash(seed_hash), variant(variant), result(false) 
{

};

AllocateWorker::~AllocateWorker() 
{

};

void AllocateWorker::Execute() 
{
    if (rx->cache || rx->dataset)
    {
        if (rx->dataset) randomx_release_dataset(rx->dataset);
        if (rx->cache) randomx_release_cache(rx->cache);
    };

    if (!variant.empty()) 
    {
        if (variant == "rx/0" || variant == "rx/monero")
            randomx_apply_config(RandomX_MoneroConfig);
        else if (variant == "rx/wow") randomx_apply_config(RandomX_WowneroConfig);
        else if (variant == "rx/arq") randomx_apply_config(RandomX_ArqmaConfig);
        else if (variant == "rx/sfx") randomx_apply_config(RandomX_SafexConfig);
        else if (variant == "rx/yada") randomx_apply_config(RandomX_YadaConfig);
        else if (variant == "rx/graft") randomx_apply_config(RandomX_GraftConfig);
        else 
        {
            SetError("Invalid variant");
            return;
        };
    };

    const randomx_flags flags = build_cache_flags();

    if (!rx->cache) 
    {
        rx->cache = randomx_create_cache(flags, nullptr);
        if (!rx->cache) 
        { 
            SetError("Failed to allocate rx cache"); 
            return; 
        };
    };

    if (rx->m_mode == RANDOMX_FAST && !rx->dataset) {
        rx->dataset = randomx_alloc_dataset((randomx_flags)(flags | RANDOMX_FLAG_FULL_MEM));
        if (!rx->dataset)
        { 
            SetError("Failed to allocate rx dataset"); 
            return; 
        };
    };

    randomx_init_cache(rx->cache, seed_hash.c_str(), seed_hash.size());

    if (rx->m_mode == RANDOMX_FAST) 
    {
        int threads_count = std::thread::hardware_concurrency();
        const uint64_t dataset_count = randomx_dataset_item_count();

        if (threads_count > 1) 
        {
            std::vector<std::thread> threads;
            threads.reserve(threads_count);

            for (uint32_t i = 0; i < threads_count; ++i) {
                const uint32_t start = static_cast<uint32_t>((dataset_count * i) / threads_count);
                const uint32_t end   = static_cast<uint32_t>((dataset_count * (i + 1)) / threads_count);
                const uint32_t size  = end - start;

                threads.emplace_back([this, start, size]() 
                {
                    if (size % 5) {
                        randomx_init_dataset(rx->dataset, rx->cache, start, size - (size % 5));
                        randomx_init_dataset(rx->dataset, rx->cache, start + size - 5, 5);
                    } else {
                        randomx_init_dataset(rx->dataset, rx->cache, start, size);
                    };
                });
            };

            for (auto &t : threads) 
            {
                if (t.joinable()) t.join();
            };
        } else {
            randomx_init_dataset(rx->dataset, rx->cache, 0, dataset_count);
        };
    };

    result = true;
};

void AllocateWorker::OnOK() 
{
    {
        std::lock_guard<std::mutex> lock(rx->mutex);
        rx->updating = false;
    };

    deferred.Resolve(Napi::Boolean::New(Env(), result));
};

void AllocateWorker::OnError(const Napi::Error& e) 
{
    {
        std::lock_guard<std::mutex> lock(rx->mutex);
        rx->updating = false;
    };

    deferred.Reject(e.Value());
};

Napi::Promise AllocateWorker::GetPromise() 
{ 
    return deferred.Promise(); 
};