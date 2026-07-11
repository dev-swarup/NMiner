cmake_minimum_required(VERSION 3.15)
project(NMiner)

include(CheckCXXCompilerFlag)

if(MSVC)
    check_cxx_compiler_flag("/std:c++20" COMPILER_SUPPORTS_CXX20)
else()
    check_cxx_compiler_flag("-std=c++20" COMPILER_SUPPORTS_CXX20)
endif()

if(COMPILER_SUPPORTS_CXX20)
    set(CMAKE_CXX_STANDARD 20)
else()
    set(CMAKE_CXX_STANDARD 17)
endif()

set(CMAKE_CXX_EXTENSIONS OFF)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_POSITION_INDEPENDENT_CODE ON)

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

set(SOURCES
    src/main.cpp)

include(src/algo/randomx/randomx.cmake)

if(TARGET ${CMAKE_PROJECT_NAME}-asm)
    add_dependencies(${CMAKE_PROJECT_NAME} ${CMAKE_PROJECT_NAME}-asm)
endif()

include_directories(${CMAKE_JS_INC})
include_directories(${RANDOMX_INCLUDE})

include_directories("${CMAKE_CURRENT_SOURCE_DIR}/src/algo")
include_directories("${CMAKE_CURRENT_SOURCE_DIR}/src/algo/randomx")

include_directories("${CMAKE_CURRENT_SOURCE_DIR}/node_modules/node-addon-api")
include_directories("${CMAKE_CURRENT_SOURCE_DIR}/node_modules/node-api-headers/include")

if(MSVC)
    add_compile_options($<$<COMPILE_LANGUAGE:C,CXX>:/wd4005>)
    add_compile_definitions(_HAS_EXCEPTIONS=1)

    if(CMAKE_BUILD_TYPE STREQUAL "Release" OR NOT CMAKE_BUILD_TYPE)
        add_compile_options(
            $<$<COMPILE_LANGUAGE:C,CXX>:/O2>
            $<$<COMPILE_LANGUAGE:C,CXX>:/Oi>
            $<$<COMPILE_LANGUAGE:C,CXX>:/Ot>
            $<$<COMPILE_LANGUAGE:C,CXX>:/GL>)
        add_link_options(/LTCG)
    endif()
else()
    if(CMAKE_BUILD_TYPE STREQUAL "Release" OR NOT CMAKE_BUILD_TYPE)
        add_flag("-O3")
        add_flag("-flto")
        add_flag("-funroll-loops")
        add_flag("-fno-exceptions")
    endif()
endif()

add_library(${CMAKE_PROJECT_NAME} SHARED ${SOURCES} ${CMAKE_JS_SRC})
target_link_libraries(${CMAKE_PROJECT_NAME} ${CMAKE_JS_LIB})

set_target_properties(${CMAKE_PROJECT_NAME} PROPERTIES PREFIX "" SUFFIX ".node")
target_compile_definitions(${CMAKE_PROJECT_NAME} PRIVATE NAPI_DISABLE_CPP_EXCEPTIONS)