import { LogLike, Logger, asLogger } from "./logger.js";
import { connect, StratumClient, StratumJob } from "./connect.js";
import { Grant, Ledger, NonceSpace, capacity, chunkSize, createSpace, fullSpace, nicehashSlot, nicehashSpace, spaceLeft, take, NICEHASH_SLOTS } from "./nonce.js";

export interface UpstreamOptions {
    log?: LogLike;
    proxy?: string;
    maxLinks?: number;
    keepalive?: boolean;
    strictTls?: boolean;
    idleTimeout?: number;
    expandNicehash?: boolean;
};

export interface UpstreamClient {
    hashrate: number;
    drop(message: string): void;
    target?(pool: string): string;
    job(payload: StratumJob & Partial<Grant>): void;
};

export type ChunkReply = Grant | { migrated: true } | { job_expired: true } | { retry_after: number };

const SAFETY = 0.8;
const STRAY_SAMPLE = 8;
const MIN_INTERVAL = 4000;
const IDLE_LINK_MS = 60000;
export const IDLE_POOL_MS = 300000;
const REBALANCE_MS = 15000;
const MAX_INTERVAL = 240000;
const DEFAULT_INTERVAL = 120000;

class Link {
    public socket: StratumClient | null = null;
    public connecting: Promise<void> | null = null;

    public job: StratumJob | null = null;
    public space: NonceSpace = createSpace([]);

    public slot: number = 0;
    public extra: number[] = [];

    public job_at: number = 0;
    public samples: number = 0;
    public idle_at: number = 0;
    public interval: number = DEFAULT_INTERVAL;
    public interval_hi: number = DEFAULT_INTERVAL;

    public load: number = 0;
    public clients: Set<UpstreamClient> = new Set();

    public capacity(): number {
        return capacity(this.space, this.interval_hi);
    };

    public headroom(): number {
        return this.capacity() * SAFETY - this.load;
    };

    public deadline(): number {
        return Math.max(1, (this.interval - (Date.now() - this.job_at)) / 1000);
    };
};

const rateOf = (client: UpstreamClient): number => client.hashrate > 0 ? client.hashrate : 1000;

export class Upstream {
    private links: Link[] = [];
    private live: Set<UpstreamClient> = new Set();
    private homes: Map<UpstreamClient, Link> = new Map();
    private ledgers: Map<UpstreamClient, Ledger> = new Map();

    private timer: NodeJS.Timeout;
    private closed: boolean = false;

    private expand: boolean;
    private stray_shares: number = 0;
    private stray_rejects: number = 0;

    private log: Logger;

    constructor(public pool: string, public address: string, public pass: string, private options: UpstreamOptions, private retired?: () => void) {
        this.log = asLogger(options.log, "pool");
        this.expand = options.expandNicehash === true;

        this.timer = setInterval(() => this.rebalance(), Math.max(1000, Math.min(REBALANCE_MS, (options.idleTimeout ?? IDLE_POOL_MS) / 2)));
        this.timer.unref?.();
    };

    public get size(): number { return this.homes.size; };
    public get connections(): number { return this.links.length; };

    public stats() {
        return this.links.map(link => ({
            slot: link.slot,
            miners: link.clients.size,
            left: spaceLeft(link.space),
            load: Math.round(link.load),
            worst: Math.round(link.interval_hi),
            interval: Math.round(link.interval),
            capacity: Math.round(link.capacity())
        }));
    };

    public async attach(client: UpstreamClient): Promise<StratumJob & Grant> {
        this.live.add(client);

        try {
            const link = await this.pick(client);
            if (!this.live.has(client)) throw new Error("Miner detached before it was housed.");

            this.house(link, client);

            const grant = this.grant(link, client);
            if (!grant) throw new Error("Upstream nonce space is exhausted.");

            return this.payload(link, client, grant);
        } catch (err) {
            this.detach(client);
            throw err;
        };
    };

    public detach(client: UpstreamClient): void {
        this.live.delete(client);

        this.evict(client);
        this.ledgers.delete(client);
    };

    public report(client: UpstreamClient, hashrate: number): void {
        if (!(hashrate > 0)) return;

        const link = this.homes.get(client);
        if (link) link.load += hashrate - rateOf(client);

        client.hashrate = hashrate;
    };

    public async chunk(client: UpstreamClient, job_id: string): Promise<ChunkReply> {
        const link = this.homes.get(client);
        if (!link || !link.job) return { retry_after: 2000 };
        if (link.job.job_id !== job_id) return { job_expired: true };

        const grant = this.grant(link, client);
        if (grant) return grant;

        if (await this.migrate(link, client)) return { migrated: true };
        return { retry_after: Math.max(500, Math.round(link.interval - (Date.now() - link.job_at))) };
    };

    public jobOf(client: UpstreamClient): StratumJob | null {
        return this.homes.get(client)?.job ?? null;
    };

    public async submit(client: UpstreamClient, job_id: string, nonce: string, result: string): Promise<any> {
        const link = this.homes.get(client);
        if (!link || !link.socket) throw new Error("Upstream is not connected.");

        const stray = this.expand && link.slot > 0 && nonce.length >= 8 && parseInt(nonce.substring(6, 8), 16) !== link.slot;
        if (stray) this.stray_shares++;

        try {
            return await link.socket.submit(job_id, nonce, result);
        } catch (err) {
            if (stray && ++this.stray_rejects >= STRAY_SAMPLE && this.stray_rejects * 2 >= this.stray_shares) this.narrow();
            throw err;
        };
    };

    public close(): void {
        this.closed = true;
        clearInterval(this.timer);

        for (const link of this.links.splice(0)) {
            link.socket?.removeAllListeners("close");
            link.socket?.close();
        };

        this.live.clear();
        this.homes.clear();
        this.ledgers.clear();
    };

    private house(link: Link, client: UpstreamClient): void {
        link.clients.add(client);
        link.load += rateOf(client);
        link.idle_at = 0;

        this.homes.set(client, link);
    };

    private evict(client: UpstreamClient): void {
        const link = this.homes.get(client);
        if (!link) return;

        link.clients.delete(client);
        link.load = Math.max(0, link.load - rateOf(client));

        if (link.clients.size === 0) link.idle_at = Date.now();
        this.homes.delete(client);
    };

    private grant(link: Link, client: UpstreamClient): Grant | null {
        const left = spaceLeft(link.space);
        if (left <= 0) return null;

        const rate = rateOf(client);
        const share = link.load > 0 ? left * (rate / link.load) : left;

        const range = take(link.space, chunkSize(rate, share, link.deadline()));
        if (range && link.job) this.record(client, link.job.job_id, range);

        return range;
    };

    private record(client: UpstreamClient, job_id: string, range: Grant): void {
        let ledger = this.ledgers.get(client);

        if (!ledger) {
            ledger = new Ledger();
            this.ledgers.set(client, ledger);
        };

        ledger.record(job_id, range);
    };

    public owns(client: UpstreamClient, nonce: number): boolean {
        return this.ledgers.get(client)?.owns(nonce) ?? false;
    };

    private payload(link: Link, client: UpstreamClient, grant: Grant): StratumJob & Grant {
        const job = link.job!;
        return { ...job, ...(client.target ? { target: client.target(job.target), pool_target: job.target } : {}), ...grant };
    };

    private async pick(client: UpstreamClient, exclude?: Link): Promise<Link> {
        const rate = rateOf(client), max = this.options.maxLinks ?? 64;

        for (; ;) {
            if (this.closed) throw new Error("Upstream is closed.");

            let best: Link | null = null, roomiest: Link | null = null;

            for (const link of this.links) {
                if (link === exclude || !link.job || spaceLeft(link.space) <= 0) continue;
                const room = link.headroom();

                if (!roomiest || room > roomiest.headroom()) roomiest = link;
                if (room >= rate && (!best || room < best.headroom())) best = link;
            };

            if (best) return best;

            const pending = this.links.find(link => link.connecting); if (pending) {
                await pending.connecting!.catch(() => { });
                continue;
            };

            if (this.links.length >= max) {
                if (roomiest) return roomiest;
                throw new Error(`Upstream link limit (${max}) reached.`);
            };

            const link = new Link();
            const seen = this.links.find(peer => peer.samples > 0); if (seen) {
                link.interval = seen.interval;
                link.interval_hi = seen.interval_hi;
            };

            this.links.push(link);

            try {
                await this.open(link);
                this.reslice();

                return link;
            } catch (err) {
                const index = this.links.indexOf(link);
                if (index !== -1) this.links.splice(index, 1);

                if (roomiest) return roomiest;
                throw err;
            };
        };
    };

    private open(link: Link): Promise<void> {
        if (link.socket) return Promise.resolve();
        if (link.connecting) return link.connecting;

        link.connecting = (async () => {
            const socket = await connect(this.pool, this.options.proxy, this.options.keepalive, this.options.strictTls);

            socket.on("job", job => this.accept(link, job));
            socket.on("close", () => this.sever(link));

            let job: StratumJob; try {
                job = await socket.login(this.address, this.pass);
            } catch (err) {
                socket.removeAllListeners("close");
                socket.close();

                throw err;
            };

            link.socket = socket;
            if (!link.job) this.accept(link, job);
            this.log.info("link up", { host: socket.host, links: this.links.length, slot: link.slot > 0 ? `0x${link.slot.toString(16).padStart(2, "0")}` : undefined });
        })().finally(() => { link.connecting = null; });

        return link.connecting;
    };

    private accept(link: Link, job: StratumJob): void {
        const now = Date.now();

        if (link.job_at) {
            const observed = Math.min(MAX_INTERVAL, Math.max(MIN_INTERVAL, now - link.job_at));
            const first = link.samples++ === 0;

            link.interval = first ? observed : link.interval * 0.7 + observed * 0.3;
            link.interval_hi = first ? observed : Math.max(observed, link.interval_hi * 0.9);

            if (first) for (const peer of this.links) if (peer.samples === 0) peer.interval_hi = peer.interval = observed;
        };


        link.job = job;
        link.job_at = now;
        link.slot = nicehashSlot(job.blob);
        link.space = link.slot > 0 ? nicehashSpace(link.slot, this.expand ? link.extra : []) : fullSpace();

        this.log.debug("new job", { job: job.job_id, height: job.height, miners: link.clients.size, interval: `${Math.round(link.interval / 1000)}s` });

        for (const client of [...link.clients]) {
            const grant = this.grant(link, client);

            if (grant)
                client.job(this.payload(link, client, grant));
            else
                this.migrate(link, client).then(moved => { if (!moved) client.drop("Upstream nonce space is exhausted."); }).catch(() => { });
        };
    };

    private sever(link: Link): void {
        const index = this.links.indexOf(link);
        if (index !== -1) this.links.splice(index, 1);

        link.job = null;
        link.socket = null;

        const orphans = [...link.clients];

        link.load = 0;
        link.clients.clear();

        for (const client of orphans) this.homes.delete(client);
        this.reslice();

        this.log.warn("link down", { links: this.links.length, rehoming: orphans.length });

        for (const client of orphans)
            this.attach(client).then(job => client.job(job)).catch(err => client.drop(err instanceof Error ? err.message : String(err)));

        if (!this.links.length && !this.live.size) this.retired?.();
    };

    private async migrate(from: Link, client: UpstreamClient): Promise<boolean> {
        let link: Link;
        try { link = await this.pick(client, from); } catch { return false; };

        if (!this.live.has(client)) return false;

        this.evict(client);
        this.house(link, client);

        const grant = this.grant(link, client);
        if (grant) {
            client.job(this.payload(link, client, grant));
            return true;
        };

        if (from.socket) {
            this.evict(client);
            this.house(from, client);
        };

        return false;
    };

    private reslice(): void {
        const nice = this.links.filter(link => link.slot > 0);
        if (nice.length === 0) return;

        const owned = new Set(nice.map(link => link.slot)), free: number[] = [];
        for (let slot = 0; slot < NICEHASH_SLOTS; slot++) if (!owned.has(slot)) free.push(slot);

        nice.forEach((link, i) => { link.extra = this.expand ? free.filter((_, k) => k % nice.length === i) : []; });
    };

    private narrow(): void {
        if (!this.expand) return;

        this.expand = false;
        for (const link of this.links) link.extra = [];

        this.log.warn("nicehash expansion disabled, pool validates the slot byte", { shares: this.stray_shares, rejects: this.stray_rejects });
    };

    private rebalance(): void {
        const now = Date.now();

        for (const link of [...this.links]) {
            if (link.clients.size === 0) {
                const last = this.links.length === 1;
                const idle = last ? (this.options.idleTimeout ?? IDLE_POOL_MS) : IDLE_LINK_MS;

                if (!link.idle_at)
                    link.idle_at = now;
                else if (now - link.idle_at > idle) {
                    if (last) this.log.info("no miners, disconnecting upstream", { pool: this.pool, idle: `${Math.round((now - link.idle_at) / 1000)}s` });
                    link.socket?.close();
                };

                continue;
            };

            link.idle_at = 0;

            let excess = -link.headroom();
            if (excess <= 0) continue;

            for (const client of [...link.clients]) {
                if (excess <= 0) break;

                excess -= rateOf(client);
                this.migrate(link, client).catch(() => { });
            };
        };

        this.consolidate();
    };

    private consolidate(): void {
        if (this.links.length < 2) return;

        const staffed = this.links.filter(link => link.job && link.clients.size > 0);
        if (staffed.length < 2) return;

        const supply = staffed.reduce((total, link) => total + link.capacity() * SAFETY, 0);
        const demand = staffed.reduce((total, link) => total + link.load, 0);

        const victim = staffed.reduce((least, link) => link.load < least.load ? link : least);
        if (supply - victim.capacity() * SAFETY < demand * 1.2) return;

        this.log.debug("consolidating link", { links: this.links.length, moving: victim.clients.size, supply: Math.round(supply), demand: Math.round(demand) });
        for (const client of [...victim.clients]) this.migrate(victim, client).catch(() => { });
    };
};

export class UpstreamRegistry {
    private pools: Map<string, Upstream> = new Map();

    constructor(private options: UpstreamOptions) { };

    public get(pool: string, address: string, pass: string, proxy?: string): Upstream {
        const key = `${pool}|${address}|${pass}|${proxy ?? ""}`;
        const known = this.pools.get(key);

        if (known) return known;

        const upstream = new Upstream(pool, address, pass, { ...this.options, proxy }, () => {
            if (this.pools.get(key) !== upstream) return;

            this.pools.delete(key);
            upstream.close();
        });

        this.pools.set(key, upstream);
        return upstream;
    };

    public all(): Upstream[] {
        return [...this.pools.values()];
    };

    public close(): void {
        for (const upstream of this.pools.values()) upstream.close();
        this.pools.clear();
    };
};