import dgram from "dgram";
import { hash, createExchange } from "./crypto.js";

export const RESET = "0";
export const HELLO = "1";
export const WELCOME = "2";
export const DATA = "3";
export const ACK = "4";

export const MAX_PAYLOAD = 60000;
export const PEER_TIMEOUT = 5 * 60000;

const RETRIES = 5;
const RETRY_MS = 700;
const SEEN_WINDOW = 256;

export class Datagram {
    private seq: number = 0;
    private seen: number[] = [];
    private outbox: Map<number, { text: string, tries: number, timer: NodeJS.Timeout }> = new Map();

    constructor(private write: (text: string) => void, private deliver: (payload: string) => void, private dead: () => void) {

    };

    public get inflight(): number { return this.outbox.size; };

    public send(payload: string): void {
        const seq = ++this.seq, text = `${DATA}${seq.toString(36)}:${payload}`;
        const entry = { text, tries: 0, timer: null as any };

        this.outbox.set(seq, entry);

        const retry = () => {
            if (!this.outbox.has(seq)) return;

            if (++entry.tries > RETRIES) {
                this.outbox.delete(seq);
                return this.dead();
            };

            this.write(text);

            entry.timer = setTimeout(retry, RETRY_MS);
            entry.timer.unref?.();
        };

        retry();
    };

    public receive(text: string): void {
        if (text[0] === ACK) {
            const seq = parseInt(text.slice(1), 36);
            const entry = this.outbox.get(seq);

            if (!entry) return;

            clearTimeout(entry.timer);
            this.outbox.delete(seq);

            return;
        };

        if (text[0] !== DATA) return;

        const at = text.indexOf(":");
        if (at < 0) return;

        const seq = parseInt(text.slice(1, at), 36);
        if (!Number.isFinite(seq)) return;

        this.write(`${ACK}${seq.toString(36)}`);
        if (this.seen.includes(seq)) return;

        this.seen.push(seq);
        if (this.seen.length > SEEN_WINDOW) this.seen.shift();

        this.deliver(text.slice(at + 1));
    };

    public stop(): void {
        for (const entry of this.outbox.values()) clearTimeout(entry.timer);
        this.outbox.clear();
    };
};

export class UdpClient {
    public session?: Buffer;

    private link!: Datagram;
    private socket: dgram.Socket;
    private ecdh = createExchange();

    private closed: boolean = false;
    private hello?: NodeJS.Timeout;
    private handlers: Map<string, Function[]> = new Map();

    constructor(private host: string, private port: number) {
        this.socket = dgram.createSocket("udp4");
    };

    public on(event: string, handler: Function): this {
        const list = this.handlers.get(event);

        if (list) list.push(handler);
        else this.handlers.set(event, [handler]);

        return this;
    };

    public send(text: string): void { if (!this.closed) this.link.send(text); };

    public close(): void {
        if (this.closed) return;
        this.closed = true;

        clearInterval(this.hello);
        this.link?.stop();

        try { this.socket.close(); } catch { };
        for (const handler of this.handlers.get("close") ?? []) handler();
    };

    public connect(ms: number = 15000): Promise<void> {
        return new Promise((resolve, reject) => {
            let ready = false;
            const salt = this.ecdh.generateKeys("hex");

            this.link = new Datagram(text => this.write(text), payload => { for (const handler of this.handlers.get("message") ?? []) handler(payload); }, () => this.close());

            this.socket.on("error", () => this.close());
            this.socket.on("message", buf => {
                const text = buf.toString("utf8");

                if (text[0] === WELCOME) {
                    if (ready) return;

                    try {
                        this.session = hash(this.ecdh.computeSecret(text.slice(1), "hex"));
                    } catch { return; };

                    ready = true;
                    clearTimeout(timer);
                    clearInterval(this.hello);

                    return resolve();
                };

                if (text[0] === RESET) return this.close();
                if (ready) this.link.receive(text);
            });

            const timer = setTimeout(() => {
                if (ready) return;

                clearInterval(this.hello);
                this.close();

                reject(new Error(`UDP connection timeout: no handshake from ${this.host}:${this.port} within ${ms}ms.`));
            }, ms);

            this.hello = setInterval(() => this.write(HELLO + salt), 800);
            this.write(HELLO + salt);
        });
    };

    private write(text: string): void {
        if (!this.closed) this.socket.send(text, this.port, this.host, () => { });
    };
};