/**
 * Check (d) of scripts/windows/verify-service.ps1 as a pure function (NB-847).
 * verify-service.ps1 is the code that runs; this is its mirror, so the
 * credential-ACL decision can be tested on a machine with no PowerShell.
 * tests/windows-service.test.ts feeds it icacls output and checks that the
 * ps1 block carries the same algorithm.
 *
 * Per icacls row: strip the token path if the row starts with it, then match
 * `^\s*(.+):\(` and keep the trimmed principal. No principals -> the ACL could
 * not be read; any principal other than the running user -> not private.
 */

export type AclVerdict = { kind: "ok" } | { kind: "no-principals" } | { kind: "others"; others: string[] };

export function principalsOf(lines: readonly string[], tokenPath: string): string[] {
  const principals: string[] = [];
  for (const row of lines) {
    let s = row;
    if (s.startsWith(tokenPath)) s = s.slice(tokenPath.length);
    const m = /^\s*(.+):\(/.exec(s);
    if (m?.[1] !== undefined) principals.push(m[1].trim());
  }
  return principals;
}

export function decideAcl(lines: readonly string[], tokenPath: string, me: string): AclVerdict {
  const principals = principalsOf(lines, tokenPath);
  // Matches PowerShell -ne, which compares strings case-insensitively; others keep their spelling.
  const meLower = me.toLowerCase();
  const others = principals.filter((p) => p.toLowerCase() !== meLower);
  if (principals.length === 0) return { kind: "no-principals" };
  if (others.length > 0) return { kind: "others", others };
  return { kind: "ok" };
}
