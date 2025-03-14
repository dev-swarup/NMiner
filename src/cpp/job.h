#include <mutex>
#include <chrono>
#include <cstring>
#include <cstdint>
#include <randomx.h>

#include "n-api.h"

template <typename T>
inline T readUnaligned(const T *ptr)
{
    static_assert(std::is_trivially_copyable<T>::value, "T must be trivially copyable");

    T result;
    std::memcpy(&result, ptr, sizeof(T));
    return result;
};


inline constexpr const size_t kNonceSize = 4;
inline constexpr const size_t kNonceOffset = 39;
inline constexpr const size_t kMaxSeedSize = 32;
inline constexpr const size_t kMaxBlobSize = 408;

struct t_machine
{
    randomx_vm* vm;
    std::thread m_thread;
    uint8_t blob[kMaxBlobSize];
};

struct randomx_machine
{
    bool paused = true;
    bool closed = false;
    std::vector<std::shared_ptr<t_machine>> vms;
};

namespace randomx
{
    class job
    {
    private:
        size_t m_size = 0;
        uint64_t m_diff = 0;
        uint64_t m_target = 0;
        randomx_cache *m_cache = nullptr;
        randomx_dataset *m_dataset = nullptr;
        std::shared_ptr<randomx_machine> m_vm;
        
        uint8_t m_seed[kMaxSeedSize];
        uint8_t m_blob[kMaxBlobSize];

        bool m_nicehash = false;
        inline uint32_t *nonce() { return reinterpret_cast<uint32_t *>(m_blob + kNonceOffset); };

        std::mutex m_mutex;
        int m_hashes = 0;
        uint64_t m_nonce = 0;

        void calculate_hash(randomx_vm* vm, uint8_t blob[kMaxBlobSize], uint64_t nonce);
    public:
        job();
        ~job();

        inline bool isValid() const { return m_size > 0 && m_diff > 0; };

        int threads()     { return m_vm->vms.size(); };
        int totalHashes() { return m_hashes; };
        uint32_t setBlob(const std::string &blob);
        uint64_t setTarget(const std::string &target);

        void resetNonce()
        {
            m_nonce = 0;
        };

        bool alloc(const std::string &mode);
        bool init(const std::string &mode, size_t threads, const std::string &seed_hash);

        void cleanup()
        {
            m_vm->closed = true;
            for (size_t i = 0; i < m_vm->vms.size(); i++)
            {
                if (m_vm->vms[i]->m_thread.joinable())
                {
                    m_vm->vms[i]->m_thread.join();
                    randomx_destroy_vm(m_vm->vms[i]->vm);
                };
            };

            m_vm->vms.clear();
            m_vm->closed = false;
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
        };

        void pause();
        void start();
        size_t start(const std::string &mode, size_t threads, Napi::FunctionReference fn);
    };
};