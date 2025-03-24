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
        return { ...require("../../build/NMiner.node").init(mode, threads, submitFn), mode, uThreads: threads };
    } catch {
        return { ...require("../../build/Release/NMiner.node").init(mode == "LIGHT" ? "LIGHT" : sysInfo.mode, Math.min(threads, sysInfo.threads), submitFn), mode, uThreads: threads };
    };
};

const setLevel = (str, length) =>
    Array(length - str.length).fill("0").join("") + str;

module.exports.getPoolBlob = blob => {
    const nonce = blob.slice(78, 86); if (nonce == "00000000") {
        const blobs = [];
        for (let i = 1; i < 4096; i++)
            blobs.push(`${blob.slice(0, 82)}${setLevel(i.toString(16), 4)}${blob.slice(86)}`);

        return blobs;
    } else if (nonce.startsWith("000000")) {
        const blobs = [];
        for (let i = 1; i < 256; i++)
            blobs.push(`${blob.slice(0, 82)}${setLevel(i.toString(16), 2)}${blob.slice(84)}`);

        return blobs;
    } else
        return [blob];
};