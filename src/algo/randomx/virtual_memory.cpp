/*
Copyright (c) 2018-2019, tevador <tevador@gmail.com>

All rights reserved.

Redistribution and use in source and binary forms, with or without
modification, are permitted provided that the following conditions are met:
	* Redistributions of source code must retain the above copyright
	  notice, this list of conditions and the following disclaimer.
	* Redistributions in binary form must reproduce the above copyright
	  notice, this list of conditions and the following disclaimer in the
	  documentation and/or other materials provided with the distribution.
	* Neither the name of the copyright holder nor the
	  names of its contributors may be used to endorse or promote products
	  derived from this software without specific prior written permission.

THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS "AS IS" AND
ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT LIMITED TO, THE IMPLIED
WARRANTIES OF MERCHANTABILITY AND FITNESS FOR A PARTICULAR PURPOSE ARE
DISCLAIMED. IN NO EVENT SHALL THE COPYRIGHT HOLDER OR CONTRIBUTORS BE LIABLE
FOR ANY DIRECT, INDIRECT, INCIDENTAL, SPECIAL, EXEMPLARY, OR CONSEQUENTIAL
DAMAGES (INCLUDING, BUT NOT LIMITED TO, PROCUREMENT OF SUBSTITUTE GOODS OR
SERVICES; LOSS OF USE, DATA, OR PROFITS; OR BUSINESS INTERRUPTION) HOWEVER
CAUSED AND ON ANY THEORY OF LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY,
OR TORT (INCLUDING NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE
OF THIS SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
*/

#include <stdexcept>
#include "virtual_memory.hpp"

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <memoryapi.h>
#else
#include <sys/mman.h>
#endif


void* allocExecutableMemory(std::size_t bytes, bool hugePages) {
    void *mem = nullptr;
#ifdef _WIN32
    DWORD flags = MEM_COMMIT | MEM_RESERVE;
    if (hugePages) flags |= MEM_LARGE_PAGES;
    mem = VirtualAlloc(nullptr, bytes, flags, PAGE_EXECUTE_READWRITE);
#else
    int flags = MAP_PRIVATE | MAP_ANONYMOUS;
    if (hugePages) flags |= MAP_HUGETLB;
    mem = mmap(nullptr, bytes, PROT_READ | PROT_WRITE | PROT_EXEC, flags, -1, 0);
    if (mem == MAP_FAILED) mem = nullptr;
#endif

    if (mem == nullptr) {
        throw std::runtime_error("Failed to allocate executable memory");
    }

    return mem;
}


void* allocLargePagesMemory(std::size_t bytes) {
    void *mem = nullptr;
#ifdef _WIN32
    mem = VirtualAlloc(nullptr, bytes, MEM_COMMIT | MEM_RESERVE | MEM_LARGE_PAGES, PAGE_READWRITE);
#else
    mem = mmap(nullptr, bytes, PROT_READ | PROT_WRITE, MAP_PRIVATE | MAP_ANONYMOUS | MAP_HUGETLB, -1, 0);
    if (mem == MAP_FAILED) mem = nullptr;
#endif

    if (mem == nullptr) {
        throw std::runtime_error("Failed to allocate large pages memory");
    }

    return mem;
}


void freePagedMemory(void* ptr, std::size_t bytes) {
#ifdef _WIN32
    VirtualFree(ptr, 0, MEM_RELEASE);
#else
    munmap(ptr, bytes);
#endif
}
