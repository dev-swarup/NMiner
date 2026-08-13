#pragma once
#include <deque>
#include <mutex>
#include <atomic>
#include <memory>
#include <thread>
#include <vector>
#include <cstdint>
#include <condition_variable>

#include <napi.h>

#include "rx.h"
#include "rx_job.h"

static constexpr uint32_t kVerifyMatched = 1u;
static constexpr uint32_t kVerifySkipped = 8u;
static constexpr uint32_t kVerifyPoolTarget = 4u;
static constexpr uint32_t kVerifyMinerTarget = 2u;

static constexpr size_t kVerifyQueueLimit = 4096;

class RxVerify : public Napi::ObjectWrap<RxVerify>
{
public:
    static Napi::Object Init(Napi::Env env, Napi::Object exports);

    RxVerify(const Napi::CallbackInfo &info);
    ~RxVerify();

    Napi::Value Stop(const Napi::CallbackInfo &info);
    Napi::Value Verify(const Napi::CallbackInfo &info);
    Napi::Value Pending(const Napi::CallbackInfo &info);

private:
    struct State
    {
        Napi::ThreadSafeFunction tsfn;
        std::atomic<int> inflight{0};
    };

    struct Task
    {
        std::vector<uint8_t> blob;
        uint8_t nonce[4];
        uint8_t result[RANDOMX_HASH_SIZE];

        uint64_t miner_target;
        uint64_t pool_target;

        uint32_t flags;
        std::shared_ptr<State> state;
        Napi::Promise::Deferred deferred;
    };

    void Loop(uint32_t numa_node);
    void StopLoop();
    void ReleaseTsfn();
    static void CleanupTsfn(void *arg);

    void Settle(Task *task);

    Rx *rx = nullptr;
    napi_env m_env = nullptr;
    Napi::ObjectReference rx_ref;
    std::shared_ptr<State> m_state;
    std::atomic<bool> m_released{false};

    std::mutex m_mutex;
    std::condition_variable m_cv;
    std::deque<Task *> m_queue;

    std::atomic<bool> m_active{false};
    std::vector<std::thread> m_threads;
};