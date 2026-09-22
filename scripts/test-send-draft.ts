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

// --- 1b. Migration 0070: the attempt captures the identity it sent --------
// STATE item 59, ruling 0029 clause 4 extended: from_identity and reply_to
// join the birth payload, nullable (a row born before the columns existed
// records that absence honestly), pinned by the terminal-once trigger.

section("migration 0070 is additive and pins the captured sender identity");

const sql70 = readFileSync(join(root, "supabase/migrations/0070_send_attempt_identity.sql"), "utf8");
const stmts70 = sql70
  .split("\n")
  .map((l) => l.replace(/--.*$/, ""))
  .join("\n")
  .toLowerCase();

const alterTargets70 = [...stmts70.matchAll(/alter\s+table\s+([a-z_]+)/g)].map((m) => m[1]);
ok(
  "every ALTER TABLE targets draft_send_attempts and nothing else (ruling 0020: additive)",
  alterTargets70.length > 0 && alterTargets70.every((t) => t === "draft_send_attempts"),
  `alter targets: ${alterTargets70.join(", ")}`
);
ok("no DROP of any kind, no new table -- two columns and one widened guard, nothing else", !/\bdrop\b/.test(stmts70) && !/create\s+table/.test(stmts70));
const addColumns70 = [...stmts70.matchAll(/add\s+column\s+([a-z_]+)\s+([a-z]+)/g)].map((m) => [m[1], m[2]]).sort();
ok(
  "the only ADD COLUMNs are from_identity text and reply_to text",
  JSON.stringify(addColumns70) === JSON.stringify([["from_identity", "text"], ["reply_to", "text"]]),
  `added: ${addColumns70.map(([c, t]) => `${c} ${t}`).join(", ")}`
);
ok(
  "neither new column is NOT NULL (nullable by spec -- a row born before the capture existed keeps the absence)",
  ![...stmts70.matchAll(/add\s+column[^,;]*/g)].some((m) => /not\s+null/.test(m[0]))
);
// The widened guard: create OR REPLACE, because 0069's function is already
// applied live -- additive in effect (widens a pin list, changes no data,
// drops nothing), stated in the migration's own header.
const replaced = stmts70.match(/create\s+or\s+replace\s+function\s+([a-z_]+)/g) ?? [];
ok(
  "exactly ONE create or replace function, and it is the terminal-once trigger function (birth and drafts triggers untouched)",
  replaced.length === 1 && /create\s+or\s+replace\s+function\s+draft_send_attempts_enforce_terminal_once/.test(stmts70),
  `replaced: ${replaced.join(", ")}`
);
ok(
  "the replaced function pins BOTH new columns as birth facts (new is distinct from old raises)",
  /new\.from_identity\s+is\s+distinct\s+from\s+old\.from_identity/.test(stmts70) &&
    /new\.reply_to\s+is\s+distinct\s+from\s+old\.reply_to/.test(stmts70)
);
ok(
  "the replaced function keeps EVERY 0069 pin -- widening only, no check removed",
  ["id", "draft_id", "recipient_email", "subject", "body", "attempted_by", "attempted_at", "organization_id"].every((c) =>
    new RegExp(`new\\.${c}\\s+is\\s+distinct\\s+from\\s+old\\.${c}`).test(stmts70)
  )
);
ok(
  "the replaced function keeps terminal-written-once whole: a terminal row is immutable, and unfinalized-to-terminal is the only legal transition",
  /old\.outcome\s+is\s+not\s+null/.test(stmts70) && /new\.outcome\s+is\s+null/.test(stmts70) && (stmts70.match(/raise\s+exception/g) ?? []).length === 3
);
ok("migration 0069 itself is untouched (never rewrite an applied migration)", /add\s+column\s+sent_at/.test(sql) && !/from_identity/.test(sql));

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
ok(
  "the birth insert also captures the identity it sends AS: from_identity = payload.from, reply_to = payload.replyTo (STATE item 59)",
  /from_identity:\s*payload\.from\b/.test(handlerText) && /reply_to:\s*payload\.replyTo/.test(handlerText)
);
ok(
  "the finalization updates never touch the identity columns -- birth facts are written at birth, full stop",
  ![...handlerText.matchAll(/\.update\(\{[^}]*\}/g)].some((m) => /from_identity|reply_to/.test(m[0]))
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

// --- 3b. composeDraft: human-composed, no AI, no new send path -------------
// STATE item 60: a human can compose an email draft with no strategy at
// all. The action is construction-checked here the way the handler is:
// no model call (so no ai_runs row -- ruling 0026 covers model calls and
// compose makes none), the generateDraft insert shape minus the AI-only
// fields, refusals returned as plain messages, and NOTHING touching the
// send machinery -- the closed-set scan above is the proof that compose
// introduced no new send call and no new importer of lib/send-draft.ts.

section("composeDraft source: human-written draft, no model call, refusals in plain words");

const draftActionsText = fileText.get("app/(dashboard)/prospects/[id]/draft-actions.ts") ?? "";
const composeStart = draftActionsText.indexOf("export async function composeDraft");
const composeEnd = draftActionsText.indexOf("export async function", composeStart + 1);
const composeRaw = composeStart >= 0 ? draftActionsText.slice(composeStart, composeEnd < 0 ? undefined : composeEnd) : "";
// Statements only -- the comments legitimately DISCUSS what must not
// exist (the same discipline as the migration checks above).
const composeBody = composeRaw
  .split("\n")
  .map((l) => l.replace(/\/\/.*$/, ""))
  .join("\n");

ok("composeDraft exists in draft-actions.ts, beside generateDraft", composeStart >= 0);
ok(
  "composeDraft takes (prospectId, subject, content) -- the human's own words, no strategy parameter",
  /composeDraft\(\s*prospectId:\s*string,\s*subject:\s*string,\s*content:\s*string\s*\)/.test(composeBody)
);
ok(
  "composeDraft makes NO model call and records NO ai_runs row (no anthropic, no beginRun/finalizeRun -- ruling 0026 covers model calls and none is made)",
  composeBody.length > 0 && !/anthropic|beginRun|finalizeRun/.test(composeBody)
);
ok(
  "composeDraft never touches the send path: no sendFunderEmail, no send-draft import, no draft_send_attempts",
  composeBody.length > 0 && !/sendFunderEmail|send-draft|draft_send_attempts/.test(composeBody)
);
ok(
  "validation trims BOTH fields and refuses empties with returned plain messages",
  (composeBody.match(/\.trim\(\)/g) ?? []).length >= 2 &&
    /if\s*\(!trimmedSubject\)\s*return\s*\{\s*error:/.test(composeBody) &&
    /if\s*\(!trimmedContent\)\s*return\s*\{\s*error:/.test(composeBody)
);
ok(
  "composeDraft throws nothing -- every refusal is a returned message (production redacts thrown server-action errors)",
  composeBody.length > 0 && !/\bthrow\b/.test(composeBody)
);
ok(
  "the insert mirrors generateDraft's shape: drafts row with kind intro_email, status 'draft', created_by the authenticated user",
  /\.from\("drafts"\)\.insert\(/.test(composeBody) &&
    /kind:\s*"intro_email"/.test(composeBody) &&
    /status:\s*"draft"/.test(composeBody) &&
    /created_by:\s*user\.id/.test(composeBody)
);
ok(
  "the insert stores the TRIMMED values the validation checked -- what was validated is what is saved",
  /subject:\s*trimmedSubject/.test(composeBody) && /content:\s*trimmedContent/.test(composeBody)
);
ok(
  "no model and no strategy_run_id are written -- their absence is the honest record that no model and no strategy produced this",
  !/model:/.test(composeBody) && !/strategy_run_id/.test(composeBody)
);
ok(
  "org scoping is generateDraft's exactly: no organization_id in the insert (the column defaults to my_organization_id(), hard rule 6)",
  /\.from\("drafts"\)\.insert\(/.test(composeBody) && !/organization_id/.test(composeBody)
);
ok(
  "composeDraft requires an authenticated user before anything else",
  /supabase\.auth\.getUser\(\)/.test(composeBody) && /if\s*\(!user\)\s*redirect\("\/login"\)/.test(composeBody)
);

// The UI side: compose renders WITHOUT an approved strategy, AI drafting
// keeps its gate, and the composed draft joins the same list.
const pageText = fileText.get(PROSPECT_PAGE) ?? "";
ok(
  "the prospect page renders DraftPanel unconditionally on the Strategy tab, with strategyRunId null when no approved strategy exists",
  /strategyRunId=\{strategyRun\?\.approved_strategy \? strategyRun\.id : null\}/.test(pageText) &&
    !/approved_strategy\s*&&\s*\(\s*<DraftPanel/.test(pageText)
);
ok(
  "the panel gates the AI-draft buttons on strategyRunId (render guard AND a handler guard that never calls generateDraft without one)",
  /\{strategyRunId && \(\s*<div/.test(panelText) && /if \(!strategyRunId\) return;/.test(panelText)
);
ok(
  "the compose affordance is NOT gated on strategyRunId (ComposeSection renders outside the strategyRunId guard)",
  /<ComposeSection prospectId=\{prospectId\} \/>/.test(panelText) &&
    !/strategyRunId && \([\s\S]{0,400}<ComposeSection/.test(panelText)
);
ok(
  "the compose form saves through composeDraft and shows the returned refusal message instead of swallowing it",
  /composeDraft\(prospectId, subject, content\)/.test(panelText) && /setComposeError\(result\.error\)/.test(panelText)
);
ok(
  "the compose form says plainly the email is human-written and still needs approval before anything is sent",
  /writing this email yourself/.test(panelText) && /no AI involved/.test(panelText) && /needs explicit\s+approval/.test(panelText)
);

// --- 3c. generateProposalDraft: approved strategy in, evidence by id, ------
// never sendable (STATE item 63). The proposal is a reviewable draft
// produced by its own action; nothing about it may reach the send
// machinery -- the closed-set scan above already proves no new send call
// and no new importer exist, and the assertions here pin the action's own
// construction plus the UI gate that keeps a proposal away from Send.

section("generateProposalDraft source: approved strategy in, evidence by id, never sendable");

const proposalStart = draftActionsText.indexOf("export async function generateProposalDraft");
const proposalEnd = draftActionsText.indexOf("export async function", proposalStart + 1);
const proposalRaw = proposalStart >= 0 ? draftActionsText.slice(proposalStart, proposalEnd < 0 ? undefined : proposalEnd) : "";
// Statements only -- comments legitimately DISCUSS what must not exist.
const proposalBody = proposalRaw
  .split("\n")
  .map((l) => l.replace(/\/\/.*$/, ""))
  .join("\n");

ok("generateProposalDraft exists in draft-actions.ts, beside generateDraft", proposalStart >= 0);
ok(
  "it refuses without an APPROVED strategy, with a returned plain message (the gate is in the action, not only the UI)",
  /if\s*\(!run\s*\|\|\s*!run\.approved_strategy\)\s*\{\s*return\s*\{\s*error:/.test(proposalBody)
);
ok(
  "it fails closed BEFORE any model call when migration 0071 is missing: the enum-literal probe precedes the anthropic call and its refusal names the migration",
  proposalBody.indexOf('.eq("kind", "proposal")') >= 0 &&
    proposalBody.indexOf('.eq("kind", "proposal")') < proposalBody.indexOf("await anthropic.messages.create") &&
    /0071/.test(proposalRaw)
);
ok(
  "the evidence pool query IS the permission gate: verified_at not null AND permission = 'approved', nothing else reaches the prompt",
  /\.not\("verified_at", "is", null\)/.test(proposalBody) && /\.eq\("permission", "approved"\)/.test(proposalBody)
);
ok(
  "evidence is handed to the model WITH ids and cited back by id (evidence_cited), validated against the pool it was given (capture, don't retype)",
  /evidence_cited/.test(proposalBody) && /evidencePoolIds\.has\(/.test(proposalBody)
);
ok(
  "the strategy's own selections (strategy_runs.evidence_item_ids) are flagged in the list the model sees",
  /evidence_item_ids/.test(proposalBody) && /cited in the approved strategy/.test(proposalRaw)
);
ok(
  "the insert is a reviewable proposal draft: kind 'proposal', status 'draft', tied to the approved strategy run, model recorded, author recorded",
  /kind:\s*"proposal"/.test(proposalBody) &&
    /status:\s*"draft"/.test(proposalBody) &&
    /strategy_run_id:\s*strategyRunId/.test(proposalBody) &&
    /model:\s*DRAFT_MODEL/.test(proposalBody) &&
    /created_by:\s*user\.id/.test(proposalBody)
);
ok(
  "org scoping is generateDraft's exactly: no organization_id in the insert (the column defaults to my_organization_id(), hard rule 6)",
  /\.from\("drafts"\)\.insert\(/.test(proposalBody) && !/organization_id/.test(proposalBody)
);
ok(
  "generateProposalDraft never touches the send path: no sendFunderEmail, no send-draft import, no draft_send_attempts",
  proposalBody.length > 0 && !/sendFunderEmail|send-draft|draft_send_attempts/.test(proposalBody)
);
ok(
  "its failures finalize the run and RETURN the error -- never a rethrow production would redact",
  /catch\s*\(err\)\s*\{[\s\S]*finalizeRun\([\s\S]*return\s*\{\s*error:/.test(proposalBody) && !/throw err/.test(proposalBody)
);

// The UI side: the proposal control sits behind the SAME approved-strategy
// gate as the outreach buttons, and no proposal draft can reach Send.
ok(
  "the panel's proposal handler carries the same approved-strategy gate as handleDraft (guard in the handler, button inside the strategyRunId block)",
  /function handleProposal\(\) \{\s*if \(!strategyRunId\) return;/.test(panelText) &&
    /strategyRunId && \([\s\S]{0,900}Draft Grant Proposal/.test(panelText)
);
ok(
  "SendSection renders ONLY for an intro_email draft -- a proposal card has no send control at all",
  /const isEmail = draft\.kind === "intro_email"/.test(panelText) && /\{isEmail && \(\s*<SendSection/.test(panelText)
);
{
  const dialogUses = [...panelText.matchAll(/<SendConfirmDialog/g)].map((m) => m.index ?? -1);
  const sendSectionAt = panelText.indexOf("function SendSection");
  const dialogDefAt = panelText.indexOf("function SendConfirmDialog");
  ok(
    "the send confirmation is rendered in exactly one place, inside SendSection -- a proposal draft cannot reach the confirmation",
    dialogUses.length === 1 && dialogUses[0] > sendSectionAt && dialogUses[0] < dialogDefAt,
    `renders at ${dialogUses.join(", ")}, SendSection at ${sendSectionAt}, definition at ${dialogDefAt}`
  );
}

// --- 3d. generateDeckOutline: same gates as the proposal, never sendable ----
// STATE item 66. The deck outline is a reviewable draft like the proposal;
// nothing about it may reach the send machinery. The closed-set scan above
// already proves no new send call and no new importer of lib/send-draft.ts
// exists anywhere under app/ or lib/ (the deck view route included, since
// the scan walks all of app/); the assertions here pin the action's own
// construction and the UI gates. The deck's parser and view have their own
// suite (scripts/test-deck-outline.ts).

section("generateDeckOutline source: approved strategy in, evidence by id, never sendable");

const deckStart = draftActionsText.indexOf("export async function generateDeckOutline");
const deckEnd = draftActionsText.indexOf("export async function", deckStart + 1);
const deckRaw = deckStart >= 0 ? draftActionsText.slice(deckStart, deckEnd < 0 ? undefined : deckEnd) : "";
// Statements only -- comments legitimately DISCUSS what must not exist.
const deckBody = deckRaw
  .split("\n")
  .map((l) => l.replace(/\/\/.*$/, ""))
  .join("\n");

ok("generateDeckOutline exists in draft-actions.ts, beside generateProposalDraft", deckStart >= 0);
ok(
  "it refuses without an APPROVED strategy, with a returned plain message (the gate is in the action, not only the UI)",
  /if\s*\(!run\s*\|\|\s*!run\.approved_strategy\)\s*\{\s*return\s*\{\s*error:/.test(deckBody)
);
ok(
  "it fails closed BEFORE any model call when migration 0072 is missing: the enum-literal probe precedes the anthropic call and its refusal names the migration",
  deckBody.indexOf('.eq("kind", "deck")') >= 0 &&
    deckBody.indexOf('.eq("kind", "deck")') < deckBody.indexOf("await anthropic.messages.create") &&
    /0072/.test(deckRaw)
);
ok(
  "the evidence pool query IS the permission gate: verified_at not null AND permission = 'approved', nothing else reaches the prompt",
  /\.not\("verified_at", "is", null\)/.test(deckBody) && /\.eq\("permission", "approved"\)/.test(deckBody)
);
ok(
  "evidence is handed to the model WITH ids; the ids cited in the outline are parsed back out with the SHARED parser and validated against the pool (capture, don't retype -- one copy of the fact)",
  /parseDeckOutline\(content\)\.evidenceIds/.test(deckBody) && /evidencePoolIds\.has\(/.test(deckBody)
);
ok(
  "an id outside the pool is logged and KEPT in the outline for human review -- never silently dropped",
  /kept in the outline for human review/.test(deckRaw)
);
ok(
  "the strategy's own selections (strategy_runs.evidence_item_ids) are flagged in the list the model sees",
  /evidence_item_ids/.test(deckBody) && /cited in the approved strategy/.test(deckRaw)
);
ok(
  "the stored outline begins with the format's self-documentation, prepended in CODE (ensureOutlineHeader), never trusted to the model",
  /content:\s*ensureOutlineHeader\(content\)/.test(deckBody)
);
ok(
  "the insert is a reviewable deck draft: kind 'deck', status 'draft', tied to the approved strategy run, model recorded, author recorded",
  /kind:\s*"deck"/.test(deckBody) &&
    /status:\s*"draft"/.test(deckBody) &&
    /strategy_run_id:\s*strategyRunId/.test(deckBody) &&
    /model:\s*DRAFT_MODEL/.test(deckBody) &&
    /created_by:\s*user\.id/.test(deckBody)
);
ok(
  "org scoping is generateDraft's exactly: no organization_id in the insert (the column defaults to my_organization_id(), hard rule 6)",
  /\.from\("drafts"\)\.insert\(/.test(deckBody) && !/organization_id/.test(deckBody)
);
ok(
  "generateDeckOutline never touches the send path: no sendFunderEmail, no send-draft import, no draft_send_attempts",
  deckBody.length > 0 && !/sendFunderEmail|send-draft|draft_send_attempts/.test(deckBody)
);
ok(
  "its failures finalize the run and RETURN the error -- never a rethrow production would redact",
  /catch\s*\(err\)\s*\{[\s\S]*finalizeRun\([\s\S]*return\s*\{\s*error:/.test(deckBody) && !/throw err/.test(deckBody)
);

// The UI side: the deck control sits behind the SAME approved-strategy
// gate as the other AI-draft buttons, and no deck draft can reach Send
// (SendSection is intro_email-only, asserted above); the approved deck
// card links to the read-only deck view, not to any send affordance.
ok(
  "the panel's deck handler carries the same approved-strategy gate as handleProposal (guard in the handler, button inside the strategyRunId block)",
  /function handleDeck\(\) \{\s*if \(!strategyRunId\) return;/.test(panelText) &&
    /strategyRunId && \([\s\S]{0,1400}Draft Deck Outline/.test(panelText)
);
{
  const deckLinkAt = panelText.indexOf('draft.kind === "deck" && (');
  const approvedBranchAt = panelText.indexOf("{isApproved && (");
  const confirmDialogAt = panelText.indexOf("<ConfirmDialog");
  ok(
    "an APPROVED deck draft's card links to the deck view route -- the link renders inside the isApproved branch only",
    deckLinkAt >= 0 &&
      approvedBranchAt >= 0 &&
      deckLinkAt > approvedBranchAt &&
      (confirmDialogAt < 0 || deckLinkAt < confirmDialogAt) &&
      /href=\{`\/prospects\/\$\{prospectId\}\/deck\/\$\{draft\.id\}`\}/.test(panelText),
    `deck link at ${deckLinkAt}, isApproved branch at ${approvedBranchAt}, ConfirmDialog at ${confirmDialogAt}`
  );
}

// --- 3e. updateDraft / deleteDraft: an approved draft is immutable ----------
// STATE item 67, load-bearing for item 66's invariant (a deck renders
// exactly what a human approved): the UI hiding edit controls on
// approved drafts was the only lock, so a stale card or hand-built
// request could rewrite or delete approved content. The guards live in
// the actions: re-read the draft's CURRENT status server-side, refuse
// approved with a RETURNED plain message (the composeDraft transport --
// production redacts thrown messages), leave status-'draft' edits and
// deletes exactly as they were. Sent drafts were already DB-pinned by
// 0069's trigger; DB pinning of approved-but-unsent is item 55, not here.

section("updateDraft / deleteDraft source: approved drafts are locked server-side");

const updateStart = draftActionsText.indexOf("export async function updateDraft");
const updateEnd = draftActionsText.indexOf("export async function", updateStart + 1);
const updateRaw = updateStart >= 0 ? draftActionsText.slice(updateStart, updateEnd < 0 ? undefined : updateEnd) : "";
const updateBody = updateRaw
  .split("\n")
  .map((l) => l.replace(/\/\/.*$/, ""))
  .join("\n");

const delStart = draftActionsText.indexOf("export async function deleteDraft");
const delEnd = draftActionsText.indexOf("export async function", delStart + 1);
const delRaw = delStart >= 0 ? draftActionsText.slice(delStart, delEnd < 0 ? undefined : delEnd) : "";
const delBody = delRaw
  .split("\n")
  .map((l) => l.replace(/\/\/.*$/, ""))
  .join("\n");

ok("updateDraft and deleteDraft both exist in draft-actions.ts", updateStart >= 0 && delStart >= 0);
ok(
  "updateDraft re-reads the draft's CURRENT status server-side BEFORE any write -- the client's belief is never trusted",
  updateBody.indexOf('.select("status")') >= 0 && updateBody.indexOf('.select("status")') < updateBody.indexOf(".update("),
  `select at ${updateBody.indexOf('.select("status")')}, update at ${updateBody.indexOf(".update(")}`
);
ok(
  "updateDraft refuses an APPROVED draft with a returned plain message, before the write",
  /if\s*\(existing\.status === "approved"\)\s*\{\s*return\s*\{\s*error:/.test(updateBody) &&
    updateBody.indexOf('existing.status === "approved"') < updateBody.indexOf(".update(")
);
ok(
  "updateDraft's refusal says the content is locked to what was approved and names un-approving as the edit path",
  /locked to exactly what was approved/.test(updateBody) && /un-approving/.test(updateBody)
);
ok(
  "updateDraft's write is additionally predicated on status 'draft' -- an approve landing between read and write makes it a no-op",
  /\.update\(\{[^}]*\}\)\s*[\s\S]{0,80}\.eq\("id", draftId\)\s*\.eq\("status", "draft"\)/.test(updateBody)
);
ok(
  "a status-'draft' edit is unchanged: the same update of subject, content and updated_at, and the action still ends in revalidatePath",
  /\.update\(\{ subject, content, updated_at: new Date\(\)\.toISOString\(\) \}\)/.test(updateBody) &&
    /revalidatePath\(`\/prospects\/\$\{prospectId\}`\)/.test(updateBody)
);
ok(
  "updateDraft's success path returns { ok: true } so callers can distinguish refusal from success",
  /return\s*\{\s*ok:\s*true\s*\}/.test(updateBody)
);
ok(
  "updateDraft's pre-existing DB-error transport is untouched: the update's own failure still throws",
  /if\s*\(error\)\s*throw new Error\(error\.message\)/.test(updateBody)
);

ok(
  "deleteDraft re-reads the draft's CURRENT status server-side BEFORE the delete",
  delBody.indexOf('.select("status")') >= 0 && delBody.indexOf('.select("status")') < delBody.indexOf(".delete()"),
  `select at ${delBody.indexOf('.select("status")')}, delete at ${delBody.indexOf(".delete()")}`
);
ok(
  "deleteDraft refuses an APPROVED draft with a returned plain message, before the delete",
  /if\s*\(existing\.status === "approved"\)\s*\{\s*return\s*\{\s*error:/.test(delBody) &&
    delBody.indexOf('existing.status === "approved"') < delBody.indexOf(".delete()")
);
ok(
  "deleteDraft's refusal says an approved draft can't be deleted and names un-approving as the path",
  /can't be deleted/.test(delBody) && /un-approving/.test(delBody)
);
ok(
  "deleteDraft's delete is additionally predicated on status 'draft' -- only an unapproved draft is deletable here",
  /\.delete\(\)\.eq\("id", draftId\)\.eq\("status", "draft"\)/.test(delBody)
);
ok(
  "deleteDraft's success path returns { ok: true }, and its pre-existing DB-error throw is untouched",
  /return\s*\{\s*ok:\s*true\s*\}/.test(delBody) && /if\s*\(error\)\s*throw new Error\(error\.message\)/.test(delBody)
);

// approveDraft itself is deliberately untouched by item 67 -- approving
// stays exactly as it was (the guard is on EDITING an approved draft,
// not on approving a draft one).
const approveStart = draftActionsText.indexOf("export async function approveDraft");
const approveEnd = draftActionsText.indexOf("export async function", approveStart + 1);
const approveBody = (approveStart >= 0 ? draftActionsText.slice(approveStart, approveEnd < 0 ? undefined : approveEnd) : "")
  .split("\n")
  .map((l) => l.replace(/\/\/.*$/, ""))
  .join("\n");
ok(
  "approveDraft is untouched: no status re-read added, same single update writing status/approved_by/approved_at",
  approveStart >= 0 &&
    !/\.select\("status"\)/.test(approveBody) &&
    /\.update\(\{ status: "approved", approved_by: user\.id, approved_at: new Date\(\)\.toISOString\(\) \}\)/.test(approveBody)
);

// The UI side: the returned refusals are displayed, not swallowed, and
// the Approve chain stops when its save is refused (otherwise it would
// re-stamp approved_by/approved_at on an already-approved draft).
ok(
  "the panel displays the returned refusal (actionError state fed by both actions' results)",
  /const \[actionError, setActionError\] = useState<string \| null>\(null\)/.test(panelText) &&
    /\{actionError && \(/.test(panelText)
);
ok(
  "the panel's Approve click checks updateDraft's result and STOPS before approveDraft when the save was refused",
  /const saved = await updateDraft\(draft\.id, prospectId, isEmail \? subject : null, content\);\s*if \("error" in saved\) \{\s*setActionError\(saved\.error\);\s*return;\s*\}/.test(
    panelText
  )
);
ok(
  "the panel's delete confirmation surfaces deleteDraft's returned refusal",
  /const removed = await deleteDraft\(draft\.id, prospectId\);\s*setActionError\("error" in removed \? removed\.error : null\)/.test(panelText)
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
  // STATE item 63: even approved, with a valid recipient, subject and
  // body, a proposal draft is refused by the FIRST check -- the send
  // path is intro_email only, and every downstream precondition is
  // unreachable for it.
  const r = evaluateSendReadiness({ ...baseDraft, kind: "proposal" }, [], "funder@example.org", baseSender);
  ok("a proposal draft can NEVER be sent -- refused as not_email before any other precondition", !r.ok && r.code === "not_email");
}
{
  // STATE item 66: the deck outline gets the same first-check refusal.
  // Even approved, with a valid recipient, subject and body, kind 'deck'
  // never reaches any downstream precondition -- the send path is
  // intro_email only.
  const r = evaluateSendReadiness({ ...baseDraft, kind: "deck" }, [], "funder@example.org", baseSender);
  ok("a deck draft can NEVER be sent -- refused as not_email before any other precondition", !r.ok && r.code === "not_email");
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

  // Migration 0070's columns, probed the same way: absent means item 59's
  // schema is not applied yet. Its checks report NOT EVALUATED (not a
  // pass), and the birth rows below are born without the identity columns
  // -- which is exactly what a 0069-only database legally accepts.
  const { error: identityProbeError } = await admin.from("draft_send_attempts").select("from_identity, reply_to").limit(1);
  const hasIdentityColumns = !identityProbeError;
  if (!hasIdentityColumns) {
    console.log(
      "NOT EVALUATED: from_identity / reply_to do not exist in this database -- migration 0070 is not applied. The identity-capture checks are not a pass."
    );
    notEvaluated.push("DB assertions for from_identity/reply_to -- migration 0070 not applied");
  }

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

    // The identity the payload would carry (item 59), captured at birth
    // when the columns exist -- the same shape the handler writes.
    const FROM_IDENTITY = `"${ORG_NAME}" <outreach@platform.example>`;
    const birthRow = {
      draft_id: draft.id,
      recipient_email: "funder@example.org",
      subject: "Test subject",
      body: "Test body",
      attempted_by: userId,
      organization_id: orgId,
      ...(hasIdentityColumns ? { from_identity: FROM_IDENTITY, reply_to: EMAIL } : {}),
    };

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

    if (hasIdentityColumns) {
      ok(
        "the birth captures the sender identity verbatim: from_identity and reply_to stored exactly as handed over (item 59)",
        born.from_identity === FROM_IDENTITY && born.reply_to === EMAIL,
        `stored: ${born.from_identity} / ${born.reply_to}`
      );
    }

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

    if (hasIdentityColumns) {
      // The extended pin (item 59): an otherwise-legal finalization that
      // also rewrites an identity column is refused -- the org renaming
      // itself later cannot reach back into what was already sent.
      const { error: fromPinError } = await admin
        .from("draft_send_attempts")
        .update({ outcome: "sent", completed_at: new Date().toISOString(), resend_message_id: "msg-123", from_identity: `"Renamed Org" <outreach@platform.example>` })
        .eq("id", born.id);
      ok("a finalization cannot rewrite from_identity -- the identity sent is pinned at birth (item 59)", !!fromPinError, fromPinError?.message ?? "no error");
      const { error: replyPinError } = await admin
        .from("draft_send_attempts")
        .update({ outcome: "sent", completed_at: new Date().toISOString(), resend_message_id: "msg-123", reply_to: "someone-else@example.org" })
        .eq("id", born.id);
      ok("a finalization cannot rewrite reply_to either", !!replyPinError, replyPinError?.message ?? "no error");
    }

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
