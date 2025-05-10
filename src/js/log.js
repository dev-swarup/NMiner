const colors = require("colors/safe"), GetTime = t => {
    if (t)
        return colors.gray(`(${(new Date()).getTime() - t} ms)`);

    const [time, mses] = new Date().toISOString().replace("T", " ").replace("Z", "").split(".");
    return `[${time}.${colors.gray(mses)}]`;
};

colors.setTheme({ RED_BOLD: ["bold", "bgRed"], BLUE_BOLD: ["bold", "bgBlue"], CYAN_BOLD: ["bold", "bgCyan"], WHITE_BOLD: ["bold", "white"], YELLOW_BOLD: ["bold", "bgYellow"], MAGENTA_BOLD: ["bold", "bgMagenta"] });

module.exports = {
    GetTime, Print: (type, message) => console.log(`${GetTime()} ${type} ${message}`),
    RED: colors.red, BOLD: colors.bold, CYAN: colors.cyan, BLUE: colors.blue, GRAY: colors.gray, WHITE: colors.white, GREEN: colors.green, YELLOW: colors.yellow, MAGENTA: colors.magenta,
    RED_BOLD: colors.RED_BOLD, BLUE_BOLD: colors.BLUE_BOLD, CYAN_BOLD: colors.CYAN_BOLD, WHITE_BOLD: colors.WHITE_BOLD, YELLOW_BOLD: colors.YELLOW_BOLD, MAGENTA_BOLD: colors.MAGENTA_BOLD
};