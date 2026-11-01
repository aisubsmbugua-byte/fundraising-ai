// STATE item 76 -- network capture v1 (ruling 0033), as amended by item 103
// (ruling 0040: import, narrowing instead of refusal). Offline: migration 0077's
// statics, the pure rules in lib/network.ts run for real, and source scans of
// the actions and pages. No database and no API key.
//
// What this CANNOT prove (named for the owner's live run, scripts/
// test-tenant-isolation.ts, written and unexecuted): that the org-match
// triggers actually refuse a cross-org insert and that deleting a connection
// actually deletes its suggestions. Here both are proven STATICALLY -- the
// trigger definitions and the cascade clause are in the SQL -- not by running
// Postgres.
//
// Usage: npx tsx scripts/test-network.ts

import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  CONNECTION_STRENGTHS,
  NETWORK_ANCHOR_CLAIM_KEYS,
  NETWORK_DISCLOSURE,
  NETWORK_PATHS_TOOL,
  buildNetworkPathPrompt,
  selectAnchorClaims,
  validateNetworkPaths,
} from "../lib/network";
import {
  GENERIC_WORDS,
  MIN_SHARED_WORD_LENGTH,
  NETWORK_PATHS_MAX_CONSIDERED,
  WHOLE_NAME_BONUS,
  consideredSentence,
  distinctiveWords,
  emptyShortlistMessage,
  pathsOutcomeMessage,
  shortlistConnections,
  shortlistRuleSentence,
  tokenize,
} from "../lib/network-shortlist";
import { FakeNetDb, ORG_ID, USER_ID, makeStubber } from "./network-test-support";
import { AI_RUN_OPERATIONS } from "../lib/ai-runs";
import type { ApprovedClaim } from "../lib/prospect-intelligence";

const root = join(__dirname, "..");
let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
function section(t: string) {
  console.log(`\n--- ${t} ---`);
}
const read = (p: string) => readFileSync(join(root, p), "utf8");
// Code only: comments legitimately DISCUSS what must not exist.
const stripComments = (t: string) =>
  t
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((l) => l.replace(/(^|[^:"'`])\/\/.*$/, "$1"))
    .join("\n");
const stripSqlComments = (t: string) =>
  t
    .split("\n")
    .map((l) => l.replace(/--.*$/, ""))
    .join("\n")
    .toLowerCase();

// --- 1. Migration 0077 ------------------------------------------------------

section("migration 0077: numbering, additivity, header");
const migrations = readdirSync(join(root, "supabase/migrations")).filter((f) => /^\d{4}_/.test(f)).sort();
const file = migrations.find((f) => f.startsWith("0077_"));
// Not "...and is the highest-numbered migration" -- that was a
// position-relative assertion guaranteed to fail the moment any later
// migration landed (it did, at 0078). What this test actually cares about
// is that 0077 exists and is additive, not where it sits in a list that
// grows every week.
ok("0077 exists among the migrations", !!file, `found: ${file}`);
const raw = read(`supabase/migrations/${file}`);
const stmts = stripSqlComments(raw);
ok("header cites ruling 0020 additivity and states the deploy order both ways", /0020/.test(raw) && /CODE AHEAD OF THE MIGRATION/.test(raw) && /MIGRATION AHEAD OF THE CODE/.test(raw));
ok("header carries the SQL-editor caveat", /SQL-editor caveat/.test(raw));
ok("header states why no contact-detail column exists", /NO email, phone, address or social-handle column/i.test(raw));
ok("no drop, no add column, and every alter table touches only the two new tables", !/\bdrop\b/.test(stmts) && !/add column/.test(stmts) && [...stmts.matchAll(/alter table (\w+)/g)].every((m) => m[1].startsWith("network_")));
ok("no create or replace: nothing existing is redefined", !/create or replace/.test(stmts));

function tableBody(name: string): string {
  const m = stmts.match(new RegExp(`create table ${name} \\(([\\s\\S]*?)\\n\\);`));
  return m ? m[1] : "";
}
function columnsOf(body: string): string[] {
  return body
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("--"))
    .map((l) => l.split(/\s+/)[0])
    .filter((w) => /^[a-z_]+$/.test(w));
}
const connBody = tableBody("network_connections");
const sugBody = tableBody("network_path_suggestions");

section("migration 0077: network_connections (ruling 0033 clauses 1-2)");
const connColumns = columnsOf(connBody);
ok(
  "the column set is exactly the ruling's: id, organization_id, recorded_by, person_name, affiliation, how_known, strength, notes, timestamps",
  JSON.stringify(connColumns) ===
    JSON.stringify(["id", "organization_id", "recorded_by", "person_name", "affiliation", "how_known", "strength", "notes", "created_at", "updated_at"]),
  connColumns.join(", ")
);
ok("NO contact-detail column of any kind (email, phone, handle, address, url, social, contact)", !connColumns.some((c) => /email|phone|handle|address|url|social|linkedin|twitter|facebook|contact|mobile|whatsapp|website/.test(c)));
ok("strength is text NOT NULL with NO default", /\bstrength text not null,/.test(connBody) && !/strength[^,\n]*default/.test(connBody));
ok("strength is a closed list: close / warm / acquaintance", /check \(strength in \('close', 'warm', 'acquaintance'\)\)/.test(stmts));
ok("person_name cannot be blank", /length\(btrim\(person_name\)\) > 0/.test(stmts));
ok("organization_id is not null, references organizations and defaults to my_organization_id()", /organization_id uuid not null references organizations \(id\) default my_organization_id\(\)/.test(connBody));
ok("recorded_by references auth.users", /recorded_by uuid not null references auth\.users \(id\)/.test(connBody));
ok("RLS is enabled on network_connections", /alter table network_connections enable row level security/.test(stmts));
for (const op of ["select", "insert", "update", "delete"]) {
  ok(`network_connections has an org-scoped ${op} policy (all four exist by design)`, new RegExp(`on network_connections for ${op}\\s+to authenticated\\s+(using|with check) \\(([^;]*?)organization_id = my_organization_id\\(\\)`).test(stmts));
}
ok("insert additionally pins recorded_by to the session user", /on network_connections for insert[\s\S]*?recorded_by = auth\.uid\(\)/.test(stmts));

section("migration 0077: network_path_suggestions (ruling 0033 clauses 2, 4, 5)");
ok("connection FK cascades: deleting a person deletes their derived paths", /network_connection_id uuid not null references network_connections \(id\) on delete cascade/.test(sugBody));
ok("claim FK references research_claims (0035) and cascades: a suggestion does not outlive its anchor", /funder_claim_id uuid not null references research_claims \(id\) on delete cascade/.test(sugBody));
ok("prospect FK cascades", /prospect_id uuid not null references prospects \(id\) on delete cascade/.test(sugBody));
ok("reasoning is not null", /reasoning text not null/.test(sugBody));
ok("model_confidence is a closed list low / medium / high", /model_confidence is null or model_confidence in \('low', 'medium', 'high'\)/.test(stmts));
ok("status is NOT NULL and defaults to 'suggested' (the review state)", /status text not null default 'suggested'/.test(sugBody));
ok("status is a closed list suggested / accepted / dismissed", /check \(status in \('suggested', 'accepted', 'dismissed'\)\)/.test(stmts));
ok("decision columns and status agree by constraint (decided_by/decided_at only with a decision)", /status = 'suggested' and decided_by is null and decided_at is null/.test(stmts) && /status <> 'suggested' and decided_by is not null and decided_at is not null/.test(stmts));
ok("decided_by / decided_at are nullable", /decided_by uuid references auth\.users \(id\),/.test(sugBody) && /decided_at timestamptz,/.test(sugBody));
ok("the same path is stored once (unique prospect + connection + claim)", /unique \(prospect_id, network_connection_id, funder_claim_id\)/.test(stmts));
ok("organization_id is not null, references organizations and defaults to my_organization_id()", /organization_id uuid not null references organizations \(id\) default my_organization_id\(\)/.test(sugBody));
ok("RLS is enabled on network_path_suggestions", /alter table network_path_suggestions enable row level security/.test(stmts));
for (const op of ["select", "insert", "update"]) {
  ok(`network_path_suggestions has an org-scoped ${op} policy`, new RegExp(`on network_path_suggestions for ${op}\\s+to authenticated\\s+(using|with check) \\(organization_id = my_organization_id\\(\\)`).test(stmts));
}
ok("the insert policy admits only status = 'suggested' (nothing is born decided)", /on network_path_suggestions for insert[\s\S]*?status = 'suggested'/.test(stmts));
ok("no delete policy on suggestions (a dismissed path is kept; cascades still remove it)", !/on network_path_suggestions for delete/.test(stmts));

section("migration 0077: org-match triggers on EVERY cross-table reference (hard rule 6)");
for (const [ref, table, column] of [
  ["prospect", "prospects", "prospect_id"],
  ["connection", "network_connections", "network_connection_id"],
  ["claim", "research_claims", "funder_claim_id"],
] as const) {
  const fnName = `enforce_network_suggestion_${ref}_org_match`;
  const fn = stmts.match(new RegExp(`create function ${fnName}\\(\\) returns trigger as \\$\\$([\\s\\S]*?)\\$\\$ language plpgsql security definer set search_path = public;`));
  ok(`${ref}: function ${fnName} exists, is security definer with set search_path = public`, !!fn);
  ok(`${ref}: it compares new.organization_id to the referenced ${table} row's organization_id and raises`, !!fn && new RegExp(`from ${table} where id = new\\.${column}`).test(fn[1]) && /is distinct from/.test(fn[1]) && /raise exception/.test(fn[1]));
  ok(
    `${ref}: a before insert-or-update trigger on ${column} runs it for each row`,
    new RegExp(`create trigger network_path_suggestions_${ref}_org_match\\s+before insert or update of [a-z_, ]*\\b${column}\\b[a-z_, ]* on network_path_suggestions\\s+for each row execute function ${fnName}\\(\\)`).test(stmts)
  );
}
ok("the claim trigger also requires the claim to belong to the same prospect", /new\.prospect_id is distinct from c\.prospect_id/.test(stmts));
ok("exactly three security definer functions, all with search_path pinned (none without)", (stmts.match(/security definer/g) ?? []).length === 3 && (stmts.match(/security definer set search_path = public/g) ?? []).length === 3);

// --- 2. The pure rules, run for real ----------------------------------------

section("lib/network.ts: the disclosure, the closed lists, the anchor selection");
ok(
  "the clause-3 disclosure is the item row's sentence verbatim",
  NETWORK_DISCLOSURE ===
    "What you record here is shared with the AI service to find introductions. Nothing is ever sent to the people you list. Avoid recording sensitive personal details in notes."
);
ok("strengths are exactly close / warm / acquaintance", JSON.stringify([...CONNECTION_STRENGTHS]) === JSON.stringify(["close", "warm", "acquaintance"]));

function claim(over: Partial<ApprovedClaim> & { claimId: string; claimKey: string }): ApprovedClaim {
  return { humanDecided: false, claim: "x", reportingPeriod: null, advisory: false, limitation: null, humanOverride: false, overrideNote: null, sources: [], ...over };
}
const pool = [
  claim({ claimId: "c-people-verified", claimKey: "people.key_contacts", claim: "Jane Doe, Executive Director", humanDecided: true }),
  claim({ claimId: "c-people-advisory-undecided", claimKey: "people.key_contacts", advisory: true, humanDecided: false }),
  claim({ claimId: "c-people-advisory-decided", claimKey: "people.key_contacts", advisory: true, humanDecided: true }),
  claim({ claimId: "c-grants", claimKey: "funding.recent_grants", humanDecided: true }),
  claim({ claimId: "c-grants-undecided", claimKey: "funding.recent_grants", humanDecided: false }),
  claim({ claimId: "c-invitation", claimKey: "application.invitation_mechanism", humanDecided: true }),
  claim({ claimId: "c-denom", claimKey: "application.denominational_restriction", humanDecided: true }),
  claim({ claimId: "c-money", claimKey: "funding.total_annual_giving" }),
  claim({ claimId: "c-deadline", claimKey: "application.deadline" }),
];
const anchors = selectAnchorClaims(pool).map((c) => c.claimId);
ok("claims that name a person or organization are anchors", anchors.includes("c-people-verified") && anchors.includes("c-grants"));
ok("a claim about money or a deadline names nobody and is never handed over", !anchors.includes("c-money") && !anchors.includes("c-deadline"));
ok("an advisory claim no human decided is NOT an anchor; one a human decided is", !anchors.includes("c-people-advisory-undecided") && anchors.includes("c-people-advisory-decided"));
ok("the anchor key list is EXACTLY people.key_contacts and funding.recent_grants", JSON.stringify([...NETWORK_ANCHOR_CLAIM_KEYS]) === JSON.stringify(["people.key_contacts", "funding.recent_grants"]));
ok("invitation mechanism and denominational restriction are not anchors, even human-decided", !anchors.includes("c-invitation") && !anchors.includes("c-denom"));
ok("a claim with humanDecided false is excluded regardless of key or advisory flag", !anchors.includes("c-grants-undecided") && !anchors.includes("c-people-advisory-undecided") && selectAnchorClaims([claim({ claimId: "u", claimKey: "people.key_contacts", advisory: false, humanDecided: false })]).length === 0);
ok("the humanDecided requirement is unconditional in the function, not carried by the key list", /&&\s*c\.humanDecided\s*\)/.test(stripComments(read("lib/network.ts"))) && !/advisory/.test(stripComments(read("lib/network.ts")).slice(stripComments(read("lib/network.ts")).indexOf("export function selectAnchorClaims"), stripComments(read("lib/network.ts")).indexOf("export function anchorKindLabel"))));
{
  // Successor to "the cap is 150; 150 connections are accepted, 151 refused with the
  // count and the limit in plain words" (item 77's refusal, replaced by ruling 0040
  // clause 7): the limit is still 150, 150 people are considered whole, and 151 are
  // narrowed -- and the sentence states the counts and the limit instead of refusing.
  const mk = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      id: `p-${String(i).padStart(4, "0")}`,
      person_name: `Person ${i}`,
      affiliation: i === 0 ? "Riverbend Ministries" : null,
      how_known: null,
      notes: null,
      created_at: `2026-01-01T00:00:${String(i % 60).padStart(2, "0")}Z`,
    }));
  const claimsForLimit = [{ claim: "Riverbend Ministries received a grant." }];
  const at150 = shortlistConnections(mk(150), claimsForLimit);
  const at151 = shortlistConnections(mk(151), claimsForLimit);
  ok(
    "the limit is NETWORK_PATHS_MAX_CONSIDERED = 150; exactly 150 people are all considered (narrowed false), 151 are narrowed (narrowed true) -- no refusal at either",
    NETWORK_PATHS_MAX_CONSIDERED === 150 && at150.narrowed === false && at150.considered.length === 150 && at151.narrowed === true && at151.totalRecorded === 151
  );
  ok(
    "the narrowed sentence states X of Y and the limit in plain words (it replaces the old refusal's count-and-limit message)",
    /Considered 1 of 151 recorded people/.test(consideredSentence(at151)) && /150/.test(consideredSentence(at151)) && /not examined/.test(consideredSentence(at151))
  );
}
ok("no approved claims naming anybody yields an empty pool (the action then refuses without a model call)", selectAnchorClaims(pool.filter((c) => c.claimId === "c-money" || c.claimId === "c-deadline")).length === 0);

section("lib/network.ts: validateNetworkPaths -- an id outside the pool is discarded, never kept");
const conns = new Set(["k1", "k2"]);
const claims = new Set(["c1", "c2"]);
const good = { network_connection_id: "k1", funder_claim_id: "c1", reasoning: "Same congregation.", confidence: "medium" };
{
  const r = validateNetworkPaths([good], conns, claims);
  ok("a fully grounded path is kept", r.kept.length === 1 && r.discarded.length === 0 && r.kept[0].network_connection_id === "k1" && r.kept[0].funder_claim_id === "c1");
}
{
  const r = validateNetworkPaths([{ ...good, network_connection_id: "invented" }], conns, claims);
  ok("an unknown connection id is discarded (and reported so it can be logged)", r.kept.length === 0 && r.discarded.length === 1 && /network_connection_id/.test(r.discarded[0].reason));
}
{
  const r = validateNetworkPaths([{ ...good, funder_claim_id: "invented" }], conns, claims);
  ok("an unknown claim id is discarded", r.kept.length === 0 && r.discarded.length === 1 && /funder_claim_id/.test(r.discarded[0].reason));
}
{
  const r = validateNetworkPaths([{ ...good, network_connection_id: "c1", funder_claim_id: "k1" }], conns, claims);
  ok("ids swapped between the pools are discarded (each id must be in ITS pool)", r.kept.length === 0);
}
{
  const r = validateNetworkPaths([{ ...good, reasoning: "   " }], conns, claims);
  ok("a path with no reasoning is discarded", r.kept.length === 0 && r.discarded.length === 1);
}
{
  const r = validateNetworkPaths([{ ...good, confidence: "certain" }, { ...good, funder_claim_id: "c2", confidence: undefined }], conns, claims);
  ok("a confidence outside low/medium/high (or missing) discards the path", r.kept.length === 0 && r.discarded.length === 2);
}
{
  const r = validateNetworkPaths([good, { ...good, reasoning: "again" }], conns, claims);
  ok("a repeated connection-and-fact pair is kept once", r.kept.length === 1 && r.discarded.length === 1);
}
{
  const r = validateNetworkPaths([good, { network_connection_id: "zzz", funder_claim_id: "c2", reasoning: "r", confidence: "low" }, null, "junk"], conns, claims);
  ok("one bad path among good ones does not sink the good one; null and junk are discarded", r.kept.length === 1 && r.discarded.length === 3);
}
ok("zero paths is a valid answer: an empty list and a non-array both yield nothing kept and nothing discarded-as-error", validateNetworkPaths([], conns, claims).kept.length === 0 && validateNetworkPaths(undefined, conns, claims).kept.length === 0);

section("lib/network.ts: the tool schema and the grounding prompt");
const pathSchema = (NETWORK_PATHS_TOOL.input_schema.properties.paths as { items: { required: string[]; properties: Record<string, unknown> } }).items;
ok("the tool requires each path to carry network_connection_id, funder_claim_id, reasoning and confidence", JSON.stringify([...pathSchema.required].sort()) === JSON.stringify(["confidence", "funder_claim_id", "network_connection_id", "reasoning"]));
ok("the tool has no field for a contact detail or for message text", !Object.keys(pathSchema.properties).some((k) => /email|phone|message|draft|subject|body/.test(k)));
const prompt = buildNetworkPathPrompt({
  prospectName: "Test Funder",
  connections: [{ id: "k1", person_name: "Pat Example", affiliation: "First Church", how_known: "board", strength: "warm", notes: "sings in choir" }],
  claims: [{ claimId: "c1", claimKey: "people.key_contacts", claim: "Jane Doe, Executive Director" }],
});
ok("the prompt hands over ids for both pools and the recorded facts", prompt.includes("id: k1") && prompt.includes("id: c1") && prompt.includes("Pat Example") && prompt.includes("Jane Doe, Executive Director") && prompt.includes("sings in choir"));
ok("the prompt forbids inventing a person, affiliation or relationship", /Never invent a person, an affiliation/.test(prompt));
ok("the prompt says a same-name coincidence is low confidence at most", /name coincidence[\s\S]*"low" at most/.test(prompt));
ok("the prompt says zero paths is a valid answer", /Zero paths is a valid answer/.test(prompt));
ok("the prompt says a path citing an unknown id is discarded", /not in these lists is discarded/.test(prompt));
ok("the prompt forbids drafting outreach", /do not write outreach/i.test(prompt));

// --- 3. Source scans: the action --------------------------------------------

section("network-actions.ts: findNetworkPaths grounds, refuses early, births before the call");
const actionsRaw = read("app/(dashboard)/prospects/[id]/network-actions.ts");
const actions = stripComments(actionsRaw);
const findStart = actions.indexOf("export async function findNetworkPaths");
const decideStart = actions.indexOf("export async function decideNetworkPath");
const find = actions.slice(findStart, decideStart);
const decide = actions.slice(decideStart);
{
  // Successor to "the cap refusal precedes beginRun and the model call, and returns
  // rather than truncating" (item 77): the REFUSAL is gone (ruling 0040 clause 7);
  // what must still hold is that the read of everyone, the shortlist and the
  // empty-shortlist return all precede beginRun and the model call, and that the
  // action neither refuses on size nor slices the network itself (the stated rule
  // in lib/network-shortlist.ts is the only thing that narrows).
  const loadAt = find.indexOf("await loadAllConnections(");
  const shortlistAt = find.indexOf("shortlistConnections(");
  const emptyAt = find.indexOf("connections.length === 0");
  const beginAt = find.indexOf("await beginRun(");
  const modelAt = find.indexOf("anthropic.messages.create");
  ok(
    "the full read, the shortlist and the empty-shortlist return all precede beginRun and the model call",
    loadAt > 0 && loadAt < shortlistAt && shortlistAt < emptyAt && emptyAt < beginAt && beginAt < modelAt,
    `${loadAt}/${shortlistAt}/${emptyAt}/${beginAt}/${modelAt}`
  );
  ok("there is no size refusal and no slicing in the action: connectionCapRefusal is gone and nothing here slices, limits or ranges the network", !/connectionCapRefusal|capRefusal/.test(actions) && !/\.slice\(|\.limit\(|\.range\(/.test(find));
}
ok("both actions found", findStart > 0 && decideStart > findStart);
ok("research is read ONLY through loadApprovedIntelligence; research_claims is never queried here", find.includes("loadApprovedIntelligence(") && !/from\("research_claims"\)/.test(actions) && !/from\("research_runs"\)/.test(actions));
const at = (needle: string) => find.indexOf(needle);
const refuseIntel = at("if (!approved)");
const refuseAnchors = at("anchorClaims.length === 0");
const refuseConns = at("loaded.total === 0");
const born = at("await beginRun(");
const called = at("await anthropic.messages.create");
ok("every refusal (unresolved intelligence, no naming claims, no connections) precedes the ledger birth", refuseIntel > 0 && refuseAnchors > refuseIntel && refuseConns > refuseAnchors && born > refuseConns, `${refuseIntel}/${refuseAnchors}/${refuseConns}/${born}`);
ok("the run is BORN before the model call", born > 0 && called > born, `${born} vs ${called}`);
ok("each refusal returns an error (no throw) before any model call", /if \(!approved\) \{\s*return \{\s*error:/.test(find) && /anchorClaims\.length === 0\) \{\s*return \{\s*error:/.test(find) && /loaded\.total === 0\) \{\s*return \{ error:/.test(find));
ok("the operation is the LITERAL string network_paths, not a ternary", /operation: "network_paths"/.test(find) && !/operation:\s*[^"\s]/.test(find));
ok("network_paths is in AI_RUN_OPERATIONS", (AI_RUN_OPERATIONS as readonly string[]).includes("network_paths"));
ok("finalizeRun runs on success and on failure", (find.match(/finalizeRun\(/g) ?? []).length >= 2 && /outcome: "failed"/.test(find));
ok("model config follows the sibling actions: DRAFT_MODEL with a max_tokens", /model: DRAFT_MODEL/.test(find) && /max_tokens: 1500/.test(find));
ok("the model is forced through the submit_network_paths tool", /tool_choice: \{ type: "tool", name: NETWORK_PATHS_TOOL\.name \}/.test(find));
ok("the pools handed to the model are the pools ids are validated against", /connectionIds = new Set\(connections\.map/.test(find) && /claimIds = new Set\(anchorClaims\.map/.test(find) && /buildNetworkPathPrompt\(\{[^}]*connections[^}]*claims: anchorClaims/.test(find));
ok("every returned id is validated against both pools", /validateNetworkPaths\(rawPaths, connectionIds, claimIds\)/.test(find));
ok("a discarded path is LOGGED, not stored", /console\.log\(`\[network_paths\] discarded/.test(find));
ok("only validated paths are inserted (the insert maps over `fresh`, derived from `kept`)", /const fresh = kept\.filter/.test(find) && /insert\(\s*fresh\.map/.test(find) && !/toolUse\.input[^;]*\.insert/.test(find));
ok("a stored suggestion is never given a status: it takes the column default 'suggested'", !/status:/.test(find.slice(find.indexOf(".insert("))));
ok("the model's own text (reasoning, confidence) is the only model-typed data stored; ids are checked ids", /reasoning: p\.reasoning/.test(find) && /model_confidence: p\.confidence/.test(find));

section("network-actions.ts: accept / dismiss reach no send, draft or stage code");
const imports = actions.split("\n").filter((l) => /^\s*(import|\}\s*from)/.test(l) || /from "/.test(l)).join("\n");
ok("imports nothing from the send path, the drafting actions, the send actions or stage code", !/draft-send|draft-actions|send-actions|send-draft|lib\/prospects|resend|postmark|MoveStage|advance/i.test(imports), imports);
ok("decideNetworkPath updates network_path_suggestions and nothing else", (decide.match(/\.from\("/g) ?? []).length === 1 && /\.from\("network_path_suggestions"\)/.test(decide));
ok("it writes exactly status, decided_by (from the verified user) and decided_at", /\.update\(\{ status: decision, decided_by: user\.id, decided_at: new Date\(\)\.toISOString\(\) \}\)/.test(decide) && /const user = await requireUser\(\)/.test(decide));
ok("it only decides a path still 'suggested'", /\.eq\("status", "suggested"\)/.test(decide));
ok("it accepts only 'accepted' or 'dismissed'", /decision !== "accepted" && decision !== "dismissed"/.test(decide));
ok("neither action touches prospects, drafts, stage_changes or any send table", !/from\("(prospects|drafts|stage_changes|draft_send_attempts|interactions|contacts)"\)/.test(actions.replace(/from\("prospects"\)\.select\("id, name"\)/, "")));
ok("the only prospects access in the file is the read of id and name", (actions.match(/from\("prospects"\)/g) ?? []).length === 1 && /from\("prospects"\)\.select\("id, name"\)/.test(actions));

section("the Network page and its actions");
const netActions = stripComments(read("app/(dashboard)/network/actions.ts"));
ok("add / update / delete exist", /export async function addConnection/.test(netActions) && /export async function updateConnection/.test(netActions) && /export async function deleteConnection/.test(netActions));
ok("recorded_by comes from the verified session user, not the request", /recorded_by: user\.id/.test(netActions) && !/input\.recorded_by/.test(netActions));
ok("an omitted or unknown strength is refused, never defaulted", /isConnectionStrength\(input\.strength\)/.test(netActions) && !/strength: input\.strength \|\|/.test(netActions) && !/strength: "(close|warm|acquaintance)"/.test(netActions));
ok("no action here has a contact-detail field, an import, or a model call", !/email|phone|handle|import_|csv|vcard|anthropic/i.test(netActions.replace(/import [^\n]*\n/g, "")));
const workspace = stripComments(read("app/(dashboard)/network/network-workspace.tsx"));
ok("the form shows the clause-3 disclosure (imported from lib/network, rendered on the form)", /NETWORK_DISCLOSURE/.test(workspace) && /\{NETWORK_DISCLOSURE\}/.test(workspace));
ok("delete goes through a confirm dialog that warns derived paths go too", /ConfirmDialog/.test(workspace) && /introduction paths suggested through them will be deleted too/.test(workspace));
ok("the strength select has no preselected value", /strength: ""/.test(workspace) && /Choose one/.test(workspace));
ok("the page has no contact-detail input", !/name="(email|phone)"|type="(email|tel)"/i.test(workspace));
ok("the Network page reads no research table", !/research_/.test(stripComments(read("app/(dashboard)/network/page.tsx"))));
ok("layout adds a Network nav item to /network", /href: "\/network", label: "Network"/.test(read("app/(dashboard)/layout.tsx")) && /network: Network/.test(read("components/Sidebar.tsx")));

section("the prospect page panel");
const panel = read("app/(dashboard)/prospects/[id]/network-panel.tsx");
ok("titled 'Who can open this door' with a Find paths button", /Who can open this door/.test(panel) && /Find paths/.test(panel));
ok("each path shows the person, the anchoring fact, the reasoning, the AI's estimate label and Accept / Dismiss", /person\?\.person_name/.test(panel) && /anchor\.text/.test(panel) && /suggestion\.reasoning/.test(panel) && /AI&apos;s estimate/.test(panel) && />\s*Accept\s*</.test(panel) && />\s*Dismiss\s*</.test(panel));
ok("the anchor is shown as the claim's own text (name and role), never an id", !/funder_claim_id\}/.test(panel) && !/\{suggestion\.funder_claim_id/.test(panel));
ok("calm empty states name what is needed (record people; approve research)", /have not recorded anyone you know yet/.test(panel) && /Nothing approved about this funder names a person or an organization yet/.test(panel));
ok("the Find paths button is withheld unless both sides exist", /const canFind = !data\.unavailable && !missingConnections && !missingAnchors/.test(panel));
const pagePros = read("app/(dashboard)/prospects/[id]/page.tsx");
ok("the panel sits on the Strategy tab above the drafting panel", pagePros.indexOf("<NetworkPanel") > 0 && pagePros.indexOf("<NetworkPanel") < pagePros.indexOf("<DraftPanel"));
const panelLoader = stripComments(read("lib/network-panel.ts"));
ok("the panel loader reads research only through loadApprovedIntelligence", /loadApprovedIntelligence\(/.test(panelLoader) && !/research_claims/.test(panelLoader));
ok("the panel uses shared lib/ui tokens", /from "@\/lib\/ui"/.test(panel) && /from "@\/lib\/ui"/.test(read("app/(dashboard)/network/network-workspace.tsx")));

section("lib/prospect-intelligence.ts: the loader now carries claim ids");
const intel = read("lib/prospect-intelligence.ts");
ok("both ApprovedClaim push sites carry claimId and humanDecided", (intel.match(/claimId: c\.id as string,/g) ?? []).length === 2 && (intel.match(/humanDecided: !!decision,/g) ?? []).length === 2);

// ===========================================================================
// STATE item 103 -- narrowing instead of refusing (ruling 0040 clause 7)
// ===========================================================================

type P = { id: string; person_name: string; affiliation: string | null; how_known: string | null; notes: string | null; created_at: string };
const uuidOf = (n: number) => `20000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const iso = (i: number) => new Date(Date.UTC(2026, 0, 1) + i * 1000).toISOString();
const person = (i: number, over: Partial<P> = {}): P => ({ id: uuidOf(i + 1), person_name: `Filler ${i}`, affiliation: "Plain Org", how_known: null, notes: null, created_at: iso(i), ...over });
const fillers = (from: number, n: number): P[] => Array.from({ length: n }, (_, k) => person(from + k));
const ids = (ps: readonly { id: string }[]) => ps.map((p) => p.id);
const factClaims = [{ claim: "Jane Whitcombe, Executive Director" }, { claim: "Riverbend Heritage Alliance; Harvest Table Kitchen" }];

section("lib/network-shortlist.ts: the constants and the generic-word list are named data");
ok("the limit is NETWORK_PATHS_MAX_CONSIDERED = 150, the minimum shared word is 4 letters, the whole-name bonus outranks any word count", NETWORK_PATHS_MAX_CONSIDERED === 150 && MIN_SHARED_WORD_LENGTH === 4 && WHOLE_NAME_BONUS >= 1000);
ok("GENERIC_WORDS is a closed list of lowercase, de-duplicated words that includes the brief's: church, foundation, fund, trust, inc, llc, ltd, corp, company, group, ministries, ministry, international, national, global, association, society, university, college, school, center, centre, institute, community, board, member, director, president, pastor, chair, chairman, officer, executive, manager, the, and, of?, for, with, from",
  ["church", "foundation", "fund", "trust", "inc", "llc", "ltd", "corp", "company", "group", "ministries", "ministry", "international", "national", "global", "association", "society", "university", "college", "school", "center", "centre", "institute", "community", "board", "member", "director", "president", "pastor", "chair", "chairman", "officer", "executive", "manager", "the", "and", "for", "with", "from"].every((w) => GENERIC_WORDS.includes(w)) &&
    GENERIC_WORDS.every((w) => w === w.toLowerCase()) && new Set(GENERIC_WORDS).size === GENERIC_WORDS.length);
ok("tokenize lowercases, strips accents and splits on anything that is not a letter or digit", JSON.stringify(tokenize("José O'Neil-Smith, St. Mary's (2024)")) === JSON.stringify(["jose", "o", "neil", "smith", "st", "mary", "s", "2024"]));
ok("a distinctive word is 4+ letters, has a letter in it and is not generic: 'church' no, 'grace' yes, 'doe' no, '2024' no, 'cos7' yes", JSON.stringify([...distinctiveWords("Church Grace Doe 2024 Cos7 The Foundation")].sort()) === JSON.stringify(["cos7", "grace"]));
ok("the rule sentence is built from the constants (4 letters, 150 people, a full-name match first)", /4 or more letters/.test(shortlistRuleSentence()) && /150 people/.test(shortlistRuleSentence()) && /full-name match first/.test(shortlistRuleSentence()) && /"church", "foundation" or "director"/.test(shortlistRuleSentence()));

section("lib/network-shortlist.ts: at or under the limit, nothing is narrowed (identical to before)");
{
  const small = [person(0, { person_name: "Zed Last" }), person(1), person(2, { person_name: "Alpha First" })];
  const r = shortlistConnections(small, factClaims);
  ok("a small network: everyone considered, narrowed false, matched null, in the order given", r.narrowed === false && r.matched === null && JSON.stringify(ids(r.considered)) === JSON.stringify(ids(small)) && r.totalRecorded === 3);
  ok("... the considered list is the same objects, so the prompt handed to the model is byte-identical to the unnarrowed prompt", (() => {
    const claims = [{ claimId: "c1", claimKey: "people.key_contacts", claim: "Jane Whitcombe" }];
    const before = buildNetworkPathPrompt({ prospectName: "F", connections: small.map((p) => ({ ...p, strength: "warm" as const })), claims });
    const after = buildNetworkPathPrompt({ prospectName: "F", connections: r.considered.map((p) => ({ ...p, strength: "warm" as const })), claims });
    return before === after;
  })());
  const at = shortlistConnections(fillers(0, 150), factClaims);
  ok("exactly 150 people: all 150 considered, narrowed false (the boundary is inclusive)", at.narrowed === false && at.considered.length === 150);
  ok("... even when NONE of them shares a word with the funder (nothing is filtered below the limit)", at.considered.length === 150 && at.matched === null);
  const over = shortlistConnections([...fillers(0, 150), person(150, { affiliation: "Riverbend Heritage" })], factClaims);
  ok("151 people: narrowed true, and only the one sharing a word is considered (1 of 151)", over.narrowed === true && over.totalRecorded === 151 && over.considered.length === 1 && over.considered[0].id === uuidOf(151) && over.matched === 1);
  ok("shortlistConnections does not mutate its input", (() => { const input = [...fillers(0, 151)]; const copy = JSON.stringify(input); shortlistConnections(input, factClaims); return JSON.stringify(input) === copy; })());
}

section("lib/network-shortlist.ts: what shortlists a person, and what does not");
{
  const pad = fillers(1000, 151);
  const run = (p: P) => ids(shortlistConnections([...pad, p], [{ claim: "Grace Community Church Foundation, board member Riverbend 2024" }]).considered).includes(p.id);
  ok("a GENERIC word alone does not shortlist (Community, Church, Foundation, First all shared; nothing distinctive)", !run(person(5000, { person_name: "Pat Roe", affiliation: "First Community Church Foundation" })));
  ok("a DISTINCTIVE word does (affiliation shares 'riverbend')", run(person(5001, { person_name: "Pat Roe", affiliation: "Riverbend Fellowship" })));
  ok("a distinctive word in the how-known text shortlists", run(person(5002, { how_known: "We met through the Riverbend choir" })));
  ok("a distinctive word in the notes shortlists", run(person(5003, { notes: "Mentioned Grace in passing" })));
  ok("a distinctive word in the NAME shortlists (ruling 0040 clause 7 names the name)", run(person(5004, { person_name: "Riverbend Smith" })));
  ok("a word under four letters never shortlists, even when shared exactly ('Zed')", !run(person(5005, { person_name: "Zed Roe", affiliation: "Zed" })) && !ShortSharedFixture());
  ok("a bare number never shortlists (a shared year '2024' is not a shared word)", !run(person(5006, { notes: "Met in 2024" })));
  ok("matching ignores case and accents ('RIVERBEND', 'Ríverbend')", run(person(5007, { affiliation: "RIVERBEND" })) && run(person(5008, { affiliation: "Ríverbend" })));
  ok("a substring is not a match: 'Riverbendix' does not share 'riverbend'; whole words only (token containment, not fuzzy similarity)", !run(person(5009, { affiliation: "Riverbendix" })));
  function ShortSharedFixture() {
    return ids(shortlistConnections([...pad, person(5010, { person_name: "Zed", affiliation: "Zed" })], [{ claim: "Zed Corp" }]).considered).length > 0;
  }
}

section("lib/network-shortlist.ts: ranking -- a whole name outranks any affiliation word; ties break deterministically");
{
  const pad = fillers(1000, 160);
  const A = person(1, { person_name: "Jane Whitcombe", affiliation: null });
  const B = person(2, { person_name: "Pat Roe", affiliation: "Riverbend Heritage Harvest Alliance" });
  const C = person(3, { person_name: "Sam Lee", notes: "volunteers at Riverbend" });
  const D = person(0, { person_name: "Dee Ray", notes: "Harvest" }); // same score as C, created earlier
  const E = person(3, { id: uuidOf(0), person_name: "Eli Fox", notes: "Riverbend" }); // same score AND created_at as C: id decides
  const r = shortlistConnections([...pad, C, B, E, D, A], factClaims);
  ok("whole-name containment (Jane Whitcombe) ranks ABOVE a person sharing THREE affiliation words (more than the two words of the name)", r.considered[0].id === A.id && r.considered[1].id === B.id, JSON.stringify(r.considered.map((p) => p.person_name)));
  ok("score is the number of distinct shared words: three shared words (B) outrank one (C, D, E)", r.considered.slice(1, 2)[0].id === B.id && r.considered.slice(2).every((p) => [C.id, D.id, E.id].includes(p.id)));
  ok("equal scores: earlier created_at first, then id (D created earliest; E and C share created_at and E's id sorts first)", JSON.stringify(r.considered.slice(2).map((p) => p.person_name)) === JSON.stringify(["Dee Ray", "Eli Fox", "Sam Lee"]), JSON.stringify(r.considered.map((p) => p.person_name)));
  ok("a single-word name that appears in a fact scores as a word match, not as a whole-name match", (() => {
    const solo = person(9, { person_name: "Whitcombe", affiliation: null });
    const rr = shortlistConnections([...pad, B, solo], factClaims);
    return rr.considered[0].id === B.id && rr.considered[1].id === solo.id;
  })());
  ok("titles do not defeat a whole-name match ('Dr. Jane Whitcombe' still contains Jane Whitcombe)", shortlistConnections([...pad, person(8, { person_name: "Dr. Jane Whitcombe, Jr." }), B], factClaims).considered[0].person_name === "Dr. Jane Whitcombe, Jr.");
}

section("lib/network-shortlist.ts: determinism, stated cut, speed at 1,500 people");
{
  const crowd: P[] = [
    ...fillers(0, 1300),
    ...Array.from({ length: 200 }, (_, k) => person(2000 + k, { affiliation: "Riverbend Heritage Alliance" })),
    person(3000, { person_name: "Jane Whitcombe", affiliation: null }),
  ];
  const a = shortlistConnections(crowd, factClaims);
  const b = shortlistConnections(crowd, factClaims);
  ok("the same input twice gives the same shortlist in the same order", JSON.stringify(ids(a.considered)) === JSON.stringify(ids(b.considered)));
  const shuffled = [...crowd].sort((x, y) => (x.id.split("").reverse().join("") < y.id.split("").reverse().join("") ? -1 : 1));
  ok("the input in a different order gives the SAME shortlist in the same order (nothing depends on arrival order)", JSON.stringify(ids(shortlistConnections(shuffled, factClaims).considered)) === JSON.stringify(ids(a.considered)));
  ok("1,501 people: the model is never handed more than the limit (150), the whole-name match is first, and the cut is stated (201 matched)", a.considered.length === 150 && a.narrowed && a.matched === 201 && a.considered[0].person_name === "Jane Whitcombe" && a.totalRecorded === 1501);
  const started = Date.now();
  for (let i = 0; i < 20; i++) shortlistConnections(crowd, factClaims);
  const per = (Date.now() - started) / 20;
  ok(`a 1,501-person fixture shortlists quickly (${per.toFixed(1)} ms per look; under 250 ms)`, per < 250, `${per} ms`);
  ok("the sentence states X of Y, the rule, the cut and that those left out were not examined", /Considered 150 of 1501 recorded people \(/.test(consideredSentence(a)) && /201 people shared such a word, so only the 150 sharing the most were considered/.test(consideredSentence(a)) && /not a judgement about them/.test(consideredSentence(a)) && consideredSentence(a).includes(a.rule));
  ok("no cut clause when everyone who matched fits", !/shared such a word/.test(consideredSentence(shortlistConnections([...fillers(0, 200), person(900, { affiliation: "Riverbend" })], factClaims))));
}

section("lib/network-shortlist.ts: the user-facing wording");
{
  const narrowed = shortlistConnections([...fillers(0, 200), person(900, { affiliation: "Riverbend" })], factClaims);
  const whole = shortlistConnections(fillers(0, 12), factClaims);
  ok("no path found reads 'none found among those considered' with X of Y -- never 'none exist'", (() => { const m = pathsOutcomeMessage({ stored: 0, alreadyKnown: 0, shortlist: narrowed }); return /none found among those considered/.test(m) && /Considered 1 of 201 recorded people/.test(m) && !/none exist|no one exists|does not exist/i.test(m); })());
  ok("... and the same words on a small network that was not narrowed (it is still only 'those considered')", (() => { const m = pathsOutcomeMessage({ stored: 0, alreadyKnown: 0, shortlist: whole }); return /none found among those considered/.test(m) && /Considered 12 of 12 recorded people/.test(m); })());
  ok("found paths: the count, 'among those considered' and X of Y", /Found 2 possible paths among those considered/.test(pathsOutcomeMessage({ stored: 2, alreadyKnown: 0, shortlist: narrowed })) && /Considered 1 of 201/.test(pathsOutcomeMessage({ stored: 2, alreadyKnown: 0, shortlist: narrowed })));
  ok("already-known paths keep their wording and still state the counts", /already listed below/.test(pathsOutcomeMessage({ stored: 0, alreadyKnown: 1, shortlist: narrowed })) && /Considered 1 of 201/.test(pathsOutcomeMessage({ stored: 0, alreadyKnown: 1, shortlist: narrowed })));
  const empty = emptyShortlistMessage({ totalRecorded: 1500, rule: shortlistRuleSentence() });
  ok("an empty shortlist's message: 'Considered 0 of 1500', none share a distinctive word, none examined, the AI was not asked, and how to widen it", /Considered 0 of 1500 recorded people/.test(empty) && /None of your 1500 recorded people share a distinctive word/.test(empty) && /none were examined/.test(empty) && /AI was not asked/.test(empty) && /approve more of this funder's facts on the Research tab/.test(empty) && /add affiliation and how-you-know-them detail/.test(empty));
}

section("lib/network.ts + the action: id validation uses the CONSIDERED pool");
{
  const crowd = [...fillers(0, 300), person(900, { affiliation: "Riverbend" }), person(901, { affiliation: "Riverbend" })];
  const sl = shortlistConnections(crowd, factClaims);
  const pool = new Set(ids(sl.considered));
  const excluded = crowd.find((p) => !pool.has(p.id))!;
  const r = validateNetworkPaths(
    [
      { network_connection_id: sl.considered[0].id, funder_claim_id: "c1", reasoning: "Same body.", confidence: "medium" },
      { network_connection_id: excluded.id, funder_claim_id: "c1", reasoning: "Cites someone never shortlisted.", confidence: "high" },
    ],
    pool,
    new Set(["c1"])
  );
  ok("a path citing a person who was not shortlisted is discarded (and reported for logging), exactly like any id outside the pool", r.kept.length === 1 && r.discarded.length === 1 && /network_connection_id/.test(r.discarded[0].reason));
}

section("source: lib/network-shortlist.ts is pure and the action only narrows through it");
{
  const sl = stripComments(read("lib/network-shortlist.ts"));
  ok("the shortlist module imports no database, model or framework code (only a type from lib/network)", (sl.match(/^import .*$/gm) ?? []).every((l) => /^import type \{ NetworkConnection \} from "@\/lib\/network";$/.test(l)), (sl.match(/^import .*$/gm) ?? []).join(" | "));
  ok("... and uses no randomness, clock or database (Math.random, Date.now, new Date, fetch, supabase)", !/Math\.random|Date\.now|new Date\(|fetch\(|supabase/i.test(sl));
  ok("the sort has no tiebreak but created_at then id (fully deterministic)", /b\.score - a\.score \|\| a\.at - b\.at \|\| \(a\.person\.id < b\.person\.id/.test(sl));
  const act = stripComments(read("app/(dashboard)/prospects/[id]/network-actions.ts"));
  ok("the action hands the model ONLY shortlist.considered (connections = shortlist.considered) and builds both id pools from it", /const connections = shortlist\.considered;/.test(act) && /connectionIds = new Set\(connections\.map/.test(act) && !/loaded\.connections[^;]*buildNetworkPathPrompt/.test(act));
  ok("an empty shortlist returns BEFORE beginRun: its return statement precedes the ledger birth in source order", act.indexOf("connections.length === 0") > 0 && act.indexOf("connections.length === 0") < act.indexOf("await beginRun("));
  ok("the old fixed-number refusal is gone from lib/network.ts", !/connectionCapRefusal|NETWORK_PATHS_MAX_CONNECTIONS/.test(stripComments(read("lib/network.ts"))));
}

async function actionTests() {
  section("findNetworkPaths, the REAL action, against a fake client and a fake model");
  const S = makeStubber(root);
  process.env.ANTHROPIC_API_KEY ||= "test-key";
  let db = new FakeNetDb();
  const approved = {
    researchRunId: "90000000-0000-4000-8000-000000000001",
    version: 1,
    confirmedEin: null,
    withheld: [],
    claims: [
      { claimId: "c-people", humanDecided: true, claimKey: "people.key_contacts", claim: "Jane Whitcombe, Executive Director", reportingPeriod: null, advisory: false, limitation: null, humanOverride: false, overrideNote: null, sources: [] },
      { claimId: "c-grants", humanDecided: true, claimKey: "funding.recent_grants", claim: "Riverbend Heritage Alliance; Harvest Table Kitchen", reportingPeriod: null, advisory: false, limitation: null, humanOverride: false, overrideNote: null, sources: [] },
    ],
  };
  let approvedNow: typeof approved | null = approved;
  let modelCalls: { params: any }[] = []; // eslint-disable-line @typescript-eslint/no-explicit-any
  let modelPaths: () => unknown[] = () => [];
  const serverPath = S.resolve("lib/supabase/server.ts");
  const intelPath = S.resolve("lib/prospect-intelligence.ts");
  const anthropicPath = S.resolve("lib/ai/anthropic.ts");
  const actionPath = S.resolve("app/(dashboard)/prospects/[id]/network-actions.ts");
  const realIntel = require(intelPath);
  const { anthropic } = require(anthropicPath) as { anthropic: { messages: { create: unknown } } };
  const realCreate = anthropic.messages.create;
  S.stub(serverPath, { createClient: () => db });
  S.stub(require.resolve("next/cache"), { revalidatePath() {} });
  S.stub(intelPath, { ...realIntel, loadApprovedIntelligence: async () => approvedNow });
  (anthropic.messages as { create: unknown }).create = async (params: unknown) => {
    modelCalls.push({ params });
    return { model: "claude-test", usage: { input_tokens: 10, output_tokens: 5 }, content: [{ type: "tool_use", input: { paths: modelPaths() } }] };
  };
  S.forget(S.resolve("lib/auth.ts"));
  S.forget(actionPath);
  S.forget(S.resolve("lib/network-store.ts"));

  const fullRow = (p: P) => ({ ...p, organization_id: ORG_ID, recorded_by: USER_ID, strength: "warm", updated_at: p.created_at });
  const world = (people: P[]) => {
    db = new FakeNetDb();
    db.seed("prospects", [{ id: "prospect-1", name: "Test Funder" }]);
    db.seed("network_connections", people.map(fullRow));
    modelCalls = [];
    modelPaths = () => [];
    approvedNow = approved;
    return db;
  };
  const connectionCount = (prompt: string) => (prompt.match(/\n {2}affiliation: /g) ?? []).length;

  try {
    const find = (require(actionPath) as { findNetworkPaths: (id: string) => Promise<any> }).findNetworkPaths; // eslint-disable-line @typescript-eslint/no-explicit-any

    // ---- a small network: nothing is narrowed ----
    {
      const people = [person(0, { person_name: "Anna One" }), person(1, { person_name: "Ben Two", affiliation: "Riverbend" }), person(2, { person_name: "Cy Three" })];
      const d = world(people);
      modelPaths = () => [{ network_connection_id: uuidOf(2), funder_claim_id: "c-grants", reasoning: "Both name Riverbend.", confidence: "medium" }];
      const r = await find("prospect-1");
      const prompt = modelCalls[0].params.messages[0].content as string;
      const ordered = [...people].sort((a, b) => (a.created_at < b.created_at ? 1 : -1)); // updated_at desc, as the action reads them
      const expected = buildNetworkPathPrompt({ prospectName: "Test Funder", connections: ordered.map((p) => ({ ...p, strength: "warm" as const })), claims: approved.claims });
      ok("a small network: the model is called once with EVERY person, and the prompt is byte-identical to the one built from the whole list", "success" in r && modelCalls.length === 1 && prompt === expected);
      ok("... the result says narrowed false, 3 of 3 considered, and stored the one path", r.narrowed === false && r.considered === 3 && r.totalRecorded === 3 && r.stored === 1 && /Considered 3 of 3 recorded people/.test(r.message));
      ok("... the run was born in the ledger before the call and finalized completed", d.logOf("ai_runs", "insert").length === 1 && d.rows("ai_runs")[0].outcome === "completed");
    }

    // ---- a large network: narrowed, full read, excluded id discarded ----
    {
      const crowd: P[] = [
        person(0, { person_name: "Jane Whitcombe", affiliation: null }), // oldest: last in the updated_at-desc read, beyond row 1000
        ...Array.from({ length: 199 }, (_, k) => person(1 + k, { affiliation: "Riverbend Heritage Alliance" })),
        ...fillers(200, 1300),
      ];
      const d = world(crowd);
      const excludedAmongMatched = uuidOf(181 + 1); // person(181): matched but cut by the limit
      const neverMatched = uuidOf(900 + 1);
      modelPaths = () => [
        { network_connection_id: uuidOf(1), funder_claim_id: "c-people", reasoning: "Same person.", confidence: "high" },
        { network_connection_id: uuidOf(11), funder_claim_id: "c-grants", reasoning: "Same body.", confidence: "medium" },
        { network_connection_id: excludedAmongMatched, funder_claim_id: "c-grants", reasoning: "Cites a matched person cut by the limit.", confidence: "high" },
        { network_connection_id: neverMatched, funder_claim_id: "c-grants", reasoning: "Cites a person who shared no word.", confidence: "high" },
      ];
      const r = await find("prospect-1");
      const prompt = modelCalls[0]?.params.messages[0].content as string;
      ok("1,500 recorded people: the whole list was read (more than 1000 rows; ranged pages after an exact count)", d.log.filter((l) => l.table === "network_connections" && l.op === "select" && l.range).length === 2 && d.log.some((l) => l.table === "network_connections" && l.head === true));
      ok("... the model is handed exactly 150 people, never the whole network", "success" in r && modelCalls.length === 1 && connectionCount(prompt) === 150, `${connectionCount(prompt)} connections in prompt`);
      ok("... the person who is oldest in the list (beyond the 1000-row limit) and whose WHOLE NAME is in an approved fact is considered, which proves the read was complete", prompt.includes(`id: ${uuidOf(1)}`));
      ok("... a person who shares no word with the funder's facts was never sent (their id is not in the prompt)", !prompt.includes(neverMatched) && !prompt.includes("Filler 700"));
      ok("... a matched person cut by the limit was not sent either", !prompt.includes(`id: ${excludedAmongMatched}`));
      ok("the paths citing a person who was NOT shortlisted are discarded (2) and the two grounded paths are stored (2); nothing citing an excluded person reaches the table", r.stored === 2 && r.discarded === 2 && d.rows("network_path_suggestions").every((s) => s.network_connection_id !== excludedAmongMatched && s.network_connection_id !== neverMatched) && d.rows("network_path_suggestions").length === 2, JSON.stringify(r));
      ok("the result states X of Y and the rule, the cut (200 shared a word, 150 considered), and that the rest were not examined", r.narrowed === true && r.considered === 150 && r.totalRecorded === 1500 && r.matched === 200 && /Considered 150 of 1500 recorded people/.test(r.message) && /200 people shared such a word, so only the 150/.test(r.message) && r.message.includes(r.rule) && /not examined/.test(r.message), r.message);
      ok("the grounding rules in the prompt are unchanged by narrowing (same text as buildNetworkPathPrompt's)", prompt.includes("Never invent a person, an affiliation") && prompt.includes("Zero paths is a valid answer"));
    }

    // ---- an empty shortlist: no model call, no ledger birth ----
    {
      const d = world(fillers(0, 1500));
      const r = await find("prospect-1");
      ok("an empty shortlist makes NO model call", "success" in r && modelCalls.length === 0);
      ok("... and writes NO ledger row: ai_runs is never touched (not an AI operation)", d.log.every((l) => l.table !== "ai_runs") && d.rows("ai_runs").length === 0);
      ok("... and stores nothing: no path-suggestion write either", d.log.every((l) => l.table !== "network_path_suggestions"));
      ok("... the result says none of the 1500 share a distinctive word, so none were examined, with Considered 0 of 1500 and how to widen it", r.examined === false && r.considered === 0 && r.totalRecorded === 1500 && /Considered 0 of 1500 recorded people/.test(r.message) && /none were examined/.test(r.message) && /approve more of this funder's facts/.test(r.message), r.message);
    }

    // ---- the model finds nothing ----
    {
      const d = world([person(0, { person_name: "Anna One" }), person(1, { person_name: "Ben Two" })]);
      modelPaths = () => [];
      const r = await find("prospect-1");
      ok("when the model proposes nothing, the result reads 'none found among those considered' (never 'none exist'), and the run is finalized 'empty'", /none found among those considered/.test(r.message) && !/none exist/i.test(r.message) && d.rows("ai_runs")[0].outcome === "empty", r.message);
    }

    // ---- the refusals that precede the ledger, in their old order ----
    {
      let d = world(fillers(0, 5));
      approvedNow = null;
      const r1 = await find("prospect-1");
      ok("unresolved funder identity: refused with an error, before the network is even read and with no ledger row", "error" in r1 && /confirm the organization's identity/.test(r1.error) && d.log.every((l) => l.table === "prospects") && modelCalls.length === 0);
      d = world(fillers(0, 5));
      approvedNow = { ...approved, claims: [] };
      const r2 = await find("prospect-1");
      ok("no approved fact naming anybody: refused, no ledger row, no model call", "error" in r2 && /names a person or an organization/.test(r2.error) && d.rows("ai_runs").length === 0 && modelCalls.length === 0);
      d = world([]);
      const r3 = await find("prospect-1");
      ok("nobody recorded: refused with the old message, no ledger row, no model call", "error" in r3 && /have not recorded anyone/.test(r3.error) && d.rows("ai_runs").length === 0 && modelCalls.length === 0);
      d = world(fillers(0, 5));
      const r4 = await find("no-such-prospect");
      ok("unknown prospect: refused first", "error" in r4 && /Prospect not found/.test(r4.error));
    }
  } finally {
    (anthropic.messages as { create: unknown }).create = realCreate;
    S.restore();
  }
}

actionTests()
  .catch((e) => {
    console.error(e);
    fail++;
  })
  .finally(() => {
    console.log(`\n${pass} passed, ${fail} failed.`);
    process.exit(fail > 0 ? 1 : 0);
  });
