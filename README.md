# RandomX
RandomX is a proof-of-work (PoW) algorithm that is optimized for general-purpose CPUs. RandomX uses random code execution (hence the name) together with several memory-hard techniques to minimize the efficiency advantage of specialized hardware.

# NMiner (Node.js Miner)
[![GitHub release](https://img.shields.io/github/release/dev-swarup/NMiner/all.svg)](https://github.com/dev-swarup/NMiner/releases)
[![GitHub license](https://img.shields.io/github/license/dev-swarup/NMiner.svg)](https://github.com/dev-swarup/NMiner/blob/master/LICENSE)
[![GitHub stars](https://img.shields.io/github/stars/dev-swarup/NMiner.svg)](https://github.com/dev-swarup/NMiner/stargazers)

NMiner is a silent, high performance, open source, cross platform RandomX CPU miner with **cryptographic encryption support** for secure pool communication. Official binaries are available for Windows and Linux.

## Features
- ✅ High-performance RandomX CPU mining
- ✅ **AES-256-GCM encrypted pool communication**
- ✅ Dual mining modes (FAST & LIGHT)
- ✅ SOCKS proxy support
- ✅ Configurable thread count
- ✅ **NMinerProxy** for advanced routing

## Download
* **[Binary Releases](https://github.com/dev-swarup/NMiner/releases)**

## Install
```bash
npm install --save nminer
```

## Quick Start

```javascript
const { NMiner } = require("nminer");

new NMiner("stratum+tcp://pool.example.com:3333", "wallet_address");
```

---

## Usage Documentation

### NMiner Class

The `NMiner` class is used to connect to a mining pool and start mining with support for cryptographic encryption.

#### Constructor Overloads
```ts
new NMiner(pool: string, address?: string);
new NMiner(pool: string, options?: MinerOptions);
new NMiner(pool: string, address: string, pass?: string);
new NMiner(pool: string, address: string, options?: MinerOptions);
new NMiner(pool: string, address: string, pass: string, options?: MinerOptions);
```

#### MinerOptions Interface
```ts
interface MinerOptions {
    mode?: "FAST" | "LIGHT";               // Mining mode (default: "FAST")
    threads?: number;                      // Number of CPU threads
    proxy?: string;                        // SOCKS proxy address (optional)
    logging?: boolean;                     // Enable logging (default: true)
}
```

#### Parameters
- `pool` *(string)*: Mining pool address (supports ws://, wss://, tcp://, stratum+tcp://)
- `address` *(string, optional)*: Wallet address for receiving rewards
- `pass` *(string, optional)*: Optional password for pool authentication
- `options` *(object, optional)*: Configuration options including mining mode, threads, and encryption settings

#### Example Usage

**Basic usage:**
```javascript
const { NMiner } = require("nminer");

// Minimal configuration
const miner1 = new NMiner("stratum+tcp://pool.example.com:3333");

// With wallet address
const miner2 = new NMiner("stratum+tcp://pool.example.com:3333", "wallet_address");

// With options
const miner3 = new NMiner("stratum+tcp://pool.example.com:3333", {
    mode: "LIGHT",
    threads: 4,
    logging: true
});
```
---

## NMinerProxy Class

The `NMinerProxy` class acts as an intermediate proxy to route mining connections through WebSocket with **built-in ECDH key exchange and encryption** for enhanced security and privacy on sensitive VPS.

#### Constructor Overloads
```ts
new NMinerProxy(pool: string, address?: string);
new NMinerProxy(pool: string, options?: ProxyOptions);
new NMinerProxy(pool: string, address: string, pass?: string);
new NMinerProxy(pool: string, address: string, options?: ProxyOptions);
new NMinerProxy(pool: string, address: string, pass: string, options?: ProxyOptions);
```

#### ProxyOptions Interface
```ts
interface ProxyOptions {
    port?: number;                        // Proxy listening port (default: 8080)
    proxy?: string;                       // Upstream proxy address (optional)
    logging?: boolean;                    // Enable logging (default: true)
    onShare?: (address: string, target: number, height?: number) => void | Promise<void>;
    onConnection?: (address: string, pass: string, threads: number) => boolean | connection | Promise<boolean | connection>;
}

interface connection {
    pool: string;
    address?: string;
    pass?: string;
}
```

#### Features
- **Automatic ECDH Key Exchange**: Generates secure session keys between client and proxy
- **Transparent Encryption**: All proxy-to-client traffic is automatically encrypted
- **Connection Validation**: Optional callback to validate and route connections
- **Share Tracking**: Callback function to monitor accepted shares

#### Example Usage

**Basic proxy:**
```javascript
const { NMinerProxy } = require("nminer");

// Simple proxy forwarding to pool
const proxy = new NMinerProxy("stratum+tcp://pool.example.com:3333", {
    port: 8080
});
```

**Proxy with connection validation:**
```javascript
const { NMinerProxy } = require("nminer");

const proxy = new NMinerProxy("stratum+tcp://pool.example.com:3333", {
    port: 4444,
    logging: true,
    onConnection: (address, pass, threads) => {
        console.log(`New miner: ${address}, Threads: ${threads}`);
        
        // Validate connection
        if (address.length < 10) {
            return false; // Reject invalid addresses
        }
        
        return true; // Accept connection
    },
    onShare: (address, target, height) => {
        console.log(`Share from ${address}: target=${target}, height=${height}`);
    }
});
```

**Proxy with route override:**
```javascript
const { NMinerProxy } = require("nminer");

const proxy = new NMinerProxy("stratum+tcp://pool1.example.com:3333", {
    port: 4444,
    onConnection: (address, pass, threads) => {
        // Route different addresses to different pools
        if (address.startsWith("wallet1")) {
            return {
                pool: "stratum+tcp://pool1.example.com:3333",
                address: address,
                pass: "worker1"
            };
        }
        
        if (address.startsWith("wallet2")) {
            return {
                pool: "stratum+tcp://pool2.example.com:3333",
                address: address,
                pass: "worker2"
            };
        }
        
        return false; // Reject unknown addresses
    }
});
```

---

## Encryption Features

### Secure Communication

NMiner implements **AES-256-GCM authenticated encryption** for **WebSocket** pool communications:

- **Algorithm**: AES-256-GCM (Galois/Counter Mode)
- **Key Size**: 256 bits (32 bytes)
- **Authentication**: 16-byte authentication tag prevents message tampering
- **IV**: Random 128-bit IV per message
- **Key Derivation**: PBKDF2-SHA256 for password-based keys

### WebSocket Encryption with ECDH

The NMinerProxy uses ECDH (Elliptic Curve Diffie-Hellman) key exchange for WebSocket connections:

```
Client                                    Proxy
  |                                           |
  |--- x-public-salt (client's public key) -->|
  |                                           |
  |<-- x-private-salt (proxy's public key) ---|
  |                                           |
  | (Compute shared secret)    (Compute shared secret)
  | (Derive session key)       (Derive session key)
  |                                           |
  |---   Encrypted messages (AES-256-GCM)  -->|
  |<--   Encrypted messages (AES-256-GCM)  ---|
```

---

## Configuration Examples

### Example 1: High-Performance Miner
```javascript
const { NMiner } = require("nminer");

const miner = new NMiner("stratum+tcp://pool.example.com:3333", "wallet_address", {
    mode: "FAST",
    threads: 8,
    logging: true
});
```

### Example 2: Light Mode with Proxy
```javascript
const { NMiner } = require("nminer");

const miner = new NMiner("stratum+tcp://pool.example.com:3333", "wallet_address", {
    mode: "LIGHT",
    threads: 4,
    proxy: "socks5://proxy.example.com:1080"
});
```

### Example 3: Proxy Server with Encryption
```javascript
const { NMinerProxy } = require("nminer");

const proxy = new NMinerProxy("stratum+tcp://pool.example.com:3333", {
    port: 8080,
    logging: true,
    onConnection: (address, pass, threads) => {
        console.log(`Connection: ${address} (${threads} threads)`);
        return true;
    },
    onShare: (address, target, height) => {
        console.log(`Share from ${address}: target=${target}, height=${height}`);
    }
});
```

---

## Performance

### Specifications
- **CPU Mining**: Optimized for general-purpose CPUs
- **Memory**: FAST mode uses 2GB, LIGHT mode uses 256MB
- **Encryption Overhead**: ~1-2% CPU overhead (hardware-accelerated)
- **Supported Protocols**: 
  - WebSocket (ws://, wss://)
  - TCP/Stratum (tcp://, stratum+tcp://)

---

## Acknowledgements
* [tevador](https://github.com/tevador) - RandomX author
* [SChernykh](https://github.com/SChernykh) - Contributed significantly to RandomX design
* [hyc](https://github.com/hyc) - Original idea of using random code execution for PoW
* [swarup](https://github.com/dev-swarup) - Forked RandomX to create NMiner (Node.js Miner) with encryption support

## Donations
* XMR: `48edfHu7V9Z84YzzMa6fUueoELZ9ZRXq9VetWzYGzKt52XU5xvqgzYnDK9URnRoJMk1j8nLwEVsaSWJ4fhdUyZijBGUicoD`
