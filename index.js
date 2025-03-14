const os = require("os");
const miner = require("./src/js/miner.js");
const connect = require("./src/js/connect.js");
const { GetTime, Print, RED, BOLD, CYAN, GRAY, GREEN, MAGENTA, BLUE_BOLD, CYAN_BOLD, WHITE_BOLD, YELLOW_BOLD } = require("./src/js/log.js");

const PrintHashes = n => (n > 800 ? n / 1000 : n).toFixed(1);
module.exports.NMiner = class {
    #miner; constructor(...args) {
        let pool = "stratum+ssl://randomxmonero.auto.nicehash.com:443", address = null,
            pass = "x", options = { mode: os.freemem() >= 3 * 1024 * 1024 * 1024 ? "FAST" : "LIGHT", threads: Math.floor(os.cpus().length * 0.7) };

        switch (args.length) {
            case 1:
                address = args[0];
                break;
            case 2:
                if (typeof args[1] == "object") {
                    address = args[0];
                    options = { ...options, ...args[0] };
                    break;
                };

                pool = args[0];
                address = args[1];
                break;
            case 3:
                if (typeof args[0] == "string" && typeof args[1] == "string" && typeof args[2] == "string") {
                    pool = args[0];
                    address = args[1]; pass = args[2];
                    break;
                } else if (typeof args[0] == "string" && typeof args[1] == "string" && typeof args[2] == "object") {
                    pool = args[0];
                    address = args[1];
                    options = { ...options, ...args[2] };
                    break;
                };
            default:
                throw new Error("Invalid arguments");
        };

        this.#miner = miner.init(options.mode, options.threads);
        let m_this = this, temp_job, m_blob, m_seed_hash, datasetOffline; (async function i() {
            try {
                let interval; const { id, host } = await connect(pool, address, pass, m_job => {
                    m_this.pause();
                    const job = m_this.#miner.job(m_job.target, m_job.blob, m_blob != m_job.blob);
                    Print(BLUE_BOLD(" net     "), `${MAGENTA("new job")} from ${WHITE_BOLD(host.host)}${job.diff ? ` diff ${WHITE_BOLD(job.diff)}` : ""} algo ${WHITE_BOLD("rx/0")}${"height" in m_job ? ` height ${WHITE_BOLD(m_job.height)}` : ""}${job.txnCount > 0 ? ` (${job.txnCount} tx)` : ""}`);

                    (function init(m_job) {
                        m_blob = m_job.blob; if (datasetOffline) {
                            temp_job = m_job;
                            return;
                        };

                        if (m_seed_hash != m_job.seed_hash) {
                            m_this.#miner.cleanup();

                            temp_job = m_job; datasetOffline = true; m_seed_hash = m_job.seed_hash;
                            Print(BLUE_BOLD(" randomx "), `${MAGENTA("init dataset")} algo ${WHITE_BOLD("rx/0")} (${CYAN(os.cpus().length + "")} threads) ${GRAY("seed " + m_job.seed_hash.slice(0, 16) + "...")}`);

                            let time = (new Date()).getTime(); if (!m_this.#miner.alloc()) {
                                Print(BLUE_BOLD(" randomx "), RED(`Failed to allocate ${BOLD("RandomX")}`));
                                return setTimeout(() => process.exit(), 500);
                            };

                            Print(BLUE_BOLD(" randomx "), `${GREEN("allocated")} ${options.mode != "LIGHT" ? `${CYAN("2336 MB")} ${GRAY("(2080+256)")}` : `${CYAN("256 MB")}`} ${GetTime(time)}`);
                            time = (new Date()).getTime(); if (!m_this.#miner.init(m_job.seed_hash, os.cpus().length)) {
                                Print(BLUE_BOLD(" randomx "), RED(`Failed to intialize ${BOLD("RandomX")} dataset`));
                                return setTimeout(() => process.exit(), 500);
                            };

                            datasetOffline = false;
                            Print(BLUE_BOLD(" randomx "), `${GREEN("dataset ready")} ${GetTime(time)}`); if (m_seed_hash != temp_job.seed_hash)
                                return init(temp_job);

                            Print(CYAN_BOLD(" cpu     "), `use profile ${BLUE_BOLD(" rx ")} (${CYAN(options.threads)} threads)`);
                        };

                        m_this.#miner.start((nonce, result) => {
                            console.log(nonce, result);
                        });
                    })(m_job);
                }, () => { m_this.pause(); Print(BLUE_BOLD(" net     "), RED("pool disconnected, stop mining")); interval ? clearInterval(interval) : null; setTimeout(() => i(), 10000); });
                let tHashes = 0; interval = setInterval(() => {
                    let { threads, totalHashes } = m_this.#miner.totalHashes(); let thisHashes = totalHashes - tHashes;

                    tHashes += thisHashes;
                    Print(CYAN_BOLD(" cpu     "), `speed     ${PrintHashes(thisHashes / 60)} ${thisHashes > 800 ? "kH/s" : "H/s"} ${CYAN(`(${(options.threads == threads ? CYAN : RED)(threads)}/${options.threads})`)}`);
                }, 60000);
            } catch { interval ? clearInterval(interval) : null; setTimeout(() => i(), 10000); };
        })();

        process.on("SIGINT", () => {
            Print(YELLOW_BOLD(" signal  "), WHITE_BOLD("Exiting ..."));
            m_this.#miner.cleanup();
            process.exit();
        });

        process.on("SIGTERM", () => {
            Print(YELLOW_BOLD(" signal  "), WHITE_BOLD("Exiting ..."));
            m_this.#miner.cleanup();
            process.exit();
        });

        process.on("uncaughtException", () => {
            Print(YELLOW_BOLD(" signal  "), WHITE_BOLD("Program Error. Exiting ..."));
            m_this.#miner.cleanup();
            process.exit();
        });
    };

    start = () => { this.#miner.start(); };
    pause = () => { this.#miner.pause(); };
};