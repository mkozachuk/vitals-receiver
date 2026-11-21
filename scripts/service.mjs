// The npm service verbs on every platform (NB-775):
//
//   node scripts/service.mjs install|uninstall|verify|restart|logs [args]
//
// Windows runs scripts\windows\<script>.ps1 under Windows PowerShell with the
// arguments forwarded. Everything else runs `bash scripts/service.sh <verb>`
// exactly as before (stdio inherited, exit code propagated): macOS and Linux
// are decided there, on `uname -s`. Plain ESM and node builtins only, so it
// runs before any dependency is installed and needs no TypeScript loader.
import { spawnSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/** npm verb -> the Windows script that carries it. */
export const WINDOWS_SCRIPTS = Object.freeze({
  install: "service-install.ps1",
  uninstall: "service-uninstall.ps1",
  verify: "verify-service.ps1",
  restart: "restart.ps1",
  logs: "logs.ps1",
});

/**
 * The command for one verb on one platform, as [file, args], or null for a
 * verb Windows has no script for. Pure: the tests call it with a stubbed
 * platform. Paths are relative to the repository root (the spawn's cwd).
 */
export function command(verb, platform, args = []) {
  if (platform === "win32") {
    const script = Object.hasOwn(WINDOWS_SCRIPTS, verb) ? WINDOWS_SCRIPTS[verb] : undefined;
    if (script === undefined) return null;
    return [
      "powershell.exe",
      ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", `scripts\\windows\\${script}`, ...args],
    ];
  }
  return ["bash", ["scripts/service.sh", verb, ...args]];
}

function main(argv) {
  const [verb = "", ...args] = argv;
  const cmd = command(verb, process.platform, args);
  if (cmd === null) {
    process.stderr.write(`usage: node scripts/service.mjs ${Object.keys(WINDOWS_SCRIPTS).join("|")} [args]\n`);
    return 2;
  }
  const [file, fileArgs] = cmd;
  const r = spawnSync(file, fileArgs, { cwd: REPO, stdio: "inherit" });
  if (r.error) {
    process.stderr.write(`vitals: could not run ${file}: ${r.error.message}\n`);
    return 127;
  }
  if (r.status === null) return 1;
  return r.status;
}

const invoked = process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invoked) process.exitCode = main(process.argv.slice(2));
