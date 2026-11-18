# shellcheck shell=bash
# Sourced by the Linux service scripts. Sets REPO, NODE_BIN, NODE_DIR, TSX and,
# through scripts/linux/unit.ts (src/config.ts with platform "linux"):
# STATE_DIR, DB, TOKEN_FILE, READ_HOST, READ_PORT, INGEST_PORT, UNIT_FILE.
# Exits 1 with one line on stderr before anything is written.

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
UNIT_NAME="vitals.service"

# node >= 22, chosen deliberately: VITALS_NODE if set (no fall-through when it
# is unusable), else the first of PATH's node, /usr/local/bin, /usr/bin.
# better-sqlite3 is built against the node 22 ABI, so 22 is not a preference.
node_major() { "$1" --version 2>/dev/null | sed -n 's/^v\([0-9][0-9]*\)\..*/\1/p'; }
pick_node() {
  local c major
  if [ -n "${VITALS_NODE:-}" ]; then set -- "$VITALS_NODE"; else
    set -- "$(command -v node 2>/dev/null || true)" /usr/local/bin/node /usr/bin/node
  fi
  for c in "$@"; do
    [ -n "$c" ] && [ -x "$c" ] || continue
    major="$(node_major "$c")"
    if [ -n "$major" ] && [ "$major" -ge 22 ]; then echo "$c"; return 0; fi
    echo "node $("$c" --version 2>/dev/null || echo '(no version)') at $c is older than 22" >&2
  done
  return 1
}
NODE_BIN="$(pick_node || true)"
if [ -z "$NODE_BIN" ]; then
  echo "no node >= 22 found (better-sqlite3 is built against its ABI); set VITALS_NODE=/path/to/node" >&2
  exit 1
fi
NODE_DIR="$(dirname "$NODE_BIN")"

TSX="$REPO/node_modules/tsx/dist/loader.mjs"
[ -f "$TSX" ] || { echo "dependencies missing -- run: npm ci" >&2; exit 1; }

vitals_unit_ts() { "$NODE_BIN" --import "$TSX" "$REPO/scripts/linux/unit.ts" "$@"; }

PATHS="$(vitals_unit_ts paths "$REPO")" || exit 1
while IFS='=' read -r key value; do
  case "$key" in
    STATE_DIR|DB|TOKEN_FILE|READ_HOST|READ_PORT|INGEST_PORT|UNIT_FILE) printf -v "$key" '%s' "$value" ;;
  esac
done <<< "$PATHS"

file_mode() { stat -c '%a' "$1" 2>/dev/null || stat -f '%Lp' "$1"; }
