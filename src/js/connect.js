const { print } = require("./log.js");
const { connect } = require("node:tls");
const { createConnection } = require("node:net");

const GetHost = (host, port) => new Promise((resolve, reject) => {
    const tls = connect({ host, port, rejectUnauthorized: false }, async () => {
        print("net", `use pool ${`${host}:${port}`.cyan} ${tls.remoteAddress.gray} ${"+TLS".green}`);

        tls.host = `${host}:${tls.remotePort}`;
        resolve(tls);
    }).on("error", () => {
        const socket = createConnection({ host, port }, async () => {
            print("net", `use pool ${`${host}:${port}`.cyan} ${socket.remoteAddress.gray}`);

            socket.host = `${host}:${socket.remotePort}`;
            resolve(socket);
        }).on("error", err => reject(err));
    });
});

const GetPool = (pool, user, pass = "x") => new Promise(async (resolve, reject) => {
    pool = pool.split("://");
    try {
        const host = await GetHost(...(pool.length == 1 ? pool[0].split(":") : pool[1].split(":")));
        host.write(`${JSON.stringify({ id: 1, jsonrpc: "2.0", method: "login", params: { login: user, pass: pass, agent: "NMiner ~ v1.2.1", algo: ["rx/0"] } })}\n`);
        host.once("data", data => {
            try {
                data = JSON.parse(data.toString());
                if ("result" in data && data.result.status == "OK")
                    resolve({ host, id: data.result.id, job: data.result.job });

                else if ("error" in data && data.error != null)
                    reject(data.error.message);
            } catch (err) { reject(err); };
        });
    } catch (err) { reject(err); };
});

module.exports = (pool, user, pass, onJob, onClose) => new Promise(async (resolve, reject) => {
    onJob = onJob && typeof onJob == "function" ? onJob : () => { };
    onClose = onClose && typeof onClose == "function" ? onClose : () => { };

    try {
        let i = 1;
        const { host, id, job } = await GetPool(pool, user, pass);

        const keepalived = setInterval(() => {
            i++;
            host.write(`${JSON.stringify({ id: i, jsonrpc: "2.0", method: "keepalived", params: { id } })}\n`);
        }, 1000);
        host.on("close", async () => { print("net", "no active pools, stop mining".red); clearInterval(keepalived); onClose(); }).on("data", async data => {
            try {
                data = JSON.parse(data.toString());
                switch (data.method) {
                    case "job":
                        if ("params" in data && data.params != null)
                            onJob(data.params, (nonce, result) => {
                                i++;
                                host.write(`${JSON.stringify({ id: i, jsonrpc: "2.0", method: "submit", params: { id, job_id: data.params.job_id, nonce, result } })}\n`);
                            });
                        return;
                    default:
                        console.log(data);
                        if (data.error)
                            print("net", (await chalk()).red(data.error.message));

                        if (data.result)
                            console.log(data.result);
                        break;
                };
            } catch { };
        });

        resolve(host);
        setTimeout(() => onJob(job, (nonce, result) => {
            i++;
            host.write(`${JSON.stringify({ id: i, jsonrpc: "2.0", method: "submit", params: { id, job_id: job.job_id, nonce, result } })}\n`);
        }), 100);
    } catch (err) { print("net", (await chalk()).red(err.toString())); reject(err); };
});