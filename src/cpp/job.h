#include <mutex>
#include <chrono>
#include <thread>
#include <cstring>
#include <cstdint>

#include <main.h>
#include <randomx.h>

static int sodium_bin2hex(char *const hex, const size_t hex_maxlen, const unsigned char *const bin, const size_t bin_len)
{
    size_t i = 0U;
    unsigned int x = 0U;
    int b = 0;
    int c = 0;

    if (bin_len >= SIZE_MAX / 2 || hex_maxlen < bin_len * 2U)
        return -1;

    while (i < bin_len)
    {
        c = bin[i] & 0xf;
        b = bin[i] >> 4;
        x = (unsigned char)(87U + c + (((c - 10U) >> 8) & ~38U)) << 8 |
            (unsigned char)(87U + b + (((b - 10U) >> 8) & ~38U));
        hex[i * 2U] = (char)x;
        x >>= 8;
        hex[i * 2U + 1U] = (char)x;
        i++;
    };

    if (i * 2U < hex_maxlen)
        hex[i * 2U] = 0U;

    return 0;
};

static int sodium_hex2bin(unsigned char *const bin, const size_t bin_maxlen, const char *const hex, const size_t hex_len, const char *const ignore, size_t *const bin_len, const char **const hex_end)
{
    size_t bin_pos = 0U;
    size_t hex_pos = 0U;
    int ret = 0;
    unsigned char c = 0U;
    unsigned char c_acc = 0U;
    unsigned char c_alpha0 = 0U;
    unsigned char c_alpha = 0U;
    unsigned char c_num0 = 0U;
    unsigned char c_num = 0U;
    unsigned char c_val = 0U;
    unsigned char state = 0U;

    while (hex_pos < hex_len)
    {
        c = (unsigned char)hex[hex_pos];
        c_num = c ^ 48U;
        c_num0 = (c_num - 10U) >> 8;
        c_alpha = (c & ~32U) - 55U;
        c_alpha0 = ((c_alpha - 10U) ^ (c_alpha - 16U)) >> 8;

        if ((c_num0 | c_alpha0) == 0U)
        {
            if (ignore != nullptr && state == 0U && strchr(ignore, c) != nullptr)
            {
                hex_pos++;
                continue;
            };

            break;
        };

        c_val = (c_num0 & c_num) | (c_alpha0 & c_alpha);

        if (bin_pos >= bin_maxlen)
        {
            ret = -1;
            errno = ERANGE;
            break;
        };

        if (state == 0U)
            c_acc = c_val * 16U;
        else
            bin[bin_pos++] = c_acc | c_val;

        state = ~state;
        hex_pos++;
    };

    if (state != 0U)
    {
        hex_pos--;
        errno = EINVAL;
        ret = -1;
    };

    if (ret != 0)
        bin_pos = 0U;

    if (hex_end != nullptr)
        *hex_end = &hex[hex_pos];
    else if (hex_pos != hex_len)
    {
        errno = EINVAL;
        ret = -1;
    };

    if (bin_len != nullptr)
        *bin_len = bin_pos;

    return ret;
};

template <typename T>
inline T readUnaligned(const T *ptr)
{
    static_assert(std::is_trivially_copyable<T>::value, "T must be trivially copyable");

    T result;
    std::memcpy(&result, ptr, sizeof(T));
    return result;
};

template<typename T>
inline void writeUnaligned(T* ptr, T data)
{
    static_assert(std::is_trivially_copyable<T>::value, "T must be trivially copyable");

    std::memcpy(ptr, &data, sizeof(T));
};

inline constexpr const size_t kNonceSize = 4;
inline constexpr const size_t kNonceOffset = 39;
inline constexpr const size_t kMaxSeedSize = 32;
inline constexpr const size_t kMaxBlobSize = 408;

struct blob
{
    size_t size = 0;
    uint8_t blob[kMaxBlobSize];
};

struct t_machine
{
    uint32_t nonce;
    randomx_vm* vm;
    std::thread m_thread;
    uint8_t blob[kMaxBlobSize];
};

struct randomx_machine
{
    bool paused = true;
    bool closed = false;
    std::vector<std::shared_ptr<t_machine>> machine;
};

namespace randomx
{
    class job
    {
    private:
        std::mutex m_mutex;

        uint64_t m_diff = 0;
        uint64_t m_target = 0;
        randomx_cache *m_cache = nullptr;
        randomx_dataset *m_dataset = nullptr;
        std::shared_ptr<randomx_machine> m_machine;
        
        uint8_t m_seed[kMaxSeedSize];
        std::vector<blob> blobs = {};

        bool m_nicehash = false;
        bool m_extra_nonce = false;
        inline uint32_t *nonce() 
        { 
            return reinterpret_cast<uint32_t *>(blobs[0].blob + kNonceOffset); 
        };
        inline uint32_t *nonce(uint8_t blob[kMaxBlobSize]) 
        { 
            return reinterpret_cast<uint32_t *>(blob + kNonceOffset); 
        };

        int m_hashes = 0;
        int m_last_hashes = 0;
        std::chrono::system_clock::time_point m_last_time = std::chrono::system_clock::now();

        void calculate_hash(size_t thread_id, randomx_vm* vm, uint8_t blob[kMaxBlobSize], size_t size, uint32_t nonce, Napi::ThreadSafeFunction tsfn);
    public:
        job();
        ~job();
        std::string job_id;
        std::shared_ptr<Napi::FunctionReference> jsSubmit;
        std::shared_ptr<Napi::FunctionReference> jsRequestNonce;

        std::string hashrate();
        int threads() 
        {
            return m_machine->machine.size();
        };

        uint32_t setBlob(Napi::Array blob);
        uint32_t setBlob(const std::string &blob);
        uint64_t setTarget(const std::string &target);

        void resetNonce()
        {
            for (size_t i = 0; i < m_machine->machine.size(); i++)
                m_machine->machine[i]->nonce = m_extra_nonce ? 0 : i;
        };

        bool alloc(const std::string &mode);
        bool init(const std::string &mode, size_t threads, const std::string &seed_hash);

        void cleanup()
        {
            m_machine->closed = true;
            for (size_t i = 0; i < m_machine->machine.size(); i++)
            {
                if (m_machine->machine[i]->m_thread.joinable())
                {
                    m_machine->machine[i]->m_thread.join();
                    randomx_destroy_vm(m_machine->machine[i]->vm);
                };
            };

            m_machine->machine.clear();
            m_machine->closed = false;
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
            
            m_hashes = 0;
            m_last_hashes = 0;
        };

        void pause();
        void start();
        void start(const std::string &mode, size_t threads);
    };
};