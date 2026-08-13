export const RETUNE_RATIO = 1.3;
export const SHARE_SECONDS = 15;
export const MIN_DIFFICULTY = 1000;

const U32 = 0xFFFFFFFF;
const U64 = 0xFFFFFFFFFFFFFFFFn;

export function targetDifficulty(target: string): number {
    if (target.length >= 16) {
        const value = Buffer.from(target.substring(0, 16), "hex").readBigUInt64LE(0);
        return value > 0n ? Number(U64 / value) : MIN_DIFFICULTY;
    };

    const compact = Buffer.from(target.padEnd(8, "0").substring(0, 8), "hex").readUInt32LE(0);
    return compact > 0 ? Math.floor(U32 / compact) : MIN_DIFFICULTY;
};

export function difficultyTarget(difficulty: number): string {
    const compact = Math.max(1, Math.min(U32, Math.floor(U32 / Math.max(1, difficulty))));

    const buf = Buffer.allocUnsafe(4);
    buf.writeUInt32LE(compact >>> 0, 0);

    return buf.toString("hex");
};

export function targetValue(target: string): bigint {
    if (target.length >= 16) {
        const value = Buffer.from(target.substring(0, 16), "hex").readBigUInt64LE(0);
        return value > 0n ? value : U64;
    };

    const compact = Buffer.from(target.padEnd(8, "0").substring(0, 8), "hex").readUInt32LE(0);
    return compact > 0 ? U64 / BigInt(Math.floor(U32 / compact)) : U64;
};

export function hashValue(result: string): bigint | null {
    if (result.length < 64) return null;

    const hash = Buffer.from(result.substring(0, 64), "hex");
    return hash.length === 32 ? hash.readBigUInt64LE(24) : null;
};

export function meetsValue(value: bigint | null, target: string): boolean {
    return value !== null && value <= targetValue(target);
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

    public work: number = 0;
    public solved: number = 0;
    public accepted: number = 0;

    private issue: Issue;
    private prior: Issue | null = null;

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

    public submitted(difficulty: number): void {
        this.shares++;
        this.accepted++;

        this.work += difficulty;
        this.window += difficulty;

        const elapsed = (Date.now() - this.since) / 1000;
        if (this.shares < 4 || elapsed < SHARE_SECONDS * 2) return;

        const observed = this.window / elapsed;
        this.hashrate = this.hashrate > 0 ? this.hashrate * 0.6 + observed * 0.4 : observed;

        this.shares = 0;
        this.window = 0;
        this.since = Date.now();
    };

    public credit(solved: number): void { this.solved += solved; };

    public tune(pool: string): string {
        const ceiling = targetDifficulty(pool);
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