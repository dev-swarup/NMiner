#include <thread>
#include <vector>
#include <algorithm>

#include "rx_worker.h"

AllocateWorker::AllocateWorker(Napi::Env env, Rx *rx, std::vector<uint8_t> seed_hash, std::string variant) : Napi::AsyncWorker(env), deferred(Napi::Promise::Deferred::New(env)), rx(rx), seed_hash(std::move(seed_hash)), variant(std::move(variant)), result(false)
{
}

Napi::Promise AllocateWorker::GetPromise()
{
    return deferred.Promise();
}

void AllocateWorker::Execute()
{
    while (rx->active_vms.load(std::memory_order_acquire) > 0) std::this_thread::sleep_for(std::chrono::milliseconds(10));

    for (auto &[key, dataset] : rx->datasets)
        if (dataset) randomx_release_dataset(dataset);

    rx->datasets.clear();

    if (rx->cache)
    {
        randomx_release_cache(rx->cache);
        rx->cache = nullptr;
    }

    if (!variant.empty() && variant != "rx/0" && variant != "rx/monero")
    {
        SetError("Invalid variant: expected 'rx/0' or 'rx/monero'");
        return;
    }

    const randomx_flags cache_flags = build_cache_flags();
    rx->cache = randomx_alloc_cache(cache_flags);
    if (!rx->cache)
    {
        SetError("randomx_alloc_cache failed");
        return;
    }

    const size_t seed_len = std::min<size_t>(seed_hash.size(), kMaxSeedSize);
    randomx_init_cache(rx->cache, seed_hash.data(), seed_len);

    if (rx->m_mode != RxMode::Fast)
    {
        result = true;
        return;
    }

    randomx_flags dataset_flags = RANDOMX_FLAG_FULL_MEM;
    if (LargePagesSupported()) dataset_flags = static_cast<randomx_flags>(dataset_flags | RANDOMX_FLAG_LARGE_PAGES);

    const uint64_t item_count = randomx_dataset_item_count();

#ifdef HAVE_HWLOC
    hwloc_topology_t topo;

    hwloc_topology_init(&topo);
    hwloc_topology_load(topo);

    int num_nodes = hwloc_get_nbobjs_by_type(topo, HWLOC_OBJ_NUMANODE);
    if (num_nodes <= 0) num_nodes = 1;

    for (int n = 0; n < num_nodes; ++n)
    {
        hwloc_obj_t node = hwloc_get_obj_by_type(topo, HWLOC_OBJ_NUMANODE, n);
        const uint32_t numa_id = node ? node->os_index : 0u;

        if (rx->datasets.count(numa_id))
            continue;

        rx->datasets[numa_id] = randomx_alloc_dataset(dataset_flags);
        if (!rx->datasets[numa_id])
        {
            SetError("randomx_alloc_dataset failed");
            hwloc_topology_destroy(topo);
            return;
        }

        int num_pus = node ? hwloc_get_nbobjs_inside_cpuset_by_type(topo, node->cpuset, HWLOC_OBJ_PU) : hwloc_get_nbobjs_by_type(topo, HWLOC_OBJ_PU);
        if (num_pus <= 0) num_pus = 1;

        std::vector<std::thread> workers;
        workers.reserve(static_cast<size_t>(num_pus));

        for (int i = 0; i < num_pus; ++i)
        {
            const auto start = static_cast<uint32_t>((item_count * i) / num_pus);
            const auto end = static_cast<uint32_t>((item_count * (i + 1)) / num_pus);
            const uint32_t sz = end - start;

            hwloc_obj_t pu = node ? hwloc_get_obj_inside_cpuset_by_type(topo, node->cpuset, HWLOC_OBJ_PU, i) : hwloc_get_obj_by_type(topo, HWLOC_OBJ_PU, i);
            const uint32_t core_id = pu ? pu->os_index : 0u;

            workers.emplace_back([this, numa_id, start, sz, core_id, &topo]
            {
                hwloc_obj_t tpu = hwloc_get_obj_by_type(topo, HWLOC_OBJ_PU, static_cast<int>(core_id));
                if (tpu) hwloc_set_cpubind(topo, tpu->cpuset, HWLOC_CPUBIND_THREAD);

                const uint32_t aligned = sz - (sz % 5);
                if (aligned > 0) randomx_init_dataset(rx->datasets[numa_id], rx->cache, start, aligned);
                if (sz % 5) randomx_init_dataset(rx->datasets[numa_id], rx->cache, start + aligned, sz % 5); 
            });
        }

        for (auto &w : workers)
            if (w.joinable()) w.join();
    }

    hwloc_topology_destroy(topo);
#else
    rx->datasets[0] = randomx_alloc_dataset(dataset_flags);
    if (!rx->datasets[0])
    {
        SetError("randomx_alloc_dataset failed");
        return;
    }

    const int cpu_count = static_cast<int>(std::thread::hardware_concurrency());

    if (cpu_count <= 1)
    {
        randomx_init_dataset(rx->datasets[0], rx->cache, 0, static_cast<uint32_t>(item_count));
    }
    else
    {
        std::vector<std::thread> workers;
        workers.reserve(static_cast<size_t>(cpu_count));

        for (int i = 0; i < cpu_count; ++i)
        {
            const auto start = static_cast<uint32_t>((item_count * i) / cpu_count);
            const auto end = static_cast<uint32_t>((item_count * (i + 1)) / cpu_count);
            const uint32_t sz = end - start;

            workers.emplace_back([this, start, sz]
            {
                const uint32_t aligned = sz - (sz % 5);
                if (aligned > 0) randomx_init_dataset(rx->datasets[0], rx->cache, start, aligned);
                if (sz % 5) randomx_init_dataset(rx->datasets[0], rx->cache, start + aligned, sz % 5); 
            });
        }

        for (auto &w : workers)
            if (w.joinable()) w.join();
    }
#endif
    result = true;
}

void AllocateWorker::OnOK()
{
    {
        std::lock_guard<std::mutex> lock(rx->mutex);
        rx->updating = false;
    }

    deferred.Resolve(Napi::Boolean::New(Env(), result));
}

void AllocateWorker::OnError(const Napi::Error &err)
{
    {
        std::lock_guard<std::mutex> lock(rx->mutex);
        rx->updating = false;
    }

    deferred.Reject(err.Value());
}