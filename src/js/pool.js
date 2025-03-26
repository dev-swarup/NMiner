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
        let u = new URL(url), resolved = false; const t = (new Socket(url)).on("open", () => {
            resolved = true;
            setTimeout(() => resolve(t), 100);
        }).on("error", () => {
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
    });

const init = url => new Promise(async (resolve, reject) => {
    try {
        let u = new URL(url), e = new (await import("node:events")).EventEmitter(), isWebSocket = false, sockets = {}; if (["ws:", "wss:"].includes(u.protocol))
            isWebSocket = true;

        const connect = async i => {
            if (i in sockets && !sockets[i].closed)
                return;

            sockets[i] = { id: 1, closed: false, promises: new Map(), socket: isWebSocket ? await WebSocket(url) : await Tcp(u.hostname, u.port) };
            return sockets[i].socket.on("close", () => { sockets[i].closed ? null : e.emit("close", i); sockets[i].closed = true; }).on("end", () => { sockets[i].closed ? null : e.emit("close", i); sockets[i].closed = true; }).on(isWebSocket ? "message" : "data", async data => {
                try {
                    data = JSON.parse(data.toString()); if (isWebSocket) {
                        if (typeof data[0] == "string")
                            return e.emit(data[0], data[1], i);

                        if (sockets[i].promises.has(data[0])) {
                            const promise = sockets[i].promises.get(data[0]); clearTimeout(promise.timeout); if (data[1] != null && typeof data[1] == "string")
                                promise.reject(data[1]);
                            else
                                promise.resolve(data[2]);

                            sockets[i].promises.delete(data[0]);
                        };
                    } else {
                        if ("method" in data)
                            return e.emit(data.method, data.params, i);

                        if (sockets[i].promises.has(data.id)) {
                            const promise = sockets[i].promises.get(data.id); clearTimeout(promise.timeout); if (data.error != null && "message" in data.error)
                                promise.reject(data.error.message);
                            else
                                promise.resolve(data.result);

                            sockets[i].promises.delete(data.id);
                        };
                    };
                } catch (err) { log.Print(log.YELLOW_BOLD(" signal  "), "Program Error: " + err); };
            });
        };

        await connect(0); return resolve({
            isWebSocket, hostname: isWebSocket ? u.hostname : u.host, remoteHost: isWebSocket ? null : sockets[0].socket.remoteAddress, on: (...args) => e.on(...args), once: (...args) => e.once(...args), connect, close: i => {
                if (sockets[i].closed)
                    return;

                if (isWebSocket)
                    sockets[i].socket.close();
                else {
                    sockets[i].socket.end();
                    sockets[i].socket.destroy();
                };

                sockets[i].closed = true;
            }, send: (i, method, params) => new Promise((resolve, reject) => {
                let ii = sockets[i].id++;
                sockets[i].promises.set(ii, {
                    resolve, reject, timeout: setTimeout(() => {
                        if (sockets[i].closed)
                            return sockets[i].promises.delete(ii);

                        if (sockets[i].promises.has(ii)) {
                            reject("30s Timeout");
                            sockets[i].promises.delete(ii);
                        };
                    }, 30000)
                });

                if (isWebSocket)
                    sockets[i].socket.send(JSON.stringify([ii, method, params]));
                else
                    sockets[i].socket.write(`${JSON.stringify({ id: ii, jsonrpc: "2.0", method, params })}\n`);
            })
        });
    } catch (err) { reject(err); };
});

const multiConnect = (url, address, pass = "x", on_job = () => { }, on_close = () => { }, on_connect = () => { }) => new Promise(async (resolve, reject) => {
    try {
        let sessions = []; const pool = await init(url), Fn = i => new Promise((resolve, reject) => {
            pool.send(i, "login", pool.isWebSocket ? [address, pass] : { login: address, pass: "x", agent: "nodejs", algo: ["rx/0"] }).then(({ id: _id, job }) => {
                resolve(); sessions[i] = {
                    id: _id, closed: false, interval: setInterval(async () => {
                        try {
                            await pool.send(0, "keepalived", pool.isWebSocket ? _id : { id: _id })
                        } catch { };
                    }, 60000)
                };

                setTimeout(() => { on_connect(i); on_job(i, { job_id: job.job_id, seed_hash: job.seed_hash, target: job.target, blob: job.blob, ...("height" in job ? { height: job.height } : {}) }); }, 500);
            }).catch(err => { reject(err); pool.close(i); });
        });

        pool.on("job", (job, i) => on_job(i, { job_id: job.job_id, seed_hash: job.seed_hash, target: job.target, blob: job.blob, ...("height" in job ? { height: job.height } : {}) })).on("close", async i => {
            if (i in sessions && !sessions[i].closed) {
                if (sessions[i].interval)
                    clearInterval(sessions[i].interval);
            };

            if (await on_close(i))
                setTimeout(async () => {
                    try {
                        await pool.connect(i); await Fn(i);
                    } catch (err) { log.Print(log.BLUE_BOLD(" net     "), log.RED(err)); setTimeout(() => pool.close(i), 10000); };
                }, 10000);
        });

        await Fn(0); resolve({
            host: pool.hostname, remoteHost: pool.remoteHost, isWebSocket: pool.isWebSocket, submit: (i, job_id, nonce, result, target) => new Promise((resolve, reject) => {
                if (sessions[i].closed)
                    return reject("pool disconnected, late response", target);

                pool.send(i, "submit", pool.isWebSocket ? [job_id, nonce, result] : { id: sessions[i].id, job_id, nonce, result })
                    .then(() => resolve(target)).catch(reject);
            }), close: i => { sessions[i].closed = true; pool.close(i); }, reconnect: async i => {
                await pool.connect(i); await Fn(i);
            }
        });
    } catch (err) { reject(err); };
});

module.exports.connect = (url, address, pass = "x", on_job = () => { }, on_close = () => { }, on_connect = () => { }) => new Promise(async (resolve, reject) => {
    try {
        const pool = await multiConnect(url, address, pass, (i, job) => on_job(job), () => { on_close(); return true; }, () => on_connect());

        return resolve({
            host: pool.host, remoteHost: pool.remoteHost, submit: (job_id, nonce, result, target) => pool.submit(0, job_id, nonce, result, target),
            close: () => pool.close(0),
            reconnect: () => pool.reconnect(0),
        });
    } catch (err) { reject(err); };
});