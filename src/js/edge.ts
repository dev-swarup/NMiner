import http from "http";
import dgram from "dgram";
import type { Socket } from "net";
import { WebSocketServer, WebSocket } from "ws";

import * as crypto from "./crypto.js";
import { LogLike, Logger, asLogger } from "./logger.js";
import { Backend, Session, invoke, nextSession } from "./hub.js";
import { Datagram, HELLO, WELCOME, RESET, MAX_PAYLOAD, PEER_TIMEOUT } from "./udp.js";

export const MINER_TIMEOUT = 5 * 60000;

export interface EdgeOptions {
    log?: LogLike;
    port?: number;
};

export class Edge {
    private server: http.Server;
    private wss: WebSocketServer;
    private log: Logger;

    constructor(private backend: Backend, private options: EdgeOptions = {}) {
        this.log = asLogger(options.log, "net");

        this.server = http.createServer((req, res) => {
            res.writeHead(404);
            res.end();
        });

        this.wss = new WebSocketServer({ noServer: true });

        this.server.on("upgrade", (req, socket, head) => {
            const publicHash = req.headers["x-salt"];

            if (!publicHash || typeof publicHash !== "string" || publicHash.length < 64) {
                socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
                socket.destroy();

                return;
            };

            let privateHash: string, session: Buffer; try {
                ({ salt: privateHash, session } = crypto.generateHandshake(publicHash as any));
            } catch {
                socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
                socket.destroy();

                return;
            };

            (req as any).session = session;
            (req as any).privateHash = privateHash;

            this.wss.handleUpgrade(req, socket, head, ws => this.wss.emit("connection", ws, req));
        });

        this.wss.on("headers", (headers, req) => {
            if ((req as any).privateHash) headers.push(`x-salt: ${(req as any).privateHash}`);
        });

        this.wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => this.serve(ws, req));

        this.server.on("error", err => this.log.error(err, { port: this.options.port }));
    };

    public listen(): void {
        this.server.listen(this.options.port, "0.0.0.0", () => this.log.info("listening", { port: this.options.port, transport: "ws" }));
    };

    public accept(socket: Socket): void {
        this.server.emit("connection", socket);
        socket.resume();
    };

    public close(): void {
        this.wss.close();
        this.server.close();
    };

    private serve(ws: WebSocket, req: http.IncomingMessage): void {
        const secret = (req as any).session as Buffer;
        const ToMiner = (payload: any) => { if (ws.readyState === WebSocket.OPEN) ws.send(crypto.encrypt(secret, payload)); };

        const session: Session = {
            id: nextSession(),
            peer: req.socket.remoteAddress,
            push: job => ToMiner(["job", job]),
            kill: message => { ToMiner(["error", message]); ws.close(); }
        };

        let logged = false;
        let timeout = setTimeout(() => ws.close(), MINER_TIMEOUT);

        const bump = () => {
            clearTimeout(timeout);
            timeout = setTimeout(() => ws.close(), MINER_TIMEOUT);
        };

        this.log.debug("miner connected", { session: session.id, transport: "ws" });

        ws.on("error", () => ws.close());
        ws.on("close", () => {
            clearTimeout(timeout);
            this.backend.close(session);

            this.log.debug("miner disconnected", { session: session.id, transport: "ws" });
        });

        ws.on("message", async (data: Buffer) => {
            let id: any = null;
            bump();

            try {
                const [rpc, method, params] = crypto.decrypt(secret, data.toString());
                id = rpc;

                const result = await invoke(this.backend, session, method, params, logged);
                if (method === "login") logged = true;

                ToMiner([id, null, result]);
            } catch (err: any) {
                const message = err instanceof Error ? err.message : String(err);
                this.log.debug("call failed", { session: session.id, error: message });

                if (id !== null) ToMiner([id, message, null]);
                if (!logged) ws.close();
            };
        });
    };
};

interface Peer {
    key: string;
    seen: number;
    salt: string;
    link: Datagram;
    secret: Buffer;
    welcome: string;
    logged: boolean;
    session: Session;
};

export interface UdpEdgeOptions {
    log?: LogLike;
    left?: (key: string) => void;
    joined?: (key: string) => void;
    dropped?: (key: string) => void;
};

export class UdpEdge {
    private log: Logger;
    private peers: Map<string, Peer> = new Map();
    private sweeper: NodeJS.Timeout;

    constructor(private backend: Backend, private write: (key: string, text: string) => void, private options: UdpEdgeOptions = {}) {
        this.log = asLogger(options.log, "udp");

        this.sweeper = setInterval(() => this.sweep(), 30000);
        this.sweeper.unref?.();
    };

    public get size(): number { return this.peers.size; };

    public receive(key: string, text: string): void {
        if (!text) return;
        if (text[0] === RESET) return this.drop(key);
        if (text[0] === HELLO) return this.greet(key, text.slice(1));

        const peer = this.peers.get(key);
        if (!peer) { this.write(key, RESET); return this.drop(key); };

        peer.seen = Date.now();
        peer.link.receive(text);
    };

    public drop(key: string): void { this.discard(key, true); };

    private discard(key: string, notify: boolean): void {
        if (notify) this.options.dropped?.(key);

        const peer = this.peers.get(key);
        if (!peer) return;

        this.peers.delete(key);
        this.options.left?.(key);

        peer.link.stop();
        this.backend.close(peer.session);

        this.log.debug("peer dropped", { session: peer.session.id, peer: key });
    };

    public close(): void {
        clearInterval(this.sweeper);
        for (const key of [...this.peers.keys()]) this.drop(key);
    };

    private greet(key: string, salt: string): void {
        if (salt.length < 64) return;

        const known = this.peers.get(key); if (known && known.salt === salt) {
            known.seen = Date.now();
            return this.write(key, WELCOME + known.welcome);
        };

        let privateHash: string, secret: Buffer; try {
            ({ salt: privateHash, session: secret } = crypto.generateHandshake(Buffer.from(salt, "hex") as any));
        } catch { return; };

        this.discard(key, false);

        const peer: Peer = { key, salt, secret, welcome: privateHash, logged: false, seen: Date.now() } as Peer;

        peer.link = new Datagram(text => this.write(key, text), payload => this.handle(peer, payload), () => this.drop(key));
        peer.session = {
            id: nextSession(),
            peer: key.slice(0, key.lastIndexOf(":")),
            push: job => this.deliver(peer, ["job", job]),
            kill: message => { this.deliver(peer, ["error", message]); setTimeout(() => this.drop(key), 1500).unref?.(); }
        };

        this.peers.set(key, peer);
        this.options.joined?.(key);

        this.write(key, WELCOME + privateHash);

        this.log.debug("peer connected", { session: peer.session.id, peer: key });
    };

    private deliver(peer: Peer, payload: any): void {
        const text = crypto.encrypt(peer.secret, payload);

        if (text.length > MAX_PAYLOAD)
            return this.log.warn("payload too large, dropped", { peer: peer.key, bytes: text.length, limit: MAX_PAYLOAD });

        peer.link.send(text);
    };

    private async handle(peer: Peer, payload: string): Promise<void> {
        let id: any = null;

        try {
            const [rpc, method, params] = crypto.decrypt(peer.secret, payload);
            id = rpc;

            const result = await invoke(this.backend, peer.session, method, params, peer.logged);
            if (method === "login") peer.logged = true;

            this.deliver(peer, [id, null, result]);
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            this.log.debug("call failed", { session: peer.session.id, error: message });

            if (id !== null) this.deliver(peer, [id, message, null]);
            if (!peer.logged) this.drop(peer.key);
        };
    };

    private sweep(): void {
        const cutoff = Date.now() - PEER_TIMEOUT;
        for (const [key, peer] of [...this.peers]) if (peer.seen < cutoff) this.drop(key);
    };
};

export interface UdpTarget {
    id: number;
    load: number;
    alive: boolean;
    send(message: any): void;
};

export interface UdpRouterOptions extends UdpEdgeOptions {
    reusePort?: boolean;
};

export function probeReusePort(port: number): Promise<boolean> {
    const open = () => new Promise<dgram.Socket | null>(resolve => {
        let socket: dgram.Socket;
        try { socket = dgram.createSocket({ type: "udp4", reusePort: true } as any); } catch { return resolve(null); };

        socket.once("error", () => resolve(null));
        try { socket.bind(port, "0.0.0.0", () => resolve(socket)); } catch { resolve(null); };
    });

    return open().then(async first => {
        if (!first) return false;

        const second = await open();

        try { first.close(); } catch { };
        try { second?.close(); } catch { };

        return second !== null;
    });
};

export class UdpRouter {
    private log: Logger;
    private edge?: UdpEdge;
    private socket: dgram.Socket;
    private routes: Map<string, number> = new Map();

    constructor(private port: number, private options: UdpRouterOptions = {}, private pool?: () => UdpTarget[], backend?: Backend) {
        this.log = asLogger(options.log, "udp");
        this.socket = dgram.createSocket({ type: "udp4", reuseAddr: !options.reusePort, reusePort: options.reusePort === true } as any);

        if (!this.pool && backend) this.edge = new UdpEdge(backend, (key, text) => this.write(key, text), options);

        this.socket.on("error", err => this.log.error(err, { port: this.port }));
        this.socket.on("message", (buf, rinfo) => this.inbound(`${rinfo.address}:${rinfo.port}`, buf.toString("utf8")));
    };

    public listen(): void {
        const shared = this.options.reusePort === true;
        this.socket.bind(this.port, "0.0.0.0", () => this.log[shared ? "debug" : "info"]("listening", { port: this.port, transport: "udp" }));
    };

    public write(key: string, text: string): void {
        const at = key.lastIndexOf(":");
        if (at < 0) return;

        this.socket.send(text, Number(key.slice(at + 1)), key.slice(0, at), () => { });
    };

    public forget(key: string): void {
        const id = this.routes.get(key);
        if (id === undefined) return;

        this.routes.delete(key);

        const target = this.pool?.().find(entry => entry.id === id);
        if (target) target.load = Math.max(0, target.load - 1);
    };

    public evict(id: number): void {
        for (const [key, owner] of [...this.routes]) if (owner === id) this.routes.delete(key);
    };

    public close(): void {
        this.edge?.close();
        try { this.socket.close(); } catch { };
    };

    private inbound(key: string, text: string): void {
        if (this.edge) return this.edge.receive(key, text);

        const target = this.pick(key);
        if (!target) return void this.write(key, RESET);

        target.send({ t: "u", k: key, d: text });
    };

    private pick(key: string): UdpTarget | null {
        const targets = this.pool!();
        const owner = this.routes.get(key);

        if (owner !== undefined) {
            const held = targets.find(target => target.id === owner && target.alive);
            if (held) return held;

            this.routes.delete(key);
        };

        let pick: UdpTarget | null = null;
        for (const target of targets) if (target.alive && (!pick || target.load < pick.load)) pick = target;

        if (pick) {
            this.routes.set(key, pick.id);
            pick.load++;

            this.log.debug("peer routed", { peer: key, worker: pick.id });
        };

        return pick;
    };
};