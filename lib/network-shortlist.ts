// Narrowing a large network for one path-finding look (STATE item 103, ruling
// 0040 clause 7; it replaces item 77's refusal above a fixed number).
//
// The general invariant: when more people are recorded than one look can
// consider, the code chooses whom the model sees by a FIXED, NAMED, READABLE
// rule, and every result says how many were considered of how many are
// recorded and by what rule. A person left out was not examined -- that is not
// a judgement about them -- so "no path" always reads "none found among those
// considered", never "none exist".
//
// Pure: no database, no model, no clock. Token containment, deliberately, and
// not fuzzy similarity -- the codebase's attestation precedent (CLAUDE.md,
// "Attestation"): a threshold loose enough to forgive wording variance also
// accepts an invented link that shares a word.
//
// THE RULE, as implemented below:
//   1. Words. Lowercase, strip accents, split on anything that is not a letter
//      or a digit. A DISTINCTIVE word is one of at least MIN_SHARED_WORD_LENGTH
//      characters, containing at least one letter (a bare year is not a word),
//      and not in GENERIC_WORDS.
//   2. The funder's side. The words of the approved anchor claims' text.
//   3. A person is shortlisted when at least one distinctive word from their
//      name, affiliation, how-known text or notes also appears in the anchor
//      claims. (Ruling 0040 clause 7 names all four fields.)
//   4. Score = the number of DISTINCT shared distinctive words, plus
//      WHOLE_NAME_BONUS when the person's whole name appears in the claims
//      (every non-generic word of the name, at least two of them).
//   5. Order: score descending, then created_at ascending, then id ascending.
//      Nothing else, so the same input always gives the same shortlist.
//   6. Keep the first NETWORK_PATHS_MAX_CONSIDERED.
//   7. A network at or under NETWORK_PATHS_MAX_CONSIDERED is not narrowed at
//      all: every person is considered, in the order they came in.

import type { NetworkConnection } from "@/lib/network";

// The most people one path-finding look considers. Also the size above which
// the network is narrowed instead of considered whole.
export const NETWORK_PATHS_MAX_CONSIDERED = 150;

// A word shorter than this is never a shared word (it is too easily chance).
export const MIN_SHARED_WORD_LENGTH = 4;

// For the whole-name test only: a name word shorter than this (an initial) is
// ignored, so "J. Smith" is tested as "smith" and a single letter never counts.
export const MIN_NAME_WORD_LENGTH = 2;

// A whole-name match must outrank any number of shared affiliation words.
export const WHOLE_NAME_BONUS = 1000;

// A closed list, as data. These words are common to many organizations, titles
// and sentences, so sharing one is not evidence of a link. It is tested
// (scripts/test-network.ts) and reported, and extending it is a code change.
export const GENERIC_WORDS: readonly string[] = [
  // organization forms and types
  "church", "churches", "foundation", "foundations", "fund", "funds", "trust", "trusts",
  "inc", "llc", "ltd", "corp", "corporation", "company", "group", "groups",
  "ministries", "ministry", "international", "national", "global", "association",
  "associations", "society", "university", "college", "school", "schools", "center",
  "centre", "centers", "centres", "institute", "community", "communities", "network",
  "council", "alliance", "partners", "partnership", "organization", "organisation",
  "nonprofit", "charity", "charitable", "philanthropic", "philanthropies", "family",
  "families", "services", "service", "program", "programs", "development",
  "american", "united", "states", "first", "second", "new",
  // roles and titles
  "board", "member", "members", "director", "directors", "president", "pastor", "chair",
  "chairman", "chairwoman", "chairperson", "officer", "executive", "manager", "vice",
  "senior", "associate", "assistant", "treasurer", "secretary", "founder", "trustee",
  "dr", "mr", "mrs", "ms", "miss", "rev", "reverend", "jr", "sr", "ii", "iii", "esq",
  "phd", "prof", "professor", "hon", "honorable", "bishop", "deacon", "elder", "rabbi",
  // the vocabulary of funder facts themselves
  "grant", "grants", "grantee", "giving", "funding", "funded", "award", "awarded",
  "awards", "annual", "recipient", "recipients", "support", "supports", "supported",
  // ordinary words
  "the", "and", "for", "with", "from", "that", "this", "have", "been", "were", "also",
  "into", "over", "such", "than", "then", "them", "they", "their", "there", "which",
  "while", "whom", "whose", "about", "after", "other", "some", "will", "your", "only",
  "more", "most", "many", "much", "very", "each", "both", "known", "knows",
];

const GENERIC = new Set(GENERIC_WORDS);

// Lowercase, accents stripped, split on anything that is not a letter or digit.
export function tokenize(text: string | null | undefined): string[] {
  if (!text) return [];
  return text
    .normalize("NFD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((t) => t.length > 0);
}

export function isDistinctiveWord(token: string): boolean {
  return token.length >= MIN_SHARED_WORD_LENGTH && /\p{L}/u.test(token) && !GENERIC.has(token);
}

export function distinctiveWords(text: string | null | undefined): Set<string> {
  return new Set(tokenize(text).filter(isDistinctiveWord));
}

export type ShortlistablePerson = Pick<NetworkConnection, "id" | "person_name" | "affiliation" | "how_known" | "notes" | "created_at">;

export type Shortlist<T> = {
  considered: T[];
  totalRecorded: number;
  narrowed: boolean;
  // How many recorded people shared at least one distinctive word with the
  // funder's approved facts, before the limit was applied. Null when the
  // network was not narrowed (no matching was run -- everyone was considered).
  matched: number | null;
  // The stated rule, as one plain sentence. The UI and the result both reuse it.
  rule: string;
};

// The rule as a sentence, built from the constants so the sentence cannot
// drift from the numbers the code uses.
export function shortlistRuleSentence(): string {
  return `people are chosen when their name, affiliation, how-you-know-them text or notes share a distinctive word (${MIN_SHARED_WORD_LENGTH} or more letters, and not a common word such as "church", "foundation" or "director") with this funder's approved facts; those sharing the most words, with a full-name match first, are considered, up to ${NETWORK_PATHS_MAX_CONSIDERED} people`;
}

function createdAtMs(p: ShortlistablePerson): number {
  const ms = Date.parse(p.created_at);
  return Number.isNaN(ms) ? 0 : ms;
}

// Score one person against the funder's words. Returns null when they share
// no distinctive word (so they are not shortlisted).
function scorePerson(p: ShortlistablePerson, claimWords: ReadonlySet<string>): number | null {
  const shared = new Set<string>();
  for (const field of [p.person_name, p.affiliation, p.how_known, p.notes]) {
    for (const w of distinctiveWords(field)) if (claimWords.has(w)) shared.add(w);
  }
  if (shared.size === 0) return null;
  let score = shared.size;
  const nameWords = tokenize(p.person_name).filter((t) => t.length >= MIN_NAME_WORD_LENGTH && !GENERIC.has(t));
  if (nameWords.length >= 2 && nameWords.every((w) => claimWords.has(w))) score += WHOLE_NAME_BONUS;
  return score;
}

export function shortlistConnections<T extends ShortlistablePerson>(
  connections: readonly T[],
  anchorClaims: readonly { claim: string }[]
): Shortlist<T> {
  const rule = shortlistRuleSentence();
  const totalRecorded = connections.length;
  if (totalRecorded <= NETWORK_PATHS_MAX_CONSIDERED) {
    // Not narrowed: everyone, in the order they came in -- exactly as before.
    return { considered: [...connections], totalRecorded, narrowed: false, matched: null, rule };
  }
  const claimWords = new Set<string>();
  for (const c of anchorClaims) for (const t of tokenize(c.claim)) claimWords.add(t);

  const scored: { person: T; score: number; at: number }[] = [];
  for (const person of connections) {
    const score = scorePerson(person, claimWords);
    if (score !== null) scored.push({ person, score, at: createdAtMs(person) });
  }
  scored.sort((a, b) => b.score - a.score || a.at - b.at || (a.person.id < b.person.id ? -1 : a.person.id > b.person.id ? 1 : 0));
  return {
    considered: scored.slice(0, NETWORK_PATHS_MAX_CONSIDERED).map((s) => s.person),
    totalRecorded,
    narrowed: true,
    matched: scored.length,
    rule,
  };
}

// "Considered X of Y recorded people (<rule>)." -- stated in every result.
export function consideredSentence(s: Pick<Shortlist<unknown>, "considered" | "totalRecorded" | "narrowed" | "matched" | "rule">): string {
  const x = s.considered.length;
  const y = s.totalRecorded;
  if (!s.narrowed) {
    return `Considered ${x} of ${y} recorded people (everyone: your network is within the ${NETWORK_PATHS_MAX_CONSIDERED} one look considers, so nobody was left out).`;
  }
  const cut =
    s.matched !== null && s.matched > x
      ? ` ${s.matched} people shared such a word, so only the ${x} sharing the most were considered.`
      : "";
  return `Considered ${x} of ${y} recorded people (${s.rule}).${cut} The rest were not examined, which is not a judgement about them.`;
}

// When narrowing leaves nobody: no model call is made, so this says plainly
// that nobody was examined and how to widen the look.
export function emptyShortlistMessage(s: Pick<Shortlist<unknown>, "totalRecorded" | "rule">): string {
  return `Considered 0 of ${s.totalRecorded} recorded people (${s.rule}). None of your ${s.totalRecorded} recorded people share a distinctive word with this funder's approved facts, so none were examined and the AI was not asked. To widen the look, approve more of this funder's facts on the Research tab, or add affiliation and how-you-know-them detail to the people you have recorded.`;
}

// The sentence shown after a look that did ask the model.
export function pathsOutcomeMessage(args: {
  stored: number;
  alreadyKnown: number;
  shortlist: Pick<Shortlist<unknown>, "considered" | "totalRecorded" | "narrowed" | "matched" | "rule">;
}): string {
  const considered = consideredSentence(args.shortlist);
  if (args.stored > 0) {
    return `Found ${args.stored} possible path${args.stored === 1 ? "" : "s"} among those considered. Review them below. ${considered}`;
  }
  if (args.alreadyKnown > 0) {
    return `No new paths — everything the AI found among those considered is already listed below. ${considered}`;
  }
  return `No paths: none found among those considered. ${considered}`;
}
