# Review 0025 — the blank-organization walkthrough, Friday morning

Decision space, 2026-09-26. Method: a fictional organization and a directly-
created (never emailed) tester account, driven through a real browser against
the live production app. Everything created was deleted afterward and
verified gone by direct query. No outgoing communication occurred at any
point — the account was created via the admin API's createUser, never via
inviteUserByEmail, and the only link used was generateLink's own return value,
opened by this session, never dispatched anywhere.

## Critical finding, fixed same session (item 78)

The exact link Supabase issues for a real admin-side invite failed to
complete sign-in — "Something went wrong signing you in." Root cause: the
self-serve login button (`signInWithOtp`, client-initiated) produces a
PKCE-style link the callback route already handles; the admin invite path
(`sendOrgInvite` -> `inviteUserByEmail`, server-initiated) produces a
different, hash-token-carrying link the callback route had no way to read,
because hash fragments never reach a server at all. Every real invite this
app has ever sent was, in all likelihood, unable to complete. Fixed by adding
a client-side arrival page that reads the hash, establishes the session via
the SDK's own `setSession`, and completes the same profile-creation logic —
one shared function, called from both paths. Re-tested live after the fix:
a fresh link now lands on `/pipeline` with a correctly created profile row,
confirmed by direct query. Full detail: STATE item 78.

## The blank-organization experience, page by page

- **Pipeline** — empty board, all six stages present and correctly at zero,
  no crash.
- **Org Profile** — every field empty with a helpful placeholder; the logo
  note states plainly that no upload means no logo, never a broken image.
- **Evidence Library** — correct zeroed counts, working category tabs, calm
  "No evidence yet" state.
- **Follow-ups** — every tab including Nurture (last night's build) renders
  at zero with "Nothing here."
- **Donor Finder** — "No pending candidates," and the page states hard rule 3
  in its own copy: "Nothing here reaches the pipeline until a human accepts
  it."
- **Network** — correctly failed with a graceful, honest message rather than
  a crash: migration 0077 has not yet been applied, so this feature is
  UNVERIFIED live. This is expected, not a defect; it is on the owner's
  remaining list.
- **Creating a prospect from zero** — worked end to end: name, channel,
  submit, landed on a real, well-formed detail page (Outcome, Opportunity
  summary, Screening, AI strategy, Next action, Key contact, Recent
  activity), every section in a correct, calm not-yet-started state, and the
  outcome card's own copy matches the domain glossary verbatim ("a no is
  data, not a dead end").
- **Deleting that prospect** — done via direct deletion during cleanup, not
  the UI button (the UI attempt did not visibly confirm in this session,
  possibly obscured by the toolbar noted below; not re-tested, low
  consequence, worth one owner click during the full walkthrough).

## Noted, not concluded: the Vercel Toolbar

A floating comment/annotation widget repeatedly intercepted clicks aimed at
buttons beneath it, including "Create Prospect," and persisted across page
navigations. This is very likely visible only because this session's browser
is authenticated to the Vercel team that owns the project — Vercel's toolbar
is documented to inject only for such sessions, and the accessibility tree
could not see the widget at all, consistent with it being an external
injection rather than part of the app's own code. **Not concluded as a
tester-facing defect.** One 30-second check settles it: open the production
URL in a private/incognito window (no Vercel login) and confirm the widget is
absent. If it is not absent, this becomes a real, fast fix (a Vercel project
setting).

## What this leaves for the owner's own walkthrough

Everything requiring human judgment rather than mechanical correctness: the
proposal PDF's visual quality, the deck's look, revising a proposal with real
feedback, sending a real email and checking the inbox placement, and the
network-paths feature once its migration is applied. Also worth one click:
the incognito check above.

## Handed to the ledger

Item 78 closes as released and proven live. The Network migration remains
the one outstanding piece of setup before that feature can be verified at
all — see STATE.md's open items.
