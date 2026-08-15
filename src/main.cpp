#include <napi.h>
#include <thread>
#include <vector>
#include <fstream>
#include <algorithm>

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

    uint32_t numPages = 1280; // 2560 MB: enough for one 2080 MB dataset plus scratchpads

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

    return Napi::Number::New(env, LargePagesSupported() ? 0 : -1);
#endif
};

#ifdef HAVE_HWLOC
#include <hwloc.h>
#endif

static int ScanNumaNodes()
{
#ifdef HAVE_HWLOC
    hwloc_topology_t topology;
    hwloc_topology_init(&topology);
    hwloc_topology_load(topology);

    const int numa_nodes = hwloc_get_nbobjs_by_type(topology, HWLOC_OBJ_NUMANODE);

    hwloc_topology_destroy(topology);
    return numa_nodes <= 0 ? 1 : numa_nodes;
#else
    return 1;
#endif
};

Napi::Value GetNumaNodes(const Napi::CallbackInfo &info)
{
    static const int numa_nodes = ScanNumaNodes();
    return Napi::Number::New(info.Env(), numa_nodes);
};

namespace
{
    struct NodeCache
    {
        uint32_t node;
        uint64_t l2;
        uint64_t l3;
        uint32_t cores;
        uint32_t pus;
    };

    std::vector<NodeCache> ScanCachesOnce()
    {
        std::vector<NodeCache> nodes;

#ifdef HAVE_HWLOC
        hwloc_topology_t topology;
        hwloc_topology_init(&topology);
        hwloc_topology_load(topology);

        auto sum_caches = [&](hwloc_const_cpuset_t set, hwloc_obj_type_t type)
        {
            uint64_t total = 0;
            const int count = set ? hwloc_get_nbobjs_inside_cpuset_by_type(topology, set, type) : hwloc_get_nbobjs_by_type(topology, type);

            for (int i = 0; i < count; ++i)
            {
                hwloc_obj_t obj = set ? hwloc_get_obj_inside_cpuset_by_type(topology, set, type, i) : hwloc_get_obj_by_type(topology, type, i);
                if (obj) total += obj->attr->cache.size;
            };

            return total;
        };

        int count = hwloc_get_nbobjs_by_type(topology, HWLOC_OBJ_NUMANODE);
        if (count <= 0) count = 1;

        for (int n = 0; n < count; ++n)
        {
            hwloc_obj_t node = hwloc_get_obj_by_type(topology, HWLOC_OBJ_NUMANODE, n);
            hwloc_const_cpuset_t set = node ? node->cpuset : nullptr;

            auto count_by = [&](hwloc_obj_type_t type)
            {
                const int n = set ? hwloc_get_nbobjs_inside_cpuset_by_type(topology, set, type) : hwloc_get_nbobjs_by_type(topology, type);
                return static_cast<uint32_t>(n > 0 ? n : 1);
            };

            nodes.push_back({ node ? node->os_index : 0u, sum_caches(set, HWLOC_OBJ_L2CACHE), sum_caches(set, HWLOC_OBJ_L3CACHE), count_by(HWLOC_OBJ_CORE), count_by(HWLOC_OBJ_PU) });
        };

        hwloc_topology_destroy(topology);
#else
        const uint32_t hw = std::thread::hardware_concurrency();
        nodes.push_back({ 0u, 0u, 0u, hw > 0 ? hw : 1u, hw > 0 ? hw : 1u });
#endif

        return nodes;
    };

    const std::vector<NodeCache> &ScanCaches()
    {
        static const std::vector<NodeCache> nodes = ScanCachesOnce();
        return nodes;
    };

    uint32_t ThreadsForNode(const NodeCache &node)
    {
        uint32_t limit = node.pus > 0 ? node.pus : node.cores;

        if (node.l3)
            limit = std::min<uint32_t>(limit, static_cast<uint32_t>(node.l3 / RANDOMX_SCRATCHPAD_L3));
        if (node.l2)
            limit = std::min<uint32_t>(limit, static_cast<uint32_t>(node.l2 / RANDOMX_SCRATCHPAD_L2));

        return limit > 0 ? limit : 1u;
    };
};

Napi::Value GetCacheInfo(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    const std::vector<NodeCache> &nodes = ScanCaches();

    Napi::Array list = Napi::Array::New(env, nodes.size());

    for (size_t i = 0; i < nodes.size(); ++i)
    {
        Napi::Object entry = Napi::Object::New(env);

        entry.Set("node", Napi::Number::New(env, nodes[i].node));
        entry.Set("l2", Napi::Number::New(env, static_cast<double>(nodes[i].l2)));
        entry.Set("l3", Napi::Number::New(env, static_cast<double>(nodes[i].l3)));
        entry.Set("cores", Napi::Number::New(env, nodes[i].cores));
        entry.Set("pus", Napi::Number::New(env, nodes[i].pus));
        entry.Set("threads", Napi::Number::New(env, ThreadsForNode(nodes[i])));

        list.Set(i, entry);
    };

    Napi::Object out = Napi::Object::New(env);

    out.Set("l2PerThread", Napi::Number::New(env, RANDOMX_SCRATCHPAD_L2));
    out.Set("l3PerThread", Napi::Number::New(env, RANDOMX_SCRATCHPAD_L3));

    out.Set("aes", Napi::String::New(env, AesImplName()));
    out.Set("blake2", Napi::String::New(env, Blake2ImplName()));

    out.Set("nodes", list);

    return out;
};

Napi::Value GetRecommendedThreads(const Napi::CallbackInfo &info)
{
    Napi::Env env = info.Env();
    const std::vector<NodeCache> &nodes = ScanCaches();

    Napi::Array out = Napi::Array::New(env, nodes.size());

    for (size_t i = 0; i < nodes.size(); ++i)
        out.Set(i, Napi::Number::New(env, ThreadsForNode(nodes[i])));

    return out;
};

Napi::Object Init(Napi::Env env, Napi::Object exports)
{
    Rx::Init(env, exports);
    RxJob::Init(env, exports);

    exports.Set("hugePages", Napi::Function::New(env, HugePages));
    exports.Set("numaNodes", Napi::Function::New(env, GetNumaNodes));
    exports.Set("cacheInfo", Napi::Function::New(env, GetCacheInfo));
    exports.Set("recommendedThreads", Napi::Function::New(env, GetRecommendedThreads));
    return exports;
};

NODE_API_MODULE(NMiner, Init);