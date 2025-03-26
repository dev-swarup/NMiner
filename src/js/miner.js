const sys = require("systeminformation");
const sysInfo = (require("deasync")(async resolve => {
    try {
        const cpu = await sys.cpu(), mem = await sys.mem();

        resolve(null, {
            numa: cpu.processors,
            name: cpu.brand.split(" ").slice(0, 3).join(" "),
            mode: mem.free >= (cpu.processors * 3221225472) ? "FAST" : "LIGHT",
            threads: Math.min(Math.round(cpu.cores * 0.85), cpu.cache.l3 / 2097152)
        });
    } catch (err) { resolve(err, null); };
}))();

module.exports = { ...sysInfo };
module.exports.init = (mode, threads, submitFn) => {
    mode = mode == "LIGHT" ? "LIGHT" : sysInfo.mode;
    threads = Math.min(threads || sysInfo.threads, sysInfo.threads);

    try {
        return { ...require("../../build/NMiner.node").init(mode, sysInfo.numa, threads, submitFn), mode, uThreads: threads };
    } catch {
        return { ...require("../../build/Release/NMiner.node").init(mode, sysInfo.numa, threads, submitFn), mode, uThreads: threads };
    };
};