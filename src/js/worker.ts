import type { Socket } from "net";

import { WorkerBackend } from "./hub.js";
import { Edge, UdpEdge } from "./edge.js";
import { Logger, consoleSink } from "./logger.js";
import { isProxyWorker, workerLevel, workerLink } from "./fleet.js";

if (isProxyWorker()) {
    const link = workerLink();
    const log = new Logger({ level: workerLevel(), sink: entry => process.connected ? link.send({ t: "log", e: entry }) : consoleSink(entry) });

    const backend = new WorkerBackend();
    const edge = new Edge(backend, { log }), udp = new UdpEdge(backend, (key, text) => link.send({ t: "u", k: key, d: text }), { log, dropped: key => link.send({ t: "ux", k: key }) });

    link.on((raw, handle) => {
        if (!raw) return;

        if (raw.t === "u") return udp.receive(raw.k, raw.d);
        if (raw.t !== "conn" || !handle) return;

        const socket = handle as Socket;
        socket.once("close", () => link.send({ t: "off" }));

        edge.accept(socket);
    });
};