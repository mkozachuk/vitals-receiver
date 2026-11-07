import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import type { Config } from "./config.js";
import { envelopeSchema, sampleSchema, SCHEMA_VERSION, type Sample } from "./envelope.js";
import type { Store } from "./store.js";
import { tokenMatches, type TokenSource } from "./token.js";

/**
 * The one rule this whole server hangs on: healthd never reads our response
 * body, and every 4xx we actually send (401, 404, bare 413 -- we never set
 * Retry-After) is a status healthd treats as permanent, so that batch is lost
 * for good. healthd does retry from its outbox, but only on no answer
 * (transport failure) and on 408/425/429/5xx (and a 413 carrying Retry-After),
 * for up to 7 days -- see healthd/Export/RetryDisposition.swift:80-120 and
 * healthd/Export/PendingWork.swift:31. That is why our internal-error 500 is
 * survivable and a 4xx is not.
 *
 *   - 2xx for anything we can persist, including bytes we cannot parse
 *     (those go to `quarantine` and are answered 200).
 *   - non-2xx ONLY for configuration errors the owner must see:
 *     401 (credential) and 413 (oversize).
 */

export interface IngestDeps {
  config: Config;
  store: Store;
  token: TokenSource;
  log?: (line: string) => void;
  /**
   * The clock stamped onto `received_at`, as a function for the reason the
   * read server's is one: this listener outlives its requests. Optional and
   * defaulting to the real clock, so `src/server.ts` passes nothing and the
   * live daemon is unchanged.
   *
   * It exists so a test can hold BOTH sides of the pipe at one instant.
   * `received_at` is the only timestamp in this store the sender does not
   * supply; leaving it on the wall clock while the read side is pinned makes
   * every delivery arrive from the future, which is its own kind of rot.
   */
  now?: () => Date;
}

interface RequestContext {
  receivedAt: string;
  remoteAddr: string | null;
  method: string;
  path: string;
  bytes: number;
  raw: string;
  headers: Record<string, unknown>;
}

const CANONICAL_PATH = "/ingest";

export function buildIngestServer(deps: IngestDeps): FastifyInstance {
  const { config, store, token } = deps;
  const log = deps.log ?? (() => {});
  const now = deps.now ?? (() => new Date());

  // logger: false already silences request logging; fastify 5 deprecates the
  // explicit disableRequestLogging option.
  const app = Fastify({
    bodyLimit: config.maxBodyBytes,
    logger: false,
    trustProxy: false,
  });

  // Take the body verbatim, whatever the Content-Type claims. We parse JSON
  // ourselves so that a parse failure can be quarantined instead of becoming
  // a 400 that destroys the batch.
  app.removeAllContentTypeParsers();
  app.addContentTypeParser("*", { parseAs: "string" }, (_req, body, done) => done(null, body));

  app.addHook("onSend", async (_req, reply) => {
    void reply.header("x-content-type-options", "nosniff");
    void reply.header("content-security-policy", "default-src 'none'");
  });

  const context = (req: FastifyRequest): RequestContext => {
    const raw = typeof req.body === "string" ? req.body : "";
    return {
      receivedAt: now().toISOString(),
      remoteAddr: req.ip ?? null,
      method: req.method,
      path: req.url,
      bytes: Buffer.byteLength(raw, "utf8"),
      raw,
      headers: req.headers as Record<string, unknown>,
    };
  };

  const quarantine = (ctx: RequestContext, reason: string, detail: string | null): void => {
    const deliveryId = store.recordDelivery({
      receivedAt: ctx.receivedAt,
      remoteAddr: ctx.remoteAddr,
      method: ctx.method,
      path: ctx.path,
      status: 200,
      bytes: ctx.bytes,
      outcome: "quarantined",
      note: reason,
    });
    store.recordQuarantine({
      receivedAt: ctx.receivedAt,
      remoteAddr: ctx.remoteAddr,
      reason,
      detail,
      headers: ctx.headers,
      body: ctx.raw,
      deliveryId,
    });
    log(`${ctx.receivedAt} 200 quarantined reason=${reason} bytes=${ctx.bytes} from=${ctx.remoteAddr ?? "?"}`);
  };

  const handler = async (req: FastifyRequest, reply: FastifyReply): Promise<unknown> => {
    const startedNs = process.hrtime.bigint();
    const ctx = context(req);
    const elapsedMs = (): number => Number((process.hrtime.bigint() - startedNs) / 1_000_000n);

    // 1. Credential. A wrong or missing one is a configuration error the
    //    owner has to see, so it is one of the only two non-2xx answers.
    if (!tokenMatches(token.current(), ctx.headers[config.tokenHeader])) {
      store.recordDelivery({
        receivedAt: ctx.receivedAt,
        remoteAddr: ctx.remoteAddr,
        method: ctx.method,
        path: ctx.path,
        status: 401,
        bytes: ctx.bytes,
        outcome: "unauthorised",
        durationMs: elapsedMs(),
        note: ctx.headers[config.tokenHeader] === undefined ? "no credential header" : "credential mismatch",
      });
      log(`${ctx.receivedAt} 401 unauthorised bytes=${ctx.bytes} from=${ctx.remoteAddr ?? "?"}`);
      return reply.code(401).send({ ok: false, error: "unauthorised" });
    }

    // 2. Bytes we cannot turn into JSON are still health data. Keep them.
    let parsed: unknown;
    try {
      parsed = JSON.parse(ctx.raw);
    } catch (err) {
      quarantine(ctx, "unparseable-json", err instanceof Error ? err.message : String(err));
      return reply.code(200).send({ ok: true, stored: 0, quarantined: 1 });
    }

    // 3. A schemaVersion we do not know. payload.md says reject; we keep the
    //    bytes and answer 200 instead, because rejecting means the data is
    //    gone forever. The quarantine count is surfaced on /healthz.
    const version = (parsed as { schemaVersion?: unknown } | null)?.schemaVersion;
    if (version !== SCHEMA_VERSION) {
      quarantine(ctx, "unknown-schema-version", `schemaVersion=${JSON.stringify(version)}`);
      return reply.code(200).send({ ok: true, stored: 0, quarantined: 1 });
    }

    // 4. Envelope shape.
    const envelopeResult = envelopeSchema.safeParse(parsed);
    if (!envelopeResult.success) {
      const detail = envelopeResult.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; ");
      quarantine(ctx, "bad-envelope", detail);
      return reply.code(200).send({ ok: true, stored: 0, quarantined: 1 });
    }
    const envelope = envelopeResult.data;

    // 5. The connectivity probe: acknowledge, record nothing but the
    //    delivery. A probe that somehow carries samples is treated as an
    //    export -- we never bin samples over a flag.
    if (envelope.connectivityTest && envelope.samples.length === 0) {
      store.recordDelivery({
        receivedAt: ctx.receivedAt,
        remoteAddr: ctx.remoteAddr,
        method: ctx.method,
        path: ctx.path,
        status: 200,
        bytes: ctx.bytes,
        outcome: "probe",
        exportId: envelope.exportId,
        batchSequence: envelope.batchSequence,
        durationMs: elapsedMs(),
      });
      log(`${ctx.receivedAt} 200 probe bytes=${ctx.bytes} from=${ctx.remoteAddr ?? "?"}`);
      return reply.code(200).send({ ok: true, probe: true });
    }

    // 6. Samples, one at a time: one malformed sample must not cost the 999
    //    good ones beside it.
    const valid: Sample[] = [];
    const rejected: { index: number; detail: string; value: unknown }[] = [];
    envelope.samples.forEach((candidate, index) => {
      const result = sampleSchema.safeParse(candidate);
      if (result.success) {
        valid.push(result.data);
      } else {
        rejected.push({
          index,
          detail: result.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`).join("; "),
          value: candidate,
        });
      }
    });

    const result = store.storeBatch(envelope, valid, ctx.receivedAt, ctx.bytes, rejected.length);

    if (rejected.length > 0) {
      store.recordQuarantine({
        receivedAt: ctx.receivedAt,
        remoteAddr: ctx.remoteAddr,
        reason: "bad-sample",
        detail: rejected.map((r) => `[${r.index}] ${r.detail}`).join(" | "),
        headers: ctx.headers,
        body: JSON.stringify(rejected.map((r) => r.value)),
      });
    }

    const notes: string[] = [];
    if (ctx.path !== CANONICAL_PATH) notes.push(`non-canonical path ${ctx.path}`);
    if (result.drift !== null) notes.push(result.drift);
    if (result.duplicates > 0) notes.push(`${result.duplicates} duplicate sample(s)`);

    store.recordDelivery({
      receivedAt: ctx.receivedAt,
      remoteAddr: ctx.remoteAddr,
      method: ctx.method,
      path: ctx.path,
      status: 200,
      bytes: ctx.bytes,
      sampleCount: envelope.samples.length,
      storedCount: result.stored,
      duplicateCount: result.duplicates,
      rejectedCount: rejected.length,
      outcome: "export",
      exportId: envelope.exportId,
      batchSequence: envelope.batchSequence,
      durationMs: elapsedMs(),
      note: notes.length === 0 ? null : notes.join(" | "),
    });
    log(
      `${ctx.receivedAt} 200 export export=${envelope.exportId} seq=${envelope.batchSequence}` +
        ` final=${envelope.isFinalBatch} samples=${valid.length} stored=${result.stored}` +
        ` duplicates=${result.duplicates} rejected=${rejected.length} bytes=${ctx.bytes}`,
    );

    return reply
      .code(200)
      .send({ ok: true, stored: result.stored, duplicates: result.duplicates, quarantined: rejected.length > 0 ? 1 : 0 });
  };

  // Canonical path first, then any other POST path. A typo in the endpoint
  // the owner types into the phone must not cost an export: we take the data
  // and record the path we were called on.
  app.post(CANONICAL_PATH, handler);
  app.post("/", handler);
  app.post("/*", handler);

  app.setNotFoundHandler((req, reply) => {
    const ctx = context(req);
    store.recordDelivery({
      receivedAt: ctx.receivedAt,
      remoteAddr: ctx.remoteAddr,
      method: ctx.method,
      path: ctx.path,
      status: 404,
      bytes: ctx.bytes,
      outcome: "unroutable",
      note: "not a POST",
    });
    return reply.code(404).send({ ok: false, error: "this port accepts POST only", endpoint: CANONICAL_PATH });
  });

  app.setErrorHandler((error: unknown, req, reply) => {
    const ctx = context(req);
    const tooLarge = (error as { code?: string }).code === "FST_ERR_CTP_BODY_TOO_LARGE";
    const message = error instanceof Error ? error.message : String(error);
    const status = tooLarge ? 413 : 500;
    store.recordDelivery({
      receivedAt: ctx.receivedAt,
      remoteAddr: ctx.remoteAddr,
      method: ctx.method,
      path: ctx.path,
      status,
      bytes: Number(req.headers["content-length"] ?? ctx.bytes),
      outcome: tooLarge ? "oversize" : "quarantined",
      note: tooLarge ? `body over ${config.maxBodyBytes} bytes` : message,
    });
    log(`${ctx.receivedAt} ${status} ${tooLarge ? "oversize" : "error"} ${message}`);
    return reply.code(status).send({ ok: false, error: tooLarge ? "payload too large" : "internal error" });
  });

  return app;
}
