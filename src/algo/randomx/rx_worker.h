#pragma once
#include "rx.h"
#include "rx_job.h"

class AllocateWorker : public Napi::AsyncWorker {
public:
    AllocateWorker(Napi::Env env, Rx* rx, std::vector<uint8_t> seed_hash, std::string variant);
    ~AllocateWorker();

    void Execute() override;

    void OnOK() override;
    void OnError(const Napi::Error& e) override;

    Napi::Promise GetPromise();

private:
    Rx* rx;
    bool result;
    std::string variant;
    std::vector<uint8_t> seed_hash;
    Napi::Promise::Deferred deferred;
};