import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

/**
 * `POST /api/restart`: the daemon asks launchd to run the code that
 * is now on disk, without anyone typing `launchctl`. The plist has
 * `KeepAlive = true`, so ANY exit is relaunched; 75 (EX_TEMPFAIL) only tells
 * the log, and whoever reads it, that the exit was asked for.
 *
 * The route lives on the READ listener and only when that listener is bound
 * to loopback. The ingest listener is on the LAN, and a Host header is
 * whatever the client says it is: on a LAN bind the Host check below could be
 * forged, so there the route simply does not exist.
 *
 * Guard order (the shared contract, RC2), every step before anything runs:
 *   a) exactly one Host, `127.0.0.1:<port>` or `localhost:<port>`  -> 403 host
 *   b) any Origin -> 403 origin; Sec-Fetch-Site other than none   -> 403 sec-fetch-site
 *   c) media type other than application/json                     -> 415 content_type
 *   d) over 1024 bytes -> 413 body; not a JSON object -> 400 body;
 *      a member other than `force` -> 400 <member>; non-boolean force -> 400 force
 * a-c run in the route's onRequest hook, before fastify reads the body, so a
 * forged Host is refused before its body is even received. d runs on the raw
 * body: this route takes bytes, not fastify's parsed JSON, so the parser can
 * never answer first with a shape of its own.
 */

/** The exit code of a requested restart. Signals still exit 0. */
export const RESTART_EXIT = 75;

/** The body cap, the same as the read listener's own `bodyLimit`. */
export const RESTART_MAX_BODY = 1024;

export const RESTART_PATH = "/api/restart";

const LOOPBACK = new Set(["127.0.0.1", "::1", "[::1]", "localhost"]);

/** Whether a configured bind host is loopback. The route exists only then (VR2). */
export function isLoopbackHost(host: string): boolean {
  return LOOPBACK.has(host.trim().toLowerCase());
}

/**
 * What the route needs from the process: how much ingest is in flight, and
 * the one call that starts the stop. `request` is called only after the 200
 * has been written to the socket.
 */
export interface RestartSwitch {
  inFlight(): number;
  request(opts: { force: boolean; inFlight: number }): void;
}

export interface RestartSwitchDeps {
  inFlight(): number;
  /** The process's shared stop path -- the same one SIGTERM runs. */
  readonly shutdown: (reason: string, code: number) => unknown;
  log(line: string): void;
}

/** The production switch: one WARNING when force overrides ingest, then the shared stop. */
export function restartSwitch(deps: RestartSwitchDeps): RestartSwitch {
  return {
    inFlight: deps.inFlight,
    request({ force, inFlight }) {
      if (force && inFlight > 0) {
        deps.log(`vitals: WARNING restart forced (force: true) with ${inFlight} ingest request(s) in flight`);
      }
      void deps.shutdown("restart requested", RESTART_EXIT);
    },
  };
}

/**
 * Counts the ingest listener's requests from the moment their headers arrive
 * (onRequest runs before the body is read) until the response is closed --
 * finished or aborted, `close` fires exactly once either way.
 */
export function countInFlight(app: FastifyInstance): () => number {
  let n = 0;
  app.addHook("onRequest", async (_req, reply) => {
    n += 1;
    reply.raw.once("close", () => {
      n -= 1;
    });
  });
  return () => n;
}

export interface Refusal {
  status: number;
  field: string;
  detail: string;
}

const refuse = (status: number, field: string, detail: string): Refusal => ({ status, field, detail });

/** RC2 a-c, from the headers alone. `null` = pass. */
export function screenHeaders(req: FastifyRequest, port: number): Refusal | null {
  const raw = req.raw.rawHeaders;
  const hosts: string[] = [];
  for (let i = 0; i + 1 < raw.length; i += 2) {
    if (raw[i]?.toLowerCase() === "host") hosts.push(raw[i + 1] ?? "");
  }
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (hosts.length !== 1 || !allowed.includes((hosts[0] ?? "").toLowerCase())) {
    return refuse(403, "host", `Host must be one of ${allowed.join(", ")}.`);
  }
  if (req.headers.origin !== undefined) {
    return refuse(403, "origin", "cross-origin requests are refused.");
  }
  const fetchSite = req.headers["sec-fetch-site"];
  if (fetchSite !== undefined && String(fetchSite).toLowerCase() !== "none") {
    return refuse(403, "sec-fetch-site", "requests made by a page are refused.");
  }
  const mediaType = String(req.headers["content-type"] ?? "").split(";")[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") {
    return refuse(415, "content_type", "the body must be application/json.");
  }
  return null;
}

/** RC2 d, on the raw body. Returns the refusal or the validated `force`. */
export function screenBody(raw: string): Refusal | { force: boolean } {
  if (Buffer.byteLength(raw, "utf8") > RESTART_MAX_BODY) {
    return refuse(413, "body", `the body is over ${RESTART_MAX_BODY} bytes.`);
  }
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return refuse(400, "body", "the body is not valid JSON.");
  }
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return refuse(400, "body", "the body must be a JSON object.");
  }
  for (const name of Object.keys(body)) {
    if (name !== "force") return refuse(400, name, `unknown field ${JSON.stringify(name)}.`);
  }
  const force = (body as { force?: unknown }).force;
  if (force !== undefined && typeof force !== "boolean") {
    return refuse(400, "force", "force must be true or false.");
  }
  return { force: force === true };
}

const sendRefusal = (reply: FastifyReply, r: Refusal): FastifyReply =>
  reply.code(r.status).send({ error: "restart_refused", field: r.field, detail: r.detail });

export interface RestartRouteOptions {
  /** The configured read port: the Host allowlist is built from it. */
  port: number;
  /** Absent = the guard still runs, then 503 (test and demo servers). */
  restart?: RestartSwitch;
}

/**
 * Registers the route in its own encapsulated context: its body parser takes
 * every content type as a raw string, so the guard -- not fastify's JSON
 * parser -- decides every answer, in the contract's order.
 */
export function registerRestartRoute(app: FastifyInstance, opts: RestartRouteOptions): void {
  void app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser("*", { parseAs: "string", bodyLimit: RESTART_MAX_BODY }, (_req, body, done) =>
      done(null, body),
    );

    scope.setErrorHandler(async (error: unknown, _req, reply) => {
      const code = (error as { code?: string }).code;
      if (code === "FST_ERR_CTP_BODY_TOO_LARGE") {
        return sendRefusal(reply, refuse(413, "body", `the body is over ${RESTART_MAX_BODY} bytes.`));
      }
      return sendRefusal(reply, refuse(400, "body", "the body could not be read."));
    });

    scope.post(
      RESTART_PATH,
      {
        onRequest: async (req, reply) => {
          const refusal = screenHeaders(req, opts.port);
          if (refusal !== null) {
            await sendRefusal(reply, refusal);
            return reply;
          }
          return undefined;
        },
      },
      async (req, reply) => {
        const checked = screenBody(typeof req.body === "string" ? req.body : "");
        if ("status" in checked) return sendRefusal(reply, checked);

        const restart = opts.restart;
        if (restart === undefined) {
          return reply.code(503).send({ error: "restart_unavailable", detail: "no restart switch wired." });
        }

        // RC7 / VR5: a delivery being received or stored is health data in
        // transit. Cutting it costs healthd a retry after its own backoff;
        // refusing here costs the caller one retry instead.
        const inFlight = restart.inFlight();
        if (inFlight > 0 && !checked.force) {
          return reply.code(409).send({ error: "ingest in progress", inFlight });
        }

        // Reply first. The stop closes this listener; a 200 that raced it
        // would reach the caller as a reset, indistinguishable from a refusal.
        // `finish` = the last byte is handed to the socket.
        reply.raw.once("finish", () => restart.request({ force: checked.force, inFlight }));
        return reply.code(200).send({ restarting: true, exit_code: RESTART_EXIT });
      },
    );

    // RC1: any other method is 405. Non-GET/HEAD never get here (the
    // listener's own hook answers them); GET and HEAD would otherwise be 404.
    scope.get(RESTART_PATH, async (_req, reply) =>
      reply.code(405).header("allow", "POST").send({ ok: false, error: "POST only" }),
    );
  });
}
