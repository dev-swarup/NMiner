import { StratumJob } from "./connect.js";
import { Logger, asLogger } from "./logger.js";
import { Channel, workerLink } from "./fleet.js";
import { VarDiff, hashValue, meetsValue, valueDifficulty, targetDifficulty } from "./vardiff.js";
import { Verifier, VerifierOptions, VERIFY_MATCHED, VERIFY_SKIPPED } from "./verifier.js";
import { Upstream, UpstreamClient, UpstreamOptions, UpstreamRegistry } from "./upstream.js";

export interface Session {
    id: number;
    push(job: any): void;
    kill(message: string): void;
};

export interface Backend {
    close(session: Session): void;
    chunk(session: Session, job_id: string, hashrate?: number): Promise<any>;
    login(session: Session, address: string, pass: string, threads?: number): Promise<any>;
    submit(session: Session, job_id: string, nonce: string, result: string): Promise<any>;
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

type Entry = { client: UpstreamClient, upstream: Upstream, address: string, vardiff: VarDiff };

export class LocalBackend implements Backend {
    private log: Logger;
    private verifier: Verifier | null;
    private registry: UpstreamRegistry;
    private entries: Map<Session, Entry> = new Map();

    constructor(private resolve: Resolver, private sink: ShareSink, options: UpstreamOptions, verify?: VerifierOptions | false) {
        this.log = asLogger(options.log, "share");
        this.registry = new UpstreamRegistry(options);
        this.verifier = verify === false || verify === undefined ? null : new Verifier(verify);
    };

    public get pools(): Upstream[] { return this.registry.all(); };
    public get verifying(): boolean { return this.verifier !== null && this.verifier.ready; };

    public async login(session: Session, address: string, pass: string, threads?: number): Promise<StratumJob> {
        this.close(session);

        const target = await this.resolve(address, pass);
        const upstream = this.registry.get(target.pool, target.address, target.pass, target.proxy);
        const vardiff = new VarDiff((typeof threads === "number" && threads > 0 ? threads : 1) * 1000);

        const client: UpstreamClient = {
            hashrate: vardiff.hashrate,
            job: payload => {
                if (payload.seed_hash) this.verifier?.sync(payload.seed_hash);
                session.push(payload);
            },
            drop: message => session.kill(message),
            target: pool => vardiff.tune(pool)
        };

        const entry: Entry = { client, upstream, address, vardiff };
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

        if (typeof hashrate === "number") entry.upstream.report(entry.client, hashrate);
        return entry.upstream.chunk(entry.client, job_id);
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

        const flags = this.verifier ? await this.verifier.check(job.blob, nonce, result, issue.target, job.target, job.seed_hash) : VERIFY_SKIPPED;
        if (!(flags & VERIFY_SKIPPED) && !(flags & VERIFY_MATCHED)) deny("Share does not hash to the submitted result.");

        if (!meetsValue(value, issue.target)) deny("Share is below your assigned difficulty.");

        if (issue.target === entry.vardiff.target || meetsValue(value, entry.vardiff.target)) entry.vardiff.settle();

        entry.vardiff.submitted(issue.difficulty);
        entry.upstream.report(entry.client, entry.vardiff.hashrate);

        const report = { address: entry.address, target: job.target, height: job.height, elapsed: started, difficulty: issue.difficulty, actual: valueDifficulty(value) };

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

        this.verifier?.stop();
    };

    public accounting(): Array<{ address: string, hashrate: number, difficulty: number, shares: number, work: number, solved: number }> {
        return [...this.entries.values()].map(entry => ({ address: entry.address, hashrate: Math.round(entry.vardiff.hashrate), difficulty: entry.vardiff.difficulty, shares: entry.vardiff.accepted, work: entry.vardiff.work, solved: entry.vardiff.solved }));
    };

    private static accepted(result: any): boolean {
        if (result === "OK") return true;
        if (typeof result === "string") return result.includes("OK");

        return typeof result === "object" && result !== null && result.status === "OK";
    };
};

export class WorkerBackend implements Backend {
    private seq: number = 1;
    private link = workerLink();
    private sessions: Map<number, Session> = new Map();
    private pending: Map<number, { resolve: Function, reject: Function, timeout: NodeJS.Timeout }> = new Map();

    constructor() {
        this.link.on((raw: any) => {
            if (!raw || typeof raw.t !== "string") return;

            if (raw.t === "r") {
                const call = this.pending.get(raw.i);
                if (!call) return;

                this.pending.delete(raw.i);
                clearTimeout(call.timeout);

                if (raw.e)
                    call.reject(new Error(raw.e));
                else call.resolve(raw.d);

                return;
            };

            const session = this.sessions.get(raw.c);
            if (!session) return;

            if (raw.t === "j")
                session.push(raw.d);
            else if (raw.t === "k")
                session.kill(raw.e || "Disconnected by proxy.");
        });

        process.on("disconnect", () => {
            for (const call of this.pending.values()) {
                clearTimeout(call.timeout);
                call.reject(new Error("Proxy primary disconnected."));
            };

            this.pending.clear();
        });
    };

    public login(session: Session, address: string, pass: string, threads?: number): Promise<any> {
        this.sessions.set(session.id, session);
        return this.call(session, "login", { a: address, p: pass, k: threads });
    };

    public chunk(session: Session, job_id: string, hashrate?: number): Promise<any> {
        return this.call(session, "chunk", { j: job_id, h: hashrate });
    };

    public submit(session: Session, job_id: string, nonce: string, result: string): Promise<any> {
        return this.call(session, "submit", { j: job_id, n: nonce, r: result });
    };

    public close(session: Session): void {
        this.sessions.delete(session.id);
        this.link.send({ t: "bye", c: session.id });
    };

    private call(session: Session, t: string, payload: any): Promise<any> {
        if (!process.connected) return Promise.reject(new Error("Proxy primary disconnected."));

        return new Promise((resolve, reject) => {
            const i = this.seq++, timeout = setTimeout(() => {
                if (this.pending.delete(i)) reject(new Error("Proxy primary did not answer in time."));
            }, 45000);

            this.pending.set(i, { resolve, reject, timeout });
            this.link.send({ t, c: session.id, i, ...payload });
        });
    };
};

export class PrimaryHub {
    private sessions: Map<string, Session> = new Map();

    constructor(private backend: Backend) { };

    public message(channel: Channel, raw: any): void { this.handle(channel, raw).catch(() => { }); };

    public evict(id: number): void {
        const prefix = `${id}:`;

        for (const [key, session] of [...this.sessions]) {
            if (!key.startsWith(prefix)) continue;

            this.sessions.delete(key);
            this.backend.close(session);
        };
    };

    private async handle(channel: Channel, raw: any): Promise<void> {
        if (!raw || typeof raw.t !== "string" || typeof raw.c !== "number") return;
        const key = `${channel.id}:${raw.c}`;

        if (raw.t === "bye") {
            const session = this.sessions.get(key);
            if (!session) return;

            this.sessions.delete(key);
            this.backend.close(session);

            return;
        };

        let session = this.sessions.get(key);
        if (!session) {
            const id = raw.c;

            session = {
                id,
                push: job => channel.send({ t: "j", c: id, d: job }),
                kill: message => channel.send({ t: "k", c: id, e: message })
            };

            this.sessions.set(key, session);
        };

        try {
            const d = raw.t === "login" ? await this.backend.login(session, raw.a, raw.p, raw.k) : raw.t === "chunk" ? await this.backend.chunk(session, raw.j, raw.h) : raw.t === "submit" ? await this.backend.submit(session, raw.j, raw.n, raw.r) : null;

            channel.send({ t: "r", c: raw.c, i: raw.i, d });
        } catch (err) {
            channel.send({ t: "r", c: raw.c, i: raw.i, e: err instanceof Error ? err.message : String(err) });
        };
    };
};