#!/usr/bin/env bash
# Item 116, ruling 0047 clause 6: the owner's decision of 2026-11-11 to run the public charity and
# donor-advised fund sponsor load for every state, one state at a time, each state checked before the next.
#
# What it does, for each jurisdiction in turn (California is already loaded and checked, so it is skipped):
#   1. load that state with scripts/load-public-charities.ts (writes only the six charity_reference_*
#      tables; refuses while any run that loads is recorded as running);
#   2. check that state's seeded sample against the IRS returns with scripts/verify-public-charities.ts,
#      and record the verdict on the run (--annotate-run);
#   3. mark the state done only if the check passed.
# The owner's decision of 2026-11-11 (decision 0012) on a check that does not pass:
#   - STOPS at once (exit 3 or 4) when a load fails, or the check reports a structural failure: the run's
#     outcomes do not add up, the header or scope audit finds a return the loader got wrong, or an input
#     is missing. Those signal a broken loader, and going on would repeat the fault in every state.
#   - Otherwise (exit 1: only sample-value differences nobody has explained) the state is recorded as NOT
#     verified, in the database (counts.verification.verified = false on its run) and in the unverified
#     folder, and the run goes on to the next state. It halts after 3 unverified states in a row or 8 in all.
#   - A state whose differences all fit the margin of error (decision 0013: 0.01% of the values compared,
#     1% of the funders checked for a difference in who a funder is, one miss in each audit sample, and
#     nothing about a stored person or donor) is recorded as "verified within tolerance" (its record says
#     so, and it is listed in the within-tolerance folder), and counts as done.
#   - The national load is not complete, and nothing may rely on it, until every unverified state's
#     differences are explained or fixed and the state re-checked. At the end this script lists them and
#     exits 5 if any remain; it exits 0 only when every requested state passed.
# Run it again after a stop: finished states are skipped; unverified ones are loaded and checked again.
# It sends nothing to anyone.
#
# Usage (as the service user, under systemd-run; see the owner's notes):
#   charity-run-all.sh [STATE ...]        # no arguments = every jurisdiction below
#
# Exit codes: 0 all done and verified; 3 a load failed; 4 a structural failure; 5 the run halted on, or
# finished with, states not verified.

set -uo pipefail

APP="${FUNDER_CHARITY_APP:-/opt/funder-loader/charity-app/repo}"
DATA="${FUNDER_DATA:-/var/lib/funder-loader/data}"
WORK="${FUNDER_CHARITY_WORK:-/var/lib/funder-loader/work-charity}"
TSX="$APP/node_modules/.bin/tsx"
ALL="AE AK AL AR AS AZ CO CT DC DE FL GA GU HI IA ID IL IN KS KY LA MA MD ME MI MN MO MP MS MT NC ND NE NH NJ NM NV NY OH OK OR PA PR RI SC SD TN TX UT VA VI VT WA WI WV WY"
STATES="${*:-$ALL}"

cd "$APP"
mkdir -p "$WORK/done" "$WORK/unverified"
MAX_IN_A_ROW=3
MAX_IN_ALL=8
in_a_row=0
for st in $STATES; do
  if [ -e "$WORK/done/$st" ]; then echo "== $st: already loaded and checked, skipped =="; continue; fi
  echo "== $st: load $(date -u +%H:%M) UTC =="
  "$TSX" scripts/load-public-charities.ts --work-dir "$WORK" --index-dir "$DATA/index" --archives-dir "$DATA/zips" \
    --state "$st" --target supabase --confirm-write-to-supabase --result-file "$WORK/$st-load.json" || { echo "STOPPED: the load of $st failed"; exit 3; }
  echo "== $st: check $(date -u +%H:%M) UTC =="
  "$TSX" scripts/verify-public-charities.ts --target supabase --state "$st" --archives-dir "$DATA/zips" --index-dir "$DATA/index" \
    --work-dir "$WORK" --result-file "$WORK/$st-verify.json" --annotate-run
  rc=$?
  if [ $rc -eq 0 ]; then
    rm -f "$WORK/unverified/$st"; touch "$WORK/done/$st"; in_a_row=0
    if grep -q '"verification_status": "verified_within_tolerance"' "$WORK/$st-verify.json" 2>/dev/null; then
      mkdir -p "$WORK/within-tolerance"; date -u +%FT%TZ > "$WORK/within-tolerance/$st"
      echo "== $st: loaded, and verified WITHIN THE MARGIN OF ERROR (differences listed in $WORK/$st-verify.json) $(date -u +%H:%M) UTC =="
    else
      rm -f "$WORK/within-tolerance/$st"
      echo "== $st: loaded and checked $(date -u +%H:%M) UTC =="
    fi
  elif [ $rc -eq 1 ]; then
    date -u +%FT%TZ > "$WORK/unverified/$st"; in_a_row=$((in_a_row + 1))
    echo "== $st: NOT VERIFIED (sample-value differences nobody has explained; see $WORK/$st-verify.json); going on =="
    total=$(ls "$WORK/unverified" | wc -l)
    if [ $in_a_row -ge $MAX_IN_A_ROW ] || [ "$total" -ge $MAX_IN_ALL ]; then
      echo "STOPPED: $in_a_row state(s) in a row and $total in all are not verified; that points at the check or the loader, not at single returns"
      exit 5
    fi
  else
    echo "STOPPED: the check of $st reported a structural failure or crashed (exit $rc)"; exit 4
  fi
done
left=$(ls "$WORK/unverified" 2>/dev/null | tr '\n' ' ')
if [ -n "$left" ]; then echo "== finished, but these states are NOT verified: $left =="; exit 5; fi
echo "== every requested state is loaded and checked $(date -u +%H:%M) UTC =="
