#include <napi.h>
#include <fstream>

#include "randomx/rx.h"
#include "randomx/rx_job.h"

#ifdef _WIN32
#include <windows.h>
#else
#include <sys/mman.h>
#endif

#ifdef _WIN32
#include <ntsecapi.h>
#endif

bool LargePagesSupported()
{
#ifdef _WIN32
    void *ptr = VirtualAlloc(nullptr, 2u * 1024u * 1024u, MEM_RESERVE | MEM_COMMIT | MEM_LARGE_PAGES, PAGE_READWRITE);
    if (ptr)
    {
        VirtualFree(ptr, 0, MEM_RELEASE);
        return true;
    };

    return false;
#else
    void *ptr = mmap(nullptr, 2u * 1024u * 1024u, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB, -1, 0);
    if (ptr == MAP_FAILED)
        return false;

    munmap(ptr, 2u * 1024u * 1024u);
    return true;
#endif
};

#ifdef _WIN32
bool AddSeLockMemoryPrivilege()
{
    HANDLE hToken;
    if (!OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &hToken))
        return false;

    DWORD len = 0;
    GetTokenInformation(hToken, TokenUser, NULL, 0, &len);
    if (GetLastError() != ERROR_INSUFFICIENT_BUFFER)
    {
        CloseHandle(hToken);
        return false;
    };

    PTOKEN_USER pUser = (PTOKEN_USER)malloc(len);
    if (!GetTokenInformation(hToken, TokenUser, pUser, len, &len))
    {
        free(pUser);
        CloseHandle(hToken);

        return false;
    };

    LSA_HANDLE hPolicy;
    LSA_OBJECT_ATTRIBUTES lsaAttr = {0};
    if (LsaOpenPolicy(NULL, &lsaAttr, POLICY_CREATE_ACCOUNT | POLICY_LOOKUP_NAMES, &hPolicy) != 0)
    {
        free(pUser);
        CloseHandle(hToken);

        return false;
    };

    LSA_UNICODE_STRING lsaPriv;
    WCHAR privName[] = L"SeLockMemoryPrivilege";

    lsaPriv.Buffer = privName;
    lsaPriv.Length = wcslen(privName) * sizeof(WCHAR);
    lsaPriv.MaximumLength = lsaPriv.Length + sizeof(WCHAR);

    NTSTATUS status = LsaAddAccountRights(hPolicy, pUser->User.Sid, &lsaPriv, 1);

    LsaClose(hPolicy);
    free(pUser);
    CloseHandle(hToken);

    return status == 0;
};
#endif

Napi::Value HugePages(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

    uint32_t numPages = 128;

    if (info.Length() > 0 && info[0].IsNumber())
        numPages = info[0].As<Napi::Number>().Uint32Value();

    if (LargePagesSupported())
        return Napi::Number::New(env, 0);

#ifdef _WIN32
    LUID luid;
    HANDLE hToken;
    TOKEN_PRIVILEGES tp;
    bool privilegeAdjusted = false;

    if (OpenProcessToken(GetCurrentProcess(), TOKEN_ADJUST_PRIVILEGES | TOKEN_QUERY, &hToken))
    {
        LookupPrivilegeValue(nullptr, SE_LOCK_MEMORY_NAME, &luid);

        tp.PrivilegeCount = 1;
        tp.Privileges[0].Luid = luid;
        tp.Privileges[0].Attributes = SE_PRIVILEGE_ENABLED;

        if (AdjustTokenPrivileges(hToken, FALSE, &tp, sizeof(TOKEN_PRIVILEGES), nullptr, nullptr))
        {
            if (GetLastError() == ERROR_SUCCESS)
            {
                privilegeAdjusted = true;
            };
        };

        CloseHandle(hToken);
    };

    if (privilegeAdjusted && LargePagesSupported())
        return Napi::Number::New(env, 0);

    if (AddSeLockMemoryPrivilege())
        return Napi::Number::New(env, 1);

    return Napi::Number::New(env, -1);
#else
    std::ofstream nr_hugepages("/proc/sys/vm/nr_hugepages");
    if (nr_hugepages) nr_hugepages << numPages;

    return Napi::Number::New(env, CheckLargePagesSupport() ? 0 : -1);
#endif
};

#ifdef HAVE_HWLOC
#include <hwloc.h>
#endif

Napi::Value GetNumaNodes(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();

#ifdef HAVE_HWLOC
    hwloc_topology_t topology;
    hwloc_topology_init(&topology);
    hwloc_topology_load(topology);

    int numa_nodes = hwloc_get_nbobjs_by_type(topology, HWLOC_OBJ_NUMANODE);

    hwloc_topology_destroy(topology);
    return Napi::Number::New(env, numa_nodes == 0 ? 1 : numa_nodes);
#else
    return Napi::Number::New(env, 1);
#endif
};

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    Rx::Init(env, exports);
    RxJob::Init(env, exports);

    exports.Set("hugePages", Napi::Function::New(env, HugePages));
    exports.Set("numaNodes", Napi::Function::New(env, GetNumaNodes));
    return exports;
};

NODE_API_MODULE(NMiner, Init);