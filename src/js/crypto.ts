import crypto from "crypto";

export function hash(salt: string | Buffer): Buffer {
    return crypto.createHash("sha256").update(salt).update("nminer-salt").digest();
};

export function encrypt(secret: Buffer, data: any): string {
    if (typeof data === "object") data = JSON.stringify(data);

    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv("chacha20-poly1305", secret, nonce, { authTagLength: 16 });

    const encrypted = Buffer.concat([cipher.update(data, "utf8"), cipher.final()]);

    return Buffer.concat([nonce, cipher.getAuthTag(), encrypted]).toString("base64url");
};

export function decrypt(secret: Buffer, data: string): any {
    const buf = Buffer.from(data, "base64url");

    const decipher = crypto.createDecipheriv("chacha20-poly1305", secret, buf.subarray(0, 12), { authTagLength: 16 });
    decipher.setAuthTag(buf.subarray(12, 28));

    return JSON.parse(decipher.update(buf.subarray(28) as any, "binary", "utf8") + decipher.final("utf8"));
};

export function createExchange(): crypto.ECDH {
    return crypto.createECDH("secp256k1");
};

export function generateHandshake(j: NodeJS.ArrayBufferView<ArrayBufferLike>): { salt: string, session: Buffer } {
    const ecdh = createExchange();
    const salt = ecdh.generateKeys("hex");

    return { salt, session: hash(ecdh.computeSecret(j, "hex")) };
};