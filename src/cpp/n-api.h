#pragma once

#include <napi.h>
#include <string>
#include <vector>
#include <thread>
#include <functional>

inline Napi::String ToString(Napi::Env env, const std::string &str)
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