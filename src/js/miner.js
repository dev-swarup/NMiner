const { join } = require("path");
const { existsSync } = require("fs");

const isBun = typeof process.versions.bun !== "undefined";

(function loadAddon() {
    let path = join(__dirname, "..", "..", "bin", `nminer-${process.platform}${process.platform === "linux" ? `-node${process.versions.node.split(".")[0]}` : ""}.node`);

    if (!existsSync(path)) {
        path = join(__dirname, "..", "..", "build", "Release", "NMiner.node");

        if (!existsSync(path))
            throw new Error(`[NMiner] Native addon binaries not found.\nPlease compile the project or ensure the pre-built binaries exist.\n`);
    };

    try {
        module.exports = require(path);
    } catch (err) { throw new Error(`[NMiner] Failed to load the native addon.\nReason: ${err.message}\n\nSystem: ${process.platform} ${process.arch} (${isBun ? `Bun v${process.versions.bun}` : `Node.js ${process.version}`})\n`); };
})();