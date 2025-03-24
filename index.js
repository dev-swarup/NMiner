const os = require("os");
const miner = require("./src/js/miner.js");
const { connect, multiConnect } = require("./src/js/pool.js");

const { WebSocketServer } = require("ws");
const { GetTime, Print, RED, BOLD, CYAN, GRAY, WHITE, GREEN, YELLOW, MAGENTA, BLUE_BOLD, CYAN_BOLD, WHITE_BOLD, YELLOW_BOLD } = require("./src/js/log.js");

const PrintHashes = (i, n) => (n ? (n > 800 ? i / 1000 : i) : i > 800 ? i / 1000 : i).toFixed(1);
module.exports.NMiner = class {
    constructor(...args) {
        let pool = null, address = null, pass = "x", options = { mode: null, threads: null };
        if (args.length == 1 && typeof args[0] == "string")
            pool = args[0];

        if (args.length == 2 && typeof args[0] == "string" || typeof args[1] == "string") {
            pool = args[0];
            address = args[1];
        };

        if (args.length == 2 && typeof args[0] == "string" || typeof args[1] == "object") {
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

        let p, accepted = 0, rejected = 0, submitFn, requestNonceFn,
            nminer = miner.init(options.mode, options.threads, (...args) => submitFn(...args), () => requestNonceFn());

        const lPages = nminer.lPages(), hugePages = nminer.hugePages();
        console.log(GREEN(" * "), `${WHITE_BOLD("1GB PAGES")}        ${(lPages == 0 ? GREEN : lPages == -1 ? RED : YELLOW)(lPages == 0 ? "supported" : lPages == -1 ? "disabled" : "restart required")}`);
        console.log(GREEN(" * "), `${WHITE_BOLD("HUGE PAGES")}       ${(hugePages == 0 ? GREEN : hugePages == -1 ? RED : YELLOW)(hugePages == 0 ? "supported" : hugePages == -1 ? "disabled" : "restart required")}`);

        (function connectTo() {
            let totalHashes = 0, jobCount = 0, temp_blob, temp_seed_hash; try {
                p = connect(pool, pool.startsWith("ws") ? [address, miner.name, nminer.uThreads] : address, pass, async job => {
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

                requestNonceFn = async () => await p.requestNonce();

                let lastAcceptedCount = 0, lastJobCount = 0, lastTotalHashes = 0; setInterval(() => {
                    if (lastJobCount == jobCount && lastAcceptedCount == accepted) {
                        p.close();
                        nminer.pause();
                        Print(BLUE_BOLD(" net     "), RED("no job update, stop mining")); return setTimeout(() => p.reconnect(), 5000);
                    };

                    lastJobCount = jobCount;
                    lastAcceptedCount = accepted;
                    const threads = nminer.threads();
                    const [hashes, hashrate] = nminer.hashrate().split(":");
                    Print(CYAN_BOLD(" cpu     "), `speed ${CYAN_BOLD(" cpu ")} ${PrintHashes(Number(hashrate))} ${BLUE_BOLD(" pool ")} ${PrintHashes((totalHashes - lastTotalHashes) / 60, Number(hashrate))} ${Number(hashrate) > 800 ? "kH/s" : "H/s"} ${CYAN(`(${(nminer.uThreads == threads ? CYAN : RED)(threads)}/${nminer.uThreads})`)}`);

                    p
                        .sendHashRate(Number(hashes)); lastTotalHashes = totalHashes;
                }, 60000);
            } catch (err) { Print(BLUE_BOLD(" net     "), RED(err)); setTimeout(() => connectTo(), 10000); };
        })();

        process.on("SIGINT", () => { nminer.cleanup(); process.exit(); });
        process.on("SIGTERM", () => { nminer.cleanup(); process.exit(); });

        process.on("uncaughtException", err => {
            Print(YELLOW_BOLD(" signal  "), `${WHITE_BOLD("Program Error. Exiting ...")} ${err.message}`);
            nminer.cleanup();

            if (p)
                p.close();
        });

        process.on("unhandledRejection", err => {
            Print(YELLOW_BOLD(" signal  "), `${WHITE_BOLD("Program Error. Exiting ...")} ${err.message}`);
            nminer.cleanup();

            if (p)
                p.close();
        });
    };
};

module.exports.NMinerProxy = class {
    constructor(p, options) {
        let pool = null, address = null, pass = "x", soloMine = null;
        if (typeof p != "object")
            throw new Error("Invalid arguments");

        if (("url" in p && typeof p.url == "string") && ("address" in p && typeof p.address == "string")) {
            pool = p.url;
            address = p.address;
        };

        if ("pass" in p && typeof p.pass == "string")
            pass = p.pass;

        if ("soloMine" in p && typeof p.soloMine == "object") {
            soloMine = { pool: null, address: null, pass: "x", share: 20 };

            if (("url" in p.soloMine && typeof p.soloMine.url == "string") && ("address" in p.soloMine && typeof p.soloMine.address == "string")) {
                soloMine.pool = p.soloMine.url;
                soloMine.address = p.soloMine.address;
            };

            if ("pass" in p.soloMine && typeof p.soloMine.pass == "string")
                soloMine.pass = p.soloMine.pass;

            if ("share" in p.soloMine && typeof p.soloMine.share == "string")
                soloMine.share = p.soloMine.share;

            if (soloMine.pool == null || soloMine.address == null)
                throw new Error("Invalid soloMine arguments");
        };

        if (pool == null || address == null)
            throw new Error("Invalid arguments");

        options = { port: 8080, ...(typeof options == "object" ? options : {}) };
        let WebSocket, count = 0, accepted = 0, rejected = 0, submitFn, nminer = miner.init("LIGHT", 1, (...args) => submitFn(...args));

        let seed_hash = null, height = null, solo_jobs = [], soloPool = null; if (soloMine != null) {
            soloPool = multiConnect(soloMine.pool, soloMine.address, soloMine.pass, (i, job) => {
                seed_hash = job.seed_hash;
                const { diff, txnCount } = nminer.job(job.job_id, job.target, job.blob, true);
                Print(BLUE_BOLD(" net     "), `${MAGENTA("new job")} from ${soloPool.host} diff ${WHITE_BOLD(diff)} algo ${WHITE_BOLD("rx/0")}${"height" in job ? ` height ${WHITE_BOLD(job.height)}` : ""}${txnCount > 0 ? ` (${txnCount} tx)` : ""}`);

                solo_jobs[i] = new miner.splitter(job.job_id, job.target, job.blob, job.seed_hash, job.height); if (WebSocket) {

                };
            }, i => {
                Print(BLUE_BOLD(" net     "), RED("pool disconnected, switching ..."));

            }, i => {
                Print(BLUE_BOLD(" net     "), `connected to ${CYAN(`${soloPool.host}`)}${soloPool.remoteHost != null ? ` ${GRAY(soloPool.remoteHost)}` : ""}`);

            });
        };

        let main_jobs = [], mainPool = multiConnect(pool, address, pass, async (i, job) => {
            if (soloPool != null && seed_hash != job.seed_hash) {
                setTimeout(async () => {
                    mainPool.close(i);
                    await mainPool.reconnect(i);
                }, 10000);
                return Print(BLUE_BOLD(" net     "), `${RED(`seed not matched, closing the pool ${mainPool.host} ...`)}`);
            };

            const { diff, txnCount } = nminer.job(job.job_id, job.target, job.blob, true);
            Print(BLUE_BOLD(" net     "), `${MAGENTA("new job")} from ${mainPool.host} diff ${WHITE_BOLD(diff)} algo ${WHITE_BOLD("rx/0")}${"height" in job ? ` height ${WHITE_BOLD(job.height)}` : ""}${txnCount > 0 ? ` (${txnCount} tx)` : ""}`);

            main_jobs[i] = new miner.splitter(job.job_id, job.target, job.blob, job.seed_hash, job.height); if (WebSocket) {

            };
        }, i => {
            main_jobs[i] = null;
            Print(BLUE_BOLD(" net     "), RED("pool disconnected, switching ..."));

        }, i => {
            Print(BLUE_BOLD(" net     "), `connected to ${CYAN(`${mainPool.host}`)}${mainPool.remoteHost != null ? ` ${GRAY(mainPool.remoteHost)}` : ""}`);

        });

        WebSocket = (new WebSocketServer({ host: "0.0.0.0", port: options.port })).on("connection", async WebSocket => {
            WebSocket.on("close", () => {

            }).on("message", async data => {
                try {
                    const [id, method, params] = JSON.parse(data.toString()); switch (method) {
                        case "login":
                            if (main_jobs[main_jobs.length - 1] != null) {
                                WebSocket.id = main_jobs.length - 1;
                                const job = main_jobs[main_jobs.length - 1].get();
                                WebSocket.send(JSON.stringify([id, null, { id: main_jobs.length - 1, job }]));
                            } else {

                            };

                        default:
                            console.log(id, method, params);
                    };
                } catch { };
            });
        }).on("listening", () => {
            Print(BLUE_BOLD(" net     "), `listening on ${options.port}${seed_hash != null ? ", " + GRAY("seed " + seed_hash.slice(0, 16) + "...") : ""}`);
        });

        submitFn = async (...args) => {
            try {
                let time = (new Date()).getTime();

            } catch (err) { rejected++; Print(CYAN_BOLD(" cpu     "), `${RED("rejected")} (${accepted}/${RED(rejected)}) ${err}`); };
        };

        process.on("SIGINT", () => { nminer.cleanup(); process.exit(); });
        process.on("SIGTERM", () => { nminer.cleanup(); process.exit(); });

        process.on("uncaughtException", err => {
            Print(YELLOW_BOLD(" signal  "), `${WHITE_BOLD("Program Error. Exiting ...")} ${err.message}`);
            nminer.cleanup();

        });

        process.on("unhandledRejection", err => {
            Print(YELLOW_BOLD(" signal  "), `${WHITE_BOLD("Program Error. Exiting ...")} ${err.message}`);
            nminer.cleanup();
        });
    };
};