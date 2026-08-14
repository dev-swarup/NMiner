import si from "systeminformation";
import * as logger from "./logger.js";

import { version } from "../../package.json";
import { numaNodes, hugePages, cacheInfo, recommendedThreads } from "./miner.js";

let _numa: number | null = null;
let _cpuCache: Awaited<ReturnType<typeof si.cpu>> | null = null;

async function getCpu() {
    if (_cpuCache) return _cpuCache;

    _cpuCache = await si.cpu();
    return _cpuCache;
};

export function getNumaNodes(): number {
    if (_numa !== null) return _numa;

    _numa = numaNodes();
    return _numa;
};

const MB = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

export async function PrintTopology(log?: logger.LogLike, pool?: string, algo?: string): Promise<void> {
    if (log !== undefined && !logger.asLogger(log, "program").allows("info")) return;

    const topology: Array<[string, string | Array<string>]> = [];
    const [cpu, system, motherboard, mem, memLayout] = await Promise.all([getCpu(), si.system(), si.baseboard(), si.mem(), si.memLayout()]);

    /// @ts-ignore
    topology.push(["ABOUT", `${logger.CYAN_BOLD(`NMiner/v${version}`)} ${logger.WHITE(process.isBun ? `Bun/v${process.versions.bun}` : `Node.js/${process.version}`)}`]);
    topology.push(["LIBS", `${logger.WHITE(`libuv/${process.versions.uv}`)} ${logger.WHITE(`OpenSSL/${process.versions.openssl}`)}`]);

    const numa_nodes = getNumaNodes();
    const huge_pages = hugePages(1280 * numa_nodes);
    const caches = cacheInfo();

    topology.push(["HUGE PAGES", huge_pages === 0 ? logger.GREEN("permission granted") : huge_pages === 1 ? logger.YELLOW("restart required") : logger.RED("unavailable")]);

    topology.push(["CPU", [
        `${logger.WHITE(`${cpu.manufacturer} ${cpu.brand}`)} (${cpu.processors}) ${logger.CYAN_BOLD(process.arch)} ${caches.aes === "soft" ? logger.RED("soft AES") : logger.GREEN_BOLD(caches.aes.toUpperCase())}`,
        `${logger.GRAY("L2:")}${logger.CYAN(MB(cpu.cache.l2))} ${logger.GRAY("L3:")}${logger.CYAN(MB(cpu.cache.l3))} ${logger.CYAN_BOLD(String(cpu.physicalCores))}C/${logger.CYAN_BOLD(String(cpu.cores))}T ${logger.GRAY("NUMA:")}${logger.CYAN_BOLD(String(numa_nodes))}`
    ]]);

    topology.push(["MEMORY", [
        `${logger.CYAN_BOLD((mem.used / 1024 / 1024 / 1024).toFixed(1) + "/" + (mem.total / 1024 / 1024 / 1024).toFixed(1))} ${logger.WHITE("GB")} ${logger.GRAY(`(${Math.round((mem.used / mem.total) * 100)}%)`)}`,
        ...memLayout.filter(({ bank }) => bank.length > 0).map(bank => `${bank.formFactor}: ${logger.CYAN(String(Math.round(bank.size / 1024 / 1024 / 1024)) + "GB")} ${bank.type} @ ${bank.clockSpeed} MHz ${bank.partNum.length > 0 ? logger.GRAY(bank.partNum) : ""}`)
    ]]);

    topology.push(["MOTHERBOARD", logger.WHITE(`${system.manufacturer} ${motherboard.model}`)]);

    if (pool) topology.push(["POOL #1", `${logger.CYAN_BOLD(pool)}${algo ? ` ${logger.GRAY("algo")} ${logger.WHITE_BOLD(algo)}` : ""}`]);

    for (const [label, val] of topology) {
        process.stdout.write(logger.row(label, ""));

        if (!Array.isArray(val)) { process.stdout.write(`${val}\n`); continue; };
        val.forEach((line, i) => process.stdout.write(i + 1 < val.length ? `${line}\n${logger.INDENT}` : `${line}\n`));
    };

    process.stdout.write("\n");
};

export async function MaxThreads(): Promise<number> {
    const threads = recommendedThreads().reduce((total, n) => total + n, 0);
    if (threads > 0) return threads;

    const cpu = await getCpu();
    return Math.max(1, Math.min(Math.floor(cpu.cache.l3 / 1024 / 1024 / 2), cpu.physicalCores || cpu.cores));
};