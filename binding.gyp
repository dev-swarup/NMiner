{
    "targets": [
        {
            "target_name": "RandomX",
            "sources": [
                "src/main.cpp",
                "src/crypto/Job.cpp"
            ],
            "libraries": [
                "-lnuma",
                "-L<(module_root_dir)/build_randomx", "-lrandomx"
            ],
            "cflags_cc": [
                "-std=c++17",
                "-fexceptions"
            ],
            "defines": [
                "NODE_ADDON_API_CPP_EXCEPTIONS"
            ],
            "dependencies": [
                "<!(node -p \"require('node-addon-api').gyp\")"
            ],
            "include_dirs": [
                "<(module_root_dir)/src",
                "<(module_root_dir)/src/crypto",
                "<(module_root_dir)/node_modules/node-addon-api"
            ]
        }
    ]
}