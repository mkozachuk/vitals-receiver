# shellcheck shell=bash
# Sourced by service-install.sh, service-uninstall.sh and verify-service.sh:
# the one rule for finding launchagent-kit's `lak`, so the three cannot drift.
#
#   1. $LAK, if set and non-empty (used as given -- no fall-through if it is bad)
#   2. `lak` on PATH
#
# There is no default location: launchagent-kit is not published at the
# moment, so a path guessed here would only ever exist on one machine.
#
# Sets LAK_BIN. If there is no candidate, or it is not an executable file, the
# caller exits here with one line on stderr, before it renders, unloads or
# kills anything.
if [ -n "${LAK:-}" ]; then
  LAK_BIN="$LAK"
  if [ ! -f "$LAK_BIN" ] || [ ! -x "$LAK_BIN" ]; then
    echo "lak not found: LAK=$LAK_BIN is not an executable file -- point LAK at launchagent-kit's bin/lak, or unset LAK to use \`lak\` on PATH" >&2
    exit 1
  fi
else
  LAK_BIN="$(command -v lak 2>/dev/null || true)"
  if [ -z "$LAK_BIN" ] || [ ! -f "$LAK_BIN" ] || [ ! -x "$LAK_BIN" ]; then
    echo "lak not found: LAK is not set and there is no executable \`lak\` on PATH -- set LAK=/path/to/lak or put lak on PATH (without launchagent-kit, run the daemon with \`npm start\`)" >&2
    exit 1
  fi
fi
