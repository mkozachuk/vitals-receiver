import crypto from "node:crypto";
import net from "node:net";

/**
 * The ingest listener's rate limiter: fixed windows, in memory, reset on
 * restart. Three counters, each one Map:
 *
 *   - ip    every request, keyed by client (C1)
 *   - token every request whose credential matches, keyed by the SHA-256 of
 *           the presented value, shared across addresses (C2)
 *   - auth  only 401 outcomes, keyed by client (C3)
 *
 * Why not @fastify/rate-limit: it counts every request, while the auth
 * budget counts only 401s, and a refusal here must be logged once per bucket
 * per window (not once per request) on the clock the ingest server already
 * takes in `IngestDeps.now`.
 *
 * Default sizing (src/config.ts): 1200 requests per 60 s window is 20 req/s
 * sustained -- 26x the busiest 60 s the live store has seen (45 deliveries)
 * and above its busiest second (12) held for a whole minute. A 1000-batch
 * backfill is ~1000 MB of uploads and cannot fit in one window on a phone
 * link. healthd retries a 429 and honours Retry-After, so a refusal delays
 * data; it never destroys it.
 *
 * Memory: each Map holds at most `maxKeys` entries. A bucket is (re)inserted
 * only when its window opens, so insertion order is window-start order:
 * expired buckets sit at the front and a sweep from the front stops at the
 * first live one. Past the cap, the oldest entry is evicted.
 */

export type BucketKind = "ip" | "token" | "auth";

export interface RateLimitOptions {
  /** Window for the ip and token counters, ms. */
  windowMs: number;
  /** Per-window maxima. 0 switches that counter off. */
  ipMax: number;
  tokenMax: number;
  /** 401s allowed per client per auth window before every request is refused. */
  authFailMax: number;
  authFailWindowMs: number;
  /** Cap on entries per Map. */
  maxKeys: number;
}

export interface Refusal {
  kind: BucketKind;
  /** How the bucket is named in a log line or row: `ip=<client>` or
   *  `token=<first 8 hex of the hash>`. Never the credential. */
  name: string;
  /** Whole seconds to the end of the window, at least 1. */
  retryAfterSeconds: number;
  /** True for the first refusal of this bucket in this window: the only one
   *  that writes a row and a log line. */
  first: boolean;
}

export interface WindowSummary {
  kind: BucketKind;
  name: string;
  refused: number;
  windowStart: number;
  /** The instant the closed window was noticed (a later request's clock). */
  at: number;
}

export interface RateLimiter {
  checkAuthBudget(client: string, t: number): Refusal | null;
  checkIp(client: string, t: number): Refusal | null;
  checkToken(tokenHash: string, t: number): Refusal | null;
  noteAuthFailure(client: string, t: number): void;
  /** For tests: the size of each Map, and its keys. */
  sizes(): Record<BucketKind, number>;
  keys(): Record<BucketKind, string[]>;
}

interface Bucket {
  start: number;
  count: number;
  refused: number;
}

class Counters {
  private readonly map = new Map<string, Bucket>();

  constructor(
    private readonly kind: BucketKind,
    private readonly windowMs: number,
    private readonly maxKeys: number,
    private readonly onSummary: (s: WindowSummary) => void,
  ) {}

  get size(): number {
    return this.map.size;
  }

  keys(): string[] {
    return [...this.map.keys()];
  }

  name(key: string): string {
    return this.kind === "token" ? `token=${key.slice(0, 8)}` : `ip=${key}`;
  }

  /** A closed window with more than one refusal gets its `xN` summary; one
   *  refusal was already said in full by the first line. */
  private close(key: string, b: Bucket, t: number): void {
    if (b.refused > 1) {
      this.onSummary({ kind: this.kind, name: this.name(key), refused: b.refused, windowStart: b.start, at: t });
    }
  }

  private sweep(t: number): void {
    for (const [key, b] of this.map) {
      if (t < b.start + this.windowMs) break;
      this.map.delete(key);
      this.close(key, b, t);
    }
  }

  /** The live bucket for `key`, or undefined. Never creates one. */
  peek(key: string, t: number): Bucket | undefined {
    this.sweep(t);
    const b = this.map.get(key);
    if (b === undefined) return undefined;
    // A clock that stepped backwards can leave an expired bucket behind the
    // sweep's stop point; judge each one on its own window too.
    if (t >= b.start + this.windowMs || t < b.start) {
      this.map.delete(key);
      this.close(key, b, t);
      return undefined;
    }
    return b;
  }

  /** The live bucket for `key`, opening a window at `t` if there is none. */
  touch(key: string, t: number): Bucket {
    const live = this.peek(key, t);
    if (live !== undefined) return live;
    const b: Bucket = { start: t, count: 0, refused: 0 };
    this.map.set(key, b);
    while (this.map.size > this.maxKeys) {
      const oldest = this.map.keys().next();
      if (oldest.done === true) break;
      const evicted = this.map.get(oldest.value) as Bucket;
      this.map.delete(oldest.value);
      this.close(oldest.value, evicted, t);
    }
    return b;
  }

  refuse(key: string, b: Bucket, t: number): Refusal {
    b.refused += 1;
    return {
      kind: this.kind,
      name: this.name(key),
      retryAfterSeconds: Math.max(1, Math.ceil((b.start + this.windowMs - t) / 1000)),
      first: b.refused === 1,
    };
  }
}

export function createRateLimiter(opts: RateLimitOptions, onSummary: (s: WindowSummary) => void = () => {}): RateLimiter {
  const ip = new Counters("ip", opts.windowMs, opts.maxKeys, onSummary);
  const token = new Counters("token", opts.windowMs, opts.maxKeys, onSummary);
  const auth = new Counters("auth", opts.authFailWindowMs, opts.maxKeys, onSummary);

  const hit = (counters: Counters, max: number, key: string, t: number): Refusal | null => {
    if (max <= 0) return null;
    const b = counters.touch(key, t);
    b.count += 1;
    return b.count > max ? counters.refuse(key, b, t) : null;
  };

  return {
    checkAuthBudget(client, t) {
      if (opts.authFailMax <= 0) return null;
      const b = auth.peek(client, t);
      return b !== undefined && b.count >= opts.authFailMax ? auth.refuse(client, b, t) : null;
    },
    checkIp: (client, t) => hit(ip, opts.ipMax, client, t),
    checkToken: (tokenHash, t) => hit(token, opts.tokenMax, tokenHash, t),
    noteAuthFailure(client, t) {
      if (opts.authFailMax <= 0) return;
      auth.touch(client, t).count += 1;
    },
    sizes: () => ({ ip: ip.size, token: token.size, auth: auth.size }),
    keys: () => ({ ip: ip.keys(), token: token.keys(), auth: auth.keys() }),
  };
}

/** The token counter's key: never the credential itself. */
export function tokenKey(presented: string): string {
  return crypto.createHash("sha256").update(presented).digest("hex");
}

const MAPPED_V4 = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/;

/** `::ffff:a.b.c.d` -> `a.b.c.d`; anything else unchanged (lower-cased). */
export function unmapIPv4(address: string): string {
  const lower = address.toLowerCase();
  const m = MAPPED_V4.exec(lower);
  return m !== null ? (m[1] as string) : lower;
}

function ipv6Groups(address: string): number[] {
  let s = address.split("%")[0] as string;
  const v4 = /(\d{1,3}(?:\.\d{1,3}){3})$/.exec(s);
  if (v4 !== null) {
    const [a, b, c, d] = (v4[1] as string).split(".").map(Number) as [number, number, number, number];
    s = s.slice(0, s.length - (v4[1] as string).length) + `${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const double = s.indexOf("::");
  const head = double === -1 ? s : s.slice(0, double);
  const tail = double === -1 ? "" : s.slice(double + 2);
  const h = head.length > 0 ? head.split(":") : [];
  const tl = tail.length > 0 ? tail.split(":") : [];
  const fill = double === -1 ? [] : new Array<string>(8 - h.length - tl.length).fill("0");
  return [...h, ...fill, ...tl].map((g) => parseInt(g, 16));
}

/**
 * The client key for the ip and auth counters. IPv4 as is; an IPv4-mapped
 * IPv6 address as its IPv4; any other IPv6 address by its /64 prefix, because
 * one host is routinely handed a whole /64 and rotates through it.
 */
export function clientKey(ip: string): string {
  const address = unmapIPv4(ip);
  if (!net.isIPv6(address)) return address;
  const prefix = ipv6Groups(address)
    .slice(0, 4)
    .map((g) => g.toString(16))
    .join(":");
  return `${prefix}::/64`;
}

/**
 * `VITALS_TRUST_PROXY` as Fastify's trustProxy function form: X-Forwarded-For
 * is honoured only for hops whose address is trusted. `off` trusts nothing, so
 * `req.ip` is always the socket peer.
 */
export function trustProxyFn(setting: "off" | "loopback" | string[]): (address: string, hop: number) => boolean {
  if (setting === "off") return () => false;
  if (setting === "loopback") {
    return (address) => {
      const a = unmapIPv4(address);
      return a === "::1" || (net.isIPv4(a) && a.startsWith("127."));
    };
  }
  const trusted = new Set(setting.map(unmapIPv4));
  return (address) => trusted.has(unmapIPv4(address));
}
