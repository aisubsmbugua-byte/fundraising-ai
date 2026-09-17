---
id: 0014
title: Recording what a ruling says and exempting the working tree are separate commands, and the routine one never performs the escape hatch
status: settled
provenance: verbatim
supersedes:
date: 2026-09-16
---

## The ruling

`--seal` records ruling hashes. That is all it does.

Re-baselining the working tree — the operation `README.md` names as the known
escape hatch — moves behind its own flag, `--baseline`, and every use of it
writes a dated reason into `.baseline.json` naming what was exempted and why.

`.baseline.json` carries two kinds of entry and must distinguish them: paths
grandfathered at ledger creation, and any path exempted since, with its date and
justification. They are not the same fact and a single flat list cannot tell them
apart.

## Why

Demonstrated accidentally, in the decision space, on 2026-09-16. Settling ruling
0013 required `--seal`, which is routine — it runs every time a ruling is
settled. That one command also silently rewrote `.baseline.json`, discarding the
28-path grandfather list and replacing it with the two paths build happened to
have dirty at that moment:

```
"note": "Uncommitted governed paths at ledger creation. Grandfathered -- predates the protocol.",
"paths": [ "lib/availability.ts", "scripts/test-availability.ts" ]
```

The note is now false about its own contents. Those two files are build's active
Step 4 work under ruling 0009, written *after* the protocol, and the file
asserts they predate it. Worse, both would have become permanently exempt from
the unauthorized-change check — the two files at the exact centre of the current
dispute, quietly removed from the guard that watches them.

No unauthorized change was laundered: build's edits were authorized under 0009,
and the check reports on a single `## Authorized now` ruling rather than on the
baseline while anything is authorized. The baseline has been restored. The defect
is the mechanism, not this instance.

`README.md` already anticipated the risk and named the mitigation — "`--seal` is
decision-space-only" — but that guards against the *wrong space* running it. It
does not guard against the right space running it for the right reason and
getting the second effect for free. A hatch that opens every time the front door
is used is not a hatch.

## The general invariant

One command, two effects, where one is routine and the other is consequential.
The routine use is frequent, so the consequential effect becomes invisible
through repetition — which is worse than an unguarded operation, because the
audit trail shows a legitimate action every time.

This is ruling 0012's shape at the command layer rather than the data layer.
0012 separated provenance from confirmation because one field was carrying two
facts; this separates sealing from baselining because one flag is carrying two
intentions. 0012's own test of compliance already stated the principle —
*"sealing records what a ruling says, confirmation records whether it is true,
and one command must not do both"* — and it applies here unchanged.

## Test of compliance

Run `--seal` with a dirty working tree containing a governed path that is not in
the baseline. The baseline must be byte-identical afterwards. If it is not, the
separation has not been made.

Any entry added to `.baseline.json` after ledger creation must be distinguishable
from a grandfathered one by reading the file alone.

## Scope

Authorizes changes to `scripts/ledger-check.ts` (the flag split and the
`.baseline.json` schema) and the corresponding correction to `README.md`'s
escape-hatch section, which currently describes a single command doing both jobs
and should describe two. Does not authorize changing which paths are governed, or
re-examining the grandfathered set — that list is now historical and the paths in
it have since been committed.
