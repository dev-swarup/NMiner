#include <thread>
#include <vector>
#include <algorithm>

#include "rx_worker.h"

AllocateWorker::AllocateWorker(Napi::Env env, Rx* rx, std::vector<uint8_t> seed_hash, std::string variant) : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env)), rx(rx), seed_hash(seed_hash), variant(variant), result(false) 
{

};

AllocateWorker::~AllocateWorker() 
{

};

void AllocateWorker::Execute() 
{
    while (rx->active_vms.load(std::memory_order_acquire) > 0) 
    {
        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    };

    if (rx->cache || rx->dataset)
    {
        if (rx->dataset) randomx_release_dataset(rx->dataset);
        if (rx->cache) randomx_release_cache(rx->cache);
    };

    if (!variant.empty()) 
    {
        if (variant == "rx/0" || variant == "rx/monero")
        {

        }
        else
        {
            SetError("Invalid variant");
            return;
        };
    };

    randomx_flags flags = build_cache_flags();

    if (!rx->cache) 
    {
        rx->cache = randomx_alloc_cache(flags);
        if (!rx->cache) 
        { 
            SetError("Failed to allocate rx cache"); 
            return; 
        };
    };

    if (rx->m_mode == RANDOMX_FAST && !rx->dataset) {
        randomx_flags dataset_flags = (randomx_flags)RANDOMX_FLAG_FULL_MEM;
        
        if (LargePagesSupported())
            dataset_flags = (randomx_flags)(dataset_flags | RANDOMX_FLAG_LARGE_PAGES);

        rx->dataset = randomx_alloc_dataset(dataset_flags);
        if (!rx->dataset)
        { 
            SetError("Failed to allocate rx dataset"); 
            return; 
        };
    };

    randomx_init_cache(rx->cache, seed_hash.data(), std::min<std::size_t>(seed_hash.size(), static_cast<std::size_t>(kMaxSeedSize)));

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