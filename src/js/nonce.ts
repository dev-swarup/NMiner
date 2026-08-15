export const NONCE_SPACE = 0x100000000;
export const NICEHASH_SPAN = 0x1000000;
export const NICEHASH_SLOTS = 256;

export const MIN_CHUNK = 1 << 12;
export const MAX_CHUNK = 1 << 28;
export const CHUNK_SECONDS = 20;

export interface Segment {
    base: number;
    size: number;
};

export interface NonceSpace {
    index: number;
    cursor: number;
    segments: Segment[];
};

export interface Grant {
    start_nonce: number;
    nonce_limit: number;
};

export const fullSpace = (): NonceSpace => createSpace([{ base: 0, size: NONCE_SPACE }]);
export const createSpace = (segments: Segment[]): NonceSpace => ({ segments: segments.filter(s => s.size > 0), index: 0, cursor: 0 });
export const nicehashSpace = (slot: number, extra: number[] = []): NonceSpace => createSpace([slot, ...extra].map(b => ({ base: b * NICEHASH_SPAN, size: NICEHASH_SPAN })));

export function nicehashSlot(blob: string): number {
    const slot = blob.length >= 86 ? parseInt(blob.substring(84, 86), 16) : 0;
    return Number.isFinite(slot) ? slot : 0;
};

export function spaceTotal(space: NonceSpace): number {
    let total = 0;
    for (const segment of space.segments) total += segment.size;

    return total;
};

export function spaceLeft(space: NonceSpace): number {
    let left = 0;

    for (let i = space.index; i < space.segments.length; i++)         left += space.segments[i].size - (i === space.index ? space.cursor : 0);
    return left > 0 ? left : 0;
};

export function capacity(space: NonceSpace, interval: number): number {
    return spaceTotal(space) / Math.max(0.5, interval / 1000);
};

export function chunkSize(hashrate: number, share: number, deadline: number): number {
    const rate = hashrate > 0 ? hashrate : 1000;
    const window = Math.max(1, Math.min(CHUNK_SECONDS, deadline));

    return Math.max(MIN_CHUNK, Math.min(MAX_CHUNK, Math.ceil(rate * window), Math.max(share, MIN_CHUNK)));
};

export class Ledger {
    private job_id: string = "";
    private prior: Grant[] = [];
    private ranges: Grant[] = [];

    public record(job_id: string, range: Grant): void {
        if (this.job_id !== job_id) {
            this.prior = this.ranges;
            this.ranges = [];
            this.job_id = job_id;
        };

        const last = this.ranges[this.ranges.length - 1];

        if (last && last.nonce_limit === range.start_nonce) last.nonce_limit = range.nonce_limit;
        else this.ranges.push(range);
    };

    public owns(nonce: number): boolean {
        for (let i = this.ranges.length - 1; i >= 0; i--) if (nonce >= this.ranges[i].start_nonce && nonce < this.ranges[i].nonce_limit) return true;
        for (let i = this.prior.length - 1; i >= 0; i--) if (nonce >= this.prior[i].start_nonce && nonce < this.prior[i].nonce_limit) return true;

        return false;
    };
};

export function take(space: NonceSpace, count: number): Grant | null {
    while (space.index < space.segments.length) {
        const segment = space.segments[space.index], left = segment.size - space.cursor;

        if (left <= 0) {
            space.index++;
            space.cursor = 0;

            continue;
        };

        const size = Math.min(Math.max(1, Math.floor(count)), left);
        const start = segment.base + space.cursor;

        space.cursor += size;

        const limit = Math.min(start + size, 0xFFFFFFFF);
        if (limit > start) return { start_nonce: start, nonce_limit: limit };
    };

    return null;
};