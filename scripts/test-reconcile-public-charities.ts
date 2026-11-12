// Item 116: the pure part of the moved-filer reconcile (lib/funder-reference/reconcile-990.ts).
// Usage: npx tsx scripts/test-reconcile-public-charities.ts
import { reconcileKinds, needsReconcile } from "../lib/funder-reference/reconcile-990";
import { DEFAULT_CHARITY_THRESHOLD as T, kindsForFunder, type PeriodFacts } from "../lib/funder-reference/charity-scope";

let pass = 0, fail = 0;
const ok = (label: string, c: boolean, d = "") => { console.log(`${c ? "PASS" : "FAIL"}: ${label}${c ? "" : `\n      ${d}`}`); c ? pass++ : fail++; };
const p = (end: string, grants: number | null, daf: number | null = null, box: boolean | null = false): PeriodFacts => ({ taxPeriodEnd: end, orgGrantsAmt: grants, dafHeldCnt: daf, dafBox: box });

const all = [p("2022-12-31", 187234), p("2023-12-31", 229228), p("2024-12-31", 168719)];
const onlyLatest = kindsForFunder([all[2]], T);
const stored = { is_grantmaking_public_charity: onlyLatest.isGrantmakingPublicCharity, is_daf_sponsor: onlyLatest.isDafSponsor, kind_basis: onlyLatest.basis };

let r = reconcileKinds(stored, all, T);
ok("a basis resting on one of three returns is patched to list all three", r.action === "patch" && r.patch.kind_basis.length === 3 && r.basisAdded === 2, JSON.stringify(r));
ok("the patched basis is sorted by period, with the loader's own keys", r.action === "patch" && r.patch.kind_basis.map((b) => b.tax_period_end).join() === "2022-12-31,2023-12-31,2024-12-31" && Object.keys(r.patch.kind_basis[0]).sort().join() === "donor_advised_fund_box,donor_advised_funds_held_cnt,grants_to_domestic_orgs_amt,tax_period_end", JSON.stringify(r));
ok("the labels did not change when they were already right", r.action === "patch" && r.labelChanged === false);

r = reconcileKinds({ ...stored, kind_basis: kindsForFunder(all, T).basis }, [...all].reverse(), T);
ok("a basis that already lists every return is left alone, whatever the order", r.action === "none", JSON.stringify(r));

const low = [p("2022-12-31", 250_000), p("2024-12-31", 40_000)];
const lowStored = kindsForFunder([low[1], p("2024-12-31", 100_000)].slice(1), T);
r = reconcileKinds({ is_grantmaking_public_charity: false, is_daf_sponsor: false, kind_basis: lowStored.basis }, low, T);
ok("a label that rested on too few returns is corrected (a return over the threshold was in the other state)", r.action === "patch" && r.patch.is_grantmaking_public_charity === true && r.labelChanged === true, JSON.stringify(r));

r = reconcileKinds({ is_grantmaking_public_charity: false, is_daf_sponsor: true, kind_basis: [] }, [p("2023-12-31", 10, 2), p("2024-12-31", null, null, true)], T);
ok("a sponsor stays a sponsor; an unstated figure is not zero and not a miss", r.action === "patch" && r.patch.is_daf_sponsor === true && r.patch.kind_basis[1].grants_to_domestic_orgs_amt === null, JSON.stringify(r));

r = reconcileKinds(stored, [p("2024-12-31", 10)], T);
ok("it refuses to take a funder out of scope", r.action === "refuse", JSON.stringify(r));
r = reconcileKinds(stored, [], T);
ok("it refuses when no return could be read", r.action === "refuse", JSON.stringify(r));

ok("which funders need a look: periods differ", needsReconcile(onlyLatest.basis, ["2022-12-31", "2023-12-31", "2024-12-31"]) === true);
ok("which funders need a look: periods equal, any order", needsReconcile(kindsForFunder(all, T).basis, ["2024-12-31", "2022-12-31", "2023-12-31"]) === false);
ok("which funders need a look: an amended and an original return of one period are two entries", needsReconcile([{ tax_period_end: "2023-12-31" }], ["2023-12-31", "2023-12-31"]) === true);
ok("which funders need a look: a null basis is treated as empty", needsReconcile(null, ["2024-12-31"]) === true);

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
