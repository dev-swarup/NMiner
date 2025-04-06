#include <thread>
#include <vector>
#include <fstream>

#include "job.h"
#include "main.h"
using namespace randomx;

Napi::Object InitFn(const Napi::CallbackInfo &info)
{
    job *m_job = new job();
    Napi::Env env = info.Env();
    Napi::Object exports = Napi::Object::New(env);
    if (!info[0].IsString() || !info[1].IsNumber() || !info[2].IsFunction())
    {
        ThrowError(env, "Expected arguments: mode, threads and submitFn");
        return exports;
    };

    m_job->jsSubmit = std::make_shared<Napi::FunctionReference>(std::move(Napi::Persistent(info[2].As<Napi::Function>())));
    std::string mode = info[0].As<Napi::String>();

    size_t threads = static_cast<size_t>(info[1].As<Napi::Number>().Uint32Value());

    exports.Set("lPages", Napi::Function::New(env, [](const Napi::CallbackInfo &info)
        {
            return ToNumber(info.Env(), -1);
        }));
    exports.Set("hugePages", Napi::Function::New(env, [](const Napi::CallbackInfo &info)
        {
            std::ofstream nr_hugepages("/proc/sys/vm/nr_hugepages");
            if (!nr_hugepages)
                return ToNumber(info.Env(), -1);
            
            nr_hugepages << 128;
            nr_hugepages.close();
            return ToNumber(info.Env(), 0);
        }));
    
    exports.Set("job", Napi::Function::New(env, [m_job](const Napi::CallbackInfo &info) mutable
        { 
            Napi::Env env = info.Env();
            Napi::Object exports = Napi::Object::New(env);
            if (info.Length() != 4 || !info[0].IsString() || !info[1].IsString() || !info[2].IsString() || !info[3].IsBoolean())
            {
                Napi::ThrowError(env, "Expected arguments: job_id, target, blob and reset nonce");
                return exports;
            };
            
            m_job->job_id = info[0].As<Napi::String>();
            exports.Set("diff", ToNumber(env, m_job->setTarget(info[1].As<Napi::String>())));
            exports.Set("txnCount", ToNumber(env, m_job->setBlob(info[2].As<Napi::String>())));

            if (info[3].As<Napi::Boolean>())
                m_job->resetNonce();

            return exports; 
        }));

    exports.Set("start", Napi::Function::New(env, [mode, threads, m_job](const Napi::CallbackInfo &info) 
        {
            if (info.Length() > 0)
                m_job->start(mode, threads);
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
            return Napi::Boolean::New(info.Env(), m_job->alloc(mode)); 
        }));

    exports.Set("threads", Napi::Function::New(env, [m_job](const Napi::CallbackInfo &info)
        {
            return ToNumber(info.Env(), m_job->threads());
        }));
    
    exports.Set("hashrate", Napi::Function::New(env, [m_job](const Napi::CallbackInfo &info)
        {
            return ToNumber(info.Env(), m_job->hashrate());
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