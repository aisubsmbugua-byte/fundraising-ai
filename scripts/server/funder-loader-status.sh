#!/usr/bin/env bash
# Item 114 (ruling 0046 clause 5): show the last thing the loader did, read from the
# DATABASE (not from this server's logs), so it is the same answer from anywhere.
#
#   sudo /opt/funder-loader/app/scripts/server/funder-loader-status.sh
#
# Needs root only to read the key file; the key is passed to the one command below and
# is never printed.

set -euo pipefail
ENV_FILE="${FUNDER_ENV_FILE:-/etc/funder-loader.env}"
APP="${FUNDER_APP:-/opt/funder-loader/app}"
[ -r "$ENV_FILE" ] || { echo "cannot read $ENV_FILE (run this with sudo)"; exit 2; }
set -a
# shellcheck disable=SC1090
. "$ENV_FILE"
set +a
cd "$APP"
exec "$APP/node_modules/.bin/tsx" scripts/all-states-status.ts --target supabase "$@"
