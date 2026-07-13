cmake_minimum_required(VERSION 3.15)

include(FetchContent)
include(ExternalProject)

set(HWLOC_VERSION "2.11.1")
set(HWLOC_INSTALL_DIR "${CMAKE_CURRENT_BINARY_DIR}/hwloc_install")

add_library(hwloc::hwloc UNKNOWN IMPORTED GLOBAL)

if(WIN32)
    set(HWLOC_URL "https://download.open-mpi.org/release/hwloc/v2.11/hwloc-win64-build-${HWLOC_VERSION}.zip")
    
    FetchContent_Declare(hwloc_external URL ${HWLOC_URL})
    FetchContent_MakeAvailable(hwloc_external)
    
    set(HWLOC_INC_DIR "${hwloc_external_SOURCE_DIR}/include")
    set(HWLOC_LIB_PATH "${hwloc_external_SOURCE_DIR}/lib/libhwloc.lib")
    
    set_target_properties(hwloc::hwloc PROPERTIES
        IMPORTED_LOCATION "${HWLOC_LIB_PATH}"
        INTERFACE_COMPILE_DEFINITIONS "HAVE_HWLOC=1"
        INTERFACE_INCLUDE_DIRECTORIES "${HWLOC_INC_DIR}")
else()
    set(HWLOC_URL "https://download.open-mpi.org/release/hwloc/v2.11/hwloc-${HWLOC_VERSION}.tar.gz")
    
    ExternalProject_Add(hwloc_external
        URL ${HWLOC_URL}
        PREFIX "${CMAKE_CURRENT_BINARY_DIR}/hwloc_external"
        CONFIGURE_COMMAND <SOURCE_DIR>/configure 
            --prefix=${HWLOC_INSTALL_DIR}
            --disable-shared
            --enable-static
            --disable-libxml2
            --disable-pci
            --disable-opencl
            --disable-cuda
            --disable-nvml
            --disable-rsmi
            --disable-gl
            CC=${CMAKE_C_COMPILER}
            CFLAGS=${CMAKE_C_FLAGS}
            LDFLAGS=${CMAKE_EXE_LINKER_FLAGS}
        BUILD_COMMAND make -j4
        INSTALL_COMMAND make install
        BUILD_BYPRODUCTS "${HWLOC_INSTALL_DIR}/lib/libhwloc.a")

    set(HWLOC_INC_DIR "${HWLOC_INSTALL_DIR}/include")
    set(HWLOC_LIB_PATH "${HWLOC_INSTALL_DIR}/lib/libhwloc.a")
    
    set_target_properties(hwloc::hwloc PROPERTIES
        IMPORTED_LOCATION "${HWLOC_LIB_PATH}"
        INTERFACE_COMPILE_DEFINITIONS "HAVE_HWLOC=1"
        INTERFACE_INCLUDE_DIRECTORIES "${HWLOC_INC_DIR}")

    add_dependencies(hwloc::hwloc hwloc_external)
endif()