import os from "os";
import path from "path";
import cluster from "cluster";
import net, { Socket } from "net";
import { fork, ChildProcess } from "child_process";

import { Entry, Level, LogLike, Logger, asLogger, toLevel } from "./logger.js";

export const WORKER_LOG = "NMINER_PROXY_LOG";
export const WORKER_FLAG = "NMINER_PROXY_WORKER";

const BATCH_LIMIT = 256;
const RESPAWN_MIN = 500;
const RESPAWN_MAX = 15000;
const PENDING_LIMIT = 1024;
const RESPAWN_HEALTHY = 30000;

export const workerLevel = (): Level => toLevel(process.env[WORKER_LOG], "silent");
export const isProxyWorker = (): boolean => process.env[WORKER_FLAG] === "1" && typeof process.send === "function";

export function foreignCluster(): { manager: string, index: number } | null {
    if (isProxyWorker()) return null;

    const instance = Number(process.env.NODE_APP_INSTANCE);
    const indexed = Number.isFinite(instance) ? instance : null;

    if (process.env.pm_id !== undefined && (cluster.isWorker || (indexed !== null && indexed > 0)))
        return {
            manager: "pm2",
            index: indexed ?? (cluster.worker?.id ?? 1) - 1
        };

    if (cluster.isWorker) return { manager: "cluster", index: indexed ?? (cluster.worker?.id ?? 1) - 1 };
    return null;
};

export function autoWorkers(): number {
    const cores = os.cpus().length;
    return cores <= 2 ? 0 : Math.max(1, Math.min(cores - 2, 8));
};

export interface Channel {
    id: number;
    alive: boolean;
    send(message: any): void;
};

export class FleetChild implements Channel {
    public load: number = 0;
    public readonly started: number = Date.now();

    private queue: any[] = [];
    private flushing: boolean = false;

    constructor(public readonly id: number, public readonly proc: ChildProcess) { };

    public get alive(): boolean { return this.proc.connected && !this.proc.killed; };

    public send(message: any): void {
        if (!this.alive) return;

        this.queue.push(message);

        if (this.queue.length >= BATCH_LIMIT) return this.flush();
        if (this.flushing) return;

        this.flushing = true;
        setImmediate(this.pump);
    };

    private pump = (): void => {
        this.flushing = false;
        this.flush();
    };

    public hand(socket: Socket): boolean {
        if (!this.alive) return false;

        this.load++;
        this.proc.send({ t: "conn" }, socket, (err: Error | null) => { if (err) { this.load = Math.max(0, this.load - 1); socket.destroy(); }; });

        return true;
    };

    public flush(): void {
        if (this.queue.length === 0) return;

        const batch = this.queue;
        this.queue = [];

        if (this.alive) this.proc.send(batch.length === 1 ? batch[0] : { t: "batch", b: batch }, () => { });
    };
};

export class Fleet {
    private pending: Socket[] = [];
    private roster: FleetChild[] = [];
    private children: Map<number, FleetChild> = new Map();

    private backoff: number = RESPAWN_MIN;
    private sequence: number = 0;
    private stopping: boolean = false;

    private log: Logger;
    private server?: net.Server;
    private greetings: Array<() => any> = [];

    constructor(private size: number, log: LogLike, private onMessage: (child: FleetChild, raw: any) => void, private onExit: (child: FleetChild) => void) {
        this.log = asLogger(log, "fleet");
        for (let i = 0; i < size; i++) this.spawn();
    };

    public get alive(): number { let live = 0; for (const child of this.roster) if (child.alive) live++; return live; };
    public all(): FleetChild[] { return this.roster; };
    public stats(): Array<{ id: number, load: number, uptime: number }> { return this.roster.map(child => ({ id: child.id, load: child.load, uptime: Date.now() - child.started })); };

    public listen(port: number): void {
        this.server = net.createServer({ pauseOnConnect: true }, socket => this.dispatch(socket));

        this.server.on("error", err => this.log.error(err, { port }));
        this.server.listen(port, "0.0.0.0", () => this.log.info("listening", { port, workers: this.size, upstream: "primary" }));
    };

    public greet(build: () => any): void {
        this.greetings.push(build);

        const hello = build();
        if (hello) for (const child of this.roster) child.send(hello);
    };

    public dispatch(socket: Socket): void {
        let pick: FleetChild | null = null;
        for (const child of this.roster) if (child.alive && (!pick || child.load < pick.load)) pick = child;

        if (pick && pick.hand(socket)) return;
        if (this.pending.length >= PENDING_LIMIT) return void socket.destroy();

        this.pending.push(socket);
        socket.once("close", () => { const at = this.pending.indexOf(socket); if (at >= 0) this.pending.splice(at, 1); });
    };

    public stop(): void {
        this.stopping = true;
        this.server?.close();

        for (const socket of this.pending.splice(0)) socket.destroy();
        for (const child of this.roster) { if (child.proc.connected) child.proc.disconnect(); child.proc.kill(); };

        this.roster = [];
        this.children.clear();
    };

    private spawn(): void {
        const id = ++this.sequence;
        const proc = fork(path.join(__dirname, "worker.js"), [], { env: { ...process.env, [WORKER_FLAG]: "1", [WORKER_LOG]: this.log.level }, stdio: ["ignore", "inherit", "inherit", "ipc"] });
        const child = new FleetChild(id, proc);

        this.children.set(id, child);
        this.roster = [...this.children.values()];

        this.log.debug("worker spawned", { worker: id, pid: proc.pid });

        proc.on("error", () => { });
        proc.on("message", raw => this.deliver(child, raw));

        proc.on("exit", () => {
            this.children.delete(id);
            this.roster = [...this.children.values()];

            this.onExit(child);

            if (this.stopping) return;
            if (Date.now() - child.started >= RESPAWN_HEALTHY) this.backoff = RESPAWN_MIN;

            this.log.warn("worker exited", { worker: id, uptime: `${Math.round((Date.now() - child.started) / 1000)}s`, respawn: `${this.backoff}ms` });

            setTimeout(() => { if (!this.stopping) this.spawn(); }, this.backoff).unref();
            this.backoff = Math.min(RESPAWN_MAX, this.backoff * 2);
        });

        for (const build of this.greetings) { const hello = build(); if (hello) child.send(hello); };
        for (const socket of this.pending.splice(0)) child.hand(socket);
    };

    private deliver(child: FleetChild, raw: any): void {
        if (!raw || typeof raw.t !== "string") return;

        if (raw.t === "on") { child.load++; return; };
        if (raw.t === "off") { child.load = Math.max(0, child.load - 1); return; };
        if (raw.t === "log") {
            const entry = raw.e as Entry;
            if (entry) this.log.emit({ ...entry, fields: { ...entry.fields, worker: child.id } }); return;
        };
        if (raw.t === "batch") { if (Array.isArray(raw.b)) for (const message of raw.b) this.deliver(child, message); return; };

        this.onMessage(child, raw);
    };
};

export class WorkerLink {
    private queue: any[] = [];
    private flushing: boolean = false;
    private handlers: Array<(raw: any, handle?: any) => void> = [];

    constructor() {
        process.on("message", (raw: any, handle: any) => this.deliver(raw, handle));
        process.on("disconnect", () => setTimeout(() => process.exit(0), 1000).unref());
    };

    public on(handler: (raw: any, handle?: any) => void): void { this.handlers.push(handler); };

    public send(message: any): void {
        if (!process.connected) return;

        this.queue.push(message);

        if (this.queue.length >= BATCH_LIMIT) return this.flush();
        if (this.flushing) return;

        this.flushing = true;
        setImmediate(this.pump);
    };

    private pump = (): void => {
        this.flushing = false;
        this.flush();
    };

    private flush(): void {
        if (this.queue.length === 0) return;

        const batch = this.queue;
        this.queue = [];

        if (process.connected) process.send!(batch.length === 1 ? batch[0] : { t: "batch", b: batch }, () => { });
    };

    private deliver(raw: any, handle?: any): void {
        if (raw && raw.t === "batch" && Array.isArray(raw.b)) { for (const message of raw.b) this.deliver(message); return; };
        for (const handler of this.handlers) handler(raw, handle);
    };
};

let link: WorkerLink | null = null;
export const workerLink = (): WorkerLink => link ??= new WorkerLink();