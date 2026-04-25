const dns = require("dns");
const net = require("net");
const tls = require("tls");

dns.setServers(["1.1.1.1", "1.0.0.1"]); Object.assign(dns, {
    get: hostname => new Promise(resolve => dns.lookup(hostname, { family: 4 }, (err, address) => {
        if (err || !address)
            return resolve(hostname);
        return resolve(address);
    }))
});

const { WebSocket } = require("ws");
const { SocksClient } = require("socks");
const { hash, encrypt, decrypt, createExchange, generateHandshake } = require("./crypto.js");

const log = require("./log.js"),
    Tcp = (host, port, agent) => new Promise(async (resolve, reject) => {
        let gt, socket, resolved = false, resolvedHost = await dns.get(host);

        if (agent)
            try {
                gt = async () => {
                    agent = new URL(agent);

                    const pt = Number(agent.port);
                    const username = agent.username.length > 0 ? decodeURIComponent(agent.username) : undefined;
                    const password = agent.password.length > 0 ? decodeURIComponent(agent.password) : undefined;

                    const client = await SocksClient.createConnection({
                        proxy: {
                            type: agent.protocol.startsWith("socks4") ? 4 : 5,

                            port: pt,
                            host: agent.hostname,
                            userId: username, password: password
                        },
                        command: "connect",
                        destination: { host: resolvedHost, port: Number(port) }
                    });

                    socket = client.socket;
                };

                await gt();
            } catch { resolved = true; return reject(`Failed to connect to "${agent}"`); };

        const t = tls.connect({ ...(socket ? { socket } : { host: resolvedHost, port }), servername: host, rejectUnauthorized: false }, async () => { resolved = true; setTimeout(async () => resolve({ socket: t, remoteAddress: agent ? await dns.get(agent.hostname) : resolvedHost }), 100); }).once("error", async () => {
            if (!resolved)
                if (agent) {
                    if (socket.destroyed) {
                        try {
                            await gt();
                            resolved = true;
                            setTimeout(async () => resolve({ socket, remoteAddress: agent ? await dns.get(agent.hostname) : resolvedHost }), 100);
                        } catch { resolved = true; return reject(`Failed to connect to ${host}:${port}`); };
                    } else {
                        resolved = true;
                        setTimeout(async () => resolve({ socket, remoteAddress: agent ? await dns.get(agent.hostname) : resolvedHost }), 100);
                    };
                } else {
                    const t = net.createConnection({ host: resolvedHost, port }, async () => { resolved = true; setTimeout(async () => resolve({ socket: t, remoteAddress: agent ? await dns.get(agent.hostname) : resolvedHost }), 100); }).once("error", () => {
                        if (!resolved) {
                            resolved = true;
                            reject(`Failed to connect ${host}:${port}`);
                        };
                    });
                };
        });
    }),
    Wss = (url, agent) => new Promise(async (resolve, rej) => {
        let u = new URL(url), resolved = false, resolvedHost = await dns.get(u.hostname); reject = () => {
            resolved = true;
            rej(`Failed to connect ${u.host}`);
        };

        const ecdh = createExchange(), publicSalt = ecdh.generateKeys("hex"), t = (new WebSocket(url, {
            headers: {
                "x-public-salt": publicSalt
            },
            ...(agent ? { agent: new ((await import("proxy-agent")).ProxyAgent)(agent) } : {})
        }))
            .on("open", () => {
                resolved = true;
                setTimeout(async () => resolve({ socket: t, remoteAddress: resolvedHost }), 100);
            })
            .on("error", () => resolved ? null : reject()).on("close", () => resolved ? null : reject())
            .on("upgrade", res => {
                const privateHash = res.headers["x-private-salt"];

                if (!privateHash)
                    return t.terminate();

                t.session = hash(ecdh.computeSecret(privateHash, "hex"));
            });
    });

const init = (url, agent) => new Promise(async (resolve, reject) => {
    try {
        let u = new URL(url), e = new (await import("node:events")).EventEmitter(), isWebSocket = false, socket;

        if (["ws:", "wss:"].includes(u.protocol))
            isWebSocket = true;

        const connect = async () => {
            if (socket && !socket.closed)
                return;

            socket = { id: 1, closed: false, promises: new Map(), ...(isWebSocket ? await Wss(url, agent) : await Tcp(u.hostname, u.port, agent)) };

            ["end", "close"].forEach(j =>
                socket.socket.on(j, () => { socket.closed ? null : e.emit("close"); socket.closed = true; }));

            return socket.socket.on(isWebSocket ? "message" : "data", async data => {
                try {
                    data = data.toString();

                    if (isWebSocket && socket.socket.session)
                        data = decrypt(socket.socket.session, data);
                    else
                        data = JSON.parse(data);

                    if (isWebSocket) {
                        if (typeof data[0] == "string")
                            return e.emit(data[0], data[1]);

                        if (socket.promises.has(data[0])) {
                            const promise = socket.promises.get(data[0]); clearTimeout(promise.timeout);

                            if (data[1] != null && typeof data[1] == "string")
                                promise.reject(data[1]);
                            else
                                promise.resolve(data[2]);

                            socket.promises.delete(data[0]);
                        };
                    } else {
                        if ("method" in data)
                            return e.emit(data.method, data.params);

                        if (socket.promises.has(data.id)) {
                            const promise = socket.promises.get(data.id); clearTimeout(promise.timeout);

                            if (data.error != null && "message" in data.error)
                                promise.reject(data.error.message);
                            else
                                promise.resolve(data.result);

                            socket.promises.delete(data.id);
                        };
                    };
                } catch (err) { log.Print(log.YELLOW_BOLD(" signal  "), "JSON Error: " + err.stack); };
            });
        };

        await connect(); return resolve({
            isWebSocket, hostname: isWebSocket ? u.hostname : u.host, remoteAddress: socket.remoteAddress, on: (...args) => e.on(...args), once: (...args) => e.once(...args), connect, close: () => {
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
                            reject("Timeout");
                            socket.promises.delete(ii);
                        };
                    }, 30000)
                });

                if (isWebSocket && socket.socket.session)
                    socket.socket.send(encrypt(socket.socket.session, [ii, method, params]));
                else
                    socket.socket.write(`${JSON.stringify({ id: ii, jsonrpc: "2.0", method, params })}\n`);
            })
        });
    } catch (err) { reject(err?.stack || err); };
});

module.exports.connect = (url, address, pass = "x", agent, on_job = () => { }, on_close = () => { }, on_connect = () => { }) => new Promise(async (resolve, reject) => {
    try {
        let session; const pool = await init(url, agent), Fn = () => new Promise((resolve, reject) => {
            if (session && !session.closed)
                return;

            pool.send("login", pool.isWebSocket ? [address, pass] : { login: address, pass: "x", agent: "nodejs / v1.2.2", algo: ["rx/0"], extensions: ["nicehash", "keepalive"] }).then(({ id: _id, job, extensions }) => {
                resolve(); session = {
                    id: _id, closed: false, interval: setInterval(async () => {
                        try {
                            if (pool.isWebSocket)
                                await pool.send("keepalived", _id);

                            if (!pool.isWebSocket && Array.isArray(extensions) && extensions.includes("keepalive"))
                                await pool.send("keepalive", { id: _id });
                        } catch { };
                    }, 60000)
                };

                setTimeout(() => { on_connect(); on_job({ job_id: job.job_id, seed_hash: job.seed_hash, target: job.target, blob: job.blob, ...("height" in job ? { height: job.height } : {}) }); }, 100);
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
            host: pool.hostname, remoteHost: pool.remoteAddress, isWebSocket: pool.isWebSocket, submit: (job_id, nonce, result, target, height) => new Promise((resolve, reject) => {
                if (session.closed)
                    return reject("pool disconnected, late response", target);

                pool.send("submit", pool.isWebSocket ? [job_id, nonce, result, target, height] : { id: session.id, job_id, nonce, result })
                    .then(() => resolve(target)).catch(reject);
            }),
            close: () => { session.closed = true; pool.close(); },
            reconnect: async () => { await pool.connect(); await Fn(); }
        });
    } catch (err) { reject(err?.stack || err); };
});