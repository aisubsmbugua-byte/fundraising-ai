// STATE item 78 -- an invited user's admin-issued sign-in link (no PKCE
// ?code=, session comes back as URL-hash tokens) could never complete.
// See lib/auth-callback.ts, app/auth/callback/route.ts,
// app/auth/complete-signin/{page.tsx,actions.ts}.
//
// Entirely offline: no browser, no live Supabase call, no email. Three
// things are proven:
//
//   1. lib/auth-callback.ts's parseHashTokens, a pure function, parses a
//      real hash, an absent one, and a malformed one correctly.
//
//   2. ensureProfileForCurrentUser's three outcomes (ok via existing
//      profile, ok via a fresh insert, no_organization, and error via
//      both a failed getUser and a failed insert) are each reachable
//      against a stubbed Supabase client, and the insert it performs
//      uses the EXACT same shape (same fields, same values, same
//      order) as the inline block it replaced -- diffed against the
//      pre-refactor route.ts via `git show HEAD:...`, since this
//      refactor is not yet committed.
//
//   3. Source-level checks that route.ts's ?code= path is behaviorally
//      unchanged after the refactor (same three outcomes, same two
//      redirect targets), that its no-code fallback now hands off to
//      /auth/complete-signin with `next` preserved and URL-encoded and
//      no fragment of its own, that the new page/action reuse the
//      EXACT error query values already defined in login/page.tsx's
//      CALLBACK_ERROR_MESSAGE (no invented ones), and that the
//      self-serve signInWithOtp flow in login/page.tsx is byte-for-byte
//      unchanged.
//
// Usage: npx tsx scripts/test-auth-callback.ts

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseHashTokens, ensureProfileForCurrentUser, type EnsureProfileResult } from "../lib/auth-callback";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");
const readAtHead = (p: string) => execSync(`git show HEAD:${p}`, { cwd: root }).toString();

let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
function section(t: string) {
  console.log(`\n--- ${t} ---`);
}

// --- 1. parseHashTokens ----------------------------------------------------

section("parseHashTokens: pure, framework-free hash parsing");

ok(
  "a real Supabase hash (with leading #) yields both tokens",
  JSON.stringify(parseHashTokens("#access_token=abc123&refresh_token=def456&expires_in=3600")) ===
    JSON.stringify({ access_token: "abc123", refresh_token: "def456" })
);
ok(
  "the same string without a leading # parses identically (route hands the hash string either way)",
  JSON.stringify(parseHashTokens("access_token=abc123&refresh_token=def456")) ===
    JSON.stringify({ access_token: "abc123", refresh_token: "def456" })
);
ok("an empty hash yields null, not a crash", parseHashTokens("") === null);
ok("a bare '#' yields null", parseHashTokens("#") === null);
ok(
  "a malformed hash missing refresh_token yields null (partial tokens are not usable)",
  parseHashTokens("#access_token=abc123&expires_in=3600") === null
);
ok(
  "a hash with unrelated params (e.g. an error redirect) yields null",
  parseHashTokens("#error=access_denied&error_description=nope") === null
);

// --- 2. ensureProfileForCurrentUser's three outcomes -----------------------

section("ensureProfileForCurrentUser: outcomes against a stubbed client");

type StubOpts = {
  user: { id: string; email: string; app_metadata?: Record<string, unknown> } | null;
  userError?: string;
  existingProfile: { id: string } | null;
  insertError?: string;
};

function makeStub(opts: StubOpts) {
  let insertCalls: unknown[] = [];
  const client = {
    auth: {
      getUser: async () => {
        if (opts.userError) return { data: { user: null }, error: { message: opts.userError } };
        return { data: { user: opts.user }, error: null };
      },
    },
    from: (table: string) => {
      if (table !== "profiles") throw new Error(`unexpected table: ${table}`);
      return {
        select: () => ({
          eq: () => ({
            maybeSingle: async () => ({ data: opts.existingProfile, error: null }),
          }),
        }),
        insert: (row: unknown) => {
          insertCalls.push(row);
          return Promise.resolve({ error: opts.insertError ? { message: opts.insertError } : null });
        },
      };
    },
  };
  return { client, getInsertCalls: () => insertCalls };
}

async function outcome(opts: StubOpts) {
  const { client, getInsertCalls } = makeStub(opts);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await ensureProfileForCurrentUser(client as any);
  return { result, insertCalls: getInsertCalls() };
}

(async () => {
  // Outcome: getUser fails -> error, no profile lookup attempted downstream matters less than the result.
  {
    const { result, insertCalls } = await outcome({
      user: null,
      userError: "invalid session",
      existingProfile: null,
    });
    ok(
      "outcome 'error' is reachable via a failed getUser",
      (result as EnsureProfileResult).status === "error",
      JSON.stringify(result)
    );
    ok("no insert attempted when there's no user", insertCalls.length === 0);
  }

  // Outcome: profile already exists -> ok, no-op, no insert.
  {
    const { result, insertCalls } = await outcome({
      user: { id: "u1", email: "a@b.com", app_metadata: { organization_id: "org1" } },
      existingProfile: { id: "u1" },
    });
    ok(
      "outcome 'ok' is reachable via an already-existing profile (no-op)",
      (result as EnsureProfileResult).status === "ok",
      JSON.stringify(result)
    );
    ok("an existing profile triggers no insert", insertCalls.length === 0);
  }

  // Outcome: no profile, no org in app_metadata -> no_organization.
  {
    const { result, insertCalls } = await outcome({
      user: { id: "u2", email: "b@b.com", app_metadata: {} },
      existingProfile: null,
    });
    ok(
      "outcome 'no_organization' is reachable when app_metadata has no organization_id",
      (result as EnsureProfileResult).status === "no_organization",
      JSON.stringify(result)
    );
    ok("no_organization does not attempt an insert", insertCalls.length === 0);
  }

  // Outcome: no profile, org present, insert succeeds -> ok, and the insert
  // shape matches the pre-refactor inline block exactly.
  {
    const { result, insertCalls } = await outcome({
      user: { id: "u3", email: "c@b.com", app_metadata: { organization_id: "org3" } },
      existingProfile: null,
    });
    ok(
      "outcome 'ok' is reachable via a fresh profile insert",
      (result as EnsureProfileResult).status === "ok",
      JSON.stringify(result)
    );
    ok(
      "the insert carries exactly {id, organization_id, email} for the current user",
      insertCalls.length === 1 &&
        JSON.stringify(insertCalls[0]) === JSON.stringify({ id: "u3", organization_id: "org3", email: "c@b.com" }),
      JSON.stringify(insertCalls)
    );
  }

  // Outcome: no profile, org present, insert fails -> error.
  {
    const { result, insertCalls } = await outcome({
      user: { id: "u4", email: "d@b.com", app_metadata: { organization_id: "org4" } },
      existingProfile: null,
      insertError: "duplicate key",
    });
    ok(
      "outcome 'error' is also reachable via a failed insert",
      (result as EnsureProfileResult).status === "error",
      JSON.stringify(result)
    );
    ok("exactly one insert was attempted before failing", insertCalls.length === 1);
  }

  // --- 2b. the insert shape matches the pre-refactor route.ts verbatim ----

  section("insert shape diffed against the pre-refactor route.ts (git HEAD)");

  const preRefactorRoute = readAtHead("app/auth/callback/route.ts");
  const preInsertMatch = preRefactorRoute.match(
    /\.insert\(\{\s*id:\s*data\.user\.id,\s*organization_id:\s*organizationId,\s*email:\s*data\.user\.email,\s*\}\)/
  );
  ok(
    "the pre-refactor route.ts did insert {id: data.user.id, organization_id: organizationId, email: data.user.email}",
    !!preInsertMatch,
    "couldn't find the expected inline insert block in git HEAD's route.ts -- has the pre-refactor shape assumed here gone stale?"
  );

  const sharedLib = read("lib/auth-callback.ts");
  const sharedInsertMatch = sharedLib.match(
    /\.insert\(\{\s*id:\s*user\.id,\s*organization_id:\s*organizationId,\s*email:\s*user\.email,\s*\}\)/
  );
  ok(
    "the shared function inserts the same three fields, same order, same source values (data.user.* -> user.* is the same object)",
    !!sharedInsertMatch,
    "lib/auth-callback.ts's insert shape has drifted from the original inline block"
  );

  // --- 3. Source-level checks on route.ts, the new page/action, and login.ts

  section("route.ts: the ?code= path is behaviorally unchanged");

  const route = read("app/auth/callback/route.ts");
  ok("route.ts no longer contains the inline profile-creation block", !/existingProfile/.test(route));
  ok(
    "route.ts imports the shared function",
    /import \{ ensureProfileForCurrentUser \} from "@\/lib\/auth-callback"/.test(route)
  );
  ok(
    "the ?code= branch still calls exchangeCodeForSession then, on success, ensureProfileForCurrentUser",
    /exchangeCodeForSession\(code\)/.test(route) &&
      /if \(!error && data\.user\) \{\s*const result = await ensureProfileForCurrentUser\(supabase\);/.test(route)
  );
  ok(
    "no_organization still maps to the same redirect target as before",
    /no_organization.*\n.*redirect\(`\$\{origin\}\/login\?error=no_organization`\)/.test(route)
  );
  ok(
    "a profile-creation error still maps to /login?error=auth, same as before",
    (route.match(/redirect\(`\$\{origin\}\/login\?error=auth`\)/g) ?? []).length >= 2
  );
  ok(
    "success still redirects to `next`, same as before",
    /return NextResponse\.redirect\(`\$\{origin\}\$\{next\}`\);/.test(route)
  );

  section("route.ts: the no-code fallback now hands off to complete-signin");

  ok(
    "the final fallback redirects to /auth/complete-signin with next URL-encoded, no fragment on this Location header",
    /return NextResponse\.redirect\(`\$\{origin\}\/auth\/complete-signin\?next=\$\{encodeURIComponent\(next\)\}`\);/.test(
      route
    )
  );
  ok("that redirect target string carries no '#' of its own", !/complete-signin[^`]*#/.test(route));

  section("login/page.tsx: self-serve flow is byte-for-byte unchanged");

  const loginNow = read("app/login/page.tsx");
  const loginAtHead = readAtHead("app/login/page.tsx");
  ok("app/login/page.tsx is untouched by this change", loginNow === loginAtHead);

  const errorKeysMatch = loginNow.match(/CALLBACK_ERROR_MESSAGE: Record<string, string> = \{([\s\S]*?)\};/);
  const errorKeys = errorKeysMatch ? [...errorKeysMatch[1].matchAll(/^\s*([a-z_]+):/gm)].map((m) => m[1]) : [];
  ok(
    "CALLBACK_ERROR_MESSAGE still defines exactly no_organization and auth",
    errorKeys.sort().join(",") === "auth,no_organization",
    errorKeys.join(",")
  );

  section("the new hash-token page and its server action");

  const completeSigninPage = read("app/auth/complete-signin/page.tsx");
  const completeSigninActions = read("app/auth/complete-signin/actions.ts");

  ok(
    "the page reads window.location.hash and delegates parsing to the shared pure function",
    /window\.location\.hash/.test(completeSigninPage) && /parseHashTokens\(/.test(completeSigninPage)
  );
  ok(
    "on parsed tokens, it calls the browser client's setSession with exactly those tokens",
    /supabase\.auth\.setSession\(tokens\)/.test(completeSigninPage)
  );
  ok(
    "a missing-hash or failed setSession both land on the SAME error route as the existing auth error",
    (completeSigninPage.match(/router\.replace\("\/login\?error=auth"\)/g) ?? []).length === 2
  );
  ok("the action file is a server action", /^"use server";/.test(completeSigninActions.trim()));
  ok(
    "the action runs the shared profile-ensure logic against the (now-authenticated) server client",
    /ensureProfileForCurrentUser\(supabase\)/.test(completeSigninActions)
  );
  ok(
    "the action reuses the exact same two error redirects as route.ts / login page, no invented ones",
    /redirect\("\/login\?error=no_organization"\)/.test(completeSigninActions) &&
      /redirect\("\/login\?error=auth"\)/.test(completeSigninActions)
  );
  ok(
    "on success the action redirects to `next` (falling back to /pipeline)",
    /redirect\(next \|\| "\/pipeline"\)/.test(completeSigninActions)
  );

  section("lib/invite.ts and the two client constructors: untouched, as scoped");

  const inviteNow = read("lib/invite.ts");
  const inviteAtHead = readAtHead("lib/invite.ts");
  ok("lib/invite.ts is untouched by this change", inviteNow === inviteAtHead);
  const clientNow = read("lib/supabase/client.ts");
  const clientAtHead = readAtHead("lib/supabase/client.ts");
  ok("lib/supabase/client.ts is untouched", clientNow === clientAtHead);
  const serverNow = read("lib/supabase/server.ts");
  const serverAtHead = readAtHead("lib/supabase/server.ts");
  ok("lib/supabase/server.ts is untouched", serverNow === serverAtHead);
  ok(
    "no server-role/secret key referenced anywhere in the new client page (hard rule 5)",
    !/service_role|SERVICE_ROLE/.test(completeSigninPage)
  );

  console.log(`\n${pass} passed, ${fail} failed.`);
  process.exit(fail > 0 ? 1 : 0);
})();
