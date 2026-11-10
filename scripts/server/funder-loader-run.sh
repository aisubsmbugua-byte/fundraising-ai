#!/usr/bin/env bash
# Item 114, authorized by ruling 0046: what the server runs, for the first load and for
# the monthly refresh alike (systemd starts this; see setup-funder-loader.sh).
#
# FOR THE OWNER. Three steps, then it hands over to the all-states command:
#   1. fetch today's IRS index files (small; always replaced whole, never appended to);
#   2. fetch any IRS archive not yet on this disk (the big files; skips what is complete
#      and resumes a partial download);
#   3. load every state that is not already complete for what the index now lists, check a
#      sample of each, and stop on any difference nobody has explained.
# Run again after any stop: every step resumes. It sends nothing to anyone.
#
# Exit codes: those of scripts/load-all-states.ts (0 done; 1 stopped on a difference; 2
# configuration; 3 a state failed; 4 another copy running), or 5 when a download failed
# (the one case systemd should retry by itself).

set -euo pipefail

APP="${FUNDER_APP:-/opt/funder-loader/app}"
DATA="${FUNDER_DATA:-/var/lib/funder-loader/data}"
WORK="${FUNDER_WORK:-/var/lib/funder-loader/work}"
TSX="$APP/node_modules/.bin/tsx"

cd "$APP"
mkdir -p "$DATA/index" "$DATA/zips" "$WORK"

echo "== 1. IRS index files =="
rm -rf "$DATA/staging"
"$TSX" scripts/fetch-funder-reference-sources.ts --out "$DATA/staging" --index-only --parallel 2 || { echo "the index download failed"; exit 5; }
for f in "$DATA"/staging/index/index_*.csv; do
  [ -e "$f" ] || { echo "the index download produced no index file"; exit 5; }
  mv -f "$f" "$DATA/index/"
done
rm -rf "$DATA/staging"

echo "== 2. IRS archives not yet on disk =="
# --zips-only: the index files were just replaced whole in step 1 and must not be compared again
# (on 2026-11-09 a second comparison reported a smaller size than the file just downloaded and
# stopped the first run on the server)
"$TSX" scripts/fetch-funder-reference-sources.ts --out "$DATA" --zips-only --parallel 2 || { echo "the archive download failed"; exit 5; }

echo "== 3. every state =="
exec "$TSX" scripts/load-all-states.ts --work-dir "$WORK" --index-dir "$DATA/index" --archives-dir "$DATA/zips" --target supabase --confirm-write-to-supabase "$@"
