// Verifying a presented token (STATE item 98, ruling 0039 clause 1).
//
// The presented token is hashed here and ONLY THE HASH goes to the database,
// to verify_agent_token -- a security-definer function callable without a
// session. It is called with an anon-key client: no session, no service role.
// It returns the token's owner, organization, scope and expiry for a live
// token, and nothing for anything else. This module therefore cannot tell
// "unknown" from "revoked" from "expired", and does not pretend to: the
// refusal names all three, plainly, because the agent's provider relays it.
//
// Pure apart from the injected rpc: tests drive it with fakes.

import { createClient } from "@supabase/supabase-js";
import { isUuid } from "@/lib/assistant/validate";
import { hashToken, parseBearer } from "./token";
import { isSetupPending, AGENT_SETUP_PENDING_MESSAGE } from "./setup";

export type Scope = "read" | "act";

export type Principal = {
  tokenId: string;
  userId: string;
  organizationId: string;
  scope: Scope;
  expiresAt: string;
};

export type RpcError = { code?: string | null; message?: string | null };
export type VerifyRpc = (hash: string) => Promise<{ data: unknown; error: RpcError | null }>;

export type AuthFailure = {
  ok: false;
  status: 401 | 503 | 500;
  code: "token_required" | "token_invalid" | "setup_pending" | "verify_failed";
  message: string;
};
export type AuthResult = { ok: true; principal: Principal } | AuthFailure;

export const TOKEN_REQUIRED_MESSAGE =
  "An access token is required. Send it as 'Authorization: Bearer <token>'. Create one under Settings → Connect Muse.";
export const TOKEN_INVALID_MESSAGE =
  "This access token is not valid: it is unknown, has been revoked, or has expired. Create a new one under Settings → Connect Muse and update the connector with it.";

export async function authenticate(authorization: string | null, rpc: VerifyRpc, now: Date = new Date()): Promise<AuthResult> {
  const parsed = parseBearer(authorization);
  if (!parsed.ok) {
    return parsed.reason === "missing"
      ? { ok: false, status: 401, code: "token_required", message: TOKEN_REQUIRED_MESSAGE }
      : { ok: false, status: 401, code: "token_invalid", message: TOKEN_INVALID_MESSAGE };
  }

  let res: Awaited<ReturnType<VerifyRpc>>;
  try {
    res = await rpc(hashToken(parsed.token));
  } catch {
    return { ok: false, status: 500, code: "verify_failed", message: "The access token could not be checked just now. Nothing was done. Try again shortly." };
  }
  if (res.error) {
    if (isSetupPending(res.error)) return { ok: false, status: 503, code: "setup_pending", message: AGENT_SETUP_PENDING_MESSAGE };
    return { ok: false, status: 500, code: "verify_failed", message: "The access token could not be checked just now. Nothing was done. Try again shortly." };
  }

  const rows = Array.isArray(res.data) ? res.data : res.data ? [res.data] : [];
  const row = rows[0] as Record<string, unknown> | undefined;
  if (!row) return { ok: false, status: 401, code: "token_invalid", message: TOKEN_INVALID_MESSAGE };

  // Defence in depth: the function already returned only a live token, but this
  // module does not rely on a database function being right about shape or
  // time.
  const scope = row.scope;
  const expires = typeof row.expires_at === "string" ? Date.parse(row.expires_at) : NaN;
  if (
    !isUuid(row.token_id) ||
    !isUuid(row.user_id) ||
    !isUuid(row.organization_id) ||
    (scope !== "read" && scope !== "act") ||
    Number.isNaN(expires) ||
    expires <= now.getTime()
  ) {
    return { ok: false, status: 401, code: "token_invalid", message: TOKEN_INVALID_MESSAGE };
  }
  return {
    ok: true,
    principal: {
      tokenId: row.token_id.toLowerCase(),
      userId: row.user_id.toLowerCase(),
      organizationId: row.organization_id.toLowerCase(),
      scope,
      expiresAt: row.expires_at as string,
    },
  };
}

// The real rpc: an anon-key client with no session. (Reads only the public
// URL and the publishable key -- never the service-role credential.)
export function anonVerifyRpc(): VerifyRpc {
  return async (hash) => {
    const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
    const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
    if (!url || !key) return { data: null, error: { code: "CONFIG", message: "Supabase is not configured." } };
    const client = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
    const { data, error } = await client.rpc("verify_agent_token", { p_hash: hash });
    return { data, error };
  };
}
