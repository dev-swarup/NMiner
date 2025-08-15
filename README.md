# RandomX
RandomX is a proof-of-work (PoW) algorithm optimized for general-purpose CPUs. It uses random code execution (hence the name) combined with several memory-hard techniques to minimize the efficiency advantage of specialized hardware like ASICs.

# NMiner (Node.js Miner)
[![GitHub release](https://img.shields.io/github/release/dev-swarup/NMiner/all.svg)](https://github.com/dev-swarup/NMiner/releases)
[![GitHub license](https://img.shields.io/github/license/dev-swarup/NMiner.svg)](https://github.com/dev-swarup/NMiner/blob/master/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/dev-swarup/NMiner.svg)](https://github.com/dev-swarup/NMiner/stargazers)

NMiner is a silent, high-performance, open-source, cross-platform RandomX CPU miner for Node.js. Official binaries are available for **Windows** and **Linux**.

## 📥 Download
* **[Binary Releases](https://github.com/dev-swarup/NMiner/releases)**

## Usage
### 🚀 NMiner
The `NMiner` class is used to connect directly to a mining pool and start CPU mining.

### Constructor Overloads
```ts
type mode = "FAST" | "LIGHT";

interface MinerOptions {
    mode?: mode;
    proxy?: string;
    threads?: number;
}

new NMiner(pool: string, address?: string);
new NMiner(pool: string, options?: MinerOptions);

new NMiner(pool: string, address: string, pass?: string);
new NMiner(pool: string, address: string, options?: MinerOptions);

new NMiner(pool: string, address: string, pass: string, options?: MinerOptions);
```

### 🌐 NMinerProxy
The `NMinerProxy` class runs a local proxy server that routes mining connections to a pool.
It can be used to hide traffic (via WebSocket) or handle miners on sensitive VPS environments.

### Constructor Overloads
```ts
type connection = { pool: string, address?: string, pass?: string };

interface ProxyOptions {
    port?: number;
    handler?: EventEmitter;
    onShare?: (address: string, target: number, height?: number) => void | Promise<void>;
    onConnection?: (address: string, pass: string, threads: number) => boolean | connection | Promise<boolean | connection>;
}

new NMinerProxy(pool: string, address?: string);
new NMinerProxy(pool: string, options?: ProxyOptions);

new NMinerProxy(pool: string, address: string, pass?: string);
new NMinerProxy(pool: string, address: string, options?: ProxyOptions);

new NMinerProxy(pool: string, address: string, pass: string, options?: ProxyOptions);
```

## Acknowledgements
* [tevador](https://github.com/tevador) - author
* [SChernykh](https://github.com/SChernykh) - contributed significantly to the design of RandomX
* [hyc](https://github.com/hyc) - original idea of using random code execution for PoW
* [swarup](https://github.com/dev-swarup) - Forked RandomX to create NMiner (Node.js Miner)