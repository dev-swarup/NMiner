export type RxMode = "FAST" | "LIGHT";

declare type JobResult = {
    diff: number;
    txnCount?: number;
}

declare type RxVariant = "rx/0" | "rx/wow" | "rx/arq" | "rx/sfx" | "rx/yada" | "rx/graft" | "rx/monero";
declare type RxSubmitFn = (job_id: string, nonce: string, result: string) => void | Promise<void>

export class Rx {
    constructor(variant: RxVariant, mode: RxMode);

    public allocate(seed_hash: string): Promise<boolean>;
    public reallocate(seed_hash: string, variant?: RxVariant): Promise<boolean>;
}

export class RxJob {
    constructor(rx: Rx, submitFn: RxSubmitFn);

    public stop(): void;
    public pause(): void;
    public start(threads?: number): void;

    public send_job(job_id: string, blob: string, diff: string, reset_nonce: boolean): JobResult;
}