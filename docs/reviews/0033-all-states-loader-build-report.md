# 0033 — The funder reference loader for every state: build report

Item 114 · authorized by ruling 0046 (which widens ruling 0045) · build space, 2026-11-09
Status: **built and tested on the owner's Mac. Nothing was committed or pushed, nothing was applied to production, and nothing was run on a server.** The server setup script has never run on a real Ubuntu machine (section 9).

## 1. Read this first

**What the owner gets.** One command that loads the funder reference database for every state and territory in the IRS filings, one state at a time, by itself. It loads New York, Texas, Florida, Pennsylvania and Illinois first, then the rest by size. It skips any state that is already done for the filings the IRS lists today, so running it again or after a stop repeats nothing. After each state it checks a repeatable sample of that state's funders against the IRS filings (150 funders by default, always the 10 with the most grants and the 10 with the most people) using the independent checker. A difference counts as explained only if someone has written its cause in a dated exception list; anything else stops the whole run before the next state and is shown in the database. It tells the database what it is doing as it goes, so you can read the last status from anywhere without logging into the server. Once a month a timer fetches only the IRS files it does not have and runs the same command, which reloads only the states whose filings changed. It sends nothing to anyone and writes only the shared reference tables and their run records.

**The server.** One script, run once in the browser terminal, sets up a fresh Ubuntu 24.04 machine: Node 22, a 4 GB safety swap file, a no-login user, the code (through a read-only GitHub deploy key it makes and shows you; no token), your hidden Supabase key stored for root alone, the IRS download, and the service and monthly timer. It refuses to start with under 60 GB free. It does not start the first load. It ends by printing the one command that does, and the three you need afterwards.

**What it costs.**
- *Memory.* Before: loading California needed **5.77 GB** at its peak (measured). Now: **1.7 to 1.8 GB** with a local test database that itself takes about 0.9 GB, and **1.2 to 1.3 GB** with no database at all, which is the shape of a run against Supabase. So an 8 GB server has room to spare and a 4 GB one is workable with the swap file as a safety net and the service capped at 80% of memory. Every state runs in its own process, so memory is given back between states. The controlling process, which lives for the whole run, uses about 0.5 GB.
- *Disk.* About 20 GB of IRS files (measured on the Mac: 19.97 GB of archives plus 0.4 GB of index files), a few hundred MB of caches and logs, and 4 GB of swap. The setup refuses under 60 GB free; a 80 GB disk passes that, a 160 GB disk has ample room.
- *Time.* **Not measured on the server. An estimate:** California took 95 minutes to write 36,625 filings to production from the Mac (156 milliseconds each, 5,727 s in the Mac's own run diary). The rest of the country is about 338,000 more filings, which at the same pace is **about 15 hours of writing**, plus reading and the sample checks, so plan on a day. A server in the same region as the database should be faster. Reading and deciding is quick: a whole state is read in 10 to 60 seconds on the Mac (measured). The monthly refresh should be minutes to a few hours, depending on how many states gained filings.

**Four things found by running it on real data that you should know now.**
1. **The first real multi-state run stopped, as designed, on something that is not a loader fault.** Many funders file from addresses in more than one state (5,491 of 136,543 funders in the header data, about 4%). Each state is loaded as a unit and judges the size threshold on its own returns, so a small return filed from one state can be held "below the threshold" while the funder is in scope through a larger return from another state. The checker flags that as a mismatch ("no filing for this EIN is skipped below the threshold"). It will appear in almost every state's sample. The exception list ships empty, as instructed, so the first server run will halt at its first state until the decision space rules. Two ways out are in section 10, item 1. I did not choose.
2. **A real checker fault was found and corrected** (ruling 0046 clause 4 asks for this to be recorded): the checker reported a false mismatch when a filer typed its own EIN into the signing officer's SSN field (EIN 112001717 did). The EIN is public and is stored on purpose, so it is not a leak. The checker now counts and lists those instead of flagging them. This needs recording on the item and, because it changes what the checker accepts, the decision space's eye.
3. **A bug that would have corrupted the data was found and fixed before any second state was loaded.** The loader's final step replaced the "which years are held" rows for every funder in the whole index, so loading Texas would have erased California's. It now touches only the funders it considered (section 6).
4. **One Washington return is 279 MB of XML with 363,675 listed grants** (EIN 462626883, object 202540919349100629). Written as one database call it is a 245 MB document; the local test database ran out of memory on it, so Washington failed three times. Reading it would also strain the loader's 1.5 GB. The loader now records any return over 64 MB of XML, or any filing whose write document is over 16 MB, as unread with the reason, size and limit, and carries on (section 6). Whether Supabase would accept a call that size was never tried.

## 2. What was built

New files:

| Path | What it is |
|---|---|
| `lib/funder-reference/supervisor.ts` | Every decision of the all-states command as plain functions (order, complete or not, skip or check or load, the sample, the exception list, retry), plus the loop. |
| `lib/funder-reference/run-store.ts` | How the command reads and writes the existing run table: the standing row, a note on each state's run, marking killed runs. No new table. |
| `lib/funder-reference/strings.ts` | A small function that copies a string so it does not keep a whole IRS return alive (the memory fix). |
| `lib/funder-reference/verify-exceptions.json` | The written exception list. **Empty.** Its schema is documented inside it. |
| `scripts/load-all-states.ts` | The all-states command. |
| `scripts/all-states-status.ts` | Prints the last status from the run table. |
| `scripts/funder-reference-rows-digest.ts` | A fingerprint of every stored reference row, ignoring only run id and load times, for before-and-after comparisons. |
| `scripts/server/setup-funder-loader.sh` | The one-time server setup. |
| `scripts/server/funder-loader-run.sh` | What the server runs: fetch, then load. |
| `scripts/server/funder-loader-status.sh` | The status command for the server (reads the key file, shows the run table). |
| `scripts/test-funder-reference-memory.ts` | Memory tests, including the real-data acceptance test. |
| `scripts/test-all-states.ts` | Tests of the command, from pure decisions up to the real command on real child processes. |
| `scripts/test-server-setup.ts` | Tests of the server scripts that do not need a server. |
| `scripts/mutation-check-all-states.ts` | Breaks each key decision on purpose and shows a test notices. |

Changed files:

| Path | What changed |
|---|---|
| `lib/funder-reference/pipeline.ts` | Memory fix; pass-A cache records name their state; coverage step touches only the funders the run considered; a header-scan-only entry point; dry runs keep less. No parsed or stored value changed (section 3). |
| `lib/funder-reference/sources.ts` | Faster CSV reading with the same results; a one-row-at-a-time index reader; archive open takes a member filter. |
| `lib/funder-reference/zip.ts` | An optional filter for which archive members are listed. Default behaviour unchanged. |
| `scripts/load-funder-reference.ts` | Header comments rewritten; options for no database in a dry run, a header-scan-only run and a result file; peak memory printed. |
| `scripts/verify-funder-reference-example.ts` | The SSN-field fault above. Nothing else. |

Not changed on purpose: the two California shell scripts under scripts, because a bash script that is running when it is edited can break. The owner's Mac is running one of them now. Their comments about a 10 GB heap are out of date; the decision space can have them tidied after that run ends.

## 3. The memory fix

**Method.** Peak resident memory is the figure macOS reports for the whole run (`/usr/bin/time -l`, "maximum resident set size"), on Node 26.4.0 on the owner's Mac. Inputs were the real IRS files in the Mac's irs-data folder and a copy of the existing header cache (read only). Each run used a fresh scratch work folder under /private/tmp, so pass A (reading every in-state return whole) was cold. Phase-by-phase figures come from the loader's own memory log lines. Heap snapshots were not taken; the causes were established by measuring each phase and by controlled experiments.

**Before and after, same input:**

| Run | Before | After |
|---|---|---|
| Minnesota, local test database | 2.89 GB (2,894,970,880 bytes) | 1.63 GB (1,633,075,200 bytes), 1536 MB heap cap |
| California, cold, local test database | **5.77 GB (5,771,673,600 bytes)** | **1.70 GB (1,696,071,680) and 1.81 GB (1,814,167,552)** in two runs, 1536 MB heap cap |
| California, no database (dry run) | not measured: the old code kept every parsed return in a dry run | 1.31 GB (1,314,881,536 bytes), 1536 MB heap cap, 24 s |
| the local test database alone | | about 0.9 GB (87 MB before it opens, about 1,020 MB after) |

**The causes, in order of size.**
1. **Reading a return kept it alive.** V8 does not copy a substring of 13 or more characters; it points into the original. The loader kept a 25-character timestamp from every return it read in pass A, and each one kept its entire return (about 100 KB) in memory for the rest of the run. Measured: the heap grew from 538 MB to 1,076 MB over Minnesota's 5,241 returns. California's 36,000 would be about 3.6 GB. Fixed by copying the few strings kept (strings.ts). A test loads 2,500 returns (134 MB of XML) under a 96 MB heap limit and cannot pass if even one small piece of each return is kept.
2. **Every opening of an IRS archive built an object, a name and two map entries for every member.** An archive can list several hundred thousand. The loader opens each archive four times per run. The locate step peaked at 1,557 MB of heap (Minnesota). Now only the members being looked for are listed, and the other three opens list none: the same step peaks at about 320 MB.
3. **The index reader built each field one character at a time**, leaving long fields as chains of one-character nodes. The 375,000-row index took 496 MB of heap and now takes 166 to 198 MB. A line with no quote is now cut at its commas; 6,000 generated lines give identical fields to the old reader, which is kept in the test as the oracle.
4. **What stays.** The index rows, the located members and the header records for all 375,000 returns are held for the run. That is about 330 to 420 MB of heap, flat from the start of pass A to the end (the old figure rose by 500 MB over the same pass). It is the floor.

I tested the stated hypotheses: substrings keeping the XML alive was the main cause; the index and header records held whole are a real but smaller floor, and I did not remove them because the run needs them.

**No parsed or stored value changed.** For California and for Minnesota, a fingerprint of all seven stored reference tables (row count and SHA-256 over every row, leaving out only the run id, load time and check time, which are about when and by which run) is **identical before and after**: California's 36,628 filings, 6,178 funders, 17,519 figures rows, 82,336 people, 406,422 grants, 17,519 application rows and 18,534 coverage rows, and the run's own counts (outcomes, in scope, below threshold, superseded, unread) are identical line for line. The California comparison was repeated on the final code, after every change in this report. Existing suites pass unchanged (section 8).

## 4. How the all-states command decides

Ruling 0046 clause 3 says a state is complete only when four things are recorded on its run. The command checks them from the run table itself, not from the loader's own flags:
1. The run finished.
2. The outcome counts, added up here, equal the returns the run considered.
3. The header audit (a sample of the returns the header ruled out, read whole) found none that was in the state after all, and did read some.
4. The verified sample has no unexplained mismatch.

A state's earlier completion also counts only for the same loader version, tax years, size threshold, and the same IRS index rows for that state. A digest of the object ids of the state's index rows is stored on its run, so a month's new filings reopen only the states that gained returns. When a state is not complete the command either checks it again (loaded and sound, sample missing or stale) or loads it. The first load of a state under a changed loader version is verified in full, not by sample (clause 4); the version number must be bumped by whoever changes parsing or storing.

**Failure handling.** A loader process that fails is tried again up to 3 times with pauses of 30 s then 120 s; if it never works the state is marked failed and the run goes on to the next state, finishing with exit code 3. A loader that finishes but whose counts do not add up, or whose header audit found strays, or whose sample has an unexplained difference, or whose checker crashed, stops the run (exit code 1) and marks the state not verified, leaving its rows in place. A process silent for 30 minutes is stopped and counted as a failed attempt. A second copy refuses to start (exit 4).

**What it writes.** One standing row in the existing run table, with a fixed id, updated at every step (running, completed, failed, interrupted) with the status and reason of every state; and a note on each state's own run (input digest, the sample, the exceptions that explained anything, peak memory). Runs found still "running" from a killed process are marked interrupted. A repeat invocation writes no new row. A small manifest in the work folder remembers how far each state got, so a kill between loading and checking resumes with the check.

**Dry run.** Reads the index and the database and prints each state's decision and reason; starts nothing and writes nothing. (With a local test database it creates an empty database folder if none exists.)

**The sample.** Funders are those whose foundation row says the state. The 10 with the most grant rows and the 10 with the most people rows are always in. The rest are drawn by ranking a hash of seed, state and EIN, so the same funders and seed always give the same sample; a state with 150 or fewer funders is checked whole. Against the hosted database the grant count is the listed grants on each standing filing's figures row plus rows approved for future payment (it cannot ask for a count per funder); against the local one it is an exact count.

## 5. What running it on real data showed

I ran the command itself, not the loader alone, on the real IRS files with a local test database, a copy of the existing header cache and the real independent checker. Thirty-four states and territories ran to **complete**: VT, SD, ND, AK, HI, AR, DC, ME, CO, MD, WA, CT, MN, IN, AZ, TN, AL, UT, OK, IA, KS, SC, OR, KY, LA, NE, NH, ID, MT, WV, MS, RI, NM, WY. Totals from their run records: 16,233 funders and 45,790 standing filings stored (98,496 filing rows including those held below the threshold or unread), 1,125,300 grant rows, 232,591 people rows; the sample checked 4,944 of 16,315 funders and **compared 11,010,867 stored values with the filings. 5 mismatches, all of one kind.** About 10 to 35 seconds a state; the loader process peaked at 1.15 to 1.45 GB, except Washington at 3.95 GB, which is the local test database's own memory growing on very large filings (the program's heap stayed inside its 1536 MB cap; against Supabase there is no such database in the process: a dry run of Washington with no database peaked at 1.09 GB).

- The first Vermont run stopped on the SSN-field fault (section 1, item 2). After the correction it passed.
- Idaho stopped on the funder-in-two-states difference (section 1, item 1). I then ran the remaining states with a scratch exception file (not the shipped list, which is still empty) holding exactly that message. Five states (WA, UT, LA, ID, NM) each had one such difference; each was checked by hand against the header data and every one is a funder with returns from addresses in two or three states (for example EIN 462502407: one return from Idaho loaded, two from Hawaii held below the threshold). **No other kind of difference appeared in the other 29 states, or anywhere else.**
- Washington first failed three times (section 1, item 4) and, with the oversize limits in place, completed: two returns of the same funder (EIN 462626883, 277.6 and 278.8 MB) are recorded as unread with their reason.
- **Run again, back to back, over the same 34 states:** all 34 were skipped as complete; no loader process started, no check ran, **no run row was added (38 before, 38 after) and a per-table row count and hash of all seven reference tables was identical.**
- A stop signal sent to the command mid-run (during Connecticut's check) was handled as designed: the standing row read INTERRUPTED with the last note, and the next start resumed.

## 6. Other things changed or found

- **Coverage rows (a bug).** The final step replaced the "which years are held" rows for every funder in the whole index. With one state loaded that was harmless; with two it would have erased the first state's. It now replaces rows only for the funders the run considered. A funder with returns in more than one state gets its rows worked out from every index row it has, using this run's result for the rows it decided and the database's for the rest. Where the index has a return for a year that another state's run held below the threshold, no coverage row is written, because "not in the index" would be false and the table has no other status for it (a decision for the decision space, item 2 in section 10). For a database holding one state the result is exactly what it was (the California fingerprint is identical).
- **Oversize returns (new, found on Washington).** Two limits, both stated in the reason on the filing and in the run record, both overridable on the loader's command line (--max-return-mb, --max-write-mb): a return whose XML is over 64 MB is not parsed; a filing whose write document is over 16 MB is not written. Either way the filing is stored as unread with its reason, the funder's year shows as unread (not absent), and the run's counts still add up. Before this a single such return stopped its whole state. The limits are my choice, not a measured Supabase limit; the largest California filing is about 1 MB.
- **The pass-A cache is now per state.** It used to be one file for the run with no state on its records, so a state's verdict could be reused by another state for any return whose header could not be read cheaply. Each record now names its state. The existing cache from the owner's California run has no state on it and will be ignored, so that run's pass A would be read again once.
- **A return not in any archive** has no header record, so the command's "any returns not yet scanned" check always finds it and starts a header-scan process (about 10 seconds). Harmless; noted.
- **Funders with returns in more than one state:** 5,491 of 136,543 funder numbers in the header data have returns in more than one US state across the three years. The foundation row describes the funder as of its latest return, wherever that was filed.
- **Not a state:** 442 returns are filed from foreign addresses and belong to no state's run; they are never loaded. "AE" (a military mail address, three returns) and the territories (PR, VI, AS, MP, GU) are treated as states.
- **tsx is not a declared dependency of the repository.** The scripts are run with npx tsx everywhere. The server setup installs tsx 4.21.0 next to the code without changing the repository's package files.

## 7. The server setup script

Written for Ubuntu 24.04; run as `bash setup-funder-loader.sh` by a user with sudo (it asks for sudo). The script is self-contained, so it can be pasted into the browser terminal before the code is on the server. Options: --check (print what it would do, change nothing), --skip-download, --key-from-stdin, --only STEPS, --env-file, --print-units. Steps, each skipped if already done:
1. Machine check (Ubuntu 24.04; memory; 60 GB free or it stops before installing anything).
2. Installs git, curl and Node.js 22 from NodeSource's apt repository. **Node 22 is the choice** because it is the long-term-support line this loader has run on (the earlier cloud session) and Next.js in this repository declares support from Node 18.17; the owner's Mac runs Node 26, which every test here ran on. Node 22 was **not** run for this item.
3. A 4 GB swap file and swappiness 10.
4. The no-login user and its folders.
5. An SSH key for that user; prints the public half and where to paste it (repository, Settings, Deploy keys, Add deploy key; leave write access unchecked); waits for Enter; checks GitHub accepts it; clones main. GitHub's published host key is pinned (checked today against GitHub's published list), not trusted on first use.
6. The key: hidden prompt, must start sb_secret_, written to the root-only env file with the URL and NODE_OPTIONS=--max-old-space-size=1536, never printed or on a command line. Run again, Enter keeps the stored key.
7. The IRS download with the project's fetch script (resumable).
8. The service (Restart=on-failure so a crash or reboot resumes; it does not restart after a deliberate stop with exit codes 1, 2, 3 or 4; memory capped at 80%) and the monthly timer. The timer starts a small unit that starts the loader only if a person has already started the first load.

The monthly run, through the same wrapper: replaces the index files whole (staged, then moved), fetches any archive not on disk, runs the command. A failed download exits 5 so systemd retries it by itself.

## 8. Verification

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean (exit 0) |
| `scripts/test-funder-reference.ts` | 161 passed, 0 failed (unchanged) |
| `scripts/test-funder-reference-migration.ts` | 124 passed, 0 failed (unchanged) |
| `scripts/test-funder-reference-memory.ts` (new) | 38 passed, 0 failed (includes the real-data acceptance test, which ran on Minnesota) |
| `scripts/test-all-states.ts` (new) | 172 passed, 0 failed (includes the real command on real child processes and a real local database over three synthetic states) |
| `scripts/test-server-setup.ts` (new) | 77 passed, 0 failed |
| `scripts/test-network-import.ts` | 156 passed, 0 failed (its migration-allowance check passes; no migration was added) |
| `scripts/mutation-check-all-states.ts` (new) | 36 mutations: 35 caught in the full run; the 36th (the unreadable-header rule) was not applied in that run because a refactor had renamed its target line, and is caught when run alone after correcting the text. Each is caught by a named assertion. Includes the memory fix, the per-state cache, the coverage scope, the oversize limits and the checker's SSN-field correction |
| `scripts/ledger-check.ts` | ends "protocol intact" (the two standing warnings about rulings 0005 and 0007 are unchanged); its own suite, scripts/test-ledger-check.ts, 111 of 111 |

No existing assertion was weakened or removed. One successor was added: the migration suite's rule that only two funder-reference scripts read the service key still passes as written (it looks only at paths containing "funder-reference"); the new all-states command and its status reader also read the key, so test-all-states.ts adds a stricter rule that names every file that does.

The memory acceptance test (section 6 of test-funder-reference-memory) ran Minnesota from the real IRS files under `node --max-old-space-size=1536` against a real local PostgreSQL and passed: 2,797 filings for 996 funders, peak resident memory 1,430 to 1,589 MB in three runs, below the 2 GB limit it asserts. It skips, and says so, on a machine without the IRS files.

## 9. NOT VERIFIED

- **Any real Ubuntu 24.04 server.** The setup script was syntax-checked, run in its --check mode on a Mac, and its generated systemd files were checked for shape. The NodeSource commands, apt, swap, user creation, the deploy key flow, the real key prompt, systemd and the timer have never run.
- **Node 22.** Every test ran on Node 26.4.0.
- **systemd behaviour:** restart on a crash or reboot, the exit-code rules, the memory cap, the timer's calendar and its refresh unit's condition were not exercised. systemd-analyze was not available.
- **Writes to Supabase.** No command here wrote to Supabase. The hosted run-table code was tested only against an in-memory stand-in for the client, so PostgREST's actual behaviour (the filter on a field inside the parameters document, paging, the funder count queries) is unconfirmed, and so is how long the checker takes against the hosted database.
- **Time on the server.** All time figures for a full load are estimates from California's earlier run.
- **Supabase's limit on the size of one call.** The 16 MB write limit is a guess to keep calls small; the real limit was not tried. The one 245 MB filing was not written anywhere but the local test database, which refused it.
- **A real run through every state** and the national header scan: 34 of 57 were run, on a local database, with the existing header cache; the biggest states (New York, Texas, Florida, Pennsylvania, Illinois, Ohio and the rest) were not, and California went through the loader but not through the command. The header scan of all returns was not repeated.
- **Peak memory on Linux.** Measured on macOS. Linux counts resident memory a little differently.
- **The monthly refresh end to end,** including a changed index.
- **A kill in the middle of a state's load** (SIGKILL or the out-of-memory killer) and then a restart, the stall watchdog (30 minutes of silence) and the second-copy lock: covered by fakes or by design only. A stop signal (SIGTERM) was observed once on the Mac, mid-check, and wrote the interrupted note.
- **--remote mode** (reading archives over the network) with the new member filter; only local archives were tested.

## 10. For the decision space to rule on

1. **Funders with returns in more than one state (section 1, item 1).** Today a state's run decides scope from its own returns, so such a funder can be held in full from one state and have a small return from another held below the threshold. Options: (a) accept it and add an exception to the list for the checker's message. A proposed entry: id "funder-in-two-states", cause "the funder has returns filed from addresses in more than one state; each state's run judges the size threshold on its own returns", pattern `^\[\d{9}\] no filing for this EIN is skipped below the threshold`, evidence "EIN 462502407, scratch run 2026-11-09 (this report, section 5)". This hides nothing else, but the funder's small return from the other state is simply not stored. (b) Decide scope per funder across states: a funder is in scope if any return anywhere meets the threshold, and a state's run then stores all of the funder's returns that it holds. That is better data but changes which filings California would store (additions only) and needs a cross-state figure cache. I recommend (b) before the national load, because (a) leaves the history of about 4% of funders incomplete without saying so. The list ships empty.
2. **Coverage for such funders.** Where the index has a return for a year held below the threshold, no coverage row is written. Is that acceptable, or is a new status wanted (that needs a migration)?
3. **The checker fault in section 1, item 2.** Record it on the item; confirm the correction (a filer's own EIN in the SSN field is counted and listed, not scanned for as an SSN).
4. **California.** The production California run was made by the Mac and carries no note from this command, so the server will reload it (writing nothing if unchanged) and verify it, rather than skip it. Is that wanted, or should the Mac's full verification stand?
5. **"Reads only IRS archives not yet read" (clause 5).** The download is incremental. A reload of a state whose filings changed re-reads that state's returns from disk, including old archives. Is that within the intent?
6. **Halt versus continue.** A load that does not add up or a header audit with strays halts; a loader process that crashes three times is marked failed and the run continues. Confirm.
7. **Full verification** happens automatically only when the loader version string changes. Nothing forces whoever changes parsing to bump it. This item changed no value and did not bump it.
8. **Database size.** California is 36,628 filings and 406,422 grant rows; the country is about ten times that. Check the Supabase plan's storage limit before the national load.
9. **package.json** has no tsx; adding it as a development dependency is outside this item's scope.
10. **"AE"** is loaded as if it were a state.
11. **Oversize returns** (section 6) are stored as unread rather than loaded in full, with limits of 64 MB read and 16 MB write that I chose. Washington's 363,675-grant return (EIN 462626883) is the case seen. Is "unread with a reason" the right record, or should such a return be split across several writes (that needs a migration)?

## 11. How to run it

On the Mac, for a dry look at the real order and decisions (reads the real index, writes nothing in the database except an empty local folder):

```
cd "/Users/kanjii/Developer/Fundraising Ai Build/fundraising-ai"
mkdir -p /private/tmp/f114/look/work && cp ~/irs-work/header-scan-cache.jsonl /private/tmp/f114/look/work/
npx tsx scripts/load-all-states.ts --work-dir /private/tmp/f114/look/work --index-dir ~/irs-data/index --archives-dir ~/irs-data/zips --target pglite:/private/tmp/f114/look/db --dry-run
```

On the server, after the setup script: start with `sudo systemctl start funder-loader`; follow with `sudo journalctl -u funder-loader -f`; see the last status with `sudo /opt/funder-loader/app/scripts/server/funder-loader-status.sh`; stop with `sudo systemctl stop funder-loader`.
