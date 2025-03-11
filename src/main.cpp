#include <napi.h>
#include <main.h>

Napi::Value InitFn(const Napi::CallbackInfo& info)
{
    Napi::Env env = info.Env();
    Napi::Object exports = Napi::Object::New(env);
    if (info.Length() != 2 || !info[0].IsNumber() || !info[1].IsString())
    {
        Napi::TypeError::New(env, "Invalid arguments").ThrowAsJavaScriptException();
        return exports;
    };

    std::shared_ptr<randomx_machine> machine = std::make_shared<randomx_machine>();

    machine->mode = info[1].As<Napi::String>();
    machine->threads = static_cast<size_t>(info[0].As<Napi::Number>().Uint32Value());
    exports.Set("GetJob", Napi::Function::New(env, [](const Napi::CallbackInfo& info)
        {
            Napi::Env env = info.Env();
            if (info.Length() != 4 || !info[0].IsString() || !info[1].IsString() || !info[2].IsString() || !info[3].IsFunction())
            {
                Napi::TypeError::New(env, "Expected string arguments: seed_hash, target and blob").ThrowAsJavaScriptException();
                return Napi::Object::New(env);
            };

            RandomX::Job* m_job = new RandomX::Job(info[0].As<Napi::String>(), info[1].As<Napi::String>(), info[2].As<Napi::String>(), Napi::Persistent(info[3].As<Napi::Function>()));
            if(!m_job->isValid())
            {
                Napi::TypeError::New(env, "Invalid job").ThrowAsJavaScriptException();
                return Napi::Object::New(env);
            };

            Napi::Object result = Napi::Object::New(env);
            result.Set("job", Napi::External<RandomX::Job>::New(env, m_job));
            result.Set("target", Napi::Number::New(env, m_job->diff()));
            result.Set("txnCount", Napi::Number::New(env, m_job->GetTxnCount()));

            return result;
        }));
    exports.Set("Init", Napi::Function::New(env, [machine](const Napi::CallbackInfo& info)
        {
            Napi::Env env = info.Env();
            Napi::Promise::Deferred result = Napi::Promise::Deferred::New(env);
            if (info.Length() != 2 || !info[0].IsExternal() || !info[1].IsNumber())
            {
                result.Reject(Napi::Error::New(env, "Expected job").Value());
                return result.Promise();
            };
            
            RandomX::Job* job = info[0].As<Napi::External<RandomX::Job>>().Data();
            size_t threads = static_cast<size_t>(info[1].As<Napi::Number>().Uint32Value());

            Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function::New(env, [](const Napi::CallbackInfo&) { }), "napi_randomx_init", 0, 1);
            std::thread([job, threads, machine, tsfn, result]()
                {
                    bool rt = machine->init(job, threads);
                    tsfn.BlockingCall([result, rt](Napi::Env env, Napi::Function) 
                        {
                            result.Resolve(Napi::Boolean::New(env, rt));
                        });
                    tsfn.Release();
                }).detach();

            return result.Promise();
        }));
    exports.Set("FreshUp", Napi::Function::New(env, [machine](const Napi::CallbackInfo& info)
        {
            Napi::Env env = info.Env();
            Napi::Promise::Deferred result = Napi::Promise::Deferred::New(env);

            Napi::ThreadSafeFunction tsfn = Napi::ThreadSafeFunction::New(env, Napi::Function::New(env, [](const Napi::CallbackInfo&) { }), "napi_randomx_alloc", 0, 1);
            std::thread([machine, tsfn, result]()
                {
                    bool rt = machine->alloc();
                    tsfn.BlockingCall([result, rt](Napi::Env env, Napi::Function) 
                        {
                            result.Resolve(Napi::Boolean::New(env, rt));
                        });
                    tsfn.Release();
                }).detach();
            
            return result.Promise();
        }));
    exports.Set("SwitchTo", Napi::Function::New(env, [machine](const Napi::CallbackInfo& info)
        {
            Napi::Env env = info.Env();
            if (info.Length() != 1 || !info[0].IsExternal())
            {
                Napi::TypeError::New(env, "Expected job").ThrowAsJavaScriptException();
                return Napi::Number::New(env, -1);
            };

            return Napi::Number::New(env, machine->switchTo(info[0].As<Napi::External<RandomX::Job>>().Data()));
        }));
    exports.Set("Stop", Napi::Function::New(env, [machine](const Napi::CallbackInfo& info)
        {
            Napi::Env env = info.Env();
            return Napi::Boolean::New(env, machine->stop());
        }));
    exports.Set("Hashes", Napi::Function::New(env, [machine](const Napi::CallbackInfo& info)
        {
            Napi::Env env = info.Env();
            return Napi::Number::New(env, machine->hashes());
        }));
    return exports;
};

Napi::Object Init(Napi::Env env, Napi::Object)
{
    return Napi::Function::New(env, InitFn);
};

NODE_API_MODULE(RandomX, Init);