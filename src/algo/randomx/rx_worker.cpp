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

    if (rx->cache || rx->datasets.size() > 0)
    {
        for (auto const& [k, dataset] : rx->datasets) 
        {
            if (dataset) randomx_release_dataset(dataset);
        };

        rx->datasets.clear();
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

    randomx_init_cache(rx->cache, seed_hash.data(), std::min<std::size_t>(seed_hash.size(), static_cast<std::size_t>(kMaxSeedSize)));

    if (rx->m_mode == RANDOMX_FAST) 
    {
        randomx_flags dataset_flags = (randomx_flags)RANDOMX_FLAG_FULL_MEM;

        if (LargePagesSupported())
            dataset_flags = (randomx_flags)(dataset_flags | RANDOMX_FLAG_LARGE_PAGES);

        const uint64_t dataset_count = randomx_dataset_item_count();

#ifdef HAVE_HWLOC
        hwloc_topology_t topology;
        hwloc_topology_init(&topology);
        hwloc_topology_load(topology);

        int num_numa = hwloc_get_nbobjs_by_type(topology, HWLOC_OBJ_NUMANODE);
        if (num_numa <= 0) num_numa = 1;

        for (int n = 0; n < num_numa; ++n)
        {
            hwloc_obj_t node_obj = hwloc_get_obj_by_type(topology, HWLOC_OBJ_NUMANODE, n);
            uint32_t numa_node = node_obj ? node_obj->os_index : 0;

            if (rx->datasets.find(numa_node) == rx->datasets.end()) 
            {
                hwloc_cpuset_t cpuset = node_obj ? hwloc_bitmap_dup(node_obj->cpuset) : hwloc_bitmap_alloc();
                if (node_obj) hwloc_set_cpubind(topology, cpuset, HWLOC_CPUBIND_THREAD);
                
                rx->datasets[numa_node] = randomx_alloc_dataset(dataset_flags);
                
                if (node_obj) hwloc_bitmap_free(cpuset);

                if (!rx->datasets[numa_node]) 
                { 
                    SetError("Failed to allocate rx dataset"); 

                    hwloc_topology_destroy(topology);
                    return; 
                };
            };

            int num_pus = node_obj ? hwloc_get_nbobjs_inside_cpuset_by_type(topology, node_obj->cpuset, HWLOC_OBJ_PU) : hwloc_get_nbobjs_by_type(topology, HWLOC_OBJ_PU);
            if (num_pus <= 0) num_pus = 1;

            std::vector<std::thread> threads;
            threads.reserve(num_pus);

            for (int i = 0; i < num_pus; ++i) 
            {
                const uint32_t start = static_cast<uint32_t>((dataset_count * i) / num_pus);
                const uint32_t end   = static_cast<uint32_t>((dataset_count * (i + 1)) / num_pus);
                const uint32_t size  = end - start;

                hwloc_obj_t pu = node_obj ? hwloc_get_obj_inside_cpuset_by_type(topology, node_obj->cpuset, HWLOC_OBJ_PU, i) : hwloc_get_obj_by_type(topology, HWLOC_OBJ_PU, i);
                uint32_t core_id = pu ? pu->os_index : 0;

                threads.emplace_back([this, numa_node, start, size, core_id]() 
                {
                    hwloc_topology_t thread_topology;
                    hwloc_topology_init(&thread_topology);
                    hwloc_topology_load(thread_topology);

                    hwloc_obj_t thread_pu = hwloc_get_obj_by_type(thread_topology, HWLOC_OBJ_PU, core_id);
                    if (thread_pu) hwloc_set_cpubind(thread_topology, thread_pu->cpuset, HWLOC_CPUBIND_THREAD);

                    if (size % 5) 
                    {
                        randomx_init_dataset(rx->datasets[numa_node], rx->cache, start, size - (size % 5));
                        randomx_init_dataset(rx->datasets[numa_node], rx->cache, start + size - 5, 5);
                    } 
                    else 
                    {
                        randomx_init_dataset(rx->datasets[numa_node], rx->cache, start, size);
                    };
                    
                    hwloc_topology_destroy(thread_topology);
                });
            };

            for (auto &t : threads) 
            {
                if (t.joinable()) t.join();
            };
        };

        hwloc_topology_destroy(topology);
#else
        if (rx->datasets.find(0) == rx->datasets.end()) 
        {
            rx->datasets[0] = randomx_alloc_dataset(dataset_flags);

            if (!rx->datasets[0]) 
            {
                SetError("Failed to allocate rx dataset");
                return;
            };
        };
        
        int threads_count = std::thread::hardware_concurrency();
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
                    if (size % 5) 
                    {
                        randomx_init_dataset(rx->datasets[0], rx->cache, start, size - (size % 5));
                        randomx_init_dataset(rx->datasets[0], rx->cache, start + size - 5, 5);
                    } 
                    else 
                    {
                        randomx_init_dataset(rx->datasets[0], rx->cache, start, size);
                    };
                });
            };

            for (auto &t : threads) 
            {
                if (t.joinable()) t.join();
            };
        } 
        else
        {
            randomx_init_dataset(rx->datasets[0], rx->cache, 0, dataset_count);
        };
#endif
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