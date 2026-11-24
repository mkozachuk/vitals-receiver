import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { after, describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { windowsPaths } from "../scripts/windows/paths.js";
import { BACKOFF_SECONDS, decide, MAX_RESTARTS, RESTART_EXIT, WINDOW_SECONDS } from "../scripts/windows/policy.js";

/**
 * NB-775: the Windows always-on example (a per-user scheduled task). Nothing
 * here needs Windows or PowerShell: the dispatcher is a pure function called
 * with a stubbed platform, the .ps1 files are checked as text against the
 * PowerShell 5.1 subset, and run.ps1's restart policy is exercised through its
 * TypeScript mirror. PowerShell itself never parses these files on this
 * machine; the CI job windows-service is where they run.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..");

// service.mjs is plain JavaScript with no declaration file; import it by URL
// and type the two exports the tests use.
type Command = [string, string[]] | null;
const dispatcher = (await import(pathToFileURL(path.join(REPO, "scripts", "service.mjs")).href)) as {
  command: (verb: string, platform: NodeJS.Platform, args?: string[]) => Command;
  WINDOWS_SCRIPTS: Record<string, string>;
};
const { command, WINDOWS_SCRIPTS } = dispatcher;
const WIN = path.join(REPO, "scripts", "windows");
const VERBS = ["install", "uninstall", "verify", "restart", "logs"] as const;
const roots: string[] = [];

after(() => {
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

function tempRepo(dotEnv?: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "vitals-win-"));
  roots.push(dir);
  if (dotEnv !== undefined) fs.writeFileSync(path.join(dir, ".env"), dotEnv);
  return dir;
}

const ps1Files = (): string[] =>
  fs.readdirSync(WIN).filter((f) => f.endsWith(".ps1")).sort();
const ps1 = (name: string): string => fs.readFileSync(path.join(WIN, name), "utf8");

// --- (a) dispatch --------------------------------------------------------------

describe("windows service: dispatch (scripts/service.mjs)", () => {
  it("win32: every verb runs powershell.exe -File scripts\\windows\\<script>.ps1", () => {
    for (const verb of VERBS) {
      const cmd = command(verb, "win32", ["-Purge"]);
      assert.ok(cmd !== null, verb);
      const [file, args] = cmd;
      assert.equal(file, "powershell.exe", verb);
      assert.deepEqual(args.slice(0, 4), ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File"], verb);
      const script = args[4] as string;
      assert.match(script, /^scripts\\windows\\[a-z-]+\.ps1$/, verb);
      assert.ok(fs.existsSync(path.join(REPO, ...script.split("\\"))), `${verb}: ${script} exists`);
      assert.deepEqual(args.slice(5), ["-Purge"], `${verb}: arguments forwarded`);
    }
  });

  it("win32: the five verbs map to five distinct scripts, all present", () => {
    assert.deepEqual(Object.keys(WINDOWS_SCRIPTS).sort(), [...VERBS].sort());
    const scripts = Object.values(WINDOWS_SCRIPTS);
    assert.equal(new Set(scripts).size, VERBS.length);
    for (const s of scripts) assert.ok(ps1Files().includes(s), s);
  });

  it("darwin and linux: bash scripts/service.sh <verb>, exactly as before", () => {
    for (const platform of ["darwin", "linux"] as const) {
      for (const verb of VERBS) {
        assert.deepEqual(command(verb, platform), ["bash", ["scripts/service.sh", verb]], `${platform} ${verb}`);
        assert.deepEqual(command(verb, platform, ["--purge"]), ["bash", ["scripts/service.sh", verb, "--purge"]]);
      }
    }
  });

  it("win32: an unknown verb has no command", () => {
    assert.equal(command("nope", "win32"), null);
    assert.equal(command("constructor", "win32"), null);
  });

  it("package.json routes every service verb through node scripts/service.mjs", () => {
    const scripts = (JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    for (const [name, verb] of [
      ["service:install", "install"],
      ["service:uninstall", "uninstall"],
      ["service:verify", "verify"],
      ["service:logs", "logs"],
      ["restart", "restart"],
    ] as const) {
      assert.equal(scripts[name], `node scripts/service.mjs ${verb}`);
    }
  });

  it("the real entry point propagates the exit code (an unknown verb exits 2)", async () => {
    const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
      execFile(process.execPath, [path.join(REPO, "scripts", "service.mjs"), "nope"], { cwd: REPO }, (error, _out, err) => {
        resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, err: String(err) });
      });
    });
    assert.equal(r.code, 2, r.err);
    assert.match(r.err, /usage/);
  });

  it("service.mjs is plain ESM on node builtins (no TypeScript loader, no dependency)", () => {
    const src = fs.readFileSync(path.join(REPO, "scripts", "service.mjs"), "utf8");
    const imports = [...src.matchAll(/^import .* from "([^"]+)";$/gm)].map((m) => m[1]);
    assert.ok(imports.length > 0);
    for (const spec of imports) assert.match(spec as string, /^node:/, spec);
    assert.doesNotMatch(src, /\.ts["']/);
  });
});

// --- (b) the PowerShell 5.1 subset ---------------------------------------------

/** Every Verb-Noun token the scripts may use. Windows PowerShell 5.1 ships all of them. */
const CMDLETS = [
  "Add-Content",
  "ConvertFrom-Json",
  "Get-ChildItem",
  "Get-CimInstance",
  "Get-Command",
  "Get-Content",
  "Get-Date",
  "Get-Item",
  "Get-NetTCPConnection",
  "Get-ScheduledTask",
  "Get-ScheduledTaskInfo",
  "Invoke-WebRequest",
  "Join-Path",
  "New-Item",
  "New-Object",
  "New-ScheduledTaskAction",
  "New-ScheduledTaskPrincipal",
  "New-ScheduledTaskSettingsSet",
  "New-ScheduledTaskTrigger",
  "New-TimeSpan",
  "Out-Null",
  "Pop-Location",
  "Push-Location",
  "Register-ScheduledTask",
  "Remove-Item",
  "Resolve-Path",
  "Select-Object",
  "Set-StrictMode",
  "Split-Path",
  "Start-ScheduledTask",
  "Start-Sleep",
  "Stop-Process",
  "Stop-ScheduledTask",
  "Test-Path",
  "Unregister-ScheduledTask",
  "Where-Object",
  "Write-Output",
];

/** PowerShell 7-only syntax and parameters, read over the whole file (comments too). */
const FORBIDDEN: Array<[string, RegExp]> = [
  ["?? (null-coalescing) / ??= / ?. (null-conditional) / ternary ?:", /\?/],
  ["&& pipeline chain", /&&/],
  ["|| pipeline chain", /\|\|/],
  ["ForEach-Object -Parallel", /-Parallel\b/i],
  ["$PSStyle", /\$PSStyle\b/i],
  ["using namespace", /\busing\s+namespace\b/i],
  ["Join-Path -AdditionalChildPath", /-AdditionalChildPath\b/i],
  ["ConvertFrom-Json -AsHashtable", /-AsHashtable\b/i],
  ["Get-Content -AsByteStream", /-AsByteStream\b/i],
];

describe("windows service: the .ps1 files keep to Windows PowerShell 5.1", () => {
  it("the scripts exist: install, uninstall, verify, run, restart, logs", () => {
    for (const f of ["service-install.ps1", "service-uninstall.ps1", "verify-service.ps1", "run.ps1", "restart.ps1", "logs.ps1"]) {
      assert.ok(ps1Files().includes(f), f);
    }
  });

  it("pure ASCII (no BOM needed) with CRLF line endings throughout", () => {
    for (const f of ps1Files()) {
      const bytes = fs.readFileSync(path.join(WIN, f));
      const high = bytes.findIndex((b) => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09));
      assert.equal(high, -1, `${f}: non-ASCII or control byte at offset ${high}`);
      const text = bytes.toString("latin1");
      assert.ok(text.endsWith("\r\n"), `${f}: ends with CRLF`);
      assert.equal(text.replaceAll("\r\n", "").includes("\n"), false, `${f}: a bare LF`);
      assert.equal(text.replaceAll("\r\n", "").includes("\r"), false, `${f}: a bare CR`);
    }
  });

  it("no PowerShell 7-only construct", () => {
    for (const f of ps1Files()) {
      const text = ps1(f);
      for (const [name, re] of FORBIDDEN) {
        const line = text.split("\r\n").findIndex((l) => re.test(l));
        assert.equal(line, -1, `${f}:${line + 1}: ${name}`);
      }
    }
  });

  it("Join-Path takes one child only (no positional -AdditionalChildPath)", () => {
    const arg = /[ \t]*(\$[A-Za-z_][\w.:]*|'[^']*'|"[^"]*"|\([^()]*\))/y;
    for (const f of ps1Files()) {
      const text = ps1(f);
      for (const m of text.matchAll(/Join-Path\b/g)) {
        let n = 0;
        arg.lastIndex = (m.index ?? 0) + m[0].length;
        while (arg.exec(text) !== null) n += 1;
        assert.ok(n <= 2, `${f}: Join-Path with ${n} positional arguments`);
      }
    }
  });

  it("every Verb-Noun token is on the allow-list", () => {
    const seen = new Set<string>();
    for (const f of ps1Files()) {
      for (const m of ps1(f).matchAll(/\b[A-Za-z]+-[A-Za-z][A-Za-z0-9]*\b/g)) {
        const token = m[0];
        // Parameters (-Force) are preceded by '-'; words like "pwsh-only" in
        // comments are lower-case and not cmdlets. Everything else counts.
        const before = ps1(f)[(m.index ?? 0) - 1];
        if (before === "-" || !/^[A-Z][a-z]+-[A-Z]/.test(token)) continue;
        seen.add(token);
        assert.ok(CMDLETS.includes(token), `${f}: ${token} is not on the allow-list`);
      }
    }
    assert.ok(seen.has("Register-ScheduledTask"));
  });
});

// --- (c) run.ps1's restart policy ---------------------------------------------

describe("windows service: run.ps1 restart policy", () => {
  it("75 restarts at once, uncounted; 0 stops", () => {
    assert.deepEqual(decide(75, [1, 2], 3), { action: "restart", failures: [1, 2] });
    assert.deepEqual(decide(0, [1], 3), { action: "stop", failures: [1] });
  });

  it("any other exit waits BACKOFF_SECONDS, five times within the window", () => {
    let failures: number[] = [];
    for (let i = 1; i <= MAX_RESTARTS; i += 1) {
      const d = decide(i === 3 ? -1 : 1, failures, i * 30);
      assert.equal(d.action, "backoff", `failure ${i}`);
      assert.equal((d as { waitSeconds: number }).waitSeconds, BACKOFF_SECONDS);
      failures = d.failures;
    }
    assert.equal(failures.length, 5);
    assert.equal(decide(1, failures, 6 * 30).action, "give-up");
  });

  it("failures older than the window no longer count", () => {
    const failures = [0, 10, 20, 30, 40];
    assert.equal(decide(1, failures, WINDOW_SECONDS - 1).action, "give-up");
    const d = decide(1, failures, WINDOW_SECONDS + 5);
    assert.equal(d.action, "backoff");
    assert.deepEqual(d.failures, [10, 20, 30, 40, WINDOW_SECONDS + 5]);
  });

  it("the constants are 75, 10 s, 5 restarts, 10 minutes", () => {
    assert.deepEqual([RESTART_EXIT, BACKOFF_SECONDS, MAX_RESTARTS, WINDOW_SECONDS], [75, 10, 5, 600]);
  });

  it("run.ps1 carries the same constants and comparisons as the mirror", () => {
    const run = ps1("run.ps1");
    assert.match(run, new RegExp(`^\\$RestartExit = ${RESTART_EXIT}\\r$`, "m"));
    assert.match(run, new RegExp(`^\\$BackoffSeconds = ${BACKOFF_SECONDS}\\r$`, "m"));
    assert.match(run, new RegExp(`^\\$MaxRestarts = ${MAX_RESTARTS}\\r$`, "m"));
    assert.match(run, new RegExp(`^\\$WindowSeconds = ${WINDOW_SECONDS}\\r$`, "m"));
    assert.match(run, /if \(\$code -eq \$RestartExit\) \{/);
    assert.match(run, /if \(\$code -eq 0\) \{/);
    assert.match(run, /\.TotalSeconds -lt \$WindowSeconds/);
    assert.match(run, /if \(\$failures\.Count -gt \$MaxRestarts\) \{/);
    assert.match(run, /Start-Sleep -Seconds \$BackoffSeconds/);
  });
});

// --- listeners -----------------------------------------------------------------

describe("windows service: the read listener stays on loopback", () => {
  it("no .ps1 sets VITALS_READ_HOST to anything but 127.0.0.1; run.ps1 sets it once", () => {
    const set = /VITALS_READ_HOST['"]?\s*[=,:]\s*['"]?([^'"\s;),]*)/g;
    let inRun = 0;
    for (const f of ps1Files()) {
      for (const m of ps1(f).matchAll(set)) {
        assert.equal(m[1], "127.0.0.1", `${f}: VITALS_READ_HOST = ${m[1]}`);
        if (f === "run.ps1") inRun += 1;
      }
    }
    assert.equal(inRun, 1);
    assert.match(ps1("run.ps1"), /^\$env:VITALS_READ_HOST = '127\.0\.0\.1'\r$/m);
  });

  it("the task's arguments carry no listener setting at all", () => {
    const common = ps1("_common.ps1");
    const fn = common.slice(common.indexOf("function TaskArguments"), common.indexOf("function WindowsPowerShell"));
    assert.ok(fn.length > 0);
    assert.doesNotMatch(fn, /VITALS_|HOST|0\.0\.0\.0/);
  });

  it("paths refuse a .env that moves VITALS_READ_HOST off loopback", () => {
    const repo = tempRepo("VITALS_READ_HOST=0.0.0.0\n");
    assert.throws(() => windowsPaths(repo, { LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" }), /must stay on 127\.0\.0\.1/);
  });

  it("paths.ts exits 1 naming the .env, and install reads paths before it writes anything", async () => {
    const repo = tempRepo("VITALS_READ_HOST=0.0.0.0\n");
    const tsx = path.join(REPO, "node_modules", "tsx", "dist", "loader.mjs");
    const r = await new Promise<{ code: number | null; err: string }>((resolve) => {
      // --import takes a URL: a bare D:\\ path reads as a URL scheme on Windows.
      execFile(process.execPath, ["--import", pathToFileURL(tsx).href, path.join(WIN, "paths.ts"), repo], (error, _out, err) => {
        resolve({ code: error === null ? 0 : typeof error.code === "number" ? error.code : null, err: String(err) });
      });
    });
    assert.equal(r.code, 1, r.err);
    assert.match(r.err, /VITALS_READ_HOST=0\.0\.0\.0/);
    const install = ps1("service-install.ps1");
    const first = (needle: string): number => {
      const i = install.indexOf(needle);
      assert.ok(i >= 0, needle);
      return i;
    };
    assert.ok(first("$P = ReadPaths $Node") < first("icacls.exe"));
    assert.ok(first("$P = ReadPaths $Node") < first("Register-ScheduledTask"));
  });

  it("the ingest default is unchanged on win32 (0.0.0.0), the read default loopback", () => {
    const c = loadConfig({ LOCALAPPDATA: "C:\\Users\\ada\\AppData\\Local" }, "win32");
    assert.equal(c.ingestHost, "0.0.0.0");
    assert.equal(c.readHost, "127.0.0.1");
  });
});

// --- paths and ACL (D4, D5) ------------------------------------------------------

describe("windows service: paths", () => {
  const LAD = "C:\\Users\\ada\\AppData\\Local";
  // loadConfig() joins the store file name onto the state dir with the host's
  // path.join, outside defaultPaths (unchanged by NB-775): a backslash on
  // Windows, a slash when this suite stubs win32 on macOS or Linux.
  const db = (stateDir: string): string => path.join(stateDir, "vitals.db");

  it("LOCALAPPDATA set: store, credential and log under %LOCALAPPDATA%\\vitals", () => {
    const c = loadConfig({ LOCALAPPDATA: LAD }, "win32");
    assert.equal(c.stateDir, `${LAD}\\vitals`);
    assert.equal(c.dbPath, db(`${LAD}\\vitals`));
    assert.equal(c.tokenFile, `${LAD}\\vitals\\token`);
    const p = windowsPaths(tempRepo(), { LOCALAPPDATA: LAD });
    assert.deepEqual(p, {
      STATE_DIR: `${LAD}\\vitals`,
      DB: db(`${LAD}\\vitals`),
      TOKEN_FILE: `${LAD}\\vitals\\token`,
      LOG_FILE: `${LAD}\\vitals\\logs\\vitals.log`,
      READ_HOST: "127.0.0.1",
      READ_PORT: "4780",
      INGEST_PORT: "4781",
    });
  });

  it("LOCALAPPDATA unset or empty: <home>\\AppData\\Local", () => {
    const want = path.win32.join(os.homedir(), "AppData", "Local", "vitals");
    for (const env of [{}, { LOCALAPPDATA: "" }]) {
      const c = loadConfig(env, "win32");
      assert.equal(c.stateDir, want);
      assert.equal(c.dbPath, db(want));
      assert.equal(c.tokenFile, `${want}\\token`);
    }
  });

  it("explicit VITALS_STATE_DIR, VITALS_DB and VITALS_TOKEN_FILE still win", () => {
    const s = loadConfig({ LOCALAPPDATA: LAD, VITALS_STATE_DIR: "D:\\vitals" }, "win32");
    assert.equal(s.dbPath, db("D:\\vitals"));
    assert.equal(s.tokenFile, "D:\\vitals\\token");
    const f = loadConfig({ LOCALAPPDATA: LAD, VITALS_DB: "D:\\data\\v.db", VITALS_TOKEN_FILE: "D:\\keys\\t" }, "win32");
    assert.equal(f.dbPath, "D:\\data\\v.db");
    assert.equal(f.tokenFile, "D:\\keys\\t");
  });

  it("darwin and linux defaults are untouched by LOCALAPPDATA", () => {
    // The values themselves are pinned in linux-service.test.ts and config tests.
    for (const platform of ["darwin", "linux"] as const) {
      const without = loadConfig({}, platform);
      const withIt = loadConfig({ LOCALAPPDATA: LAD }, platform);
      assert.equal(withIt.dbPath, without.dbPath, platform);
      assert.equal(withIt.tokenFile, without.tokenFile, platform);
      assert.ok(!withIt.dbPath.includes("AppData"), platform);
    }
    assert.equal(loadConfig({}, "darwin").dbPath, path.join(os.homedir(), "Library", "Application Support", "vitals", "vitals.db"));
  });

  it("install cuts inheritance and grants the running user only, on the credential and the state dir", () => {
    const install = ps1("service-install.ps1");
    assert.match(install, /& icacls\.exe \$P\.TOKEN_FILE \/inheritance:r \/grant:r "\$\{Me\}:\(R,W\)"/);
    assert.match(install, /& icacls\.exe \$P\.STATE_DIR \/inheritance:r \/grant:r "\$\{Me\}:\(OI\)\(CI\)F"/);
    const verify = ps1("verify-service.ps1");
    assert.match(verify, /\(d\) credential ACL also grants/);
    assert.match(verify, /& icacls\.exe \$P\.TOKEN_FILE/);
  });
});

// --- the task definition (D1, D3) ------------------------------------------------

describe("windows service: the scheduled task", () => {
  const install = ps1("service-install.ps1");

  it("at logon, per user, no admin, no time limit, one instance", () => {
    assert.match(install, /New-ScheduledTaskTrigger -AtLogOn -User \$Me/);
    assert.match(install, /New-ScheduledTaskPrincipal -UserId \$Me -LogonType Interactive -RunLevel Limited/);
    assert.match(
      install,
      /New-ScheduledTaskSettingsSet -ExecutionTimeLimit \(New-TimeSpan\) -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -MultipleInstances IgnoreNew/,
    );
    assert.match(install, /Register-ScheduledTask .*-Force/);
    assert.doesNotMatch(install, /-RunLevel Highest/);
  });

  it("idempotent: an identical registered action is left alone; install starts the task", () => {
    assert.match(install, /\$same = \(\$old\.Execute -eq \$Exe\) -and \(\$old\.Arguments -eq \$Arguments\)/);
    assert.match(install, /task unchanged: \$TaskName/);
    assert.match(install, /Start-ScheduledTask -TaskName \$TaskName/);
  });

  it("the action runs run.ps1 under Windows PowerShell with node by absolute path (no npm, no npx)", () => {
    const common = ps1("_common.ps1");
    assert.match(common, /-NoProfile -ExecutionPolicy Bypass -File "' \+ \$RunPs1/);
    assert.match(common, /' -Node "' \+ \$Node \+ '"/);
    assert.match(common, /System32\\WindowsPowerShell\\v1\.0\\powershell\.exe/);
    for (const f of ps1Files()) {
      const code = ps1(f).split("\r\n").filter((l) => !l.trimStart().startsWith("#")).join("\n");
      // "run: npm ci" hints in messages are fine; starting node through npm is not.
      assert.doesNotMatch(code, /\bnpx\b|\bnpm(\.cmd)? (start|exec)\b|&\s*['"]?npm/, f);
    }
  });

  it("install refuses node older than 22, naming the version", () => {
    const common = ps1("_common.ps1");
    assert.match(common, /\[int\]\$Matches\[1\] -ge 22/);
    assert.match(common, /node \$version at \$c is older than 22/);
  });

  it("uninstall keeps store and credential unless -Purge", () => {
    const un = ps1("service-uninstall.ps1");
    assert.match(un, /param\(\[switch\]\$Purge\)/);
    assert.match(un, /kept: ' \+ \$P\.DB/);
    assert.match(un, /Unregister-ScheduledTask -TaskName \$TaskName -Confirm:\$false/);
  });

  it("verify names checks (a) to (d) and exits with the failure count", () => {
    const v = ps1("verify-service.ps1");
    for (const want of [
      "Get-ScheduledTask -TaskName $TaskName",
      "Get-NetTCPConnection -State Listen -LocalPort ([int]$P.INGEST_PORT)",
      "Invoke-WebRequest -UseBasicParsing",
      "'(a) ",
      "'(b) ",
      "'(c) ",
      "'(d) ",
      "exit $fails",
    ]) {
      assert.ok(v.includes(want) || ps1("_common.ps1").includes(want), want);
    }
  });
});
