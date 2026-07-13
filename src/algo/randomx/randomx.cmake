set(RANDOMX_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/src/algo/randomx" CACHE STRING "RandomX Include")

list(APPEND SOURCES
    ${RANDOMX_INCLUDE}/rx.cpp
    ${RANDOMX_INCLUDE}/rx_job.cpp
    ${RANDOMX_INCLUDE}/rx_worker.cpp
    ${RANDOMX_INCLUDE}/aes_hash.cpp
    ${RANDOMX_INCLUDE}/argon2_ref.c
    ${RANDOMX_INCLUDE}/argon2_ssse3.c
    ${RANDOMX_INCLUDE}/argon2_avx2.c
    ${RANDOMX_INCLUDE}/argon2_core.c
    ${RANDOMX_INCLUDE}/bytecode_machine.cpp
    ${RANDOMX_INCLUDE}/dataset.cpp
    ${RANDOMX_INCLUDE}/soft_aes.cpp
    ${RANDOMX_INCLUDE}/vm_interpreted.cpp
    ${RANDOMX_INCLUDE}/allocator.cpp
    ${RANDOMX_INCLUDE}/randomx.cpp
    ${RANDOMX_INCLUDE}/superscalar.cpp
    ${RANDOMX_INCLUDE}/vm_compiled.cpp
    ${RANDOMX_INCLUDE}/vm_interpreted_light.cpp
    ${RANDOMX_INCLUDE}/blake2_generator.cpp
    ${RANDOMX_INCLUDE}/instructions_portable.cpp
    ${RANDOMX_INCLUDE}/reciprocal.c
    ${RANDOMX_INCLUDE}/virtual_machine.cpp
    ${RANDOMX_INCLUDE}/virtual_memory.cpp
    ${RANDOMX_INCLUDE}/vm_compiled_light.cpp
    ${RANDOMX_INCLUDE}/blake2/blake2b.c)

if ((CMAKE_SIZEOF_VOID_P EQUAL 8) AND (ARCH_ID STREQUAL "x86_64" OR ARCH_ID STREQUAL "x86-64" OR ARCH_ID STREQUAL "amd64"))
    list(APPEND SOURCES
        ${RANDOMX_INCLUDE}/jit_compiler_x86.cpp)

    if(MSVC)
        enable_language(ASM_MASM)
        list(APPEND SOURCES
            ${RANDOMX_INCLUDE}/jit_compiler_x86_static.asm)

        set_property(SOURCE ${RANDOMX_INCLUDE}/jit_compiler_x86_static.asm PROPERTY LANGUAGE ASM_MASM)
        set_source_files_properties(${RANDOMX_INCLUDE}/argon2_avx2.c COMPILE_FLAGS /arch:AVX2)

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
                set_source_files_properties(${RANDOMX_INCLUDE}/argon2_avx2.c COMPILE_FLAGS -mavx2)
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
        ${RANDOMX_INCLUDE}/aes_hash_rv64_vector.cpp
        ${RANDOMX_INCLUDE}/aes_hash_rv64_zvkned.cpp
        ${RANDOMX_INCLUDE}/jit_compiler_rv64_static.S
        ${RANDOMX_INCLUDE}/jit_compiler_rv64.cpp
        ${RANDOMX_INCLUDE}/jit_compiler_rv64_vector.cpp
        ${RANDOMX_INCLUDE}/jit_compiler_rv64_vector_static.S
        ${RANDOMX_INCLUDE}/cpu_rv64.S)

    set_property(SOURCE ${RANDOMX_INCLUDE}/cpu_rv64.S PROPERTY LANGUAGE C)
    set_property(SOURCE ${RANDOMX_INCLUDE}/jit_compiler_rv64_static.S PROPERTY LANGUAGE C)
    set_property(SOURCE ${RANDOMX_INCLUDE}/jit_compiler_rv64_vector_static.S PROPERTY LANGUAGE C)

    set(RVARCH "rv64gc")

    if(ARCH STREQUAL "native")
        enable_language(ASM)

        try_run(RANDOMX_VECTOR_RUN_FAIL
            RANDOMX_VECTOR_COMPILE_OK
            ${CMAKE_CURRENT_BINARY_DIR}/
            ${RANDOMX_INCLUDE}/tests/riscv64_vector.s
            COMPILE_DEFINITIONS "-march=rv64gcv")

        if (RANDOMX_VECTOR_COMPILE_OK AND NOT RANDOMX_VECTOR_RUN_FAIL)
            set(RVARCH_V ON)
            message(STATUS "RISC-V vector extension detected")
        else()
            set(RVARCH_V OFF)
        endif()

        try_run(RANDOMX_ZICBOP_RUN_FAIL
            RANDOMX_ZICBOP_COMPILE_OK
            ${CMAKE_CURRENT_BINARY_DIR}/
            ${RANDOMX_INCLUDE}/tests/riscv64_zicbop.s
            COMPILE_DEFINITIONS "-march=rv64gc_zicbop")

        if (RANDOMX_ZICBOP_COMPILE_OK AND NOT RANDOMX_ZICBOP_RUN_FAIL)
            set(RVARCH_ZICBOP ON)
            message(STATUS "RISC-V zicbop extension detected")
        else()
            set(RVARCH_ZICBOP OFF)
        endif()

        try_run(RANDOMX_ZBA_RUN_FAIL
            RANDOMX_ZBA_COMPILE_OK
            ${CMAKE_CURRENT_BINARY_DIR}/
            ${RANDOMX_INCLUDE}/tests/riscv64_zba.s
            COMPILE_DEFINITIONS "-march=rv64gc_zba")

        if (RANDOMX_ZBA_COMPILE_OK AND NOT RANDOMX_ZBA_RUN_FAIL)
            set(RVARCH_ZBA ON)
            message(STATUS "RISC-V zba extension detected")
        else()
            set(RVARCH_ZBA OFF)
        endif()

        try_run(RANDOMX_ZBB_RUN_FAIL
            RANDOMX_ZBB_COMPILE_OK
            ${CMAKE_CURRENT_BINARY_DIR}/
            ${RANDOMX_INCLUDE}/tests/riscv64_zbb.s
            COMPILE_DEFINITIONS "-march=rv64gc_zbb")

        if (RANDOMX_ZBB_COMPILE_OK AND NOT RANDOMX_ZBB_RUN_FAIL)
            set(RVARCH_ZBB ON)
            message(STATUS "RISC-V zbb extension detected")
        else()
            set(RVARCH_ZBB OFF)
        endif()

        try_run(RANDOMX_ZVKB_RUN_FAIL
            RANDOMX_ZVKB_COMPILE_OK
            ${CMAKE_CURRENT_BINARY_DIR}/
            ${RANDOMX_INCLUDE}/tests/riscv64_zvkb.s
            COMPILE_DEFINITIONS "-march=rv64gcv_zvkb")

        if (RANDOMX_ZVKB_COMPILE_OK AND NOT RANDOMX_ZVKB_RUN_FAIL)
            set(RVARCH_ZVKB ON)
            message(STATUS "RISC-V zvkb extension detected")
        else()
            set(RVARCH_ZVKB OFF)
        endif()

        try_run(RANDOMX_ZVKNED_RUN_FAIL
            RANDOMX_ZVKNED_COMPILE_OK
            ${CMAKE_CURRENT_BINARY_DIR}/
            ${RANDOMX_INCLUDE}/tests/riscv64_zvkned.s
            COMPILE_DEFINITIONS "-march=rv64gcv_zvkned")

        if (RANDOMX_ZVKNED_COMPILE_OK AND NOT RANDOMX_ZVKNED_RUN_FAIL)
            set(RVARCH_ZVKNED ON)
            message(STATUS "RISC-V zvkned extension detected")
        else()
            set(RVARCH_ZVKNED OFF)
        endif()

        if (ARCH STREQUAL "native")
            if (RVARCH_V)
                set(RVARCH "${RVARCH}v")
            endif()

            if (RVARCH_ZICBOP)
                set(RVARCH "${RVARCH}_zicbop")
            endif()

            if (RVARCH_ZBA)
                set(RVARCH "${RVARCH}_zba")
            endif()

            if (RVARCH_ZBB)
                set(RVARCH "${RVARCH}_zbb")
            endif()

            if (RVARCH_ZVKB)
                set(RVARCH "${RVARCH}_zvkb")
            endif()

            if (RVARCH_ZVKNED)
                set(RVARCH "${RVARCH}_zvkned")
            endif()
        endif()
    endif()

    add_flag("-march=${RVARCH}")
    set(RV64_VECTOR_FILE_ARCH "rv64gcv")

    if (ARCH STREQUAL "native")
        if (RVARCH_ZICBOP)
            set(RV64_VECTOR_FILE_ARCH "${RV64_VECTOR_FILE_ARCH}_zicbop")
        endif()

        if (RVARCH_ZBA)
            set(RV64_VECTOR_FILE_ARCH "${RV64_VECTOR_FILE_ARCH}_zba")
        endif()

        if (RVARCH_ZBB)
            set(RV64_VECTOR_FILE_ARCH "${RV64_VECTOR_FILE_ARCH}_zbb")
        endif()

        if (RVARCH_ZVKB)
            set(RV64_VECTOR_FILE_ARCH "${RV64_VECTOR_FILE_ARCH}_zvkb")
        endif()
    endif()

    set_source_files_properties(${RANDOMX_INCLUDE}/aes_hash_rv64_vector.cpp PROPERTIES COMPILE_FLAGS "-O3 -march=${RV64_VECTOR_FILE_ARCH}")
    set_source_files_properties(${RANDOMX_INCLUDE}/aes_hash_rv64_zvkned.cpp PROPERTIES COMPILE_FLAGS "-O3 -march=${RV64_VECTOR_FILE_ARCH}_zvkned")
    set_source_files_properties(${RANDOMX_INCLUDE}/jit_compiler_rv64_vector_static.S PROPERTIES COMPILE_FLAGS "-march=${RV64_VECTOR_FILE_ARCH}_zvkned")
endif()