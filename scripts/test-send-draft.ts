// Ruling 0029: one send path, born behind one human click. This file
// asserts the five clauses four ways:
//
//   1. Statically, by reading migration 0069 and asserting the schema
//      encodes the ruling: additive-only, org-scoped with RLS, no delete
//      policy, an outcome vocabulary with NO 'unconfirmed' value (an
//      attempt whose provider response never arrived is a born row whose
//      outcome stays null -- absence is the encoding), one-live-attempt
//      and one-sent-attempt partial unique indexes, birth preconditions,
//      terminal-written-once, and sent-facts-written-once on drafts.
//
//   2. By closed-set scan (the test-ai-runs pattern, which is ruling
//      0029's own test of compliance): exactly ONE module under app/ or
//      lib/ imports or calls the Resend provider (lib/send-draft.ts), and
//      exactly ONE file imports that module (the confirmed-send handler).
//      The teammate-invite path (lib/invite.ts) is not that module and
//      touches no part of it. A second send call or a second importer
//      anywhere fails this suite.
//
//   3. By source assertions on the handler: re-verification happens at
//      send time (draft re-read, then evaluateSendReadiness), the attempt
//      row is born BEFORE the provider call, the interaction row is built
//      from the SAME payload object that was sent, and the unconfirmed
//      branch finalizes nothing (attempted-unconfirmed stands).
//
//   4. By pure logic, running evaluateSendReadiness (the ONE function
//      that builds the payload, shared by the confirmation UI and the
//      handler -- which is why confirmation payload = send payload by
//      construction) across every precondition combination.
//
// Parts 1-4 are pure logic plus file reads -- no DB, no API key, and no
// mail is ever sent by this test (nothing here imports lib/send-draft).
//
// A fifth, DB-dependent section exercises the real schema (birth
// preconditions, one live attempt, terminal once, the drafts mirror
// check, undeletable send history) and needs env:
//
//   npx tsx --env-file=.env.local scripts/test-send-draft.ts
//
// Without env it skips cleanly and says so. With env but WITHOUT
// migration 0069 applied, it reports NOT EVALUATED rather than pretending
// to pass -- "not evaluated" and "evaluated and clean" are different facts.
//
// Usage (offline): npx tsx scripts/test-send-draft.ts

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { evaluateSendReadiness, buildInteractionSummary, type DraftSendAttempt } from "../lib/draft-send";

const root = join(__dirname, "..");

let pass = 0;
let fail = 0;
const notEvaluated: string[] = [];
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
function section(t: string) {
  console.log(`\n--- ${t} ---`);
}

// --- 1. The migration encodes the ruling ----------------------------------

section("migration 0069 is additive and encodes ruling 0029 in the schema");

const sql = readFileSync(join(root, "supabase/migrations/0069_draft_send.sql"), "utf8");
// Statements only -- the header legitimately DISCUSSES what must not exist.
const stmts = sql
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .toLowerCase();

const alterTargets = [...stmts.matchAll(/alter\s+table\s+([a-z_]+)/g)].map((m) => m[1]);
ok(
  "every ALTER TABLE targets drafts or draft_send_attempts and nothing else (ruling 0020: additive)",
  alterTargets.length > 0 && alterTargets.every((t) => t === "drafts" || t === "draft_send_attempts"),
  `alter targets: ${alterTargets.join(", ")}`
);
ok("no DROP of any kind", !/\bdrop\b/.test(stmts));
const addColumns = [...stmts.matchAll(/add\s+column\s+([a-z_]+)\s+([a-z]+)/g)].map((m) => m[1]).sort();
ok(
  "the only ADD COLUMNs are the three nullable send facts on drafts",
  JSON.stringify(addColumns) === JSON.stringify(["resend_message_id", "sent_at", "sent_by"]),
  `added: ${addColumns.join(", ")}`
);
ok(
  "none of the added columns is NOT NULL (nullable by spec -- a draft that was never sent is the normal case)",
  ![...stmts.matchAll(/add\s+column[^,;]*/g)].some((m) => /not\s+null/.test(m[0]))
);
ok(
  "creates exactly one table, draft_send_attempts",
  (stmts.match(/create\s+table/g) ?? []).length === 1 && /create\s+table\s+draft_send_attempts/.test(stmts)
);
ok(
  "draft_send_attempts is org-scoped: organization_id not null references organizations default my_organization_id() (hard rule 6)",
  /organization_id\s+uuid\s+not\s+null\s+references\s+organizations\s*\(id\)\s+default\s+my_organization_id\(\)/.test(stmts)
);
ok("row level security is enabled on draft_send_attempts", /alter\s+table\s+draft_send_attempts\s+enable\s+row\s+level\s+security/.test(stmts));

ok(
  "the attempt's FK to drafts has NO cascade -- a draft with send history cannot be deleted (sent facts never cleared)",
  /draft_id\s+uuid\s+not\s+null\s+references\s+drafts\s*\(id\)\s*,/.test(stmts) && !/references\s+drafts\s*\(id\)[^,]*cascade/.test(stmts)
);

// The outcome vocabulary, read from the constraint itself.
const outcomeCheck = stmts.match(/draft_send_attempts_outcome_check\s+check\s*\(outcome\s+in\s*\(([^)]*)\)\)/);
const allowedOutcomes = (outcomeCheck?.[1] ?? "")
  .split(",")
  .map((s) => s.trim().replace(/'/g, ""))
  .filter(Boolean)
  .sort();
ok(
  "outcome check allows exactly failed | sent",
  JSON.stringify(allowedOutcomes) === JSON.stringify(["failed", "sent"]),
  `allowed: ${allowedOutcomes.join(", ")}`
);
const storableStmts = stmts.replace(/comment\s+on[\s\S]*?;/g, "");
ok("there is NO 'unconfirmed' value anywhere a statement could store one -- absence is the encoding (clause 4)", !/'unconfirmed'/.test(storableStmts));
ok(
  "completed_at cannot exist without an outcome, and an unfinalized row carries no terminal fact at all",
  /outcome\s+is\s+null\s+and\s+completed_at\s+is\s+null\s+and\s+error_note\s+is\s+null\s+and\s+resend_message_id\s+is\s+null/.test(stmts)
);
ok(
  "the provider message id exists exactly on a 'sent' outcome (captured, not asserted)",
  /outcome\s*=\s*'sent'\s+and\s+resend_message_id\s+is\s+not\s+null/.test(stmts) && /outcome\s*=\s*'failed'\s+and\s+resend_message_id\s+is\s+null/.test(stmts)
);

// Once-only under concurrency (clause 3): the two partial unique indexes.
ok(
  "at most ONE live attempt per draft (partial unique index where outcome is null)",
  /create\s+unique\s+index\s+draft_send_attempts_one_live_idx\s+on\s+draft_send_attempts\s*\(draft_id\)\s+where\s+outcome\s+is\s+null/.test(stmts)
);
ok(
  "at most ONE confirmed send per draft (partial unique index where outcome = 'sent')",
  /create\s+unique\s+index\s+draft_send_attempts_one_sent_idx\s+on\s+draft_send_attempts\s*\(draft_id\)\s+where\s+outcome\s*=\s*'sent'/.test(stmts)
);

// Policies on the new table: insert + select + update, NO delete.
const attemptsPolicyBlock = stmts.slice(stmts.indexOf("draft_send_attempts enable row level security"));
const policyKinds = [...attemptsPolicyBlock.matchAll(/for\s+(insert|select|update|delete)/g)].map((m) => m[1]).sort();
ok(
  "attempt policies are insert + select + update, and there is NO delete policy (a send record is retained)",
  JSON.stringify(policyKinds) === JSON.stringify(["insert", "select", "update"]),
  `policies: ${policyKinds.join(", ")}`
);
ok(
  "the update policy's USING gates on outcome is null -- session clients can only finalize unfinalized attempts",
  /for\s+update[\s\S]*?using\s*\(organization_id\s*=\s*my_organization_id\(\)\s+and\s+outcome\s+is\s+null\)/.test(attemptsPolicyBlock)
);
ok(
  "the insert policy requires attempted_by = auth.uid() -- a send confirmation names its real author",
  /for\s+insert[\s\S]*?with\s+check\s*\(attempted_by\s*=\s*auth\.uid\(\)\s+and\s+organization_id\s*=\s*my_organization_id\(\)\)/.test(attemptsPolicyBlock)
);

// Triggers: birth preconditions, terminal-once, and the drafts mirror.
ok(
  "a BEFORE INSERT trigger enforces birth preconditions: approved draft, never sent, no live/confirmed attempt, born unfinalized (clauses 2-4)",
  /create\s+trigger\s+draft_send_attempts_birth\s+before\s+insert\s+on\s+draft_send_attempts/.test(stmts) &&
    /d\.status\s*<>\s*'approved'/.test(stmts) &&
    /d\.sent_at\s+is\s+not\s+null/.test(stmts) &&
    /outcome\s*=\s*'sent'\s+or\s+outcome\s+is\s+null/.test(stmts) &&
    /new\.outcome\s+is\s+not\s+null\s+or\s+new\.completed_at\s+is\s+not\s+null/.test(stmts)
);
ok(
  "the birth trigger enforces org-match against the referenced draft (0066's pattern)",
  /d\.organization_id\s+is\s+distinct\s+from\s+new\.organization_id/.test(stmts)
);
ok(
  "a BEFORE UPDATE trigger enforces terminal-written-once on attempts, for every role, and pins the birth payload",
  /create\s+trigger\s+draft_send_attempts_terminal_once\s+before\s+update\s+on\s+draft_send_attempts/.test(stmts) &&
    /old\.outcome\s+is\s+not\s+null/.test(stmts) &&
    /new\.outcome\s+is\s+null/.test(stmts) &&
    /new\.recipient_email\s+is\s+distinct\s+from\s+old\.recipient_email/.test(stmts) &&
    /new\.body\s+is\s+distinct\s+from\s+old\.body/.test(stmts)
);
ok(
  "a BEFORE UPDATE trigger on drafts writes sent facts once, never cleared, and pins a sent draft's content (clause 3)",
  /create\s+trigger\s+drafts_sent_once\s+before\s+update\s+on\s+drafts/.test(stmts) &&
    /new\.sent_at\s+is\s+distinct\s+from\s+old\.sent_at/.test(stmts) &&
    /new\.content\s+is\s+distinct\s+from\s+old\.content/.test(stmts)
);
ok(
  "the drafts sent-write requires status 'approved' at that moment and a mirroring confirmed attempt (clauses 2 and 4)",
  /old\.status\s*<>\s*'approved'/.test(stmts) &&
    /outcome\s*=\s*'sent'[\s\S]{0,120}resend_message_id\s*=\s*new\.resend_message_id/.test(stmts)
);

// --- 2. Closed-set scan: one send module, one importer (clause 1) ---------

section("closed-set scan: exactly one funder-facing send module, exactly one importer");

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (name === "node_modules" || name === ".next" || name.startsWith(".")) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

const sourceFiles = [...walk(join(root, "app")), ...walk(join(root, "lib"))];
const fileText = new Map(sourceFiles.map((f) => [relative(root, f), readFileSync(f, "utf8")]));

const SEND_MODULE = "lib/send-draft.ts";
const HANDLER = "app/(dashboard)/prospects/[id]/send-actions.ts";

// The provider package import and the provider call, matched separately --
// a file that smuggles either in fails on its own.
const RESEND_IMPORT = /from\s+["']resend["']|require\(\s*["']resend["']\s*\)/;
const PROVIDER_CALL = /new\s+Resend\s*\(|\.emails\s*\.\s*send\s*\(/;

const resendImporters = [...fileText.entries()].filter(([, t]) => RESEND_IMPORT.test(t)).map(([f]) => f).sort();
ok(
  `exactly one file under app/ or lib/ imports the resend package: ${SEND_MODULE}`,
  JSON.stringify(resendImporters) === JSON.stringify([SEND_MODULE]),
  `found: ${resendImporters.join(", ") || "(none)"}`
);

const providerCallers = [...fileText.entries()].filter(([, t]) => PROVIDER_CALL.test(t)).map(([f]) => f).sort();
ok(
  `exactly one file under app/ or lib/ makes the provider call: ${SEND_MODULE}`,
  JSON.stringify(providerCallers) === JSON.stringify([SEND_MODULE]),
  `found: ${providerCallers.join(", ") || "(none)"}`
);

// The send module's importers. "@/lib/send-draft" or any relative
// spelling ending in /send-draft -- and note lib/draft-send (the pure
// payload module) deliberately does NOT match.
const SEND_MODULE_IMPORT = /from\s+["'](?:@\/lib\/send-draft|[^"']*\/send-draft)["']/;
const sendModuleImporters = [...fileText.entries()]
  .filter(([f]) => f !== SEND_MODULE)
  .filter(([, t]) => SEND_MODULE_IMPORT.test(t))
  .map(([f]) => f)
  .sort();
ok(
  `exactly one file imports ${SEND_MODULE}: the confirmed-send handler`,
  JSON.stringify(sendModuleImporters) === JSON.stringify([HANDLER]),
  `found: ${sendModuleImporters.join(", ") || "(none)"}`
);

const inviteText = fileText.get("lib/invite.ts") ?? "";
ok(
  "the invite path (lib/invite.ts) exists and is NOT the send module: no resend import, no provider call, no send-draft import",
  inviteText.length > 0 && !RESEND_IMPORT.test(inviteText) && !PROVIDER_CALL.test(inviteText) && !SEND_MODULE_IMPORT.test(inviteText)
);

// The env READ (process.env.RESEND_*), not the mere mention -- the handler
// legitimately NAMES the variables in its not-configured error message.
// The SECRET (the API key) is read in exactly one place. The FROM address
// is not a secret (STATE item 57: platform infrastructure, address only)
// and is additionally read by the prospect page -- a server component --
// so the confirmation UI can display the exact from identity the send
// will carry. Both readers are a closed set; anything else fails.
const PROSPECT_PAGE = "app/(dashboard)/prospects/[id]/page.tsx";
const keyReaders = [...fileText.entries()].filter(([, t]) => /process\.env\.RESEND_API_KEY/.test(t)).map(([f]) => f).sort();
ok(
  `RESEND_API_KEY (the secret) is read only in ${SEND_MODULE} (hard rule 5: server-only secret, one place)`,
  JSON.stringify(keyReaders) === JSON.stringify([SEND_MODULE]),
  `found: ${keyReaders.join(", ") || "(none)"}`
);
const fromReaders = [...fileText.entries()].filter(([, t]) => /process\.env\.RESEND_FROM_EMAIL/.test(t)).map(([f]) => f).sort();
ok(
  `RESEND_FROM_EMAIL (address only) is read in exactly two server files: ${SEND_MODULE} and the prospect page feeding the confirmation`,
  JSON.stringify(fromReaders) === JSON.stringify([PROSPECT_PAGE, SEND_MODULE].sort()),
  `found: ${fromReaders.join(", ") || "(none)"}`
);
const anyResendEnvReaders = [...fileText.entries()].filter(([, t]) => /process\.env\.RESEND/.test(t)).map(([f]) => f).sort();
ok(
  "no OTHER file touches any RESEND env var at all",
  JSON.stringify(anyResendEnvReaders) === JSON.stringify([PROSPECT_PAGE, SEND_MODULE].sort()),
  `found: ${anyResendEnvReaders.join(", ") || "(none)"}`
);
ok(
  "the prospect page never touches the API key -- only the from address",
  !/process\.env\.RESEND_API_KEY/.test(fileText.get(PROSPECT_PAGE) ?? "")
);

// No batch, no schedule, no trigger, no retry loop (clause 5): the send
// files contain no timer or scheduler, and the handler calls the send
// function exactly once.
const handlerText = fileText.get(HANDLER) ?? "";
const sendModuleText = fileText.get(SEND_MODULE) ?? "";
ok(
  "neither the handler nor the send module contains a timer, interval or cron hook",
  !/setInterval|setTimeout|cron/i.test(handlerText + sendModuleText)
);
ok(
  "the handler contains exactly ONE call to sendFunderEmail -- one click, one message",
  (handlerText.match(/sendFunderEmail\(/g) ?? []).length === 1,
  `occurrences: ${(handlerText.match(/sendFunderEmail\(/g) ?? []).length}`
);
ok(
  "the handler contains no loop at all -- nothing here can iterate recipients or retries",
  !/\bfor\s*\(|\bwhile\s*\(|\.forEach\(|\.map\(\s*async/.test(handlerText)
);

// --- 3. The handler's construction (clauses 2 and 4) -----------------------

section("handler source: re-verify at send time, birth before send, capture not retype");

const readIdx = handlerText.indexOf('.from("drafts")');
const readinessIdx = handlerText.indexOf("evaluateSendReadiness(");
const birthMatch = handlerText.match(/\.from\("draft_send_attempts"\)\s*[\s\S]{0,40}?\.insert\(/);
const birthIdx = birthMatch ? handlerText.indexOf(birthMatch[0]) : -1;
const sendIdx = handlerText.indexOf("sendFunderEmail(payload)");

ok("the handler re-reads the draft from the database (server-side, at send time)", readIdx >= 0);
ok(
  "order of construction: re-read draft, THEN evaluate readiness, THEN birth the attempt, THEN (and only then) call the provider",
  readIdx >= 0 && readinessIdx > readIdx && birthIdx > readinessIdx && sendIdx > birthIdx,
  `read at ${readIdx}, readiness at ${readinessIdx}, birth at ${birthIdx}, send at ${sendIdx}`
);
ok(
  "the payload the provider gets IS the readiness payload (sendFunderEmail(payload)), not a re-assembled one",
  sendIdx >= 0 && handlerText.includes("const payload = readiness.payload")
);
// STATE item 57: the sender identity flows through the SAME payload. The
// provider module consumes payload.from / payload.replyTo and assembles
// neither; the handler sources them from the org's own profile row, the
// platform address helper, and the authenticated user's email.
ok(
  "the send module's provider call uses payload.from and payload.replyTo -- no identity assembled at the provider",
  /from:\s*payload\.from/.test(sendModuleText) && /replyTo:\s*payload\.replyTo/.test(sendModuleText)
);
ok(
  "the send module no longer feeds the env address straight into the provider call (identity comes only via the payload)",
  !/from:\s*(?:from|process\.env)/.test(sendModuleText)
);
ok(
  "the handler sources sender identity from the org profile row, platformFromAddress() and the session user's email",
  /\.from\("org_profile"\)/.test(handlerText) &&
    /orgName:\s*orgProfile\?\.name/.test(handlerText) &&
    /fromAddress:\s*platformFromAddress\(\)/.test(handlerText) &&
    /userEmail:\s*user\.email/.test(handlerText)
);
ok(
  "the interaction row is built from the SAME payload object that was sent (buildInteractionSummary(payload))",
  handlerText.includes("buildInteractionSummary(payload)")
);
ok(
  "the birth insert carries the exact payload fields (recipient_email, subject, body) -- captured before the provider call",
  /recipient_email:\s*payload\.to/.test(handlerText) && /subject:\s*payload\.subject/.test(handlerText) && /body:\s*payload\.body/.test(handlerText)
);

// The unconfirmed branch finalizes nothing: between entering it and the
// refused branch there is no update -- the born-unfinalized row stands.
const unconfirmedIdx = handlerText.indexOf('result.status === "unconfirmed"');
const refusedIdx = handlerText.indexOf('result.status === "refused"');
ok(
  "the unconfirmed branch exists, precedes the refused branch, and performs NO update -- attempted-unconfirmed stands (clause 4)",
  unconfirmedIdx >= 0 && refusedIdx > unconfirmedIdx && !handlerText.slice(unconfirmedIdx, refusedIdx).includes(".update("),
  `unconfirmed at ${unconfirmedIdx}, refused at ${refusedIdx}`
);
ok(
  "the handler returns errors instead of throwing them (production keeps the message)",
  /return\s*\{\s*error:/.test(handlerText) && handlerText.includes("catch (err)")
);

// The confirmation UI displays the same construction: the panel calls
// evaluateSendReadiness and renders readiness.payload -- it never
// assembles recipient/subject/body of its own.
const panelText = fileText.get("app/(dashboard)/prospects/[id]/draft-panel.tsx") ?? "";
ok(
  "the confirmation UI calls the same evaluateSendReadiness and displays readiness.payload (confirmation payload = send payload by construction)",
  panelText.includes("evaluateSendReadiness(") && panelText.includes("payload={readiness.payload}") &&
    panelText.includes("{payload.to}") && panelText.includes("{payload.subject}") && panelText.includes("{payload.body}")
);
ok(
  "the confirmation also displays the exact from identity and reply-to from the same payload (clause 2 extended, STATE item 57)",
  panelText.includes("{payload.from}") && panelText.includes("{payload.replyTo}")
);
ok(
  "the confirmation's confirm click calls sendApprovedDraft with the draft id -- the id, not client-supplied content, is what the server acts on",
  panelText.includes("sendApprovedDraft(draft.id, prospectId)")
);

// --- 4. Pure logic: every precondition combination --------------------------

section("evaluateSendReadiness: the clause-2 preconditions, offline");

const baseDraft = { kind: "intro_email" as const, subject: "A real subject", content: "A real body", status: "approved" as const, sent_at: null };
// STATE item 57: org name captured from the org's record, platform address
// from env, reply-to from the authenticated clicker.
const baseSender = { orgName: "Village Worship Initiative", fromAddress: "outreach@platform.example", userEmail: "officer@example.org" };
const attempt = (over: Partial<DraftSendAttempt>): DraftSendAttempt => ({
  id: "a1",
  draft_id: "d1",
  recipient_email: "x@example.org",
  subject: "s",
  body: "b",
  attempted_by: "u1",
  attempted_at: "2026-09-21T00:00:00Z",
  outcome: null,
  completed_at: null,
  error_note: null,
  resend_message_id: null,
  organization_id: "o1",
  ...over,
});

{
  const r = evaluateSendReadiness(baseDraft, [], "funder@example.org", baseSender);
  ok("an approved, never-sent email draft with a contact email is ready", r.ok);
  ok(
    "the payload is EXACTLY the stored fields: to = contact email, subject = draft subject, body = draft content",
    r.ok && r.payload.to === "funder@example.org" && r.payload.subject === "A real subject" && r.payload.body === "A real body"
  );
  ok(
    'the email presents as the ORGANIZATION: from = "{org record name}" <platform address> (STATE item 57)',
    r.ok && r.payload.from === '"Village Worship Initiative" <outreach@platform.example>'
  );
  ok(
    "replies go to the human who clicked send: replyTo = the authenticated user's email, never the platform address",
    r.ok && r.payload.replyTo === "officer@example.org"
  );
}
{
  const r = evaluateSendReadiness({ ...baseDraft, kind: "call_prep" }, [], "funder@example.org", baseSender);
  ok("call prep notes can never be sent", !r.ok && !r.ok && r.code === "not_email");
}
{
  const r = evaluateSendReadiness({ ...baseDraft, status: "draft" }, [], "funder@example.org", baseSender);
  ok("an unapproved draft cannot be sent (clause 2)", !r.ok && r.code === "not_approved");
}
{
  const r = evaluateSendReadiness({ ...baseDraft, sent_at: "2026-09-21T00:00:00Z" }, [], "funder@example.org", baseSender);
  ok("a sent draft cannot be sent again -- re-sending requires a new draft (clause 3)", !r.ok && r.code === "already_sent");
}
{
  const r = evaluateSendReadiness(baseDraft, [attempt({ outcome: "sent", completed_at: "x", resend_message_id: "m" })], "funder@example.org", baseSender);
  ok("a confirmed attempt blocks sending even if the draft row missed its sent fact", !r.ok && r.code === "already_sent");
}
{
  const r = evaluateSendReadiness(baseDraft, [attempt({})], "funder@example.org", baseSender);
  ok(
    "an unconfirmed attempt permanently blocks sending, and the reason says the outcome is unknown (clauses 4-5)",
    !r.ok && r.code === "attempt_unconfirmed" && /may or may not/.test(r.ok ? "" : r.reason)
  );
}
{
  const r = evaluateSendReadiness(baseDraft, [attempt({ outcome: "failed", completed_at: "x", error_note: "bad domain" })], "funder@example.org", baseSender);
  ok("a FAILED attempt does not block a new human confirmation (clause 5: click again, never auto-retry)", r.ok);
}
{
  const r = evaluateSendReadiness(baseDraft, [], null, baseSender);
  ok(
    "no contact email refuses with guidance (add one on the Contacts tab), so the confirmation is unreachable",
    !r.ok && r.code === "no_recipient" && /[Cc]ontacts/.test(r.ok ? "" : r.reason)
  );
}
{
  const r = evaluateSendReadiness(baseDraft, [], "not-an-address", baseSender);
  ok("a non-address in contact_email refuses the same way", !r.ok && r.code === "no_recipient");
}
{
  const r = evaluateSendReadiness({ ...baseDraft, subject: "  " }, [], "funder@example.org", baseSender);
  ok("a blank subject refuses", !r.ok && r.code === "empty_subject");
}
{
  const r = evaluateSendReadiness({ ...baseDraft, content: "" }, [], "funder@example.org", baseSender);
  ok("a blank body refuses", !r.ok && r.code === "empty_body");
}
// Sender identity refusals (STATE item 57): each missing fact refuses with
// what to fix -- never a silent fall back to a bare platform identity.
{
  const r = evaluateSendReadiness(baseDraft, [], "funder@example.org", { ...baseSender, orgName: null });
  ok(
    "no org display name refuses with guidance (add it on the Organization page) -- never a bare platform from",
    !r.ok && r.code === "no_org_name" && /[Oo]rganization/.test(r.ok ? "" : r.reason)
  );
}
{
  const r = evaluateSendReadiness(baseDraft, [], "funder@example.org", { ...baseSender, orgName: "   " });
  ok("a whitespace-only org name refuses the same way", !r.ok && r.code === "no_org_name");
}
{
  const r = evaluateSendReadiness(baseDraft, [], "funder@example.org", { ...baseSender, fromAddress: null });
  ok(
    "no platform from-address refuses as not configured (RESEND_FROM_EMAIL named in the reason)",
    !r.ok && r.code === "send_not_configured" && /RESEND_FROM_EMAIL/.test(r.ok ? "" : r.reason)
  );
}
{
  const r = evaluateSendReadiness(baseDraft, [], "funder@example.org", { ...baseSender, fromAddress: "not-an-address" });
  ok("a malformed platform from-address refuses the same way", !r.ok && r.code === "send_not_configured");
}
{
  const r = evaluateSendReadiness(baseDraft, [], "funder@example.org", { ...baseSender, userEmail: null });
  ok(
    "a clicker with no email refuses -- a funder's reply must have somewhere to go",
    !r.ok && r.code === "no_sender_email"
  );
}
{
  // The name is the org's record verbatim, normalized only as far as a mail
  // header requires: quotes and newlines cannot survive into the header.
  const r = evaluateSendReadiness(baseDraft, [], "funder@example.org", { ...baseSender, orgName: ' The "Village"\r\nInitiative ' });
  ok(
    "header-breaking characters in the org name are normalized, everything else kept",
    r.ok && r.payload.from === `"The 'Village' Initiative" <outreach@platform.example>`,
    r.ok ? r.payload.from : r.reason
  );
}
{
  const summary = buildInteractionSummary({
    from: '"Village Worship Initiative" <outreach@platform.example>',
    replyTo: "officer@example.org",
    to: "funder@example.org",
    subject: "Hello",
    body: "...",
  });
  ok("the interaction summary derives from the payload alone", summary.includes("funder@example.org") && summary.includes("Hello"));
}

// --- 5. DB-dependent: the live schema's own behavior -----------------------

async function dbSection() {
  const supabaseUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceRoleKey) {
    console.log(
      "\nSKIPPED: DB assertions (no NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY in the environment)." +
        "\n         Run with --env-file=.env.local once migration 0069 is applied."
    );
    notEvaluated.push("DB assertions -- no env supplied");
    return;
  }

  section("DB: birth preconditions, one live attempt, terminal once, the drafts mirror");
  const { createClient } = await import("@supabase/supabase-js");
  const admin = createClient(supabaseUrl, serviceRoleKey, { auth: { autoRefreshToken: false, persistSession: false } });

  const { error: probeError } = await admin.from("draft_send_attempts").select("id").limit(1);
  // Postgres says 42P01 for a missing relation; PostgREST (which is what
  // the client actually talks to) says PGRST205 when the table is not in
  // its schema cache. Both mean the same fact here: 0069 is not applied.
  const MISSING_TABLE = new Set(["42P01", "PGRST205"]);
  if (probeError && MISSING_TABLE.has(probeError.code ?? "")) {
    console.log("NOT EVALUATED: draft_send_attempts does not exist in this database -- migration 0069 is not applied. This is not a pass.");
    notEvaluated.push("DB assertions -- migration 0069 not applied");
    return;
  }
  if (probeError) throw new Error(`Could not probe draft_send_attempts: ${probeError.message}`);

  // Equality-matched throwaway identity, purged before and after -- the
  // test-ai-runs / test-tenant-isolation discipline: no like/ilike, refuse
  // to touch an org holding any other profile, idempotent either way.
  const ORG_NAME = "Draft Send Test Org";
  const EMAIL = "draft-send-test@fundraising-ai-test.local";

  async function findOrgIds(): Promise<string[]> {
    const { data, error } = await admin.from("organizations").select("id, name").eq("name", ORG_NAME);
    if (error) throw new Error(`could not list test orgs: ${error.message}`);
    return (data ?? []).filter((o) => o.name === ORG_NAME).map((o) => o.id as string);
  }
  async function findTestUsers(): Promise<string[]> {
    const found: string[] = [];
    for (let page = 1; ; page++) {
      const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
      if (error) throw new Error(`listUsers failed: ${error.message}`);
      const users = data?.users ?? [];
      for (const u of users) if (u.email === EMAIL) found.push(u.id);
      if (users.length < 200) return found;
    }
  }
  async function purge(phase: string) {
    const orgIds = await findOrgIds();
    if (orgIds.length > 0) {
      const { data: occupants } = await admin.from("profiles").select("email").in("organization_id", orgIds);
      const strangers = (occupants ?? []).filter((p) => p.email !== EMAIL);
      if (strangers.length > 0) throw new Error(`[${phase}] refusing to purge: test org has non-test profile(s) ${strangers.map((s) => s.email).join(", ")}`);
      // Attempts first: their FK to drafts has NO cascade, so a surviving
      // attempt blocks the prospects->drafts cascade delete.
      const { error: attemptsError } = await admin.from("draft_send_attempts").delete().in("organization_id", orgIds);
      if (attemptsError && attemptsError.code !== "42P01" && attemptsError.code !== "PGRST205")
        throw new Error(`[${phase}] could not delete test attempts: ${attemptsError.message}`);
      const { error: interactionsError } = await admin.from("interactions").delete().in("organization_id", orgIds);
      if (interactionsError) throw new Error(`[${phase}] could not delete test interactions: ${interactionsError.message}`);
      const { error: prospectsError } = await admin.from("prospects").delete().in("organization_id", orgIds);
      if (prospectsError) throw new Error(`[${phase}] could not delete test prospects: ${prospectsError.message}`);
      const { error: profilesError } = await admin.from("profiles").delete().in("organization_id", orgIds);
      if (profilesError) throw new Error(`[${phase}] could not delete test profiles: ${profilesError.message}`);
    }
    for (const id of await findTestUsers()) {
      await admin.from("profiles").delete().eq("id", id);
      const { error: userError } = await admin.auth.admin.deleteUser(id);
      if (userError) throw new Error(`[${phase}] could not delete test user: ${userError.message}`);
    }
    if (orgIds.length > 0) {
      const { error: orgError } = await admin.from("organizations").delete().in("id", orgIds);
      if (orgError) throw new Error(`[${phase}] could not delete test orgs: ${orgError.message}`);
    }
  }

  await purge("pre-run");
  const { data: org, error: orgError } = await admin.from("organizations").insert({ name: ORG_NAME }).select("id").single();
  if (orgError || !org) throw new Error(`Could not create test org: ${orgError?.message}`);
  const orgId = org.id as string;
  const { data: created, error: userError } = await admin.auth.admin.createUser({ email: EMAIL, email_confirm: true });
  if (userError || !created.user) throw new Error(`Could not create test user: ${userError?.message}`);
  const userId = created.user.id;

  try {
    const { data: prospect, error: prospectError } = await admin
      .from("prospects")
      .insert({ name: "[test] Draft Send Probe", channel: "foundation", owner_id: userId, organization_id: orgId, contact_email: "funder@example.org" })
      .select("id")
      .single();
    if (prospectError || !prospect) throw new Error(`Could not create test prospect: ${prospectError?.message}`);

    const { data: draft, error: draftError } = await admin
      .from("drafts")
      .insert({ prospect_id: prospect.id, kind: "intro_email", subject: "Test subject", content: "Test body", status: "draft", created_by: userId, organization_id: orgId })
      .select("id")
      .single();
    if (draftError || !draft) throw new Error(`Could not create test draft: ${draftError?.message}`);

    const birthRow = { draft_id: draft.id, recipient_email: "funder@example.org", subject: "Test subject", body: "Test body", attempted_by: userId, organization_id: orgId };

    const { error: unapprovedError } = await admin.from("draft_send_attempts").insert(birthRow);
    ok("an attempt cannot be born against an UNAPPROVED draft (birth trigger, clause 2)", !!unapprovedError, unapprovedError?.message ?? "no error");

    const { error: approveError } = await admin.from("drafts").update({ status: "approved", approved_by: userId, approved_at: new Date().toISOString() }).eq("id", draft.id);
    ok("approving a never-sent draft still works with the sent-once trigger in place (safe ahead of its code)", !approveError, approveError?.message ?? "");

    const { error: prefinalizedError } = await admin
      .from("draft_send_attempts")
      .insert({ ...birthRow, outcome: "sent", completed_at: new Date().toISOString(), resend_message_id: "fake" });
    ok("a PRE-FINALIZED attempt cannot be inserted -- birth-before-send is mandatory (birth trigger, clause 4)", !!prefinalizedError, prefinalizedError?.message ?? "no error");

    const { error: sentNoAttemptError } = await admin
      .from("drafts")
      .update({ sent_at: new Date().toISOString(), sent_by: userId, resend_message_id: "asserted-from-nowhere" })
      .eq("id", draft.id);
    ok("a sent fact CANNOT be written on a draft with no mirroring confirmed attempt (drafts trigger, clause 4)", !!sentNoAttemptError, sentNoAttemptError?.message ?? "no error");

    const { data: born, error: bornError } = await admin.from("draft_send_attempts").insert(birthRow).select("*").single();
    ok("a legal birth succeeds and the row is born unfinalized (outcome null = attempted-unconfirmed encoding exists)", !bornError && !!born && born.outcome === null && born.completed_at === null, bornError?.message ?? "");
    if (!born) throw new Error("cannot continue without a born attempt");

    const { error: secondLiveError } = await admin.from("draft_send_attempts").insert(birthRow);
    ok("a SECOND live attempt for the same draft is refused -- two concurrent clicks cannot both send (clause 3)", !!secondLiveError, secondLiveError?.message ?? "no error");

    const { error: nonTerminalError } = await admin.from("draft_send_attempts").update({ body: "rewritten" }).eq("id", born.id);
    ok("an update that does not write a terminal outcome raises (terminal trigger)", !!nonTerminalError, nonTerminalError?.message ?? "no error");

    const { error: unconfirmedValueError } = await admin
      .from("draft_send_attempts")
      .update({ outcome: "unconfirmed", completed_at: new Date().toISOString() })
      .eq("id", born.id);
    ok("'unconfirmed' cannot be stored as an outcome (check constraint) -- absence is the only encoding", !!unconfirmedValueError, unconfirmedValueError?.message ?? "no error");

    const { error: sentNoIdError } = await admin
      .from("draft_send_attempts")
      .update({ outcome: "sent", completed_at: new Date().toISOString() })
      .eq("id", born.id);
    ok("an attempt cannot finalize 'sent' without a captured provider message id (clause 4)", !!sentNoIdError, sentNoIdError?.message ?? "no error");

    const { error: finalizeError } = await admin
      .from("draft_send_attempts")
      .update({ outcome: "sent", completed_at: new Date().toISOString(), resend_message_id: "msg-123" })
      .eq("id", born.id);
    ok("finalizing 'sent' with the captured message id succeeds", !finalizeError, finalizeError?.message ?? "");

    const { error: refinalizeError } = await admin
      .from("draft_send_attempts")
      .update({ outcome: "failed", completed_at: new Date().toISOString(), error_note: "should not land" })
      .eq("id", born.id);
    ok("a finalized attempt is immutable -- terminal is written once, even for the service role (trigger)", !!refinalizeError, refinalizeError?.message ?? "no error");

    const { error: thirdBirthError } = await admin.from("draft_send_attempts").insert(birthRow);
    ok("once an attempt is confirmed 'sent', no new attempt can be born for that draft, ever", !!thirdBirthError, thirdBirthError?.message ?? "no error");

    const { error: mismatchedIdError } = await admin
      .from("drafts")
      .update({ sent_at: new Date().toISOString(), sent_by: userId, resend_message_id: "some-other-id" })
      .eq("id", draft.id);
    ok("the drafts sent-write must carry the SAME message id the confirmed attempt captured", !!mismatchedIdError, mismatchedIdError?.message ?? "no error");

    const { error: sentWriteError } = await admin
      .from("drafts")
      .update({ sent_at: new Date().toISOString(), sent_by: userId, resend_message_id: "msg-123" })
      .eq("id", draft.id);
    ok("the ONE legal sent-write (mirroring the confirmed attempt) succeeds", !sentWriteError, sentWriteError?.message ?? "");

    const { error: editSentError } = await admin.from("drafts").update({ content: "edited after send" }).eq("id", draft.id);
    ok("a sent draft's content is pinned exactly as sent (drafts trigger)", !!editSentError, editSentError?.message ?? "no error");

    const { error: clearSentError } = await admin.from("drafts").update({ sent_at: null, sent_by: null, resend_message_id: null }).eq("id", draft.id);
    ok("sent facts can never be cleared, even by the service role (clause 3)", !!clearSentError, clearSentError?.message ?? "no error");

    const { error: deleteDraftError } = await admin.from("drafts").delete().eq("id", draft.id);
    ok("a draft with send history cannot be deleted (FK without cascade) -- the record outlives tidying", !!deleteDraftError, deleteDraftError?.message ?? "no error");

    // The failed-then-retry path on a fresh draft: a refusal is terminal
    // for its attempt but not for the draft.
    const { data: draft2, error: draft2Error } = await admin
      .from("drafts")
      .insert({ prospect_id: prospect.id, kind: "intro_email", subject: "Second", content: "Second body", status: "approved", created_by: userId, organization_id: orgId })
      .select("id")
      .single();
    if (draft2Error || !draft2) throw new Error(`Could not create second test draft: ${draft2Error?.message}`);
    const birth2 = { ...birthRow, draft_id: draft2.id, subject: "Second", body: "Second body" };
    const { data: born2, error: born2Error } = await admin.from("draft_send_attempts").insert(birth2).select("id").single();
    if (born2Error || !born2) throw new Error(`Second draft's attempt birth failed: ${born2Error?.message}`);
    const { error: failFinalizeError } = await admin
      .from("draft_send_attempts")
      .update({ outcome: "failed", completed_at: new Date().toISOString(), error_note: "provider refused" })
      .eq("id", born2.id);
    ok("an attempt can finalize 'failed' with the provider's error note", !failFinalizeError, failFinalizeError?.message ?? "");
    const { error: retryBirthError } = await admin.from("draft_send_attempts").insert(birth2);
    ok("after a FAILED attempt, a new attempt can be born -- a human may click again on a new confirmation (clause 5)", !retryBirthError, retryBirthError?.message ?? "");
  } finally {
    await purge("teardown");
    const leftoverOrgs = await findOrgIds();
    const leftoverUsers = await findTestUsers();
    if (leftoverOrgs.length > 0 || leftoverUsers.length > 0) {
      console.error(`CLEANUP PROBLEM: ${leftoverOrgs.length} test org(s), ${leftoverUsers.length} test user(s) still present`);
      fail++;
    } else {
      console.log("Teardown verified: no test org, user, prospect, draft or attempt rows remain.");
    }
  }
}

async function main() {
  await dbSection();
  console.log(`\n${pass} passed, ${fail} failed.`);
  for (const n of notEvaluated) console.log(`NOT EVALUATED: ${n}`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FAILED:", err);
  console.error(`Run aborted. Of the assertions that executed before the abort: ${pass} passed, ${fail} failed.`);
  process.exit(1);
});
