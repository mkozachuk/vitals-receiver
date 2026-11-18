#!/usr/bin/env bash
# Install (or reinstall) vitals as a systemd USER unit. Idempotent: a second
# run with nothing changed rewrites nothing, enables nothing and exits 0.
#
#   bash scripts/linux/service-install.sh      (npm run service:install on Linux)
#
# Order: everything that only reads first (node, dependencies, credential,
# render + systemd-analyze), then lingering, then the unit. A template that
# will not render leaves an installed unit and its process untouched.
set -euo pipefail
# shellcheck source=scripts/linux/_common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

echo "using node $("$NODE_BIN" --version) at $NODE_BIN"

# The native module is the dependency that can be present and still wrong.
if ! (cd "$REPO" && "$NODE_BIN" -e 'import("better-sqlite3").then(()=>process.exit(0),()=>process.exit(1))') >/dev/null 2>&1; then
  echo "better-sqlite3 will not load under $NODE_BIN (ABI mismatch?) -- run: npm rebuild better-sqlite3" >&2
  exit 1
fi

# A LAN-facing listener with no credential is worse than no listener: the
# server exits 1 without one, and Restart= would respawn it every 5 s.
if [ ! -s "$TOKEN_FILE" ]; then
  echo "no credential at $TOKEN_FILE -- run: npm run token:mint" >&2
  exit 1
fi

RENDER_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vitals-unit.XXXXXX")"
trap 'rm -rf "$RENDER_DIR"' EXIT
RENDERED="$RENDER_DIR/$UNIT_NAME"
vitals_unit_ts render "$REPO/scripts/linux/vitals.service.template" "$RENDERED" \
    "NODE_BIN=$NODE_BIN" "NODE_DIR=$NODE_DIR" "REPO=$REPO" "TSX=$TSX" \
    "DB=$DB" "TOKEN_FILE=$TOKEN_FILE" \
  || { echo "unit render failed -- installed unit left untouched" >&2; exit 1; }
if command -v systemd-analyze >/dev/null 2>&1; then
  systemd-analyze --user verify "$RENDERED" \
    || { echo "systemd-analyze rejected the rendered unit -- installed unit left untouched" >&2; exit 1; }
fi

# Credential 600, its directory and the state directory 700.
chmod 600 "$TOKEN_FILE"
chmod 700 "$(dirname "$TOKEN_FILE")"
mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"

# A user unit stops at logout and does not start at boot unless the user
# lingers. That needs polkit consent or root on most distributions.
USER_NAME="${USER:-$(id -un)}"
if [ "$(loginctl show-user "$USER_NAME" --property=Linger --value 2>/dev/null || true)" != "yes" ]; then
  if ! loginctl enable-linger "$USER_NAME"; then
    echo "loginctl enable-linger failed; run this once, then rerun the install:" >&2
    echo "  sudo loginctl enable-linger $USER_NAME" >&2
    exit 1
  fi
fi

changed=0
if [ -f "$UNIT_FILE" ] && cmp -s "$RENDERED" "$UNIT_FILE"; then
  echo "unit unchanged: $UNIT_FILE"
else
  mkdir -p "$(dirname "$UNIT_FILE")"
  cp "$RENDERED" "$UNIT_FILE"
  chmod 644 "$UNIT_FILE"
  echo "unit written: $UNIT_FILE"
  systemctl --user daemon-reload
  changed=1
fi
if [ "$(systemctl --user is-enabled "$UNIT_NAME" 2>/dev/null || true)" != "enabled" ]; then
  systemctl --user enable "$UNIT_NAME"
fi
if [ "$changed" = 1 ]; then
  systemctl --user restart "$UNIT_NAME"
elif [ "$(systemctl --user is-active "$UNIT_NAME" 2>/dev/null || true)" != "active" ]; then
  systemctl --user start "$UNIT_NAME"
fi

echo "logs: journalctl --user -u vitals   (npm run service:logs)"
# Give the server a moment to open the store and both listeners.
for _ in $(seq 1 "${VITALS_INSTALL_WAIT:-15}"); do
  curl -fsS -m 2 "http://127.0.0.1:$READ_PORT/healthz" >/dev/null 2>&1 && break
  sleep 1
done
rm -rf "$RENDER_DIR"; trap - EXIT
exec bash "$REPO/scripts/linux/verify-service.sh"
