// Step 3 acceptance tests: page selection and fetch outcomes.
//
// Pure logic, no network and no model. The model call itself is a thin wrapper;
// everything that could go wrong on the way in (what it is shown) and on the
// way out (what we do with its answer) is tested here.
//
// Run: npx tsx scripts/test-tier2-selection.ts

import { buildManifest, type DiscoveredUrl } from "../lib/tier2/manifest";
import { buildSelectionPrompt, resolveSelection, MAX_SELECTED, SELECTION_TOOL } from "../lib/tier2/select";
import { extractText, purposeCoverage, type FetchedPage } from "../lib/tier2/fetch";
import { extractIdentityEvidence, completesIdentity } from "../lib/tier2/identity-evidence";

let passed = 0;
let failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  if (ok) passed++;
  else failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function section(t: string) {
  console.log(`\n${t}`);
}

const u = (url: string, title?: string): DiscoveredUrl => ({ url, title });
const MACLELLAN = buildManifest(
  ["/fund", "/grantees", "/faq", "/fiscal-sponsorship", "/multi-year", "/our-foundations", "/history"].map((p) =>
    u(`https://maclellan.net${p}`)
  ),
  { host: "maclellan.net" }
);

// ---------------------------------------------------------------------------
section("What the model is shown");
// ---------------------------------------------------------------------------

const prompt = buildSelectionPrompt({ manifest: MACLELLAN, funderName: "Maclellan Foundation" });
check("the funder is named", prompt.includes("Maclellan Foundation"), true);
check("pages are listed by index", prompt.includes("[0] https://maclellan.net/"), true);
check("the cap on selections is stated", prompt.includes(`at most ${MAX_SELECTED}`), true);
check("it is told to use indices, not URLs", prompt.includes("Do not write URLs"), true);
check(
  "an opportunity is named when there is one",
  buildSelectionPrompt({ manifest: MACLELLAN, funderName: "Missio Nexus", opportunityName: "Ministry Innovation Fund" }).includes(
    '"Ministry Innovation Fund"'
  ),
  true
);

// A capped manifest must say so. Otherwise the model reasons over a partial
// site believing it is complete -- the same mistake the identity search made.
const cappedManifest = buildManifest(
  Array.from({ length: 200 }, (_, i) => u(`https://x.org/dir-${i}/page`)),
  { host: "x.org", maxEntries: 10 }
);
check("a capped manifest declares the pages it is not showing", buildSelectionPrompt({ manifest: cappedManifest, funderName: "X" }).includes("190 further pages"), true);
check("an uncapped one makes no such claim", prompt.includes("further pages exist"), false);

// The tool forces structure, so nothing has to be parsed back out of prose.
check("the tool requires both selections and unavailable purposes", SELECTION_TOOL.input_schema.required, ["selections", "unavailable_purposes"]);

// ---------------------------------------------------------------------------
section("What we accept back");
// ---------------------------------------------------------------------------

const entries = MACLELLAN.entries;
check(
  "valid indices resolve to their URLs",
  resolveSelection({ selections: [{ index: 0, purposes: ["priorities"] }], unavailable_purposes: [] }, entries).selected[0].url,
  entries[0].url
);

// Strict on purpose. Clamping an out-of-range index would silently substitute
// a different page for the one that was chosen -- the exact quiet substitution
// this pipeline exists to remove.
check(
  "an out-of-range index is discarded, never clamped",
  resolveSelection({ selections: [{ index: 999, purposes: ["priorities"] }], unavailable_purposes: [] }, entries),
  { selected: [], unavailablePurposes: [], discarded: 1 }
);
check(
  "a negative index is discarded",
  resolveSelection({ selections: [{ index: -1, purposes: [] }], unavailable_purposes: [] }, entries).discarded,
  1
);
check(
  "a non-integer index is discarded",
  resolveSelection({ selections: [{ index: "2" as unknown, purposes: [] }], unavailable_purposes: [] }, entries).discarded,
  1
);
check(
  "a duplicate index is counted once",
  resolveSelection(
    { selections: [{ index: 1, purposes: ["priorities"] }, { index: 1, purposes: ["grants"] }], unavailable_purposes: [] },
    entries
  ).selected.length,
  1
);
check(
  "an invented purpose is dropped but the page is kept",
  resolveSelection({ selections: [{ index: 1, purposes: ["priorities", "vibes"] }], unavailable_purposes: [] }, entries).selected[0].purposes,
  ["priorities"]
);
check(
  "more than the cap is truncated",
  resolveSelection(
    { selections: entries.map((_, i) => ({ index: i, purposes: ["priorities"] })), unavailable_purposes: [] },
    entries
  ).selected.length <= MAX_SELECTED,
  true
);
check(
  "declared-unavailable purposes survive",
  resolveSelection({ selections: [], unavailable_purposes: ["grants", "process"] }, entries).unavailablePurposes,
  ["grants", "process"]
);
check("a malformed response yields nothing rather than throwing", resolveSelection({}, entries), { selected: [], unavailablePurposes: [], discarded: 0 });

// ---------------------------------------------------------------------------
section("Text extraction");
// ---------------------------------------------------------------------------

check(
  "scripts and styles are removed entirely",
  extractText("<p>Grants</p><script>var x = 'apply now';</script><style>.a{}</style>"),
  "Grants"
);
check(
  "block boundaries become line breaks, not run-on prose",
  extractText("<li>Education</li><li>Health</li>"),
  "Education\nHealth"
);
check("entities are decoded", extractText("<p>Grants &amp; Programs</p>"), "Grants & Programs");
check("a comment is not content", extractText("<!-- hidden --><p>Visible</p>"), "Visible");
check("an empty document yields empty text", extractText("<html><head></head><body></body></html>"), "");

// ---------------------------------------------------------------------------
section("Coverage: four different reasons a purpose has no answer");
// ---------------------------------------------------------------------------

const SUBSTANTIVE = "x".repeat(2000);
const page = (over: Partial<FetchedPage>): FetchedPage => ({
  url: "https://x.org/a", purposes: [], state: "found", httpStatus: 200, text: SUBSTANTIVE, chars: SUBSTANTIVE.length,
  truncated: false, contentType: "text/html", fetchedAt: "2026-09-02T00:00:00Z", failure: null, ...over,
});

const coverage = purposeCoverage(
  [
    page({ purposes: ["priorities", "eligibility"], state: "found" }),
    page({ purposes: ["process"], state: "retrieval_failed", httpStatus: 403, failure: "HTTP 403" }),
  ],
  ["grants"]
);
check("a page that loaded covers its purposes", coverage.priorities, "found");
check("one page can cover several purposes", coverage.eligibility, "found");
// The distinction that stops a pointless rerun: a 403 might succeed later, a
// site that has no grant list never will.
check("a page that failed to load is retrieval_failed, not missing", coverage.process, "retrieval_failed");
check("a purpose the site does not offer is not_offered", coverage.grants, "not_offered");
check("a purpose nobody looked for is not_checked", coverage.identity, "not_checked");

// A found page alongside a failed one still counts as covered -- the purpose
// was answered, whatever else did not load.
// A page that loads and says nothing is neither found nor failed. Real case:
// maclellan.net/fund is 104KB of HTML yielding 528 characters, because "what
// we fund" is delivered as an embedded video. Reporting that as "found" would
// claim we had read their priorities when we had read their navigation.
const thin = purposeCoverage([page({ purposes: ["priorities"], text: "Fund - Maclellan Foundation Skip to content" })], []);
check("a page too thin to have said anything is found_thin", thin.priorities, "found_thin");
check(
  "...and a substantive page for the same purpose outranks it",
  purposeCoverage(
    [page({ purposes: ["priorities"], text: "short" }), page({ purposes: ["priorities"], text: SUBSTANTIVE })],
    []
  ).priorities,
  "found"
);
check(
  "found_thin is not a failure -- refetching returns the same video",
  purposeCoverage([page({ purposes: ["grants"], text: "tiny" })], []).grants !== "retrieval_failed",
  true
);

check(
  "one success is enough for a purpose",
  purposeCoverage([page({ purposes: ["priorities"], state: "retrieval_failed" }), page({ purposes: ["priorities"], state: "found" })], []).priorities,
  "found"
);

// ---------------------------------------------------------------------------
section("Identity evidence: Tier 2 completing Tier 1");
// ---------------------------------------------------------------------------

// The case this exists for. 14 of 30 funders could not be resolved from a name
// search -- churches and denominational programs whose display name matches no
// registered legal name. Their own footer usually states the EIN.
const footer = [{ url: "https://x.org/give", text: "Gifts are tax deductible. EIN: 62-1234567\nX Ministries Inc\n100 Main St, Chattanooga, TN 37402" }];
const ev = extractIdentityEvidence(footer);
check("an EIN in a donation footer is found", ev.agreedEin, "621234567");
check("...with the page that stated it", ev.eins[0].url, "https://x.org/give");
check("a mailing state is captured", ev.states, ["TN"]);
check("a legal name line is captured", ev.legalNames.includes("X Ministries Inc"), true);

// Unanimity, not majority. A site naming two EINs is describing two entities --
// an affiliated fund, a fiscal sponsor -- and picking the more frequent one
// would be guessing which organization we are looking at.
const twoEins = extractIdentityEvidence([
  { url: "https://x.org/a", text: "EIN 62-1234567" },
  { url: "https://x.org/b", text: "EIN 62-1234567 and also EIN 58-7654321" },
]);
check("two different EINs resolve nothing", twoEins.agreedEin, null);
check("...but both are recorded", new Set(twoEins.eins.map((e) => e.ein)).size, 2);
check("the same EIN twice is still unanimous", extractIdentityEvidence([
  { url: "https://x.org/a", text: "EIN 62-1234567" },
  { url: "https://x.org/b", text: "ein 62-1234567" },
]).agreedEin, "621234567");
check("no EIN anywhere resolves nothing", extractIdentityEvidence([{ url: "https://x.org/a", text: "We fund education." }]).agreedEin, null);
check("an empty page is not evidence", extractIdentityEvidence([{ url: "https://x.org/a", text: "" }]).eins, []);

// Only an EIN reopens Tier 1. A name or a state narrows a search without
// settling it, and re-running on those alone repeats the same ambiguity with
// more confidence attached.
check("a new EIN lets Tier 1 try again", completesIdentity(ev, null), true);
check("an EIN we already had changes nothing", completesIdentity(ev, "62-1234567"), false);
check("a legal name alone does not reopen it", completesIdentity(extractIdentityEvidence([{ url: "u", text: "Y Foundation Inc\n, TN 37402" }]), null), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
