set(RANDOMX_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/src/algo/randomx" CACHE STRING "RandomX Include")

include(CheckSymbolExists)
include(CheckCCompilerFlag)
include(CheckCXXCompilerFlag)

if (WIN32)
    check_symbol_exists(_aligned_malloc "stdlib.h" HAVE_ALIGNED_MALLOC)

    if (HAVE_ALIGNED_MALLOC)
        add_compile_definitions(HAVE_ALIGNED_MALLOC)
    endif()
else()
    check_symbol_exists(posix_memalign "stdlib.h" HAVE_POSIX_MEMALIGN)

    if (HAVE_POSIX_MEMALIGN)
        add_compile_definitions(HAVE_POSIX_MEMALIGN)
    endif()
endif()

if (NOT DEFINED WITH_SSE4_1)
    set(WITH_SSE4_1 ON)
endif()

if (NOT DEFINED WITH_AVX2)
    set(WITH_AVX2 ON)
endif()

if (NOT DEFINED WITH_VAES)
    set(WITH_VAES ON)
endif()

if (MSVC)
    set(VAES_COMPILER_OK ON)
else()
    CHECK_CXX_COMPILER_FLAG("-mavx512f -mvaes" VAES_COMPILER_OK)
endif()

if (NOT VAES_COMPILER_OK)
    set(WITH_VAES OFF)
endif()

if (NOT MSVC)
    CHECK_C_COMPILER_FLAG("-mavx2" AVX2_COMPILER_OK)

    if (NOT AVX2_COMPILER_OK)
        set(WITH_AVX2 OFF)
    endif()

    CHECK_C_COMPILER_FLAG("-msse4.1" SSE41_COMPILER_OK)

    if (NOT SSE41_COMPILER_OK)
        set(WITH_SSE4_1 OFF)
    endif()
endif()

if (WITH_SSE4_1)
    add_definitions(-DNMINER_FEATURE_SSE4_1)
endif()

if (WITH_AVX2)
    add_definitions(-DNMINER_FEATURE_AVX2)
endif()

if (WITH_VAES)
    add_definitions(-DNMINER_VAES)
endif()

list(APPEND SOURCES
    ${RANDOMX_INCLUDE}/rx.cpp
    ${RANDOMX_INCLUDE}/rx_job.cpp
    ${RANDOMX_INCLUDE}/rx_worker.cpp
    ${RANDOMX_INCLUDE}/aes_hash.cpp
    ${RANDOMX_INCLUDE}/argon2_ref.c
    ${RANDOMX_INCLUDE}/argon2_ssse3.c
    ${RANDOMX_INCLUDE}/argon2_avx2.c
    ${RANDOMX_INCLUDE}/bytecode_machine.cpp
    ${RANDOMX_INCLUDE}/cpu.cpp
    ${RANDOMX_INCLUDE}/dataset.cpp
    ${RANDOMX_INCLUDE}/soft_aes.cpp
    ${RANDOMX_INCLUDE}/virtual_memory.c
    ${RANDOMX_INCLUDE}/vm_interpreted.cpp
    ${RANDOMX_INCLUDE}/allocator.cpp
    ${RANDOMX_INCLUDE}/assembly_generator_x86.cpp
    ${RANDOMX_INCLUDE}/instruction.cpp
    ${RANDOMX_INCLUDE}/randomx.cpp
    ${RANDOMX_INCLUDE}/superscalar.cpp
    ${RANDOMX_INCLUDE}/vm_compiled.cpp
    ${RANDOMX_INCLUDE}/vm_interpreted_light.cpp
    ${RANDOMX_INCLUDE}/argon2_core.c
    ${RANDOMX_INCLUDE}/blake2_generator.cpp
    ${RANDOMX_INCLUDE}/instructions_portable.cpp
    ${RANDOMX_INCLUDE}/reciprocal.c
    ${RANDOMX_INCLUDE}/virtual_machine.cpp
    ${RANDOMX_INCLUDE}/vm_compiled_light.cpp
    ${RANDOMX_INCLUDE}/blake2/blake2b.c)

if (CMAKE_CXX_COMPILER_ID MATCHES GNU OR CMAKE_CXX_COMPILER_ID MATCHES Clang)
    set_source_files_properties(${RANDOMX_INCLUDE}/dataset.cpp               PROPERTIES COMPILE_FLAGS "-Ofast")
    set_source_files_properties(${RANDOMX_INCLUDE}/aes_hash.cpp              PROPERTIES COMPILE_FLAGS "-Ofast")
    set_source_files_properties(${RANDOMX_INCLUDE}/instructions_portable.cpp PROPERTIES COMPILE_FLAGS "-Ofast -fno-tree-vectorize")
endif()

if (WITH_SSE4_1)
    if (CMAKE_C_COMPILER_ID MATCHES GNU OR CMAKE_C_COMPILER_ID MATCHES Clang)
        set_source_files_properties(${RANDOMX_INCLUDE}/blake2/blake2b.c      PROPERTIES COMPILE_FLAGS "-Ofast -msse4.1")
    endif()
endif()

if (WITH_AVX2)
    if (CMAKE_C_COMPILER_ID MATCHES GNU OR CMAKE_C_COMPILER_ID MATCHES Clang)
        set_source_files_properties(${RANDOMX_INCLUDE}/argon2_avx2.c         PROPERTIES COMPILE_FLAGS "-Ofast -mavx2")
        set_source_files_properties(${RANDOMX_INCLUDE}/argon2_ssse3.c        PROPERTIES COMPILE_FLAGS "-Ofast -mssse3")
    endif()
endif()

if (WITH_VAES)
    if (EXISTS "${RANDOMX_INCLUDE}/aes_hash_vaes512.cpp")
        list(APPEND SOURCES ${RANDOMX_INCLUDE}/aes_hash_vaes512.cpp)

        if (MSVC)
            set_source_files_properties(${RANDOMX_INCLUDE}/aes_hash_vaes512.cpp    PROPERTIES COMPILE_FLAGS "/arch:AVX512")
        elseif (CMAKE_C_COMPILER_ID MATCHES GNU OR CMAKE_C_COMPILER_ID MATCHES Clang)
            set_source_files_properties(${RANDOMX_INCLUDE}/aes_hash_vaes512.cpp    PROPERTIES COMPILE_FLAGS "-mavx512f -mvaes -Ofast")
        endif()
    else()
        set(WITH_VAES OFF)
    endif()
endif()

if ((CMAKE_SIZEOF_VOID_P EQUAL 8) AND (ARCH_ID STREQUAL "x86_64" OR ARCH_ID STREQUAL "x86-64" OR ARCH_ID STREQUAL "amd64"))
    list(APPEND SOURCES
        ${RANDOMX_INCLUDE}/jit_compiler_x86.cpp)

    if(MSVC)
        enable_language(ASM_MASM)
        list(APPEND SOURCES
            ${RANDOMX_INCLUDE}/jit_compiler_x86_static.asm)

        set_property(SOURCE ${RANDOMX_INCLUDE}/jit_compiler_x86_static.asm PROPERTY LANGUAGE ASM_MASM)

        if (CMAKE_CXX_COMPILER_ID MATCHES Clang)
            set_source_files_properties(${RANDOMX_INCLUDE}/jit_compiler_x86.cpp    PROPERTIES COMPILE_FLAGS "-Wno-unused-const-variable")
        endif()

        set(CMAKE_C_FLAGS_RELWITHDEBINFO "${CMAKE_C_FLAGS_RELWITHDEBINFO} /DRELWITHDEBINFO")
        set(CMAKE_CXX_FLAGS_RELWITHDEBINFO "${CMAKE_CXX_FLAGS_RELWITHDEBINFO} /DRELWITHDEBINFO")

        add_custom_command(
            OUTPUT  ${RANDOMX_INCLUDE}/asm/configuration.asm
            COMMAND powershell -ExecutionPolicy Bypass -File h2inc.ps1 ..\\src\\algo\\randomx\\configuration.h > ..\\src\\algo\\randomx\\asm\\configuration.asm SET ERRORLEVEL = 0
            COMMENT "Generating configuration.asm"
            WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}/vcxproj)

        add_custom_target(generate-asm DEPENDS ${RANDOMX_INCLUDE}/asm/configuration.asm)
    else()
        list(APPEND SOURCES
            ${RANDOMX_INCLUDE}/jit_compiler_x86_static.S)

        set_property(SOURCE ${RANDOMX_INCLUDE}/jit_compiler_x86_static.S PROPERTY LANGUAGE C)
        set_property(SOURCE ${RANDOMX_INCLUDE}/jit_compiler_x86_static.S PROPERTY XCODE_EXPLICIT_FILE_TYPE sourcecode.asm)

        if (CMAKE_CXX_COMPILER_ID MATCHES Clang)
            set_source_files_properties(${RANDOMX_INCLUDE}/jit_compiler_x86.cpp    PROPERTIES COMPILE_FLAGS "-Wno-unused-const-variable")
        endif()

        if(ARCH STREQUAL "native")
            add_flag("-march=native")
        else()
            add_flag("-maes")
            check_c_compiler_flag(-mssse3 HAVE_SSSE3)

            if(HAVE_SSSE3)
                set_source_files_properties(${RANDOMX_INCLUDE}/argon2_ssse3.c COMPILE_FLAGS -mssse3)
            endif()

            check_c_compiler_flag(-mavx2 HAVE_AVX2)

            if(HAVE_AVX2)
                set_source_files_properties(${RANDOMX_INCLUDE}/argon2_avx2.c  COMPILE_FLAGS -mavx2)
            endif()
        endif()
    endif()
endif()

if(ARCH_ID STREQUAL "ppc64" OR ARCH_ID STREQUAL "ppc64le")
    if(ARCH STREQUAL "native")
        add_flag("-mcpu=native")
    endif()
endif()

if(ARM_ID STREQUAL "aarch64" OR ARM_ID STREQUAL "arm64" OR ARM_ID STREQUAL "armv8-a")
    list(APPEND SOURCES
        ${RANDOMX_INCLUDE}/jit_compiler_a64_static.S
        ${RANDOMX_INCLUDE}/jit_compiler_a64.cpp)

    set_property(SOURCE ${RANDOMX_INCLUDE}/jit_compiler_a64_static.S PROPERTY LANGUAGE C)
    set_property(SOURCE ${RANDOMX_INCLUDE}/jit_compiler_a64_static.S PROPERTY XCODE_EXPLICIT_FILE_TYPE sourcecode.asm)

    if(ARCH STREQUAL "native")
        add_flag("-march=native")
    else()
        add_flag("-march=armv8-a+crypto")
    endif()
endif()

if(ARCH_ID STREQUAL "riscv64")
    list(APPEND SOURCES
        ${RANDOMX_INCLUDE}/jit_compiler_rv64_static.S
        ${RANDOMX_INCLUDE}/jit_compiler_rv64.cpp)

    set_property(SOURCE ${RANDOMX_INCLUDE}/jit_compiler_rv64_static.S PROPERTY LANGUAGE C)
    set_property(SOURCE ${RANDOMX_INCLUDE}/jit_compiler_rv64_static.S PROPERTY XCODE_EXPLICIT_FILE_TYPE sourcecode.asm)

    set(RVARCH "rv64gc")

    if(ARCH STREQUAL "native")
        enable_language(ASM)

        try_run(RANDOMX_ZBA_RUN_FAIL RANDOMX_ZBA_COMPILE_OK
            ${CMAKE_CURRENT_BINARY_DIR}/
            ${RANDOMX_INCLUDE}/tests/riscv64_zba.s
            COMPILE_DEFINITIONS "-march=rv64gc_zba")

        if (RANDOMX_ZBA_COMPILE_OK AND NOT RANDOMX_ZBA_RUN_FAIL)
            set(RVARCH_ZBA ON)
            message(STATUS "RISC-V zba extension detected")
        else()
            set(RVARCH_ZBA OFF)
        endif()

        try_run(RANDOMX_ZBB_RUN_FAIL RANDOMX_ZBB_COMPILE_OK
            ${CMAKE_CURRENT_BINARY_DIR}/
            ${RANDOMX_INCLUDE}/tests/riscv64_zbb.s
            COMPILE_DEFINITIONS "-march=rv64gc_zbb")

        if (RANDOMX_ZBB_COMPILE_OK AND NOT RANDOMX_ZBB_RUN_FAIL)
            set(RVARCH_ZBB ON)
            message(STATUS "RISC-V zbb extension detected")
        else()
            set(RVARCH_ZBB OFF)
        endif()

        if (RVARCH_ZBA)
            set(RVARCH "${RVARCH}_zba")
        endif()

        if (RVARCH_ZBB)
            set(RVARCH "${RVARCH}_zbb")
        endif()
    endif()

    add_flag("-march=${RVARCH}")
endif()