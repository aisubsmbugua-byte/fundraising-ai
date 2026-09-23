// STATE item 69: "[Insert Date]" reached a human as a live placeholder in
// a real proposal draft. Two independent layers close it, so a single
// point of failure never reaches review -- measured prompt-only
// compliance on this codebase is 52-80%, so the prompt instruction alone
// is not the guarantee:
//
//   1. The prompt is handed TODAY'S ACTUAL DATE (capture, don't retype --
//      the model is never asked to know today) and told to write it
//      verbatim if a date belongs in the document, never a placeholder.
//   2. The action deterministically scans its own output afterward and
//      replaces any bracketed date-shaped placeholder with that same
//      date -- the safety net for the model ignoring layer 1.
//
// Pulled into its own module (the ensureOutlineHeader/deck-outline.ts
// pattern) rather than living inline in draft-actions.ts: that file is a
// "use server" Server Actions module, which Next.js requires to export
// ONLY async functions, so these pure, synchronous helpers cannot live
// (or be exported for the test suite to exercise directly) there.
//
// Applied to both generateProposalDraft and generateDeckOutline: the
// proposal is where this was observed in real usage, but a deck
// outline's title slide carries the same risk and gets the same two
// layers, per the same audit.

// Long form, with a year, to read naturally in a letterhead-style
// document a funder will see -- e.g. "September 23, 2026".
export function todaysDateLabel(): string {
  return new Date().toLocaleDateString("en-US", { month: "long", day: "numeric", year: "numeric" });
}

// Broad and case-insensitive on purpose, not a literal match on "[Insert
// Date]": a model that ignores the instruction not to write a placeholder
// is exactly the model that phrases it as "[DATE]" or "[Today's Date]"
// instead. Matches a single bracketed span containing the word "date".
export const DATE_PLACEHOLDER = /\[[^[\]]{0,40}\bdate\b[^[\]]{0,40}\]/gi;

// Pure: same text and label in, same text out. Replaces every bracketed
// date-shaped placeholder with the real date -- never removes a bracket
// that isn't date-shaped (an evidence citation, a "[Phone Number]"
// placeholder handled elsewhere, etc).
export function fillDatePlaceholders(content: string, todayLabel: string): string {
  return content.replace(DATE_PLACEHOLDER, todayLabel);
}
