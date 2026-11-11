#!/usr/bin/env bash
# Item 116, ruling 0047 clause 6: the owner's decision of 2026-11-11 to run the public charity and
# donor-advised fund sponsor load for every state, one state at a time, each state checked before the next.
#
# What it does, for each jurisdiction in turn (California is already loaded and checked, so it is skipped):
#   1. load that state with scripts/load-public-charities.ts (writes only the six charity_reference_*
#      tables; refuses while any run that loads is recorded as running);
#   2. check that state's seeded sample against the IRS returns with scripts/verify-public-charities.ts,
#      and record the verdict on the run (--annotate-run);
#   3. only if both succeed, mark the state done and go on.
# It STOPS at the first state whose load fails or whose check reports anything it cannot explain, and
# says which. Run it again after a stop: finished states are skipped, so it resumes at the stopped one.
# It sends nothing to anyone.
#
# Usage (as the service user, under systemd-run; see the owner's notes):
#   charity-run-all.sh [STATE ...]        # no arguments = every jurisdiction below
#
# Exit codes: 0 all done; 1 a state's check found a difference nobody has explained; 3 a load failed.

set -uo pipefail

APP="${FUNDER_CHARITY_APP:-/opt/funder-loader/charity-app/repo}"
DATA="${FUNDER_DATA:-/var/lib/funder-loader/data}"
WORK="${FUNDER_CHARITY_WORK:-/var/lib/funder-loader/work-charity}"
TSX="$APP/node_modules/.bin/tsx"
ALL="AE AK AL AR AS AZ CO CT DC DE FL GA GU HI IA ID IL IN KS KY LA MA MD ME MI MN MO MP MS MT NC ND NE NH NJ NM NV NY OH OK OR PA PR RI SC SD TN TX UT VA VI VT WA WI WV WY"
STATES="${*:-$ALL}"

cd "$APP"
mkdir -p "$WORK/done"
for st in $STATES; do
  if [ -e "$WORK/done/$st" ]; then echo "== $st: already loaded and checked, skipped =="; continue; fi
  echo "== $st: load $(date -u +%H:%M) UTC =="
  "$TSX" scripts/load-public-charities.ts --work-dir "$WORK" --index-dir "$DATA/index" --archives-dir "$DATA/zips" \
    --state "$st" --target supabase --confirm-write-to-supabase --result-file "$WORK/$st-load.json" || { echo "STOPPED: the load of $st failed"; exit 3; }
  echo "== $st: check $(date -u +%H:%M) UTC =="
  "$TSX" scripts/verify-public-charities.ts --target supabase --state "$st" --archives-dir "$DATA/zips" --index-dir "$DATA/index" \
    --work-dir "$WORK" --result-file "$WORK/$st-verify.json" --annotate-run || { echo "STOPPED: the check of $st found a difference nobody has explained"; exit 1; }
  touch "$WORK/done/$st"
  echo "== $st: loaded and checked $(date -u +%H:%M) UTC =="
done
echo "== every requested state is loaded and checked $(date -u +%H:%M) UTC =="
