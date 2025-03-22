export class NMiner {
    constructor(pool: string, address?: string);
    constructor(pool: string, options?: { mode?: "FAST" | "LIGHT", threads?: number });

    constructor(pool: string, address: string, pass?: string);
    constructor(pool: string, address: string, options?: { mode?: "FAST" | "LIGHT", threads?: number });

    constructor(pool: string, address: string, pass: string, options?: { mode?: "FAST" | "LIGHT", threads?: number });
};

export class NMinerProxy {
    constructor(pools: Array<{ url: string, address?: string, pass?: string, share?: number }>, options?: { port?: number, onConnection?: (user: string) => Promise<boolean> });
};