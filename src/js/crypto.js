const crypto = require("crypto");

module.exports = {
    hash: salt => crypto.scryptSync(salt, "nminer-salt", 32),
    encrypt: (secret, data) => {
        if (typeof data == "object")
            data = JSON.stringify(data);

        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv("aes-256-gcm", secret, iv);
        const buffer = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);

        return Buffer.concat([iv, cipher.getAuthTag(), buffer]).toString("base64url");
    },
    decrypt: (secret, data) => {
        const buf = Buffer.from(data, "base64url");
        const decipher = crypto.createDecipheriv("aes-256-gcm", secret, buf.slice(0, 16));

        decipher.setAuthTag(buf.slice(16, 32));
        const chunk = decipher.update(buf.slice(32), "binary", "utf8") + decipher.final("utf8");

        try {
            return JSON.parse(chunk);
        } catch { return chunk };
    }
};

module.exports.createExchange = () => crypto.createECDH("secp256k1");
module.exports.generateHandshake = j => {
    const ecdh = crypto.createECDH("secp256k1"), salt = ecdh.generateKeys("hex");

    return { salt, session: module.exports.hash(ecdh.computeSecret(j, "hex")) };
};