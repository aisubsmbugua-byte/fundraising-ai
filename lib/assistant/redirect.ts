// Structural handling of next/navigation's redirect() for the command path.
//
// An existing entry point may THROW (it surfaces a database error that way)
// or call redirect() -- a signed-out caller, or createProspect on success --
// and redirect works by throwing an error whose `digest` starts with
// NEXT_REDIRECT and carries `NEXT_REDIRECT;<push|replace>;<url>;<status>;`.
// Detected structurally so this module does not depend on framework
// internals beyond that documented digest shape. (executors.ts keeps its own
// copy for the click-approval path; it is deliberately untouched.)

export function isRedirectError(err: unknown): boolean {
  const digest = err && typeof err === "object" ? (err as { digest?: unknown }).digest : undefined;
  return typeof digest === "string" && digest.startsWith("NEXT_REDIRECT");
}

// The destination a redirect error carries, or null.
export function redirectTarget(err: unknown): string | null {
  const digest = err && typeof err === "object" ? (err as { digest?: unknown }).digest : undefined;
  if (typeof digest !== "string" || !digest.startsWith("NEXT_REDIRECT")) return null;
  const parts = digest.split(";");
  return parts.length >= 3 ? parts[2] : null;
}

const PROSPECT_PATH_RE = /^\/prospects\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:[/?#]|$)/i;

// The id in a `/prospects/<uuid>` redirect target, or null.
export function prospectIdFromRedirect(err: unknown): string | null {
  const target = redirectTarget(err);
  if (!target) return null;
  const m = PROSPECT_PATH_RE.exec(target);
  return m ? m[1].toLowerCase() : null;
}
