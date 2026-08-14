import { Rx, RxVerify } from "./miner.js"
import { LogLike, Logger, asLogger, ms } from "./logger.js";

export const VERIFY_MATCHED = 1;
export const VERIFY_SKIPPED = 8;
export const VERIFY_POOL_TARGET = 4;
export const VERIFY_MINER_TARGET = 2;

export interface VerifierOptions {
    log?: LogLike;
    algo?: string;
    mode?: "FAST" | "LIGHT";
    threads?: number;
};

export class Verifier {
    private rx: any = null;
    private native: any = null;

    private log: Logger;
    private seed: string = "";
    private failures: number = 0;
    private stopped: boolean = false;
    private rotating: Promise<void> | null = null;

    constructor(private options: VerifierOptions) {
        this.log = asLogger(options.log, "verify");
    };

    public get ready(): boolean { return this.native !== null && this.seed !== "" && this.rotating === null; };
    public get seed_hash(): string { return this.seed; };

    public pending(): number { return this.native ? this.native.pending() : 0; };

    public sync(seed_hash: string): void {
        if (this.stopped || !seed_hash || seed_hash === this.seed || this.rotating || this.failures >= 3) return;

        this.rotating = this.rotate(seed_hash).then(() => { this.failures = 0; }).catch(err => {
            this.log.error(err, {
                seed: seed_hash.substring(0, 16), failures: ++this.failures,
                ...(this.failures >= 3 ? { giving_up: "shares forward unverified" } : {})
            });
        }).then(() => { this.rotating = null; });
    };

    public async check(blob: string, nonce: string, result: string, miner_target: string, pool_target: string, seed_hash: string): Promise<number> {
        if (!this.native || this.rotating || seed_hash !== this.seed) return VERIFY_SKIPPED;

        try {
            return await this.native.verify(Buffer.from(blob, "hex"), Buffer.from(nonce, "hex"), Buffer.from(result, "hex"), Buffer.from(miner_target, "hex"), Buffer.from(pool_target, "hex"));
        } catch { return VERIFY_SKIPPED; };
    };

    public stop(): void {
        this.stopped = true;
        this.native?.stop();

        this.seed = "";
        this.native = null;
    };

    private async rotate(seed_hash: string): Promise<void> {
        const started = Date.now();

        this.log.info("init dataset", { algo: this.options.algo ?? "rx/0", mode: this.options.mode ?? "FAST", threads: this.options.threads || undefined, seed: `${seed_hash.substring(0, 16)}...` });

        if (!this.rx) {
            this.rx = new (Rx as any)(this.options.algo ?? "rx/0", this.options.mode ?? "FAST");
            await this.rx.allocate(Buffer.from(seed_hash, "hex"));
        } else await this.rx.reallocate(Buffer.from(seed_hash, "hex"), this.options.algo ?? "rx/0");

        if (this.stopped) return;
        if (!this.native) this.native = new (RxVerify as any)(this.rx, this.options.threads ?? 0);

        this.seed = seed_hash;
        this.log.success("ready", { took: ms(started) });
    };
};