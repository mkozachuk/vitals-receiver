import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * The startup line: one fact the store cannot record about itself -- when
 * this process began listening, and which commit it is running. With it, a
 * day with no deliveries can be told apart: a receiver that was down (no
 * start line, or a `startedAt` after the gap) versus a phone that never
 * sent (receiver up throughout).
 *
 * Deliberately carries no path, hostname, address or port: it lands in a log
 * file and in `/healthz`, and neither needs to identify the machine.
 */

const COMMIT = /^([0-9a-f]{7,40}|unknown)$/;

/** The repository this module runs from: the parent of `src/`. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export interface ResolveCommitOptions {
  /** The git binary. A seam for the "git is absent" test, nothing else. */
  git?: string;
  /** Upper bound on the lookup, in ms. Startup never waits longer. */
  timeoutMs?: number;
}

/**
 * The short commit of `dir`, or `unknown`. Never throws, never uses a shell,
 * never waits more than `timeoutMs`.
 *
 * `GIT_CEILING_DIRECTORIES` stops git at `dir` itself: a checkout copied out
 * of its repository must say `unknown`, not borrow the commit of whatever
 * repository happens to enclose it.
 */
export function resolveCommit(dir: string = REPO_ROOT, options: ResolveCommitOptions = {}): string {
  const out = revParse(dir, ["--short=12", "HEAD"], options);
  return out !== null && COMMIT.test(out) ? out : "unknown";
}

const FULL_SHA = /^[0-9a-f]{40}$/;

/**
 * The full 40-hex commit of `dir`, or `null` (RC6) -- by the same
 * rules as `resolveCommit`: no shell, the ceiling at `dir`, the timeout.
 * Works from a `git worktree` checkout, where `.git` is a file.
 */
export function resolveSha(dir: string = REPO_ROOT, options: ResolveCommitOptions = {}): string | null {
  const out = revParse(dir, ["HEAD"], options);
  return out !== null && FULL_SHA.test(out) ? out : null;
}

/**
 * The commit this process runs, resolved ONCE at start and held: `/healthz`
 * reports the code that is running, not whatever the checkout has moved to
 * since. A failure costs one WARNING line and never stops startup.
 */
export function runningSha(log: (line: string) => void, dir: string = REPO_ROOT, options: ResolveCommitOptions = {}): string | null {
  const sha = resolveSha(dir, options);
  if (sha === null) log("vitals: WARNING commit not resolved; /healthz sha is null");
  return sha;
}

/** The startup line's 12-hex token, from the one resolved sha. */
export function shortCommit(sha: string | null): string {
  return sha === null ? "unknown" : sha.slice(0, 12);
}

function revParse(dir: string, args: string[], options: ResolveCommitOptions): string | null {
  const env: NodeJS.ProcessEnv = { ...process.env, GIT_CEILING_DIRECTORIES: path.dirname(path.resolve(dir)) };
  delete env.GIT_DIR;
  delete env.GIT_WORK_TREE;
  try {
    return execFileSync(options.git ?? "git", ["rev-parse", ...args], {
      cwd: dir,
      env,
      timeout: options.timeoutMs ?? 2000,
      stdio: ["ignore", "pipe", "ignore"],
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

/** `vitals: started <ISO> commit <rev|unknown>` -- pure, for the test. */
export function startupLine(startedAt: number, commit: string): string {
  const rev = COMMIT.test(commit) ? commit : "unknown";
  return `vitals: started ${new Date(startedAt).toISOString()} commit ${rev}`;
}
