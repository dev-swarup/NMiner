const tls = require("node:tls");
const tcp = require("node:net");
const { WebSocket: Socket } = require("ws");
const { Print, RED, CYAN, GRAY, BLUE_BOLD } = require("./log.js");

const Tcp = (host, port) => new Promise((resolve, reject) => {
    let resolved = false; const t = tls.connect({ host, port, rejectUnauthorized: false }, async () => {
        Print(BLUE_BOLD(" net     "), `use pool ${CYAN(`${host}:${port}`)} ${GRAY(t.remoteAddress)}`);

        t.host = `${host}:${t.remotePort}`;
        resolved = true; setTimeout(() => resolve(t), 100);
    }).once("error", () => {
        if (!resolved) {
            const t = tcp.createConnection({ host, port }, async () => {
                Print(BLUE_BOLD(" net     "), `use pool ${CYAN(`${host}:${port}`)} ${GRAY(t.remoteAddress)}`);

                t.host = `${host}:${t.remotePort}`;
                resolved = true; setTimeout(() => resolve(t), 100);
            }).once("error", () => {
                if (!resolved) {
                    resolved = true;
                    reject(`Failed to connect ${host}:${port}`);
                };
            });
        };
    });
}), WebSocket = (pool, address) => new Promise((resolve, reject) => {
    let resolved = false; const t = (new Socket(pool)).once("open", () => t.send(JSON.stringify(["login", address]))).once("message", data => {
        try {
            data = JSON.parse(data.toString());
            if (data[0] == "login" && typeof data[1] == "object") {
                resolved = true;
                Print(BLUE_BOLD(" net     "), `use pool ${CYAN(`${(new URL(t.url)).hostname}`)}`);

                return resolve({ job: data[1], host: t });
            };

            resolved = true;
            reject(`Login Failed`);
        } catch {
            if (!resolved) {
                resolved = true;
                reject(`Login Failed`);
            };
        };
    }).once("close", () => {
        if (!resolved) {
            resolved = true;
            reject(`Failed to connect ${(new URL(t.url)).hostname}`);
        };
    }).once("error", () => {
        if (!resolved) {
            resolved = true;
            reject(`Failed to connect ${(new URL(t.url)).hostname}`);
        };
    });

    t.host = (new URL(t.url)).hostname;
}),

    loginMiningPool = (pool, user, pass) => new Promise(async (resolve, reject) => {
        pool = pool.split("://");
        pool = pool.length > 1 ? pool[pool.length - 1] : pool[0];

        let resolved = false; try {
            const host = await Tcp(...pool.split(":"));
            host.write(`${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "login", params: { login: user, pass: pass, agent: "NMiner ~ v1.2.1", algo: ["rx/0"] } })}\n`); host.once("data", data => {
                try {
                    data = JSON.parse(data);
                    if (!resolved && data.id == 1) {
                        if ("error" in data && data.error != null)
                            reject(data.error.message);
                        else
                            resolve({ id: data.result.id, job: data.result.job, host });
                    };
                } catch {
                    if (!resolved) {
                        resolved = true;
                        reject("Login Failed");
                    };
                };
            });
        } catch (err) { resolved ? null : reject(err); };
    });


module.exports.Tcp = async (pool, user, pass, on_job, on_close) => {
    on_job = on_job && typeof on_job == "function" ? on_job : () => { };
    on_close = on_close && typeof on_close == "function" ? on_close : () => { };

    try {
        let message_count = 2, message_result = {}; const { id, job, host } = await loginMiningPool(pool, user, pass), keepalived = setInterval(async () => {
            host.write(`${JSON.stringify({ id: message_count++, jsonrpc: "2.0", method: "keepalived", params: { id } })}\n`);
        }, 30000);

        let closed = false; host.on("end", () => { keepalived ? clearInterval(keepalived) : null; closed ? null : on_close(); closed = true; }).on("close", () => { keepalived ? clearInterval(keepalived) : null; closed ? null : on_close(); closed = true; }).on("data", async data => {
            try {
                data = JSON.parse(data);
                if (data?.method == "job")
                    return on_job(data.params);

                if (data.error != null && data.id in message_result) {
                    message_result[data.id].reject(data.error.code);
                    delete message_result[data.id];
                };

                if ("result" in data && data.error == null && data.id in message_result) {
                    message_result[data.id].resolve(message_result[data.id].args);
                    delete message_result[data.id];
                };
            } catch { };
        });

        setTimeout(() => on_job(job), 100); return {
            host, submit: (job_id, nonce, result, ...args) => new Promise((resolve, reject) => {
                let count = message_count++; message_result[count] = { resolve, reject, args };
                host.write(`${JSON.stringify({ id: count, jsonrpc: "2.0", method: "submit", params: { id, job_id, nonce, result } })}\n`);
            })
        };
    } catch (err) { Print(BLUE_BOLD(" net     "), RED(err.toString())); await (() => new Promise(resolve => setTimeout(resolve, 5000)))(); return await module.exports.Tcp(pool, user, pass, on_job, on_close); };
};

module.exports.WebSocket = async (pool, address, on_job, on_close) => {
    on_job = on_job && typeof on_job == "function" ? on_job : () => { };
    on_close = on_close && typeof on_close == "function" ? on_close : () => { };

    try {
        let message_count = 0, message_result = {}; const { job, host } = await WebSocket(pool, address), keepalived = setInterval(async () => {
            host.send(`${JSON.stringify(["keepalive"])}`);
        }, 30000);

        let closed = false; host.on("close", () => { keepalived ? clearInterval(keepalived) : null; closed ? null : on_close(); closed = true; }).on("message", async data => {
            try {
                data = JSON.parse(data);
                if (data[0] == "job" && typeof data[1] == "object")
                    return on_job(data[1]);
                else if (data[0] == "result") {
                    if (data[1] == "rejected" && typeof data[2] == "number") {
                        message_result[data[2]].reject();
                        delete message_result[data[2]];
                    };

                    if (data[1] == "accepted" && typeof data[2] == "number") {
                        message_result[data[2]].resolve(message_result[data[2]].args);
                        delete message_result[data[2]];
                    };
                };
            } catch { };
        });

        setTimeout(() => on_job(job), 100); return {
            host, submit: (job_id, nonce, result, ...args) => new Promise((resolve, reject) => {
                let count = message_count++; message_result[count] = { resolve, reject, args };
                host.send(`${JSON.stringify(["submit", { job_id, nonce, result }, count])}\n`);
            })
        };
    } catch (err) { Print(BLUE_BOLD(" net     "), RED(err.toString())); await (() => new Promise(resolve => setTimeout(resolve, 5000)))(); return await module.exports.WebSocket(pool, address, on_job, on_close); };
};