// Making and revoking a delegate token (STATE item 98, ruling 0039 clause 1).
//
// These run as the signed-in user through their own cookie client, from the
// Connect Muse page's server actions -- the only place a token can be made.
// The token is generated here, its SHA-256 hash is the only thing handed to
// storage, and the token itself is returned to the caller exactly once.

import type { SupabaseClient } from "@supabase/supabase-js";
import { isUuid } from "@/lib/assistant/validate";
import { TOKEN_DEFAULT_EXPIRY_DAYS, TOKEN_EXPIRY_CHOICES_DAYS, TOKEN_MAX_EXPIRY_DAYS, TOKEN_NAME_MAX_CHARS } from "./limits";
import { generateToken, hashToken, tokenDisplayPrefix } from "./token";
import { AGENT_SETUP_PENDING_MESSAGE, isSetupPending } from "./setup";

export const TOKEN_TABLE = "agent_tokens";
export type TokenScopeChoice = "read" | "act";

export type CreateTokenResult = { ok: true; token: string; prefix: string; expiresAt: string } | { error: string };

export async function createTokenCore(input: {
  supabase: SupabaseClient;
  name: unknown;
  scope: unknown;
  days: unknown;
  now?: Date;
  random?: (n: number) => Buffer;
}): Promise<CreateTokenResult> {
  const now = input.now ?? new Date();
  const name = typeof input.name === "string" ? input.name.replace(/\s+/g, " ").trim() : "";
  if (name.length < 1 || name.length > TOKEN_NAME_MAX_CHARS) return { error: `Give the connection a name of 1 to ${TOKEN_NAME_MAX_CHARS} characters, such as "Muse on my laptop".` };
  if (input.scope !== "read" && input.scope !== "act") return { error: "Choose what the connection may do: look things up only, or look things up and make changes." };
  const days = input.days === undefined || input.days === "" ? TOKEN_DEFAULT_EXPIRY_DAYS : Number(input.days);
  if (!Number.isInteger(days) || days < 1 || days > TOKEN_MAX_EXPIRY_DAYS) {
    return { error: `Choose how long it lasts: one of ${TOKEN_EXPIRY_CHOICES_DAYS.join(", ")} days (at most ${TOKEN_MAX_EXPIRY_DAYS}).` };
  }
  const token = generateToken(input.random);
  const expiresAt = new Date(now.getTime() + days * 86_400_000).toISOString();

  // Only the hash and the display prefix reach storage -- never the token.
  const { error } = await input.supabase.from(TOKEN_TABLE).insert({
    name,
    token_hash: hashToken(token),
    token_prefix: tokenDisplayPrefix(token),
    scope: input.scope,
    expires_at: expiresAt,
  });
  if (error) {
    if (isSetupPending(error)) return { error: AGENT_SETUP_PENDING_MESSAGE };
    console.error("[agent] token insert failed:", error.message);
    return { error: "The token could not be created just now. Nothing was saved." };
  }
  return { ok: true, token, prefix: tokenDisplayPrefix(token), expiresAt };
}

export async function revokeTokenCore(input: { supabase: SupabaseClient; tokenId: unknown; now?: Date }): Promise<{ ok: true } | { error: string }> {
  if (!isUuid(input.tokenId)) return { error: "That token could not be found." };
  const now = input.now ?? new Date();
  const { data, error } = await input.supabase
    .from(TOKEN_TABLE)
    .update({ revoked_at: now.toISOString() })
    .eq("id", input.tokenId)
    .is("revoked_at", null)
    .select("id");
  if (error) {
    if (isSetupPending(error)) return { error: AGENT_SETUP_PENDING_MESSAGE };
    return { error: "The token could not be revoked just now. Try again." };
  }
  if (!data || data.length === 0) return { error: "That token could not be found, or it is already revoked." };
  return { ok: true };
}
