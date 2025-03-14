const tls = require("node:tls");
const tcp = require("node:net");
const { Print, RED, CYAN, GRAY, BLUE_BOLD } = require("./log.js");

const connect = (host, port) => new Promise((resolve, reject) => {
    let resolved = false; const t = tls.connect({ host, port, rejectUnauthorized: false }, async () => {
        Print(BLUE_BOLD(" net     "), `use pool ${CYAN(`${host}:${port}`)} ${GRAY(t.remoteAddress)}`);

        t.host = `${host}:${t.remotePort}`;
        resolved = true; setTimeout(() => resolve(t), 100);
    }).once("error", () => {
        if (!resolved) {
            const t = tcp.createConnection({ host, port }, async () => {
                Print(BLUE_BOLD(" net     "), `use pool ${CYAN(`${host}:${port}`)} ${GRAY(socket.remoteAddress)}`);

                t.host = `${host}:${t.remotePort}`;
                resolved = true; setTimeout(() => resolve(t), 100);
            }).once("error", () => {
                if (!resolved) {
                    resolved = true;
                    reject(`Failed to connect to ${host}:${port}`);
                };
            });
        };
    });
}), loginPool = (pool, user, pass) => new Promise(async (resolve, reject) => {
    pool = pool.split("://");
    pool = pool.length > 1 ? pool[pool.length - 1] : pool[0];

    let resolved = false; try {
        const host = await connect(...pool.split(":"));
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


module.exports = async (pool, user, pass, on_job, on_close) => {
    on_job = on_job && typeof on_job == "function" ? on_job : () => { };
    on_close = on_close && typeof on_close == "function" ? on_close : () => { };

    try {
        const { id, job, host } = await loginPool(pool, user, pass);
        let closed = false; host.on("close", () => { closed ? null : on_close(); closed = true; }).on("data", async data => {
            try {
                data = JSON.parse(data);
                if (data?.method == "job")
                    return on_job(data.params);
                console.log(data);
            } catch { };
        });

        setTimeout(() => on_job(job), 100); return { id, host };
    } catch (err) { Print(BLUE_BOLD(" net     "), RED(err.toString())); return {}; };
};