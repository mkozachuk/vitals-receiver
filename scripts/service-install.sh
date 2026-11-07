#!/usr/bin/env bash
# Install (or reinstall) vitals as a user LaunchAgent. Idempotent.
#
#   bash scripts/service-install.sh               install, start, verify
#   bash scripts/service-install.sh --print-node  only report which node the
#                                                 plist would get, and exit
#
# Run this from a normal login shell. Some sandboxes and agent runtimes refuse
# to register a persistent job from inside their own process; if yours does,
# that guard is correct -- run the script from a terminal instead.
#
# Needs launchagent-kit (`lak`), found by scripts/_lak.sh: $LAK if set, else
# `lak` on PATH; neither -> it stops before touching anything. launchagent-kit
# is not published at the moment; without it, run the daemon in the foreground
# (`npm start`, see the README). The plist is rendered and linted BEFORE the
# running job is touched; a bad template leaves it running.
#
# VITALS_NODE=/path/to/node pins the interpreter explicitly (it must be node
# >= 22 and must load better-sqlite3); otherwise the candidates below are tried
# in order.
set -euo pipefail

PRINT_NODE=0
[ "${1:-}" = "--print-node" ] && PRINT_NODE=1

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="local.vitals.daemon"
TEMPLATE="$REPO/scripts/$LABEL.plist.template"
LOG_DIR="$HOME/Library/Logs/vitals"

READ_PORT="${VITALS_READ_PORT:-4780}"
INGEST_PORT="${VITALS_INGEST_PORT:-4781}"

# Pick the interpreter deliberately; do not inherit it. A Mac can easily carry
# an older node first on PATH and node 22 somewhere else, and 22 is not a
# preference: better-sqlite3 is compiled against the node 22 ABI. The version
# check below only shortlists; the proof is loading the native module with the
# binary we are about to bake into the plist, a few lines down.
NODE_CANDIDATES=(
  "${VITALS_NODE:-}"
  /opt/homebrew/opt/node@22/bin/node   # Homebrew node@22, Apple silicon
  /usr/local/opt/node@22/bin/node      # Homebrew node@22, Intel
  /opt/homebrew/bin/node
  /usr/local/bin/node
  "$(command -v node || true)"
)
pick_node() {
  local c
  if [ -n "${VITALS_NODE:-}" ]; then
    # An explicit choice is not silently overridden: if it is unusable, fail.
    [ -x "$VITALS_NODE" ] || return 1
    "$VITALS_NODE" -e 'const [a]=process.versions.node.split(".").map(Number); process.exit(a>=22?0:1)' 2>/dev/null || return 1
    echo "$VITALS_NODE"; return 0
  fi
  for c in "${NODE_CANDIDATES[@]}"; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    "$c" -e 'const [a]=process.versions.node.split(".").map(Number); process.exit(a>=22?0:1)' 2>/dev/null || continue
    echo "$c"; return 0
  done
  return 1
}
NODE_BIN="$(pick_node || true)"
if [ -z "$NODE_BIN" ]; then
  if [ -n "${VITALS_NODE:-}" ]; then
    echo "VITALS_NODE=$VITALS_NODE is not an executable node >= 22." >&2
  else
    echo "no node >= 22 found (better-sqlite3 is built against its ABI)." >&2
    echo "  candidates tried: ${NODE_CANDIDATES[*]:1}" >&2
    echo "  set VITALS_NODE=/path/to/node to choose one explicitly." >&2
  fi
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"
echo "using node $("$NODE_BIN" --version) at $NODE_BIN"

TSX="$REPO/node_modules/tsx/dist/loader.mjs"
[ -f "$TSX" ] || { echo "dependencies missing -- run: npm install" >&2; exit 1; }

# The native module is the one dependency that can be present and still wrong:
# a better-sqlite3 built against another ABI imports fine by eye and throws at
# require time. Load it with the binary we are about to bake into the plist.
if ! "$NODE_BIN" -e 'import("better-sqlite3").then(()=>process.exit(0),(e)=>{console.error(String(e.message).split("\n")[0]);process.exit(1)})' >/dev/null 2>&1; then
  echo "better-sqlite3 will not load under $NODE_BIN (ABI mismatch?) -- run: npm rebuild better-sqlite3" >&2
  exit 1
fi

# Everything above only reads; everything below writes. --print-node stops here.
if [ "$PRINT_NODE" = 1 ]; then
  echo "$NODE_BIN"
  exit 0
fi

# A LAN-facing listener with no credential is worse than no listener, so the
# server exits 1 when the token file is absent. Catch that here instead of
# installing a job that KeepAlive will respawn every 30s forever.
TOKEN_FILE="${VITALS_TOKEN_FILE:-$HOME/Library/Application Support/vitals/token}"
if [ ! -s "$TOKEN_FILE" ]; then
  echo "no credential at $TOKEN_FILE -- run: npm run token:mint" >&2
  exit 1
fi

# shellcheck source=scripts/_lak.sh
. "$REPO/scripts/_lak.sh"

# Render and lint FIRST, while the running job is still untouched. A template
# that does not render, or renders into a plist launchd would reject, must not
# cost a working service its process: fail here and nothing has been stopped.
# The temp file lives outside ~/Library/LaunchAgents and is removed on exit.
RENDER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vitals-plist.XXXXXX")"
trap 'rm -rf "$RENDER_DIR"' EXIT
RENDERED="$RENDER_DIR/$LABEL.plist"
"$LAK_BIN" render "$TEMPLATE" \
    --var "NODE_BIN=$NODE_BIN" \
    --var "NODE_DIR=$NODE_DIR" \
    --var "TSX=$TSX" \
    --var "LOG_DIR=$LOG_DIR" \
    --var "REPO=$REPO" \
    -o "$RENDERED" \
  || { echo "lak render failed -- running job left untouched" >&2; exit 1; }
"$LAK_BIN" lint --label "$LABEL" "$RENDERED" >/dev/null \
  || { echo "lak lint failed on the rendered plist -- running job left untouched" >&2; exit 1; }

# Stop our own job, and only then sweep for strays. Measured on the first
# reinstall: killing the port holder while the job is still loaded just hands
# the port to the copy KeepAlive respawns a second later, and the installer
# fails on a service that is working perfectly. Unload, then sweep.
# (lak uninstall polls launchctl until the job is gone before it returns.)
"$LAK_BIN" uninstall "$LABEL" || { echo "lak uninstall $LABEL failed" >&2; exit 1; }

# What can still be holding the ports now is a hand-started copy -- npm start,
# or a debugging session. Leave it in place and the LaunchAgent crash-loops on
# EADDRINUSE, which reads as "vitals is broken" rather than "two of you are
# fighting over one port".
for port in "$READ_PORT" "$INGEST_PORT"; do
  strays=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
  if [ -n "$strays" ]; then
    echo "port $port is already held by pid(s): $strays -- stopping them before install"
    # shellcheck disable=SC2086
    /bin/kill $strays 2>/dev/null || true
    sleep 2
    still=$(lsof -nP -iTCP:"$port" -sTCP:LISTEN -t 2>/dev/null || true)
    [ -z "$still" ] || { echo "pid(s) $still will not release port $port -- stop them manually and rerun" >&2; exit 1; }
  fi
done

mkdir -p "$HOME/Library/LaunchAgents" "$LOG_DIR"

# No launchctl enable / kickstart -k any more: RunAtLoad starts the job on
# bootstrap, and the kit's launchctl seam deliberately has no kickstart.
"$LAK_BIN" install "$RENDERED" || { echo "lak install failed" >&2; exit 1; }

echo "logs: $LOG_DIR/vitals.log  and  $LOG_DIR/vitals.err.log"
sleep 3
# exec replaces this shell, so the EXIT trap would never fire: clean up now.
rm -rf "$RENDER_DIR"; trap - EXIT
exec "$REPO/scripts/verify-service.sh"
