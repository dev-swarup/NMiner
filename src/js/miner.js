const os = require("node:os");

module.exports = {
    threads: Math.round(os.cpus().length * 0.8),
    mode: os.freemem() > (1024 * 1024 * 1024 * 2) ? "FAST" : "LIGHT"
};

module.exports.init = (mode, threads, submitFn) => {
    threads = Math.min(threads || module.exports.threads, module.exports.threads);

    try {
        return { ...require("../../build/NMiner.node").init(mode, threads, submitFn), mode, uThreads: threads };
    } catch {
        return { ...require("../../build/Release/NMiner.node").init(mode, threads, submitFn), mode, uThreads: threads };
    };
};