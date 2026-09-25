// STATE item 76 -- network capture v1 (ruling 0033). Offline: migration 0077's
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
ok("0077 exists and is the highest-numbered migration", !!file && migrations[migrations.length - 1] === file, `last: ${migrations[migrations.length - 1]}`);
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
  claim({ claimId: "c-people-verified", claimKey: "people.key_contacts", claim: "Jane Doe, Executive Director" }),
  claim({ claimId: "c-people-advisory-undecided", claimKey: "people.key_contacts", advisory: true, humanDecided: false }),
  claim({ claimId: "c-people-advisory-decided", claimKey: "people.key_contacts", advisory: true, humanDecided: true }),
  claim({ claimId: "c-grants", claimKey: "funding.recent_grants" }),
  claim({ claimId: "c-money", claimKey: "funding.total_annual_giving" }),
  claim({ claimId: "c-deadline", claimKey: "application.deadline" }),
];
const anchors = selectAnchorClaims(pool).map((c) => c.claimId);
ok("claims that name a person or organization are anchors", anchors.includes("c-people-verified") && anchors.includes("c-grants"));
ok("a claim about money or a deadline names nobody and is never handed over", !anchors.includes("c-money") && !anchors.includes("c-deadline"));
ok("an advisory claim no human decided is NOT an anchor; one a human decided is", !anchors.includes("c-people-advisory-undecided") && anchors.includes("c-people-advisory-decided"));
ok("the anchor key list includes people.key_contacts", NETWORK_ANCHOR_CLAIM_KEYS.includes("people.key_contacts"));
ok("no approved claims naming anybody yields an empty pool (the action then refuses without a model call)", selectAnchorClaims([pool[4], pool[5]]).length === 0);

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
ok("both actions found", findStart > 0 && decideStart > findStart);
ok("research is read ONLY through loadApprovedIntelligence; research_claims is never queried here", find.includes("loadApprovedIntelligence(") && !/from\("research_claims"\)/.test(actions) && !/from\("research_runs"\)/.test(actions));
const at = (needle: string) => find.indexOf(needle);
const refuseIntel = at("if (!approved)");
const refuseAnchors = at("anchorClaims.length === 0");
const refuseConns = at("connections.length === 0");
const born = at("await beginRun(");
const called = at("await anthropic.messages.create");
ok("every refusal (unresolved intelligence, no naming claims, no connections) precedes the ledger birth", refuseIntel > 0 && refuseAnchors > refuseIntel && refuseConns > refuseAnchors && born > refuseConns, `${refuseIntel}/${refuseAnchors}/${refuseConns}/${born}`);
ok("the run is BORN before the model call", born > 0 && called > born, `${born} vs ${called}`);
ok("each refusal returns an error (no throw) before any model call", /if \(!approved\) \{\s*return \{\s*error:/.test(find) && /anchorClaims\.length === 0\) \{\s*return \{\s*error:/.test(find) && /connections\.length === 0\) \{\s*return \{ error:/.test(find));
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

console.log(`\n${pass} passed, ${fail} failed.`);
process.exit(fail > 0 ? 1 : 0);
