import { EventEmitter } from "node:events";

type mode = "FAST" | "LIGHT";
type connection = { pool: string, address?: string, pass?: string };

interface MinerOptions {
    mode?: mode;
    proxy?: string;
    threads?: number;
}

interface ProxyOptions {
    port?: number;
    handler?: EventEmitter;
    onShare?: () => void | Promise<void>;
    onConnection?: (address: string, pass: string, threads: number) => boolean | connection | Promise<boolean | connection>;
}

export class NMiner {
    constructor(pool: string, address?: string);
    constructor(pool: string, options?: MinerOptions);

    constructor(pool: string, address: string, pass?: string);
    constructor(pool: string, address: string, options?: MinerOptions);

    constructor(pool: string, address: string, pass: string, options?: MinerOptions);
}

export class NMinerProxy {
    constructor(pool: string, address?: string);
    constructor(pool: string, options?: ProxyOptions);

    constructor(pool: string, address: string, pass?: string);
    constructor(pool: string, address: string, options?: ProxyOptions);

    constructor(pool: string, address: string, pass: string, options?: ProxyOptions);
}