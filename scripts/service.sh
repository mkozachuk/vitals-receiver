#!/usr/bin/env bash
# One entry point for the npm service scripts, switched on `uname -s`:
#
#   bash scripts/service.sh install|uninstall|verify|restart|logs [args]
#
# Darwin runs the macOS LaunchAgent scripts and one-liners exactly as before.
# Linux runs scripts/linux/*.sh (systemd user unit). Anything else: exit 2.
set -euo pipefail
REPO="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
VERB="${1:-}"
[ $# -gt 0 ] && shift
OS="$(uname -s)"

case "$OS" in
  Darwin)
    case "$VERB" in
      install)   exec bash "$REPO/scripts/service-install.sh" "$@" ;;
      uninstall) exec bash "$REPO/scripts/service-uninstall.sh" "$@" ;;
      verify)    exec bash "$REPO/scripts/verify-service.sh" "$@" ;;
      restart)   exec launchctl kickstart -k "gui/$(id -u)/local.vitals.daemon" ;;
      logs)      exec tail -f "$HOME/Library/Logs/vitals/vitals.log" ;;
    esac ;;
  Linux)
    case "$VERB" in
      install)   exec bash "$REPO/scripts/linux/service-install.sh" "$@" ;;
      uninstall) exec bash "$REPO/scripts/linux/service-uninstall.sh" "$@" ;;
      verify)    exec bash "$REPO/scripts/linux/verify-service.sh" "$@" ;;
      restart)   exec bash "$REPO/scripts/linux/restart.sh" "$@" ;;
      logs)      exec bash "$REPO/scripts/linux/logs.sh" "$@" ;;
    esac ;;
  *)
    echo "vitals: no service support for $OS (macOS and Linux only)" >&2
    exit 2 ;;
esac
echo "usage: scripts/service.sh install|uninstall|verify|restart|logs" >&2
exit 2
