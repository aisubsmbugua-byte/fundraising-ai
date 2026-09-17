import { classifyProspectKind, handoffDefects, readHandoff, HANDOFF_VERSION } from "../lib/discovery-handoff";
import { classifyDomain, registrableDomain, isSharedPlatform, isRelatedHost, admitRelatedHosts, EXPANSION_AUTHORIZED } from "../lib/tier2/domain";

let passed = 0, failed = 0;
function check(label: string, actual: unknown, expected: unknown) {
  const ok = JSON.stringify(actual) === JSON.stringify(expected);
  ok ? passed++ : failed++;
  console.log(`${ok ? "  ok  " : "FAIL  "}${label}${ok ? "" : `\n        expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`}`);
}
function section(t: string) { console.log(`\n${t}`); }

section("Prospect kind: a missing opportunity name is not automatically a defect");
check("a named opportunity", classifyProspectKind({ opportunityName: "Ministry Innovation Fund" }), "named_opportunity");
check("a general foundation with a type is a general funder", classifyProspectKind({ funderType: "private foundation" }), "general_funder");
check("a DAF sponsor is an intermediary", classifyProspectKind({ funderType: "donor-advised fund sponsor" }), "intermediary");
check("a wealth manager is an intermediary", classifyProspectKind({ funderType: "wealth advisory" }), "intermediary");
// The one that must NOT be general_funder: the display name still carries a
// programme, so claiming the funder has none would be false.
check(
  "a display name carrying a programme with no captured name is unknown",
  classifyProspectKind({ displayName: "Hilton Foundation — Aviation Fund", funderType: "private foundation" }),
  "unknown"
);
check("nothing known at all is unknown", classifyProspectKind({}), "unknown");

section("Defects are Discovery losing what it had");
const base = { handoffVersion: HANDOFF_VERSION, funderName: "X Foundation", opportunityName: null, sourceUrl: "https://x.org/grants", sourceTitle: null, sourceResultIndex: 0, sourceClassification: "official", location: null, parentOrganization: null, kind: "general_funder" as const };
check("a complete handoff has no defects", handoffDefects(base), []);
check("a missing source URL is a defect", handoffDefects({ ...base, sourceUrl: null }), ["missing_source_url"]);
check(
  "a programme in the display name with no captured name is a defect",
  handoffDefects({ ...base, funderName: "Hilton Foundation — Aviation Fund" }),
  ["unnamed_opportunity"]
);
check(
  "...and so is one only the source title reveals",
  handoffDefects({ ...base, sourceTitle: "Apply to the Ministry Innovation Fund" }),
  ["unnamed_opportunity"]
);
// A general foundation with no programme is CORRECT, not defective.
check("a plain foundation with no programme is not defective", handoffDefects(base), []);

section("Legacy rows are reported, not repaired");
check("a row predating the contract is legacy", readHandoff({ name: "X" }).legacy, true);
check("a row at the current version is not", readHandoff({ name: "X", handoff_version: HANDOFF_VERSION }).legacy, false);
check("website_status stands in for classification on legacy rows", readHandoff({ website_status: "official" }).sourceClassification, "official");

section("Domain verification precedes expansion");
check("registrable domain of a subdomain", registrableDomain("centernet.pcusa.org"), "pcusa.org");
check("a two-part public suffix", registrableDomain("grants.example.co.uk"), "example.co.uk");
check("a hosting domain is recognised", isSharedPlatform("mychurch.squarespace.com"), true);
check("...and its siblings are never related", isRelatedHost("other.squarespace.com", "mychurch.squarespace.com"), false);
check("a real subdomain is related", isRelatedHost("centernet.pcusa.org", "pcusa.org"), true);
check("a different organisation is not", isRelatedHost("pcusa.org", "umc.org"), false);

const named = classifyDomain({ requestedHost: "maclellan.net", finalHost: "maclellan.net", pageTitle: "Maclellan Foundation", pageText: "The Maclellan Foundation funds...", prospectNames: ["Maclellan Foundation"] });
check("a site naming the prospect is confirmed official", named.state, "confirmed_official");
check("...and authorizes expansion", EXPANSION_AUTHORIZED.has(named.state), true);

const quiet = classifyDomain({ requestedHost: "x.org", finalHost: "x.org", pageTitle: "Welcome", pageText: "Hello", prospectNames: ["Maclellan Foundation"] });
check("a site that does not name them is unverified, NOT rejected", quiet.state, "unverified");
check("...and does not authorize expansion", EXPANSION_AUTHORIZED.has(quiet.state), false);

// Only affirmative evidence of somebody else rejects.
check(
  "a site identifying a different organisation is rejected",
  classifyDomain({ requestedHost: "x.org", finalHost: "x.org", pageTitle: "Acme Widgets Foundation", pageText: "", prospectNames: ["Maclellan Foundation"] }).state,
  "rejected"
);
check(
  "a redirect is reported so the stored row can be corrected",
  classifyDomain({ requestedHost: "theantiochfoundation.org", finalHost: "antiochfoundation.org", pageTitle: "The Antioch Foundation", pageText: "", prospectNames: ["The Antioch Foundation"] }).state,
  "redirected_to_current"
);
check(
  "a hosting domain never authorizes sibling crawling",
  EXPANSION_AUTHORIZED.has(classifyDomain({ requestedHost: "x.squarespace.com", finalHost: "x.squarespace.com", pageTitle: "X Foundation", pageText: "", prospectNames: ["X Foundation"] }).state),
  false
);

section("Related hosts are admitted on evidence, and say how");
check(
  "an unverified domain admits nothing beyond itself",
  admitRelatedHosts({ officialHost: "pcusa.org", domainState: "unverified", sitemapHosts: ["centernet.pcusa.org"] }).length,
  1
);
const admitted = admitRelatedHosts({ officialHost: "pcusa.org", domainState: "confirmed_official", sitemapHosts: ["centernet.pcusa.org"], linkedHosts: ["give.pcusa.org", "unrelated.org"] });
check("evidenced subdomains are admitted", admitted.map((a) => a.host), ["pcusa.org", "centernet.pcusa.org", "give.pcusa.org"]);
check("...each recording how it got in", admitted.map((a) => a.reason), ["official", "sitemap_reference", "linked_from_official"]);
check("an unrelated host is never admitted", admitted.some((a) => a.host === "unrelated.org"), false);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed > 0 ? 1 : 0);
