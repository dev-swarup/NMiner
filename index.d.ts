export class NMiner {
    constructor(pool: string, address: string, pass?: string);
    constructor(pool: string, options?: { pass?: string, mode?: "FAST" | "LIGHT", threads?: number });
    constructor(pool: string, address: string, options?: { pass?: string, mode?: "FAST" | "LIGHT", threads?: number });
};

export class NMinerProxy {
    constructor(pool: string, address: string, options?: { port?: number, onConnection?: (user: string) => Promise<boolean | { pool: string, address: string, pass?: string }> });
    constructor(pool: string, address: string, pass?: string, options?: { port?: number, onConnection?: (user: string) => Promise<boolean | { pool: string, address: string, pass?: string }> });
};