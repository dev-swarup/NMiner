#pragma once

#include <napi.h>
#include <string>
#include <vector>
#include <thread>
#include <functional>

static char *sodium_bin2hex(char *const hex, const size_t hex_maxlen, const unsigned char *const bin, const size_t bin_len)
{
    size_t i = 0U;
    unsigned int x = 0U;
    int b = 0;
    int c = 0;

    if (bin_len >= SIZE_MAX / 2 || hex_maxlen < bin_len * 2U)
        return nullptr;

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

    return hex;
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

inline Napi::String ToString(Napi::Env env, const std::string &str)
{
    return Napi::String::New(env, str);
};

inline Napi::Value FromBinToString(Napi::Env env, uint8_t *i, size_t size)
{
    char str[size];
    if (sodium_bin2hex(str, sizeof(str), i, sizeof(i)) != 0)
        return env.Null();
    return Napi::String::New(env, str);
};

namespace Napi
{
    inline void ThrowError(Napi::Env env, const char *message)
    {
        return Napi::TypeError::New(env, message).ThrowAsJavaScriptException();
    };
};