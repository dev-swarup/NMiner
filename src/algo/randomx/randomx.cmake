list(APPEND SOURCES
    ${CMAKE_CURRENT_LIST_DIR}/aes_hash.cpp
    ${CMAKE_CURRENT_LIST_DIR}/argon2_ref.c
    ${CMAKE_CURRENT_LIST_DIR}/argon2_ssse3.c
    ${CMAKE_CURRENT_LIST_DIR}/argon2_avx2.c
    ${CMAKE_CURRENT_LIST_DIR}/bytecode_machine.cpp
    ${CMAKE_CURRENT_LIST_DIR}/cpu.cpp
    ${CMAKE_CURRENT_LIST_DIR}/dataset.cpp
    ${CMAKE_CURRENT_LIST_DIR}/soft_aes.cpp
    ${CMAKE_CURRENT_LIST_DIR}/virtual_memory.c
    ${CMAKE_CURRENT_LIST_DIR}/vm_interpreted.cpp
    ${CMAKE_CURRENT_LIST_DIR}/allocator.cpp
    ${CMAKE_CURRENT_LIST_DIR}/assembly_generator_x86.cpp
    ${CMAKE_CURRENT_LIST_DIR}/instruction.cpp
    ${CMAKE_CURRENT_LIST_DIR}/randomx.cpp
    ${CMAKE_CURRENT_LIST_DIR}/superscalar.cpp
    ${CMAKE_CURRENT_LIST_DIR}/vm_compiled.cpp
    ${CMAKE_CURRENT_LIST_DIR}/vm_interpreted_light.cpp
    ${CMAKE_CURRENT_LIST_DIR}/argon2_core.c
    ${CMAKE_CURRENT_LIST_DIR}/blake2_generator.cpp
    ${CMAKE_CURRENT_LIST_DIR}/instructions_portable.cpp
    ${CMAKE_CURRENT_LIST_DIR}/reciprocal.c
    ${CMAKE_CURRENT_LIST_DIR}/virtual_machine.cpp
    ${CMAKE_CURRENT_LIST_DIR}/vm_compiled_light.cpp
    ${CMAKE_CURRENT_LIST_DIR}/blake2/blake2b.c)

if((CMAKE_SIZEOF_VOID_P EQUAL 8) AND
   (ARCH_ID STREQUAL "x86_64" OR ARCH_ID STREQUAL "x86-64" OR ARCH_ID STREQUAL "amd64"))

    list(APPEND SOURCES ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_x86.cpp)

    if(MSVC)
        enable_language(ASM_MASM)
        list(APPEND SOURCES ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_x86_static.asm)

        set_property(SOURCE ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_x86_static.asm PROPERTY LANGUAGE ASM_MASM)
        set_source_files_properties(${CMAKE_CURRENT_LIST_DIR}/argon2_avx2.c COMPILE_FLAGS /arch:AVX2)

        set(CMAKE_C_FLAGS_RELWITHDEBINFO "${CMAKE_C_FLAGS_RELWITHDEBINFO} /DRELWITHDEBINFO" PARENT_SCOPE)
        set(CMAKE_CXX_FLAGS_RELWITHDEBINFO "${CMAKE_CXX_FLAGS_RELWITHDEBINFO} /DRELWITHDEBINFO" PARENT_SCOPE)

        add_custom_command(
            OUTPUT  ${CMAKE_SOURCE_DIR}/src/algo/randomx/asm/configuration.asm
            COMMAND powershell -ExecutionPolicy Bypass -File h2inc.ps1 ..\\src\\algo\\randomx\\configuration.h > ..\\src\\algo\\randomx\\asm\\configuration.asm SET ERRORLEVEL = 0
            COMMENT "Generating configuration.asm"
            WORKING_DIRECTORY ${CMAKE_SOURCE_DIR}/vcxproj)

        add_custom_target(generate-asm DEPENDS ${CMAKE_SOURCE_DIR}/src/algo/randomx/asm/configuration.asm)
    else()
        list(APPEND SOURCES ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_x86_static.S)

        set_property(SOURCE ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_x86_static.S PROPERTY LANGUAGE C)
        set_property(SOURCE ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_x86_static.S PROPERTY XCODE_EXPLICIT_FILE_TYPE sourcecode.asm)

        if(ARCH STREQUAL "native")
            add_flag("-march=native")
        else()
            add_flag("-maes")

            check_c_compiler_flag(-mssse3 HAVE_SSSE3)
            if(HAVE_SSSE3)
                set_source_files_properties(${CMAKE_CURRENT_LIST_DIR}/argon2_ssse3.c COMPILE_FLAGS -mssse3)
            endif()

            check_c_compiler_flag(-mavx2 HAVE_AVX2)
            if(HAVE_AVX2)
                set_source_files_properties(${CMAKE_CURRENT_LIST_DIR}/argon2_avx2.c COMPILE_FLAGS -mavx2)
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
        ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_a64_static.S
        ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_a64.cpp)

    set_property(SOURCE ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_a64_static.S PROPERTY LANGUAGE C)
    set_property(SOURCE ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_a64_static.S PROPERTY XCODE_EXPLICIT_FILE_TYPE sourcecode.asm)

    include(CheckIncludeFile)
    check_include_file(asm/hwcap.h HAVE_HWCAP)

    if(HAVE_HWCAP)
        add_definitions(-DHAVE_HWCAP)
    endif()

    if(ARCH STREQUAL "native")
        add_flag("-march=native")
    else()
        add_flag("-march=armv8-a+crypto")
    endif()
endif()

if(ARCH_ID STREQUAL "riscv64")
    list(APPEND SOURCES
        ${CMAKE_CURRENT_LIST_DIR}/aes_hash_rv64_vector.cpp
        ${CMAKE_CURRENT_LIST_DIR}/aes_hash_rv64_zvkned.cpp
        ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_rv64_static.S
        ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_rv64.cpp
        ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_rv64_vector.cpp
        ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_rv64_vector_static.S
        ${CMAKE_CURRENT_LIST_DIR}/cpu_rv64.S)

    set_property(SOURCE ${CMAKE_CURRENT_LIST_DIR}/cpu_rv64.S PROPERTY LANGUAGE C)
    set_property(SOURCE ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_rv64_static.S PROPERTY LANGUAGE C)
    set_property(SOURCE ${CMAKE_CURRENT_LIST_DIR}/jit_compiler_rv64_vector_static.S PROPERTY LANGUAGE C)

    set(RVARCH "rv64gc")

    if(ARCH STREQUAL "native")
        enable_language(ASM)

        macro(rv64_probe VAR FAIL_VAR SRC FLAGS)
            try_run(${FAIL_VAR} ${VAR} ${CMAKE_CURRENT_BINARY_DIR}/ {CMAKE_CURRENT_SOURCE_DIR}/src/algo/randomx/tests/${SRC} COMPILE_DEFINITIONS "${FLAGS}")
        endmacro()

        rv64_probe(RANDOMX_VECTOR_COMPILE_OK  RANDOMX_VECTOR_RUN_FAIL
                   riscv64_vector.s           "-march=rv64gcv")
        rv64_probe(RANDOMX_ZICBOP_COMPILE_OK  RANDOMX_ZICBOP_RUN_FAIL
                   riscv64_zicbop.s           "-march=rv64gc_zicbop")
        rv64_probe(RANDOMX_ZBA_COMPILE_OK     RANDOMX_ZBA_RUN_FAIL
                   riscv64_zba.s              "-march=rv64gc_zba")
        rv64_probe(RANDOMX_ZBB_COMPILE_OK     RANDOMX_ZBB_RUN_FAIL
                   riscv64_zbb.s              "-march=rv64gc_zbb")
        rv64_probe(RANDOMX_ZVKB_COMPILE_OK    RANDOMX_ZVKB_RUN_FAIL
                   riscv64_zvkb.s             "-march=rv64gcv_zvkb")
        rv64_probe(RANDOMX_ZVKNED_COMPILE_OK  RANDOMX_ZVKNED_RUN_FAIL
                   riscv64_zvkned.s           "-march=rv64gcv_zvkned")

        if(RANDOMX_VECTOR_COMPILE_OK  AND NOT RANDOMX_VECTOR_RUN_FAIL)
            set(RVARCH_V ON)
            message(STATUS "RISC-V vector extension detected")
        endif()

        if(RANDOMX_ZICBOP_COMPILE_OK AND NOT RANDOMX_ZICBOP_RUN_FAIL)
            set(RVARCH_ZICBOP ON)
            message(STATUS "RISC-V zicbop extension detected")
        endif()

        if(RANDOMX_ZBA_COMPILE_OK    AND NOT RANDOMX_ZBA_RUN_FAIL)
            set(RVARCH_ZBA ON)
            message(STATUS "RISC-V zba extension detected")
        endif()

        if(RANDOMX_ZBB_COMPILE_OK    AND NOT RANDOMX_ZBB_RUN_FAIL)
            set(RVARCH_ZBB ON)
            message(STATUS "RISC-V zbb extension detected")
        endif()

        if(RANDOMX_ZVKB_COMPILE_OK   AND NOT RANDOMX_ZVKB_RUN_FAIL)
            set(RVARCH_ZVKB ON)
            message(STATUS "RISC-V zvkb extension detected")
        endif()

        if(RANDOMX_ZVKNED_COMPILE_OK AND NOT RANDOMX_ZVKNED_RUN_FAIL)
            set(RVARCH_ZVKNED ON)
            message(STATUS "RISC-V zvkned extension detected")
        endif()

        if(RVARCH_V)      set(RVARCH "${RVARCH}v")          endif()
        if(RVARCH_ZICBOP) set(RVARCH "${RVARCH}_zicbop")    endif()
        if(RVARCH_ZBA)    set(RVARCH "${RVARCH}_zba")        endif()
        if(RVARCH_ZBB)    set(RVARCH "${RVARCH}_zbb")        endif()
        if(RVARCH_ZVKB)   set(RVARCH "${RVARCH}_zvkb")       endif()
        if(RVARCH_ZVKNED) set(RVARCH "${RVARCH}_zvkned")     endif()
    endif()

    add_flag("-march=${RVARCH}")

    set(RV64_VECTOR_FILE_ARCH "rv64gcv")
    if(ARCH STREQUAL "native")
        if(RVARCH_ZICBOP) set(RV64_VECTOR_FILE_ARCH "${RV64_VECTOR_FILE_ARCH}_zicbop") endif()
        if(RVARCH_ZBA)    set(RV64_VECTOR_FILE_ARCH "${RV64_VECTOR_FILE_ARCH}_zba")    endif()
        if(RVARCH_ZBB)    set(RV64_VECTOR_FILE_ARCH "${RV64_VECTOR_FILE_ARCH}_zbb")    endif()
        if(RVARCH_ZVKB)   set(RV64_VECTOR_FILE_ARCH "${RV64_VECTOR_FILE_ARCH}_zvkb")   endif()
    endif()

    set_source_files_properties(${CMAKE_CURRENT_LIST_DIR}/aes_hash_rv64_vector.cpp
        PROPERTIES COMPILE_FLAGS "-O3 -march=${RV64_VECTOR_FILE_ARCH}")
    set_source_files_properties(${CMAKE_CURRENT_LIST_DIR}/aes_hash_rv64_zvkned.cpp
        PROPERTIES COMPILE_FLAGS "-O3 -march=${RV64_VECTOR_FILE_ARCH}_zvkned")
    set_source_files_properties(${CMAKE_CURRENT_LIST_DIR}/jit_compiler_rv64_vector_static.S
        PROPERTIES COMPILE_FLAGS "-march=${RV64_VECTOR_FILE_ARCH}_zvkned")
endif()

set(SOURCES ${SOURCES} PARENT_SCOPE)