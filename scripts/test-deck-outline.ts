// STATE item 66: a deck renders exactly what a human approved. This file
// asserts that three ways:
//
//   1. By pure logic, running parseDeckOutline (the ONE parser, shared by
//      the generation action's citation validation and the deck view's
//      rendering) across the format's whole vocabulary -- titles, bullets,
//      evidence citations, comments, blanks -- and its edge cases, none of
//      which may silently drop a human's line.
//
//   2. On the header contract: every stored outline documents its own
//      format because ensureOutlineHeader prepends the explanation in
//      CODE (idempotently, and invisibly to the parser) -- a human can
//      read and edit the outline in the plain draft editor with no
//      instructions from anywhere else, and no model is trusted to
//      remember to include them.
//
//   3. By source scan on the deck view route: rendering is deterministic
//      parsing of the approved text -- zero model calls, no run ledger
//      entry (nothing to meter), no external deck/PDF library, the shared
//      parser and shared UI tokens, an APPROVED-only gate before any
//      slide markup, a print stylesheet with the screen-only note, and a
//      read-only evidence lookup for footnote attributions.
//
// Everything here is pure logic plus file reads -- no DB, no API key, no
// model call.
//
// Usage: npx tsx scripts/test-deck-outline.ts

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseDeckOutline, ensureOutlineHeader, DECK_OUTLINE_HEADER } from "../lib/deck-outline";

const root = join(__dirname, "..");

let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
function section(t: string) {
  console.log(`\n--- ${t} ---`);
}

// --- 1. The parser, across the format's vocabulary -------------------------

section("parseDeckOutline: the format's whole vocabulary");

{
  const outline = parseDeckOutline(
    [
      "# Title Slide",
      "Village Worship Initiative",
      "A partnership proposal",
      "",
      "# The Need",
      "Rural congregations lack trained worship leaders",
      "> evidence: ev-1",
      "",
      "# The Ask",
      "A three-year partnership",
      "> evidence: ev-2",
      "> evidence: ev-1",
    ].join("\n")
  );
  ok("three '# ' lines produce three slides in order", outline.slides.length === 3 && outline.slides[0].title === "Title Slide" && outline.slides[2].title === "The Ask");
  ok("plain lines are bullets on their own slide", JSON.stringify(outline.slides[0].bullets) === JSON.stringify(["Village Worship Initiative", "A partnership proposal"]));
  ok("blank lines are ignored", outline.slides.every((s) => s.bullets.every((b) => b.length > 0)));
  ok("'> evidence:' lines attach ids to THEIR slide, in order", JSON.stringify(outline.slides[2].evidenceIds) === JSON.stringify(["ev-2", "ev-1"]));
  ok("evidence lines are never bullets", outline.slides.every((s) => s.bullets.every((b) => !/^>/.test(b))));
  ok(
    "the outline-level id list is deduplicated in first-appearance order",
    JSON.stringify(outline.evidenceIds) === JSON.stringify(["ev-1", "ev-2"]),
    `got: ${outline.evidenceIds.join(", ")}`
  );
}

{
  const outline = parseDeckOutline("// a note\n//another note\n# Only Slide\npoint");
  ok("'//' comment lines never appear on a slide", outline.slides.length === 1 && outline.slides[0].bullets.length === 1);
}

section("parseDeckOutline: nothing a human wrote is silently dropped");

{
  const outline = parseDeckOutline("stray line before any title\n# First Real Slide\npoint");
  ok(
    "body lines before the first '#' land on a leading UNTITLED slide, not on the floor",
    outline.slides.length === 2 && outline.slides[0].title === null && outline.slides[0].bullets[0] === "stray line before any title"
  );
}
{
  const outline = parseDeckOutline("# Slide\n> a quoted remark, not a citation\n> evidence: ev-9");
  ok(
    "a '>' line that is not an evidence citation is kept as a bullet",
    outline.slides[0].bullets.length === 1 && outline.slides[0].bullets[0] === "> a quoted remark, not a citation" && JSON.stringify(outline.slides[0].evidenceIds) === JSON.stringify(["ev-9"])
  );
}
{
  const outline = parseDeckOutline("> evidence: this has spaces so it is not one id");
  ok("an evidence 'id' containing spaces is not a citation -- it stays visible as a bullet", outline.slides[0].evidenceIds.length === 0 && outline.slides[0].bullets.length === 1);
}
{
  const outline = parseDeckOutline("#Tight Title\n## Markdown Habit\n>evidence: ev-3\n>  EVIDENCE:   ev-4");
  ok("forgiving spellings: '#Tight', '##', '>evidence:' and case variants all parse as intended", outline.slides.length === 2 && outline.slides[0].title === "Tight Title" && outline.slides[1].title === "Markdown Habit" && JSON.stringify(outline.slides[1].evidenceIds) === JSON.stringify(["ev-3", "ev-4"]));
}
{
  ok("empty text parses to zero slides (the view renders its explicit empty message, not a crash)", parseDeckOutline("").slides.length === 0 && parseDeckOutline("\n\n// only notes\n").slides.length === 0);
}
{
  const a = parseDeckOutline("# S\nx\n> evidence: e1");
  const b = parseDeckOutline("# S\nx\n> evidence: e1");
  ok("deterministic: same text in, same slides out", JSON.stringify(a) === JSON.stringify(b));
}

// --- 2. The header contract -------------------------------------------------

section("ensureOutlineHeader: the outline documents its own format, in code");

{
  const body = "# Slide\npoint\n> evidence: ev-1";
  const stored = ensureOutlineHeader(body);
  ok("the stored outline BEGINS with the format explanation", stored.startsWith(DECK_OUTLINE_HEADER));
  ok(
    "the header names every construct a human needs: '#' titles, plain bullets, '> evidence:' citations, '//' notes, blank lines",
    /#/.test(DECK_OUTLINE_HEADER) && /> evidence:/.test(DECK_OUTLINE_HEADER) && /\/\//.test(DECK_OUTLINE_HEADER) && /[Bb]lank lines/.test(DECK_OUTLINE_HEADER)
  );
  ok("the header is invisible to the parser -- parsing with and without it yields identical slides", JSON.stringify(parseDeckOutline(stored)) === JSON.stringify(parseDeckOutline(body)));
  ok("ensureOutlineHeader is idempotent -- re-storing an already-headed outline never stacks headers", ensureOutlineHeader(stored) === stored);
}

// --- 3. The deck view route: deterministic rendering of approved text only --

section("deck view route: approved only, zero model calls, no deck library, the shared parser");

const ROUTE = "app/prospects/[id]/deck/[draftId]/page.tsx";
const routeText = readFileSync(join(root, ROUTE), "utf8");
// Statements only -- the comments legitimately DISCUSS what must not exist.
const routeCode = routeText
  .split("\n")
  .map((l) => l.replace(/\/\/.*$/, ""))
  .join("\n");

ok(
  "rendering makes ZERO model calls: no anthropic import, no messages.create/stream, and no run-ledger write (nothing runs, so nothing is metered)",
  !/anthropic/i.test(routeCode) && !/\.messages\s*\.\s*(create|stream)\s*\(/.test(routeCode) && !/beginRun|finalizeRun/.test(routeCode)
);
{
  const imports = [...routeCode.matchAll(/from\s+["']([^"']+)["']/g)].map((m) => m[1]);
  ok(
    "no external deck/PDF library: every import is next/*, or this codebase's own @/lib and @/components",
    imports.length > 0 && imports.every((i) => i.startsWith("next/") || i.startsWith("next-") || i.startsWith("@/lib/") || i.startsWith("@/components/")),
    `imports: ${imports.join(", ")}`
  );
}
ok("the slides come from the SHARED parser (parseDeckOutline from lib/deck-outline) -- no second parser exists in the route", /from\s+["']@\/lib\/deck-outline["']/.test(routeCode) && /parseDeckOutline\(draft\.content\)/.test(routeCode));
ok("the generation action imports the SAME module -- one format definition for writer and renderer", /from\s+["']@\/lib\/deck-outline["']/.test(readFileSync(join(root, "app/(dashboard)/prospects/[id]/draft-actions.ts"), "utf8")));
ok("typography and colors come from the shared UI tokens (lib/ui)", /from\s+["']@\/lib\/ui["']/.test(routeCode));

{
  const approvedGateAt = routeCode.indexOf('draft.status !== "approved"');
  const parseAt = routeCode.indexOf("parseDeckOutline(draft.content)");
  const slideMarkupAt = routeCode.indexOf('className="deck-slide"');
  ok(
    "an UNAPPROVED deck draft never renders as slides: the approved gate returns a plain message BEFORE any parse or slide markup",
    approvedGateAt >= 0 && parseAt > approvedGateAt && slideMarkupAt > approvedGateAt,
    `gate at ${approvedGateAt}, parse at ${parseAt}, slide markup at ${slideMarkupAt}`
  );
}
ok(
  "the unapproved branch points back to review on the prospect's Strategy tab",
  /tab=strategy/.test(routeCode) && /[Rr]eview and approve/.test(routeText)
);
ok(
  "the route never renders a deck for a non-deck draft (kind checked in code, not by an enum filter that would error pre-migration)",
  /draft\.kind !== "deck"\) notFound\(\)/.test(routeCode) && !/\.eq\("kind"/.test(routeCode)
);
ok(
  "the draft is fetched by draft id AND prospect id -- a draft id pasted under another prospect's URL resolves to nothing",
  /\.eq\("id", params\.draftId\)[\s\S]{0,80}\.eq\("prospect_id", params\.id\)/.test(routeCode)
);
ok("the route re-checks the session itself, like every dashboard page", /supabase\.auth\.getUser\(\)/.test(routeCode) && /redirect\("\/login"\)/.test(routeCode));

ok(
  "print styling: an @media print block, one slide per page (break-after), and the screen-only chrome hidden in print",
  /@media print/.test(routeCode) && /break-after:\s*page/.test(routeCode) && /\.deck-screen-only\s*\{\s*display:\s*none/.test(routeCode)
);
ok(
  "the on-screen note says print-to-PDF is the export, and is marked screen-only so it never prints onto a slide",
  /Save as\s+PDF/.test(routeText) && /className="deck-screen-only"/.test(routeText)
);
ok(
  "evidence citations resolve READ-ONLY from the evidence library (a select, no insert/update/delete anywhere in the route)",
  /\.from\("evidence_items"\)\.select\("id, title, type"\)/.test(routeCode) && !/\.insert\(|\.update\(|\.delete\(/.test(routeCode)
);
ok(
  "an id the library cannot answer renders as explicitly unresolved -- never silently dropped from the slide",
  /not found in the evidence library/.test(routeText)
);

// The route lives OUTSIDE the (dashboard) group so the sidebar shell never
// prints onto the deck; the middleware's /prospects prefix still gates it.
ok(
  "the middleware's auth matcher covers /prospects, which covers this route's URL",
  /"\/prospects"/.test(readFileSync(join(root, "middleware.ts"), "utf8"))
);

console.log(`\n${pass} passed, ${fail} failed.`);
if (fail > 0) process.exit(1);
