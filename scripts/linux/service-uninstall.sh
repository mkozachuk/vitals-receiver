#!/usr/bin/env bash
# Remove the systemd user unit. Keeps the store and the credential -- health
# data is not this script's to delete -- unless --purge is given. Lingering is
# left on: other user services may rely on it (loginctl disable-linger).
#
#   bash scripts/linux/service-uninstall.sh [--purge]
set -euo pipefail
PURGE=0
case "${1:-}" in
  "") ;;
  --purge) PURGE=1 ;;
  *) echo "usage: service-uninstall.sh [--purge]" >&2; exit 2 ;;
esac
# shellcheck source=scripts/linux/_common.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_common.sh"

if [ -f "$UNIT_FILE" ]; then
  systemctl --user disable --now "$UNIT_NAME" || true
  rm -f "$UNIT_FILE"
  systemctl --user daemon-reload
  echo "uninstalled $UNIT_NAME"
else
  echo "no unit at $UNIT_FILE -- nothing to uninstall"
fi

if [ "$PURGE" = 1 ]; then
  rm -f "$DB" "$DB-wal" "$DB-shm" "$TOKEN_FILE"
  rmdir "$STATE_DIR" 2>/dev/null || true
  rmdir "$(dirname "$TOKEN_FILE")" 2>/dev/null || true
  echo "purged: $DB and $TOKEN_FILE"
else
  echo "kept: $DB and $TOKEN_FILE (--purge deletes them)"
fi
