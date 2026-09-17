# The ledger — how the decision space and the build space talk

Two Claude Code sessions run against this same directory:

- **The decision space** — where context is worked on, work is counterchecked, and
  rulings are issued. Writes `docs/ledger/` and `docs/reviews/`. Reads everything.
  Does not write code.
- **The build space** — where code is written. Reads rulings, writes code and
  build reports. Does not write rulings.

They cannot talk directly. There is no live channel between two sessions, and
there is deliberately no attempt to fake one. The channel is this directory, and
the transport is the human moving between terminals. That is the same shape as
hard rule 3: AI drafts and suggests, a human decides. Applied here to the build
process itself.

## Why files and a check, rather than an instruction

Because this codebase already knows what happens to a rule that lives only in a
prompt. Measured prompt-only compliance on this project is 52–80% — which is why
the Research Agent selects `evidence_ids` instead of writing its own quote, and
why a candidate's display name is derived rather than restated. A protocol held
only in a system prompt drifts exactly the same way, and it drifts silently.

So the protocol is three things a script can check:

1. **`STATE.md`** — the one mutable file. What is open, and *which side owns it*.
   Both spaces write it. It is the handoff.
2. **`rulings/NNNN-*.md`** — written only by the decision space. Once `status:
   settled`, immutable: its hash is recorded in `rulings/.settled.json` and any
   later edit is a check failure, not a correction. A ruling changes by being
   superseded by a new one, never by being rewritten.
3. **`scripts/ledger-check.ts`** — runs the checks. Wired to a Stop hook so it
   runs at the end of every turn in both spaces.

## The rule with teeth

**No code change in a governed area survives without a ruling that authorized
it.**

`STATE.md` carries an `## Authorized now` section naming the ruling currently in
force. If the working tree has code changes and nothing is authorized, the check
fails and says so. This is the governing rule — *every case-specific failure must
be translated into a general system invariant before code is changed* — made
mechanical instead of remembered.

## The known escape hatch

`--seal` re-records ruling hashes and re-baselines the working tree. It can
therefore be used to launder an unauthorized change into an approved one, and a
check with an escape hatch nobody names is worse than no check. So: **`--seal` is
decision-space-only.** The build space never runs it. If the build space is
staring at a failing check and reaching for `--seal`, that is precisely the
moment the protocol is meant to stop it.

This is not enforced in code — it cannot be, since both spaces run in the same
directory with the same permissions. It is enforced by being written down here,
and by the seal file being visible in every diff.

## The handoff cycle

```
build space     finishes work
                → writes docs/reviews/NNNN-*.md
                → appends an item to STATE.md with owner: decision
                → tells you: ready for the decision space

you             switch terminal

decision space  reads STATE.md, sees the item
                → reads the review, the diff, and — if it needs the build
                  space's actual words — searches its transcript directly
                → writes rulings/NNNN-*.md
                → flips the item to owner: build, sets Authorized now
                → tells you: ready for the build space

you             switch back
```

## Reading the other space's actual words

The decision space does not have to rely on a summary. It can full-text search
the build session's transcript (`search_session_transcripts`) and read what was
really said — the raw number before it was rounded, the caveat before it was
dropped. Use it whenever a build report makes a claim that matters. This project
has already had a measurement labelled "78% coverage" that was not coverage, and
a "47% discovery recall" that conflated never-retrieved with retrieved-then-
reduced. Both were caught by going back to the underlying words.

## Provenance on back-filled rulings

Rulings numbered before this ledger existed were reconstructed from the session
transcript, not copied from a written ruling. They carry `provenance:
reconstructed` and must be confirmed in the decision space before being relied
on. This is the same rule the product applies to itself: a field a model wrote is
a claim, not a fact. A reconstructed ruling is a claim about what was decided.

## Starting each space

In the decision space, open with:

> Read docs/ledger/ROLE-decision.md and operate as that role.

In the build space:

> Read docs/ledger/ROLE-build.md and operate as that role.

Nothing else is needed. Both files point back here.
