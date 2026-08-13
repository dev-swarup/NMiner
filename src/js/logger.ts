const CSI   = "\x1B[";
const CLEAR = "\x1B[0m";

export const BLACK         = (s: string) => `${CSI}0;30m${s}${CLEAR}`;
export const RED           = (s: string) => `${CSI}0;31m${s}${CLEAR}`;
export const GREEN         = (s: string) => `${CSI}0;32m${s}${CLEAR}`;
export const YELLOW        = (s: string) => `${CSI}0;33m${s}${CLEAR}`;
export const BLUE          = (s: string) => `${CSI}0;34m${s}${CLEAR}`;
export const MAGENTA       = (s: string) => `${CSI}0;35m${s}${CLEAR}`;
export const CYAN          = (s: string) => `${CSI}0;36m${s}${CLEAR}`;
export const WHITE         = (s: string) => `${CSI}0;37m${s}${CLEAR}`;
export const GRAY          = (s: string) => `${CSI}0;90m${s}${CLEAR}`;

export const BLACK_BOLD    = (s: string) => `${CSI}1;30m${s}${CLEAR}`;
export const RED_BOLD      = (s: string) => `${CSI}1;31m${s}${CLEAR}`;
export const GREEN_BOLD    = (s: string) => `${CSI}1;32m${s}${CLEAR}`;
export const YELLOW_BOLD   = (s: string) => `${CSI}1;33m${s}${CLEAR}`;
export const BLUE_BOLD     = (s: string) => `${CSI}1;34m${s}${CLEAR}`;
export const MAGENTA_BOLD  = (s: string) => `${CSI}1;35m${s}${CLEAR}`;
export const CYAN_BOLD     = (s: string) => `${CSI}1;36m${s}${CLEAR}`;
export const WHITE_BOLD    = (s: string) => `${CSI}1;37m${s}${CLEAR}`;


export const BOLD          = (s: string) => `${CSI}1m${s}${CLEAR}`;

export const BLUE_BG         = (s: string) => `${CSI}44m${s}${CLEAR}`;
export const MAGENTA_BG      = (s: string) => `${CSI}45m${s}${CLEAR}`;
export const CYAN_BG         = (s: string) => `${CSI}46m${s}${CLEAR}`;

export const RED_BG_BOLD     = (s: string) => `${CSI}41;1m${s}${CLEAR}`;
export const GREEN_BG_BOLD   = (s: string) => `${CSI}42;1m${s}${CLEAR}`;
export const YELLOW_BG_BOLD  = (s: string) => `${CSI}43;1m${s}${CLEAR}`;
export const BLUE_BG_BOLD    = (s: string) => `${CSI}44;1m${s}${CLEAR}`;
export const MAGENTA_BG_BOLD = (s: string) => `${CSI}45;1m${s}${CLEAR}`;
export const CYAN_BG_BOLD    = (s: string) => `${CSI}46;1m${s}${CLEAR}`;

const pad2 = (n: number) => n < 10 ? `0${n}` : `${n}`;
const pad3 = (n: number) => n < 10 ? `00${n}` : n < 100 ? `0${n}` : `${n}`;

export const GetTime = (elapsed?: number): string => {
    if (elapsed !== undefined)
        return GRAY(`(${Date.now() - elapsed} ms)`);

    const d = new Date();
    const ms = pad3(d.getMilliseconds());

    const ts = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;

    return `[${ts}${BLACK_BOLD(`.${ms}`)}]`;
};

export const Print = (type: string, message: string): boolean => process.stdout.write(`${GetTime()} ${type} ${message}\n`);

export type Kind = "error" | "warn" | "info" | "success" | "debug";
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

const Kind: { [key in Kind]: number } = { error: 1, warn: 2, info: 3, success: 3, debug: 4 };
const Rank: { [key in Level]: number } = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const plain = (s: string) => s;

const Badges: { [key: string]: (s: string) => string } = {
    net: BLUE_BG, pool: BLUE_BG, udp: BLUE_BG,
    cpu: CYAN_BG, randomx: CYAN_BG, verify: CYAN_BG,
    share: MAGENTA_BG, proxy: MAGENTA_BG, fleet: MAGENTA_BG, program: MAGENTA_BG
};

const Tints: { [key in Kind]: (s: string) => string } = { error: RED, warn: YELLOW, info: plain, success: GREEN, debug: GRAY };

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
    const badge = color ? (Badges[entry.scope] ?? MAGENTA_BG) : plain;
    const colorWith = color ? GRAY : plain, value = color ? WHITE_BOLD : plain;

    const { accepted, rejected, took, reason, ...rest } = entry.fields ?? {};

    let shares = "";
    if (accepted !== undefined || rejected !== undefined) {
        const bad = color && Number(rejected) > 0 ? RED : value;
        shares = ` ${colorWith("(")}${value(render(accepted ?? 0))}${colorWith("/")}${bad(render(rejected ?? 0))}${colorWith(")")}`;
    };

    let fields = "";
    for (const [name, input] of Object.entries(rest))
        if (input !== undefined && input !== null) fields += ` ${colorWith(name)} ${value(render(input))}`;

    const why = reason !== undefined && reason !== null ? ` ${tint(render(reason))}` : "";
    return `${stamp(entry.time, color)} ${badge(` ${entry.scope.padEnd(7)} `)} ${tint(entry.message)}${shares}${why}${fields}${took !== undefined ? ` ${colorWith(`(${render(took)})`)}` : ""}`;
};

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

    public emit(entry: Entry): void { if (entry && Kind[entry.kind] !== undefined && this.allows(entry.kind)) this.config.sink(entry); };

    private write(kind: Kind, message: string, fields?: Fields): void {
        if (!this.allows(kind)) return;
        this.config.sink({ time: Date.now(), kind, scope: this.scope, message, fields });
    };
};

export const Silent = new Logger({ level: "silent", sink: () => { } });

export const toLevel = (input: unknown, fallback: Level = "silent"): Level => typeof input === "string" && (Levels as string[]).includes(input) ? input as Level : input === true ? "info" : input === false ? "silent" : fallback;

export function createLogger(options: LogOptions = {}, scope: string = "program"): Logger {
    if (options.logger instanceof Logger) return options.logger.child(scope);

    const level = toLevel(options.logging, options.logger ? "info" : "silent");
    return new Logger({ level, sink: typeof options.logger === "function" ? options.logger : consoleSink }, scope);
};

export type LogLike = Logger | boolean | Level;
export const asLogger = (input: LogLike | undefined, scope: string): Logger => input instanceof Logger ? input.child(scope) : createLogger({ logging: input }, scope);

export const ms = (started: number): string => `${Date.now() - started} ms`;