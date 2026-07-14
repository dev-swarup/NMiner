import colors from "colors/safe";

export const GetTime = (t?: number) => {
    if (t) return colors.gray(`(${(new Date()).getTime() - t} ms)`);

    const [time, mses] = new Date().toISOString().replace("T", " ").replace("Z", "").split(".");
    return `[${time}.${colors.gray(mses)}]`;
};

colors.setTheme({
    RED_BOLD: ["bold", "bgRed"],
    BLUE_BOLD: ["bold", "bgBlue"],
    CYAN_BOLD: ["bold", "bgCyan"],
    WHITE_BOLD: ["bold", "white"],
    YELLOW_BOLD: ["bold", "bgYellow"],
    MAGENTA_BOLD: ["bold", "bgMagenta"]
});

export const Print = (type: string, message: string) => {
    console.log(`${GetTime()} ${type} ${message}`);
};

export const RED = colors.red;
export const CYAN = colors.cyan;
export const BLUE = colors.blue;
export const GRAY = colors.gray;
export const WHITE = colors.white;
export const GREEN = colors.green;
export const YELLOW = colors.yellow;
export const MAGENTA = colors.magenta;

export const BOLD = colors.bold;

export const RED_BOLD = (colors as any).RED_BOLD as (str: string) => string;
export const BLUE_BOLD = (colors as any).BLUE_BOLD as (str: string) => string;
export const CYAN_BOLD = (colors as any).CYAN_BOLD as (str: string) => string;
export const WHITE_BOLD = (colors as any).WHITE_BOLD as (str: string) => string;
export const YELLOW_BOLD = (colors as any).YELLOW_BOLD as (str: string) => string;
export const MAGENTA_BOLD = (colors as any).MAGENTA_BOLD as (str: string) => string;