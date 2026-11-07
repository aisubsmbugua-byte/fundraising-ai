// Mutation check for STATE item 112 (researching a confirmed person, ruling 0044
// clauses 3, 4, 5, 9 and 10 and clause 2's gate): break each guard in turn and
// confirm a NAMED assertion fails. A guard whose removal changes no test result is a
// guard nobody is checking.
//
// How it works. For every mutation below this script: (1) confirms the text to change
// appears in the source file exactly once; (2) writes the mutated source; (3) runs the
// test file (a child process: `npx tsx scripts/<test>.ts`); (4) reads the FAIL lines;
// (5) restores the original source byte for byte -- in a `finally`, and again on exit
// or interrupt -- and checks the restore. A mutation is CAUGHT when the run reports at
// least one FAIL whose label contains the expected text. A mutation that is not caught
// makes this script exit non-zero.
//
// It first runs each test file unmutated and refuses to continue unless it passes.
//
// Mutations R* break application code and are run against scripts/test-network-
// research.ts; mutations D* break the migration (supabase/migrations/0085_...) and are
// run against scripts/test-network-research-migration.ts on a real Postgres.
//
// Usage: npx tsx scripts/mutation-check-network-research.ts            (all)
//        npx tsx scripts/mutation-check-network-research.ts R1 D5 (some)

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = join(__dirname, "..");

type Mutation = {
  id: string;
  guard: string;
  file: string;
  find: string;
  replace: string;
  test: string;
  // Each of these must appear inside a FAIL label for the mutation to count as caught.
  expectFail: string[];
};

const APP = "app/(dashboard)/network";
const RES = "lib/network-research.ts";
const ACT = `${APP}/research-actions.ts`;
const SQL = "supabase/migrations/0085_network_person_findings.sql";
const T = "scripts/test-network-research.ts";
const TM = "scripts/test-network-research-migration.ts";

const MUTATIONS: Mutation[] = [
  // ---- the gate: nothing is researched about someone who is not confirmed ----
  {
    id: "R1",
    guard: "an unconfirmed person may be researched (the refusal rule forgets the confirmation)",
    file: RES,
    find: '  if (person.identity_status !== "confirmed") {',
    replace: "  if (false as boolean) {",
    test: T,
    expectFail: ["NO RESEARCH WITHOUT A CONFIRMATION (unconfirmed)", "NO RESEARCH WITHOUT A CONFIRMATION: an unconfirmed person is refused"],
  },
  {
    id: "R1b",
    guard: "the server action stops asking the rule (no refusal in code before a run is born)",
    file: ACT,
    find: "    const refusal = refusalForResearch(person, { anchorFound: anchor !== null, researchedAt }, again === true, new Date());",
    replace: "    const refusal = null as ReturnType<typeof refusalForResearch>;",
    test: T,
    expectFail: ["NO RESEARCH WITHOUT A CONFIRMATION: an unconfirmed person is refused", "ZERO ledger runs, ZERO model calls"],
  },
  {
    id: "R2",
    guard: "a do-not-research person may be researched (the rule forgets the flag)",
    file: RES,
    find: "  if (person.do_not_research === true) {\n    return { code: \"do_not_research\", message: \"This person is marked do not research, so nothing is researched about them.\" };",
    replace: "  if (false as boolean) {\n    return { code: \"do_not_research\", message: \"This person is marked do not research, so nothing is researched about them.\" };",
    test: T,
    expectFail: ["DO NOT RESEARCH outranks everything"],
  },
  {
    id: "R3",
    guard: "a person already researched is researched again by a plain call (the rule forgets the ledger)",
    file: RES,
    find: "  if (!again && ctx.researchedAt) {",
    replace: "  if (false as boolean) {",
    test: T,
    expectFail: ["ALREADY RESEARCHED"],
  },
  {
    id: "R3b",
    guard: "a missing 'again' is read as an explicit again (a plain call re-researches)",
    file: ACT,
    find: "again === true, new Date()",
    replace: "again !== false, new Date()",
    test: T,
    expectFail: ["ALREADY RESEARCHED (end to end)"],
  },
  {
    id: "R3c",
    guard: "a research run from before the current confirmation counts as 'researched'",
    file: RES,
    find: "    if (since !== null && Number.isFinite(since) && t < since) continue;",
    replace: "",
    test: T,
    expectFail: ["a run from BEFORE the current confirmation does not count"],
  },
  {
    id: "R4",
    guard: "the ledger run is not born (no beginRun) before the model is called",
    file: ACT,
    find: '    aiRunId = await beginRun(supabase, { operation: "network_research", sourceTable: "network_connections", sourceId: person.id });',
    replace: '    aiRunId = "no-run";',
    test: T,
    expectFail: ["ONE ledger run is born for the whole research", "THE RUN IS BORN BEFORE THE MODEL"],
  },
  {
    id: "R5",
    guard: "the model can type the URL (a typed source_url is used instead of the captured one)",
    file: RES,
    find: "      source_url: source.url,\n      source_title: source.title,\n      source_passage: source.passage || null,",
    replace: '      source_url: typeof item.source_url === "string" ? item.source_url : source.url,\n      source_title: source.title,\n      source_passage: source.passage || null,',
    test: T,
    expectFail: ["THE MODEL CANNOT TYPE A URL, TITLE OR PASSAGE (in code)"],
  },
  {
    id: "R5b",
    guard: "the model can type the passage (a typed passage is stored instead of the captured one)",
    file: RES,
    find: "      source_passage: source.passage || null,\n      supported: attest.supported,",
    replace: '      source_passage: typeof item.source_passage === "string" ? item.source_passage : source.passage || null,\n      supported: attest.supported,',
    test: T,
    expectFail: ["THE MODEL CANNOT TYPE A URL, TITLE OR PASSAGE (in code)"],
  },
  {
    id: "R5c",
    guard: "the model's answer schema gains a free url field",
    file: RES,
    find: '            role_text: { type: "string", description: "The title, seat, degree or role exactly as the source words it. Empty if it gives none." },',
    replace: '            role_text: { type: "string", description: "The title, seat, degree or role exactly as the source words it. Empty if it gives none." },\n            source_url: { type: "string", description: "The address." },',
    test: T,
    expectFail: ["THE MODEL CANNOT TYPE A URL, TITLE OR PASSAGE: the answer's schema has exactly four fields"],
  },
  {
    id: "R6",
    guard: "a kind outside the closed list is stored (the code-level kind check is gone)",
    file: RES,
    find: "    if (!isFindingKind(kind)) {",
    replace: "    if (false as boolean) {",
    test: T,
    expectFail: ["CLOSED KINDS IN CODE"],
  },
  {
    id: "R6b",
    guard: "isFindingKind accepts any text",
    file: RES,
    find: '  return typeof v === "string" && (FINDING_KINDS as readonly string[]).includes(v);',
    replace: '  return typeof v === "string";',
    test: T,
    expectFail: ["isFindingKind accepts the six and nothing else"],
  },
  {
    id: "R7",
    guard: "the wrong-person guard is removed (a page that never names the person yields findings)",
    file: RES,
    find: "    if (!capturedTextNamesPerson(facts.person_name, { url: source.url, title: source.title, passage: source.passage })) {",
    replace: "    if (false as boolean) {",
    test: T,
    expectFail: ["WRONG-PERSON GUARD"],
  },
  {
    id: "R7b",
    guard: "the wrong-person guard needs only SOME name token, not every one",
    file: RES,
    find: "  return required.every((t) => have.has(t));\n}\n\n// Attestation",
    replace: "  return required.some((t) => have.has(t));\n}\n\n// Attestation",
    test: T,
    expectFail: ["capturedTextNamesPerson needs EVERY distinctive token"],
  },
  {
    id: "R8",
    guard: "a finding the captured text does not support is DELETED instead of stored with supported = false",
    file: RES,
    find: "    const attest = attestFinding(organization, role, { url: source.url, title: source.title, passage: source.passage });",
    replace: '    const attest = attestFinding(organization, role, { url: source.url, title: source.title, passage: source.passage });\n    if (!attest.supported) {\n      discarded.push({ reason: "dropped", raw: item });\n      continue;\n    }',
    test: T,
    expectFail: ["UNSUPPORTED IS STORED, NOT DELETED"],
  },
  {
    id: "R8b",
    guard: "every finding is called supported (the attestation is not computed)",
    file: RES,
    find: "    supported: testable && organization_missing.length === 0 && role_missing.length === 0,",
    replace: "    supported: true,",
    test: T,
    expectFail: ["UNSUPPORTED IS STORED, NOT DELETED"],
  },
  {
    id: "R8c",
    guard: "an unsupported finding counts as usable (nothing excludes it from use)",
    file: RES,
    find: '  return f.supported === true && f.status === "included";',
    replace: '  return f.status === "included";',
    test: T,
    expectFail: ["unsupported findings are not USABLE"],
  },
  {
    id: "R9",
    guard: "a source on a social network or broker is accepted at validation (defence in depth removed)",
    file: RES,
    find: "    const refusedKind = refusedSourceKind(source.url);",
    replace: "    const refusedKind = null as ReturnType<typeof refusedSourceKind>;",
    test: T,
    expectFail: ["NO SOCIAL OR BROKER SOURCE (defence in depth)"],
  },
  {
    id: "R9b",
    guard: "social and broker pages are offered to the model (the captured list is no longer filtered)",
    file: "lib/network-identity.ts",
    find: "    const kind = refusedSourceKind(url);\n    if (kind !== null) {",
    replace: "    const kind = null as ReturnType<typeof refusedSourceKind>;\n    if (kind !== null) {",
    test: T,
    expectFail: ["NO SOCIAL OR BROKER SOURCE (building the list)"],
  },
  {
    id: "R10",
    guard: "contact details are no longer scrubbed from the captured passage before it is stored",
    file: "lib/network-identity.ts",
    find: "    passage: capText(collapse(scrubContactDetails(e.passages.join(\" … \"))), PERSON_PASSAGE_MAX),",
    replace: "    passage: capText(collapse(e.passages.join(\" … \")), PERSON_PASSAGE_MAX),",
    test: T,
    expectFail: ["SCRUBBED: emails, phones, links, handles and street addresses"],
  },
  {
    id: "R10b",
    guard: "a finding whose organization or role carries a contact detail is kept",
    file: RES,
    find: "    if ((organization && containsContactDetail(organization)) || (role && containsContactDetail(role))) {",
    replace: "    if (false as boolean) {",
    test: T,
    expectFail: ["a finding whose organization or role carries an email"],
  },
  {
    id: "R11",
    guard: "the cap of 12 findings per run is gone",
    file: RES,
    find: "  const within = ordered.slice(0, MAX_FINDINGS_PER_RUN);",
    replace: "  const within = ordered;",
    test: T,
    expectFail: ["THE CAP: at most 12 findings per person per run"],
  },
  {
    id: "R11b",
    guard: "the cap no longer prefers supported findings",
    file: RES,
    find: "  const ordered = [...kept].sort((a, b) => Number(b.supported) - Number(a.supported));",
    replace: "  const ordered = [...kept];",
    test: T,
    expectFail: ["THE CAP: at most 12 findings per person per run"],
  },
  {
    id: "R12",
    guard: "the person's notes reach the search (the facts handed to the model include a field they must not)",
    file: ACT,
    find: "  person_name: p.person_name,\n  affiliation: p.affiliation,",
    replace: "  person_name: `${p.person_name} ${(p as unknown as { notes?: string }).notes ?? \"\"}`,\n  affiliation: p.affiliation,",
    test: T,
    expectFail: ["and NOT their notes or how the recorder knows them"],
  },
  {
    id: "R13",
    guard: "findings are written for a person who was reset or marked off limits while the model worked",
    file: ACT,
    find: '    if (fresh.person.do_not_research || fresh.person.identity_status !== "confirmed" || fresh.person.identity_candidate_id !== person.identity_candidate_id) {',
    replace: "    if (false as boolean) {",
    test: T,
    expectFail: ["a person who is reset, confirmed as someone else, or marked off limits WHILE the model works"],
  },
  {
    id: "R14",
    guard: "a strike is not recorded as the signed-in human",
    file: ACT,
    find: 'status: "struck", struck_by: user.id, struck_at',
    replace: 'status: "struck", struck_by: "system", struck_at',
    test: T,
    expectFail: ["A STRIKE IS HUMAN-ONLY AND RECORDED"],
  },
  {
    id: "R14b",
    guard: "a restore is not recorded as the signed-in human",
    file: ACT,
    find: "restored_by: user.id, restored_at: new Date().toISOString() })",
    replace: "restored_by: null, restored_at: new Date().toISOString() })",
    test: T,
    expectFail: ["restoring records who and when"],
  },
  {
    id: "R15",
    guard: "THE BATCH CONFIRM STARTS RESEARCH (the 'Confirm your network (N)' handler researches the people it confirms)",
    file: `${APP}/identity/identity-workspace.tsx`,
    find: "      const result = await confirmPreselectedIdentities(pairs);\n      if (\"error\" in result) setBatchError(result.error);",
    replace: "      const result = await confirmPreselectedIdentities(pairs);\n      for (const pair of pairs) void researchPerson(pair.personId);\n      if (\"error\" in result) setBatchError(result.error);",
    test: T,
    expectFail: ["THE BATCH CONFIRM NEVER TRIGGERS RESEARCH"],
  },
  {
    id: "R15b",
    guard: "the person card researches after ANY confirmation, not only in the single-person panel",
    file: `${APP}/identity/person-card.tsx`,
    find: "      if (single) {\n        setDone(`Confirmed:",
    replace: "      {\n        setDone(`Confirmed:",
    test: T,
    expectFail: ["CONFIRM NEVER TRIGGERS RESEARCH EXCEPT THE SINGLE CARD"],
  },
  {
    id: "R15c",
    guard: "the person card researches even when the confirmation FAILED",
    file: `${APP}/identity/person-card.tsx`,
    find: "        setError(result.error);\n        return;\n      }\n      if (single) {",
    replace: "        setError(result.error);\n      }\n      if (single) {",
    test: T,
    expectFail: ["CONFIRM NEVER TRIGGERS RESEARCH EXCEPT THE SINGLE CARD"],
  },
  {
    id: "R15d",
    guard: "the person card researches by itself on load (an effect, no click)",
    file: `${APP}/identity/person-card.tsx`,
    find: "  const research = usePersonResearch(p.id);",
    replace: "  const research = usePersonResearch(p.id);\n  useEffect(() => {\n    void research.run(false);\n  }, []);",
    test: T,
    expectFail: ["NOTHING STARTS A RESEARCH ON LOAD"],
  },
  {
    id: "R15e",
    guard: "the import page can start a research",
    file: `${APP}/import/import-workspace.tsx`,
    find: 'import { loadLookupQueue } from "../identity-actions";',
    replace: 'import { loadLookupQueue } from "../identity-actions";\nimport { researchPerson } from "../research-actions";',
    test: T,
    expectFail: ["AN IMPORT NEVER TRIGGERS RESEARCH"],
  },
  {
    id: "R15f",
    guard: "the Network page researches while loading",
    file: `${APP}/page.tsx`,
    find: "    const overview = await loadResearchOverview(supabase);",
    replace: "    const overview = await loadResearchOverview(supabase);\n    void researchPerson;",
    test: T,
    expectFail: ["the pages that load data (network/page.tsx, identity/page.tsx) call no research or confirm ACTION"],
  },
  {
    id: "R16",
    guard: "path-finding reads the findings table",
    file: "lib/network-shortlist.ts",
    find: "export const NETWORK_PATHS_MAX_CONSIDERED = 150;",
    replace: 'export const NETWORK_PATHS_MAX_CONSIDERED = 150;\nexport const FINDINGS_TABLE = "network_person_findings";',
    test: T,
    expectFail: ["FINDINGS ENTER NOTHING", "PATH-FINDING IS UNTOUCHED"],
  },
  {
    id: "R16b",
    guard: "a draft or strategy file reads a person's findings",
    file: "app/(dashboard)/prospects/[id]/strategy-actions.ts",
    find: '"use server";',
    replace: '"use server";\nimport { loadFindingsFor } from "@/lib/network-research-store";',
    test: T,
    expectFail: ["FINDINGS ENTER NOTHING", "the strategy and draft code never touch"],
  },
  {
    id: "R17",
    guard: "the external agent's tool registry reaches the research actions",
    file: "lib/agent/tools.ts",
    find: "// The connector's closed tool registry (STATE item 98, ruling 0039 clause 3).\n",
    replace: "// The connector's closed tool registry (STATE item 98, ruling 0039 clause 3).\nimport \"@/app/(dashboard)/network/research-actions\";\n",
    test: T,
    expectFail: ["THE ASSISTANT AND THE AGENT CANNOT RESEARCH OR STRIKE"],
  },
  {
    id: "R17b",
    guard: "the MCP route reaches the research actions",
    file: "app/api/mcp/route.ts",
    find: "// POST /api/mcp -- the MCP server the owner's desktop agent (Meta's Muse)\n",
    replace: "// POST /api/mcp -- the MCP server the owner's desktop agent (Meta's Muse)\nimport \"@/app/(dashboard)/network/research-actions\";\n",
    test: T,
    expectFail: ["THE ASSISTANT AND THE AGENT CANNOT RESEARCH OR STRIKE"],
  },
  {
    id: "R18",
    guard: "a page-fetch tool is offered to the model",
    file: "lib/ai/person-research.ts",
    find: "      tools: [searchTool],",
    replace: '      tools: [searchTool, { type: "web_fetch_20250910", name: "web_fetch" }],',
    test: T,
    expectFail: ["and offers NO fetch tool", "NO PAGE-FETCH TOOL, NO FETCH"],
  },
  {
    id: "R19",
    guard: "the search is no longer asked to leave social and people-data sites out",
    file: "lib/ai/person-research.ts",
    find: "    blocked_domains: [...PERSON_SEARCH_BLOCKED_DOMAINS],\n",
    replace: "",
    test: T,
    expectFail: ["asks the provider to leave social networks and people-data sites out"],
  },
  {
    id: "R20",
    guard: "a person with only unsupported findings counts as 'with findings' in the batch loop",
    file: RES,
    find: "  return \"error\" in r ? r : { success: true, stored: r.usable };",
    replace: "  return \"error\" in r ? r : { success: true, stored: r.stored };",
    test: T,
    expectFail: ["toLoopResult counts a person as 'with findings' only when something USABLE was found"],
  },
  {
    id: "R21",
    guard: "the per-click cap of 50 is raised",
    file: RES,
    find: "export const RESEARCH_CLICK_CAP = IDENTITY_CLICK_CAP;",
    replace: "export const RESEARCH_CLICK_CAP = 500;",
    test: T,
    expectFail: ["THE CAP OF 50 PER CLICK"],
  },
  {
    id: "R22",
    guard: "the batch loop passes 'again' (it could research the same people twice)",
    file: `${APP}/research/research-runner.tsx`,
    find: "toLoopResult(await researchPerson(personId))",
    replace: "toLoopResult(await researchPerson(personId, true))",
    test: T,
    expectFail: ["it calls the SINGLE-person action in the loop, passing the id alone"],
  },
  {
    id: "R23",
    guard: "the batch button starts by itself when the page loads (an effect calls start)",
    file: `${APP}/research/research-runner.tsx`,
    find: "  const doneRef = useRef<Set<string>>(new Set());",
    replace: "  const doneRef = useRef<Set<string>>(new Set());\n  useEffect(() => {\n    void start();\n  }, []);",
    test: T,
    expectFail: ["the batch button's one effect only STOPS the loop", "the batch button starts the loop only from its click"],
  },
  {
    id: "R24",
    guard: "the disclosure no longer says that confirmed people are researched and findings kept",
    file: "lib/network.ts",
    find: "Once you confirm who someone is, the platform may also research what the public web says about them in a few public, organizational kinds only (where they work, their title, a board, trustee or officer seat, a school, a role in a church or other organization) and keeps each finding with its source, marked as not yet reviewed, for you to review or strike; that research shares the same details plus the description and page of the match you confirmed, and still not your notes or how you know them. ",
    replace: "",
    test: T,
    expectFail: ["capture disclosure: once a person is confirmed the platform may research what the public web says about them"],
  },
  {
    id: "R25",
    guard: "the cost note is dropped from the click that spends",
    file: RES,
    find: "not yet researched. ${RESEARCH_COST_NOTE} This click spends:",
    replace: "not yet researched. This click spends:",
    test: T,
    expectFail: ["THE BATCH BUTTON: 'Research your network (212)'"],
  },
  {
    id: "R26",
    guard: "research is attempted (and a run born) with the findings table missing",
    file: ACT,
    find: "    if (!(await findingsTableReadable(supabase))) return { error: NOT_SET_UP };\n    const read = await readSubject(supabase, personId);",
    replace: "    const read = await readSubject(supabase, personId);",
    test: T,
    expectFail: ["CODE AHEAD OF THE MIGRATION"],
  },
  {
    id: "R27",
    guard: "a re-run writes findings that are already held (and brings back a struck one)",
    file: ACT,
    find: "    const toWrite = result.findings.filter((f) => !have.has(findingKey(f)));",
    replace: "    const toWrite = result.findings;",
    test: T,
    expectFail: ["it ADDS only what is new"],
  },
  {
    id: "R28",
    guard: "the 'Could not be checked against the source' findings are shown as ordinary findings",
    file: RES,
    find: '  const usableAll = list.filter((f) => isUsableFinding(f));',
    replace: '  const usableAll = list.filter((f) => f.status === "included");',
    test: T,
    expectFail: ["the usable findings are NOT inside a collapsed section"],
  },
  {
    id: "R29",
    guard: "the 'Not yet reviewed by a person' label is dropped from a finding",
    file: `${APP}/research/findings-view.tsx`,
    find: '<span style={chipStyle("amber")}>{NOT_REVIEWED_LABEL}</span>',
    replace: '<span style={chipStyle("amber")}>Reviewed</span>',
    test: T,
    expectFail: ["the label 'Not yet reviewed by a person' on every finding shown as usable"],
  },
  {
    id: "R30",
    guard: "the source link opens in the same tab without rel noopener",
    file: `${APP}/research/findings-view.tsx`,
    find: 'target="_blank" rel="noopener noreferrer nofollow" style={{ color: colors.text }}',
    replace: 'style={{ color: colors.text }}',
    test: T,
    expectFail: ["each shows the SOURCE link, opening in a new tab with rel noopener"],
  },
  // ---- the migration, on a real Postgres ----
  {
    id: "D1",
    guard: "the database accepts a kind outside the closed list",
    file: SQL,
    find: "  check (kind in ('employer', 'title', 'board_seat', 'school', 'org_leadership_role', 'public_affiliation'));",
    replace: "  check (kind <> '');",
    test: TM,
    expectFail: ["a finding of ANY other kind"],
  },
  {
    id: "D2",
    guard: "the database lets a finding be born for an unconfirmed person",
    file: SQL,
    find: "    if c.identity_status <> 'confirmed' then",
    replace: "    if false then",
    test: TM,
    expectFail: ["an unconfirmed person cannot be given a finding"],
  },
  {
    id: "D3",
    guard: "the database lets a finding be born for a do-not-research person",
    file: SQL,
    find: "    if c.do_not_research then\n      raise exception 'findings cannot be recorded for a person marked do not research';",
    replace: "    if false then\n      raise exception 'findings cannot be recorded for a person marked do not research';",
    test: TM,
    expectFail: ["a do-not-research person cannot be given a finding"],
  },
  {
    id: "D4",
    guard: "the database accepts a social-network or broker source (the host list is emptied)",
    file: SQL,
    find: "      !~ '(^|\\.)(linkedin\\.com|",
    replace: "      !~ '(^|\\.)(notarealhost\\.example|",
    test: TM,
    expectFail: ["hosts the code refuses is refused by the database too"],
  },
  {
    id: "D5",
    guard: "editing a confirmed person's facts no longer deletes their findings (the trigger is never created)",
    file: SQL,
    find: "create trigger network_connections_clear_findings\n  after update on network_connections\n  for each row execute function clear_network_findings_after_identity_change();\n",
    replace: "",
    test: TM,
    expectFail: ["changing person_name: the person is back to unconfirmed and all 3 findings are gone", "resetting the identity", "marking a confirmed person do-not-research deletes the findings"],
  },
  {
    id: "D6",
    guard: "marking a person do-not-research no longer deletes their findings",
    file: SQL,
    find: "     or (new.do_not_research and not old.do_not_research) then\n    delete from network_person_findings",
    replace: "     or false then\n    delete from network_person_findings",
    test: TM,
    expectFail: ["the do-not-research clause works by itself"],
  },
  {
    id: "D7",
    guard: "confirming a different candidate keeps the findings that rested on the first",
    file: SQL,
    find: "(new.identity_status <> 'confirmed' or new.identity_candidate_id is distinct from old.identity_candidate_id))",
    replace: "(new.identity_status <> 'confirmed'))",
    test: TM,
    expectFail: ["confirming a DIFFERENT candidate of the same person"],
  },
  {
    id: "D8",
    guard: "the unique index reads a missing organization as distinct nulls and is case-sensitive",
    file: SQL,
    find: "    lower(coalesce(organization_named, '')),\n    lower(coalesce(role_text, '')),",
    replace: "    organization_named,\n    role_text,",
    test: TM,
    expectFail: ["a bare title is unique too"],
  },
  {
    id: "D9",
    guard: "a finding's content becomes editable (the guard trigger is never created)",
    file: SQL,
    find: "create trigger network_person_findings_guard\n  before update on network_person_findings\n  for each row execute function guard_network_finding_update();\n",
    replace: "",
    test: TM,
    expectFail: ["kind cannot be edited", "supported (an unsupported finding cannot be made supported by hand) cannot be edited"],
  },
  {
    id: "D10",
    guard: "a signed-in user can record a strike as someone else",
    file: SQL,
    find: "      if auth.uid() is not null and who <> auth.uid() then",
    replace: "      if false then",
    test: TM,
    expectFail: ["a signed-in user cannot record a strike as a different teammate"],
  },
  {
    id: "D11",
    guard: "a finding can be written for another organization's person",
    file: SQL,
    find: "  if new.organization_id is distinct from c.organization_id then",
    replace: "  if false then",
    test: TM,
    expectFail: ["a finding for Org B's person cannot be written as Org A's row"],
  },
  {
    id: "D12",
    guard: "a DELETE policy is added (a struck finding could be made to disappear)",
    file: SQL,
    find: "-- Cross-table org integrity on EVERY reference, 0066/0077/0083's pattern, and\n",
    replace: 'create policy "team members can delete network person findings"\n  on network_person_findings for delete\n  to authenticated\n  using (organization_id = my_organization_id());\n\n-- Cross-table org integrity on EVERY reference, 0066/0077/0083\'s pattern, and\n',
    test: TM,
    expectFail: ["NOBODY can delete a finding directly", "there is deliberately NO delete policy"],
  },
  {
    id: "D13",
    guard: "any organization can read any other's findings",
    file: SQL,
    find: '  on network_person_findings for select\n  to authenticated\n  using (organization_id = my_organization_id());',
    replace: '  on network_person_findings for select\n  to authenticated\n  using (true);',
    test: TM,
    expectFail: ["Org A's user sees Org A's findings and none of Org B's"],
  },
  {
    id: "D14",
    guard: "a struck finding need not say who struck it or when",
    file: SQL,
    find: "      and struck_by is not null and struck_at is not null\n      and restored_by is null and restored_at is null)",
    replace: "      and restored_by is null and restored_at is null)",
    test: TM,
    expectFail: ["'struck' with no striker and no time is refused"],
  },
  {
    id: "D15",
    guard: "a bare title need not name a role, and other kinds need not name an organization",
    file: SQL,
    find: "    (kind = 'title' and role_text is not null)\n    or (kind <> 'title' and organization_named is not null)",
    replace: "    true",
    test: TM,
    expectFail: ["a title with no role is refused"],
  },
  {
    id: "D16",
    guard: "erasing a person no longer erases their findings (no cascade)",
    file: SQL,
    find: "references network_connections (id) on delete cascade,",
    replace: "references network_connections (id),",
    test: TM,
    expectFail: ["erasing a CONFIRMED person with findings"],
  },
  {
    id: "D17",
    guard: "a finding can cite another organization's ledger run",
    file: SQL,
    find: "  if new.ai_run_id is not null\n     and new.organization_id is distinct from",
    replace: "  if false\n     and new.organization_id is distinct from",
    test: TM,
    expectFail: ["a finding citing another organization's run is refused"],
  },
  {
    id: "D18",
    guard: "a person who stops being confirmed (reset, 'none of these') keeps their findings",
    file: SQL,
    find: "  if (old.identity_status = 'confirmed'\n      and (new.identity_status <> 'confirmed' or new.identity_candidate_id is distinct from old.identity_candidate_id))",
    replace: "  if (old.identity_status = 'confirmed'\n      and (new.identity_status = 'confirmed' and new.identity_candidate_id is distinct from old.identity_candidate_id))",
    test: TM,
    expectFail: ["moving a confirmed person to 'none of these' deletes the findings"],
  },
];

function run(test: string): { fails: string[]; passed: number; failed: number; raw: string } {
  const r = spawnSync("npx", ["tsx", test], { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const raw = `${r.stdout ?? ""}${r.stderr ?? ""}`;
  const fails = raw.split("\n").filter((l) => l.startsWith("FAIL: ")).map((l) => l.slice(6));
  const m = raw.match(/(\d+) passed, (\d+) failed/);
  return { fails, passed: m ? Number(m[1]) : 0, failed: m ? Number(m[2]) : -1, raw };
}

const originals = new Map<string, string>();
function restoreAll() {
  for (const [file, text] of originals) {
    try {
      writeFileSync(join(root, file), text);
    } catch {
      /* best effort on the way out */
    }
  }
}
process.on("exit", restoreAll);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => process.exit(130));

const wanted = process.argv.slice(2);
const todo = MUTATIONS.filter((m) => wanted.length === 0 || wanted.includes(m.id));

console.log("Baseline (nothing mutated):");
const baselines = new Map<string, ReturnType<typeof run>>();
for (const t of new Set(todo.map((m) => m.test))) {
  const b = run(t);
  baselines.set(t, b);
  console.log(`  ${t}: ${b.passed} passed, ${b.failed} failed`);
  if (b.failed !== 0) {
    console.error("The baseline does not pass, so a mutation result would mean nothing. Stopping.");
    process.exit(2);
  }
}

type Row = { m: Mutation; status: "CAUGHT" | "NOT CAUGHT" | "NOT APPLIED"; failing: string[]; detail: string };
const rows: Row[] = [];
for (const m of todo) {
  const path = join(root, m.file);
  const original = readFileSync(path, "utf8");
  originals.set(m.file, original);
  const occurrences = original.split(m.find).length - 1;
  if (occurrences !== 1) {
    rows.push({ m, status: "NOT APPLIED", failing: [], detail: `the text to change appears ${occurrences} times (must be exactly once)` });
    continue;
  }
  try {
    writeFileSync(path, original.replace(m.find, () => m.replace));
    const r = run(m.test);
    const matched = m.expectFail.filter((e) => r.fails.some((f) => f.includes(e)));
    rows.push({
      m,
      status: matched.length > 0 && r.fails.length > 0 ? "CAUGHT" : "NOT CAUGHT",
      failing: r.fails,
      detail: `${r.passed} passed, ${r.failed} failed; expected-label matches: ${matched.length}/${m.expectFail.length}`,
    });
  } finally {
    writeFileSync(path, original);
    if (readFileSync(path, "utf8") !== original) throw new Error(`could not restore ${m.file}`);
    originals.delete(m.file);
  }
}

console.log("\nMutation results:\n");
for (const r of rows) {
  console.log(`${r.m.id}  ${r.status}  --  ${r.m.guard}`);
  console.log(`      file: ${r.m.file}; run: ${r.m.test}; ${r.detail}`);
  for (const f of r.failing.slice(0, 4)) console.log(`      FAIL: ${f.length > 200 ? `${f.slice(0, 200)}...` : f}`);
  if (r.failing.length > 4) console.log(`      ... and ${r.failing.length - 4} more failing assertions`);
}
const bad = rows.filter((r) => r.status !== "CAUGHT");
console.log(`\n${rows.length - bad.length} of ${rows.length} mutations caught.${bad.length ? ` NOT CAUGHT / NOT APPLIED: ${bad.map((b) => b.m.id).join(", ")}` : ""}`);
process.exit(bad.length > 0 ? 1 : 0);
