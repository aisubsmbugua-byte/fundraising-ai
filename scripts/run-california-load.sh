#!/usr/bin/env bash
# Item 110 (ruling 0045): the California load, run from this machine, in stages,
# with a human decision before anything is written to production.
#
#   1. download the IRS bulk files (about 18 GB; skips what is complete, resumes)
#   2. a DRY RUN: reads everything, writes NOTHING (a throwaway local database);
#      fills the pass-A cache and the header cache so stage 4 does not redo them
#   3. you read the summary, then type WRITE to continue (anything else stops)
#   4. the real load into the Supabase project
#   5. optional: a second pass, which must write 0 rows (idempotence)
#   6. optional: the verifier over every funder in the project
#
# The secret key is asked for here, with nothing shown on screen, held only in this
# script's environment, and never written to a file, a log or the shell history.
# Every stage appends its output to $WORK/logs/ (those logs hold no secret: the
# loader never prints one). Run again after any interruption: every stage resumes.
#
#   bash scripts/run-california-load.sh
#
# Override where things live with IRS_DATA_DIR (default ~/irs-data) and IRS_WORK_DIR
# (default ~/irs-work). Both are outside the repository.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

DATA="${IRS_DATA_DIR:-$HOME/irs-data}"
WORK="${IRS_WORK_DIR:-$HOME/irs-work}"
LOGS="$WORK/logs"
mkdir -p "$DATA" "$WORK" "$LOGS"

# Keep the machine awake for as long as this script runs (a sleeping Mac stops the load).
if command -v caffeinate >/dev/null 2>&1; then caffeinate -i -w $$ & fi

read -r -s -p "Paste the Supabase secret key (it starts sb_secret_), then press Return. Nothing will be shown: " SUPABASE_SERVICE_ROLE_KEY
echo
case "$SUPABASE_SERVICE_ROLE_KEY" in
  sb_secret_*) ;;
  *) echo "That is not an sb_secret_ key (a legacy eyJ key is rejected by this project). Stopping; nothing was done."; exit 2 ;;
esac
export SUPABASE_SERVICE_ROLE_KEY
export NEXT_PUBLIC_SUPABASE_URL="https://mbsxeyoxojcqetrmwgba.supabase.co"
# The default Node heap is about 4 GB and the header scan has needed about 5 GB.
export NODE_OPTIONS="--max-old-space-size=10240"

LOAD_ARGS=(--work-dir "$WORK" --index-dir "$DATA/index" --archives-dir "$DATA/zips" --state CA --years 2022,2023,2024 --audit-header-sample 3000)

stage() { echo; echo "=== $1 ($(date '+%H:%M:%S')) ==="; }

stage "1 of 6: download the IRS files into $DATA"
npx tsx scripts/fetch-funder-reference-sources.ts --out "$DATA" --parallel 2 2>&1 | tee -a "$LOGS/1-download.log"
if [ "${PIPESTATUS[0]}" -ne 0 ]; then echo "The download did not finish cleanly. Run this script again; it resumes."; exit 1; fi

stage "2 of 6: DRY RUN (reads everything, writes nothing)"
npx tsx scripts/load-funder-reference.ts "${LOAD_ARGS[@]}" --dry-run --target "pglite:$WORK/dry-run-db" 2>&1 | tee -a "$LOGS/2-dry-run.log"
if [ "${PIPESTATUS[0]}" -ne 0 ]; then echo "The dry run did not finish cleanly. Read $WORK/run-diary.log, then run this script again; it resumes."; exit 1; fi

stage "3 of 6: your decision"
echo "The summary above is what a real load would do. Nothing has been written to production."
read -r -p "Type WRITE to load this into the production database now, or just press Return to stop: " ANSWER
if [ "$ANSWER" != "WRITE" ]; then echo "Stopped. Nothing was written."; exit 0; fi

stage "4 of 6: the real load into the Supabase project"
npx tsx scripts/load-funder-reference.ts "${LOAD_ARGS[@]}" --target supabase --confirm-write-to-supabase 2>&1 | tee -a "$LOGS/4-load.log"
if [ "${PIPESTATUS[0]}" -ne 0 ]; then echo "The load did not finish cleanly. Read $WORK/run-diary.log, then run this script again; it resumes and rewrites nothing that is already stored."; exit 1; fi

stage "5 of 6: optional second pass (must write 0 rows)"
read -r -p "Run the second pass now? Type y, or press Return to skip: " ANSWER
if [ "$ANSWER" = "y" ]; then
  npx tsx scripts/load-funder-reference.ts "${LOAD_ARGS[@]}" --target supabase --confirm-write-to-supabase 2>&1 | tee -a "$LOGS/5-second-pass.log"
fi

stage "6 of 6: optional verification of every funder against its IRS filing"
read -r -p "Run the verifier over all funders now (long)? Type y, or press Return to skip: " ANSWER
if [ "$ANSWER" = "y" ]; then
  npx tsx scripts/verify-funder-reference-example.ts --db supabase --all --archives-dir "$DATA/zips" 2>&1 | tee -a "$LOGS/6-verify.log"
fi

echo; echo "Done. Logs are in $LOGS and the run diary is $WORK/run-diary.log."
