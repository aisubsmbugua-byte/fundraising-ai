// Step 3 acceptance tests: deterministic manifest reduction.
//
// Pure logic, no network, no model. This is the step between "we found the
// site's URLs" and "a model picks pages to read", and it exists because those
// two were conflated: EAA Aviation returned 5,566 URLs of which 992 matched a
// keyword filter, and Missio Nexus matched 396 of 410. Handing either to a
// model recreates the problem the pipeline exists to remove.
//
// Run: npx tsx scripts/test-tier2-manifest.ts

import {
  buildManifest,
  canonicalizeUrl,
  isContentUrl,
  isMandatoryPath,
  renderManifest,
  opportunityTokens,
  GROUP_THRESHOLD,
  type DiscoveredUrl,
} from "../lib/tier2/manifest";

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

// ---------------------------------------------------------------------------
section("Canonicalization: one page cannot occupy two slots");
// ---------------------------------------------------------------------------

check("www and protocol are normalized", canonicalizeUrl("http://www.Maclellan.net/Fund/"), "https://maclellan.net/Fund");
check("a fragment is dropped", canonicalizeUrl("https://maclellan.net/fund#apply"), "https://maclellan.net/fund");
check("tracking params are dropped", canonicalizeUrl("https://maclellan.net/fund?utm_source=x&gclid=y"), "https://maclellan.net/fund");
check("a real query param survives", canonicalizeUrl("https://x.org/grants?year=2026"), "https://x.org/grants?year=2026");
check("index files collapse to the directory", canonicalizeUrl("https://x.org/grants/index.html"), "https://x.org/grants");
check("a trailing slash on the root is kept", canonicalizeUrl("https://x.org/"), "https://x.org/");
check("mailto is not a page", canonicalizeUrl("mailto:grants@x.org"), null);
check("javascript: is not a page", canonicalizeUrl("javascript:void(0)"), null);

// ---------------------------------------------------------------------------
section("Cleaning: what is never a funder describing itself");
// ---------------------------------------------------------------------------

check("an image is not content", isContentUrl("https://x.org/logo.png"), false);
check("a stylesheet is not content", isContentUrl("https://x.org/theme.css"), false);
check("a tag listing is not content", isContentUrl("https://x.org/tag/missions"), false);
check("an author page is not content", isContentUrl("https://x.org/author/jane"), false);
check("pagination is not content", isContentUrl("https://x.org/news/page/4"), false);
check("a dated archive is not content", isContentUrl("https://x.org/2019/07/12/annual-dinner"), false);
check("a grants page is content", isContentUrl("https://x.org/grants"), true);
check("a plain about page is content", isContentUrl("https://x.org/about"), true);

// A dated path that also looks like guidance must survive -- funders really do
// publish "2026-grant-guidelines".
check("a dated GUIDELINES page survives the archive filter", isContentUrl("https://x.org/2026/grant-guidelines"), true);

// ---------------------------------------------------------------------------
section("Mandatory paths bypass everything");
// ---------------------------------------------------------------------------

check("grants", isMandatoryPath("https://x.org/grants"), true);
check("eligibility", isMandatoryPath("https://x.org/who-we-fund/eligibility"), true);
check("fiscal sponsorship", isMandatoryPath("https://maclellan.net/fiscal-sponsorship"), true);
check("grantees, for revealed priorities", isMandatoryPath("https://maclellan.net/grantees"), true);
check("a title can make a page mandatory", isMandatoryPath("https://x.org/s/123", "Grant Guidelines"), true);
check("a staff page is not mandatory", isMandatoryPath("https://x.org/team"), false);

// -- Position, not presence ------------------------------------------------
//
// These are the real EAA URLs that made 60 of 60 manifest entries "mandatory".
// Each contains a keyword inside a slug, and each bypassed grouping on that
// basis -- 679 newsletter articles crowding out whatever the funder actually
// publishes about its grants.
check(
  "a keyword inside a dated slug is not mandatory",
  isMandatoryPath("https://eaa.org/eaa/eaa-chapters/chaptergram-articles/2018-03-13-faq-balancing-the-needs"),
  false
);
check(
  "...nor mid-segment",
  isMandatoryPath("https://eaa.org/airventure/become-a-sponsor/why-exhibit-video"),
  false
);
check(
  "...nor buried five segments deep",
  isMandatoryPath("https://eaa.org/eaa/news-and-publications/eaa-news/bits-and-pieces/2017-chapter-fundraising"),
  false
);
// And the pages that must still qualify.
check("a segment that IS the keyword qualifies", isMandatoryPath("https://x.org/grants"), true);
check("a segment that BEGINS with it qualifies", isMandatoryPath("https://x.org/2026/grant-guidelines"), true);
check("nested but shallow still qualifies", isMandatoryPath("https://x.org/foundation/programs/education/apply"), true);
check("a title rescues an opaque URL", isMandatoryPath("https://x.org/p/9f3a", "How to apply for a grant"), true);

// ---------------------------------------------------------------------------
section("Grouping: a listing is one shape of page, not many kinds");
// ---------------------------------------------------------------------------

// The EAA shape in miniature: a handful of real pages drowning in a news feed.
const newsHeavy: DiscoveredUrl[] = [
  u("https://x.org/grants", "Grants"),
  u("https://x.org/about"),
  ...Array.from({ length: 400 }, (_, i) => u(`https://x.org/news/story-${i}`, `Story ${i}`)),
];
const m1 = buildManifest(newsHeavy);
check("400 news posts collapse", m1.entries.filter((e) => e.groupPattern === "/news/*").length <= 2, true);
check("the grants page survives", m1.entries.some((e) => e.url.endsWith("/grants")), true);
check("the collapse is reported, not silent", m1.collapsed[0], { pattern: "/news/*", count: 398 });
check("a representative says what it stands for", m1.entries.find((e) => e.groupPattern)?.groupSize, 400);
check("the manifest is small enough to hand over", m1.entries.length <= 10, true);

// A mandatory page inside a big listing must never be represented by a sibling.
const grantsInsideNews: DiscoveredUrl[] = [
  ...Array.from({ length: 50 }, (_, i) => u(`https://x.org/resources/post-${i}`)),
  u("https://x.org/resources/grant-guidelines", "Grant Guidelines"),
];
const m2 = buildManifest(grantsInsideNews);
check(
  "a guidelines page buried in a listing survives on its own",
  m2.entries.some((e) => e.url.endsWith("/grant-guidelines") && e.groupSize === 1),
  true
);

// Below the threshold, nothing is collapsed -- a small site must not be
// reduced to representatives.
const small = buildManifest([u("https://x.org/a"), u("https://x.org/b"), u("https://x.org/c")]);
check(`${GROUP_THRESHOLD} or fewer siblings are left alone`, small.collapsed, []);
check("...and all of them are present", small.entries.length, 3);

// The root is navigation, not a listing. Maclellan's real sitemap: collapsing
// its 14 top-level pages kept /cookies as a "representative" and discarded
// /our-foundations and /multi-year -- the latter being exactly
// application.multiyear_grant_rules.
const MACLELLAN = [
  "/fund", "/grantees", "/resources", "/our-foundations", "/cookies", "/terms", "/privacy",
  "/multi-year", "/faq", "/fiscal-sponsorship", "/maclellan-prayer", "/history", "/covenant", "/",
].map((p) => u(`https://maclellan.net${p}`));
const mac = buildManifest(MACLELLAN);
check("root-level pages are never collapsed", mac.collapsed, []);
check("...so every top-level page survives", mac.entries.length, 14);
check("...including the ones a listing-collapse would have dropped", [
  mac.entries.some((e) => e.url.endsWith("/our-foundations")),
  mac.entries.some((e) => e.url.endsWith("/multi-year")),
], [true, true]);
check(
  "...and the four that carry eligibility rules are mandatory",
  mac.entries.filter((e) => e.mandatory).map((e) => e.url.replace("https://maclellan.net", "")).sort(),
  ["/faq", "/fiscal-sponsorship", "/fund", "/grantees"]
);

// ---------------------------------------------------------------------------
section("Capping is reported, never implied");
// ---------------------------------------------------------------------------

// Deliberately unclusterable: every page has a distinct parent, so grouping
// cannot help and the cap is the only thing left.
const wide = buildManifest(
  Array.from({ length: 200 }, (_, i) => u(`https://x.org/dir-${i}/page`)),
  { maxEntries: 20 }
);
check("the cap is applied", wide.entries.length, 20);
check("...and declared", wide.capped, true);
check("...and says how many it did not show", wide.droppedByCap, 180);

// Mandatory pages outrank the cap.
const cappedWithGrants = buildManifest(
  [...Array.from({ length: 200 }, (_, i) => u(`https://x.org/dir-${i}/page`)), u("https://x.org/deep/nested/path/grants")],
  { maxEntries: 5 }
);
check("a grants page survives a tight cap", cappedWithGrants.entries[0].url.endsWith("/grants"), true);

// ---------------------------------------------------------------------------
section("Determinism and counts");
// ---------------------------------------------------------------------------

const shuffled = [...newsHeavy].reverse();
check("input order does not change the manifest", JSON.stringify(buildManifest(shuffled).entries), JSON.stringify(m1.entries));
check("duplicates are counted once", buildManifest([u("https://x.org/a"), u("https://www.x.org/a/"), u("http://x.org/a#top")]).entries.length, 1);
check("a title survives the merge", buildManifest([u("https://x.org/a"), u("https://x.org/a", "Grants")]).entries[0].title, "Grants");
check("raw discovered count is preserved for the record", m1.discovered, 402);

// ---------------------------------------------------------------------------
section("What the model is shown");
// ---------------------------------------------------------------------------

const rendered = renderManifest(m1);
check("entries are numbered for selection by index", rendered.startsWith("[0] "), true);
check("a grouped entry declares its group", rendered.includes("[1 of ~400 under /news/*]"), true);
check("titles are shown when known", rendered.includes('— "Grants"'), true);

// ---------------------------------------------------------------------------
section("Depth ranks, it does not exclude");
// ---------------------------------------------------------------------------

// Measured against human ground truth: every page we found sat at depth 1-2,
// every page we missed sat at 3-5. A depth limit was right for the sites it was
// tested against and wrong for every funder nesting a programme under a section.
check(
  "a deep guidance page is mandatory",
  isMandatoryPath("https://eaa.org/eaa/learn-to-fly/scholarships/eaa-flight-training-scholarships"),
  true
);
check(
  "...and so is one five deep",
  isMandatoryPath("https://cmalliance.org/our-work/church-ministries/pastoral-financial-health-initiative/apply"),
  true
);
// The position rule alone still rejects everything the depth limit was catching.
check(
  "a keyword inside a deep slug is still not mandatory",
  isMandatoryPath("https://eaa.org/eaa/news-and-publications/eaa-news/bits-and-pieces/2017-chapter-fundraising"),
  false
);

// ---------------------------------------------------------------------------
section("Path diversity: one section cannot consume the cap");
// ---------------------------------------------------------------------------

// A funder with a large shallow section would otherwise fill every slot before
// a grants page three levels down was considered.
const lopsided = buildManifest(
  [
    ...Array.from({ length: 100 }, (_, i) => u(`https://x.org/news/item-${i}`)),
    ...Array.from({ length: 100 }, (_, i) => u(`https://x.org/events/e-${i}`)),
    u("https://x.org/about/our-work/how-we-decide"),
    u("https://x.org/about/our-work/history"),
  ],
  { maxEntries: 12 }
);
const sectionsPresent = new Set(lopsided.entries.map((e) => new URL(e.url).pathname.split("/")[1]));
check("every section is represented", [...sectionsPresent].sort(), ["about", "events", "news"]);
check(
  "a deep page in a small section survives a busy site",
  lopsided.entries.some((e) => e.url.endsWith("/how-we-decide")),
  true
);


// ---------------------------------------------------------------------------
section("The catalogue: discovered is not the same as shown");
// ---------------------------------------------------------------------------

// A page dropped by the cap was DISCOVERED BUT NOT EVALUATED. Reporting it as
// absent is how a user is told a funder publishes nothing when we simply never
// looked.
const big = buildManifest(
  [
    ...Array.from({ length: 100 }, (_, i) => u(`https://x.org/news/n-${i}`)),
    u("https://x.org/logo.png"),
    u("https://x.org/tag/missions"),
  ],
  { maxEntries: 5 }
);
check("the catalogue keeps everything retrieved", big.catalog.length >= 100, true);
check("rule-excluded URLs are recorded, not erased", big.excludedByRule, 2);
check(
  "pages beaten by the cap say so",
  big.catalog.some((c) => c.state === "not_shortlisted_cap"),
  true
);
check("...and none of them is reported as absent", big.catalog.every((c) => c.state !== "discovered" || big.entries.some((e) => e.url === c.url)), true);
check("the cap count comes from the catalogue", big.droppedByCap, big.catalog.filter((c) => c.state === "not_shortlisted_cap").length);

// ---------------------------------------------------------------------------
section("The opportunity we were actually sent to qualify");
// ---------------------------------------------------------------------------

// Qualification evaluates a KNOWN opportunity. No keyword vocabulary could have
// guessed "Innovation Fund" -- but Discovery already knew its name, and the
// name finds the page.
check("distinctive tokens survive, generic ones do not", opportunityTokens("Ministry Innovation Fund"), ["innovation"]);
check("a two-word programme keeps both", opportunityTokens("Racial Ethnic Local Church Grants"), ["racial", "ethnic", "local", "church"]);
check("a name of nothing but generics yields nothing", opportunityTokens("General Fund"), []);

const withOpportunity = buildManifest(
  [
    ...Array.from({ length: 200 }, (_, i) => u(`https://x.org/news/n-${i}`)),
    u("https://x.org/innovation"),
    u("https://x.org/innovation/2023-innovation-fund"),
  ],
  { maxEntries: 5, opportunityName: "Ministry Innovation Fund" }
);
check("the opportunity pages are found in the full catalogue", withOpportunity.opportunityMatches.length, 2);
check(
  "...and both survive a cap of five against 200 news posts",
  ["https://x.org/innovation", "https://x.org/innovation/2023-innovation-fund"].every((url) =>
    withOpportunity.entries.some((e) => e.url === url)
  ),
  true
);

// Donor Finder already saw a page describing this opportunity. It always
// belongs in the shortlist.
const withSource = buildManifest(
  Array.from({ length: 100 }, (_, i) => u(`https://x.org/news/n-${i}`)),
  { maxEntries: 3, sourceUrl: "https://x.org/programs/the-fund" }
);
check("the Donor Finder source URL is always shortlisted", withSource.entries.some((e) => e.url === "https://x.org/programs/the-fund"), true);

// No opportunity name is an UPSTREAM deficiency, not a retrieval one -- and it
// must not change general behaviour.
check("no opportunity name promotes nothing", buildManifest([u("https://x.org/a")], {}).opportunityMatches, []);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
