#pragma once
#include "rx.h"

class AllocateWorker : public Napi::AsyncWorker {
public:
    AllocateWorker(Napi::Env env, Rx* rx, std::string seed_hash, std::string variant);
    ~AllocateWorker();

    void Execute() override;

    void OnOK() override;
    void OnError(const Napi::Error& e) override;

    Napi::Promise GetPromise();

private:
    Rx* rx;
    bool result;
    std::string variant;
    std::string seed_hash;
    Napi::Promise::Deferred deferred;
};