import { pathToFileURL } from "node:url";

/**
 * `npm run silence:check` -- is the phone still talking to us?
 *
 * healthd can stop exporting without anyone noticing: iOS kills background
 * delivery, the app loses its permission, the phone leaves the LAN. The
 * receiver cannot raise an alarm about a request that never came, so this
 * script asks it from the outside: it reads `lastExportAt` from /healthz and
 * says something only when there is something to say.
 *
 * The output contract is for a scheduler that delivers stdout verbatim and
 * stays silent when stdout is empty:
 *
 *   fresh (now - lastExportAt <= threshold)  -> no stdout
 *   stale                                     -> one line: hours and timestamp
 *   lastExportAt is null                      -> one line: nothing ever arrived
 *   unreachable / non-200 / unparseable       -> one line: receiver is down
 *
 * The exit code is always 0. A non-zero exit is a scheduler's signal that the
 * JOB broke, and many schedulers swallow or reformat a failing job's output;
 * every outcome here is a report, and the report is the line on stdout.
 *
 * Only a loopback host is ever named in a message. A LAN address in a
 * notification is a LAN address in someone's chat history.
 *
 * Environment:
 *   VITALS_URL            read listener base URL (default http://127.0.0.1:4780)
 *   VITALS_SILENCE_HOURS  threshold in hours, a positive number (default 24)
 */

export const DEFAULT_URL = "http://127.0.0.1:4780";
export const DEFAULT_HOURS = 24;
export const TIMEOUT_MS = 5_000;

const HOUR_MS = 3_600_000;

export interface CheckOptions {
  url: string;
  hours: number;
  now: Date;
  timeoutMs?: number;
}

export interface CheckResult {
  /** The line for the scheduler, or null for silence. */
  stdout: string | null;
}

/** Threshold from the environment; anything unusable falls back, on stderr only. */
export function parseHours(raw: string | undefined): { hours: number; warning: string | null } {
  if (raw === undefined) return { hours: DEFAULT_HOURS, warning: null };
  const trimmed = raw.trim();
  const value = trimmed === "" ? Number.NaN : Number(trimmed);
  if (Number.isFinite(value) && value > 0) return { hours: value, warning: null };
  return {
    hours: DEFAULT_HOURS,
    warning: `vitals silence check: VITALS_SILENCE_HOURS=${JSON.stringify(raw)} is not a positive number; using ${DEFAULT_HOURS}`,
  };
}

/** "127.0.0.1:4780" for a loopback target, a generic name for anything else. */
export function targetName(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "the receiver";
  }
  const host = parsed.hostname.replace(/^\[|\]$/g, "");
  const loopback = host === "localhost" || host === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host);
  return loopback ? `the receiver at ${parsed.host}` : "the receiver";
}

/**
 * A short, host-free name for what went wrong. Never the error message:
 * fetch and DNS errors embed the hostname, and that is exactly what must not
 * reach a non-loopback notification.
 */
export function errorClass(error: unknown): string {
  if (error instanceof Error) {
    if (error.name === "TimeoutError" || error.name === "AbortError") return "timeout";
    const cause = (error as { cause?: unknown }).cause;
    const code = (cause as { code?: unknown } | undefined)?.code ?? (error as { code?: unknown }).code;
    if (typeof code === "string" && /^[A-Z][A-Z0-9_]*$/.test(code)) return code;
    if (error.name === "TypeError") return "fetch-failed";
  }
  return "error";
}

function down(target: string, cls: string): CheckResult {
  return { stdout: `vitals: ${target} is down (${cls}); cannot tell whether healthd is still exporting` };
}

export async function check(options: CheckOptions): Promise<CheckResult> {
  const target = targetName(options.url);
  let endpoint: URL;
  try {
    endpoint = new URL("/healthz", options.url);
  } catch {
    return down(target, "bad-url");
  }

  let response: Response;
  try {
    response = await fetch(endpoint, { signal: AbortSignal.timeout(options.timeoutMs ?? TIMEOUT_MS) });
  } catch (error) {
    return down(target, errorClass(error));
  }
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => undefined);
    return down(target, `http-${response.status}`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (error) {
    return down(target, errorClass(error) === "timeout" ? "timeout" : "bad-json");
  }
  if (body === null || typeof body !== "object" || !("lastExportAt" in body)) {
    return down(target, "bad-body");
  }
  const last = (body as { lastExportAt: unknown }).lastExportAt;
  if (last === null) {
    return { stdout: "vitals: no healthd export has ever arrived" };
  }
  const lastMs = typeof last === "string" ? Date.parse(last) : Number.NaN;
  if (!Number.isFinite(lastMs)) return down(target, "bad-body");

  const silentMs = options.now.getTime() - lastMs;
  if (silentMs <= options.hours * HOUR_MS) return { stdout: null };
  const silentHours = Math.floor(silentMs / HOUR_MS);
  return {
    stdout: `vitals: no healthd export for ${silentHours} h (last at ${new Date(lastMs).toISOString()}, threshold ${options.hours} h)`,
  };
}

async function main(): Promise<void> {
  const { hours, warning } = parseHours(process.env.VITALS_SILENCE_HOURS);
  if (warning !== null) process.stderr.write(`${warning}\n`);
  const url = process.env.VITALS_URL || DEFAULT_URL;
  const result = await check({ url, hours, now: new Date() });
  if (result.stdout !== null) process.stdout.write(`${result.stdout}\n`);
}

// Importable for tests -- the fetch happens only when this file is invoked.
const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) {
  main()
    .catch((error: unknown) => {
      // Still a report, still exit 0: a crashed check is a silent check.
      process.stdout.write(`vitals: silence check failed (${errorClass(error)})\n`);
    })
    .finally(() => {
      process.exitCode = 0;
    });
}
