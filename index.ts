import os from "os";
import * as logger from "./src/js/logger.js";

import { Rx, RxJob, RxVariant, JobResult } from "./src/js/miner.js";
import { PrintTopology, MaxThreads, getNumaNodes } from "./src/js/topology.js";
import { connect, ALGORITHMS, StratumClient, StratumJob } from "./src/js/connect.js";

const PrintDiff = (i: number) => i >= 100000000 ? `${Math.round(i / 1000000)}M` : i;
const PrintHashes = (i: number) => i > 1000 ? ((i / 1000).toFixed(2) + " kH/s") : (i + " H/s");

const DistributeThreads = (total: number, numa: number): number[] => {
    const base = Math.floor(total / numa);
    return Array.from({ length: numa }, (_, i) => base + (i < (total - base * numa) ? 1 : 0));
};

export type mode = "FAST" | "LIGHT";
export interface MinerOptions {
    mode?: mode;
    algo?: RxVariant;

    proxy?: string;
    threads?: number;
    logging?: boolean;
    throttle?: boolean;
    nicehash?: boolean;
    keepalive?: boolean;
    strictTls?: boolean;
};

export class NMiner {
    private pool: string = "stratum+tcp://pool.supportxmr.com:3333";
    private address: string = "49ofeDTjSQXJQDUaaFYZm4fF7zG7v1GN5LkJKLj1vkH5FXh2ipReU3SMkSB4ERTAeiiQpYragiKmS8VY5KmRXxqkSfNH73T";
    private pass: string = "x";
    private options: Partial<MinerOptions> = { mode: "FAST", algo: "rx/0", logging: true };
    private stratum?: StratumClient;

    private rx: Rx = null as any;
    private rx_job: RxJob = null as any;

    private accepted: number = 0;
    private rejected: number = 0;

    private m_job?: StratumJob & JobResult;
    private m_threads?: number[];
    private m_versions: Map<number, { job_id: string, diff: number }> = new Map();

    private requesting_chunk: boolean = false;
    private chunk_backoff: number = 0;
    private chunk_rate: number = 0;
    private chunk_meter?: { time: number, hashes: number };

    private chunk_gen: number = 0;
    private _chunkPollTimeout: NodeJS.Timeout | null = null;

    private schedule_chunk_poll() {
        if (this._chunkPollTimeout) clearTimeout(this._chunkPollTimeout);

        const gen = ++this.chunk_gen, poll = async () => {
            if (gen !== this.chunk_gen) return;

            if (this.m_job && this.stratum && !this.requesting_chunk) {
                const now = Date.now(), hashes = this.rx_job.get_hashes();

                if (this.chunk_meter && now > this.chunk_meter.time) {
                    const observed = (hashes - this.chunk_meter.hashes) * 1000 / (now - this.chunk_meter.time);
                    this.chunk_rate = this.chunk_rate ? this.chunk_rate * 0.7 + observed * 0.3 : observed;
                };

                this.chunk_meter = { time: now, hashes };
                if (now >= this.chunk_backoff && this.rx_job.pending_nonces() < Math.max(this.chunk_rate * 10, 4096)) {
                    this.requesting_chunk = true;

                    try {
                        const chunk: any = await this.stratum.send("get_chunk", { job_id: this.m_job.job_id, hashrate: Math.round(this.chunk_rate) });
                        if (gen !== this.chunk_gen) return;

                        if (chunk && chunk.start_nonce != null)
                            this.rx_job.queue_range(chunk.start_nonce, chunk.nonce_limit ?? 0xFFFFFFFF);
                        else
                            this.chunk_backoff = Date.now() + 5000;
                    } catch { this.chunk_backoff = Date.now() + 5000; } finally { this.requesting_chunk = false; };
                };
            };

            if (gen === this.chunk_gen && this.stratum && this.m_job)
                this._chunkPollTimeout = setTimeout(poll, 500);
            else
                this._chunkPollTimeout = null;
        };

        this._chunkPollTimeout = setTimeout(poll, 500);
    };

    private stop_chunk_poll() {
        this.chunk_gen++;
        this.chunk_backoff = 0;
        this.chunk_meter = undefined;

        if (this._chunkPollTimeout) {
            clearTimeout(this._chunkPollTimeout);
            this._chunkPollTimeout = null;
        };
    };

    private track_version(result: JobResult, job_id: string) {
        this.m_versions.set(result.version, { job_id, diff: result.diff });

        for (const key of this.m_versions.keys()) {
            if (this.m_versions.size <= 16) break;
            this.m_versions.delete(key);
        };
    };

    constructor(pool?: string, address?: string, options?: Partial<MinerOptions>);
    constructor(pool?: string, address?: string, pass?: string, options?: Partial<MinerOptions>);
    constructor(pool?: string, address?: string, passOrOptions?: string | Partial<MinerOptions>, options?: Partial<MinerOptions>) {
        if (pool) this.pool = pool;
        if (address) this.address = address;

        const pass = typeof passOrOptions === "string" ? passOrOptions : undefined;
        if (pass) this.pass = pass;

        const opts = typeof passOrOptions === "object" ? passOrOptions : options;
        if (opts) this.options = { ...this.options, ...opts };

        this.rx = new Rx(this.options.algo as RxVariant, this.options.mode as any);
        this.rx_job = new RxJob(this.rx, async (nonce: Buffer, result: Buffer, version: number) => {
            const time = Date.now();
            const job = this.m_versions.get(version);

            if (!job) {
                if (this.options.logging) logger.Print(logger.CYAN_BG(" cpu     "), logger.GRAY("dropped a share mined against an expired job"));
                return;
            };

            if (this.stratum)
                try {
                    await this.stratum.submit(job.job_id, nonce.toString("hex"), result.toString("hex"));

                    this.accepted++;
                    logger.Print(logger.CYAN_BG(" cpu     "), `${logger.GREEN("accepted")} (${this.accepted}/${(this.rejected > 0 ? logger.RED : logger.WHITE)(String(this.rejected))}) diff ${logger.WHITE_BOLD(String(job.diff))} ${logger.GetTime(time)}`);
                } catch (err) {
                    const msg = err instanceof Error ? err.message : String(err);

                    this.rejected++;
                    logger.Print(logger.CYAN_BG(" cpu     "), `${logger.RED("rejected")} (${this.accepted}/${logger.RED(String(this.rejected))}) ${logger.RED(msg)}`);
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

                        logger.Print(logger.CYAN_BG(" cpu     "), `speed ${logger.CYAN_BG(" cpu ")} ${PrintHashes(diff)}`);
                    };
                };
            }, 60000);
        };

        if (this.options.throttle) {
            let angle = 0;
            let cachedThreads: number | null = null;

            setInterval(async () => {
                if (!this.stratum) return;
                if (cachedThreads === null) cachedThreads = this.options.threads ?? await MaxThreads();

                angle += 0.5;
                const curve = (Math.sin(angle) + 1) / 2, noise = Math.random() * 0.2;

                const throttle_threads = Math.floor(cachedThreads * (curve * 0.6 + noise));
                const throttle_ms = Math.floor(1000 + Math.random() * 1000);

                if (throttle_threads > 0) this.rx_job.throttle(throttle_threads, throttle_ms);
            }, 5000);
        };
    };

    private retry_delay: number = 5000;
    private schedule_reconnect() {
        const delay = Math.round(this.retry_delay * (0.8 + Math.random() * 0.4));
        this.retry_delay = Math.min(this.retry_delay * 2, 300000);

        if (this.options.logging) logger.Print(logger.BLUE_BG(" net     "), `reconnecting in ${logger.WHITE_BOLD(String(Math.round(delay / 1000)))}s`);
        setTimeout(() => this.reconnect(), delay);
    };

    private apply_algo(job: StratumJob): boolean {
        if (!job.algo) return true;

        if (!ALGORITHMS.includes(job.algo)) {
            this.logger_error(new Error(`pool announced unsupported algorithm "${job.algo}" (this miner supports ${ALGORITHMS.join(", ")})`));
            return false;
        };

        this.options.algo = job.algo as RxVariant;
        return true;
    };

    private async reconnect() {
        try {
            const stratum = this.stratum = await connect(this.pool, this.options?.proxy, this.options?.keepalive, this.options?.strictTls);
            if (this.options.logging) logger.Print(logger.BLUE_BG(" net     "), `use pool ${logger.CYAN(`${stratum.host}`)} ${logger.GRAY(stratum.remoteAddress)}`);

            const numa = getNumaNodes();
            const max_threads = await MaxThreads();
            const used_threads = this.options.threads || max_threads;

            stratum
                .on("job", async (job) => {
                    if (this.stratum !== stratum) return;

                    if (!this.apply_algo(job)) return stratum.close();
                    this.on_job(job);
                })
                .on("close", async () => {
                    if (this.stratum === stratum) this.stratum = undefined;

                    this.rx_job.stop();
                    this.stop_chunk_poll();
                    this.schedule_reconnect();
                });

            this.m_versions.clear();
            const job = await stratum.login(this.address, this.pass, used_threads);

            if (!this.apply_algo(job)) return stratum.close();

            if (await this.on_job(job)) {
                this.m_threads = DistributeThreads(used_threads, numa);
                this.rx_job.start(this.m_threads);

                this.retry_delay = 5000;
            };
        } catch (err) {
            this.logger_error(err);

            if (this.stratum)
                this.stratum.close();
            else
                this.schedule_reconnect();
        };
    };

    private lock: Promise<void> = Promise.resolve();
    private async on_job(job: StratumJob): Promise<boolean> {
        const previous_lock = this.lock;

        let release!: () => void;
        this.lock = new Promise(resolve => release = resolve);

        await previous_lock;

        try {
            if (this.m_job && this.m_job.job_id === job.job_id && this.m_job.blob === job.blob && this.m_job.start_nonce === job.start_nonce)
                return true;

            if (job.seed_hash != this.m_job?.seed_hash || (this.options.algo && this.rx.variant != this.options.algo))
                try {
                    this.rx_job.stop();

                    const start = Date.now();
                    this.logger_dataset_init(job.seed_hash);

                    if (await this.rx.reallocate(Buffer.from(job.seed_hash, "hex"), this.options.algo))
                        this.logger_dataset_ready(Date.now() - start);

                    const numa = getNumaNodes();
                    const used_threads = this.options.threads || await MaxThreads();

                    this.m_threads = DistributeThreads(used_threads, numa);
                    this.rx_job.start(this.m_threads);
                } catch (err) {
                    this.logger_error(err);
                    if (this.stratum) this.stratum.close();

                    return false;
                };

            const reset_nonce = this.m_job?.blob !== job.blob;
            const start_nonce = job.start_nonce, nonce_limit = job.nonce_limit;

            const result = start_nonce != null ? this.rx_job.send_job(Buffer.from(job.blob, "hex"), Buffer.from(job.target, "hex"), this.options.nicehash ?? false, reset_nonce, start_nonce, nonce_limit) : this.rx_job.send_job(Buffer.from(job.blob, "hex"), Buffer.from(job.target, "hex"), this.options.nicehash ?? false, reset_nonce);

            this.logger_new_job(result.diff, job.height, result.txnCount);

            this.track_version(result, job.job_id);
            this.m_job = Object.assign({} as any, job, result);

            if (job.start_nonce != null)
                this.schedule_chunk_poll();
            else
                this.stop_chunk_poll();

            return true;
        } finally { release(); };
    };

    public throttle(threads: number, ms: number): void {
        return this.rx_job.throttle(threads, ms);
    };

    private logger_dataset_init(seed_hash: string) {
        if (this.options.logging) logger.Print(logger.CYAN_BG(" randomx "), `${logger.MAGENTA("init dataset")} algo ${logger.WHITE_BOLD(this.options.algo as string)} (${logger.WHITE_BOLD(String(os.cpus().length))} threads) seed ${logger.WHITE_BOLD(seed_hash.substring(0, 16) + "...")}`);
    };

    private logger_dataset_ready(time: number) {
        if (this.options.logging) logger.Print(logger.CYAN_BG(" randomx "), `${logger.GREEN("dataset ready")} ${logger.GRAY(`(${time} ms)`)}`);
    };

    private logger_new_job(diff: number, height?: number, txnCount?: number) {
        if (this.options.logging) logger.Print(logger.BLUE_BG(" net     "), `${logger.MAGENTA("new job")} from ${this.stratum?.host} diff ${logger.WHITE_BOLD(PrintDiff(diff) as string)} algo ${logger.WHITE_BOLD(this.options.algo as string)}` + `${height ? ` height ${logger.WHITE_BOLD(height as any)}` : ""}` + `${txnCount && txnCount > 0 ? ` (${txnCount} tx)` : ""}`);
    };

    private logger_error(err: any) {
        if (!this.options.logging) return;

        const msg = err instanceof Error ? err.message : String(err);
        logger.Print(logger.MAGENTA_BG(" program "), logger.RED(`error: ${msg}`));
    };
};