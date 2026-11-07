import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

export interface TokenSource {
  /** The credential we currently expect, or null if there is none. */
  current(): string | null;
}

/**
 * Reads the credential from disk, re-reading only when the file's mtime
 * changes -- so rotating it does not need a restart, and the common path
 * costs one stat().
 */
export function fileTokenSource(file: string): TokenSource {
  let cached: { mtimeMs: number; value: string } | null = null;
  return {
    current(): string | null {
      try {
        const stat = fs.statSync(file);
        if (!cached || cached.mtimeMs !== stat.mtimeMs) {
          cached = { mtimeMs: stat.mtimeMs, value: fs.readFileSync(file, "utf8").trim() };
        }
        return cached.value.length > 0 ? cached.value : null;
      } catch {
        cached = null;
        return null;
      }
    },
  };
}

export function staticTokenSource(value: string): TokenSource {
  return { current: () => (value.length > 0 ? value : null) };
}

/**
 * Constant-time comparison. Both sides are hashed first so that a length
 * difference cannot be measured either.
 */
export function tokenMatches(expected: string | null, provided: unknown): boolean {
  if (expected === null || expected.length === 0) return false;
  const candidate = Array.isArray(provided) ? provided[0] : provided;
  if (typeof candidate !== "string" || candidate.length === 0) return false;
  const a = crypto.createHash("sha256").update(expected).digest();
  const b = crypto.createHash("sha256").update(candidate).digest();
  return crypto.timingSafeEqual(a, b);
}

/** Mints a new credential, 0600, and returns the path. Never logs the value. */
export function mintToken(file: string): { file: string; bytes: number } {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const value = crypto.randomBytes(32).toString("hex");
  fs.writeFileSync(file, value + "\n", { mode: 0o600 });
  fs.chmodSync(file, 0o600);
  return { file, bytes: 32 };
}
