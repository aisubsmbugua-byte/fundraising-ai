#!/usr/bin/env bash
# Owner tool (STATE item 96): put the assistant's Meta API key where it needs to
# be, without the key ever appearing on screen, in a command line, in shell
# history, in a chat, or in a file other than .env.local (git-ignored).
#
# What it does, in order:
#   1. Asks for the key with a hidden prompt (nothing is echoed).
#   2. Writes MODEL_API_KEY and ASSISTANT_ENABLED_ORG_IDS into .env.local
#      (mode 600), replacing any earlier lines for those two names.
#   3. Checks you are logged in to Vercel (opens the browser login if not).
#   4. Replaces both variables on the Vercel project's Production environment,
#      after asking you to confirm.
#
# The key reaches Vercel through a pipe on standard input -- never as a command
# argument, which other processes on the machine can read.
#
# It does not deploy. Environment variables apply to the NEXT deployment; the
# closing message says how to trigger one.
#
# Usage (from anywhere):
#   bash "/Users/kanjii/Developer/Fundraising Ai Build/fundraising-ai/scripts/set-assistant-key.sh"

set -euo pipefail

ROOT="/Users/kanjii/Developer/Fundraising Ai Build/fundraising-ai"
ENV_FILE="$ROOT/.env.local"
# VWI's organization id -- the one organization the assistant is switched on for.
ORG_IDS="340d8e2b-68bf-40e6-bb92-55f40387393a"

cd "$ROOT"

KEY=""
trap 'KEY=""; unset KEY' EXIT

echo "Assistant key setup for $(basename "$ROOT")"
echo
printf "Paste the Meta API key (input is hidden), then press Return: "
IFS= read -rs KEY
echo

if [ -z "$KEY" ]; then
  echo "No key entered. Nothing was changed." >&2
  exit 1
fi
if [[ "$KEY" =~ [[:space:]] ]]; then
  echo "That contains spaces or line breaks, which a key never does. Nothing was changed." >&2
  exit 1
fi
echo "Key received (${#KEY} characters)."

# --- 2. .env.local -----------------------------------------------------------
touch "$ENV_FILE"
chmod 600 "$ENV_FILE"
TMP="$(mktemp)"
grep -v -E '^(MODEL_API_KEY|ASSISTANT_ENABLED_ORG_IDS)=' "$ENV_FILE" > "$TMP" || true
{
  cat "$TMP"
  printf 'MODEL_API_KEY=%s\n' "$KEY"
  printf 'ASSISTANT_ENABLED_ORG_IDS=%s\n' "$ORG_IDS"
} > "$ENV_FILE"
rm -f "$TMP"
chmod 600 "$ENV_FILE"
echo "Wrote MODEL_API_KEY and ASSISTANT_ENABLED_ORG_IDS to .env.local (git-ignored)."

# --- 3. Vercel login -----------------------------------------------------------
VERCEL=(npx --yes vercel@latest)
echo
echo "Checking your Vercel login..."
if ! "${VERCEL[@]}" whoami >/dev/null 2>&1; then
  echo "Not logged in to Vercel. A browser window will open to log in."
  "${VERCEL[@]}" login
fi
echo "Logged in to Vercel as: $("${VERCEL[@]}" whoami 2>/dev/null | tail -1)"

# --- 4. Vercel environment ---------------------------------------------------------
echo
echo "This will set MODEL_API_KEY and ASSISTANT_ENABLED_ORG_IDS on the"
echo "fundraising-ai project's PRODUCTION environment (replacing any existing value)."
printf "Continue? [y/N] "
read -r ANSWER
if [ "$ANSWER" != "y" ] && [ "$ANSWER" != "Y" ]; then
  echo "Stopped before touching Vercel. .env.local is updated; Vercel is unchanged."
  exit 0
fi

set_vercel_var() {
  local name="$1" value="$2"
  "${VERCEL[@]}" env rm "$name" production -y >/dev/null 2>&1 || true
  printf '%s' "$value" | "${VERCEL[@]}" env add "$name" production >/dev/null
  echo "  set $name on Production"
}
set_vercel_var MODEL_API_KEY "$KEY"
set_vercel_var ASSISTANT_ENABLED_ORG_IDS "$ORG_IDS"

echo
echo "Done. The key is in .env.local and on Vercel Production."
echo "Vercel applies new variables on the NEXT deployment -- ask Claude to trigger one,"
echo "or push any commit. To check the connection to Meta from this machine, run:"
echo "  cd \"$ROOT\" && npx tsx --env-file=.env.local scripts/assistant-smoke.ts"
