#include <sched.h>
#include <cpuid.h>
#include <pthread.h>

#include "job.h"

bool AESSupport()
{
    unsigned int eax, ebx, ecx, edx;
    if (__get_cpuid(1, &eax, &ebx, &ecx, &edx))
        return (ecx & bit_AES) != 0;
    return false;
};

randomx::job::job() 
{
    m_vm = std::make_shared<randomx_machine>();
};

randomx::job::~job() {

};

uint32_t randomx::job::setBlob(const std::string &blob)
{
    if (sodium_hex2bin(m_blob, sizeof(m_blob), blob.c_str(), blob.size(), nullptr, nullptr, nullptr) != 0)
        return 0;

    m_size = blob.size() / 2;
    uint32_t num_transactions = 0;
    const size_t expected_tx_offset = 75;
    if ((m_size > expected_tx_offset) && (m_size <= expected_tx_offset + 4))
    {
        for (size_t i = expected_tx_offset, k = 0; i < m_size; ++i, k += 7)
        {
            const uint8_t b = m_blob[i];
            num_transactions |= static_cast<uint32_t>(b & 0x7F) << k;
            if ((b & 0x80) == 0)
                break;
        };
    };

    m_nicehash = readUnaligned(nonce()) != 0;
    for (size_t i = 0; i < m_vm->vms.size(); i++)
        std::memcpy(m_vm->vms[i]->blob, m_blob, kMaxBlobSize);

    return num_transactions;
};

uint64_t randomx::job::setTarget(const std::string &target)
{
    std::vector<uint8_t> raw(target.size() / 2);
    if (sodium_hex2bin(raw.data(), raw.size(), target.c_str(), target.size(), nullptr, nullptr, nullptr) != 0)
        return 0;

    m_target = 0xFFFFFFFFFFFFFFFFULL / (0xFFFFFFFFULL / uint64_t(*reinterpret_cast<const uint32_t *>(raw.data())));
    m_diff = static_cast<uint32_t>(0xFFFFFFFFFFFFFFFFULL / m_target);
    return m_diff;
};

bool randomx::job::alloc(const std::string &mode)
{
    if (m_dataset)
    {
        randomx_release_dataset(m_dataset);
        m_dataset = nullptr;
    };

    if (m_cache)
    {
        randomx_release_cache(m_cache);
        m_cache = nullptr;
    };

    m_cache = randomx_alloc_cache(RANDOMX_FLAG_JIT | RANDOMX_FLAG_HARD_AES | RANDOMX_FLAG_SECURE | RANDOMX_FLAG_ARGON2);
    if (!m_cache)
        return false;

    if (mode == "FAST")
    {
        m_dataset = randomx_alloc_dataset(RANDOMX_FLAG_FULL_MEM);
        if (!m_dataset)
            return false;
    };

    return true;
};

bool randomx::job::init(const std::string &mode, size_t threads, const std::string &seed_hash)
{
    if (!m_cache || (!m_dataset && mode == "FAST"))
        return false;

    randomx_init_cache(m_cache, seed_hash.c_str(), seed_hash.size());
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
                                                randomx_init_dataset(m_dataset, m_cache, start, size - (size % 5));
                                                randomx_init_dataset(m_dataset, m_cache, start + size - 5, 5);
                                            }
                                            else
                                                randomx_init_dataset(m_dataset, m_cache, start, size); 
                                        });
            };

            for (auto &t : m_threads)
            {
                if (t.joinable())
                    t.join();
            };
        }
        else
            randomx_init_dataset(m_dataset, m_cache, 0, dataset_count);
        randomx_release_cache(m_cache);
        m_cache = nullptr;
    };

    return true;
};

void randomx::job::pause()
{
    m_vm->paused = true;
};

void randomx::job::start()
{
    m_vm->paused = false;
};

size_t randomx::job::start(const std::string &mode, size_t threads, Napi::FunctionReference fn)
{
    if (m_vm->vms.size() >= 1)
        return m_vm->vms.size();
    
    for (size_t i = 0; i < threads; i++)
    {
        std::shared_ptr<t_machine> machine = std::make_shared<t_machine>();
        randomx_flags flags = RANDOMX_FLAG_JIT;
        if (AESSupport())
            flags |= RANDOMX_FLAG_HARD_AES;

        if (mode == "FAST")
            flags |= RANDOMX_FLAG_FULL_MEM;

        machine->vm = randomx_create_vm(flags, m_cache, m_dataset);
        if (!machine->vm)
            continue;

        std::memcpy(machine->blob, m_blob, kMaxBlobSize);
        machine->m_thread = std::thread([this, i, machine]() mutable
            {
                cpu_set_t cpuset;
                CPU_ZERO(&cpuset);
                CPU_SET(i % std::thread::hardware_concurrency(), &cpuset);
                pthread_setaffinity_np(pthread_self(), sizeof(cpu_set_t), &cpuset);

                while (!m_vm->closed)
                {
                    if (m_vm->paused)
                    {
                        std::this_thread::sleep_for(std::chrono::milliseconds(500));
                        continue;
                    };

                    calculate_hash(machine->vm, machine->blob, m_nonce);
                    {
                        std::lock_guard<std::mutex> lock(m_mutex);
                        m_nonce++;
                        m_hashes++;
                    };
                };
            });
        m_vm->vms.emplace_back(machine);
    };

    return m_vm->vms.size();
};

void randomx::job::calculate_hash(randomx_vm* vm, uint8_t blob[kMaxBlobSize], uint64_t nonce)
{

};