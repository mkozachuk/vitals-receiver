/**
 * The restart policy of scripts/windows/run.ps1, as a pure function (NB-775).
 * run.ps1 is the code that runs; this is its mirror, so the policy can be
 * tested on a machine with no PowerShell. tests/windows-service.test.ts
 * exercises decide() and checks that run.ps1 carries the same four constants.
 *
 *   exit 75 (POST /api/restart)  restart at once, never counted
 *   exit 0                       stop: the loop ends with exit 0
 *   anything else                wait BACKOFF_SECONDS and restart; a failure
 *                                that would be the (MAX_RESTARTS + 1)th within
 *                                WINDOW_SECONDS gives up instead (exit 1)
 */

export const RESTART_EXIT = 75;
export const BACKOFF_SECONDS = 10;
export const MAX_RESTARTS = 5;
export const WINDOW_SECONDS = 600;

export type Decision =
  | { action: "restart"; failures: number[] }
  | { action: "stop"; failures: number[] }
  | { action: "backoff"; waitSeconds: number; failures: number[] }
  | { action: "give-up"; failures: number[] };

/**
 * One exit of node. `failures` holds the times (seconds) of earlier failed
 * exits; the returned list is what the loop carries to the next exit.
 */
export function decide(code: number, failures: readonly number[], nowSeconds: number): Decision {
  if (code === RESTART_EXIT) return { action: "restart", failures: [...failures] };
  if (code === 0) return { action: "stop", failures: [...failures] };
  const recent = [...failures.filter((t) => nowSeconds - t < WINDOW_SECONDS), nowSeconds];
  if (recent.length > MAX_RESTARTS) return { action: "give-up", failures: recent };
  return { action: "backoff", waitSeconds: BACKOFF_SECONDS, failures: recent };
}
