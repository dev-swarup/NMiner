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

if(NOT ARCH_ID)
    if(CMAKE_SYSTEM_PROCESSOR STREQUAL "")
        set(CMAKE_SYSTEM_PROCESSOR ${CMAKE_HOST_SYSTEM_PROCESSOR})
    endif()

    string(TOLOWER "${CMAKE_SYSTEM_PROCESSOR}" ARCH_ID)
endif()
  
if(NOT ARM_ID)
    set(ARM_ID "${ARCH_ID}")
endif()
  
if(NOT ARCH)
    set(ARCH "default")
endif()

if(NOT CMAKE_BUILD_TYPE)
    set(CMAKE_BUILD_TYPE Release)
endif()

include(CheckCCompilerFlag)
include(CheckCXXCompilerFlag)

function(add_flag flag)
    string(REPLACE "-" "_" supported_cxx ${flag}_cxx)
    check_cxx_compiler_flag(${flag} ${supported_cxx})
    
    if(${${supported_cxx}})
        message(STATUS "Setting CXX flag ${flag}")
        set(CMAKE_CXX_FLAGS "${CMAKE_CXX_FLAGS} ${flag}" PARENT_SCOPE)
    endif()
    
    string(REPLACE "-" "_" supported_c ${flag}_c)
    check_c_compiler_flag(${flag} ${supported_c})
    
    if(${${supported_c}})
        message(STATUS "Setting C flag ${flag}")
        set(CMAKE_C_FLAGS "${CMAKE_C_FLAGS} ${flag}" PARENT_SCOPE)
    endif()
endfunction()

if ((CMAKE_SIZEOF_VOID_P EQUAL 8) AND (ARCH_ID STREQUAL "x86_64" OR ARCH_ID STREQUAL "x86-64" OR ARCH_ID STREQUAL "amd64"))
    list(APPEND SOURCES
        src/jit_compiler_x86.cpp)
    
    if(MSVC)
        enable_language(ASM_MASM)
        list(APPEND SOURCES 
            src/jit_compiler_x86_static.asm)
    
        set_property(SOURCE src/jit_compiler_x86_static.asm PROPERTY LANGUAGE ASM_MASM)

        set_source_files_properties(src/argon2_avx2.c COMPILE_FLAGS /arch:AVX2)
    
        set(CMAKE_C_FLAGS_RELWITHDEBINFO "${CMAKE_C_FLAGS_RELWITHDEBINFO} /DRELWITHDEBINFO")
        set(CMAKE_CXX_FLAGS_RELWITHDEBINFO "${CMAKE_CXX_FLAGS_RELWITHDEBINFO} /DRELWITHDEBINFO")
    
        add_custom_command(OUTPUT src/asm/configuration.asm
            COMMAND powershell -ExecutionPolicy Bypass -File h2inc.ps1 ..\\src\\configuration.h > ..\\src\\asm\\configuration.asm SET ERRORLEVEL = 0
            COMMENT "Generating configuration.asm at ${CMAKE_CURRENT_SOURCE_DIR}"
            WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}/vcxproj)

        add_custom_target(${CMAKE_PROJECT_NAME}-asm DEPENDS src/asm/configuration.asm)
    else()
        list(APPEND SOURCES 
            src/jit_compiler_x86_static.S)
    
        set_property(SOURCE src/jit_compiler_x86_static.S PROPERTY LANGUAGE C)
        set_property(SOURCE src/jit_compiler_x86_static.S PROPERTY XCODE_EXPLICIT_FILE_TYPE sourcecode.asm)
    
        if(ARCH STREQUAL "native")
            add_flag("-march=native")
        else()
            add_flag("-maes")
            check_c_compiler_flag(-mavx2 HAVE_AVX2)
            check_c_compiler_flag(-mssse3 HAVE_SSSE3)

            if(HAVE_AVX2)
                set_source_files_properties(src/argon2_avx2.c COMPILE_FLAGS -mavx2)
            endif()

            if(HAVE_SSSE3)
                set_source_files_properties(src/argon2_ssse3.c COMPILE_FLAGS -mssse3)
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
        src/jit_compiler_a64_static.S
        src/jit_compiler_a64.cpp)

    set_property(SOURCE src/jit_compiler_a64_static.S PROPERTY LANGUAGE C)
    set_property(SOURCE src/jit_compiler_a64_static.S PROPERTY XCODE_EXPLICIT_FILE_TYPE sourcecode.asm)

    include(CheckIncludeFile)

    if(ARCH STREQUAL "native")
        add_flag("-march=native")
    endif()
    
    add_flag("-march=armv8-a+crypto")
endif()

if(TARGET ${CMAKE_PROJECT_NAME}-asm)
    add_dependencies(${CMAKE_PROJECT_NAME} ${CMAKE_PROJECT_NAME}-asm)
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