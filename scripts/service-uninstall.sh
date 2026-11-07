#!/usr/bin/env bash
# Remove the LaunchAgent. Leaves the repo, the logs, the credential and -- the
# one that matters -- the store alone. Health data is not this script's to
# delete.
#
# Needs launchagent-kit (`lak`); see scripts/_lak.sh for how it is found.
set -euo pipefail
LABEL="local.vitals.daemon"
# shellcheck source=scripts/_lak.sh
. "$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/_lak.sh"
# Boots the job out if loaded and deletes its plist; nothing else.
"$LAK_BIN" uninstall "$LABEL" || exit $?
echo "uninstalled $LABEL (store, credential and logs kept)"
