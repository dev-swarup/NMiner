import si from "systeminformation";
import * as logger from "./log.js";

import { version } from "../../package.json";
import { numaNodes, hugePages } from "./miner.js";

export async function PrintTopology(): Promise<void> {
    const topology: Array<[string, string | Array<string>]> = [];
    const [cpu, system, motherboard, mem, memLayout] = await Promise.all([si.cpu(), si.system(), si.baseboard(), si.mem(), si.memLayout()]);

    /// @ts-ignore
    topology.push(["ABOUT", logger.CYAN(`NMiner/v${version}`) + " " + logger.WHITE(process.isBun ? `Bun/v${process.versions.bun}` : `Node.js/${process.version}`)]);

    const numa_nodes = numaNodes();
    const huge_pages = hugePages(numa_nodes);

    topology.push(["HUGE PAGES", (huge_pages === 0 ? logger.GREEN("permission granted") : huge_pages === 1 ? logger.YELLOW("restart required") : logger.RED("not supported")) + "\n"]);

    topology.push(["CPU", [
        `${cpu.manufacturer} ${cpu.brand} (${cpu.processors})`,
        `${logger.GRAY("L2:")}${Math.round(cpu.cache.l2 / 1024 / 1024)}MB ${logger.GRAY("L3:")}${Math.round(cpu.cache.l3 / 1024 / 1024)}MB ${logger.CYAN(String(cpu.physicalCores))}C/${logger.CYAN(String(cpu.cores))}T ${logger.GRAY("NUMA:")}${numa_nodes}`
    ]]);

    topology.push(["MEMORY", [
        `${logger.CYAN((mem.used / 1024 / 1024 / 1024).toFixed(1) + "/" + (mem.total / 1024 / 1024 / 1024).toFixed(1))} ${logger.WHITE("GB")} ${logger.GRAY(`(${Math.round((mem.used / mem.total) * 100)}%)`)}`,
        ...memLayout.map(memLayout => `${memLayout.formFactor}: ${logger.CYAN(String(Math.round(memLayout.size / 1024 / 1024 / 1024)) + "GB")} ${memLayout.type} @ ${memLayout.clockSpeed} MHz ${memLayout.partNum.length > 0 ? logger.GRAY(memLayout.partNum) : ""}`)
    ]]);

    topology.push(["MOTHERBOARD", `${system.manufacturer} ${motherboard.model}`]);

    topology.forEach(([k, val]) => {
        process.stdout.write(logger.GREEN("* ") + logger.WHITE_BOLD(k.padEnd(13)));

        if (Array.isArray(val))
            val.forEach((k, i) => {
                process.stdout.write(k);

                if ((i + 1) < val.length)
                    process.stdout.write(`\n${Array(15).fill(" ").join("")}`);
                else
                    process.stdout.write("\n");
            });
        else
            process.stdout.write(val + "\n");
    });

    process.stdout.write("\n");
};

export async function MaxThreads(): Promise<number> {
    const cpu = await si.cpu();

    return Math.min(cpu.cache.l3 / 1024 / 1024 / 2, cpu.cores);
};