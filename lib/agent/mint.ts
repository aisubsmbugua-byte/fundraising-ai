// THE minting step (STATE item 98, ruling 0039 clause 2).
//
// This is the ONE module in the application, for this feature, that names the
// privileged credential. It does exactly one thing: given a user id that the
// token check has already verified, return an ordinary row-level-security
// client bound to that user. It never reads or writes a data table -- a scan
// asserts both that this is the only file in lib/agent naming the credential
// and that it contains no `.from(` call.
//
// Why a privileged credential is needed at all. The project signs sessions
// with asymmetric keys the application cannot hold, so the application cannot
// make a session token itself. The only way to act as a user without a browser
// is the exchange middleware.ts already performs for its dev login: ask the
// auth admin API for a magic link for that user (this sends no email), then
// redeem the link's hashed token on an ordinary anon-key client (verifyOtp),
// which returns a real session for exactly that user. This module confines
// that exchange rather than pretending it is not needed.
//
// What it returns is an anon-key client carrying the user's own access token
// as its Authorization header: every query it makes goes through RLS as that
// user, and auth.getUser() on it answers with that user (supabase-js treats a
// client built with a custom Authorization header as authenticated by it).
//
// The access token is cached per user, in memory, for well under its life
// (MINT_CACHE_MS, 45 minutes against the usual hour). If the database answers
// 401 the cache entry is dropped and the request retried once with a freshly
// minted token.

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { MINT_CACHE_MS, MINT_EXPIRY_MARGIN_MS } from "./limits";

type AdminLike = {
  auth: {
    admin: {
      getUserById(id: string): Promise<{ data: { user: { id: string; email?: string | null } | null }; error: { message: string } | null }>;
      generateLink(params: { type: "magiclink"; email: string }): Promise<{
        data: { properties?: { hashed_token?: string } | null } | null;
        error: { message: string } | null;
      }>;
    };
  };
};

type AnonLike = {
  auth: {
    verifyOtp(params: { token_hash: string; type: "magiclink" }): Promise<{
      data: { user: { id: string } | null; session: { access_token: string; expires_at?: number | null } | null };
      error: { message: string } | null;
    }>;
  };
};

export type MinterDeps = {
  url?: string;
  anonKey?: string;
  serviceKey?: string;
  now?: () => number;
  makeAdmin?: (url: string, serviceKey: string) => AdminLike;
  makeAnon?: (url: string, anonKey: string) => AnonLike;
  makeRlsClient?: (url: string, anonKey: string, opts: { headers: Record<string, string>; fetch: typeof fetch }) => SupabaseClient;
  fetchImpl?: typeof fetch;
};

export class MintError extends Error {}

type Cached = { accessToken: string; until: number };

export function createMinter(deps: MinterDeps = {}) {
  const now = deps.now ?? (() => Date.now());
  const cache = new Map<string, Cached>();
  const inflight = new Map<string, Promise<Cached>>();

  function config() {
    const url = deps.url ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
    const anonKey = deps.anonKey ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    const serviceKey = deps.serviceKey ?? process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !anonKey || !serviceKey) throw new MintError("The connector is not fully configured on the server, so nothing was done.");
    return { url, anonKey, serviceKey };
  }

  async function mint(userId: string): Promise<Cached> {
    const { url, anonKey, serviceKey } = config();
    const admin: AdminLike =
      deps.makeAdmin?.(url, serviceKey) ??
      (createClient(url, serviceKey, { auth: { autoRefreshToken: false, persistSession: false } }) as unknown as AdminLike);
    const anon: AnonLike =
      deps.makeAnon?.(url, anonKey) ??
      (createClient(url, anonKey, { auth: { autoRefreshToken: false, persistSession: false } }) as unknown as AnonLike);

    const found = await admin.auth.admin.getUserById(userId);
    const email = found.data?.user?.email;
    if (found.error || !found.data?.user || found.data.user.id !== userId || !email) {
      throw new MintError("The token's owner could not be found, so nothing was done.");
    }
    const link = await admin.auth.admin.generateLink({ type: "magiclink", email });
    const hashed = link.data?.properties?.hashed_token;
    if (link.error || !hashed) throw new MintError("A session for the token's owner could not be started, so nothing was done.");

    const verified = await anon.auth.verifyOtp({ token_hash: hashed, type: "magiclink" });
    const session = verified.data?.session;
    // The session MUST be the verified owner's, and no one else's.
    if (verified.error || !session?.access_token || verified.data.user?.id !== userId) {
      throw new MintError("A session for the token's owner could not be started, so nothing was done.");
    }
    const t = now();
    const own = typeof session.expires_at === "number" ? session.expires_at * 1000 - MINT_EXPIRY_MARGIN_MS : Number.POSITIVE_INFINITY;
    return { accessToken: session.access_token, until: Math.min(t + MINT_CACHE_MS, own) };
  }

  async function accessTokenFor(userId: string, force = false): Promise<string> {
    if (!force) {
      const hit = cache.get(userId);
      if (hit && hit.until > now()) return hit.accessToken;
    }
    const pending = inflight.get(userId);
    if (pending && !force) return (await pending).accessToken;
    const p = mint(userId).then(
      (c) => {
        cache.set(userId, c);
        inflight.delete(userId);
        return c;
      },
      (e) => {
        inflight.delete(userId);
        throw e;
      }
    );
    inflight.set(userId, p);
    return (await p).accessToken;
  }

  // An ordinary RLS client for `userId`. Every request carries the user's
  // access token; on a 401 the cached token is dropped, a fresh one minted,
  // and the request is retried once.
  async function clientFor(userId: string): Promise<SupabaseClient> {
    const { url, anonKey } = config();
    const holder = { token: await accessTokenFor(userId) };
    const base = deps.fetchImpl ?? ((...a: Parameters<typeof fetch>) => fetch(...a));
    const authedFetch: typeof fetch = async (input, init) => {
      const run = (token: string) => {
        const headers = new Headers(init?.headers);
        headers.set("Authorization", `Bearer ${token}`);
        return base(input, { ...init, headers });
      };
      const first = await run(holder.token);
      if (first.status !== 401) return first;
      holder.token = await accessTokenFor(userId, true);
      return run(holder.token);
    };
    const headers = { Authorization: `Bearer ${holder.token}` };
    if (deps.makeRlsClient) return deps.makeRlsClient(url, anonKey, { headers, fetch: authedFetch });
    return createClient(url, anonKey, {
      auth: { persistSession: false, autoRefreshToken: false },
      global: { headers, fetch: authedFetch },
    });
  }

  return { clientFor, accessTokenFor, invalidate: (userId: string) => void cache.delete(userId) };
}

let shared: ReturnType<typeof createMinter> | null = null;

// The process-wide minter (its cache is the per-user, in-memory token cache).
export function getMinter() {
  return (shared ??= createMinter());
}

export async function mintClientForUser(userId: string): Promise<SupabaseClient> {
  return getMinter().clientFor(userId);
}
