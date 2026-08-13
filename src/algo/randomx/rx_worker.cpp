#include <thread>
#include <vector>
#include <algorithm>
#include <functional>

#include "rx_worker.h"

namespace
{
    void init_parallel(randomx_dataset *dataset, randomx_cache *cache, uint64_t items, int threads, const std::function<void(int)> &bind)
    {
        std::vector<std::thread> workers;
        workers.reserve(static_cast<size_t>(threads));

        for (int i = 0; i < threads; ++i)
        {
            const auto start = static_cast<uint32_t>((items * i) / threads);
            const auto end = static_cast<uint32_t>((items * (i + 1)) / threads);

            workers.emplace_back([=, &bind]
            {
                if (bind) bind(i);
                randomx_init_dataset(dataset, cache, start, end - start);
            });
        };

        for (auto &w : workers)
        {
            if (w.joinable()) w.join();
        };
    };
};

AllocateWorker::AllocateWorker(Napi::Env env, Rx *rx, std::vector<uint8_t> seed_hash) : Napi::AsyncWorker(env), rx(rx), seed_hash(std::move(seed_hash)), deferred(Napi::Promise::Deferred::New(env))
{
};

Napi::Promise AllocateWorker::GetPromise()
{
    return deferred.Promise();
};

void AllocateWorker::Execute()
{
    std::lock_guard<std::mutex> lock(rx->lifecycle);

    for (uint32_t spins = 0; rx->active_vms.load(std::memory_order_acquire) > 0; ++spins)
    {
        if (spins >= kDrainSpins)
            return SetError("timed out waiting for active VMs to release");

        std::this_thread::sleep_for(std::chrono::milliseconds(10));
    };

    rx->release();

    rx->cache = randomx_alloc_cache(build_cache_flags());
    if (!rx->cache)
    {
        SetError("randomx_alloc_cache failed");
        return;
    };

    randomx_init_cache(rx->cache, seed_hash.data(), std::min<size_t>(seed_hash.size(), kMaxSeedSize));

    if (rx->m_mode != RxMode::Fast)
    {
        result = true;
        return;
    };

    result = LargePagesSupported() && BuildDataset(static_cast<randomx_flags>(RANDOMX_FLAG_FULL_MEM | RANDOMX_FLAG_LARGE_PAGES));
    if (!result) result = BuildDataset(RANDOMX_FLAG_FULL_MEM);

    if (!result) SetError("randomx_alloc_dataset failed");
};

bool AllocateWorker::BuildDataset(randomx_flags flags)
{
    const uint64_t items = randomx_dataset_item_count();

#ifdef HAVE_HWLOC
    hwloc_topology_t topo;
    hwloc_topology_init(&topo);
    hwloc_topology_load(topo);

    int nodes = hwloc_get_nbobjs_by_type(topo, HWLOC_OBJ_NUMANODE);
    if (nodes <= 0) nodes = 1;

    bool ok = true;

    for (int n = 0; n < nodes; ++n)
    {
        hwloc_obj_t node = hwloc_get_obj_by_type(topo, HWLOC_OBJ_NUMANODE, n);
        const uint32_t numa_id = node ? node->os_index : 0u;

        if (rx->datasets.count(numa_id))
            continue;

        randomx_dataset *dataset = randomx_alloc_dataset(flags);
        if (!dataset)
        {
            ok = false;
            break;
        };

        rx->datasets[numa_id] = dataset;

        int pus = node ? hwloc_get_nbobjs_inside_cpuset_by_type(topo, node->cpuset, HWLOC_OBJ_PU) : hwloc_get_nbobjs_by_type(topo, HWLOC_OBJ_PU);
        if (pus <= 0) pus = 1;

        init_parallel(dataset, rx->cache, items, pus, [&](int i)
        {
            hwloc_obj_t pu = node ? hwloc_get_obj_inside_cpuset_by_type(topo, node->cpuset, HWLOC_OBJ_PU, i) : hwloc_get_obj_by_type(topo, HWLOC_OBJ_PU, i);
            if (pu) hwloc_set_cpubind(topo, pu->cpuset, HWLOC_CPUBIND_THREAD);
        });
    };

    hwloc_topology_destroy(topo);
    return ok;
#else
    randomx_dataset *dataset = randomx_alloc_dataset(flags);
    if (!dataset)
        return false;

    rx->datasets[0] = dataset;

    const int cpus = static_cast<int>(std::thread::hardware_concurrency());
    init_parallel(dataset, rx->cache, items, cpus > 0 ? cpus : 1, nullptr);

    return true;
#endif
};

void AllocateWorker::Clear()
{
    rx->updating.store(false, std::memory_order_release);
};

void AllocateWorker::OnOK()
{
    Clear();
    deferred.Resolve(Napi::Boolean::New(Env(), result));
};

void AllocateWorker::OnError(const Napi::Error &err)
{
    Clear();
    deferred.Reject(err.Value());
};