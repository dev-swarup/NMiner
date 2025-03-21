cmake_minimum_required(VERSION 3.5)
project(NMiner)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

set(SOURCES
    src/main.cpp
    src/cpp/job.cpp
    src/aes_hash.cpp
    src/argon2_ref.c
    src/argon2_ssse3.c
    src/argon2_avx2.c
    src/bytecode_machine.cpp
    src/cpu.cpp
    src/dataset.cpp
    src/soft_aes.cpp
    src/virtual_memory.c
    src/vm_interpreted.cpp
    src/allocator.cpp
    src/assembly_generator_x86.cpp
    src/instruction.cpp
    src/randomx.cpp
    src/superscalar.cpp
    src/vm_compiled.cpp
    src/vm_interpreted_light.cpp
    src/argon2_core.c
    src/blake2_generator.cpp
    src/instructions_portable.cpp
    src/reciprocal.c
    src/virtual_machine.cpp
    src/vm_compiled_light.cpp
    src/blake2/blake2b.c
    src/jit_compiler_x86.cpp)

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include(CheckCCompilerFlag)
include(CheckCXXCompilerFlag)

if(MSVC)
    enable_language(ASM_MASM)
    list(APPEND SOURCES src/jit_compiler_x86_static.asm)

    set_property(SOURCE src/jit_compiler_x86_static.asm PROPERTY LANGUAGE ASM_MASM)
    set_source_files_properties(src/argon2_avx2.c COMPILE_FLAGS /arch:AVX2)

    set(CMAKE_C_FLAGS_RELWITHDEBINFO "${CMAKE_C_FLAGS_RELWITHDEBINFO} /DRELWITHDEBINFO")
    set(CMAKE_CXX_FLAGS_RELWITHDEBINFO "${CMAKE_CXX_FLAGS_RELWITHDEBINFO} /DRELWITHDEBINFO")
else()
    list(APPEND SOURCES src/jit_compiler_x86_static.S)

    set_property(SOURCE src/jit_compiler_x86_static.S PROPERTY LANGUAGE C)
    set_property(SOURCE src/jit_compiler_x86_static.S PROPERTY XCODE_EXPLICIT_FILE_TYPE sourcecode.asm)

    check_c_compiler_flag(-maes HAVE_AES)
    check_c_compiler_flag(-mavx2 HAVE_AVX2)
    check_c_compiler_flag(-mssse3 HAVE_SSSE3)
    
    if(HAVE_AES)
        set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} -maes")
        set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} -maes")
    endif()
    
    if(HAVE_AVX2)
        set_source_files_properties(src/argon2_avx2.c COMPILE_FLAGS -mavx2)
    endif()
    
    if(HAVE_SSSE3)
        set_source_files_properties(src/argon2_ssse3.c COMPILE_FLAGS -mssse3)
    endif()
endif()

set(RANDOMX_INCLUDE "${CMAKE_CURRENT_SOURCE_DIR}/src" CACHE STRING "RandomX Include Path")

include_directories(${CMAKE_JS_INC})
include_directories(${RANDOMX_INCLUDE})
include_directories("${RANDOMX_INCLUDE}/cpp")
include_directories("${CMAKE_CURRENT_SOURCE_DIR}/node_modules/node-addon-api")
include_directories("${CMAKE_CURRENT_SOURCE_DIR}/node_modules/node-api-headers/include")

add_library(${CMAKE_PROJECT_NAME} SHARED ${SOURCES} ${CMAKE_JS_SRC})
target_link_libraries(${CMAKE_PROJECT_NAME} ${CMAKE_JS_LIB})

set_target_properties(${CMAKE_PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")