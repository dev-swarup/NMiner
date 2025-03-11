require("colors");
module.exports.print = async (type, message) => {
    const [time, mses] = new Date().toISOString().replace("T", " ").replace("Z", "").split(".");
    console.log(`[${time}.${mses.gray}] ${(type == "net" ? " net   " : type == "miner" ? " miner " : type == "cpu" ? " cpu   " : ` ${type} `)[type == "net" ? "bgBlue" : type == "cpu" ? "bgCyan" : type == "miner" ? "bgMagenta" : "bgYellow"]} ${message}`);
};