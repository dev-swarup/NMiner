const os = require("os");
const miner = require("./src/js/miner.js");
const connect = require("./src/js/connect.js");

const { WebSocketServer } = require("ws");
const { GetTime, Print, RED, BOLD, CYAN, GRAY, WHITE, GREEN, YELLOW, MAGENTA, BLUE_BOLD, CYAN_BOLD, WHITE_BOLD, YELLOW_BOLD } = require("./src/js/log.js");

const PrintHashes = (i, n) => (n ? (n > 800 ? i / 1000 : i) : i > 800 ? i / 1000 : i).toFixed(1);
module.exports.NMiner = class {
    #miner; constructor(...args) {
        let pool = null, address = null, pass = "x", options = { mode: os.freemem() >= 3 * 1024 * 1024 * 1024 ? "FAST" : "LIGHT", threads: Math.floor(os.cpus().length * 0.7) };
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
            address = args[1]; pass = args[2];
        };

        if (args.length == 3 && typeof args[0] == "string" && typeof args[1] == "string" && typeof args[2] == "object") {
            pool = args[0];
            address = args[1];
            options = { ...options, ...args[2] };
        };

        if (pool == null)
            throw new Error("Invalid arguments");

        let accepted = 0, rejected = 0, submitFn,
            nminer = this.#miner = miner.init(options.mode, options.threads, (...args) => submitFn(...args));

        const msr = this.#miner.msr(), lPages = this.#miner.lPages(), hugePages = this.#miner.hugePages();
        console.log(GREEN(" * "), `${WHITE_BOLD("MSR")}              ${(msr == 0 ? GREEN : msr == -1 ? RED : YELLOW)(msr == 0 ? "supported" : msr == -1 ? "disabled" : "restart required")}`);
        console.log(GREEN(" * "), `${WHITE_BOLD("1GB PAGES")}        ${(lPages == 0 ? GREEN : lPages == -1 ? RED : YELLOW)(lPages == 0 ? "supported" : lPages == -1 ? "disabled" : "restart required")}`);
        console.log(GREEN(" * "), `${WHITE_BOLD("HUGE PAGES")}       ${(hugePages == 0 ? GREEN : hugePages == -1 ? RED : YELLOW)(hugePages == 0 ? "supported" : hugePages == -1 ? "disabled" : "restart required")}`);

        (async function connectTo() {
            let interval, totalHashes = 0, jobCount = 0, temp_blob, temp_seed_hash;
            const { host, submit } = await (pool.startsWith("ws") ? connect.WebSocket : connect.Tcp)(...(pool.startsWith("ws") ? [pool, address] : [pool, address, pass]), job => {
                jobCount++;
                nminer.pause();
                const { diff, txnCount } = nminer.job(job.job_id, job.target, job.blob, temp_blob != job.blob);
                Print(BLUE_BOLD(" net     "), `${MAGENTA("new job")} from ${host.host} diff ${WHITE_BOLD(diff)} algo ${WHITE_BOLD("rx/0")}${"height" in job ? ` height ${WHITE_BOLD(job.height)}` : ""}${txnCount > 0 ? ` (${txnCount} tx)` : ""}`);

                if (temp_seed_hash != job.seed_hash) {
                    temp_seed_hash = job.seed_hash; nminer.cleanup();
                    Print(BLUE_BOLD(" randomx "), `${MAGENTA("init dataset")} algo ${WHITE_BOLD("rx/0")} (${CYAN(os.cpus().length + "")} threads) ${GRAY("seed " + job.seed_hash.slice(0, 16) + "...")}`);

                    let time = (new Date()).getTime(); if (nminer.alloc()) {
                        time = (new Date()).getTime(); Print(BLUE_BOLD(" randomx "), `${GREEN("allocated")} ${options.mode != "LIGHT" ? `${CYAN("2336 MB")} ${GRAY("(2080+256)")}` : `${CYAN("256 MB")}`} ${GetTime(time)}`);

                        if (nminer.init(job.seed_hash, os.cpus().length)) {
                            Print(BLUE_BOLD(" randomx "), `${GREEN("dataset ready")} ${GetTime(time)}`);
                            Print(CYAN_BOLD(" cpu     "), `use profile ${BLUE_BOLD(" rx ")} (${CYAN(options.threads)} threads)`);
                        } else {
                            Print(BLUE_BOLD(" randomx "), RED(`Failed to intialize ${BOLD("RandomX")} dataset.`));
                            return setTimeout(() => process.exit(), 500);
                        };
                    } else {
                        Print(BLUE_BOLD(" randomx "), RED(`Failed to allocate ${BOLD("RandomX")} cache.`));
                        return setTimeout(() => process.exit(), 500);
                    };

                    return nminer.start(0);
                };

                nminer.start();
            }, async () => {
                nminer.pause();
                Print(BLUE_BOLD(" net     "), RED("pool disconnected, stop mining"));
                interval ? clearInterval(interval) : null; setTimeout(() => connectTo(), 1000);
            });

            submitFn = async (...args) => {
                try {
                    let time = (new Date()).getTime(); const [target] = await submit(...args);

                    accepted++;
                    totalHashes += target;
                    Print(CYAN_BOLD(" cpu     "), `${GREEN(`accepted`)} (${accepted}/${(rejected > 0 ? RED : WHITE)(rejected)}) diff ${WHITE_BOLD(target)} ${GetTime(time)}`);
                } catch { rejected++; Print(CYAN_BOLD(" cpu     "), `${RED("rejected")} (${accepted}}/${RED(rejected)})`); };
            };

            let lastJobCount = 0, lastTotalHashes = 0; interval = setInterval(() => {
                if (lastJobCount == jobCount) {
                    host.end();
                    nminer.pause();
                };

                lastJobCount = jobCount;
                const threads = nminer.threads();
                const hashrate = nminer.hashrate();
                Print(CYAN_BOLD(" cpu     "), `speed ${CYAN_BOLD(" cpu ")} ${PrintHashes(hashrate)} ${BLUE_BOLD(" pool ")} ${PrintHashes((totalHashes - lastTotalHashes) / 300, hashrate)} ${hashrate > 800 ? "kH/s" : "H/s"} ${CYAN(`(${(options.threads == threads ? CYAN : RED)(threads)}/${options.threads})`)}`);

                lastTotalHashes = totalHashes;
            }, 5 * 60000);
        })();

        process.on("SIGINT", () => {
            Print(YELLOW_BOLD(" signal  "), WHITE_BOLD("Exiting ..."));
            nminer.cleanup();
            process.exit();
        });

        process.on("SIGTERM", () => {
            Print(YELLOW_BOLD(" signal  "), WHITE_BOLD("Exiting ..."));
            nminer.cleanup();
            process.exit();
        });

        process.on("uncaughtException", err => {
            Print(YELLOW_BOLD(" signal  "), `${WHITE_BOLD("Program Error. Exiting ...")} ${err.message}`);
            nminer.cleanup();
            process.exit();
        });
    };

    start = () => { this.#miner.start(); };
    pause = () => { this.#miner.pause(); };
};

module.exports.NMinerProxy = class {
    constructor(...args) {
        let pool = null, address = null, pass = "x", options = { port: 8080 };
        if (args.length == 2 && typeof args[0] == "string" || typeof args[1] == "string") {
            pool = args[0];
            address = args[1];
        };

        if (args.length == 3 && typeof args[0] == "string" && typeof args[1] == "string" && typeof args[2] == "string") {
            pool = args[0];
            address = args[1]; pass = args[2];
        };

        if (args.length == 3 && typeof args[0] == "string" && typeof args[1] == "string" && typeof args[2] == "object") {
            pool = args[0];
            address = args[1];
            options = { ...options, ...args[2] };
        };

        if (args.length == 4 && typeof args[0] == "string" && typeof args[1] == "string" && typeof args[2] == "string" && typeof args[3] == "object") {
            pool = args[0];
            address = args[1]; pass = args[2];
            options = { ...options, ...args[3] };
        };

        if (pool == null && address == null)
            throw new Error("Invalid arguments");

        (new WebSocketServer({ host: "0.0.0.0", port: options.port })).on("connection", async WebSocket => {
            let t, submitFn, logged = false;
            WebSocket.on("close", () => { t ? t.end() : null; }).on("message", async data => {
                try {
                    data = JSON.parse(data.toString());
                    if (data[0] == "login") {
                        let m_pool = null, m_address = null, m_pass = "x";
                        if ("onConnection" in options) {
                            const tn = await options.onConnection(data[1]);
                            if (tn == true) {
                                m_pool = pool;
                                m_pass = pass;
                                m_address = address;
                            } else if (typeof tn == "object" && "pool" in tn && "address" in tn) {
                                m_pool = tn.pool;
                                m_pass = tn.pass || null; m_address = tn.address;
                            } else {
                                WebSocket.send(JSON.stringify(["login", false]));
                                WebSocket.close();
                            };
                        } else {
                            m_pool = pool;
                            m_pass = pass;
                            m_address = address;
                        };

                        const { host, submit } = await connect.Tcp(m_pool, m_address, m_pass, job => {
                            if (!logged) {
                                WebSocket.send(JSON.stringify(["login", job]));
                                logged = true;
                            } else
                                WebSocket.send(JSON.stringify(["job", job]));
                        }, () => WebSocket.close()); t = host; submitFn = submit;
                    } else if (data[0] == "submit")
                        try {
                            await submitFn(data[1].job_id, data[1].nonce, data[1].result);

                            Print(CYAN_BOLD(" miner   "), GREEN("accepted"));
                            WebSocket.send(JSON.stringify(["result", "accepted", data[2]]));
                        } catch {
                            Print(CYAN_BOLD(" miner   "), RED("rejected"));
                            WebSocket.send(JSON.stringify(["result", "rejected", data[2]]));
                        }
                    else if (data[0] == "keepalive")
                        WebSocket.send(JSON.stringify(["keepalived"]))
                } catch { };
            });
        });
    };
};