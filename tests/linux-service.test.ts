import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { after, describe, it } from "node:test";
import { loadConfig } from "../src/config.js";
import { LOOPBACK, renderUnit, type UnitVars } from "../scripts/linux/unit.js";

/**
 * NB-774: the Linux service (systemd user unit). Runs on macOS and Linux alike:
 * systemctl, loginctl, journalctl, systemd-analyze and uname are stubs on PATH
 * that record their argv, node is a recording wrapper around the real one, and
 * the daemon is played by two tiny listeners on 127.0.0.1 in this process.
 * HOME and every XDG directory are temp dirs; nothing reads the owner's.
 *
 * The scripts run through ASYNC execFile: they curl the listeners served by
 * this very process, which a spawnSync would block.
 */

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(here, "..");
const LINUX = path.join(REPO, "scripts", "linux");
const TEMPLATE = path.join(LINUX, "vitals.service.template");
const GOLDEN = path.join(here, "fixtures", "linux", "vitals.service.golden");
const BASH = "/bin/bash";
const roots: string[] = [];
const servers: http.Server[] = [];

after(async () => {
  for (const s of servers) await new Promise<void>((r) => s.close(() => r()));
  for (const r of roots) fs.rmSync(r, { recursive: true, force: true });
});

// --- render ------------------------------------------------------------------

const GOLDEN_VARS: UnitVars = {
  NODE_BIN: "/usr/local/bin/node",
  NODE_DIR: "/usr/local/bin",
  REPO: "/home/user/vitals-receiver",
  TSX: "/home/user/vitals-receiver/node_modules/tsx/dist/loader.mjs",
  DB: "/home/user/.local/state/vitals/vitals.db",
  TOKEN_FILE: "/home/user/.config/vitals/token",
};

describe("linux unit: render", () => {
  const unit = renderUnit(fs.readFileSync(TEMPLATE, "utf8"), GOLDEN_VARS);

  it("matches the golden file byte for byte", () => {
    assert.equal(unit, fs.readFileSync(GOLDEN, "utf8"));
  });

  it("carries the fields the service depends on", () => {
    const lines = unit.split("\n");
    for (const want of [
      "ExecStart=/usr/local/bin/node --import /home/user/vitals-receiver/node_modules/tsx/dist/loader.mjs /home/user/vitals-receiver/src/server.ts",
      "Restart=on-failure",
      "WorkingDirectory=/home/user/vitals-receiver",
      "EnvironmentFile=-/home/user/vitals-receiver/.env",
      "Environment=VITALS_READ_HOST=127.0.0.1",
      "NoNewPrivileges=yes",
      "WantedBy=default.target",
    ]) {
      assert.ok(lines.includes(want), `missing line: ${want}`);
    }
    assert.ok(!/\bnpx\b/.test(lines.filter((l) => !l.startsWith("#")).join("\n")), "no npx in the unit");
  });

  it("refuses relative paths, whitespace and leftover placeholders", () => {
    assert.throws(() => renderUnit("x", { ...GOLDEN_VARS, REPO: "vitals" }), /REPO: expected an absolute path/);
    assert.throws(() => renderUnit("x", { ...GOLDEN_VARS, REPO: "/home/a b" }), /whitespace/);
    assert.throws(() => renderUnit("Environment=VITALS_READ_HOST=127.0.0.1\n__NOPE__\n", GOLDEN_VARS), /__NOPE__/);
  });
});

// --- listeners (C4) ------------------------------------------------------------

describe("linux unit: the read listener stays on loopback", () => {
  it("the template sets VITALS_READ_HOST to 127.0.0.1, exactly once", () => {
    const hosts = [...fs.readFileSync(TEMPLATE, "utf8").matchAll(/^Environment=VITALS_READ_HOST=(.*)$/gm)].map((m) => m[1]);
    assert.deepEqual(hosts, ["127.0.0.1"]);
  });

  it("rendering refuses a template that binds the read host anywhere else", () => {
    const template = fs.readFileSync(TEMPLATE, "utf8").replace("VITALS_READ_HOST=127.0.0.1", "VITALS_READ_HOST=0.0.0.0");
    assert.throws(() => renderUnit(template, GOLDEN_VARS), /VITALS_READ_HOST=127\.0\.0\.1 exactly once/);
  });

  it("no Linux install script sets VITALS_READ_HOST to anything but 127.0.0.1", () => {
    // The shell scripts and the template; unit.ts is covered by LOOPBACK below
    // and by the render refusal above.
    for (const f of fs.readdirSync(LINUX).filter((x) => x.endsWith(".sh") || x.endsWith(".template"))) {
      const text = fs.readFileSync(path.join(LINUX, f), "utf8");
      for (const m of text.matchAll(/VITALS_READ_HOST=([^\s"'`]*)/g)) {
        assert.equal(m[1], "127.0.0.1", `${f}: ${m[0]}`);
      }
    }
    assert.equal(LOOPBACK, "127.0.0.1");
  });

  it("the ingest host default is unchanged", () => {
    assert.equal(loadConfig({}, "linux").ingestHost, "0.0.0.0");
    assert.equal(loadConfig({}, "darwin").ingestHost, "0.0.0.0");
  });

  it("no Linux path calls lak", () => {
    for (const f of [...fs.readdirSync(LINUX).map((x) => path.join(LINUX, x)), path.join(REPO, "scripts", "service.sh")]) {
      const text = fs.readFileSync(f, "utf8");
      const lak = text.split("\n").filter((l) => /\blak\b/.test(l));
      assert.deepEqual(lak, [], f);
    }
  });
});

// --- paths (C3) ----------------------------------------------------------------

describe("config paths on linux (XDG) and darwin (unchanged)", () => {
  const home = os.homedir();

  it("linux defaults: store under ~/.local/state, credential under ~/.config", () => {
    const c = loadConfig({}, "linux");
    assert.equal(c.stateDir, path.join(home, ".local", "state", "vitals"));
    assert.equal(c.dbPath, path.join(home, ".local", "state", "vitals", "vitals.db"));
    assert.equal(c.tokenFile, path.join(home, ".config", "vitals", "token"));
  });

  it("linux honours absolute XDG_STATE_HOME / XDG_CONFIG_HOME and ignores relative ones", () => {
    const c = loadConfig({ XDG_STATE_HOME: "/x/state", XDG_CONFIG_HOME: "/x/config" }, "linux");
    assert.equal(c.dbPath, "/x/state/vitals/vitals.db");
    assert.equal(c.tokenFile, "/x/config/vitals/token");
    const r = loadConfig({ XDG_STATE_HOME: "rel/state", XDG_CONFIG_HOME: "rel/config" }, "linux");
    assert.equal(r.dbPath, path.join(home, ".local", "state", "vitals", "vitals.db"));
    assert.equal(r.tokenFile, path.join(home, ".config", "vitals", "token"));
  });

  it("explicit VITALS_STATE_DIR / VITALS_DB / VITALS_TOKEN_FILE still win on linux", () => {
    const xdg = { XDG_STATE_HOME: "/x/state", XDG_CONFIG_HOME: "/x/config" };
    const s = loadConfig({ ...xdg, VITALS_STATE_DIR: "/srv/v" }, "linux");
    assert.equal(s.dbPath, "/srv/v/vitals.db");
    assert.equal(s.tokenFile, "/srv/v/token");
    const e = loadConfig({ ...xdg, VITALS_DB: "/d/v.db", VITALS_TOKEN_FILE: "/t/token" }, "linux");
    assert.equal(e.dbPath, "/d/v.db");
    assert.equal(e.tokenFile, "/t/token");
  });

  it("darwin is byte-identical to the macOS layout, XDG ignored", () => {
    const base = path.join(home, "Library", "Application Support", "vitals");
    const c = loadConfig({ XDG_STATE_HOME: "/x/state", XDG_CONFIG_HOME: "/x/config" }, "darwin");
    assert.equal(c.stateDir, base);
    assert.equal(c.dbPath, path.join(base, "vitals.db"));
    assert.equal(c.tokenFile, path.join(base, "token"));
    assert.equal(loadConfig({ VITALS_STATE_DIR: "/s" }, "darwin").tokenFile, "/s/token");
  });
});

// --- the scripts (C2, C5) --------------------------------------------------------

interface Box {
  root: string;
  home: string;
  bin: string;
  stub: string;
  log: string;
  env: NodeJS.ProcessEnv;
  unitFile: string;
  db: string;
  token: string;
}

const STUB = `#!/bin/sh
# Records "<name> <argv>" and plays the part from files in $STUB_STATE.
name=$(basename "$0")
printf '%s %s\\n' "$name" "$*" >> "$STUB_LOG"
s="$STUB_STATE"
case "$name" in
  systemctl)
    shift   # --user
    case "$1" in
      is-enabled) [ -f "$s/enabled" ] && { echo enabled; exit 0; }; echo disabled; exit 1 ;;
      is-active)  [ -f "$s/active" ] && { cat "$s/active"; [ "$(cat "$s/active")" = active ]; exit $?; }; echo inactive; exit 3 ;;
      enable)     : > "$s/enabled" ;;
      disable)    rm -f "$s/enabled" "$s/active" ;;
      start|restart) echo active > "$s/active" ;;
    esac ;;
  loginctl)
    case "$1" in
      show-user) [ -f "$s/linger" ] && echo yes || echo no ;;
      enable-linger) [ -f "$s/linger-denied" ] && { echo "Access denied" >&2; exit 1; }; : > "$s/linger" ;;
    esac ;;
  uname) cat "$s/uname" ;;
esac
exit 0
`;

function box(): Box {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vitals-linux-")));
  roots.push(root);
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  const stub = path.join(root, "stub");
  for (const d of [home, bin, stub, path.join(root, "tmp")]) fs.mkdirSync(d);
  for (const name of ["systemctl", "loginctl", "journalctl", "systemd-analyze", "uname"]) {
    fs.writeFileSync(path.join(bin, name), STUB, { mode: 0o755 });
  }
  fs.writeFileSync(
    path.join(bin, "node"),
    `#!/bin/sh\nprintf 'node %s\\n' "$*" >> "$STUB_LOG"\nexec "${process.execPath}" "$@"\n`,
    { mode: 0o755 },
  );
  fs.writeFileSync(path.join(stub, "uname"), "Linux\n");
  const log = path.join(root, "calls.log");
  fs.writeFileSync(log, "");
  const config = path.join(home, ".config");
  const state = path.join(home, ".local", "state");
  return {
    root,
    home,
    bin,
    stub,
    log,
    unitFile: path.join(config, "systemd", "user", "vitals.service"),
    db: path.join(state, "vitals", "vitals.db"),
    token: path.join(config, "vitals", "token"),
    env: {
      HOME: home,
      USER: "tester",
      PATH: `${bin}:/usr/bin:/bin`,
      TMPDIR: path.join(root, "tmp"),
      XDG_CONFIG_HOME: config,
      XDG_STATE_HOME: state,
      STUB_LOG: log,
      STUB_STATE: stub,
      VITALS_INSTALL_WAIT: "1",
    },
  };
}

function mintFake(b: Box): void {
  fs.mkdirSync(path.dirname(b.token), { recursive: true, mode: 0o755 });
  fs.chmodSync(path.dirname(b.token), 0o755);
  fs.writeFileSync(b.token, "not-a-real-credential\n", { mode: 0o644 });
  fs.chmodSync(b.token, 0o644);
}

/** Plays the daemon: /healthz on the read port, 404 on the ingest port. */
async function listen(handler: http.RequestListener): Promise<number> {
  const s = http.createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return (s.address() as AddressInfo).port;
}
async function daemon(healthOk = true): Promise<{ read: number; ingest: number }> {
  const read = await listen((req, res) => {
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ ok: healthOk, dbWritable: true }));
  });
  const ingest = await listen((_req, res) => {
    res.statusCode = 404;
    res.end();
  });
  return { read, ingest };
}
/** A port nothing listens on: bound, read, closed. */
async function deadPort(): Promise<number> {
  const s = http.createServer();
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  const port = (s.address() as AddressInfo).port;
  await new Promise<void>((r) => s.close(() => r()));
  return port;
}

interface Run {
  code: number;
  out: string;
  calls: string[];
}
function sh(b: Box, script: string, args: string[] = [], env: NodeJS.ProcessEnv = {}): Promise<Run> {
  fs.writeFileSync(b.log, "");
  return new Promise((resolve) => {
    execFile(
      BASH,
      ["--noprofile", "--norc", script, ...args],
      { env: { ...b.env, ...env }, encoding: "utf8", timeout: 60_000 },
      (error, stdout, stderr) => {
        const code = error ? (typeof error.code === "number" ? error.code : -1) : 0;
        const calls = fs.readFileSync(b.log, "utf8").split("\n").filter((l) => l !== "" && !l.startsWith("node "));
        resolve({ code, out: stdout + stderr, calls });
      },
    );
  });
}
const INSTALL = path.join(LINUX, "service-install.sh");
const VERIFY = path.join(LINUX, "verify-service.sh");
const UNINSTALL = path.join(LINUX, "service-uninstall.sh");
const ports = (p: { read: number; ingest: number }) => ({ VITALS_READ_PORT: String(p.read), VITALS_INGEST_PORT: String(p.ingest) });

describe("linux scripts: install -> install -> verify -> uninstall -> uninstall --purge", () => {
  it("runs the whole lifecycle against stubs, idempotently, keeping data until --purge", async () => {
    const b = box();
    mintFake(b);
    const p = await daemon();

    const first = await sh(b, INSTALL, [], ports(p));
    assert.equal(first.code, 0, first.out);
    const unit = fs.readFileSync(b.unitFile, "utf8");
    assert.match(unit, new RegExp(`^ExecStart=\\S+ --import ${REPO}/node_modules/tsx/dist/loader\\.mjs ${REPO}/src/server\\.ts$`, "m"));
    assert.match(unit, /^Environment=VITALS_READ_HOST=127\.0\.0\.1$/m);
    assert.ok(unit.includes(`Environment=VITALS_DB=${b.db}\n`), unit);
    assert.ok(unit.includes(`Environment=VITALS_TOKEN_FILE=${b.token}\n`), unit);
    for (const want of [
      "loginctl enable-linger tester",
      "systemctl --user daemon-reload",
      "systemctl --user enable vitals.service",
      "systemctl --user restart vitals.service",
    ]) {
      assert.ok(first.calls.includes(want), `first install: missing "${want}" in ${JSON.stringify(first.calls)}`);
    }
    assert.ok(first.calls.some((c) => c.startsWith("systemd-analyze --user verify ")), "rendered unit checked by systemd-analyze");
    assert.match(first.out, /all checks passed/);

    // D3: credential 600, its directory and the state directory 700.
    assert.equal(fs.statSync(b.token).mode & 0o777, 0o600);
    assert.equal(fs.statSync(path.dirname(b.token)).mode & 0o777, 0o700);
    assert.equal(fs.statSync(path.dirname(b.db)).mode & 0o777, 0o700);

    const mtime = fs.statSync(b.unitFile).mtimeMs;
    const second = await sh(b, INSTALL, [], ports(p));
    assert.equal(second.code, 0, second.out);
    assert.equal(fs.readFileSync(b.unitFile, "utf8"), unit, "unit bytes unchanged");
    assert.equal(fs.statSync(b.unitFile).mtimeMs, mtime, "unit not rewritten");
    for (const verb of ["enable", "daemon-reload", "restart", "start"]) {
      assert.ok(!second.calls.some((c) => c.startsWith(`systemctl --user ${verb} `) || c === `systemctl --user ${verb}`), `second install ran ${verb}: ${JSON.stringify(second.calls)}`);
    }
    assert.ok(!second.calls.some((c) => c.startsWith("loginctl enable-linger")), "linger already on");
    assert.match(second.out, /unit unchanged/);

    const v = await sh(b, VERIFY, [], ports(p));
    assert.equal(v.code, 0, v.out);
    assert.ok(v.calls.includes("systemctl --user is-active vitals.service"));

    fs.mkdirSync(path.dirname(b.db), { recursive: true });
    fs.writeFileSync(b.db, "store");
    const u = await sh(b, UNINSTALL);
    assert.equal(u.code, 0, u.out);
    assert.ok(u.calls.includes("systemctl --user disable --now vitals.service"), JSON.stringify(u.calls));
    assert.ok(!fs.existsSync(b.unitFile), "unit removed");
    assert.ok(fs.existsSync(b.db) && fs.existsSync(b.token), "store and credential kept");

    const again = await sh(b, UNINSTALL);
    assert.equal(again.code, 0, again.out);
    assert.match(again.out, /nothing to uninstall/);

    const purge = await sh(b, UNINSTALL, ["--purge"]);
    assert.equal(purge.code, 0, purge.out);
    assert.ok(!fs.existsSync(b.db) && !fs.existsSync(b.token), "store and credential purged");
  });

  it("install refuses node older than 22, naming the version", async () => {
    const b = box();
    mintFake(b);
    const old = path.join(b.root, "node20");
    fs.writeFileSync(old, "#!/bin/sh\necho v20.11.1\n", { mode: 0o755 });
    const r = await sh(b, INSTALL, [], { VITALS_NODE: old });
    assert.notEqual(r.code, 0);
    assert.match(r.out, /v20\.11\.1/);
    assert.ok(!fs.existsSync(b.unitFile));
    assert.deepEqual(r.calls.filter((c) => c.startsWith("systemctl") || c.startsWith("loginctl")), []);
  });

  it("install refuses without a credential, before touching systemd", async () => {
    const b = box();
    const r = await sh(b, INSTALL);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /no credential at .*\/\.config\/vitals\/token -- run: npm run token:mint/);
    assert.deepEqual(r.calls.filter((c) => c.startsWith("systemctl") || c.startsWith("loginctl")), []);
  });

  it("install refuses a .env that moves the read listener off loopback", async () => {
    const b = box();
    mintFake(b);
    // The scripts read <checkout>/.env; run a copy of scripts/ beside a symlinked node_modules.
    const repo = path.join(b.root, "repo");
    fs.mkdirSync(repo);
    fs.cpSync(path.join(REPO, "scripts"), path.join(repo, "scripts"), { recursive: true });
    fs.cpSync(path.join(REPO, "src"), path.join(repo, "src"), { recursive: true });
    fs.copyFileSync(path.join(REPO, "package.json"), path.join(repo, "package.json"));
    fs.symlinkSync(path.join(REPO, "node_modules"), path.join(repo, "node_modules"));
    fs.writeFileSync(path.join(repo, ".env"), "VITALS_READ_HOST=0.0.0.0\n");
    const r = await sh(b, path.join(repo, "scripts", "linux", "service-install.sh"));
    assert.notEqual(r.code, 0);
    assert.match(r.out, /VITALS_READ_HOST=0\.0\.0\.0 .*must stay on 127\.0\.0\.1/);
    assert.ok(!fs.existsSync(b.unitFile));
  });

  it("install exits non-zero with the sudo line when lingering is refused", async () => {
    const b = box();
    mintFake(b);
    fs.writeFileSync(path.join(b.stub, "linger-denied"), "");
    const r = await sh(b, INSTALL);
    assert.notEqual(r.code, 0);
    assert.match(r.out, /sudo loginctl enable-linger tester/);
    assert.ok(!fs.existsSync(b.unitFile), "no unit without linger");
  });
});

describe("linux verify: each failing check is named", () => {
  async function ready(healthOk = true) {
    const b = box();
    mintFake(b);
    fs.chmodSync(b.token, 0o600);
    fs.writeFileSync(path.join(b.stub, "active"), "active\n");
    return { b, p: await daemon(healthOk) };
  }

  it("(a) unit not active", async () => {
    const { b, p } = await ready();
    fs.writeFileSync(path.join(b.stub, "active"), "failed\n");
    const r = await sh(b, VERIFY, [], ports(p));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL {2}\(a\) systemctl --user is-active vitals: failed/);
  });

  it("(b) nothing on the ingest port", async () => {
    const { b, p } = await ready();
    const r = await sh(b, VERIFY, [], { ...ports(p), VITALS_INGEST_PORT: String(await deadPort()) });
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL {2}\(b\) ingest port \d+: nothing is listening/);
  });

  it("(c) read health not ok", async () => {
    const { b, p } = await ready(false);
    const r = await sh(b, VERIFY, [], ports(p));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL {2}\(c\) GET http:\/\/127\.0\.0\.1:\d+\/healthz did not answer ok/);
  });

  it("(e) credential mode wrong", async () => {
    const { b, p } = await ready();
    fs.chmodSync(b.token, 0o644);
    const r = await sh(b, VERIFY, [], ports(p));
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /FAIL {2}\(e\) credential .* has mode 644, expected 600/);
  });
});

// --- dispatch (D4) ------------------------------------------------------------------

describe("scripts/service.sh dispatches on uname -s", () => {
  const SERVICE = path.join(REPO, "scripts", "service.sh");

  it("Linux: restart and logs go to systemctl / journalctl --user", async () => {
    const b = box();
    const r1 = await sh(b, SERVICE, ["restart"]);
    assert.equal(r1.code, 0, r1.out);
    assert.ok(r1.calls.includes("systemctl --user restart vitals.service"), JSON.stringify(r1.calls));
    const r2 = await sh(b, SERVICE, ["logs"]);
    assert.equal(r2.code, 0, r2.out);
    assert.ok(r2.calls.includes("journalctl --user -u vitals.service -f"), JSON.stringify(r2.calls));
  });

  it("Linux: uninstall runs scripts/linux/service-uninstall.sh", async () => {
    const b = box();
    const r = await sh(b, SERVICE, ["uninstall"]);
    assert.equal(r.code, 0, r.out);
    assert.match(r.out, /no unit at .*\/systemd\/user\/vitals\.service/);
  });

  it("Darwin: the macOS scripts run unchanged (here: lak missing, nothing touched)", async () => {
    const b = box();
    fs.writeFileSync(path.join(b.stub, "uname"), "Darwin\n");
    const r = await sh(b, SERVICE, ["uninstall"]);
    assert.equal(r.code, 1, r.out);
    assert.match(r.out, /lak not found/);
    assert.deepEqual(r.calls.filter((c) => !c.startsWith("uname")), []);
  });

  it("anything else exits 2 naming the OS", async () => {
    const b = box();
    fs.writeFileSync(path.join(b.stub, "uname"), "Plan9\n");
    const r = await sh(b, SERVICE, ["install"]);
    assert.equal(r.code, 2);
    assert.match(r.out, /no service support for Plan9/);
  });

  it("package.json routes every service verb through the wrapper", () => {
    const scripts = (JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as { scripts: Record<string, string> }).scripts;
    assert.equal(scripts["service:install"], "node scripts/service.mjs install");
    assert.equal(scripts["service:uninstall"], "node scripts/service.mjs uninstall");
    assert.equal(scripts["service:verify"], "node scripts/service.mjs verify");
    assert.equal(scripts["service:logs"], "node scripts/service.mjs logs");
    assert.equal(scripts.restart, "node scripts/service.mjs restart");
  });
});

