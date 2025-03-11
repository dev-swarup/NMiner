#include <napi.h>
#include <string>
#include <cstring>
#include <cstdint>

template<typename T>
inline T readUnaligned(const T* ptr)
{
    static_assert(std::is_trivially_copyable<T>::value, "T must be trivially copyable");

    T result;
    std::memcpy(&result, ptr, sizeof(T));
    return result;
};

static constexpr const size_t kNonceSize = 4;
static constexpr const size_t kNonceOffset = 39;
static constexpr const size_t kMaxSeedSize = 32;
static constexpr const size_t kMaxBlobSize = 408;
namespace RandomX
{
    class Job
    {
    private:
        size_t m_size = 0;
        uint64_t m_diff = 0;
        uint64_t m_target = 0;

        std::string str_seed;
        std::vector<uint8_t> m_seed;
        
        bool m_nicehash = false;
        uint8_t m_blob[kMaxBlobSize]{ 0 };
        Napi::FunctionReference m_jsSubmit;
    public:
        Job(const std::string& seed_hash, const std::string& target, const std::string& blob, Napi::FunctionReference jsSubmit);
        ~Job()
        {

        };

        inline bool isValid() const                 { return m_size > 0 && m_diff > 0 && m_seed.size() > 0; };
        inline bool isNicehash() const              { return m_nicehash; };
        inline uint64_t target() const              { return m_target; };
        inline const std::string& seed_hash() const { return str_seed; };
        inline std::vector<uint8_t> seed() const    { return m_seed; };

        inline uint8_t *blob()       { return m_blob; };
        inline uint64_t diff() const { return m_diff; };
        inline uint32_t *nonce()     { return reinterpret_cast<uint32_t*>(m_blob + kNonceOffset); };
        
        uint32_t GetTxnCount()
        {
            uint32_t num_transactions = 0;
            const size_t expected_tx_offset = 75;

            if ((m_size > expected_tx_offset) && (m_size <= expected_tx_offset + 4))
            {
                for (size_t i = expected_tx_offset, k = 0; i < m_size; ++i, k += 7)
                {
                    const uint8_t b = m_blob[i];
                    num_transactions |= static_cast<uint32_t>(b & 0x7F) << k;
                    if ((b & 0x80) == 0)
                    {
                        break;
                    }
                }
            }

            return num_transactions;
        };
    };
};