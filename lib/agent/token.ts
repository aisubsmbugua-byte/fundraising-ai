// The delegate token (STATE item 98, ruling 0039 clause 1).
//
// A token is 32 random bytes, base64url, behind a fixed prefix. It is shown to
// its owner ONCE, when it is made, and the platform stores only its SHA-256
// hash: the database can then verify a presented token without ever being able
// to reveal one, so a leak of the table does not leak the credential.
//
// Pure apart from node:crypto. Nothing here reads the environment, a database
// or a client, and nothing here logs: a token appears in no log line, ever.

import { createHash, randomBytes } from "node:crypto";
import { TOKEN_DISPLAY_PREFIX_CHARS, TOKEN_PREFIX, TOKEN_RANDOM_BYTES } from "./limits";

// prefix + 43 base64url characters (32 bytes, unpadded).
const TOKEN_RE = new RegExp(`^${TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

export function generateToken(random: (n: number) => Buffer = randomBytes): string {
  return `${TOKEN_PREFIX}${random(TOKEN_RANDOM_BYTES).toString("base64url")}`;
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

// The first characters of a token, for the settings list. Not a secret worth
// keeping: it is the fixed prefix plus a few characters of 256 bits.
export function tokenDisplayPrefix(token: string): string {
  return token.slice(0, TOKEN_DISPLAY_PREFIX_CHARS);
}

export function isWellFormedToken(token: string): boolean {
  return TOKEN_RE.test(token);
}

export type BearerParse = { ok: true; token: string } | { ok: false; reason: "missing" | "malformed" };

// "Authorization: Bearer <token>". Anything else is refused before the
// database is asked.
export function parseBearer(header: string | null | undefined): BearerParse {
  if (typeof header !== "string" || header.trim() === "") return { ok: false, reason: "missing" };
  const m = /^Bearer\s+(\S+)\s*$/i.exec(header.trim());
  if (!m) return { ok: false, reason: "malformed" };
  if (!isWellFormedToken(m[1])) return { ok: false, reason: "malformed" };
  return { ok: true, token: m[1] };
}
