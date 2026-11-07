import type { Server } from "node:http";
import type { Socket } from "node:net";
import type { Db } from "./db.js";

/**
 * The daemon's one stop path (VR4). SIGINT, SIGTERM and
 * `POST /api/restart` all run this; only the reason and the exit code
 * differ (signals 0, restart 75). Close both listeners -- fastify's close
 * drains the requests already in progress -- then checkpoint the WAL so the
 * next process never inherits an unresolved journal, close the DB, exit.
 *
 * The drain is capped: a held upload or a keep-alive socket would
 * otherwise keep the process alive indefinitely. When the cap is reached,
 * every connection still open on every listener is closed, one WARNING
 * line says so, and the same checkpoint -> close -> exit runs with the same
 * exit code. A request cut there was cut before its handler ran: the ingest
 * handler has no `await` and every store write is synchronous, so a handler
 * that started has already finished. Checkpoint, `db.close()` and `exit()`
 * run in one synchronous block, so nothing can write after the close.
 *
 * Runs once: a second call (a signal during a restart, say) is ignored.
 */

export interface DrainTarget {
  /** Stop listening and drain; resolves when every connection is gone. */
  close(): Promise<unknown>;
  /** Close every connection still open now; returns how many. */
  closeAllConnections(): number;
}

export interface StopDeps {
  servers: readonly DrainTarget[];
  db: Pick<Db, "pragma" | "close">;
  log(line: string): void;
  /** `process.exit` in production; a seam for the test. */
  exit(code: number): void;
  /** `VITALS_DRAIN_CAP_SECONDS`, default 10. */
  drainCapSeconds: number;
}

export function createShutdown(deps: StopDeps): (reason: string, code: number) => Promise<void> {
  let shuttingDown = false;
  return async (reason, code) => {
    if (shuttingDown) return;
    shuttingDown = true;
    deps.log(`vitals: ${reason}, closing`);
    const drained = Promise.allSettled(deps.servers.map((server) => server.close())).then(() => "drained" as const);
    let timer: NodeJS.Timeout | undefined;
    const capped = new Promise<"capped">((resolve) => {
      timer = setTimeout(() => resolve("capped"), deps.drainCapSeconds * 1000);
    });
    const outcome = await Promise.race([drained, capped]);
    // A drain that ends inside the cap never waits the cap out.
    clearTimeout(timer);
    if (outcome === "capped") {
      let closed = 0;
      for (const server of deps.servers) closed += server.closeAllConnections();
      deps.log(`vitals: WARNING drain cap ${deps.drainCapSeconds}s reached, closed ${closed} connection(s)`);
    }
    try {
      deps.db.pragma("wal_checkpoint(TRUNCATE)");
    } catch {
      /* best effort */
    }
    deps.db.close();
    deps.exit(code);
  };
}

/**
 * Adapts a fastify instance to the stop: its own `close()`, plus a force
 * close that counts what it closes. Attach before `listen()`.
 *
 * Once the stop has begun, a response that finishes ends its connection
 * (D-504c). `server.close()` closes only the connections idle at that
 * instant; one busy then would otherwise sit in keep-alive after its reply
 * and hold the drain until the cap.
 */
export function drainTarget(app: { server: Server; close(): Promise<unknown> }): DrainTarget {
  const sockets = new Set<Socket>();
  let stopping = false;
  app.server.on("connection", (socket: Socket) => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
  });
  app.server.on("request", (req, res) => {
    // Captured now: by `finish` node has already detached it from `res`.
    const socket = req.socket;
    res.once("finish", () => {
      // end() alone is a half-close (http sockets allow half-open): the
      // socket would stay until the client closed its side. Flush, then go.
      if (stopping) socket.end(() => socket.destroy());
    });
  });
  return {
    close: () => {
      stopping = true;
      return app.close();
    },
    closeAllConnections() {
      const open = [...sockets].filter((s) => !s.destroyed);
      for (const socket of open) socket.destroy();
      return open.length;
    },
  };
}
