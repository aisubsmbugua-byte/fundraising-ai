// Assistant configuration, read from the environment (STATE item 87).
//
// Server-only: this file names MODEL_API_KEY. It is imported by the provider
// module, the turn handler, the access check and the smoke script -- never by
// a client component (hard rule 5; a source scan in scripts/test-assistant.ts
// asserts it).
//
// Same read-and-degrade shape as isSendConfigured() in lib/send-draft.ts:
// the caller asks BEFORE it births anything, and with no configuration there
// is no request, so nothing enters the run ledger.

export const DEFAULT_MODEL_BASE_URL = "https://api.meta.ai/v1";
// The model name is a constant with an environment override (ASSISTANT_MODEL).
export const DEFAULT_ASSISTANT_MODEL = "muse-spark-1.1";
// Names the provider on every turn's own record (ruling 0037 clause 4).
export const PROVIDER_ID = "meta-model-api";
// The wording the page and the disclosure use.
export const PROVIDER_LABEL = "Meta (Muse Spark, via Meta's Model API)";

export type Env = Record<string, string | undefined>;

export type ProviderConfig = { apiKey: string; baseUrl: string; model: string };

export type ProviderConfigResult =
  | { ok: true; config: ProviderConfig }
  | { ok: false; reason: "missing_key" | "bad_base_url" };

// https required, except for a loopback address so a local fake can stand in.
function normalizeBaseUrl(raw: string): string | null {
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return null;
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  return url.toString().replace(/\/+$/, "");
}

export function readProviderConfig(env: Env = process.env): ProviderConfigResult {
  const apiKey = env.MODEL_API_KEY?.trim();
  if (!apiKey) return { ok: false, reason: "missing_key" };
  const baseUrl = normalizeBaseUrl(env.MODEL_API_BASE_URL?.trim() || DEFAULT_MODEL_BASE_URL);
  if (!baseUrl) return { ok: false, reason: "bad_base_url" };
  const model = env.ASSISTANT_MODEL?.trim() || DEFAULT_ASSISTANT_MODEL;
  return { ok: true, config: { apiKey, baseUrl, model } };
}

export function isAssistantConfigured(env: Env = process.env): boolean {
  return readProviderConfig(env).ok;
}

// ASSISTANT_ENABLED_ORG_IDS: a comma-separated list of organization ids.
// Absent or empty means disabled for everyone -- the same "absence is off"
// encoding the sending switch uses (ruling 0032). A malformed entry is
// dropped, never treated as a wildcard.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function parseEnabledOrgIds(raw: string | null | undefined): Set<string> {
  const out = new Set<string>();
  for (const part of (raw ?? "").split(",")) {
    const id = part.trim().toLowerCase();
    if (UUID_RE.test(id)) out.add(id);
  }
  return out;
}

export function isAssistantEnabledForOrg(organizationId: string | null | undefined, env: Env = process.env): boolean {
  if (!organizationId) return false;
  return parseEnabledOrgIds(env.ASSISTANT_ENABLED_ORG_IDS).has(organizationId.toLowerCase());
}

// Whether ANY organization is enabled -- lets the layout skip a query when
// the answer is no for everyone.
export function isAssistantEnabledAnywhere(env: Env = process.env): boolean {
  return parseEnabledOrgIds(env.ASSISTANT_ENABLED_ORG_IDS).size > 0;
}
