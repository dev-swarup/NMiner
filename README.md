# RandomX
RandomX is a proof-of-work (PoW) algorithm that is optimized for general-purpose CPUs. RandomX uses random code execution (hence the name) together with several memory-hard techniques to minimize the efficiency advantage of specialized hardware.

# NMiner (Node.js Miner)
[![GitHub release](https://img.shields.io/github/release/dev-swarup/NMiner/all.svg)](https://github.com/dev-swarup/NMiner/releases)
[![GitHub license](https://img.shields.io/github/license/dev-swarup/NMiner.svg)](https://github.com/dev-swarup/NMiner/blob/master/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/dev-swarup/NMiner.svg)](https://github.com/dev-swarup/NMiner/stargazers)

NMiner is a silent, high performance, open source, cross platform RandomX CPU miner. Official binaries are available for Windows and Linux.

## Download
* **[Binary Releases](https://github.com/dev-swarup/NMiner/releases)**

## Usage
### NMiner
The `NMiner` class is used to connect to a mining pool and start mining.

### Constructor Overloads
```ts
new NMiner(pool: string, address?: string);
new NMiner(pool: string, options?: { mode?: "FAST" | "LIGHT", threads?: number });
new NMiner(pool: string, address: string, pass?: string);
new NMiner(pool: string, address: string, options?: { mode?: "FAST" | "LIGHT", threads?: number });
new NMiner(pool: string, address: string, pass: string, options?: { mode?: "FAST" | "LIGHT", threads?: number });
```

### Parameters
- `pool` *(string)*: Mining pool address.
- `address` *(string, optional)*: Wallet address for receiving rewards.
- `pass` *(string, optional)*: Optional password for authentication.
- `options` *(object, optional)*:
  - `mode` *("FAST" | "LIGHT")*: Mining mode (default: "FAST").
  - `threads` *(number)*: Number of CPU threads to use.

### Example Usage
```ts
import { NMiner } from "nmminer";

// Basic usage with only a pool
const miner1 = new NMiner("stratum+tcp://pool.example.com:3333");

// Usage with wallet address
const miner2 = new NMiner("stratum+tcp://pool.example.com:3333", "wallet_address");

// Usage with options
const miner3 = new NMiner("stratum+tcp://pool.example.com:3333", { mode: "LIGHT", threads: 4 });

// Full configuration
const miner4 = new NMiner("stratum+tcp://pool.example.com:3333", "wallet_address", "password", { mode: "FAST", threads: 8 });
```

---

## NMinerProxy
The `NMinerProxy` class acts as an intermediate proxy to route mining connections through WebSocket Protocol to hide the network traffic and run on sensitive VPS.

### Constructor Overloads
```ts
new NMinerProxy(pool: string, address?: string);
new NMinerProxy(pool: string, options?: { port?: number, onConnection?: (address: string, pass: string, cpu: string, threads: number) => true | { pool: string, address?: string, pass?: string } | Promise<true | { pool: string, address?: string, pass?: string }> });
new NMinerProxy(pool: string, address: string, pass?: string);
new NMinerProxy(pool: string, address: string, options?: { port?: number, onConnection?: (address: string, pass: string, cpu: string, threads: number) => true | { pool: string, address?: string, pass?: string } | Promise<true | { pool: string, address?: string, pass?: string }> });
new NMinerProxy(pool: string, address: string, pass: string, options?: { port?: number, onConnection?: (address: string, pass: string, cpu: string, threads: number) => true | { pool: string, address?: string, pass?: string } | Promise<true | { pool: string, address?: string, pass?: string }> });
```

### Parameters
- `pool` *(string)*: Mining pool address.
- `address` *(string, optional)*: Wallet address.
- `pass` *(string, optional)*: Authentication password.
- `options` *(object, optional)*:
  - `port` *(number, optional)*: Proxy listening port.
  - `onConnection` *(function, optional)*: Callback function triggered when a miner connects.

### Example Usage
```ts
import { NMinerProxy } from "nmminer";

// Basic proxy with only a pool
const proxy1 = new NMinerProxy("stratum+tcp://pool.example.com:3333");

// Proxy with a wallet address
const proxy2 = new NMinerProxy("stratum+tcp://pool.example.com:3333", "wallet_address");

// Proxy with custom port and connection handler
const proxy3 = new NMinerProxy("stratum+tcp://pool.example.com:3333", {
    port: 4444,
    onConnection: (address, pass, cpu, threads) => {
        console.log(`New miner: ${address}, CPU: ${cpu}, Threads: ${threads}`);
        return true; // Allow connection
    }
});
```

## Acknowledgements
* [tevador](https://github.com/tevador) - author
* [SChernykh](https://github.com/SChernykh) - contributed significantly to the design of RandomX
* [hyc](https://github.com/hyc) - original idea of using random code execution for PoW
* [swarup](https://github.com/dev-swarup) - Forked RandomX to create NMiner (Node.js Miner)

## Donations
* XMR: `48edfHu7V9Z84YzzMa6fUueoELZ9ZRXq9VetWzYGzKt52XU5xvqgzYnDK9URnRoJMk1j8nLwEVsaSWJ4fhdUyZijBGUicoD`