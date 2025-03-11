const os = require("os");
const colors = require("colors");
const To = require("./src/js/connect.js");
const { print } = require("./src/js/log.js");

const GetHash = n => {
    return `${n.toFixed(1)} ${n > 1000 ? "kH/s" : "H/s"}`;
};
module.exports.NMiner = class {
    constructor(...args) {
        let pool = "stratum+ssl://randomxmonero.auto.nicehash.com:443", hostname = null, address = null,
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

        let hashrateInterval;
        const RandomX = require("./build/Release/RandomX.node")(options.threads, options.mode); (async function connectTo() {
            let seed_hash, temp_job, datasetOffline, switchTo = (job, m_seed_hash) => new Promise(async resolve => {
                RandomX.Stop();
                if (hashrateInterval)
                    clearInterval(hashrateInterval);

                let time = (new Date()).getTime();
                print("cpu", `${"init dataset".magenta} algo ${colors.bold("rx/0")} (${(os.cpus().length + "").cyan} threads) ${("seed " + seed_hash.slice(0, 16) + "...").gray}`);

                if (!(await RandomX.FreshUp()))
                    return resolve(print("miner", "Failed to allocate ".red + colors.red.bold("RandomX")));
                print("cpu", `${"allocated".green} ${options.mode != "LIGHT" ? `${"2336 MB".cyan} ${"(2080+256)".gray}` : `${"256 MB".cyan}`} ${"+JIT".green} ${`(${(new Date().getTime()) - time} ms)`.gray}`);

                time = (new Date()).getTime();
                if (!(await RandomX.Init(job, os.cpus().length)))
                    return resolve(print("miner", "Failed to initialize dataset".red));
                print("cpu", `${"dataset ready".green} ${`(${(new Date().getTime()) - time} ms)`.gray}`);

                if (seed_hash != m_seed_hash)
                    return resolve(await switchTo(temp_job, seed_hash));

                datasetOffline = false;
                time = (new Date()).getTime();
                print("miner", `use profile ${" rx ".bgBlue} (${(options.threads + "").cyan} threads)`);

                let jobs = RandomX.SwitchTo(temp_job);
                if (jobs == -1)
                    return resolve(print("miner", "Failed to switch job".red));

                print("miner", `${"READY".green} (${((jobs + "")[jobs == options.threads ? "cyan" : "red"] + "/" + options.threads + "").cyan} threads) ${`(${(new Date().getTime()) - time} ms)`.gray}`);

                let hashes = 0;
                hashrateInterval = setInterval(async () => {
                    let currentHashes = RandomX.Hashes();
                    print("miner", `${colors.bold("speed")}           ${"(30s)".gray} ${colors.bold(GetHash((currentHashes - hashes) / 30))}      ${"(pool)".gray} ${colors.bold("0.0 H/s")}`);

                    hashes = currentHashes;
                }, 30000);
                return resolve();
            });

            To(pool, address, pass, async (m_job, submit) => {
                try {
                    const { job, target, txnCount } = RandomX.GetJob(m_job.seed_hash, m_job.target, m_job.blob, submit);
                    print("net", `${"new job".magenta} from ${hostname} diff ${colors.bold(target)} algo ${colors.bold("rx/0")}${m_job.height ? ` height ${colors.bold(m_job.height)}` : ""} (${txnCount} tx)`);

                    if (datasetOffline) {
                        seed_hash = m_job.seed_hash; temp_job = job;
                        return;
                    };

                    if (seed_hash != m_job.seed_hash) {
                        seed_hash = m_job.seed_hash; temp_job = job; datasetOffline = true;
                        return switchTo(job, m_job.seed_hash);
                    };

                    if (RandomX.SwitchTo(job) == -1)
                        return resolve(print("miner", "Failed to switch job".red));
                } catch (err) { print("miner", err.toString().red) };
            }, () => { RandomX.Stop(); setTimeout(() => connectTo(), 1000); }).then(({ host }) => { hostname = host; }).catch(err => print("net", err.toString().red))
        })();
    };
};