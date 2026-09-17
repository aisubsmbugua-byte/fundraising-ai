// What a funder's own site tells us about who it legally is.
//
// This is the Tier 1 <-> Tier 2 exchange, and it runs in the direction that
// matters most. Measured across the live pipeline, 14 of 30 funders could not
// be resolved to a registry record and 3 more hit a truncated search -- almost
// all of them churches and denominational programs whose DISPLAY name
// corresponds to no registered legal name. No amount of query tuning fixes
// that, because the name we hold is not the name that was filed.
//
// Their own website usually states it. An EIN in a donation footer, a legal
// name in a copyright line, a mailing address on a contact page: each is
// enough to turn a fuzzy name search into a deterministic lookup.
//
// Deliberately deterministic. A model reading these pages would be writing an
// EIN rather than finding one, and a fabricated EIN resolves to a real and
// entirely unrelated organization -- the worst failure this build can commit.

import { extractEinCandidates } from "../research";

// Two-letter state in a US address tail: "Chattanooga, TN 37402".
const ADDRESS_STATE = /,\s*([A-Z]{2})\s+\d{5}(?:-\d{4})?\b/g;
// "Legal name" as organizations write it about themselves.
const LEGAL_NAME_LINE =
  /(?:^|\n)\s*(?:©|\(c\)|copyright)?\s*(?:\d{4}\s+)?([A-Z][A-Za-z&.,'’\- ]{4,80}?(?:Foundation|Fund|Trust|Ministries|Ministry|Inc\.?|Incorporated|Corporation|Church|Association|Society)),?/g;

export type IdentityEvidence = {
  // Every EIN seen, with the page that stated it. Never one "best" value: two
  // different EINs on one site is a real finding, not a tie to break silently.
  eins: { ein: string; url: string }[];
  states: string[];
  legalNames: string[];
  // The single EIN to hand Tier 1, populated ONLY when the site is unanimous.
  // Disagreement is reported and resolves nothing.
  agreedEin: string | null;
};

export function extractIdentityEvidence(pages: { url: string; text: string }[]): IdentityEvidence {
  const eins: { ein: string; url: string }[] = [];
  const states = new Set<string>();
  const legalNames = new Set<string>();

  for (const page of pages) {
    if (!page.text) continue;

    for (const raw of extractEinCandidates(page.text)) {
      const digits = raw.replace(/\D/g, "");
      if (digits.length === 9) eins.push({ ein: digits, url: page.url });
    }

    for (const m of page.text.matchAll(ADDRESS_STATE)) states.add(m[1]);

    for (const m of page.text.matchAll(LEGAL_NAME_LINE)) {
      const name = m[1].replace(/\s+/g, " ").trim();
      // A copyright line is the most reliable place an organization writes its
      // own legal name, and also where sites put a tagline. Length is the
      // cheapest guard against capturing a sentence.
      if (name.length >= 6 && name.length <= 80) legalNames.add(name);
    }
  }

  const distinct = [...new Set(eins.map((e) => e.ein))];
  return {
    eins,
    states: [...states],
    legalNames: [...legalNames],
    // Unanimity, not majority. A site stating two EINs is describing two
    // entities -- an affiliated fund, a fiscal sponsor -- and picking the more
    // frequent one would be guessing which organization we are looking at.
    agreedEin: distinct.length === 1 ? distinct[0] : null,
  };
}

// Does this evidence let Tier 1 try again?
//
// Only a confirmed EIN does. A legal name or a state narrows a search but does
// not settle it, and re-running on those alone would repeat the same ambiguity
// with more confidence attached to it.
export function completesIdentity(evidence: IdentityEvidence, alreadyKnownEin: string | null | undefined): boolean {
  const known = (alreadyKnownEin ?? "").replace(/\D/g, "");
  return Boolean(evidence.agreedEin) && evidence.agreedEin !== known;
}
