#!/usr/bin/env bash
# npm run service:logs on Linux: the daemon logs to journald, no log file.
set -euo pipefail
exec journalctl --user -u vitals.service -f "$@"
