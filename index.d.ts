export class NMiner {
    constructor(address: string);
    constructor(pool: string, address: string, pass?: string);
    constructor(address: string, options?: { mode?: "FAST" | "LIGHT", threads?: number });
    constructor(pool: string, address: string, options?: { pass?: string, mode?: "FAST" | "LIGHT", threads?: number });
};