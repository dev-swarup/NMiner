#include <napi.h>
#include <fstream>

#include "randomx/rx.h"
#include "randomx/rx_job.h"

#ifdef _WIN32
    #include <windows.h>
#endif

Napi::Value HugePages(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
#ifdef _WIN32
    LUID luid;
    HANDLE hToken;
    TOKEN_PRIVILEGES tp;

    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &hToken))
        return Napi::Number::New(env, -1);

    LookupPrivilegeValue(nullptr, SE_LOCK_MEMORY_NAME, &luid);

    tp.PrivilegeCount           = 1;
    tp.Privileges[0].Luid       = luid;
    tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;

    const BOOL res = AdjustTokenPrivileges(hToken, FALSE, &tp, sizeof(TOKEN_PRIVILEGES), nullptr, nullptr);

    CloseHandle(hToken);
    return Napi::Number::New(env, (res && GetLastError() == ERROR_SUCCESS) ? 0 : -1);
#else
    std::ofstream nr_hugepages("/proc/sys/vm/nr_hugepages");
    if (!nr_hugepages)
        return Napi::Number::New(env, -1);

    nr_hugepages << 128;
    return Napi::Number::New(env, 0);
#endif
};

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    Rx::Init(env, exports);
    RxJob::Init(env, exports);

    exports.Set("hugePages", Napi::Function::New(env, HugePages));
    return exports;
};

NODE_API_MODULE(NMiner, Init);