try {
    module.exports = require("../../build/NMiner.node");
} catch {
    module.exports = require("../../build/Release/NMiner.node");
};