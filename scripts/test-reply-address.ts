// STATE item 106, rulings 0042 and 0043: a funder's reply goes to the human who sent the
// email, at an address that human chose, shown exactly as it will be sent.
//
// What this tests, offline (no database, no network, no mail is ever sent):
//   1. resolveReplyTo, the ONE function that turns the signed-in user into the
//      reply address: a chosen address is used; unset / empty / non-string /
//      implausible / multi-address values fall back to the account email;
//      a chosen address EQUAL to the platform sending address IS used (ruling
//      0043: writing from and replying to one mailbox is valid) and the
//      resolver takes no from-address at all;
//      clearing returns to the account email; two people through the same
//      function do not affect each other.
//   2. The two call sites. Source scans: the send handler and the prospect page
//      both call resolveReplyTo and neither reads the account email for the
//      reply any more. Then the ACTUAL argument expressions are lifted out of
//      both files and evaluated, and the REAL send handler (sendApprovedDraft)
//      is run against a fake database and a fake provider, so "the confirmation
//      shows what is sent" and "the attempt records it at birth, before the
//      provider is called" are executed, not just read.
//   3. The settings control's write path (lib/reply-address.ts and the action
//      beside it): shape-checked on the server, the sending address accepted (0043),
//      one key written through the session client, other metadata keys left
//      alone (against a fake that models Supabase Auth's merge), clearing
//      removes the key, errors returned and never thrown, no admin client.
//
// What this does NOT test (and cannot offline): that the live Supabase project
// really merges user_metadata and deletes a key on null (verified in the
// open-source auth server's source, not against this project), a real send, or
// the settings page in a browser.
//
// Usage: npx tsx scripts/test-reply-address.ts

import { readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import {
  resolveReplyTo,
  isPlausibleChosenReplyAddress,
  evaluateSendReadiness,
  REPLY_TO_METADATA_KEY,
  type SendPayload,
} from "../lib/draft-send";
import { saveReplyAddressCore, clearReplyAddressCore, REPLY_ADDRESS_INVALID_MESSAGE } from "../lib/reply-address";

const root = join(__dirname, "..");

let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
function check(label: string, actual: unknown, expected: unknown) {
  const good = JSON.stringify(actual) === JSON.stringify(expected);
  ok(label, good, `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`);
}
function section(t: string) {
  console.log(`\n--- ${t} ---`);
}

const FROM = "outreach@platform.example";
// (declared early: used by the resolver section below; the call-site section reuses it)
function stripCommentsEarly(t: string) {
  return t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
}
const ACCOUNT = "owner@agency.example";
const CHOSEN = "grants@village.example";

// --- 1. resolveReplyTo -------------------------------------------------------

section("resolveReplyTo: a chosen address is used, anything else falls back to the account email");

check("the metadata key is reply_to_email", REPLY_TO_METADATA_KEY, "reply_to_email");
check(
  "a plausible chosen address is used, and the source says it was chosen",
  resolveReplyTo({ accountEmail: ACCOUNT, metadata: { reply_to_email: CHOSEN } }),
  { address: CHOSEN, source: "chosen" }
);
check(
  "a chosen address is trimmed",
  resolveReplyTo({ accountEmail: ACCOUNT, metadata: { reply_to_email: `  ${CHOSEN}\n` } }),
  { address: CHOSEN, source: "chosen" }
);
check(
  "unset: the account email, source 'account'",
  resolveReplyTo({ accountEmail: ACCOUNT, metadata: {} }),
  { address: ACCOUNT, source: "account" }
);
for (const [label, md] of [
  ["metadata undefined", undefined],
  ["metadata null", null],
  ["metadata a string", "reply_to_email"],
  ["metadata an array", [CHOSEN]],
  ["empty string", { reply_to_email: "" }],
  ["whitespace only", { reply_to_email: "   " }],
  ["null value", { reply_to_email: null }],
  ["number", { reply_to_email: 42 }],
  ["boolean", { reply_to_email: true }],
  ["array", { reply_to_email: [CHOSEN] }],
  ["object", { reply_to_email: { address: CHOSEN } }],
  ["no @ at all", { reply_to_email: "grants" }],
  ["no dot after the @", { reply_to_email: "grants@village" }],
  ["a name with a space", { reply_to_email: "Grants Team grants@village.example" }],
  ["a name with angle brackets", { reply_to_email: "Grants <grants@village.example>" }],
  ["two addresses, comma", { reply_to_email: `${CHOSEN},${FROM}` }],
  ["two addresses, semicolon", { reply_to_email: `${CHOSEN};other@village.example` }],
  ["two @ signs", { reply_to_email: "a@b@village.example" }],
  ["a quote", { reply_to_email: 'gr"ants@village.example' }],
  ["a newline (header injection)", { reply_to_email: `${CHOSEN}\nBcc: x@y.example` }],
  ["a newline with no second @ (header injection)", { reply_to_email: `${CHOSEN}\nBcc: someone` }],
  ["over 254 characters", { reply_to_email: `${"a".repeat(250)}@v.example` }],
] as [string, unknown][]) {
  check(`${label}: falls back to the account email`, resolveReplyTo({ accountEmail: ACCOUNT, metadata: md }), {
    address: ACCOUNT,
    source: "account",
  });
}

for (const [spelling, value] of [
  ["exactly as configured", FROM],
  ["upper case", "OutReach@Platform.EXAMPLE"],
  ["surrounded by whitespace and a newline", `  ${FROM}\n`],
  ["upper case and surrounded by whitespace", ` ${FROM.toUpperCase()} `],
] as [string, string][]) {
  check(
    `a chosen address equal to the sending address (${spelling}) IS used, source 'chosen' (ruling 0043: no exclusion)`,
    resolveReplyTo({ accountEmail: ACCOUNT, metadata: { reply_to_email: value } }),
    { address: value.trim(), source: "chosen" }
  );
}
check(
  "a chosen value that merely contains the sending address as one of two is still refused as a list, and falls back",
  resolveReplyTo({ accountEmail: ACCOUNT, metadata: { reply_to_email: `x@y.example,${FROM}` } }).source,
  "account"
);
{
  // The resolver's input has no from-address, so it cannot fall back because of one.
  const src = stripCommentsEarly(readFileSync(join(root, "lib/draft-send.ts"), "utf8"));
  const sig = src.match(/export function resolveReplyTo\(input: \{([\s\S]*?)\}\): ResolvedReplyTo/)?.[1] ?? "";
  ok("resolveReplyTo takes no from-address: its input is exactly { accountEmail, metadata }", /accountEmail/.test(sig) && /metadata/.test(sig) && !/fromAddress|from/.test(sig.replace(/accountEmail|metadata/g, "")), sig);
  const body = src.slice(src.indexOf("export function resolveReplyTo"), src.indexOf("export type DraftSendAttempt"));
  ok("...and its body never lowercases or compares anything to a sending address (no process.env, no RESEND, no fromAddress)", !/fromAddress|process\.env|RESEND|toLowerCase/.test(body));
}
check("no chosen address and no account email: address null (the readiness check then refuses)", resolveReplyTo({ accountEmail: null, metadata: {} }), {
  address: null,
  source: "account",
});
check("an undefined account email is null too", resolveReplyTo({ accountEmail: undefined, metadata: undefined }).address, null);
check(
  "a chosen address works even when the account has no email",
  resolveReplyTo({ accountEmail: null, metadata: { reply_to_email: CHOSEN } }),
  { address: CHOSEN, source: "chosen" }
);
ok("the shape predicate agrees with the resolver on the good case and refuses non-strings", isPlausibleChosenReplyAddress(CHOSEN) && !isPlausibleChosenReplyAddress(42) && !isPlausibleChosenReplyAddress(null));

{
  // Clearing: the key is removed (see the merge model below), so the same
  // function returns to the account email.
  const withChoice = { reply_to_email: CHOSEN, full_name: "Pat" };
  const { reply_to_email: _gone, ...cleared } = withChoice; // eslint-disable-line @typescript-eslint/no-unused-vars
  void _gone;
  check("clearing (key removed) returns to the account email", resolveReplyTo({ accountEmail: ACCOUNT, metadata: cleared }), {
    address: ACCOUNT,
    source: "account",
  });
}

{
  // Another person's choice never changes whose replies go where: two
  // identities through the same function, in both orders.
  const a = { accountEmail: "pat@agency.example", metadata: { reply_to_email: "pat@village.example" } };
  const b = { accountEmail: "sam@agency.example", metadata: { full_name: "Sam" } };
  const ra1 = resolveReplyTo(a);
  const rb = resolveReplyTo(b);
  const ra2 = resolveReplyTo(a);
  ok("person A's choice is A's", ra1.address === "pat@village.example" && ra1.source === "chosen");
  ok("person B, same function, no choice: B's own account email (A's choice did not leak)", rb.address === "sam@agency.example" && rb.source === "account");
  check("A's result is unchanged after B was resolved (no shared state)", ra2, ra1);
}

// --- 2. The two call sites ---------------------------------------------------

section("call sites: both run resolveReplyTo, neither reads the account email for the reply");

const stripComments = (t: string) => t.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|\s)\/\/.*$/gm, "$1");
const PAGE_PATH = "app/(dashboard)/prospects/[id]/page.tsx";
const HANDLER_PATH = "app/(dashboard)/prospects/[id]/send-actions.ts";
const SEND_MODULE_PATH = "lib/send-draft.ts";
const pageText = stripComments(readFileSync(join(root, PAGE_PATH), "utf8"));
const handlerText = stripComments(readFileSync(join(root, HANDLER_PATH), "utf8"));

const CALL = /resolveReplyTo\(\{[\s\S]*?\}\)/;
const pageCall = pageText.match(CALL)?.[0] ?? "";
const handlerCall = handlerText.match(CALL)?.[0] ?? "";
ok("the prospect page (builds the confirmation) calls resolveReplyTo", /import\s*\{[^}]*\bresolveReplyTo\b[^}]*\}\s*from\s*"@\/lib\/draft-send"/.test(pageText) && pageCall !== "");
ok("the send handler calls resolveReplyTo", /import\s*\{[^}]*\bresolveReplyTo\b[^}]*\}\s*from\s*"@\/lib\/draft-send"/.test(handlerText) && handlerCall !== "");
check("each call site calls it exactly once", [(pageText.match(/resolveReplyTo\(/g) ?? []).length, (handlerText.match(/resolveReplyTo\(/g) ?? []).length], [1, 1]);
const ACCOUNT_EMAIL_READ = /user\??\.email|userEmail|session\??\.user\??\.email/;
ok(
  "the page reads the account email nowhere outside the resolveReplyTo call (no user?.email for the reply)",
  !ACCOUNT_EMAIL_READ.test(pageText.replace(pageCall, "")),
  pageText.replace(pageCall, "").match(ACCOUNT_EMAIL_READ)?.[0] ?? ""
);
ok(
  "the handler reads the account email nowhere outside the resolveReplyTo call (no user.email for the reply)",
  !ACCOUNT_EMAIL_READ.test(handlerText.replace(handlerCall, "")),
  handlerText.replace(handlerCall, "").match(ACCOUNT_EMAIL_READ)?.[0] ?? ""
);
ok(
  "neither passes a userEmail to the readiness check any more (the type no longer has the field)",
  !/userEmail/.test(pageText + handlerText) && /replyToAddress:\s*replyToResolved\.address/.test(pageText) && /replyToAddress:\s*replyTo\.address/.test(handlerText)
);
ok(
  "both call sites hand the resolver exactly the account email and the user's metadata -- the same two inputs, no from-address (ruling 0043)",
  /accountEmail:\s*user\??\.email/.test(pageCall) &&
    /metadata:\s*user\??\.user_metadata/.test(pageCall) &&
    !/fromAddress|RESEND|sendFromAddress/.test(pageCall) &&
    /accountEmail:\s*user\??\.email/.test(handlerCall) &&
    /metadata:\s*user\??\.user_metadata/.test(handlerCall) &&
    !/fromAddress|RESEND|platformFromAddress/.test(handlerCall)
);
ok(
  "only the prospect page, the send handler, the settings page and lib/draft-send.ts reference resolveReplyTo -- the confirmation and the send are the only consumers of the reply for a message",
  (() => {
    // A closed set over app/ and lib/: the resolver must not be called from a
    // third place that assembles its own payload.
    const { readdirSync, statSync } = require("node:fs") as typeof import("node:fs"); // eslint-disable-line @typescript-eslint/no-require-imports
    const hits: string[] = [];
    const walk = (dir: string) => {
      for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === ".next") continue;
        const p = join(dir, name);
        if (statSync(p).isDirectory()) walk(p);
        else if (/\.(ts|tsx)$/.test(name) && /resolveReplyTo\(/.test(stripComments(readFileSync(p, "utf8")))) hits.push(p.slice(root.length + 1));
      }
    };
    walk(join(root, "app"));
    walk(join(root, "lib"));
    hits.sort();
    return JSON.stringify(hits) === JSON.stringify([HANDLER_PATH, PAGE_PATH, "app/(dashboard)/settings/reply-address/page.tsx", "lib/draft-send.ts"].sort());
  })()
);

// The panel (confirmation dialog) renders payload.replyTo from the same
// evaluateSendReadiness the handler runs; it never assembles its own.
const panelText = stripComments(readFileSync(join(root, "app/(dashboard)/prospects/[id]/draft-panel.tsx"), "utf8"));
ok(
  "the confirmation dialog shows payload.replyTo from evaluateSendReadiness and has no reply address of its own",
  panelText.includes("{payload.replyTo}") && panelText.includes("evaluateSendReadiness(") && !/user_metadata|resolveReplyTo|\.email\b/.test(panelText)
);

// --- The real call-site expressions, evaluated -------------------------------

section("confirmation payload = send payload: the real call-site expressions and the real handler, run");

const draft = { id: "d1", prospect_id: "p1", kind: "intro_email" as const, subject: "Hello", content: "Body text", status: "approved" as const, sent_at: null };
const ORG = "Village Worship Initiative";
const CONTACT = "funder@example.org";

type FakeUser = { id: string; email?: string | null; user_metadata?: unknown };

// What the prospect page does with the signed-in user, executed from the
// page's own source: its resolveReplyTo(...) call and the expression it puts in
// sender.replyToAddress.
function pageSender(user: FakeUser, fromEnv: string | null) {
  const exprMatch = pageText.match(/replyToAddress:\s*([^,\n}]+)/);
  const bind = pageText.match(/const\s+(\w+)\s*=\s*resolveReplyTo\(/);
  if (!pageCall || !exprMatch || !bind) throw new Error("page call-site shape not found");
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  const fn = new Function("resolveReplyTo", "user", "sendFromAddress", `const ${bind[1]} = ${pageCall}; return (${exprMatch[1].trim()});`);
  return { orgName: ORG, fromAddress: fromEnv, replyToAddress: fn(resolveReplyTo, user, fromEnv) as string | null };
}
function confirmationFor(user: FakeUser, fromEnv: string | null) {
  return evaluateSendReadiness(draft, [], CONTACT, pageSender(user, fromEnv), true);
}

// --- The real handler against a fake database and a fake provider ---

type LogEntry = { kind: "db"; table: string; op: string; payload?: unknown } | { kind: "provider"; payload: SendPayload };
function makeWorld(user: FakeUser) {
  const log: LogEntry[] = [];
  const tables: Record<string, unknown> = {
    drafts: draft,
    prospects: { id: "p1", contact_email: CONTACT },
    org_profile: { name: ORG },
    org_sending_enablement: { enabled: true },
  };
  class Q {
    op = "select";
    payload: unknown;
    constructor(private table: string) {}
    select() {
      return this;
    }
    insert(p: unknown) {
      this.op = "insert";
      this.payload = p;
      return this;
    }
    update(p: unknown) {
      this.op = "update";
      this.payload = p;
      return this;
    }
    eq() {
      return this;
    }
    is() {
      return this;
    }
    limit() {
      return this;
    }
    returns() {
      return this;
    }
    private done(single: boolean) {
      log.push({ kind: "db", table: this.table, op: this.op, payload: this.payload });
      if (this.op === "insert" && this.table === "draft_send_attempts") return { data: { id: "att-1" }, error: null };
      if (this.op !== "select") return { data: null, error: null };
      if (this.table === "draft_send_attempts") return { data: [], error: null };
      return { data: single ? (tables[this.table] ?? null) : null, error: null };
    }
    maybeSingle() {
      return Promise.resolve(this.done(true));
    }
    single() {
      return Promise.resolve(this.done(true));
    }
    then(res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) {
      return Promise.resolve(this.done(false)).then(res, rej);
    }
  }
  const client = {
    auth: { getUser: async () => ({ data: { user } }) },
    from: (table: string) => new Q(table),
  };
  return { log, client };
}

// Stub what the handler imports that needs a request context or a provider.
const cache = require.cache as unknown as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-require-imports
const touched = new Map<string, unknown>();
const stub = (abs: string, exports: Record<string, unknown>) => {
  if (!touched.has(abs)) touched.set(abs, cache[abs]);
  cache[abs] = { id: abs, filename: abs, loaded: true, exports, children: [], paths: [] };
};
let current = makeWorld({ id: "u0" });
const handlerAbs = require.resolve(join(root, HANDLER_PATH)); // eslint-disable-line @typescript-eslint/no-require-imports
const FROM_ENV_FOR_RUN = FROM;
stub(require.resolve("next/cache"), { revalidatePath() {} }); // eslint-disable-line @typescript-eslint/no-require-imports
stub(require.resolve(join(root, "lib/supabase/server.ts")), { createClient: () => current.client }); // eslint-disable-line @typescript-eslint/no-require-imports
stub(require.resolve(join(root, SEND_MODULE_PATH)), { // eslint-disable-line @typescript-eslint/no-require-imports
  isSendConfigured: () => true,
  platformFromAddress: () => FROM_ENV_FOR_RUN,
  sendFunderEmail: async (payload: SendPayload) => {
    current.log.push({ kind: "provider", payload });
    return { status: "sent", providerMessageId: "msg-test-1" };
  },
});
delete cache[handlerAbs];

async function runSend(user: FakeUser) {
  current = makeWorld(user);
  const mod = require(handlerAbs) as { sendApprovedDraft: (draftId: string, prospectId: string) => Promise<{ error: string } | { success: true }> }; // eslint-disable-line @typescript-eslint/no-require-imports
  const result = await mod.sendApprovedDraft("d1", "p1");
  const provider = current.log.find((e) => e.kind === "provider");
  const birth = current.log.find((e) => e.kind === "db" && e.table === "draft_send_attempts" && e.op === "insert");
  const birthIdx = current.log.findIndex((e) => e === birth);
  const providerIdx = current.log.findIndex((e) => e === provider);
  return {
    result,
    providerPayload: provider && provider.kind === "provider" ? provider.payload : null,
    birthRow: birth && birth.kind === "db" ? (birth.payload as Record<string, unknown>) : null,
    birthIdx,
    providerIdx,
  };
}

async function main() {
  try {
    const users: [string, FakeUser][] = [
      ["a person who chose an address", { id: "u1", email: ACCOUNT, user_metadata: { reply_to_email: CHOSEN, full_name: "Pat" } }],
      ["a person with no choice", { id: "u2", email: "sam@agency.example", user_metadata: { full_name: "Sam" } }],
      ["a person whose stored value is junk", { id: "u3", email: "lee@agency.example", user_metadata: { reply_to_email: "not an address" } }],
      ["a person whose choice is the sending address, upper case (ruling 0043)", { id: "u4", email: "kim@agency.example", user_metadata: { reply_to_email: ` ${FROM.toUpperCase()} ` } }],
      ["a person whose choice is exactly the sending address (ruling 0043)", { id: "u6", email: "kanjii@agency.example", user_metadata: { reply_to_email: FROM } }],
    ];
    const expected: Record<string, string> = { u1: CHOSEN, u2: "sam@agency.example", u3: "lee@agency.example", u4: FROM.toUpperCase(), u6: FROM };

    for (const [label, user] of users) {
      const confirmation = confirmationFor(user, FROM);
      const sent = await runSend(user);
      ok(`${label}: the real handler sends`, "success" in sent.result && sent.providerPayload !== null, JSON.stringify(sent.result));
      ok(`${label}: the confirmation is ready and shows the expected reply address (${expected[user.id]})`, confirmation.ok && confirmation.payload.replyTo === expected[user.id]);
      check(`${label}: the confirmation payload EQUALS the payload handed to the provider (every field)`, confirmation.ok ? confirmation.payload : null, sent.providerPayload);
      ok(
        `${label}: the attempt row records the reply address at birth, and it is the one the provider got`,
        sent.birthRow !== null && sent.birthRow.reply_to === expected[user.id] && sent.birthRow.reply_to === sent.providerPayload?.replyTo,
        JSON.stringify(sent.birthRow)
      );
      ok(`${label}: the attempt is born BEFORE the provider is called (ruling 0029 clause 4)`, sent.birthIdx >= 0 && sent.providerIdx > sent.birthIdx, `birth ${sent.birthIdx}, provider ${sent.providerIdx}`);
      ok(
        `${label}: the reply address is exactly the one the person's own choice or account gives -- never one the platform picked`,
        sent.providerPayload !== null && sent.providerPayload.replyTo === expected[user.id]
      );
      ok(
        `${label}: the from identity is untouched by the choice (still "{org}" <platform address>)`,
        sent.providerPayload?.from === `"${ORG}" <${FROM}>` && sent.birthRow?.from_identity === `"${ORG}" <${FROM}>`
      );
    }

    {
      // Ruling 0043 test of compliance, stated outright: the reply address EQUALS
      // the sending address; the confirmation, the provider payload and the
      // attempt row at birth all carry it.
      const user: FakeUser = { id: "u7", email: "kanjii@agency.example", user_metadata: { reply_to_email: FROM } };
      const confirmation = confirmationFor(user, FROM);
      const sent = await runSend(user);
      ok(
        "reply address == sending address: the confirmation shows it, the provider gets it, and the attempt row records it at birth (before the provider call)",
        confirmation.ok &&
          confirmation.payload.replyTo === FROM &&
          sent.providerPayload?.replyTo === FROM &&
          sent.birthRow?.reply_to === FROM &&
          sent.birthIdx >= 0 &&
          sent.providerIdx > sent.birthIdx &&
          sent.providerPayload?.from === `"${ORG}" <${FROM}>`,
        JSON.stringify({ c: confirmation.ok ? confirmation.payload.replyTo : confirmation.reason, p: sent.providerPayload?.replyTo, b: sent.birthRow?.reply_to })
      );
    }

    {
      // Hand-off between people, same process, in sequence: A's choice must not
      // colour B's send.
      const a = await runSend(users[0][1]);
      const b = await runSend(users[1][1]);
      ok("a second person sending after the first goes to their own account email, not the first person's choice", a.providerPayload?.replyTo === CHOSEN && b.providerPayload?.replyTo === "sam@agency.example");
    }

    {
      // A person with no usable address at all is refused before a birth.
      const none = await runSend({ id: "u5", email: null, user_metadata: {} });
      ok(
        "no choice and no account email: refused in plain words, no attempt born, nothing sent",
        "error" in none.result && none.birthRow === null && none.providerPayload === null && /reply/i.test(none.result.error),
        JSON.stringify(none.result)
      );
    }

    {
      // Where the stored value is changed after a send, the attempt is not.
      const before = await runSend(users[0][1]);
      const changed: FakeUser = { ...users[0][1], user_metadata: { reply_to_email: "new@village.example" } };
      const after = await runSend(changed);
      ok(
        "changing the choice changes only later sends: the earlier attempt row keeps the address it was born with",
        before.birthRow?.reply_to === CHOSEN && after.birthRow?.reply_to === "new@village.example"
      );
    }
  } finally {
    for (const [abs, prev] of touched) {
      if (prev === undefined) delete cache[abs];
      else cache[abs] = prev;
    }
    delete cache[handlerAbs];
  }

  // --- 3. The settings control's write path -----------------------------------

  section("settings control: server-side shape check, one key, merged not replaced, errors returned");

  // A fake that models the documented behaviour of Supabase Auth's
  // updateUser({ data }) (supabase/auth internal/models/user.go,
  // UpdateUserMetaData): top-level MERGE into the existing user_metadata; a key
  // whose value is null is DELETED; unmentioned keys are untouched. This
  // asserts our understanding of that contract. It is a model, not the live
  // service.
  function fakeAuth(initial: Record<string, unknown>, opts: { failWith?: string; throwWith?: string } = {}) {
    const state = { metadata: { ...initial } as Record<string, unknown>, calls: [] as unknown[] };
    return {
      state,
      client: {
        auth: {
          async updateUser(attrs: { data: Record<string, string | null> }) {
            state.calls.push(attrs);
            if (opts.throwWith) throw new Error(opts.throwWith);
            if (opts.failWith) return { error: { message: opts.failWith } };
            for (const [k, v] of Object.entries(attrs.data)) {
              if (v === null) delete state.metadata[k];
              else state.metadata[k] = v;
            }
            return { error: null };
          },
        },
      },
    };
  }

  {
    const model = fakeAuth({ a: 1, b: 2 });
    await model.client.auth.updateUser({ data: { b: "x", c: "y" } });
    check("(the fake itself) a merge sets given keys and leaves unmentioned ones alone", model.state.metadata, { a: 1, b: "x", c: "y" });
    await model.client.auth.updateUser({ data: { a: null } });
    check("(the fake itself) a null value deletes just that key", model.state.metadata, { b: "x", c: "y" });
  }

  const sdkPath = join(root, "node_modules/@supabase/auth-js/src/GoTrueClient.ts");
  if (existsSync(sdkPath)) {
    const sdk = readFileSync(sdkPath, "utf8");
    const start = sdk.indexOf("protected async _updateUser(");
    const body = start >= 0 ? sdk.slice(start, start + 2500) : "";
    ok(
      "the installed SDK's updateUser PUTs the attributes to /user as given and does no client-side merge or replace (the merge is the server's)",
      /'PUT',\s*`\$\{this\.url\}\/user`/.test(body) && /\.\.\.attributes/.test(body) && !/user_metadata/.test(body),
      "shape of _updateUser in node_modules/@supabase/auth-js not as expected"
    );
  } else {
    console.log("SKIP: node_modules/@supabase/auth-js not installed -- SDK shape not checked");
  }

  {
    const model = fakeAuth({ full_name: "Pat", avatar_url: "https://x.example/p.png", reply_to_email: "old@village.example", prefs: { a: 1 } });
    const r = await saveReplyAddressCore({ supabase: model.client, input: `  ${CHOSEN} ` });
    ok("saving a good address succeeds and reports the trimmed address", "ok" in r && r.address === CHOSEN, JSON.stringify(r));
    check("exactly one updateUser call, whose payload is exactly { data: { reply_to_email } } -- nothing else is written", model.state.calls, [{ data: { reply_to_email: CHOSEN } }]);
    check("the person's OTHER metadata keys are all still there, untouched (merged, not replaced)", model.state.metadata, {
      full_name: "Pat",
      avatar_url: "https://x.example/p.png",
      reply_to_email: CHOSEN,
      prefs: { a: 1 },
    });
    check(
      "the saved value then resolves as the chosen address (write side and read side agree)",
      resolveReplyTo({ accountEmail: ACCOUNT, metadata: model.state.metadata }),
      { address: CHOSEN, source: "chosen" }
    );
    const c = await clearReplyAddressCore({ supabase: model.client });
    ok("clearing succeeds", "ok" in c && c.address === null, JSON.stringify(c));
    check("clearing sends exactly { data: { reply_to_email: null } }", model.state.calls[1], { data: { reply_to_email: null } });
    check("clearing removes only that key; the rest remain", model.state.metadata, { full_name: "Pat", avatar_url: "https://x.example/p.png", prefs: { a: 1 } });
    check(
      "after clearing, the resolver returns to the account email",
      resolveReplyTo({ accountEmail: ACCOUNT, metadata: model.state.metadata }),
      { address: ACCOUNT, source: "account" }
    );
  }

  for (const [label, input] of [
    ["not an address", "grants"],
    ["no dot", "grants@village"],
    ["two addresses", `${CHOSEN},other@village.example`],
    ["a display name", "Grants <grants@village.example>"],
    ["a newline", `${CHOSEN}\nBcc: x@y.example`],
    ["a newline with no second @", `${CHOSEN}\nBcc: someone`],
    ["too long", `${"a".repeat(250)}@v.example`],
  ] as [string, string][]) {
    const model = fakeAuth({ full_name: "Pat" });
    const r = await saveReplyAddressCore({ supabase: model.client, input });
    ok(`server-side shape check refuses ${label}, with a plain message, and writes nothing`, "error" in r && r.error === REPLY_ADDRESS_INVALID_MESSAGE && model.state.calls.length === 0, JSON.stringify(r));
  }
  for (const [label, input] of [
    ["empty", ""],
    ["whitespace", "   "],
    ["a number", 42],
    ["null", null],
    ["undefined", undefined],
    ["an object", { a: 1 }],
  ] as [string, unknown][]) {
    const model = fakeAuth({});
    const r = await saveReplyAddressCore({ supabase: model.client, input });
    ok(`${label} input is refused (an error is returned) and nothing is written`, "error" in r && model.state.calls.length === 0, JSON.stringify(r));
  }
  for (const [spelling, typed] of [
    ["exactly as configured", FROM],
    ["upper case", FROM.toUpperCase()],
    ["with surrounding whitespace", `  ${FROM} `],
  ] as [string, string][]) {
    const model = fakeAuth({ full_name: "Kanjii" });
    const r = await saveReplyAddressCore({ supabase: model.client, input: typed });
    ok(
      `an address equal to the sending address (${spelling}) is ACCEPTED and written, as typed and trimmed (ruling 0043: no refusal)`,
      "ok" in r && r.address === typed.trim() && JSON.stringify(model.state.calls) === JSON.stringify([{ data: { reply_to_email: typed.trim() } }]) && model.state.metadata.reply_to_email === typed.trim(),
      JSON.stringify(r)
    );
    check(
      `...and it then resolves as the chosen address (${spelling})`,
      resolveReplyTo({ accountEmail: ACCOUNT, metadata: model.state.metadata }),
      { address: typed.trim(), source: "chosen" }
    );
  }
  {
    const model = fakeAuth({}, { failWith: "JWT expired" });
    const r = await saveReplyAddressCore({ supabase: model.client, input: CHOSEN });
    ok("a service error is RETURNED with its message, not thrown", "error" in r && /JWT expired/.test(r.error), JSON.stringify(r));
    const c = await clearReplyAddressCore({ supabase: model.client });
    ok("...and the same for clearing", "error" in c && /JWT expired/.test(c.error), JSON.stringify(c));
  }
  {
    const model = fakeAuth({}, { throwWith: "network down" });
    let threw = false;
    let r: unknown = null;
    let c: unknown = null;
    try {
      r = await saveReplyAddressCore({ supabase: model.client, input: CHOSEN });
      c = await clearReplyAddressCore({ supabase: model.client });
    } catch {
      threw = true;
    }
    ok("even a client that THROWS yields a returned error, never an exception out of the action core", !threw && !!r && !!c && "error" in (r as object) && "error" in (c as object));
  }

  // The new files, read.
  const newFiles = [
    "lib/reply-address.ts",
    "app/(dashboard)/settings/reply-address/actions.ts",
    "app/(dashboard)/settings/reply-address/page.tsx",
    "app/(dashboard)/settings/reply-address/reply-address-form.tsx",
  ];
  const newText = newFiles.map((f) => stripComments(readFileSync(join(root, f), "utf8")));
  const allNew = newText.join("\n");
  ok("the new files use no admin client and no service role (the session client only)", !/createAdminClient|service[_-]?role|SERVICE_ROLE|admin\./i.test(allNew));
  ok("the new files never call supabase.from(...) -- no table is read or written by this control", !/\.from\(/.test(allNew));
  ok("the only auth write is auth.updateUser, in lib/reply-address.ts, and it is called twice (set, clear)", (allNew.match(/\.updateUser\(/g) ?? []).length === 2 && /\.updateUser\(/.test(newText[0]));
  ok("every updateUser writes only the computed REPLY_TO_METADATA_KEY inside data -- no other key, no email, no password", (newText[0].match(/updateUser\(\{ data: \{ \[REPLY_TO_METADATA_KEY\]: [^}]+\} \}\)/g) ?? []).length === 2);
  ok("the action file's two exports take no user id -- they act only on the signed-in session's own user", /saveReplyAddress\(address: string\)/.test(newText[1]) && /clearReplyAddress\(\)/.test(newText[1]) && !/userId|user\.id/.test(newText[1]));
  ok("the action runs requireUser() and the session createClient() before it writes", /await requireUser\(\)/.test(newText[1]) && /createClient\(\)/.test(newText[1]));
  ok("errors are returned: no throw statement in any new file, and both actions catch", !/\bthrow\b/.test(allNew) && (newText[1].match(/catch \(err\)/g) ?? []).length === 2);
  ok(
    "the form (client component) imports no server-only module: no supabase server client, no env, only the action",
    !/lib\/supabase|process\.env|lib\/send-draft/.test(newText[3]) && /from "\.\/actions"/.test(newText[3])
  );
  ok(
    "the action and core import nothing from the send machinery (lib/send-draft stays single-importer)",
    !/send-draft"/.test(allNew) && !/sendFunderEmail|draft_send_attempts/.test(allNew)
  );
  ok(
    "the new files read no environment variable at all -- no process.env, no RESEND, no sending address (ruling 0043)",
    !/process\.env|RESEND|platformFromAddress|fromAddress/.test(allNew),
    allNew.match(/process\.env|RESEND|platformFromAddress|fromAddress/)?.[0] ?? ""
  );
  ok(
    "the settings action imports nothing that could supply a sending address (not lib/send-draft, not env)",
    !/send-draft|process/.test(newText[1]) && !/send-draft|process/.test(newText[0])
  );
  // Layout tokens: every field uses fieldStyle (which carries box-sizing:
  // border-box); no one-off hex colors.
  ok("the form's input uses the shared fieldStyle token (box-sizing: border-box lives there)", /style=\{fieldStyle\}/.test(newText[3]) && /boxSizing:\s*"border-box"/.test(readFileSync(join(root, "lib/ui.ts"), "utf8")));
  ok("no one-off hex colors or px font stacks in the new UI files (tokens from lib/ui only)", !/#[0-9a-fA-F]{3,8}\b/.test(newText[2] + newText[3]));
  const settingsIndex = readFileSync(join(root, "app/(dashboard)/settings/page.tsx"), "utf8");
  ok("the Settings area links to the control", /href="\/settings\/reply-address"/.test(settingsIndex));
  ok("the page explains the three things the ruling requires", (() => {
    const raw = readFileSync(join(root, "app/(dashboard)/settings/reply-address/page.tsx"), "utf8");
    return /cannot check that you control/.test(raw) && /only to replies to emails/.test(raw) && /confirmation you see before every send/.test(raw);
  })());
  ok("the page computes the shown address with resolveReplyTo on the freshly fetched user (getUser), and says where it comes from", (() => {
    const raw = stripComments(readFileSync(join(root, "app/(dashboard)/settings/reply-address/page.tsx"), "utf8"));
    return /auth\.getUser\(\)/.test(raw) && /resolveReplyTo\(/.test(raw) && /The address you chose/.test(raw) && /Your sign-in address/.test(raw) && !/getSession/.test(raw);
  })());

  console.log(`\n${pass} passed, ${fail} failed.`);
  if (fail > 0) process.exit(1);
}

main().catch((err) => {
  console.error("FAILED:", err);
  console.error(`Run aborted. Of the assertions that executed before the abort: ${pass} passed, ${fail} failed.`);
  process.exit(1);
});
