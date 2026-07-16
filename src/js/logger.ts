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