const os = require("os");
const miner = require("./src/js/miner.js");
const { connect } = require("./src/js/pool.js");

const { WebSocketServer } = require("ws");
const { GetTime, Print, RED, BOLD, CYAN, GRAY, WHITE, GREEN, YELLOW, MAGENTA, BLUE_BOLD, CYAN_BOLD, WHITE_BOLD, YELLOW_BOLD } = require("./src/js/log.js");

const PrintHashes = (i, n) => (n ? (n > 800 ? i / 1000 : i) : i > 800 ? i / 1000 : i).toFixed(1);
module.exports.NMiner = class {
    constructor(...args) {
        let pool = null, address = null, pass = "x", options = { mode: null, threads: null };
        if (args.length == 1 && typeof args[0] == "string")
            pool = args[0];

        if (args.length == 2 && typeof args[0] == "string" && typeof args[1] == "string") {
            pool = args[0];
            address = args[1];
        };

        if (args.length == 2 && typeof args[0] == "string" && typeof args[1] == "object") {
            pool = args[0];
            options = { ...options, ...args[1] };
        };

        if (args.length == 3 && typeof args[0] == "string" && typeof args[1] == "string" && typeof args[2] == "string") {
            pool = args[0];
            pass = args[2];
            address = args[1];
        };

        if (args.length == 3 && typeof args[0] == "string" && typeof args[1] == "string" && typeof args[2] == "object") {
            pool = args[0];
            address = args[1];
            options = { ...options, ...args[2] };
        };

        if (args.length == 4 && typeof args[0] == "string" && typeof args[1] == "string" && typeof args[2] == "string" && typeof args[3] == "object") {
            pool = args[0];
            pass = args[2];
            address = args[1];
            options = { ...options, ...args[3] };
        };

        if (pool == null)
            throw new Error("Invalid arguments");

        let p, accepted = 0, rejected = 0, submitFn, nminer = miner.init(options.mode, options.threads, (...args) => submitFn(...args));

        const lPages = nminer.lPages(), hugePages = nminer.hugePages();
        console.log(GREEN(" * "), `${WHITE_BOLD("1GB PAGES")}        ${(lPages == 0 ? GREEN : lPages == -1 ? RED : YELLOW)(lPages == 0 ? "supported" : lPages == -1 ? "disabled" : "restart required")}`);
        console.log(GREEN(" * "), `${WHITE_BOLD("HUGE PAGES")}       ${(hugePages == 0 ? GREEN : hugePages == -1 ? RED : YELLOW)(hugePages == 0 ? "supported" : hugePages == -1 ? "disabled" : "restart required")}`);

        (async function connectTo() {
            let totalHashes = 0, jobCount = 0, temp_blob, temp_seed_hash; try {
                p = await connect(pool, pool.startsWith("ws") ? [address, miner.name, nminer.uThreads] : address, pass, async job => {
                    jobCount++;
                    nminer.pause();
                    const { diff, txnCount } = nminer.job(job.job_id, job.target, job.blob, temp_blob != job.blob);
                    Print(BLUE_BOLD(" net     "), `${MAGENTA("new job")} from ${p.host} diff ${WHITE_BOLD(diff)} algo ${WHITE_BOLD("rx/0")}${"height" in job ? ` height ${WHITE_BOLD(job.height)}` : ""}${txnCount > 0 ? ` (${txnCount} tx)` : ""}`);

                    temp_blob = job.blob;
                    if (temp_seed_hash != job.seed_hash) {
                        nminer.cleanup();
                        Print(BLUE_BOLD(" randomx "), `${MAGENTA("init dataset")} algo ${WHITE_BOLD("rx/0")} (${CYAN(os.cpus().length + "")} threads) ${GRAY("seed " + job.seed_hash.slice(0, 16) + "...")}`);

                        let time = (new Date()).getTime(); if (nminer.alloc()) {
                            time = (new Date()).getTime(); Print(BLUE_BOLD(" randomx "), `${GREEN("allocated")} ${nminer.mode != "LIGHT" ? `${CYAN("2336 MB")} ${GRAY("(2080+256)")}` : `${CYAN("256 MB")}`} ${GetTime(time)}`);

                            if (nminer.init(job.seed_hash, os.cpus().length)) {
                                Print(BLUE_BOLD(" randomx "), `${GREEN("dataset ready")} ${GetTime(time)}`);
                                Print(CYAN_BOLD(" cpu     "), `use profile ${BLUE_BOLD(" rx ")} (${CYAN(nminer.uThreads)} threads)`);
                            } else {
                                Print(BLUE_BOLD(" randomx "), RED(`Failed to intialize ${BOLD("RandomX")} dataset.`));
                                return;
                            };

                            temp_seed_hash = job.seed_hash;
                        } else {
                            Print(BLUE_BOLD(" randomx "), RED(`Failed to allocate ${BOLD("RandomX")} cache.`));
                            return;
                        };

                        return nminer.start(0);
                    };

                    nminer.start();
                }, () => {
                    nminer.pause();
                    Print(BLUE_BOLD(" net     "), RED("pool disconnected, stop mining"));
                }, () => { Print(BLUE_BOLD(" net     "), `use pool ${CYAN(`${p.host}`)}${p.remoteHost != null ? ` ${GRAY(p.remoteHost)}` : ""}`); });

                submitFn = async (...args) => {
                    try {
                        let time = (new Date()).getTime(); const target = await p.submit(...args);

                        accepted++;
                        totalHashes += target;
                        Print(CYAN_BOLD(" cpu     "), `${GREEN(`accepted`)} (${accepted}/${(rejected > 0 ? RED : WHITE)(rejected)}) diff ${WHITE_BOLD(target)} ${GetTime(time)}`);
                    } catch (err) { rejected++; Print(CYAN_BOLD(" cpu     "), `${RED("rejected")} (${accepted}/${RED(rejected)}) ${RED(err)}`); };
                };

                let lastAcceptedCount = 0, lastJobCount = 0, lastTotalHashes = 0; setInterval(() => {
                    if (lastJobCount == jobCount && lastAcceptedCount == accepted) {
                        p.close();
                        nminer.pause();
                        Print(BLUE_BOLD(" net     "), RED("no job update, stop mining")); return setTimeout(() => p.reconnect(), 5000);
                    };

                    lastJobCount = jobCount;
                    lastAcceptedCount = accepted;
                    const threads = nminer.threads();
                    const hashrate = nminer.hashrate();
                    Print(CYAN_BOLD(" cpu     "), `speed ${CYAN_BOLD(" cpu ")} ${PrintHashes(hashrate)} ${BLUE_BOLD(" pool ")} ${PrintHashes((totalHashes - lastTotalHashes) / 60, hashrate)} ${hashrate > 800 ? "kH/s" : "H/s"} ${CYAN(`(${(nminer.uThreads == threads ? CYAN : RED)(threads)}/${nminer.uThreads})`)}`);

                    lastTotalHashes = totalHashes;
                }, 60000);
            } catch (err) { Print(BLUE_BOLD(" net     "), RED(err)); setTimeout(() => connectTo(), 10000); };
        })();

        process.on("SIGINT", () => { nminer.cleanup(); process.exit(); });
        process.on("SIGTERM", () => { nminer.cleanup(); process.exit(); });

        process.on("uncaughtException", err => {
            Print(YELLOW_BOLD(" signal  "), `${WHITE_BOLD("Program Error. Exiting ...")} ${err}`);
            nminer.cleanup();

            if (p)
                p.close();
        });

        process.on("unhandledRejection", err => {
            Print(YELLOW_BOLD(" signal  "), `${WHITE_BOLD("Program Error. Exiting ...")} ${err}`);
            nminer.cleanup();

            if (p)
                p.close();
        });
    };
};

module.exports.NMinerProxy = class {
    constructor(...args) {
        let pool = null, address = null, pass = "x", options = { port: 8080 };
        if (args.length == 1 && typeof args[0] == "string")
            pool = args[0];

        if (args.length == 2 && typeof args[0] == "string" && typeof args[1] == "string") {
            pool = args[0];
            address = args[1];
        };

        if (args.length == 2 && typeof args[0] == "string" && typeof args[1] == "object") {
            pool = args[0];
            options = { ...options, ...args[1] };
        };

        if (args.length == 3 && typeof args[0] == "string" && typeof args[1] == "string" && typeof args[2] == "string") {
            pool = args[0];
            pass = args[2];
            address = args[1];
        };

        if (args.length == 3 && typeof args[0] == "string" && typeof args[1] == "string" && typeof args[2] == "object") {
            pool = args[0];
            address = args[1];
            options = { ...options, ...args[2] };
        };

        if (args.length == 4 && typeof args[0] == "string" && typeof args[1] == "string" && typeof args[2] == "string" && typeof args[3] == "object") {
            pool = args[0];
            pass = args[2];
            address = args[1];
            options = { ...options, ...args[3] };
        };

        if (pool == null)
            throw new Error("Invalid arguments");

        const WebSocket = (new WebSocketServer({ host: "0.0.0.0", port: options.port })).on("connection", async WebSocket => {
            let socket = null, logged = false, accepted = 0, rejected = 0; WebSocket.on("close", () => {
                if (socket)
                    socket.close();
                Print(BLUE_BOLD(" net     "), RED("miner disconnected, closing socket."));
            }).on("message", async data => {
                try {
                    const [id, method, params] = JSON.parse(data.toString()); switch (method) {
                        case "login":
                            let result = { pool, address, pass };
                            const [[addr, cpu, threads], x] = params;

                            if ("onConnection" in options) {
                                let resp = await options.onConnection(addr, x, cpu, threads);
                                if ((typeof resp == "boolean" && !resp) || (typeof resp == "object" && !("pool" in resp)))
                                    return WebSocket.send(JSON.stringify([id, "Invalid Login", null]));
                                else if (typeof resp == "object")
                                    result = resp;
                            };

                            try {
                                socket = await connect(result.pool, result.address, result.pass, job => {
                                    if (!logged) {
                                        WebSocket.send(JSON.stringify([id, null, { id: 0, job }]));
                                        logged = true;
                                        return;
                                    };

                                    WebSocket.send(JSON.stringify(["job", job]));
                                }, () => {
                                    WebSocket.close();
                                    Print(BLUE_BOLD(" net     "), RED("pool disconnected, stop mining"));
                                }, () => { Print(BLUE_BOLD(" net     "), `${WHITE_BOLD(threads)} @ ${WHITE_BOLD(cpu)}, connected`); });
                            } catch { };

                            break;

                        case "submit":
                            if (socket) {
                                let time = (new Date()).getTime(); try {
                                    const target = await socket.submit(...params, null);

                                    accepted++;
                                    WebSocket.send(JSON.stringify([id, null, "OK"]));
                                    Print(CYAN_BOLD(" cpu     "), `${GREEN(`accepted`)} (${accepted}/${(rejected > 0 ? RED : WHITE)(rejected)}) ${GetTime(time)}`);
                                } catch (err) {
                                    console.log(err);
                                    rejected++;
                                    WebSocket.send(JSON.stringify([id, err, null]));
                                    Print(CYAN_BOLD(" cpu     "), `${RED("rejected")} (${accepted}/${RED(rejected)})`);
                                };
                            } else {
                                rejected++;
                                WebSocket.send(JSON.stringify([id, "Pool not connected", null]));
                                Print(CYAN_BOLD(" cpu     "), `${RED("rejected")} (${accepted}/${RED(rejected)})`);
                            };
                            break;

                        case "keepalived":
                            WebSocket.send(JSON.stringify([id, null, { status: "OK" }]));
                            break;
                    };
                } catch (err) { Print(YELLOW_BOLD(" signal  "), "Program Error: " + err); };
            });
        }).on("listening", () => {
            Print(BLUE_BOLD(" net     "), `listening on ${options.port}`);
        });

        process.on("uncaughtException", err => {
            Print(YELLOW_BOLD(" signal  "), `${WHITE_BOLD("Program Error. Exiting ...")} ${err}`);
            WebSocket.close();
        });

        process.on("unhandledRejection", err => {
            Print(YELLOW_BOLD(" signal  "), `${WHITE_BOLD("Program Error. Exiting ...")} ${err}`);
            WebSocket.close();
        });
    };
};