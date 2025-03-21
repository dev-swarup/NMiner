const
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
    WebSocket = (host, port) => new Promise(async (resolve, reject) => {
        let resolved = false; const t = (new (await import("ws"))({ host, port })).once("open", () => { resolved = true; setTimeout(() => resolve(t), 100); }).once("error", () => {
            if (!resolved) {
                resolved = true;
                reject(`Failed to connect ${host}:${port}`);
            };
        }).once("close", () => {
            if (!resolved) {
                resolved = true;
                reject(`Failed to connect ${host}:${port}`);
            };
        });
    });

module.exports.init = url => new Promise(async (resolve, reject) => {
    try {
        let u = new URL(url), e = new (await import("node:events")).EventEmitter(), id = 1, promises = new Map(), isWebSocket = false, socket; if (["ws:", "wss:"].includes(u.protocol))
            isWebSocket = true;

        const connect = async () => {
            id = 1; socket = await (isWebSocket ? WebSocket : Tcp)(u.hostname, Number(u.port) || u.protocol == "ws:" ? 80 : (u.protocol == "wss:" ? 443 : 8080)); return socket.on("close", () => e.emit("close")).on("end", () => e.emit("close")).on(isWebSocket ? "message" : "data", async data => {
                try {
                    console.log(data);
                    data = JSON.parse(data.toString()); if (isWebSocket) {
                        if (typeof data[0] == "string")
                            return e.emit(data[0], data[1]);

                        if (promises.has(data[0])) {
                            const promise = promises.get(data[0]); clearTimeout(promise.timeout); if (data[1] != null)
                                promise.reject(data[1], ...promise.args);
                            else
                                promise.resolve(data[2], ...promise.args);

                            promises.delete(data[0]);
                        };
                    } else {
                        if ("method" in data)
                            return e.emit(data.method, data.params);
                        if (promises.has(data.id)) {
                            const promise = promises.get(data.id); clearTimeout(promise.timeout); if (data.error != null)
                                promise.reject(data.error.message, ...promise.args);
                            else
                                promise.resolve(data.result, ...promise.args);

                            promises.delete(data.id);
                        };
                    };
                } catch { };
            });
        };

        await connect(); return resolve({
            isWebSocket, on: e.on, once: e.once, connect, close: () => {
                if (isWebSocket)
                    socket.close();
                else {
                    socket.end();
                    socket.destroy();
                };
            }, send: (method, params, ...args) => new Promise((resolve, reject) => {
                let i = id++;
                promises.set(i, {
                    resolve, reject, args, timeout: setTimeout(() => {
                        if (promises.has(i)) {
                            promises.delete(i); reject("Request Timeout");
                        };
                    }, 10000)
                });

                if (isWebSocket)
                    socket.send(JSON.stringify([i, method, params]));
                else
                    socket.write(`${JSON.stringify({ id: i, jsonrpc: "2.0", method, params })}\n`);
            })
        });
    } catch (err) { reject(err); };
});