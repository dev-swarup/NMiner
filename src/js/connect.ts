import dns from "dns";
import net from "net";
import tls from "tls";
import { WebSocket } from "ws";
import { SocksClient } from "socks";

import { version } from "../../package.json";

import { EventEmitter } from "./utils.js";
import { hash, encrypt, decrypt, createExchange } from "./crypto.js";

const _dnsCache = new Map<string, string>();
function ResolveHostname(hostname: string): Promise<string> {
    const cached = _dnsCache.get(hostname);
    if (cached) return Promise.resolve(cached);

    if ((process as any).isBun && (dns as any).lookup?.length === 0)
        return (dns as any).lookup(hostname, { family: 4 }).then((res: any) => {
            const addr: string = res?.address ?? hostname;
            _dnsCache.set(hostname, addr);

            return addr;
        }).catch(() => hostname);

    return new Promise((resolve) => dns.lookup(hostname, { family: 4 }, (err, address) => {
        const addr = err || !address ? hostname : address;
        _dnsCache.set(hostname, addr);

        resolve(addr);
    }));
};

export type StratumJob = {
    blob: string;
    target: string;
    job_id: string;
    seed_hash: string;

    algo?: string;
    height?: number;
};

export class StratumClient extends EventEmitter<{
    job: [job: StratumJob];
    close: [];
    connect: [remoteHost: string];
}> {
    public host: string;
    public remoteAddress: string;

    private keepalive: boolean;
    private isWebSocket: boolean;
    private socket: net.Socket | WebSocket;

    private id: number = 1;
    private session?: string;
    private promises: Map<number, { resolve: Function, reject: Function, timeout: NodeJS.Timeout }> = new Map();
    private keepaliveInterval?: NodeJS.Timeout;

    constructor(isWebSocket: boolean, host: string, remoteAddress: string, socket: net.Socket | WebSocket, _keepalive: boolean = false) {
        super();
        this.host = host;
        this.socket = socket;
        this.keepalive = _keepalive;
        this.isWebSocket = isWebSocket;
        this.remoteAddress = remoteAddress;

        if (isWebSocket) {
            const ws = socket as WebSocket;
            ws
                .on("close", () => this.handleClose())
                .on("message", (data) => {
                    try {
                        let parsed: any = data.toString();
                        if ((ws as any).session) parsed = decrypt((ws as any).session, parsed);

                        if (Array.isArray(parsed) && parsed[0] === "job")
                            return this.emit("job", parsed[1]);

                        if (Array.isArray(parsed) && this.promises.has(parsed[0])) {
                            const promise = this.promises.get(parsed[0])!;
                            clearTimeout(promise.timeout);

                            if (parsed[1] != null && typeof parsed[1] === "string")
                                promise.reject(new Error(parsed[1]));
                            else
                                promise.resolve(parsed[2]);

                            this.promises.delete(parsed[0]);
                        };
                    } catch { };
                });
        } else {
            const tcp = socket as net.Socket;
            tcp
                .on("end", () => this.handleClose())
                .on("close", () => this.handleClose())
                .on("error", () => this.handleClose());

            const chunks: Buffer[] = [];
            let totalLen = 0;

            tcp.on("data", (raw: Buffer) => {
                let scanStart = 0;

                while (true) {
                    const nlPos = raw.indexOf(0x0a, scanStart);

                    if (nlPos === -1) {
                        if (scanStart === 0) {
                            chunks.push(raw);
                            totalLen += raw.length;
                        } else {
                            const tail = raw.subarray(scanStart);
                            if (tail.length > 0) {
                                chunks.push(tail);
                                totalLen += tail.length;
                            }
                        };

                        break;
                    };
                    const slice = raw.subarray(scanStart, nlPos);
                    let line: string;

                    if (chunks.length === 0)
                        line = slice.toString("utf8");
                    else {
                        chunks.push(slice);
                        totalLen += slice.length;
                        line = Buffer.concat(chunks, totalLen).toString("utf8");
                        chunks.length = 0;
                        totalLen = 0;
                    };

                    const trimmed = line.trim();
                    if (trimmed) {
                        try {
                            const data = JSON.parse(trimmed);

                            if ("method" in data) {
                                if (data.method === "job") this.emit("job", data.params);
                            } else if (this.promises.has(data.id)) {
                                const promise = this.promises.get(data.id)!;
                                clearTimeout(promise.timeout);

                                if (data.error != null && data.error.message)
                                    promise.reject(new Error(data.error.message));
                                else
                                    promise.resolve(data.result);

                                this.promises.delete(data.id);
                            };
                        } catch { };
                    };

                    scanStart = nlPos + 1;
                    if (scanStart >= raw.length) break;
                };
            });
        };
    };

    private closed: boolean = false;
    private handleClose() {
        if (this.closed) return;
        if (this.keepaliveInterval) clearInterval(this.keepaliveInterval);

        this.closed = true;
        this.emit("close");
    };

    public send(method: string, params: any): Promise<any> {
        return new Promise((resolve, reject) => {
            const id = this.id++, timeout = setTimeout(() => {
                if (this.closed)
                    return this.promises.delete(id);

                if (this.promises.has(id)) {
                    this.promises.delete(id);
                    reject(new Error("Stratum request timed out after 30000ms."));
                };
            }, 30000);

            this.promises.set(id, { resolve, reject, timeout });

            if (this.isWebSocket)
                (this.socket as WebSocket).send(encrypt((this.socket as any).session, [id, method, params]));
            else
                (this.socket as net.Socket).write(`${JSON.stringify({ id, jsonrpc: "2.0", method, params })}\n`);
        });
    };

    public async login(address: string, pass: string = "x", threads?: number): Promise<StratumJob> {
        /// @ts-ignore
        const algorithms = ["rx/0", "rx/monero"], params: any = this.isWebSocket ? [address, pass, ...(threads ? [threads] : [])] : { pass, login: address, algo: algorithms, agent: `${process.isBun ? "bun" : "nodejs"} / v${version}`, extensions: ["nicehash", "keepalive"] };

        const result = await this.send("login", params);

        this.session = result.id;
        this.keepalive = this.isWebSocket || this.keepalive || (result.extensions && Array.isArray(result.extensions) && result.extensions.includes("keepalive"));

        if (this.keepalive)
            this.keepaliveInterval = setInterval(async () => {
                try {
                    await this.send("keepalived", { id: this.session });
                } catch (err: any) { if (err.message && err.message !== "Stratum request timed out after 30000ms.") this.close(); };
            }, 60000);

        const job: StratumJob = {
            blob: result.job.blob,
            job_id: result.job.job_id,
            target: result.job.target,
            seed_hash: result.job.seed_hash,
            ...(result.job.algo !== undefined ? { algo: result.job.algo } : {}),
            ...(result.job.height !== undefined ? { height: result.job.height } : {})
        };

        this.emit("connect", this.remoteAddress);
        return job;
    };

    public async submit(job_id: string, nonce: string, result: string): Promise<string | null> {
        if (this.closed) return Promise.reject(new Error("Cannot submit job: the stratum connection is closed."));

        return this.send("submit", this.isWebSocket ? [job_id, nonce, result] : { id: this.session, job_id, nonce, result });
    };

    public close() {
        if (this.closed) return;
        if (this.keepaliveInterval) clearInterval(this.keepaliveInterval);

        this.closed = true;

        if (this.isWebSocket)
            (this.socket as WebSocket).close();
        else {
            const tcp = this.socket as net.Socket;

            tcp.end();
            tcp.destroy();
        };
    };
};

async function Tcp(protocol: string, host: string, port: number, agent?: string): Promise<{ socket: net.Socket, remoteAddress: string }> {
    const remoteAddress = await ResolveHostname(host), socket: net.Socket = await new Promise<net.Socket>(async (resolve, reject) => {
        try {
            if (agent) {
                const url = new URL(agent);
                const type: any = url.protocol === "socks4:" || url.protocol === "socks4a:" ? 4 : 5;

                const client = await SocksClient.createConnection({
                    timeout: 10000,
                    command: "connect",
                    destination: { host: remoteAddress, port },
                    proxy: {
                        type: type,
                        host: url.hostname,
                        port: parseInt(url.port) || 1080,
                        userId: url.username ? decodeURIComponent(url.username) : undefined,
                        password: url.password ? decodeURIComponent(url.password) : undefined
                    }
                });

                return resolve(client.socket);
            } else {
                let resolved = false;
                const socket = net.createConnection({ host: remoteAddress, port })
                    .once("error", (err) => {
                        if (!resolved) {
                            resolved = true;
                            reject(new Error(`Connection refused: unable to establish TCP connection to ${host} (${err.message}).`));
                        };
                    });

                const timeout = setTimeout(() => {
                    if (!resolved) {
                        resolved = true;
                        socket.destroy();
                        reject(new Error(`Connection timeout: failed to connect to ${host} within 10000ms.`));
                    }
                }, 10000);

                socket.on("connect", () => {
                    resolved = true;
                    resolve(socket);
                    clearTimeout(timeout);
                });
            };
        } catch (err: any) { reject(new Error(`Proxy connection error: failed to establish tunnel via ${agent} (${err?.message || 'unknown error'}).`)); };
    });

    if (protocol === "stratum+ssl:")
        return {
            socket: await new Promise<net.Socket>(async (cb, reject) => {
                let resolved = false;
                const resolve = (socket: net.Socket) => {
                    if (resolved) return;
                    resolved = true; cb(socket);
                };

                const tlsSocket = tls.connect({ socket, servername: host, rejectUnauthorized: false }, () => {
                    resolve(tlsSocket);
                });

                tlsSocket.once("error", (err) => {
                    if (!resolved) {
                        resolved = true;
                        reject(new Error(`TLS handshake failed: unable to establish secure connection to ${host} (${err.message}).`));
                    };
                });
            }), remoteAddress
        };
    else
        return { socket, remoteAddress };
};

async function Wss(url: string, agent?: string): Promise<{ socket: WebSocket, remoteAddress: string }> {
    const u = new URL(url);
    const remoteAddress = await ResolveHostname(u.hostname);

    return new Promise(async (resolve, reject) => {
        let resolved = false;

        const ecdh = createExchange();
        const publicSalt = ecdh.generateKeys("hex");

        const socket = new WebSocket(url, { headers: { "x-salt": publicSalt }, lookup: (hostname, options, callback) => callback(null, remoteAddress, 4), ...(typeof agent === "string" ? { agent: new ((await import("proxy-agent")).ProxyAgent)(agent as any) } : {}) });

        socket.on("open", () => {
            resolved = true;
            resolve({ socket, remoteAddress });
        });

        socket.on("error", (err) => {
            if (!resolved) {
                resolved = true;
                reject(new Error(`WebSocket connection failed: unable to connect to ${u.host} (${err.message}).`));
            };
        });

        socket.on("upgrade", (res) => {
            const privateHash = res.headers["x-salt"];
            if (!privateHash) return socket.terminate();

            (socket as any).session = hash(ecdh.computeSecret(privateHash as string, "hex"));
        });
    });
};

export async function connect(url: string, agent?: string, keepalive?: boolean): Promise<StratumClient> {
    const u = new URL(url), isWebSocket = ["ws:", "wss:"].includes(u.protocol), connection: {
        socket: net.Socket | WebSocket,
        remoteAddress: string
    } = isWebSocket ? await Wss(url, agent) : await Tcp(u.protocol, u.hostname, parseInt(u.port) || 3333, agent);

    return new StratumClient(isWebSocket, isWebSocket ? u.hostname : u.host, connection.remoteAddress, connection.socket, keepalive);
};