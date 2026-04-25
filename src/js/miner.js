const os = require("node:os");
const path = require("node:path");
const options = { threads: Math.round(os.cpus().length * 0.8), mode: os.freemem() > (1024 * 1024 * 1024 * 2) ? "FAST" : "LIGHT" };

module.exports.init = (mode, threads, submitFn) => {
    options.mode = mode == "LIGHT" ? mode : options.mode;
    options.threads = typeof threads == "number" ? threads : options.threads;

    try { return { ...require(path.join(__dirname, "..", "..", "bin", `nminer-${process.platform}.node`)).init(options.mode, options.threads, submitFn), ...options }; } catch (err) {
        try {
            return { ...require("../../build/Release/NMiner.node").init(options.mode, options.threads, submitFn), ...options };
        } catch { };
    };
};