import Fastify, { type FastifyInstance } from "fastify";
import type { Config } from "./config.js";
import { buildDashboard } from "./dashboard.js";
import { buildFitness } from "./fitness.js";
import { FITNESS_CSS, renderFitness } from "./render-fitness.js";
import { DASHBOARD_CSS, renderDashboard } from "./render.js";
import { isLoopbackHost, registerRestartRoute, RESTART_PATH, type RestartSwitch } from "./restart.js";
import type { Store } from "./store.js";

/**
 * The read side. Loopback only: the LAN reaches it through Synapse, which
 * adds auth. Separating it from ingest means the portal password cannot be
 * replayed into the ingest path and the phone's credential cannot read the
 * data back.
 *
 * Three rules hold this listener down:
 *   1. GET and HEAD only. Anything else is 405 before it reaches a handler,
 *      so "the dashboard is read-only" is enforced, not just intended.
 *      One exception, and only on a loopback bind: `POST /api/restart`
 *      (src/restart.ts), which writes nothing -- it stops the process.
 *   2. No route here loads the credential. The token source is not even a
 *      dependency of this server -- it cannot leak what it never holds.
 *   3. /healthz keeps its exact shape: the Synapse tile is built on it.
 *      (One additive key, `sha`, which the tile's parse does not read.)
 */

export interface ReadDeps {
  store: Store;
  config: Config;
  /**
   * The clock, as a function rather than an instant.
   *
   * A function because this server outlives every request it answers: a
   * captured `Date` would freeze the daemon's idea of "today" at boot, and
   * the page would go on reporting the morning it started.
   *
   * Optional because production must not notice the seam. `src/server.ts`
   * passes nothing, so the live daemon takes `new Date()` exactly as it did
   * before this parameter existed. Tests pin it -- which is the entire point:
   * a suite that reads the wall clock is a suite that tests the calendar, and
   * the calendar always wins eventually.
   */
  now?: () => Date;
  /**
   * What `POST /api/restart` drives. Optional: test and demo servers pass
   * nothing and the route answers 503 after its guard. `src/server.ts`
   * always wires one.
   */
  restart?: RestartSwitch;
  /**
   * The running commit, 40 hex, resolved once at start (RC6); `null`
   * when it could not be. Served as `/healthz` `sha`. Absent = `null`.
   */
  sha?: string | null;
}

export function buildReadServer(deps: ReadDeps): FastifyInstance {
  const { store, config } = deps;
  const now = deps.now ?? (() => new Date());
  // A read listener has no use for a request body at all.
  const app = Fastify({ logger: false, bodyLimit: 1024 });

  // The one non-GET this listener lets through. Matched on the path, not on
  // the route, so that on a non-loopback bind -- where the route is never
  // registered -- the answer is 404, not a 405 that implies it exists.
  const isRestart = (req: { method: string; url: string }): boolean =>
    req.method === "POST" && req.url.split("?")[0] === RESTART_PATH;

  app.addHook("onRequest", async (req, reply) => {
    if (req.method !== "GET" && req.method !== "HEAD" && !isRestart(req)) {
      void reply.header("allow", "GET, HEAD");
      await reply.code(405).send({ ok: false, error: "read-only listener: GET and HEAD only" });
      return reply;
    }
    return undefined;
  });

  app.addHook("onSend", async (_req, reply) => {
    void reply.header("x-content-type-options", "nosniff");
    // The page has no scripts, no images and one same-origin stylesheet.
    void reply.header(
      "content-security-policy",
      "default-src 'none'; style-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    );
    void reply.header("referrer-policy", "no-referrer");
    void reply.header("cache-control", "no-store");
  });

  // Unchanged from slice 2, deliberately: the tile in slice 4 is built on
  // this shape. It is also the one read route that writes -- the probe row
  // is how dbWritable is proved. The dashboard does not go through it.
  // One additive key: `sha`, the running commit, so a deploy
  // can poll until it equals the pulled HEAD. The tile's parse ignores it.
  const sha = deps.sha ?? null;
  app.get("/healthz", async (_req, reply) => {
    const health = store.health(now());
    return reply.code(health.ok ? 200 : 503).send({ ...health, sha });
  });

  const model = () =>
    buildDashboard(store.db, {
      dbPath: config.dbPath,
      truncatedAfterMinutes: config.truncatedAfterMinutes,
      now: now(),
    });

  const fitness = () =>
    buildFitness(store.db, {
      dbPath: config.dbPath,
      truncatedAfterMinutes: config.truncatedAfterMinutes,
      now: now(),
      goals: {
        moveKcal: config.goalMoveKcal,
        exerciseMinutes: config.goalExerciseMinutes,
        standHours: config.goalStandHours,
      },
      thirdRing: config.thirdRing,
      sourcePriority: config.sourcePriority,
      sourceNames: config.sourceNames,
      autoRefreshSeconds: config.autoRefreshSeconds,
    });

  // `/` is the fitness face. The ops dashboard is not gone and not reduced --
  // it moved to /pipe, where the delivery log belongs, and the pill on `/`
  // links to it. Cramming a delivery log under Apple rings ruins both.
  app.get("/", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").send(renderFitness(fitness())),
  );

  app.get("/pipe", async (_req, reply) =>
    reply.type("text/html; charset=utf-8").send(renderDashboard(model())),
  );

  // Same numbers as the page, for the Synapse tile and for anything that
  // would otherwise scrape the HTML.
  app.get("/api/summary", async (_req, reply) => reply.send(model()));

  // The read model behind the fitness page. Same numbers as `/`, for anything
  // that would otherwise scrape the HTML.
  app.get("/api/fitness", async (_req, reply) => reply.send(fitness()));

  app.get("/assets/app.css", async (_req, reply) =>
    reply.type("text/css; charset=utf-8").send(FITNESS_CSS),
  );

  app.get("/assets/pipe.css", async (_req, reply) =>
    reply.type("text/css; charset=utf-8").send(DASHBOARD_CSS),
  );

  // VR2: only on a loopback bind. A Host header is the client's word; on a
  // LAN bind it could be forged, so there the route does not exist at all.
  if (isLoopbackHost(config.readHost)) {
    registerRestartRoute(app, { port: config.readPort, ...(deps.restart ? { restart: deps.restart } : {}) });
  }

  app.setNotFoundHandler(async (req, reply) =>
    reply.code(404).send({
      ok: false,
      error: "not found",
      routes: ["/", "/pipe", "/healthz", "/api/summary", "/api/fitness", "/assets/app.css", "/assets/pipe.css"],
    }),
  );

  return app;
}
