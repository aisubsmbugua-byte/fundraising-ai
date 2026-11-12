#!/usr/bin/env bash
# Item 116: re-check named states WITHOUT reloading them (read-only against the database except that the
# verdict is recorded on the state's latest completed run, as charity-run-all.sh does).
#
# Why not charity-run-all.sh: that script loads a state first, and a state's load rewrites each of its funders'
# kind labels and basis from that state's returns alone, which would undo the moved-filer reconcile
# (scripts/reconcile-public-charities.ts) for every funder that moved. After the reconcile, re-checks must not
# reload.
#
# Usage: charity-recheck.sh STATE [STATE ...]    Exit 0 when every state passed (exactly or within the
# margin of error), 1 when any is still not verified or needs review, 3 when a check crashed.
set -uo pipefail
APP="${FUNDER_CHARITY_APP:-/opt/funder-loader/charity-app/repo}"
DATA="${FUNDER_DATA:-/var/lib/funder-loader/data}"
WORK="${FUNDER_CHARITY_WORK:-/var/lib/funder-loader/work-charity}"
TSX="$APP/node_modules/.bin/tsx"
cd "$APP"
mkdir -p "$WORK/done" "$WORK/unverified" "$WORK/needs-review" "$WORK/within-tolerance"
bad=""
for st in "$@"; do
  echo "== $st: re-check (no reload) $(date -u +%H:%M) UTC =="
  "$TSX" scripts/verify-public-charities.ts --target supabase --state "$st" --archives-dir "$DATA/zips" --index-dir "$DATA/index" \
    --work-dir "$WORK" --result-file "$WORK/$st-verify.json" --annotate-run
  rc=$?
  if [ $rc -eq 0 ]; then
    rm -f "$WORK/unverified/$st" "$WORK/needs-review/$st"; touch "$WORK/done/$st"
    if grep -q '"verification_status": "verified_within_tolerance"' "$WORK/$st-verify.json" 2>/dev/null; then
      date -u +%FT%TZ > "$WORK/within-tolerance/$st"; echo "== $st: verified WITHIN THE MARGIN OF ERROR =="
    else
      rm -f "$WORK/within-tolerance/$st"; echo "== $st: verified (exact) =="
    fi
  elif [ $rc -eq 1 ]; then
    date -u +%FT%TZ > "$WORK/unverified/$st"; rm -f "$WORK/done/$st"; bad="$bad $st"; echo "== $st: STILL NOT VERIFIED =="
  elif [ $rc -eq 4 ]; then
    date -u +%FT%TZ > "$WORK/needs-review/$st"; rm -f "$WORK/done/$st"; bad="$bad $st"; echo "== $st: NEEDS REVIEW (structural failure) =="
  else
    echo "== $st: the check crashed or was misused (exit $rc) =="; exit 3
  fi
done
if [ -n "$bad" ]; then echo "== re-check finished; not verified:$bad =="; exit 1; fi
echo "== re-check finished; every named state passed =="
