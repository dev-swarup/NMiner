const CSI = "\x1B[";
const CLEAR = "\x1B[0m";

export const RED = (s: string) => `${CSI}0;31m${s}${CLEAR}`;
export const GREEN = (s: string) => `${CSI}0;32m${s}${CLEAR}`;
export const YELLOW = (s: string) => `${CSI}0;33m${s}${CLEAR}`;
export const MAGENTA = (s: string) => `${CSI}0;35m${s}${CLEAR}`;
export const CYAN = (s: string) => `${CSI}0;36m${s}${CLEAR}`;
export const WHITE = (s: string) => `${CSI}0;37m${s}${CLEAR}`;
export const GRAY = (s: string) => `${CSI}0;90m${s}${CLEAR}`;

export const BLACK_BOLD = (s: string) => `${CSI}1;30m${s}${CLEAR}`;
export const RED_BOLD = (s: string) => `${CSI}1;31m${s}${CLEAR}`;
export const GREEN_BOLD = (s: string) => `${CSI}1;32m${s}${CLEAR}`;
export const MAGENTA_BOLD = (s: string) => `${CSI}1;35m${s}${CLEAR}`;
export const CYAN_BOLD = (s: string) => `${CSI}1;36m${s}${CLEAR}`;
export const WHITE_BOLD = (s: string) => `${CSI}1;37m${s}${CLEAR}`;

const TAG = `${CSI}1;37m`;
export const BLUE_BG_BOLD = (s: string) => `${CSI}44;1m${TAG}${s}${CLEAR}`;
export const MAGENTA_BG_BOLD = (s: string) => `${CSI}45;1m${TAG}${s}${CLEAR}`;
export const CYAN_BG_BOLD = (s: string) => `${CSI}46;1m${TAG}${s}${CLEAR}`;

const pad2 = (n: number) => n < 10 ? `0${n}` : `${n}`;
const pad3 = (n: number) => n < 10 ? `00${n}` : n < 100 ? `0${n}` : `${n}`;

export type Kind = "error" | "warn" | "failure" | "info" | "success" | "notice" | "debug";
export type Level = "silent" | "error" | "warn" | "info" | "debug";
export type Fields = { [key: string]: unknown };

export interface Entry {
    time: number;
    kind: Kind;
    scope: string;
    message: string;
    fields?: Fields;
};

export type Sink = (entry: Entry) => void;

export interface LogOptions {
    logger?: Logger | Sink;
    logging?: boolean | Level;
};

export const Levels: Level[] = ["silent", "error", "warn", "info", "debug"];

const Kind: { [key in Kind]: number } = { error: 1, warn: 2, failure: 2, info: 3, success: 3, notice: 3, debug: 4 };
const Rank: { [key in Level]: number } = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const plain = (s: string) => s;

const Badges: { [key: string]: (s: string) => string } = {
    cpu: CYAN_BG_BOLD, verify: CYAN_BG_BOLD,
    net: BLUE_BG_BOLD, pool: BLUE_BG_BOLD, udp: BLUE_BG_BOLD, randomx: BLUE_BG_BOLD,
    miner: MAGENTA_BG_BOLD, share: MAGENTA_BG_BOLD, proxy: MAGENTA_BG_BOLD, fleet: MAGENTA_BG_BOLD, program: MAGENTA_BG_BOLD
};

const Cyan: Set<string> = new Set(["", "pool", "host", "from", "bind", "10s/60s/15m", "max"]);
const Tints: { [key in Kind]: (s: string) => string } = { error: RED, warn: YELLOW, failure: RED_BOLD, info: WHITE_BOLD, success: GREEN_BOLD, notice: MAGENTA_BOLD, debug: GRAY };

const render = (input: unknown): string => {
    if (input instanceof Error) return input.message;
    if (typeof input === "number") return Number.isInteger(input) ? String(input) : input.toFixed(2);

    return typeof input === "string" ? input : JSON.stringify(input) ?? String(input);
};

export const stamp = (time: number, color: boolean = true): string => {
    const d = new Date(time), ms = pad3(d.getMilliseconds());
    const ts = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

    return `[${ts}${(color ? BLACK_BOLD : plain)(`.${ms}`)}]`;
};

export const format = (entry: Entry, color: boolean = true): string => {
    const tint = color ? Tints[entry.kind] : plain;
    const badge = color ? (Badges[entry.scope] ?? MAGENTA_BG_BOLD) : plain;
    const dim = color ? BLACK_BOLD : plain;

    const { accepted, rejected, took, reason, ...rest } = entry.fields ?? {};
    const shares = accepted !== undefined || rejected !== undefined ? ` (${render(accepted ?? 0)}/${render(rejected ?? 0)})` : "";

    let fields = "";
    for (const [name, input] of Object.entries(rest)) {
        if (input === undefined || input === null) continue;

        const paint = color ? (Cyan.has(name) ? CYAN_BOLD : WHITE_BOLD) : plain;
        fields += name ? ` ${name} ${paint(render(input))}` : ` ${paint(render(input))}`;
    };

    const why = reason !== undefined && reason !== null ? ` ${(color ? RED : plain)(render(reason))}` : "";
    return `${stamp(entry.time, color)} ${badge(` ${entry.scope.padEnd(7)} `)} ${tint(entry.message)}${shares}${why}${fields}${took !== undefined ? ` ${dim(`(${render(took)})`)}` : ""}`;
};

export const row = (label: string, value: string, color: boolean = true): string => `${(color ? GREEN : plain)(" *")} ${(color ? WHITE_BOLD : plain)(label.padEnd(13))}${value}`;
export const INDENT = " ".repeat(16);

const COLOR = process.env.NO_COLOR === undefined;
export const consoleSink: Sink = entry => { process.stdout.write(`${format(entry, COLOR)}\n`); };

interface Config {
    sink: Sink;
    level: Level;
};

export class Logger {
    constructor(private config: Config, public readonly scope: string = "program") { };

    public get level(): Level { return this.config.level; };
    public set level(level: Level) { this.config.level = level; };

    public get enabled(): boolean { return this.config.level !== "silent"; };

    public child(scope: string): Logger { return new Logger(this.config, scope); };
    public allows(kind: Kind): boolean { return Kind[kind] <= Rank[this.config.level]; };

    public info(message: string, fields?: Fields): void { this.write("info", message, fields); };
    public warn(message: string, fields?: Fields): void { this.write("warn", message, fields); };
    public debug(message: string, fields?: Fields): void { this.write("debug", message, fields); };
    public error(message: unknown, fields?: Fields): void { this.write("error", message instanceof Error ? message.message : String(message), fields); };
    public success(message: string, fields?: Fields): void { this.write("success", message, fields); };
    public notice(message: string, fields?: Fields): void { this.write("notice", message, fields); };
    public failure(message: string, fields?: Fields): void { this.write("failure", message, fields); };

    public emit(entry: Entry): void { if (entry && Kind[entry.kind] !== undefined && this.allows(entry.kind)) this.config.sink(entry); };

    private write(kind: Kind, message: string, fields?: Fields): void {
        if (!this.allows(kind)) return;
        this.config.sink({ time: Date.now(), kind, scope: this.scope, message, fields });
    };
};

export const toLevel = (input: unknown, fallback: Level = "silent"): Level => typeof input === "string" && (Levels as string[]).includes(input) ? input as Level : input === true ? "info" : input === false ? "silent" : fallback;

export function createLogger(options: LogOptions = {}, scope: string = "program"): Logger {
    if (options.logger instanceof Logger) return options.logger.child(scope);

    const level = toLevel(options.logging, options.logger ? "info" : "silent");
    return new Logger({ level, sink: typeof options.logger === "function" ? options.logger : consoleSink }, scope);
};

export type LogLike = Logger | boolean | Level;
export const asLogger = (input: LogLike | undefined, scope: string): Logger => input instanceof Logger ? input.child(scope) : createLogger({ logging: input }, scope);

export const ms = (started: number): string => `${Date.now() - started} ms`;