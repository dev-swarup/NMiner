const log = require("./log.js"), Socket = require("ws").WebSocket, { SocksClient } = require("socks"), { SocksProxyAgent } = require("socks-proxy-agent"),
    Tcp = (host, port, agent) => new Promise(async (resolve, reject) => {
        let gt, socket, resolved = false;

        if (agent)
            try {
                gt = async () => {
                    agent = new URL(agent);

                    const pt = Number(agent.port) || 1080;
                    const username = agent.username.length > 0 ? decodeURIComponent(agent.username) : undefined;
                    const password = agent.password.length > 0 ? decodeURIComponent(agent.password) : undefined;

                    const client = await SocksClient.createConnection({
                        proxy: {
                            type: 5,
                            port: pt,
                            host: agent.hostname,
                            userId: username, password: password
                        },
                        command: "connect",
                        destination: { host, port: Number(port) }
                    });

                    socket = client.socket;
                };

                await gt();
            } catch { resolved = true; return reject(`Failed to connect to Proxy "${agent}"`); };

        const t = (await import("node:tls")).connect({ ...(socket ? { socket, servername: host } : { host, port }), rejectUnauthorized: false }, async () => { resolved = true; setTimeout(() => resolve(t), 100); }).once("error", async () => {
            if (!resolved)
                if (agent) {
                    if (socket.destroyed) {
                        try {
                            await gt();
                            resolved = true;
                            setTimeout(() => resolve(socket), 100);
                        } catch { resolved = true; return reject(`Failed to connect to TCP Socket ${host}:${port}`); };
                    } else { resolved = true; setTimeout(() => resolve(socket), 100); };
                } else {
                    const t = (await import("node:net")).createConnection({ host, port }, async () => { resolved = true; setTimeout(() => resolve(t), 100); }).once("error", () => {
                        if (!resolved) {
                            resolved = true;
                            reject(`Failed to connect ${host}:${port}`);
                        };
                    });
                };
        });
    }),
    Wss = (url, agent) => new Promise(async (resolve, rej) => {
        let u = new URL(url), resolved = false; reject = () => {
            resolved = true;
            rej(`Failed to connect ${u.host}`);
        };

        const t = (new Socket(url, agent ? { agent: new SocksProxyAgent(agent) } : {})).on("open", () => {
            resolved = true;
            setTimeout(() => resolve(t), 100);
        }).on("error", () => resolved ? null : reject()).on("close", () => resolved ? null : reject());
    });

const init = (url, agent) => new Promise(async (resolve, reject) => {
    try {
        let u = new URL(url), e = new (await import("node:events")).EventEmitter(), isWebSocket = false, socket; if (["ws:", "wss:"].includes(u.protocol))
            isWebSocket = true;

        const connect = async () => {
            if (socket && !socket.closed)
                return;

            socket = { id: 1, closed: false, promises: new Map(), socket: isWebSocket ? await Wss(url, agent) : await Tcp(u.hostname, u.port, agent) };
            return socket.socket.on("close", () => { socket.closed ? null : e.emit("close"); socket.closed = true; }).on("end", () => { socket.closed ? null : e.emit("close"); socket.closed = true; }).on(isWebSocket ? "message" : "data", async data => {
                try {
                    data = JSON.parse(data.toString()); if (isWebSocket) {
                        if (typeof data[0] == "string")
                            return e.emit(data[0], data[1]);

                        if (socket.promises.has(data[0])) {
                            const promise = socket.promises.get(data[0]); clearTimeout(promise.timeout); if (data[1] != null && typeof data[1] == "string")
                                promise.reject(data[1]);
                            else
                                promise.resolve(data[2]);

                            socket.promises.delete(data[0]);
                        };
                    } else {
                        if ("method" in data)
                            return e.emit(data.method, data.params);

                        if (socket.promises.has(data.id)) {
                            const promise = socket.promises.get(data.id); clearTimeout(promise.timeout); if (data.error != null && "message" in data.error)
                                promise.reject(data.error.message);
                            else
                                promise.resolve(data.result);

                            socket.promises.delete(data.id);
                        };
                    };
                } catch (err) { log.Print(log.YELLOW_BOLD(" signal  "), "JSON Error: " + err); };
            });
        };

        await connect(); return resolve({
            isWebSocket, hostname: isWebSocket ? u.hostname : u.host, remoteHost: isWebSocket ? null : socket.socket.remoteAddress, on: (...args) => e.on(...args), once: (...args) => e.once(...args), connect, close: () => {
                if (socket?.closed)
                    return;

                if (isWebSocket)
                    socket.socket.close();
                else {
                    socket.socket.end();
                    socket.socket.destroy();
                };

                socket.closed = true;
            }, send: (method, params) => new Promise((resolve, reject) => {
                let ii = socket.id++;
                socket.promises.set(ii, {
                    resolve, reject, timeout: setTimeout(() => {
                        if (socket.closed)
                            return socket.promises.delete(ii);

                        if (socket.promises.has(ii)) {
                            reject("30s Timeout");
                            socket.promises.delete(ii);
                        };
                    }, 30000)
                });

                if (isWebSocket)
                    socket.socket.send(JSON.stringify([ii, method, params]));
                else
                    socket.socket.write(`${JSON.stringify({ id: ii, jsonrpc: "2.0", method, params })}\n`);
            })
        });
    } catch (err) { reject(err); };
});

module.exports.connect = (url, address, pass = "x", agent, on_job = () => { }, on_close = () => { }, on_connect = () => { }) => new Promise(async (resolve, reject) => {
    try {
        let session; const pool = await init(url, agent), Fn = () => new Promise((resolve, reject) => {
            if (session && !session.closed)
                return;

            pool.send("login", pool.isWebSocket ? [address, pass] : { login: address, pass: "x", agent: "nodejs / v1.2.2", algo: ["rx/0"] }).then(({ id: _id, job }) => {
                resolve(); session = {
                    id: _id, closed: false, interval: setInterval(async () => {
                        try {
                            await pool.send("keepalived", pool.isWebSocket ? _id : { id: _id })
                        } catch { };
                    }, 60000)
                };

                setTimeout(() => { on_connect(); on_job({ job_id: job.job_id, seed_hash: job.seed_hash, target: job.target, blob: job.blob, ...("height" in job ? { height: job.height } : {}) }); }, 500);
            }).catch(err => { reject(err); pool.close(); });
        });

        pool.on("job", job => on_job({ job_id: job.job_id, seed_hash: job.seed_hash, target: job.target, blob: job.blob, ...("height" in job ? { height: job.height } : {}) })).on("close", async () => {
            if (session && !session.closed) {
                if (session.interval)
                    clearInterval(session.interval);

                session.closed = true; (async function repeat() {
                    if (await on_close())
                        setTimeout(async () => {
                            try {
                                await pool.connect(); await Fn();
                            } catch (err) { log.Print(log.BLUE_BOLD(" net     "), log.RED(err)); pool.close(); repeat(); };
                        }, 10000);
                })();
            };
        });

        await Fn(); resolve({
            host: pool.hostname, remoteHost: pool.remoteHost, isWebSocket: pool.isWebSocket, submit: (job_id, nonce, result, target, height) => new Promise((resolve, reject) => {
                if (session.closed)
                    return reject("pool disconnected, late response", target);

                pool.send("submit", pool.isWebSocket ? [job_id, nonce, result, target, height] : { id: session.id, job_id, nonce, result })
                    .then(() => resolve(target)).catch(reject);
            }),
            close: () => { session.closed = true; pool.close(); },
            reconnect: async () => { await pool.connect(); await Fn(); }
        });
    } catch (err) { reject(err); };
});