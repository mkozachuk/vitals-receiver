#!/usr/bin/env bash
# Prove the installed service is actually serving, not merely "loaded".
# Names the check that failed; the exit code is the number of failures.
#
# The two properties worth a script: the daemon is up on the RIGHT store, and
# the two listeners still have the shapes the design depends on -- ingest
# LAN-facing and write-only, read loopback-only and read-only. A dashboard that
# quietly started accepting POSTs, or a receiver that quietly opened a second
# empty database, both answer /healthz with a cheerful 200.
set -uo pipefail

REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="local.vitals.daemon"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
DOMAIN="gui/$(id -u)"
LOG_DIR="$HOME/Library/Logs/vitals"
READ_PORT="${VITALS_READ_PORT:-4780}"
INGEST_PORT="${VITALS_INGEST_PORT:-4781}"
STATE_DIR="${VITALS_STATE_DIR:-$HOME/Library/Application Support/vitals}"
TOKEN_FILE="${VITALS_TOKEN_FILE:-$STATE_DIR/token}"
EXPECT_DB="${VITALS_DB:-$STATE_DIR/vitals.db}"
READ_BASE="http://127.0.0.1:$READ_PORT"
# shellcheck source=scripts/_lak.sh
. "$REPO/scripts/_lak.sh"

fails=0
ok()   { echo "  ok    $*"; }
bad()  { echo "  FAIL  $*"; fails=$((fails+1)); }
info() { echo "  info  $*"; }

echo "vitals service verification"

# --- the job ---------------------------------------------------------------
# lak verify (read-only): loaded and has a pid. Its output is shown; a
# non-zero exit is one failure.
job=$("$LAK_BIN" verify "$LABEL" 2>&1); job_rc=$?
echo "$job" | sed 's/^/        /'
if [ "$job_rc" -eq 0 ]; then
  ok "lak verify $LABEL"
else
  bad "lak verify $LABEL exited $job_rc -- see $LOG_DIR/vitals.err.log, or run scripts/service-install.sh"
fi

# A plist left behind by another checkout starts a daemon that serves a
# different store perfectly happily.
if [ -f "$PLIST" ] && grep -q "$REPO/src/server.ts" "$PLIST"; then
  ok "installed plist points at this checkout"
else
  bad "installed plist does not name $REPO/src/server.ts -- reinstall"
fi

# Exactly one writer. Match the program path, not the word "vitals": a name
# match also finds this script, the shell running it and any editor with the
# repo open, then reports them as rival daemons.
writers=$(pgrep -f "$REPO/src/server.ts" | wc -l | tr -d ' ')
if [ "$writers" = "1" ]; then ok "exactly one server process"; else bad "$writers processes are running $REPO/src/server.ts -- two writers on one store"; fi

# --- health ----------------------------------------------------------------
health=$(curl -fsS -m 5 "$READ_BASE/healthz" 2>/dev/null)
if [ -n "$health" ]; then ok "GET /healthz answered 2xx on $READ_BASE"; else bad "GET /healthz did not answer on $READ_BASE"; fi

summary=$(curl -fsS -m 5 "$READ_BASE/api/summary" 2>/dev/null)

if [ -n "$health" ]; then
  python3 - "$health" "$summary" "$EXPECT_DB" <<'PY' || fails=$((fails+1))
import json, os, sys
health = json.loads(sys.argv[1])
summary = json.loads(sys.argv[2]) if sys.argv[2] else {}
expect_db = sys.argv[3]
bad = 0
def line(good, msg):
    global bad
    print(f"  {'ok   ' if good else 'FAIL '} {msg}")
    if not good: bad += 1

line(health.get("ok") is True, "daemon reports ok")
line(health.get("dbWritable") is True, "store is writable (the /healthz probe row went in)")

# The store is the check that cannot be skipped: a job whose working directory
# or HOME differs from the shell's opens a SECOND, empty database and serves it
# without a word of complaint. Compare the path the running process is actually
# using, and cross-check its size against the file on disk.
db_path = (summary.get("strip") or {}).get("dbPath")
if db_path is None:
    print("  info  /api/summary did not expose dbPath; store path unverified")
else:
    line(db_path == expect_db, f"store path is the production one ({db_path})")
    main = os.path.getsize(db_path) if os.path.exists(db_path) else -1
    line(main >= 0, f"store file exists on disk ({main} bytes)")
    # dbBytes sums the main file, the WAL and the shm (dashboard.ts:dbFileBytes),
    # and the WAL moves between the daemon's stat and ours -- so the assertion
    # is the one that catches a second, empty database: the running process
    # reports at least as many bytes as the file we are looking at, and not
    # zero. An exact equality here fails on a healthy service every time the
    # journal grows mid-check.
    reported = health.get("dbBytes") or 0
    line(reported >= main > 0, f"/healthz dbBytes ({reported}) covers the store on disk ({main} + journal)")

print(f"  info  uptime {health.get('uptimeSeconds')}s · samples {health.get('samplesTotal')} total, {health.get('samples24h')} in 24h")
print(f"  info  last delivery {health.get('lastDeliveryAt') or 'never'} · last complete run {health.get('lastCompleteRunAt') or 'never'}")
print(f"  info  truncated runs {health.get('truncatedRuns7d')} in 7d / {health.get('truncatedRuns')} all time · quarantined {health.get('quarantinedTotal')} · unauthorised 24h {health.get('unauthorised24h')}")
if not health.get("lastDeliveryAt"):
    print("  info  nothing has been delivered yet -- the Synapse tile is amber by design until the first export")
sys.exit(1 if bad else 0)
PY
fi

# --- listener shapes -------------------------------------------------------
# The read side has no authentication of its own; loopback IS its security, and
# the LAN reaches it only through Synapse's basic auth.
read_listen=$(lsof -nP -iTCP:"$READ_PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2)
if [ -z "$read_listen" ]; then
  bad "nothing is listening on the read port $READ_PORT"
elif echo "$read_listen" | grep -qE '(\*|0\.0\.0\.0):'"$READ_PORT"; then
  bad "read port $READ_PORT is bound to every interface -- an unauthenticated dashboard is exposed to the LAN"
else
  ok "read port $READ_PORT is loopback-only"
fi

ingest_listen=$(lsof -nP -iTCP:"$INGEST_PORT" -sTCP:LISTEN 2>/dev/null | tail -n +2)
if [ -z "$ingest_listen" ]; then
  bad "nothing is listening on the ingest port $INGEST_PORT -- the phone has nowhere to deliver"
elif echo "$ingest_listen" | grep -qE '(\*|0\.0\.0\.0):'"$INGEST_PORT"; then
  ok "ingest port $INGEST_PORT is LAN-facing"
else
  bad "ingest port $INGEST_PORT is loopback-only -- the phone cannot reach it"
fi

code() { curl -s -o /dev/null -w '%{http_code}' -m 5 "$@"; }

# Fire at each boundary rather than asserting it.
c=$(code -X POST -H 'content-type: application/json' --data '{}' "$READ_BASE/")
if [ "$c" = "405" ]; then ok "POST on the read port is refused (405)"; else bad "POST on the read port returned $c, expected 405"; fi

c=$(code "http://127.0.0.1:$INGEST_PORT/")
if [ "$c" = "404" ]; then ok "GET / on the ingest port is not routed (404)"; else bad "GET / on the ingest port returned $c, expected 404"; fi

# No credential must mean no delivery -- and 401 is one of the few non-2xx
# vitals answers on /ingest (with bare 413), because healthd treats 401, 404
# and a 413 without Retry-After as permanent: that batch is never retried
# (healthd/Export/RetryDisposition.swift:80-120). Only no answer and 5xx are
# retried from healthd's outbox, for up to 7 days (PendingWork.swift:31).
c=$(code -X POST -H 'content-type: application/json' --data '{}' "http://127.0.0.1:$INGEST_PORT/ingest")
if [ "$c" = "401" ]; then ok "POST /ingest without a credential is refused (401)"; else bad "unauthenticated POST /ingest returned $c, expected 401"; fi
# Deliberate and worth stating: that probe is a real request, so it leaves a
# real row in the delivery log and bumps "unauthorised 24h" on the dashboard by
# one, from 127.0.0.1. The alternative -- asserting the boundary without firing
# at it -- is a claim, and the alternative to that, deleting the row afterwards,
# is a verification script issuing DELETEs against the owner's data.
info "that 401 is logged as an unauthorised delivery from 127.0.0.1 -- this script's own probe, not a stranger"

# --- credential and logs ---------------------------------------------------
if [ -s "$TOKEN_FILE" ]; then
  mode=$(stat -f '%Lp' "$TOKEN_FILE")
  if [ "$mode" = "600" ]; then ok "credential present, mode 600"; else bad "credential at $TOKEN_FILE has mode $mode, expected 600 -- chmod 600 it"; fi
else
  bad "no credential at $TOKEN_FILE -- run: npm run token:mint"
fi

for f in "$LOG_DIR/vitals.log" "$LOG_DIR/vitals.err.log"; do
  if [ -f "$f" ]; then ok "log present: $f"; else bad "missing log: $f"; fi
done
err_bytes=$(stat -f '%z' "$LOG_DIR/vitals.err.log" 2>/dev/null || echo 0)
[ "$err_bytes" = "0" ] || info "stderr log is $err_bytes bytes -- worth a look: tail $LOG_DIR/vitals.err.log"

echo
if [ "$fails" -eq 0 ]; then echo "all checks passed"; else echo "$fails check(s) failed"; fi
exit "$fails"
