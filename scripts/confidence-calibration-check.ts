// Demonstrates that confidence in the Research Agent's extraction call is
// assigned from the explicit rubric in the prompt (see
// lib/ai/research-extract.ts), not generated loosely -- weak, conflicting,
// or indirect/inferred evidence should produce medium/low confidence, not
// the uniform "high" seen on every one of the real Maclellan run's claims.
//
// Calls extractResearchClaims() directly -- no DB, no auth -- against
// three hand-written, fabricated findings blocks designed to probe each
// end of the rubric. Real (small-cost) Anthropic calls.
//
// Usage: npx tsx --env-file=.env.local scripts/confidence-calibration-check.ts

import { extractResearchClaims, type IndexedSource } from "../lib/ai/research-extract";

const CASES: { label: string; expectation: string; findings: string; sources: IndexedSource[] }[] = [
  {
    label: "Direct, authoritative, single source",
    expectation: "expect high confidence, claim_type fact",
    findings: `From the Example Family Foundation's official website (examplefoundation.org/about): "The Example Family Foundation is headquartered in Austin, Texas." This is the foundation's own primary source, stated plainly with no ambiguity.`,
    sources: [{ url: "https://examplefoundation.org/about", title: "About — Example Family Foundation", pageAge: null }],
  },
  {
    label: "Conflicting sources on the same fact",
    expectation: "expect low confidence (or a 'conflicting' coverage entry), not high",
    findings: `Source 1 (a 2019 grant directory listing): "Example Family Foundation is based in Austin, Texas."
Source 2 (a 2023 nonprofit news article): "Example Family Foundation, headquartered in Dallas, Texas, announced a new initiative..."
These two sources disagree on the foundation's location and neither is clearly more authoritative or more recent in a way that's stated.`,
    sources: [
      { url: "https://grantdirectory.example.com/example-family-foundation", title: "Example Family Foundation — Grant Directory", pageAge: "2019" },
      { url: "https://nonprofitnews.example.com/2023/example-family-foundation-initiative", title: "Example Family Foundation announces new initiative", pageAge: "2023" },
    ],
  },
  {
    label: "Vague, indirect mention requiring inference",
    expectation: "expect medium/low confidence and claim_type hypothesis, not fact",
    findings: `A blog post about nonprofit funding trends mentions in passing: "...organizations like the Example Family Foundation tend to favor grantees with an education focus, based on the handful of grants we've seen referenced online." No direct statement of the foundation's own stated focus areas exists in these findings.`,
    sources: [{ url: "https://fundingtrendsblog.example.com/2024/who-funds-education", title: "Who's funding education this year?", pageAge: null }],
  },
];

async function main() {
  for (const testCase of CASES) {
    console.log(`\n=== ${testCase.label} (${testCase.expectation}) ===`);
    const result = await extractResearchClaims({ prospectName: "Example Family Foundation", findings: testCase.findings, sources: testCase.sources });
    if (result.claims.length === 0) {
      console.log("No claims extracted (coverage:", JSON.stringify(result.coverage), ")");
      continue;
    }
    for (const claim of result.claims) {
      const cited = claim.source_indices.map((i) => testCase.sources[i]?.url).filter(Boolean);
      console.log(
        `  [${claim.confidence}/${claim.claim_type}] ${claim.claim_key}: ${claim.claim}` +
          (claim.confidence_reason ? ` (reason: ${claim.confidence_reason})` : "") +
          ` -- cited: ${cited.length > 0 ? cited.join(", ") : "(none)"}`
      );
    }
  }
}

main()
  .then(() => console.log("\nDone. Compare each case's actual confidence/claim_type against its expectation above."))
  .catch((err) => {
    console.error("FAILED:", err);
    process.exit(1);
  });
