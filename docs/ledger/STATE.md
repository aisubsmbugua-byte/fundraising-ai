# STATE

The handoff file. Both spaces write it. Every open item names the side that owns
it — if an item has no owner, nobody is doing it and both spaces think the other
one is.

Last touched by: **build** · 2026-09-16

## Authorized now

- ruling: none
- work: none
- note: Step 4 is complete and reported. Step 5 has not been authorized. The
  build space must not start it until the decision space rules.

## Open items

| id | owner | subject | opened |
|----|-------|---------|--------|
| 1 | decision | Confirm the six back-filled rulings (0002, 0003, 0005, 0006, 0007 carry `provenance: reconstructed`). They were reconstructed from the session transcript, not copied from written rulings. Until confirmed they are claims about what was decided, not the decisions themselves. | 2026-09-16 |
| 2 | decision | Review Step 4 (`docs/reviews/` pending, `lib/availability.ts`, 29 tests) and rule on Step 5 — deterministic disqualification rules. Ruling 0002 binds: denominational auto-dismissal stays disabled. Ruling 0006 binds: a rule may fire only on a fact that is `found`. | 2026-09-16 |
| 3 | decision | Decide whether the availability ledger's default scope is right. `deriveAvailability` defaults to the **screening** required set, not all 43 facts. Deliberate, following Step 1's per-consumer grading — but it means the ledger a user sees at qualification is narrower than a strategy run would need. | 2026-09-16 |
| 4 | build | Step 3b: selection and fetch recall against the frozen reference set has not been measured. Needs a user-run model call. Blocked on user execution, not on a ruling. | 2026-09-16 |
| 5 | decision | Untested: whether newly discovered named opportunities carry name + source URL through the handoff contract end to end. Ruling 0003 authorized the contract; nothing has verified it in a live run. | 2026-09-16 |
| 6 | decision | **The ledger currently fails its own check**, and deliberately so. Creating it modified `CLAUDE.md` and `package.json` with no ruling authorizing them. Rule on the ledger's own introduction — either write a ruling and set it as Authorized now, or run `npm run ledger -- --seal` to grandfather them. Leaving the failure visible until then is the protocol working, not a bug to route around. | 2026-09-16 |

## Closed items

_None yet._

## Format

`## Authorized now` takes `- key: value` lines. `ruling` is a ruling id or
`none`. Open items are a table; `owner` is `decision` or `build`. Move an item to
Closed rather than deleting it — what was decided and then dropped is itself a
fact worth keeping.
