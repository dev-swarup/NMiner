import { Ledger } from "./nonce.js";
import { StratumJob } from "./connect.js";
import { Channel, workerLink } from "./fleet.js";
import { LogLike, Logger, asLogger } from "./logger.js";
import { VarDiff, hashValue, meetsValue, valueDifficulty, targetDifficulty } from "./vardiff.js";
import { Upstream, UpstreamClient, UpstreamOptions, UpstreamRegistry } from "./upstream.js";

export interface Session {
    id: number;
    peer?: string;
    push(job: any): void;
    kill(message: string): void;
};

export interface Backend {
    close(session: Session): void;
    chunk(session: Session, job_id: string, hashrate?: number): Promise<any>;
    login(session: Session, address: string, pass: string, threads?: number): Promise<any>;
    submit(session: Session, job_id: string, nonce: string, result: string): Promise<any>;
    account?(session: Session, shares: number, work: number, actual: number): void;
};

let sequence = 0;
export const nextSession = (): number => ++sequence;

export async function invoke(backend: Backend, session: Session, method: string, params: any, logged: boolean): Promise<any> {
    switch (method) {
        case "login": return { id: 0, job: await backend.login(session, params[0], params[1], params[2]) };
        case "submit": if (!logged) throw new Error("Not logged in."); return backend.submit(session, params[0], params[1], params[2]);
        case "get_chunk": if (!logged) throw new Error("Not logged in."); return backend.chunk(session, params?.job_id, params?.hashrate);
        case "keepalived": return { status: "OK" };
    };

    throw new Error(`Unsupported method "${method}".`);
};

export type Credentials = { pool: string, address: string, pass: string, proxy?: string };
export type Resolver = (address: string, pass: string) => Promise<Credentials> | Credentials;
export interface ShareReport {
    accepted: boolean;
    forwarded: boolean;

    address: string;
    target: string;
    height?: number;
    elapsed: number;

    solved: number;
    actual: number;
    difficulty: number;
};

export type ShareSink = (share: ShareReport) => void;

type Entry = { client: UpstreamClient, upstream: Upstream, address: string, peer?: string, vardiff: VarDiff };

export class LocalBackend implements Backend {
    private log: Logger;
    private registry: UpstreamRegistry;
    private entries: Map<Session, Entry> = new Map();

    constructor(private resolve: Resolver, private sink: ShareSink, options: UpstreamOptions) {
        this.log = asLogger(options.log, "share");
        this.registry = new UpstreamRegistry(options);
    };

    public get size(): number { return this.entries.size; };
    public get pools(): Upstream[] { return this.registry.all(); };

    public summary(): { miners: number, hashrate: number } {
        let hashrate = 0;
        for (const entry of this.entries.values()) hashrate += entry.vardiff.hashrate;

        return { miners: this.entries.size, hashrate };
    };

    public async login(session: Session, address: string, pass: string, threads?: number): Promise<StratumJob> {
        this.close(session);

        const target = await this.resolve(address, pass);
        const upstream = this.registry.get(target.pool, target.address, target.pass, target.proxy);
        const vardiff = new VarDiff((typeof threads === "number" && threads > 0 ? threads : 1) * 1000);

        const client: UpstreamClient = {
            hashrate: vardiff.hashrate,
            job: payload => session.push(payload),
            drop: message => session.kill(message),
            target: pool => vardiff.tune(pool)
        };

        const entry: Entry = { client, upstream, address, peer: session.peer, vardiff };
        this.entries.set(session, entry);

        try {
            const job = await upstream.attach(client);

            if (this.entries.get(session) !== entry) throw new Error("Superseded by a newer login.");
            return job;
        } catch (err) {
            if (this.entries.get(session) === entry) this.entries.delete(session);

            upstream.detach(client);
            throw err;
        };
    };

    public async chunk(session: Session, job_id: string, hashrate?: number): Promise<any> {
        const entry = this.entries.get(session);
        if (!entry) throw new Error("Not logged in.");

        if (typeof hashrate === "number" && hashrate > 0) {
            entry.vardiff.observe(hashrate);
            entry.upstream.report(entry.client, hashrate);
        };

        const reply = await entry.upstream.chunk(entry.client, job_id);
        if (!("start_nonce" in reply)) return reply;

        const job = entry.upstream.jobOf(entry.client);
        if (!job) return reply;

        const before = entry.vardiff.target;
        return entry.vardiff.tune(job.target) === before ? reply : { ...job, ...reply, target: entry.vardiff.target, pool_target: job.target };
    };

    public async submit(session: Session, job_id: string, nonce: string, result: string): Promise<any> {
        const entry = this.entries.get(session);
        if (!entry) throw new Error("Not logged in.");

        const deny: (reason: string) => never = reason => {
            this.log.warn("share denied", { address: entry.address, session: session.id, reason });
            throw new Error(reason);
        };

        const job = entry.upstream.jobOf(entry.client), started = Date.now();
        if (!job) deny("No active job.");

        const claimed = Buffer.from(nonce, "hex");
        if (claimed.length < 4) deny("Malformed nonce.");

        if (!entry.upstream.owns(entry.client, claimed.readUInt32LE(0))) deny("Nonce outside your assigned range.");

        const issue = entry.vardiff.floor(), value = hashValue(result);
        if (!meetsValue(value, issue.target)) deny("Share is below your assigned difficulty.");

        const settled = issue.target === entry.vardiff.target || meetsValue(value, entry.vardiff.target);
        if (settled) entry.vardiff.settle();

        const difficulty = settled && entry.vardiff.difficulty > issue.difficulty ? entry.vardiff.difficulty : issue.difficulty;

        entry.vardiff.submitted(difficulty);
        if (!entry.vardiff.told) entry.upstream.report(entry.client, entry.vardiff.hashrate);

        const report = { address: entry.address, target: job.target, height: job.height, elapsed: started, difficulty, actual: valueDifficulty(value) };

        if (!meetsValue(value, job.target)) {
            this.sink({ ...report, accepted: true, forwarded: false, solved: 0 });
            return { status: "OK" };
        };

        const pool = targetDifficulty(job.target);

        try {
            const reply = await entry.upstream.submit(entry.client, job_id, nonce, result);
            const accepted = LocalBackend.accepted(reply);

            if (accepted) entry.vardiff.credit(pool);
            this.sink({ ...report, accepted, forwarded: true, solved: accepted ? pool : 0 });

            return reply;
        } catch (err) {
            this.sink({ ...report, accepted: false, forwarded: true, solved: 0 });
            throw err;
        };
    };

    public account(session: Session, shares: number, work: number, actual: number): void {
        const entry = this.entries.get(session);
        if (!entry || !(shares > 0)) return;

        const job = entry.upstream.jobOf(entry.client);
        const difficulty = Math.round(work / shares);
        const report: ShareReport = { address: entry.address, target: job?.target ?? entry.vardiff.target, height: job?.height, elapsed: Date.now(), difficulty, actual: Math.round(actual / shares), accepted: true, forwarded: false, solved: 0 };

        entry.vardiff.submitted(difficulty, shares);
        for (let i = 0; i < shares; i++) this.sink(report);

        if (!entry.vardiff.told) entry.upstream.report(entry.client, entry.vardiff.hashrate);
    };

    public reset(message: string): void {
        for (const session of [...this.entries.keys()]) {
            this.close(session);
            session.kill(message);
        };
    };

    public close(session: Session): void {
        const entry = this.entries.get(session);
        if (!entry) return;

        this.entries.delete(session);
        entry.upstream.detach(entry.client);
    };

    public shutdown(): void {
        this.entries.clear();
        this.registry.close();
    };

    public accounting(): Array<{ address: string, peer: string, hashrate: number, difficulty: number, shares: number, work: number, solved: number }> {
        return [...this.entries.values()].map(entry => ({ address: entry.address, peer: entry.peer ?? "-", hashrate: Math.round(entry.vardiff.hashrate), difficulty: entry.vardiff.difficulty, shares: entry.vardiff.accepted, work: entry.vardiff.work, solved: entry.vardiff.solved }));
    };

    private static accepted(result: any): boolean {
        if (result === "OK") return true;
        if (typeof result === "string") return result.includes("OK");

        return typeof result === "object" && result !== null && result.status === "OK";
    };
};

const ACCOUNT_MS = 5000;
const CALL_TIMEOUT = 45000;
const EXPIRE_EVERY = 5000;

type Tally = { shares: number, work: number, actual: number };
type Known = { job_id: string, pool: string, target: string, prior: string, diff: number, older: number, ledger: Ledger };

export class WorkerBackend implements Backend {
    private seq: number = 1;
    private log: Logger;
    private link = workerLink();
    private flusher?: NodeJS.Timeout;
    private expirer?: NodeJS.Timeout;
    private jobs: Map<number, Known> = new Map();
    private tallies: Map<number, Tally> = new Map();
    private sessions: Map<number, Session> = new Map();
    private pending: Map<number, { resolve: Function, reject: Function, deadline: number }> = new Map();

    constructor(log?: LogLike) {
        this.log = asLogger(log, "share");

        this.link.on((raw: any) => {
            if (!raw || typeof raw.t !== "string") return;

            if (raw.t === "r") {
                const call = this.pending.get(raw.i);
                if (!call) return;

                this.pending.delete(raw.i);

                if (raw.e)
                    call.reject(new Error(raw.e));
                else {
                    this.learn(raw.c, raw.d);
                    call.resolve(raw.d);
                };

                return;
            };

            const session = this.sessions.get(raw.c);
            if (!session) return;

            if (raw.t === "j") {
                this.learn(raw.c, raw.d);
                session.push(raw.d);
            } else if (raw.t === "k")
                session.kill(raw.e || "Disconnected by proxy.");
        });

        process.on("disconnect", () => {
            for (const call of this.pending.values()) call.reject(new Error("Proxy primary disconnected."));
            this.pending.clear();
        });
    };

    public login(session: Session, address: string, pass: string, threads?: number): Promise<any> {
        this.sessions.set(session.id, session);
        return this.call(session, "login", { a: address, p: pass, k: threads, w: session.peer });
    };

    public chunk(session: Session, job_id: string, hashrate?: number): Promise<any> {
        return this.call(session, "chunk", { j: job_id, h: hashrate });
    };

    public async submit(session: Session, job_id: string, nonce: string, result: string): Promise<any> {
        const known = this.jobs.get(session.id);
        const claimed = Buffer.from(nonce, "hex");

        if (!known || !known.target || !known.pool || known.job_id !== job_id || claimed.length < 4 || !known.ledger.owns(claimed.readUInt32LE(0)))
            return this.call(session, "submit", { j: job_id, n: nonce, r: result });

        const floor = known.prior && known.older < known.diff ? { target: known.prior, difficulty: known.older } : { target: known.target, difficulty: known.diff };
        const value = hashValue(result);

        if (!meetsValue(value, floor.target)) {
            this.log.debug("share below assigned difficulty", { session: session.id, job: job_id });
            throw new Error("Share is below your assigned difficulty.");
        };

        const current = meetsValue(value, known.target);
        if (known.prior && current) known.prior = "";

        if (meetsValue(value, known.pool))
            this.link.send({ t: "sub", c: session.id, j: job_id, n: nonce, r: result });
        else
            this.tally(session.id, current && known.diff > floor.difficulty ? known.diff : floor.difficulty, valueDifficulty(value));

        return { status: "OK" };
    };

    private tally(id: number, difficulty: number, actual: number): void {
        let sum = this.tallies.get(id);
        if (!sum) this.tallies.set(id, sum = { shares: 0, work: 0, actual: 0 });

        sum.shares++;
        sum.work += difficulty;
        sum.actual += actual;

        if (this.flusher) return;

        this.flusher = setTimeout(() => this.flush(), ACCOUNT_MS);
        this.flusher.unref?.();
    };

    private flush(): void {
        if (this.flusher) clearTimeout(this.flusher);
        this.flusher = undefined;

        if (!this.tallies.size) return;

        const d = [...this.tallies].map(([id, sum]) => [id, sum.shares, sum.work, sum.actual]);

        this.tallies.clear();
        this.link.send({ t: "acc", d });
    };

    private learn(id: number, payload: any): void {
        if (!payload || typeof payload !== "object") return;

        let known = this.jobs.get(id);
        if (!known) this.jobs.set(id, known = { job_id: "", pool: "", target: "", prior: "", diff: 0, older: 0, ledger: new Ledger() });

        if (typeof payload.blob === "string" && typeof payload.job_id === "string") {
            known.job_id = payload.job_id;
            known.pool = payload.pool_target ?? known.pool;

            if (typeof payload.target === "string" && payload.target !== known.target) {
                known.prior = known.target;
                known.older = known.diff;

                known.target = payload.target;
                known.diff = targetDifficulty(payload.target);
            };
        };

        if (typeof payload.start_nonce === "number" && known.job_id)
            known.ledger.record(known.job_id, { start_nonce: payload.start_nonce, nonce_limit: payload.nonce_limit ?? 0xFFFFFFFF });
    };

    public close(session: Session): void {
        if (this.tallies.has(session.id)) this.flush();

        this.jobs.delete(session.id);
        this.sessions.delete(session.id);

        this.link.send({ t: "bye", c: session.id });
    };

    private call(session: Session, t: string, payload: any): Promise<any> {
        if (!process.connected) return Promise.reject(new Error("Proxy primary disconnected."));

        return new Promise((resolve, reject) => {
            const i = this.seq++;

            this.pending.set(i, { resolve, reject, deadline: Date.now() + CALL_TIMEOUT });
            this.link.send({ t, c: session.id, i, ...payload });

            if (this.expirer) return;

            this.expirer = setInterval(() => this.expire(), EXPIRE_EVERY);
            this.expirer.unref?.();
        });
    };

    private expire(): void {
        const now = Date.now();

        for (const [i, call] of this.pending) {
            if (call.deadline > now) continue;

            this.pending.delete(i);
            call.reject(new Error("Proxy primary did not answer in time."));
        };

        if (this.pending.size || !this.expirer) return;

        clearInterval(this.expirer);
        this.expirer = undefined;
    };
};

export class PrimaryHub {
    private channels: Map<number, Map<number, Session>> = new Map();

    constructor(private backend: Backend) { };

    public message(channel: Channel, raw: any): void { this.handle(channel, raw).catch(() => { }); };

    public evict(id: number): void {
        const sessions = this.channels.get(id);
        if (!sessions) return;

        this.channels.delete(id);
        for (const session of sessions.values()) this.backend.close(session);
    };

    private async handle(channel: Channel, raw: any): Promise<void> {
        if (!raw || typeof raw.t !== "string") return;

        let sessions = this.channels.get(channel.id);

        if (raw.t === "acc") {
            if (!Array.isArray(raw.d) || !sessions || !this.backend.account) return;

            for (const [id, shares, work, actual] of raw.d) {
                const session = sessions.get(id);
                if (session) this.backend.account(session, shares, work, actual);
            };

            return;
        };

        if (typeof raw.c !== "number") return;

        if (raw.t === "bye") {
            const session = sessions?.get(raw.c);
            if (!session) return;

            sessions!.delete(raw.c);
            this.backend.close(session);

            return;
        };

        if (raw.t === "sub") {
            const session = sessions?.get(raw.c);
            if (session) await this.backend.submit(session, raw.j, raw.n, raw.r);

            return;
        };

        if (!sessions) this.channels.set(channel.id, sessions = new Map());

        let session = sessions.get(raw.c);
        if (!session) {
            const id = raw.c;

            session = {
                id,
                push: job => channel.send({ t: "j", c: id, d: job }),
                kill: message => channel.send({ t: "k", c: id, e: message })
            };

            sessions.set(raw.c, session);
        };

        if (typeof raw.w === "string") session.peer = raw.w;

        try {
            const d = raw.t === "login" ? await this.backend.login(session, raw.a, raw.p, raw.k) : raw.t === "chunk" ? await this.backend.chunk(session, raw.j, raw.h) : raw.t === "submit" ? await this.backend.submit(session, raw.j, raw.n, raw.r) : null;

            channel.send({ t: "r", c: raw.c, i: raw.i, d });
        } catch (err) {
            channel.send({ t: "r", c: raw.c, i: raw.i, e: err instanceof Error ? err.message : String(err) });
        };
    };
};