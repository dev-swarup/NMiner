#include <thread>
#include <vector>
#include <n-api.h>

#include "job.h"
using namespace randomx;

Napi::Object InitFn(const Napi::CallbackInfo &info)
{
    job *m_job = new job();
    Napi::Env env = info.Env();
    Napi::Object exports = Napi::Object::New(env);
    if (info.Length() != 2 || !info[0].IsString() || !info[1].IsNumber())
    {
        ThrowError(env, "Expected arguments: mode and threads");
        return exports;
    };

    std::string mode = info[0].As<Napi::String>();
    size_t threads = static_cast<size_t>(info[1].As<Napi::Number>().Uint32Value());
    
    exports.Set("job", Napi::Function::New(env, [m_job](const Napi::CallbackInfo &info)
        { 
            Napi::Env env = info.Env();
            Napi::Object exports = Napi::Object::New(env);
            if (info.Length() != 3 || !info[0].IsString() || !info[1].IsString() || !info[2].IsBoolean())
            {
                Napi::ThrowError(env, "Expected arguments: target, blob and reset nonce");
                return exports;
            };

            exports.Set("diff", Napi::Number::New(env, m_job->setTarget(info[0].As<Napi::String>())));
            exports.Set("txnCount", Napi::Number::New(env, m_job->setBlob(info[1].As<Napi::String>())));

            if (info[2].As<Napi::Boolean>())
                m_job->resetNonce();

            return exports; 
        }));

    exports.Set("start", Napi::Function::New(env, [mode, threads, m_job](const Napi::CallbackInfo &info) 
        {
            if (info.Length() == 1 && info[0].IsFunction())
                m_job->start(mode, threads, Napi::Persistent(info[0].As<Napi::Function>()));

            m_job->start();
        }));

    exports.Set("pause", Napi::Function::New(env, [m_job](const Napi::CallbackInfo &)
        {
            m_job->pause();
        }));

    exports.Set("init", Napi::Function::New(env, [mode, m_job](const Napi::CallbackInfo &info)
        {
            Napi::Env env = info.Env();
            if (info.Length() != 2 || !info[0].IsString() || !info[1].IsNumber())
            {
                Napi::ThrowError(env, "Expected arguments: seed_hash and threads");
                return Napi::Boolean::New(env, false);
            };

            const std::string &seed_hash = info[0].As<Napi::String>();
            size_t threads = static_cast<size_t>(info[1].As<Napi::Number>().Uint32Value());

            return Napi::Boolean::New(env, m_job->init(mode, threads, seed_hash));
        }));

    exports.Set("alloc", Napi::Function::New(env, [mode, m_job](const Napi::CallbackInfo &info)
        {
            Napi::Env env = info.Env();
            return Napi::Boolean::New(env, m_job->alloc(mode)); 
        }));

    exports.Set("totalHashes", Napi::Function::New(env, [m_job](const Napi::CallbackInfo &info)
        {
            Napi::Object exports = Napi::Object::New(info.Env());

            exports.Set("threads", Napi::Number::New(info.Env(), m_job->threads()));
            exports.Set("totalHashes", Napi::Number::New(info.Env(), m_job->totalHashes()));
            
            return exports;
        }));
    
    exports.Set("cleanup", Napi::Function::New(env, [m_job](const Napi::CallbackInfo&)
        {
            m_job->cleanup();
        }));                             
    return exports;
};

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    exports.Set("init", Napi::Function::New(env, InitFn));
    return exports;
};

NODE_API_MODULE(NMiner, Init);