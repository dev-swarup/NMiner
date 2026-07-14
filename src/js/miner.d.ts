export type RxMode = "FAST" | "LIGHT";

declare type JobResult = {
    diff: number;
    txnCount?: number;
}

declare type RxVariant = "rx/0" | "rx/monero";
declare type RxSubmitFn = (nonce: Buffer, result: Buffer) => void | Promise<void>

export class Rx {
    constructor(variant: RxVariant, mode: RxMode);

    public allocate(seed_hash: Buffer): Promise<boolean>;
    public reallocate(seed_hash: Buffer, variant?: RxVariant): Promise<boolean>;
}

export class RxJob {
    constructor(rx: Rx, submitFn: RxSubmitFn);

    public stop(): void;
    public pause(): void;
    public start(threads?: number[]): void;
    
    public get_hashes(): number;
    public send_job(blob: Buffer, diff: Buffer, reset_nonce: boolean): JobResult;
}

export function numaNodes(): number;
export function hugePages(pages?: number): number;