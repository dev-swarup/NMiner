#pragma once
#include <napi.h>

template <typename T>
inline Napi::Number ToNumber(Napi::Env env, T n)
{
    return Napi::Number::New(env, n);
};

template <typename T>
inline Napi::String ToString(Napi::Env env, T str)
{
    return Napi::String::New(env, str);
};

namespace Napi
{
    inline void ThrowError(Napi::Env env, const char *message)
    {
        return Napi::TypeError::New(env, message).ThrowAsJavaScriptException();
    };
};