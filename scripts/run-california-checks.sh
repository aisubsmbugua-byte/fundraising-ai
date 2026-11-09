#!/usr/bin/env bash
# Item 110 (ruling 0045): the two checks that follow the California load, run on their
# own, without the download or the dry run.
#
#   1. a second pass: the same load again; it must write 0 rows (a repeat is safe)
#   2. the verifier: every stored funder compared value by value with its IRS filing
#
# Neither stage writes new data when the load is sound. The secret key is asked for
# with nothing shown, held only in this script's environment, never written anywhere.
#
#   bash scripts/run-california-checks.sh
#
# Uses the same folders as run-california-load.sh (IRS_DATA_DIR, IRS_WORK_DIR). Logs go
# to $WORK/logs/. Run again after any interruption.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

DATA="${IRS_DATA_DIR:-$HOME/irs-data}"
WORK="${IRS_WORK_DIR:-$HOME/irs-work}"
LOGS="$WORK/logs"
mkdir -p "$LOGS"

if command -v caffeinate >/dev/null 2>&1; then caffeinate -i -w $$ & fi

read -r -s -p "Paste the Supabase secret key (it starts sb_secret_), then press Return. Nothing will be shown: " SUPABASE_SERVICE_ROLE_KEY
echo
case "$SUPABASE_SERVICE_ROLE_KEY" in
  sb_secret_*) ;;
  *) echo "That is not an sb_secret_ key. Stopping; nothing was done."; exit 2 ;;
esac
export SUPABASE_SERVICE_ROLE_KEY
export NEXT_PUBLIC_SUPABASE_URL="https://mbsxeyoxojcqetrmwgba.supabase.co"
export NODE_OPTIONS="--max-old-space-size=10240"

LOAD_ARGS=(--work-dir "$WORK" --index-dir "$DATA/index" --archives-dir "$DATA/zips" --state CA --years 2022,2023,2024 --audit-header-sample 3000)

stage() { echo; echo "=== $1 ($(date '+%H:%M:%S')) ==="; }

stage "1 of 2: second pass (must write 0 rows)"
npx tsx scripts/load-funder-reference.ts "${LOAD_ARGS[@]}" --target supabase --confirm-write-to-supabase 2>&1 | tee -a "$LOGS/5-second-pass.log"
if [ "${PIPESTATUS[0]}" -ne 0 ]; then echo "The second pass did not finish cleanly. Read $WORK/run-diary.log."; exit 1; fi

stage "2 of 2: verify every funder against its IRS filing"
npx tsx scripts/verify-funder-reference-example.ts --db supabase --all --archives-dir "$DATA/zips" 2>&1 | tee -a "$LOGS/6-verify.log"

echo; echo "Done. Logs are in $LOGS. Paste the last 40 lines of each back to the build session."
