export type RxMode = "FAST" | "LIGHT";

declare type JobResult = {
    diff: number;
    txnCount?: number;
}

declare type RxVariant = "rx/0" | "rx/monero" | "rx/v2";
declare type RxSubmitFn = (nonce: Buffer, result: Buffer) => void | Promise<void>

declare type RxNodeCache = {
    node: number;
    l2: number;
    l3: number;
    cores: number;
    pus: number;
    threads: number;
}

declare type RxCacheInfo = {
    l2PerThread: number;
    l3PerThread: number;
    blake2: "avx2" | "sse41" | "reference";
    nodes: RxNodeCache[];
}

export class Rx {
    constructor(variant: RxVariant, mode: RxMode);

    public readonly variant: RxVariant;

    public allocate(seed_hash: Buffer): Promise<boolean>;
    public reallocate(seed_hash: Buffer, variant?: RxVariant): Promise<boolean>;
}

export class RxJob {
    constructor(rx: Rx, submitFn: RxSubmitFn);

    public stop(): void;
    public pause(): void;
    public start(threads?: number[]): void;
    public throttle(threads: number, ms: number): void;

    public get_hashes(): number;
    public send_job(blob: Buffer, diff: Buffer, nicehash: boolean, reset_nonce: boolean, start_nonce?: number, nonce_limit?: number): JobResult;
}

export function numaNodes(): number;
export function hugePages(pages?: number): number;

export function cacheInfo(): RxCacheInfo;

export function recommendedThreads(): number[];