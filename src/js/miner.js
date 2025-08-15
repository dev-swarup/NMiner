const os = require("node:os"), options = { threads: Math.round(os.cpus().length * 0.8), mode: os.freemem() > (1024 * 1024 * 1024 * 2.5) ? "FAST" : "LIGHT" };

module.exports.init = (mode, threads, submitFn) => {
    options.mode = mode == "LIGHT" ? mode : options.mode;
    options.threads = typeof threads == "number" ? threads : options.threads;

    try {
        return { ...require("../../build/NMiner.node").init(options.mode, options.threads, submitFn), ...options };
    } catch {
        return { ...require("../../build/Release/NMiner.node").init(options.mode, options.threads, submitFn), ...options };
    };
};