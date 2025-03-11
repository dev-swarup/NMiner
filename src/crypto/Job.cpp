#include "Job.h"

#include <vector>
#include <cstring>
#include <cstdlib>
#include <algorithm>

static int sodium_hex2bin(unsigned char *const bin, const size_t bin_maxlen, const char *const hex, const size_t hex_len, const char *const ignore, size_t *const bin_len, const char **const hex_end)
{
    size_t        bin_pos   = 0U;
    size_t        hex_pos   = 0U;
    int           ret       = 0;
    unsigned char c         = 0U;
    unsigned char c_acc     = 0U;
    unsigned char c_alpha0  = 0U;
    unsigned char c_alpha   = 0U;
    unsigned char c_num0    = 0U;
    unsigned char c_num     = 0U;
    unsigned char c_val     = 0U;
    unsigned char state     = 0U;

    while (hex_pos < hex_len) 
    {
        c        = (unsigned char) hex[hex_pos];
        c_num    = c ^ 48U;
        c_num0   = (c_num - 10U) >> 8;
        c_alpha  = (c & ~32U) - 55U;
        c_alpha0 = ((c_alpha - 10U) ^ (c_alpha - 16U)) >> 8;

        if ((c_num0 | c_alpha0) == 0U) 
        {
            if (ignore != nullptr && state == 0U && strchr(ignore, c) != nullptr) 
            {
                hex_pos++;
                continue;
            }
            break;
        }

        c_val = (c_num0 & c_num) | (c_alpha0 & c_alpha);

        if (bin_pos >= bin_maxlen) 
        {
            ret   = -1;
            errno = ERANGE;
            break;
        }

        if (state == 0U) 
        {
            c_acc = c_val * 16U;
        } 
        else 
        {
            bin[bin_pos++] = c_acc | c_val;
        }

        state = ~state;
        hex_pos++;
    }

    if (state != 0U) 
    {
        hex_pos--;
        errno = EINVAL;
        ret = -1;
    }

    if (ret != 0) 
    {
        bin_pos = 0U;
    }

    if (hex_end != nullptr) 
    {
        *hex_end = &hex[hex_pos];
    } 
    else if (hex_pos != hex_len) 
    {
        errno = EINVAL;
        ret = -1;
    }

    if (bin_len != nullptr) 
    {
        *bin_len = bin_pos;
    }

    return ret;
}

RandomX::Job::Job(const std::string& seed_hash, const std::string& target, const std::string& blob, Napi::FunctionReference jsSubmit)
    :str_seed(seed_hash), m_jsSubmit(std::move(jsSubmit))
{
    if (seed_hash.size() != kMaxSeedSize * 2)
        return;

    m_seed.resize(kMaxSeedSize);
    if (sodium_hex2bin(m_seed.data(), m_seed.size(), seed_hash.c_str(), seed_hash.size(), nullptr, nullptr, nullptr) != 0)
        return;
    
    std::vector<uint8_t> raw(target.size() / 2);
    if (sodium_hex2bin(raw.data(), raw.size(), target.c_str(), target.size(), nullptr, nullptr, nullptr) != 0)
        return;

    switch (raw.size())
    {
        case 4:
            m_target = 0xFFFFFFFFFFFFFFFFULL / (0xFFFFFFFFULL / uint64_t(*reinterpret_cast<const uint32_t *>(raw.data())));
            break;
        case 8:
            m_target = *reinterpret_cast<const uint64_t *>(raw.data());
            break;
        default:
            m_target = 0;
            break;
    };

    if (m_target == 0)
        return;

    m_size = blob.size() / 2;
    m_diff = static_cast<uint32_t>(0xFFFFFFFFFFFFFFFFULL / m_target);

    if (m_size < kNonceOffset + kNonceSize || m_size >= sizeof(m_blob))
        return;

    if (sodium_hex2bin(m_blob, sizeof(m_blob), blob.c_str(), blob.size(), nullptr, nullptr, nullptr) != 0)
        return;

    if (readUnaligned(nonce()) != 0 && !m_nicehash)
        m_nicehash = true;
    return;
};