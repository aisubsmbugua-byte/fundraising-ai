// The deck outline format (STATE item 66, decision 0007 phase 3's second
// half): the ONE definition of how a deck outline's text becomes slides.
//
// Both the generation action (which stores the outline as a reviewable
// draft) and the deck view route (which renders the APPROVED outline)
// import this module -- there is no second parser anywhere, so what the
// human edited and approved in the draft editor is, by construction, what
// the deck renders. Rendering is this parse and nothing else: no model
// call, no external deck/PDF library.
//
// The format is deliberately minimal and self-documenting -- a human must
// be able to read and edit it in the plain-text draft editor with no
// instructions from anywhere else, which is why every stored outline
// BEGINS with the explanatory header below, prepended in code (never
// trusted to the model -- measured prompt-only compliance on this
// codebase is 52-80%, so a guarantee that matters lives here instead):
//
//   //             a comment line: notes for the editor, never on a slide
//   # Title        starts a new slide, titled "Title"
//   plain text     a bullet point on the current slide
//   > evidence: X  cites evidence-library item X; renders as a
//                  footnote-style attribution resolved from the library
//
// Blank lines are ignored. Body lines before the first "#" line land on a
// leading untitled slide rather than being dropped -- a model-typed field
// is a claim, and a human's stray line is still their line. A ">" line
// that is not an evidence citation is likewise kept as a bullet, never
// silently discarded.

export type DeckSlide = {
  // null for the leading untitled slide that collects any body lines
  // appearing before the first "#" line.
  title: string | null;
  bullets: string[];
  // Evidence ids cited on THIS slide, in the order written.
  evidenceIds: string[];
};

export type DeckOutline = {
  slides: DeckSlide[];
  // Every evidence id cited anywhere in the outline, deduplicated, in
  // first-appearance order -- what a renderer resolves against the
  // evidence library, and what the generation action validates against
  // the pool the model was handed.
  evidenceIds: string[];
};

// The self-documentation every stored outline starts with. Exported so
// the generation action can prepend it (ensureOutlineHeader) and tests
// can assert it is code-enforced, not model-remembered.
export const DECK_OUTLINE_HEADER = `// How to edit this deck outline ("//" lines are notes and never appear on a slide):
//   # Title          starts a new slide with that title
//   plain text       a bullet point on the current slide
//   > evidence: ID   cites an evidence-library item; it renders on the
//                    slide as a footnote attribution (keep the ID exact)
// Blank lines are ignored. The approved deck renders exactly this text.`;

// Prepends the format header unless the outline already carries it.
// Idempotent, so an edited-and-regenerated content never stacks headers.
export function ensureOutlineHeader(content: string): string {
  const headerFirstLine = DECK_OUTLINE_HEADER.split("\n")[0];
  if (content.trimStart().startsWith(headerFirstLine)) return content;
  return `${DECK_OUTLINE_HEADER}\n\n${content}`;
}

const COMMENT_LINE = /^\/\//;
const TITLE_LINE = /^#+\s*(.*)$/;
// Forgiving about spacing and case; strict that the citation is a single
// token -- an id, not a sentence.
const EVIDENCE_LINE = /^>\s*evidence:\s*(\S+)\s*$/i;

// The one deterministic parse. Pure: same text in, same slides out.
export function parseDeckOutline(text: string): DeckOutline {
  const slides: DeckSlide[] = [];
  const allEvidenceIds: string[] = [];
  const seenEvidenceIds = new Set<string>();
  let current: DeckSlide | null = null;

  const openSlide = (title: string | null): DeckSlide => {
    const slide: DeckSlide = { title, bullets: [], evidenceIds: [] };
    slides.push(slide);
    return slide;
  };

  for (const rawLine of text.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;
    if (COMMENT_LINE.test(line)) continue;

    const title = line.match(TITLE_LINE);
    if (title) {
      current = openSlide(title[1].trim() || null);
      continue;
    }

    if (!current) current = openSlide(null);

    const evidence = line.match(EVIDENCE_LINE);
    if (evidence) {
      const id = evidence[1];
      current.evidenceIds.push(id);
      if (!seenEvidenceIds.has(id)) {
        seenEvidenceIds.add(id);
        allEvidenceIds.push(id);
      }
      continue;
    }

    current.bullets.push(line);
  }

  return { slides, evidenceIds: allEvidenceIds };
}
