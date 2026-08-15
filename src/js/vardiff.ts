export const RETUNE_RATIO = 1.3;
export const SHARE_SECONDS = 15;
export const MIN_DIFFICULTY = 1000;

const U32 = 0xFFFFFFFF;
const U64 = 0xFFFFFFFFFFFFFFFFn;

const CACHE_LIMIT = 4096;

type Decoded = { value: bigint, difficulty: number };

const decoded: Map<string, Decoded> = new Map();
const encoded: Map<number, string> = new Map();

function decode(target: string): Decoded {
    const known = decoded.get(target);
    if (known) return known;

    let entry: Decoded;

    if (target.length >= 16) {
        const value = Buffer.from(target.substring(0, 16), "hex").readBigUInt64LE(0);
        entry = value > 0n ? { value, difficulty: Number(U64 / value) } : { value: U64, difficulty: MIN_DIFFICULTY };
    } else {
        const compact = Buffer.from(target.padEnd(8, "0").substring(0, 8), "hex").readUInt32LE(0);
        const difficulty = compact > 0 ? Math.floor(U32 / compact) : MIN_DIFFICULTY;

        entry = { value: compact > 0 ? U64 / BigInt(difficulty) : U64, difficulty };
    };

    if (decoded.size >= CACHE_LIMIT) decoded.clear();
    decoded.set(target, entry);

    return entry;
};

export const targetDifficulty = (target: string): number => decode(target).difficulty;

export function difficultyTarget(difficulty: number): string {
    const compact = Math.max(1, Math.min(U32, Math.floor(U32 / Math.max(1, difficulty))));

    const known = encoded.get(compact);
    if (known) return known;

    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt32LE(compact >>> 0, 0);

    const target = buf.toString("hex");

    if (encoded.size >= CACHE_LIMIT) encoded.clear();
    encoded.set(compact, target);

    return target;
};

export function hashValue(result: string): bigint | null {
    if (result.length < 64) return null;

    const hash = Buffer.from(result.length === 64 ? result : result.substring(0, 64), "hex");
    return hash.length === 32 ? hash.readBigUInt64LE(24) : null;
};

export function meetsValue(value: bigint | null, target: string): boolean {
    return value !== null && value <= decode(target).value;
};

export function valueDifficulty(value: bigint | null): number {
    if (value === null) return 0;
    return value > 0n ? Number(U64 / value) : Number.MAX_SAFE_INTEGER;
};

export interface Issue {
    target: string;
    difficulty: number;
};

export class VarDiff {
    public hashrate: number;

    public told: boolean = false;

    public work: number = 0;
    public solved: number = 0;
    public accepted: number = 0;

    private issue: Issue;
    private prior: Issue | null = null;
    private ceiling: Issue | null = null;

    private shares: number = 0;
    private window: number = 0;
    private since: number = Date.now();

    constructor(seed: number) {
        this.hashrate = seed > 0 ? seed : 1000;

        const difficulty = Math.max(MIN_DIFFICULTY, Math.round(this.hashrate * SHARE_SECONDS));
        this.issue = { target: difficultyTarget(difficulty), difficulty };
    };

    public get target(): string { return this.issue.target; };
    public get difficulty(): number { return this.issue.difficulty; };

    public floor(): Issue { return this.prior && this.prior.difficulty < this.issue.difficulty ? this.prior : this.issue; };
    public settle(): void { this.prior = null; };

    public submitted(difficulty: number, count: number = 1): void {
        if (!(count > 0)) return;

        this.shares += count;
        this.accepted += count;

        this.work += difficulty * count;
        this.window += difficulty * count;

        const elapsed = (Date.now() - this.since) / 1000;
        if (this.shares < 4 || elapsed < SHARE_SECONDS * 2) return;

        // Shares only estimate the rate for miners that never state one; a miner that reports is taken at its word.
        const observed = this.window / elapsed;
        if (!this.told) this.hashrate = this.hashrate > 0 ? this.hashrate * 0.6 + observed * 0.4 : observed;

        this.shares = 0;
        this.window = 0;
        this.since = Date.now();
    };

    public observe(hashrate: number): void {
        if (!(hashrate > 0)) return;

        this.told = true;
        this.hashrate = hashrate;
    };

    public credit(solved: number): void { this.solved += solved; };

    public tune(pool: string): string {
        if (this.ceiling?.target !== pool) this.ceiling = { target: pool, difficulty: targetDifficulty(pool) };

        const ceiling = this.ceiling.difficulty;
        const want = Math.min(ceiling, Math.max(MIN_DIFFICULTY, Math.round(this.hashrate * SHARE_SECONDS)));

        let next = this.issue.difficulty;
        if (want > next * RETUNE_RATIO || want * RETUNE_RATIO < next) next = want;

        let target = next >= ceiling ? pool : difficultyTarget(next);
        if (target !== pool && targetDifficulty(target) >= ceiling) target = pool;

        if (target !== this.issue.target) {
            this.prior = this.issue;
            this.issue = { target, difficulty: targetDifficulty(target) };
        };

        return this.issue.target;
    };
};