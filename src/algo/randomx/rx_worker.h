#pragma once
#include "rx.h"

static constexpr uint32_t kDrainSpins = 1000;

class AllocateWorker : public Napi::AsyncWorker
{
public:
    AllocateWorker(Napi::Env env, Rx *rx, std::vector<uint8_t> seed_hash);

    void Execute()                       override;
    void OnOK()                          override;
    void OnError(const Napi::Error &err) override;

    Napi::Promise GetPromise();

private:
    void Clear();
    bool BuildDataset();
    randomx_dataset *Reserve(uint32_t numa_id, randomx_flags primary, randomx_flags fallback);

    Rx *rx;
    std::vector<uint8_t> seed_hash;
    Napi::Promise::Deferred deferred;

    bool result {false};
};