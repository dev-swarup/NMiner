export class NMiner {
    constructor(pool: string, address?: string);
    constructor(pool: string, options?: { mode?: "FAST" | "LIGHT", threads?: number });

    constructor(pool: string, address: string, pass?: string);
    constructor(pool: string, address: string, options?: { mode?: "FAST" | "LIGHT", threads?: number });

    constructor(pool: string, address: string, pass: string, options?: { mode?: "FAST" | "LIGHT", threads?: number });
};

export class NMinerProxy {
    constructor(pool: string, address?: string);
    constructor(pool: string, options?: { port?: number, onConnection?: (user: string) => true | { pool: string, address?: string, pass?: string } | Promise<true | { pool: string, address?: string, pass?: string }> });

    constructor(pool: string, address: string, pass?: string);
    constructor(pool: string, address: string, options?: { port?: number, onConnection?: (user: string) => true | { pool: string, address?: string, pass?: string } | Promise<true | { pool: string, address?: string, pass?: string }> });

    constructor(pool: string, address: string, pass: string, options?: { port?: number, onConnection?: (user: string) => true | { pool: string, address?: string, pass?: string } | Promise<true | { pool: string, address?: string, pass?: string }> });
};