#!/usr/bin/env bash
# npm run restart on Linux. POST /api/restart (exit 75) also works under the
# unit: Restart=on-failure brings any non-zero exit back.
set -euo pipefail
exec systemctl --user restart vitals.service
