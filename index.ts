import os from "os";
import { Level, Logger, Sink, createLogger, ms } from "./src/js/logger.js";

import { Rx, RxJob, RxVariant, JobResult } from "./src/js/miner.js";
import { PrintTopology, MaxThreads, getNumaNodes } from "./src/js/topology.js";
import { connect, ALGORITHMS, StratumClient, StratumJob } from "./src/js/connect.js";

export type { Level, Logger, Sink, Entry } from "./src/js/logger.js";

const PrintDiff = (i: number) => i >= 100000000 ? `${Math.round(i / 1000000)}M` : i;
const PrintHashes = (i: number) => i > 1000 ? `${(i / 1000).toFixed(2)}kH/s` : `${i.toFixed(2)}H/s`;

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
    throttle?: boolean;
    nicehash?: boolean;
    keepalive?: boolean;
    strictTls?: boolean;

    logger?: Logger | Sink;
    logging?: boolean | Level;
};

export class NMiner {
    private pool: string = "stratum+tcp://pool.supportxmr.com:3333";
    private address: string = "49ofeDTjSQXJQDUaaFYZm4fF7zG7v1GN5LkJKLj1vkH5FXh2ipReU3SMkSB4ERTAeiiQpYragiKmS8VY5KmRXxqkSfNH73T";
    private pass: string = "x";
    private options: Partial<MinerOptions> = { mode: "FAST", algo: "rx/0", logging: true };
    private stratum?: StratumClient;

    private log!: Logger;
    private cpu!: Logger;
    private net!: Logger;
    private dataset!: Logger;

    private rx: Rx = null as any;
    private rx_job: RxJob = null as any;

    private accepted: number = 0;
    private rejected: number = 0;

    private m_job?: StratumJob & JobResult;
    private m_seed?: string;
    private m_threads?: number[];
    private m_versions: Map<number, { job_id: string, diff: number }> = new Map();

    private requesting_chunk: boolean = false;
    private chunk_backoff: number = 0;
    private chunk_rate: number = 0;
    private chunk_meter?: { time: number, hashes: number };

    private chunk_gen: number = 0;
    private _chunkPollTimeout: NodeJS.Timeout | null = null;

    private closed: boolean = false;
    private timers: NodeJS.Timeout[] = [];
    private _reconnectTimeout: NodeJS.Timeout | null = null;

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
                        else if (chunk && typeof chunk.retry_after === "number")
                            this.chunk_backoff = Date.now() + Math.min(30000, Math.max(250, chunk.retry_after));
                        else if (!chunk || !(chunk.migrated || chunk.job_expired))
                            this.chunk_backoff = Date.now() + 5000;
                    } catch { this.chunk_backoff = Date.now() + 5000; } finally { this.requesting_chunk = false; };
                };
            };

            if (gen !== this.chunk_gen) return;
            this._chunkPollTimeout = this.stratum && this.m_job ? setTimeout(poll, 500) : null;
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

        this.log = createLogger(this.options);
        this.cpu = this.log.child("cpu");
        this.net = this.log.child("net");
        this.dataset = this.log.child("randomx");

        this.rx = new Rx(this.options.algo as RxVariant, this.options.mode as any);
        this.rx_job = new RxJob(this.rx, async (nonce: Buffer, result: Buffer, version: number) => {
            const time = Date.now();
            const job = this.m_versions.get(version);

            if (!job) return void this.cpu.debug("share dropped, job expired", { version });

            if (this.stratum)
                try {
                    await this.stratum.submit(job.job_id, nonce.toString("hex"), result.toString("hex"));

                    this.accepted++;
                    this.cpu.success("accepted", { accepted: this.accepted, rejected: this.rejected, diff: job.diff, took: ms(time) });
                } catch (err) {
                    this.rejected++;
                    this.cpu.warn("rejected", { accepted: this.accepted, rejected: this.rejected, reason: err instanceof Error ? err.message : String(err), took: ms(time) });
                };
        });

        const m_this = this;
        PrintTopology(this.log).catch(err => this.log.warn("topology unavailable", { reason: err instanceof Error ? err.message : String(err) })).then(() => { m_this.reconnect(); });

        if (this.cpu.enabled) {
            let last_hashes = 0;

            this.timers.push(setInterval(() => {
                if (!this.stratum) return;

                const current_hashes = this.rx_job.get_hashes();
                if (current_hashes <= 0) return;

                const diff = (current_hashes - last_hashes) / 60;
                last_hashes = current_hashes;

                this.cpu.info("speed", { "60s": PrintHashes(diff), hashes: current_hashes, threads: this.m_threads?.reduce((total, count) => total + count, 0) });
            }, 60000));
        };

        if (this.options.throttle) {
            let angle = 0;
            let cachedThreads: number | null = null;

            this.timers.push(setInterval(async () => {
                if (!this.stratum) return;
                if (cachedThreads === null) cachedThreads = this.options.threads ?? await MaxThreads();

                angle += 0.5;
                const curve = (Math.sin(angle) + 1) / 2, noise = Math.random() * 0.2;

                const throttle_threads = Math.floor(cachedThreads * (curve * 0.6 + noise));
                const throttle_ms = Math.floor(1000 + Math.random() * 1000);

                if (throttle_threads > 0) this.rx_job.throttle(throttle_threads, throttle_ms);
            }, 5000));
        };
    };

    private retry_delay: number = 5000;
    private schedule_reconnect() {
        if (this.closed || this._reconnectTimeout) return;

        const delay = Math.round(this.retry_delay * (0.8 + Math.random() * 0.4));
        this.retry_delay = Math.min(this.retry_delay * 2, 300000);

        this.net.warn("reconnecting", { retry: `${Math.round(delay / 1000)}s`, pool: this.pool });
        this._reconnectTimeout = setTimeout(() => { this._reconnectTimeout = null; this.reconnect(); }, delay);
    };

    private apply_algo(job: StratumJob): boolean {
        if (!job.algo) return true;

        if (!ALGORITHMS.includes(job.algo)) {
            this.log.error(`pool announced an unsupported algorithm`, { algo: job.algo, supported: ALGORITHMS.join(",") });
            return false;
        };

        this.options.algo = job.algo as RxVariant;
        return true;
    };

    private async reconnect() {
        if (this.closed) return;

        try {
            const stratum = this.stratum = await connect(this.pool, this.options?.proxy, this.options?.keepalive, this.options?.strictTls);

            if (this.closed) return stratum.close();
            this.net.info("connected", { pool: stratum.host, ip: stratum.remoteAddress, proxy: this.options.proxy });

            const numa = getNumaNodes();
            const max_threads = await MaxThreads();
            const used_threads = this.options.threads || max_threads;

            stratum
                .on("job", async (job) => {
                    if (this.stratum !== stratum) return;

                    if (!this.apply_algo(job)) return stratum.close();
                    this.on_job(job).catch(err => { this.log.error(err); stratum.close(); });
                })
                .on("close", async () => {
                    if (this.stratum !== stratum) return;
                    this.stratum = undefined;

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
            this.log.error(err);

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

            if (job.seed_hash != this.m_seed || (this.options.algo && this.rx.variant != this.options.algo))
                try {
                    this.rx_job.stop();
                    this.m_seed = undefined;

                    const start = Date.now();
                    this.dataset.info("dataset init", { mode: this.options.mode, algo: this.options.algo, seed: job.seed_hash.substring(0, 16), threads: os.cpus().length });

                    if (!await this.rx.reallocate(Buffer.from(job.seed_hash, "hex"), this.options.algo))
                        throw new Error("RandomX dataset allocation failed");

                    this.m_seed = job.seed_hash;
                    this.dataset.success("dataset ready", { took: ms(start) });

                    const numa = getNumaNodes();
                    const used_threads = this.options.threads || await MaxThreads();

                    this.m_threads = DistributeThreads(used_threads, numa);
                    this.rx_job.start(this.m_threads);

                    this.cpu.debug("mining", { threads: used_threads, numa, split: this.m_threads.join("/") });
                } catch (err) {
                    this.log.error(err);
                    if (this.stratum) this.stratum.close();

                    return false;
                };

            const reset_nonce = this.m_job?.blob !== job.blob;
            const start_nonce = job.start_nonce, nonce_limit = job.nonce_limit;

            const result = start_nonce != null ? this.rx_job.send_job(Buffer.from(job.blob, "hex"), Buffer.from(job.target, "hex"), this.options.nicehash ?? false, reset_nonce, start_nonce, nonce_limit) : this.rx_job.send_job(Buffer.from(job.blob, "hex"), Buffer.from(job.target, "hex"), this.options.nicehash ?? false, reset_nonce);

            this.net.info("new job", { from: this.stratum?.host, diff: PrintDiff(result.diff), algo: this.options.algo, height: job.height, tx: result.txnCount || undefined });

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

    public close(): void {
        if (this.closed) return;
        this.closed = true;

        for (const timer of this.timers.splice(0)) clearInterval(timer);

        if (this._reconnectTimeout) {
            clearTimeout(this._reconnectTimeout);
            this._reconnectTimeout = null;
        };

        this.stop_chunk_poll();
        this.rx_job.stop();

        const stratum = this.stratum;
        this.stratum = undefined;

        stratum?.close();
        this.log.info("stopped", { accepted: this.accepted, rejected: this.rejected });
    };

};

import { EventEmitter } from "./src/js/utils.js";
import { Edge, UdpRouter } from "./src/js/edge.js";
import { Fleet, FleetChild, autoWorkers, foreignCluster } from "./src/js/fleet.js";
import { Backend, Credentials, LocalBackend, PrimaryHub, ShareReport } from "./src/js/hub.js";

export type LoginContext = {
    pass: string;
    reject?: string;
    address: string;
    override?: Partial<MinerOptions & { pool: string, address: string, pass: string }>;
};

export interface ProxyOptions extends MinerOptions {
    port?: number;
    udpPort?: number;
    maxLinks?: number;
    cluster?: boolean | number;
    expandNicehash?: boolean;

    verify?: boolean;
    verifyMode?: mode;
    verifyThreads?: number;

    authorize?: (username: string, password: string) => boolean | Promise<boolean>;
};

export class NMinerProxy extends EventEmitter<{
    share: [address: string, target: string, height?: number];
    work: [address: string, difficulty: number, forwarded: boolean, solved: number];
}> {
    private pool: string;
    private pass: string;
    private address: string;
    private options: ProxyOptions;

    private log: Logger;
    private share: Logger;

    private hub?: PrimaryHub;
    private local?: LocalBackend;
    private backend!: Backend;

    private edge?: Edge;
    private fleet?: Fleet;
    private udp?: UdpRouter;
    private idle: boolean = false;

    private work: number = 0;
    private solved: number = 0;
    private accepted: number = 0;
    private rejected: number = 0;
    private absorbed: number = 0;

    constructor(pool?: string, address?: string, options?: ProxyOptions);
    constructor(pool?: string, address?: string, pass?: string, options?: ProxyOptions);
    constructor(pool?: string, address?: string, passOrOptions?: string | ProxyOptions, options?: ProxyOptions) {
        super();

        this.pool = pool || "stratum+tcp://pool.supportxmr.com:3333";
        this.address = address || "49ofeDTjSQXJQDUaaFYZm4fF7zG7v1GN5LkJKLj1vkH5FXh2ipReU3SMkSB4ERTAeiiQpYragiKmS8VY5KmRXxqkSfNH73T";
        this.pass = typeof passOrOptions === "string" ? passOrOptions : "x";

        this.options = { port: 8080, logging: true, mode: "FAST", algo: "rx/0" };

        const opts = typeof passOrOptions === "object" ? passOrOptions : options;
        if (opts) this.options = { ...this.options, ...opts };

        this.log = createLogger(this.options, "proxy");
        this.share = this.log.child("share");

        const foreign = foreignCluster();

        if (foreign && foreign.index > 0) {
            this.idle = true;
            this.log.warn(`idle, NMiner clusters itself so upstream stays on one process — run a single instance (pm2: exec_mode "fork" or instances 1)`, { manager: foreign.manager, instance: foreign.index });

            return;
        };

        if (foreign) this.log.warn("foreign process manager detected, NMiner manages its own workers — keep instances at 1", { manager: foreign.manager });

        this.local = this.create_backend();
        this.backend = this.local;

        const workers = this.worker_count();

        if (workers > 0) {
            this.hub = new PrimaryHub(this.local);
            this.fleet = new Fleet(workers, this.log, (child, raw) => this.route(child, raw), child => { this.hub!.evict(child.id); this.udp?.evict(child.id); });
            this.fleet.listen(this.options.port ?? 8080);

            if (this.options.udpPort) {
                this.udp = new UdpRouter(this.options.udpPort, { log: this.log }, () => this.fleet!.all());
                this.udp.listen();
            };

            return;
        };

        this.edge = new Edge(this.backend, { port: this.options.port, log: this.log });
        this.edge.listen();

        if (this.options.udpPort) {
            this.udp = new UdpRouter(this.options.udpPort, { log: this.log }, undefined, this.backend);
            this.udp.listen();
        };
    };

    private route(child: FleetChild, raw: any): void {
        if (raw.t === "u") return this.udp?.write(raw.k, raw.d);
        if (raw.t === "ux") return this.udp?.forget(raw.k);

        this.hub!.message(child, raw);
    };

    public stats() {
        return {
            work: this.work,
            idle: this.idle,
            solved: this.solved,
            accepted: this.accepted,
            rejected: this.rejected,
            absorbed: this.absorbed,
            verifying: this.local?.verifying ?? false,
            workers: this.fleet?.stats() ?? [], miners: this.local?.accounting() ?? [],
            pools: (this.local?.pools ?? []).map(upstream => ({ pool: upstream.pool, miners: upstream.size, links: upstream.stats() }))
        };
    };

    public switch_pool(config: { pool: string, address: string, pass: string, proxy?: string }): void {
        this.pool = config.pool;
        this.pass = config.pass;
        this.address = config.address;

        if (config.proxy !== undefined) this.options.proxy = config.proxy;

        this.log.info("switching pool", { pool: config.pool, proxy: this.options.proxy });
        this.local?.reset("Proxy switched pools, reconnect.");
    };

    public close(): void {
        this.log.info("shutting down", { accepted: this.accepted, rejected: this.rejected, absorbed: this.absorbed, solved: PrintDiff(this.solved) });

        this.edge?.close();
        this.udp?.close();
        this.fleet?.stop();
        this.local?.shutdown();
    };

    private worker_count(): number {
        const setting = this.options.cluster;

        if (setting === false) return 0;
        if (setting === undefined || setting === true) return autoWorkers();

        return Number.isFinite(setting) && (setting as number) > 0 ? Math.floor(setting as number) : 0;
    };

    private create_backend(): LocalBackend {
        const resolve = async (address: string, pass: string): Promise<Credentials> => {
            if (this.options.authorize && !(await this.options.authorize(address, pass)))
                throw new Error("Unauthorized");

            return { pool: this.pool, address: this.address, pass: this.pass, proxy: this.options.proxy };
        };

        const sink = (share: ShareReport) => {
            this.emit("work", share.address, share.difficulty, share.forwarded, share.solved);
            if (share.accepted) this.work += share.difficulty;

            if (!share.forwarded) {
                this.absorbed++;
                return void this.share.debug("absorbed", { diff: share.difficulty, actual: PrintDiff(share.actual), absorbed: this.absorbed, took: ms(share.elapsed) });
            };

            if (share.accepted) {
                this.accepted++;
                this.solved += share.solved;

                this.emit("share", share.address, share.target, share.height);
                this.share.success("accepted", { accepted: this.accepted, rejected: this.rejected, diff: share.difficulty, solved: PrintDiff(share.solved), total: PrintDiff(this.solved), took: ms(share.elapsed) });
            } else {
                this.rejected++;
                this.share.warn("rejected", { accepted: this.accepted, rejected: this.rejected, diff: share.difficulty, took: ms(share.elapsed) });
            };
        };

        return new LocalBackend(resolve, sink, {
            log: this.log,
            proxy: this.options.proxy,
            maxLinks: this.options.maxLinks,
            keepalive: this.options.keepalive,
            strictTls: this.options.strictTls,
            expandNicehash: this.options.expandNicehash
        }, this.options.verify === false ? false : { mode: this.options.verifyMode ?? "FAST", algo: this.options.algo, threads: this.options.verifyThreads, log: this.log });
    };
};