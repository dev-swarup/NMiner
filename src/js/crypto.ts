import crypto from "crypto";

const _nonce = Buffer.allocUnsafe(12);

export function hash(salt: string | Buffer): Buffer {
    return crypto.createHash("sha256").update(salt).update("nminer-salt").digest();
};

let _subtle: SubtleCrypto | null = null;
const getSubtle = (): SubtleCrypto => {
    if (_subtle) return _subtle;

    _subtle = (globalThis as any).crypto?.subtle ?? null;
    return _subtle!;
};

const _keyCache = new WeakMap<Buffer, CryptoKey>();
async function importKey(secret: Buffer): Promise<CryptoKey> {
    let key = _keyCache.get(secret);
    if (key) return key;

    key = await getSubtle().importKey("raw", secret as any, { name: "CHACHA20-POLY1305" } as any, false, ["encrypt", "decrypt"]);
    _keyCache.set(secret, key);

    return key;
};

export function encrypt(secret: Buffer, data: any): string {
    crypto.randomFillSync(_nonce);

    const text: string = typeof data === "string" ? data : JSON.stringify(data);
    const cipher = crypto.createCipheriv("chacha20-poly1305", secret, _nonce, { authTagLength: 16 } as any);

    const encrypted = cipher.update(text, "utf8"); cipher.final();
    const tag = cipher.getAuthTag();

    const out = Buffer.allocUnsafe(12 + 16 + encrypted.length);
    _nonce.copy(out, 0); tag.copy(out, 12); encrypted.copy(out, 28);

    return out.toString("base64url");
};

export function decrypt(secret: Buffer, data: string): any {
    const buf = Buffer.from(data, "base64url");

    const decipher = crypto.createDecipheriv("chacha20-poly1305", secret, buf.subarray(0, 12), { authTagLength: 16 } as any);
    decipher.setAuthTag(buf.subarray(12, 28));

    const text = decipher.update(buf.subarray(28) as any, "binary", "utf8") + decipher.final("utf8");
    return JSON.parse(text);
};

export function createExchange(): crypto.ECDH {
    return crypto.createECDH("secp256k1");
};

export function generateHandshake(j: NodeJS.ArrayBufferView<ArrayBufferLike>): { salt: string, session: Buffer } {
    const ecdh = createExchange();
    const salt = ecdh.generateKeys("hex");

    return { salt, session: hash(ecdh.computeSecret(j, "hex")) };
};

export { importKey as importCryptoKey };