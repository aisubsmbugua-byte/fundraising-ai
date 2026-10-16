import { AsyncLocalStorage } from "node:async_hooks";
import { createServerClient } from "@supabase/ssr";
import type { SupabaseClient } from "@supabase/supabase-js";
import { cookies } from "next/headers";

// STATE item 98 (ruling 0039 clause 2): a request-scoped override for the
// external-agent connector. An agent's call carries no browser cookies, so the
// existing server actions -- which find their user by calling createClient()
// below and then auth.getUser() on it -- would see nobody. The connector's own
// handler enters runWithAgentClient(client, fn) around each tool execution,
// where `client` is a row-level-security client already bound to the token's
// user; createClient() then returns that client, and everything the action
// does goes through the same wall as every page.
//
// Absent everywhere else: with no store entered, createClient() behaves
// exactly as it did before (scripts/test-agent.ts pins the function body). The
// store lives on globalThis under a Symbol.for key so the handler's module
// instance and an action's share ONE store even if the bundler instantiates
// this file more than once. scripts/test-agent.ts asserts runWithAgentClient is
// entered in exactly one place (lib/agent/mcp.ts).
const STORE_KEY = Symbol.for("fundraising-ai.agentClientStore");
type StoreHolder = typeof globalThis & { [STORE_KEY]?: AsyncLocalStorage<SupabaseClient> };
const agentClientStore: AsyncLocalStorage<SupabaseClient> = ((globalThis as StoreHolder)[STORE_KEY] ??=
  new AsyncLocalStorage<SupabaseClient>());

export function runWithAgentClient<T>(client: SupabaseClient, fn: () => T): T {
  return agentClientStore.run(client, fn);
}

export function createClient() {
  const override = agentClientStore.getStore();
  if (override) return override as unknown as ReturnType<typeof createCookieClient>;
  return createCookieClient();
}

// The factory exactly as it was before the override existed.
function createCookieClient() {
  const cookieStore = cookies();
  return createServerClient(
    process.env.NEXT_PUBLIC_SUPABASE_URL!,
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
    {
      cookies: {
        getAll() {
          return cookieStore.getAll();
        },
        setAll(cookiesToSet: { name: string; value: string; options?: Record<string, unknown> }[]) {
          try {
            cookiesToSet.forEach(({ name, value, options }) =>
              cookieStore.set(name, value, options)
            );
          } catch {
            // called from a Server Component; safe to ignore when middleware refreshes sessions
          }
        },
      },
    }
  );
}
