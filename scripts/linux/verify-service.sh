#!/usr/bin/env bash
# Prove the installed Linux service is serving, not merely "active". Names
# each failed check; the exit code is the number of failures.
#   (a) systemctl --user is-active vitals
#   (b) the ingest port is listening (GET / on it answers at all)
#   (c) GET /healthz on 127.0.0.1:<read port> answers 2xx with ok true
#   (d) the read port is loopback-only (via ss; skipped with a line if absent)
#   (e) the credential is present, mode 600
set -uo pipefail
# shellcheck source=scripts/linux/_common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

fails=0
ok()   { echo "  ok    $*"; }
bad()  { echo "  FAIL  $*"; fails=$((fails+1)); }
info() { echo "  info  $*"; }

echo "vitals service verification (systemd user unit)"

state="$(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || true)"
if [ "$state" = "active" ]; then ok "(a) systemctl --user is-active vitals: active"
else bad "(a) systemctl --user is-active vitals: ${state:-unknown} -- see: journalctl --user -u vitals"; fi

c="$(curl -s -o /dev/null -w '%{http_code}' -m 5 "http://127.0.0.1:$INGEST_PORT/" 2>/dev/null || true)"
if [ -n "$c" ] && [ "$c" != "000" ]; then ok "(b) ingest port $INGEST_PORT is listening (GET / -> $c)"
else bad "(b) ingest port $INGEST_PORT: nothing is listening -- the phone has nowhere to deliver"; fi

health="$(curl -fsS -m 5 "http://127.0.0.1:$READ_PORT/healthz" 2>/dev/null || true)"
if [ -n "$health" ] && printf '%s' "$health" | grep -q '"ok":true'; then
  ok "(c) GET http://127.0.0.1:$READ_PORT/healthz answered ok"
else
  bad "(c) GET http://127.0.0.1:$READ_PORT/healthz did not answer ok"
fi

if command -v ss >/dev/null 2>&1; then
  listen="$(ss -ltnH "sport = :$READ_PORT" 2>/dev/null || true)"
  if [ -z "$listen" ]; then
    bad "(d) nothing is listening on the read port $READ_PORT"
  elif printf '%s\n' "$listen" | grep -qE '(\*|0\.0\.0\.0|\[::\]):'"$READ_PORT"'\b'; then
    bad "(d) read port $READ_PORT is bound to every interface -- an unauthenticated dashboard is exposed"
  else
    ok "(d) read port $READ_PORT is loopback-only"
  fi
else
  info "(d) ss not found; read-port binding not checked"
fi

if [ -s "$TOKEN_FILE" ]; then
  mode="$(file_mode "$TOKEN_FILE")"
  if [ "$mode" = "600" ]; then ok "(e) credential present, mode 600"
  else bad "(e) credential at $TOKEN_FILE has mode $mode, expected 600 -- chmod 600 it"; fi
else
  bad "(e) no credential at $TOKEN_FILE -- run: npm run token:mint"
fi

echo
if [ "$fails" -eq 0 ]; then echo "all checks passed"; else echo "$fails check(s) failed"; fi
exit "$fails"
