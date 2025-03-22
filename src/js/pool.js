const log = require("./log.js"), { WebSocket: Socket } = require("ws"),
    Tcp = (host, port) => new Promise(async (resolve, reject) => {
        let resolved = false; const t = (await import("node:tls")).connect({ host, port, rejectUnauthorized: false }, async () => { resolved = true; setTimeout(() => resolve(t), 100); }).once("error", async () => {
            if (!resolved) {
                const t = (await import("node:net")).createConnection({ host, port }, async () => { resolved = true; setTimeout(() => resolve(t), 100); }).once("error", () => {
                    if (!resolved) {
                        resolved = true;
                        reject(`Failed to connect ${host}:${port}`);
                    };
                });
            };
        });
    }),
    WebSocket = url => new Promise(async (resolve, reject) => {
        let u = new URL(url), resolved = false; const t = (new Socket(url)).on("error", () => {
            if (!resolved) {
                resolved = true;
                reject(`Failed to connect ${u.host}`);
            };
        }).on("close", () => {
            if (!resolved) {
                resolved = true;
                reject(`Failed to connect ${u.host}`);
            };
        });

        resolved = true;
        setTimeout(() => resolve(t), 100);
    });

const init = url => new Promise(async (resolve, reject) => {
    try {
        let u = new URL(url), e = new (await import("node:events")).EventEmitter(), id = 1, promises = new Map(), closed = true, isWebSocket = false, socket; if (["ws:", "wss:"].includes(u.protocol))
            isWebSocket = true;

        const connect = async () => {
            if (!closed) return;
            id = 1; closed = false; socket = isWebSocket ? await WebSocket(url) : await Tcp(u.hostname, u.port);
            return socket.on("close", () => { closed ? null : e.emit("close"); closed = true; }).on("end", () => { closed ? null : e.emit("close"); closed = true; }).on(isWebSocket ? "message" : "data", async data => {
                try {
                    data = JSON.parse(data.toString()); if (isWebSocket) {
                        if (typeof data[0] == "string")
                            return e.emit(data[0], data[1]);

                        if (promises.has(data[0])) {
                            const promise = promises.get(data[0]); clearTimeout(promise.timeout); if (data[1] != null && typeof data[1] == "string")
                                promise.reject(data[1]);
                            else
                                promise.resolve(data[2]);

                            promises.delete(data[0]);
                        };
                    } else {
                        if ("method" in data)
                            return e.emit(data.method, data.params);

                        if (promises.has(data.id)) {
                            const promise = promises.get(data.id); clearTimeout(promise.timeout); if (data.error != null && "message" in data.error)
                                promise.reject(data.error.message);
                            else
                                promise.resolve(data.result);

                            promises.delete(data.id);
                        };
                    };
                } catch (err) { log.Print(log.YELLOW_BOLD(" signal  "), "Program Error: " + err); };
            });
        };

        await connect(); return resolve({
            isWebSocket, hostname: isWebSocket ? u.hostname : u.host, remoteHost: isWebSocket ? null : socket.remoteAddress, on: (...args) => e.on(...args), once: (...args) => e.once(...args), connect, close: () => {
                if (closed)
                    return;

                if (isWebSocket)
                    socket.close();
                else {
                    socket.end();
                    socket.destroy();
                };
            }, send: (method, params) => new Promise((resolve, reject) => {
                let i = id++;
                promises.set(i, {
                    resolve, reject, timeout: setTimeout(() => {
                        if (closed)
                            return promises.delete(i);

                        if (promises.has(i)) {
                            promises.delete(i); reject("30s Timeout");
                        };
                    }, 30000)
                });

                if (isWebSocket)
                    socket.send(JSON.stringify([i, method, params]));
                else
                    socket.write(`${JSON.stringify({ id: i, jsonrpc: "2.0", method, params })}\n`);
            })
        });
    } catch (err) { reject(err); };
});

module.exports.load = require("deasync")(async (walletAddress, resolve) => {
    try {
        const pool = await init("stratum+ssl://us.salvium.herominers.com:1230");
        pool.send("login", { login: walletAddress + ".NMiner", pass: "x", agent: "nodejs", algo: ["rx/0"] }).then(({ job: { seed_hash } }) => {
            pool
                .close(); resolve(null, seed_hash);
        }).catch(err => resolve(err, null));
    } catch (err) { resolve(err, null); };
});

module.exports.connect = (url, address, pass = "x", on_job = () => { }, on_close = () => { }, on_connect = () => { }) => new Promise(async (resolve, reject) => {
    try {
        let id, interval, closed = false, pool = await init(url), Fn = () => new Promise((resolve, reject) => {
            pool.send("login", pool.isWebSocket ? [address, pass] : { login: address, pass: "x", agent: "nodejs", algo: ["rx/0"] }).then(({ id: _id, job }) => {
                id = _id;
                resolve(); setTimeout(() => { on_connect(); on_job(job); }, 500); interval = setInterval(async () => {
                    try {
                        await pool.send("keepalive", pool.isWebSocket ? _id : { id: _id })
                    } catch { };
                }, 60000);
            }).catch(err => reject(err));
        });

        pool.on("job", job => on_job(job)).on("close", async () => {
            if (!closed) {
                if (interval)
                    clearInterval(interval);
                on_close(); setTimeout(async () => {
                    try {
                        await Fn();
                    } catch (err) { log.Print(log.BLUE_BOLD(" net     "), log.RED(err)); setTimeout(() => pool.close(), 10000); };
                }, 10000);
            };
        });

        await Fn(); resolve({
            host: pool.hostname, remoteHost: pool.remoteHost, submit: async (job_id, nonce, result, target) => new Promise((resolve, reject) => {
                if (closed)
                    return reject("pool disconnected, late response", target);

                pool.send("submit", pool.isWebSocket ? [job_id, nonce, result] : { id, job_id, nonce, result })
                    .then(() => resolve(target)).catch(reject);
            }), close: () => { closed = true; pool.close(); }, reconnect: async () => {
                await pool.connect(); await Fn();
            }
        });
    } catch (err) { reject(err); };
});

module.exports.connectSync = require("deasync")(async (url, address, pass = "x", on_job = () => { }, on_close = () => { }, on_connect = () => { }, resolve) => {
    try {
        resolve(null, await module.exports.connect(url, address, pass, on_job, on_close, on_connect));
    } catch (err) { resolve(err, null); };
});