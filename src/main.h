#include <mutex>
#include <string>
#include <thread>
#include <chrono>
#include <vector>
#include <memory>
#include <functional>

#include <Job.h>
#include <numa.h>
#include <randomx.h>

struct randomx_virtual_machine
{
    int hashes = 0;
    std::mutex hashrate;

    bool stop = false;
    RandomX::Job* job = nullptr;
    std::vector<std::thread> m_threads;
};

std::shared_ptr<randomx_virtual_machine> randomx_start_vm(const std::string& mode, size_t threads, RandomX::Job* job, randomx_cache* cache, randomx_dataset* dataset)
{
    std::shared_ptr<randomx_virtual_machine> vm = std::make_shared<randomx_virtual_machine>();
    
    vm->job = job;
    for (size_t i = 0; i < threads; i++)
    {
        randomx_vm* machine;
        if (mode == "FAST")
            machine = randomx_create_vm(RANDOMX_FLAG_JIT | RANDOMX_FLAG_HARD_AES | RANDOMX_FLAG_FULL_MEM, nullptr, dataset);
        else
            machine = randomx_create_vm(RANDOMX_FLAG_JIT | RANDOMX_FLAG_HARD_AES, cache, nullptr);
    
        if (!machine)
            continue;

        vm->m_threads.emplace_back([vm, machine]()
        {
            while (!vm->stop)
            {
                if (!vm->job)
                {
                    std::this_thread::sleep_for(std::chrono::milliseconds(100));
                    continue;
                };

                char result[RANDOMX_HASH_SIZE];
                randomx_calculate_hash(machine, vm->job->blob(), kMaxBlobSize, result);

                {
                    std::lock_guard<std::mutex> lock(vm->hashrate);
                    vm->hashes += 1;
                }
            };
            
            randomx_destroy_vm(machine);
        });
    };

    return vm;
};

struct randomx_machine
{
    size_t threads;
    std::string mode;

    RandomX::Job* job = nullptr;
    randomx_cache* cache = nullptr;
    randomx_dataset* dataset = nullptr;
    std::shared_ptr<randomx_virtual_machine> vm = nullptr;
    
    bool alloc()
    {
        if (dataset)
        {    
            randomx_release_dataset(dataset);
            dataset = nullptr;
        };
    
        if (cache)
        {
            randomx_release_cache(cache);
            cache = nullptr;
        };
    
    
        cache = randomx_alloc_cache(RANDOMX_FLAG_JIT | RANDOMX_FLAG_HARD_AES | RANDOMX_FLAG_SECURE | RANDOMX_FLAG_ARGON2);
        if (!cache)
            return false;
    
        if (mode == "FAST")
        {
            dataset = randomx_alloc_dataset(RANDOMX_FLAG_FULL_MEM);
            if (!dataset)
                return false;
        };
    
        return true;
    };

    bool init(RandomX::Job* m_job, size_t threads)
    {
        if (!m_job)
            return false;

        if (!cache)
            return false;
        
        if (!dataset && mode == "FAST")
            return false;
        
        randomx_init_cache(cache, m_job->seed_hash().c_str(), m_job->seed_hash().size());
        if (mode == "FAST")
        {
            const uint64_t dataset_count = randomx_dataset_item_count();
            if (threads > 1)
            {
                std::vector<std::thread> m_threads;
                m_threads.reserve(threads);

                for (uint64_t i = 0; i < threads; ++i)
                {
                    const uint32_t start = (dataset_count * i) / threads;
                    const uint32_t end = (dataset_count * (i + 1)) / threads;

                    m_threads.emplace_back([this, start, size = end - start]()
                        {
                            if (size % 5)
                            {
                                randomx_init_dataset(dataset, cache, start, size - (size % 5));
                                randomx_init_dataset(dataset, cache, start + size - 5, 5);
                            }
                            else
                                randomx_init_dataset(dataset, cache, start, size);
                        });
                };

                for (auto& t : m_threads)
                {
                    if (t.joinable())
                        t.join();
                };
            }
            else
                randomx_init_dataset(dataset, cache, 0, dataset_count);
            randomx_release_cache(cache);
            cache = nullptr;
        };
    
        job = m_job;
        return true;
    };

    bool stop()
    {
        if (!vm)
            return false;

        vm->stop = true;
        for (size_t i = 0; i < vm->m_threads.size(); ++i)
        {
            if (vm->m_threads[i].joinable())
                vm->m_threads[i].join();
        };

        vm->job = nullptr;

        if (dataset)
        {    
            randomx_release_dataset(dataset);
            dataset = nullptr;
        };
    
        if (cache)
        {
            randomx_release_cache(cache);
            cache = nullptr;
        };
   
        vm = nullptr;
        return true;
    };

    int switchTo(RandomX::Job* m_job)
    {
        if (!job)
            return -1;
        
        if (m_job->seed_hash() != job->seed_hash())
            return -1;
        
        if (!cache && mode == "LIGHT")
            return -1;

        if (!dataset && mode == "FAST")
            return -1;

        if (!vm)
            vm = randomx_start_vm(mode, threads, nullptr, cache, dataset);
        
        vm->job = std::move(m_job);
        return vm->m_threads.size();
    };

    int hashes()
    {
        if (!vm)
            return 0;
        return vm->hashes;
    };
};