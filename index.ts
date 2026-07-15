import os from "os";
import * as logger from "./src/js/log.js";

import { EventEmitter } from "./src/js/utils.js";
import { PrintTopology, MaxThreads } from "./src/js/topology.js";
import { connect, StratumClient, StratumJob } from "./src/js/connect.js";
import { Rx, RxJob, RxVariant, JobResult, numaNodes } from "./src/js/miner.js";

const PrintDiff = (i: number) => i >= 100000000 ? `${Math.round(i / 1000000)}M` : i;
const PrintHashes = (i: number) => i > 1000 ? ((i / 1000).toFixed(2) + " kH/s") : (i + " H/s");

export type mode = "FAST" | "LIGHT";
export interface MinerOptions {
    mode?: mode;
    algo?: RxVariant;

    proxy?: string;
    threads?: number;
    logging?: boolean;
    throttle?: boolean;
};

export class NMiner extends EventEmitter<{

}> {
    private pool: string = "stratum+tcp://pool.supportxmr.com:3333";
    private address: string = "49ofeDTjSQXJQDUaaFYZm4fF7zG7v1GN5LkJKLj1vkH5FXh2ipReU3SMkSB4ERTAeiiQpYragiKmS8VY5KmRXxqkSfNH73T";
    private pass: string = "x";
    private options: MinerOptions = { mode: "FAST", algo: "rx/0", logging: true };
    private stratum?: StratumClient;

    private rx: Rx = null as any;
    private rx_job: RxJob = null as any;

    private accepted: number = 0;
    private rejected: number = 0;

    private m_job?: StratumJob & JobResult;

    constructor(pool?: string, address?: string, options?: MinerOptions);
    constructor(pool?: string, address?: string, pass?: string, options?: MinerOptions);
    constructor(pool?: string, address?: string, passOrOptions?: string | MinerOptions, options?: MinerOptions) {
        super();
        if (pool) this.pool = pool;
        if (address) this.address = address;

        const pass = typeof passOrOptions === "string" ? passOrOptions : undefined;
        if (pass) this.pass = pass;

        const opts = typeof passOrOptions === "object" ? passOrOptions : options;
        if (opts) this.options = { ...this.options, ...opts };

        this.rx = new Rx(this.options.algo as RxVariant, this.options.mode as any);
        this.rx_job = new RxJob(this.rx, async (nonce: Buffer, result: Buffer) => {
            const time = Date.now();

            if (this.stratum && this.m_job)
                try {
                    await this.stratum.submit(this.m_job.job_id, nonce.toString("hex"), result.toString("hex"));

                    this.accepted++;
                    logger.Print(logger.CYAN_BOLD(" cpu     "), `${logger.GREEN("accepted")} (${this.accepted}/${(this.rejected > 0 ? logger.RED : logger.WHITE)(String(this.rejected))}) diff ${logger.WHITE_BOLD(String(this.m_job.diff))} ${logger.GetTime(time)}`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);

                    this.rejected++;
                    logger.Print(logger.CYAN_BOLD(" cpu     "), `${logger.RED("rejected")} (${this.accepted}/${logger.RED(String(this.rejected))}) ${logger.RED(msg)}`);
                };
        });

        const m_this = this;
        PrintTopology().then(() => { m_this.reconnect(); });

        if (this.options.logging) {
            let last_hashes = 0;

            setInterval(() => {
                if (this.stratum && this.options.logging) {
                    const current_hashes = this.rx_job.get_hashes();

                    if (current_hashes > 0) {
                        const diff = (current_hashes - last_hashes) / 60;
                        last_hashes = current_hashes;

                        logger.Print(logger.CYAN_BOLD(" cpu     "), `speed ${logger.CYAN_BOLD(" cpu ")} ${PrintHashes(diff)}`);
                    };
                };
            }, 60000);
        };
    };

    private async reconnect() {
        try {
            this.stratum = await connect(this.pool, this.options?.proxy);
            if (this.options.logging) logger.Print(logger.BLUE_BOLD(" net     "), `use pool ${logger.CYAN(`${this.stratum.host}`)} ${logger.GRAY(this.stratum.remoteAddress)}`);

            const job = await this.stratum.login(this.address, this.pass);

            if (job.algo)
                this.options.algo = job.algo as RxVariant;

            if (await this.on_job(job)) {
                const numa = numaNodes();
                const max_threads = await MaxThreads();

                this.rx_job.start(Array(numa).fill(Math.floor(Math.max(max_threads / numa, (this.options.threads || max_threads) / numa))));

                this.stratum
                    .on("job", async (job) => {
                        if (job.algo)
                            this.options.algo = job.algo as RxVariant;

                        this.on_job(job);
                    })
                    .on("close", async () => {
                        this.rx_job.stop();
                        setTimeout(() => this.reconnect(), 5000);
                    });
            };
        } catch (err) {
            this.logger_error(err);
            setTimeout(() => this.reconnect(), 5000);
        };
    };

    private lock: Promise<void> = Promise.resolve();
    private async on_job(job: StratumJob): Promise<boolean> {
        const previous_lock = this.lock;

        let release!: () => void;
        this.lock = new Promise(resolve => release = resolve);

        await previous_lock;

        try {
            if (job.seed_hash != this.m_job?.seed_hash)
                try {
                    this.rx_job.stop();

                    const start = Date.now();
                    this.logger_dataset_init(job.seed_hash);

                    if (await this.rx.reallocate(Buffer.from(job.seed_hash, "hex"), this.options.algo))
                        this.logger_dataset_ready(Date.now() - start);

                    const numa = numaNodes();
                    const max_threads = await MaxThreads();

                    this.rx_job.start(Array(numa).fill(Math.floor(Math.max(max_threads / numa, (this.options.threads || max_threads) / numa))));
                } catch (err) {
                    this.logger_error(err);
                    if (this.stratum) this.stratum.close();

                    return false;
                };

            const result = this.rx_job.send_job(Buffer.from(job.blob, "hex"), Buffer.from(job.target, "hex"), this.m_job?.blob !== job.blob);
            this.logger_new_job(result.diff, job.height, result.txnCount);

            this.m_job = { ...job, ...result };
            return true;
        } finally { release(); };
    };

    public throttle(threads: number, ms: number): void {
        return this.rx_job.throttle(threads, ms);
    };

    private logger_dataset_init(seed_hash: string) {
        if (this.options.logging) logger.Print(logger.CYAN_BOLD(" randomx "), `${logger.MAGENTA("init dataset")} algo ${logger.WHITE_BOLD(this.options.algo as string)} (${logger.WHITE_BOLD(String(os.cpus().length))} threads) seed ${logger.WHITE_BOLD(seed_hash.substring(0, 16) + "...")}`);
    };

    private logger_dataset_ready(time: number) {
        if (this.options.logging) logger.Print(logger.CYAN_BOLD(" randomx "), `${logger.GREEN("dataset ready")} ${logger.GRAY(`(${time} ms)`)}`);
    };

    private logger_new_job(diff: number, height?: number, txnCount?: number) {
        if (this.options.logging) logger.Print(logger.BLUE_BOLD(" net     "), `${logger.MAGENTA("new job")} from ${this.stratum?.host} diff ${logger.WHITE_BOLD(PrintDiff(diff) as string)} algo ${logger.WHITE_BOLD(this.options.algo as string)}` + `${height ? ` height ${logger.WHITE_BOLD(height as any)}` : ""}` + `${txnCount && txnCount > 0 ? ` (${txnCount} tx)` : ""}`);
    };

    private logger_error(err: any) {
        if (!this.options.logging) return;

        const msg = err instanceof Error ? err.message : String(err);
        logger.Print(logger.MAGENTA_BOLD(" program "), logger.RED(`error: ${msg}`));
    };
};