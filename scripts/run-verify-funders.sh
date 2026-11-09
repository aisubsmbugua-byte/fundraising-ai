#!/usr/bin/env bash
# Item 110 / ruling 0046: verify named funders in the production funder reference
# database against their IRS filings, from this Mac. Reads only; writes nothing to
# the database. The secret key is asked for with nothing shown on screen, held only
# in this script's environment and never written anywhere.
#
#   bash scripts/run-verify-funders.sh 142004175,203216993,203940983
#   bash scripts/run-verify-funders.sh all          # every funder (long)
#
# The full report goes to $WORK/logs/verify-<timestamp>.log; the screen shows only the
# summary and the first lines of any mismatch.

set -uo pipefail
cd "$(dirname "$0")/.." || exit 2

WHICH="${1:-}"
if [ -z "$WHICH" ]; then echo "usage: bash scripts/run-verify-funders.sh <comma-separated EINs | all>"; exit 2; fi

DATA="${IRS_DATA_DIR:-$HOME/irs-data}"
WORK="${IRS_WORK_DIR:-$HOME/irs-work}"
mkdir -p "$WORK/logs"
LOG="$WORK/logs/verify-$(date +%Y%m%d-%H%M%S).log"

if command -v caffeinate >/dev/null 2>&1; then caffeinate -i -w $$ & fi

read -r -s -p "Paste the Supabase secret key (it starts sb_secret_), then press Return. Nothing will be shown: " SUPABASE_SERVICE_ROLE_KEY
echo
case "$SUPABASE_SERVICE_ROLE_KEY" in
  sb_secret_*) ;;
  *) echo "That is not an sb_secret_ key. Stopping; nothing was done."; exit 2 ;;
esac
export SUPABASE_SERVICE_ROLE_KEY
export NEXT_PUBLIC_SUPABASE_URL="https://mbsxeyoxojcqetrmwgba.supabase.co"
export NODE_OPTIONS="--max-old-space-size=8192"

if [ "$WHICH" = "all" ]; then SEL="--all"; else SEL="--ein $WHICH"; fi

echo "Verifying ($WHICH). Full report: $LOG"
# shellcheck disable=SC2086
npx tsx scripts/verify-funder-reference-example.ts --db supabase $SEL --archives-dir "$DATA/zips" > "$LOG" 2>&1
CODE=$?

echo
grep -E "^compared |RESULT" "$LOG"
echo "--- first mismatch lines (if any) ---"
grep -m 15 "MISMATCH" "$LOG" | cut -c1-200
echo "Total MISMATCH lines: $(grep -c MISMATCH "$LOG")"
echo "Done (exit $CODE). Full report: $LOG"
