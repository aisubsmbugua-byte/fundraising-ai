// STATE item 110 (ruling 0045): the pieces of the funder-reference loader that
// need no database -- the XML reader, the Deflate/Deflate64 inflater, the ZIP
// reader, the Form 990-PF parser, the size threshold and the derived figures.
// (The database side is scripts/test-funder-reference-migration.ts.)
//
// Real data is used where it exists: the three Servant's Heart Foundation
// returns in scripts/fixtures/funder-reference/ are the IRS's own files, and the
// .deflate64 fixture is the exact compressed bytes of one of them as the IRS
// stored it (ZIP method 9, which no common tool reads). Everything else is built
// here on purpose so each failure mode is exercised by name.
//
// Usage: npx tsx scripts/test-funder-reference.ts

import { readFileSync, writeFileSync, mkdtempSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { crc32, deflateRawSync, inflateRawSync } from "node:zlib";
import { parseXml, XmlError } from "../lib/funder-reference/xml";
import { inflate, InflateError } from "../lib/funder-reference/inflate";
import { openZip, fileSource, httpSource, ZipError } from "../lib/funder-reference/zip";
import { FilingRejected, parseFiling990PF, peekHeader } from "../lib/funder-reference/parse-990pf";
import { assessThreshold, DEFAULT_THRESHOLD, deriveGrantStats, derivePayoutRatio } from "../lib/funder-reference/derive";
import { parseCsvLine, readIndex, canonicalArchiveName } from "../lib/funder-reference/sources";
import { makeZip } from "./funder-reference-test-support";
import { supabaseSink } from "../lib/funder-reference/sink";

let pass = 0;
let fail = 0;
function ok(label: string, condition: boolean, detail = "") {
  console.log(`${condition ? "PASS" : "FAIL"}: ${label}${condition ? "" : `\n      ${detail}`}`);
  condition ? pass++ : fail++;
}
function section(t: string) {
  console.log(`\n--- ${t} ---`);
}
function throws(fn: () => unknown, re: RegExp): boolean {
  try {
    fn();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
}
async function rejects(fn: () => Promise<unknown>, re: RegExp): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (e) {
    return re.test((e as Error).message);
  }
}

const FIX = join(__dirname, "fixtures/funder-reference");
const X22 = readFileSync(join(FIX, "202343189349103439_public.xml"), "utf8");
const X23 = readFileSync(join(FIX, "202403209349107935_public.xml"), "utf8");
const X24 = readFileSync(join(FIX, "202543159349101244_public.xml"), "utf8");

async function main() {
  // ---------------------------------------------------------------- XML reader
  section("XML reader: accepts what the IRS writes, refuses what it should");
  {
    const n = parseXml(`﻿<?xml version="1.0"?><!-- c --><Return xmlns="http://x" xmlns:xsi="http://y" xsi:schemaLocation="z" returnVersion="2022v5.0"><A><B>a &amp; b &lt;c&gt; &#65;&#x42;</B><C/><D><![CDATA[<raw>&]]></D></A></Return>`);
    ok("root name, attribute kept, namespace declarations dropped", n.name === "Return" && n.attrs.returnVersion === "2022v5.0" && !("xmlns" in n.attrs) && n.attrs.schemaLocation === "z");
    ok("entities and character references decode", n.children[0].children[0].text === "a & b <c> AB");
    ok("empty element and CDATA", n.children[0].children[1].text === "" && n.children[0].children[2].text === "<raw>&");
    ok("a DOCTYPE is refused (no entity expansion)", throws(() => parseXml(`<!DOCTYPE x [<!ENTITY a "b">]><x>&a;</x>`), /DOCTYPE/));
    ok("an unknown named entity is refused", throws(() => parseXml(`<x>&nbsp;</x>`), /unknown entity/));
    ok("mismatched tags are refused", throws(() => parseXml(`<a><b></a></b>`), /closes/));
    ok("an unclosed element is refused", throws(() => parseXml(`<a><b>text</b>`), /unclosed/));
    ok("text outside the root is refused", throws(() => parseXml(`<a/>stray`), /outside the root/));
    ok("two roots are refused", throws(() => parseXml(`<a/><b/>`), /more than one root/));
    ok("an empty document is refused", throws(() => parseXml(`   `), /no root/));
    ok("an unquoted attribute is refused", throws(() => parseXml(`<a b=c/>`), /not quoted/));
    ok("XmlError carries the offset", (() => { try { parseXml(`<a></b>`); } catch (e) { return e instanceof XmlError && e.offset >= 0; } return false; })());
    const big = parseXml(X22);
    ok("a real 56 KB return parses", big.name === "Return" && big.children.length === 2);
  }

  // ------------------------------------------------------------------- inflate
  section("inflate: plain Deflate agrees with node:zlib; Deflate64 reads what zlib cannot");
  {
    const samples: Array<[string, Buffer]> = [
      ["empty", Buffer.alloc(0)],
      ["one byte", Buffer.from("a")],
      ["text", Buffer.from("the quick brown fox ".repeat(500))],
      ["random (incompressible)", randomBytes(70_000)],
      ["a real return", Buffer.from(X22)],
    ];
    for (const level of [0, 1, 6, 9]) {
      for (const [name, data] of samples) {
        const c = deflateRawSync(data, { level });
        const mine = Buffer.from(inflate(c, { expectedSize: data.length }));
        ok(`level ${level}, ${name}: identical to the original`, mine.equals(data));
        ok(`level ${level}, ${name}: identical to node:zlib`, mine.equals(inflateRawSync(c)));
      }
    }
    ok("a truncated stream is refused", throws(() => inflate(deflateRawSync(Buffer.from("x".repeat(5000))).subarray(0, 4)), /ran out of input/));
    ok("a size that disagrees with the entry is refused", throws(() => inflate(deflateRawSync(Buffer.from("hello")), { expectedSize: 9 }), /declares 9/));
    ok("garbage is refused, not looped on", throws(() => inflate(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff])), /invalid|ran out/));
    ok("partial read stops early and returns a prefix", (() => {
      const data = Buffer.from("abcdefghij".repeat(5000));
      const part = Buffer.from(inflate(deflateRawSync(data), { maxOutput: 100 }));
      return part.length >= 100 && part.length < data.length && data.subarray(0, part.length).equals(part);
    })());

    // Hand-built Deflate64 streams: fixed-Huffman blocks using the codes only Deflate64 has.
    class Bits {
      private bytes: number[] = [];
      private cur = 0;
      private n = 0;
      lsb(v: number, count: number) {
        for (let i = 0; i < count; i++) this.push((v >> i) & 1);
      }
      msb(v: number, count: number) {
        for (let i = count - 1; i >= 0; i--) this.push((v >> i) & 1);
      }
      private push(b: number) {
        this.cur |= b << this.n;
        if (++this.n === 8) {
          this.bytes.push(this.cur);
          this.cur = 0;
          this.n = 0;
        }
      }
      align() {
        if (this.n) {
          this.bytes.push(this.cur);
          this.cur = 0;
          this.n = 0;
        }
      }
      raw(b: Uint8Array) {
        this.align();
        for (const x of b) this.bytes.push(x);
      }
      done(): Buffer {
        if (this.n) this.bytes.push(this.cur);
        return Buffer.from(this.bytes);
      }
      // fixed-Huffman literal/length symbol
      sym(s: number) {
        if (s < 144) this.msb(0x30 + s, 8);
        else if (s < 256) this.msb(0x190 + s - 144, 9);
        else if (s < 280) this.msb(s - 256, 7);
        else this.msb(0xc0 + s - 280, 8);
      }
    }
    // (a) one literal, then a match using length symbol 285 = 3 + 16 extra bits
    {
      const b = new Bits();
      b.lsb(1, 1); b.lsb(1, 2); // final block, fixed Huffman
      b.sym(97);
      b.sym(285); b.lsb(1000 - 3, 16); b.msb(0, 5); // length 1000, distance 1
      b.sym(256);
      const stream = b.done();
      const out = Buffer.from(inflate(stream, { deflate64: true }));
      ok("Deflate64: length code 285 carries 16 extra bits (1001 identical bytes)", out.length === 1001 && out.every((x) => x === 97));
      ok("the same stream read as plain Deflate does NOT give that answer", (() => { try { const o = Buffer.from(inflate(stream)); return !(o.length === 1001 && o.every((x) => x === 97)); } catch { return true; } })());
    }
    // (b) a distance beyond 32 KiB uses distance symbol 30 with 14 extra bits.
    //     History comes from a stored block, so plain Deflate parses everything up to
    //     that symbol and must refuse it BY NAME.
    {
      const b = new Bits();
      b.lsb(0, 1); b.lsb(0, 2); // not final, stored
      b.align();
      b.raw(Buffer.from([40000 & 0xff, 40000 >> 8, ~40000 & 0xff, (~40000 >> 8) & 0xff]));
      b.raw(Buffer.alloc(40000, 120)); // 40000 x
      b.lsb(1, 1); b.lsb(1, 2); // final, fixed Huffman
      b.sym(121); // 'y'
      b.sym(259); b.msb(30, 5); b.lsb(33000 - 32769, 14); // length 5, distance 33000
      b.sym(256);
      const stream = b.done();
      const out = Buffer.from(inflate(stream, { deflate64: true }));
      const want = Buffer.concat([Buffer.alloc(40000, 120), Buffer.from("y"), Buffer.alloc(5, 120)]);
      ok("Deflate64: distance symbol 30 reaches back past 32 KiB", out.equals(want));
      ok("plain Deflate refuses distance symbol 30, by name", throws(() => inflate(stream), /invalid distance symbol/));
    }
    // (c) the IRS's own bytes
    const blob = readFileSync(join(FIX, "202543159349101244.deflate64"));
    const out = Buffer.from(inflate(blob, { deflate64: true, expectedSize: 52617 }));
    ok("the IRS's Deflate64 member inflates to exactly the stored return", out.toString("utf8") === X24);
    ok("its CRC-32 equals the one the archive recorded (852762132)", crc32(out) === 852762132);
    ok("node:zlib cannot read it (the reason this inflater exists)", throws(() => inflateRawSync(blob), /./));
  }

  // ----------------------------------------------------------------- ZIP reader
  section("ZIP reader: every shape the IRS archives have, and the ways they break");
  {
    const items = [
      { name: "2025_TEOS_XML_01A/111111111111111111_public.xml", data: Buffer.from("<a>one</a>".repeat(300)) },
      { name: "222222222222222222_public.xml", data: Buffer.from("<b>two</b>"), method: 0 as const },
      { name: "2025_TEOS_XML_01A/333333333333333333_public.xml", data: randomBytes(3000) },
    ];
    for (const [label, opts] of [["plain", {}], ["ZIP64", { zip64: true }], ["76 bytes before the archive", { prefixBytes: 76 }], ["ZIP64 and bytes before", { zip64: true, prefixBytes: 76 }]] as const) {
      const path = join(mkdtempSync(join(tmpdir(), "zr-")), "t.zip");
      writeFileSync(path, makeZip(items, opts));
      const z = await openZip(await fileSource(path));
      ok(`${label}: three entries found`, z.entries.length === 3);
      ok(`${label}: prefix bytes detected as ${opts.prefixBytes ?? 0}`, z.prefixBytes === (opts.prefixBytes ?? 0));
      let allEqual = true;
      for (const it of items) {
        const e = z.findObject(it.name.slice(it.name.lastIndexOf("/") + 1).replace("_public.xml", ""));
        if (!e || !Buffer.from(await z.read(e)).equals(it.data)) allEqual = false;
      }
      ok(`${label}: every member reads back byte for byte (folder or top-level name)`, allEqual);
      ok(`${label}: an object that is not there is undefined`, z.findObject("999999999999999999") === undefined);
      await z.close();
      rmSync(join(path, ".."), { recursive: true });
    }

    const bad = makeZip([{ name: "x/444444444444444444_public.xml", data: Buffer.from("<c>hi</c>"), wrongCrc: true }]);
    const zBad = await openZip({ label: "mem", size: bad.length, read: async (o, l) => bad.subarray(o, o + l) });
    ok("a member whose bytes do not match its recorded CRC-32 is refused", await rejects(() => zBad.read(zBad.entries[0]), /CRC-32/));

    const unsup = makeZip([{ name: "x/555555555555555555_public.xml", data: Buffer.from("<c/>"), method: 99 as never, precompressed: Buffer.from("zz") }]);
    const zU = await openZip({ label: "mem", size: unsup.length, read: async (o, l) => unsup.subarray(o, o + l) });
    ok("an unsupported compression method is named, not mis-read", await rejects(() => zU.read(zU.entries[0]), /method 99 is not supported/));

    let closed = 0;
    const junk: Buffer = Buffer.alloc(200, 7);
    ok("a file that is not a zip is closed, not leaked, when it fails to open", await rejects(() => openZip({ label: "junk", size: junk.length, read: async (o, l) => junk.subarray(o, o + l), close: async () => { closed++; } }), /end-of-central-directory/) && closed === 1);
    ok("not a zip at all is refused", await rejects(() => openZip({ label: "mem", size: 100, read: async (o, l) => Buffer.alloc(l) }), /end-of-central-directory/));

    // a Deflate64 member exactly as the IRS stored it
    const blob = readFileSync(join(FIX, "202543159349101244.deflate64"));
    const d64 = makeZip([{ name: "202543159349101244_public.xml", data: Buffer.from(X24), method: 9, precompressed: blob }], { zip64: true, prefixBytes: 76 });
    const zD = await openZip({ label: "mem", size: d64.length, read: async (o, l) => d64.subarray(o, o + l) });
    const e = zD.findObject("202543159349101244")!;
    ok("Deflate64 member in a ZIP64 archive with leading bytes reads back whole and CRC-checked", Buffer.from(await zD.read(e)).toString("utf8") === X24);
    const pre = Buffer.from(await zD.readPrefix(e, 4000));
    ok("a prefix of a Deflate64 member starts with the original", pre.length >= 4000 && X24.startsWith(pre.toString("utf8")));
    const zDef = await openZip({ label: "mem", size: d64.length, read: async (o, l) => d64.subarray(o, o + l) });
    void zDef;

    const long = Buffer.from(X22 + X22 + X22);
    const dz = makeZip([{ name: "666666666666666666_public.xml", data: long }]);
    const zL = await openZip({ label: "mem", size: dz.length, read: async (o, l) => dz.subarray(o, o + l) });
    const p = Buffer.from(await zL.readPrefix(zL.entries[0], 6000));
    ok("a prefix of a Deflate member starts with the original and reads little of it", p.length >= 6000 && long.subarray(0, p.length).equals(p) && p.length < long.length);
    const hdr = peekHeader(p.toString("utf8"));
    ok("the header is readable from that prefix", hdr?.ein === "582218044" && hdr.state === "CA" && hdr.returnType === "990PF" && hdr.taxPeriodEnd === "2022-12-31");
  }

  section("ZIP over HTTP range requests");
  {
    const zipBytes = makeZip([{ name: "a/777777777777777777_public.xml", data: Buffer.from("<d>over http</d>") }, { name: "888888888888888888_public.xml", data: randomBytes(40_000) }], { zip64: true });
    let requests = 0;
    let ignoreRange = false;
    const srv = createServer((req, res) => {
      requests++;
      if (req.method === "HEAD") {
        res.writeHead(200, { "content-length": zipBytes.length, "accept-ranges": "bytes" });
        return res.end();
      }
      const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range ?? "");
      if (!m || ignoreRange) {
        res.writeHead(200, { "content-length": zipBytes.length });
        return res.end(zipBytes);
      }
      const [a, b] = [Number(m[1]), Number(m[2])];
      res.writeHead(206, { "content-length": b - a + 1, "content-range": `bytes ${a}-${b}/${zipBytes.length}` });
      res.end(zipBytes.subarray(a, b + 1));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const src = await httpSource(`http://127.0.0.1:${port}/t.zip`, "test-agent");
    const z = await openZip(src);
    requests = 0;
    const e = z.findObject("777777777777777777")!;
    ok("an HTTP-hosted archive opens and a member reads back", Buffer.from(await z.read(e)).toString() === "<d>over http</d>");
    ok("reading one small member took few requests, not the whole archive", requests <= 3, `${requests} requests`);
    ignoreRange = true;
    ok("a server that ignores Range (answers 200) is an error, not a silent full download", await rejects(() => z.read(z.findObject("888888888888888888")!), /expected 206/));
    srv.close();
  }

  // --------------------------------------------------------------------- parser
  section("Form 990-PF parser: the three real Servant's Heart returns");
  const p22 = parseFiling990PF(X22);
  const p23 = parseFiling990PF(X23);
  const p24 = parseFiling990PF(X24);
  {
    ok("EIN and tax period end, three years", p22.ein === "582218044" && [p22.taxPeriodEnd, p23.taxPeriodEnd, p24.taxPeriodEnd].join() === "2022-12-31,2023-12-31,2024-12-31");
    ok("return versions carried as filed", [p22.returnVersion, p23.returnVersion, p24.returnVersion].join() === "2022v5.0,2023v5.1,2024v5.2");
    ok("2022 figures as the filing states them", p22.figures.fmv_assets_eoy_amt === 17049161 && p22.figures.total_revenue_per_books_amt === 539140 && p22.figures.total_expenses_per_books_amt === 2054296 && p22.figures.contributions_paid_per_books_amt === 911323);
    ok("2022: qualifying distributions (Part XII) is NOT the distributable amount (Part XI)", p22.figures.qualifying_distributions_amt === 1104388 && p22.figures.distributable_amount_amt === 841321);
    ok("2023: the same distinction (1,067,256 vs 849,758) and minimum investment return 850,901", p23.figures.qualifying_distributions_amt === 1067256 && p23.figures.distributable_amount_amt === 849758 && p23.figures.minimum_investment_return_amt === 850901);
    ok("2024 read from the Deflate64 member's content: assets 17,408,962; charitable disbursements 1,855,039", p24.figures.fmv_assets_eoy_amt === 17408962 && p24.figures.total_expenses_charitable_disbursements_amt === 1855039);
    ok("three different 'giving' figures stay three columns (2022)", p22.figures.contributions_paid_per_books_amt !== p22.figures.total_expenses_charitable_disbursements_amt && p22.figures.grants_paid_stated_total_amt !== p22.figures.contributions_paid_per_books_amt);
    ok("grant counts 30, 33, 30; none left unmapped", p22.grantsPaid.length === 30 && p23.grantsPaid.length === 33 && p24.grantsPaid.length === 30 && [...p22.grantsPaid, ...p23.grantsPaid, ...p24.grantsPaid].every((g) => Object.keys(g.unmappedFields).length === 0));
    ok("the stated Part XV total is the stated one (911,322), not the per-books one (911,323)", p22.figures.grants_paid_stated_total_amt === 911322 && p22.grantsPaid.reduce((a, g) => a + (g.amountAmt ?? 0), 0) === 911322);
    ok("the 2022 list has no approved-for-future grants and the figure is stated as 0", p22.grantsApproved.length === 0 && p22.figures.grants_approved_future_stated_total_amt === 0);
    ok("2023 states no Part XV line 3b total at all: null, not 0", p23.figures.grants_approved_future_stated_total_amt === null);
    ok("officers, in order, with the words the return used", p22.people.filter((x) => x.listedIn === "part_viii_officers_directors_trustees").map((x) => `${x.nameAsNamed}|${x.titleAsStated}`).join("; ") === "PAUL A NEFF|PRESIDENT/CEO /CHAIRMAN; KATHY A NEFF|DIRECTOR; RICHARD HAUGEN|TREASURER; LINDSEY HAUGEN|SECRETARY");
    ok("hours kept as written, compensation numeric", p22.people[0].hoursPerWeekAsStated === "22.00" && p23.people[0].hoursPerWeekAsStated === "22.0" && p22.people[2].compensationAmt === 31790);
    ok("the header signer is a separate person row, not merged with the officer of the same name", p22.people.filter((x) => x.nameAsNamed === "PAUL A NEFF").length === 2);
    ok("no website: the return says N/A and that is what is kept, with no URL invented", p22.websiteAsStated === "N/A");
    ok("the 'only preselected charities' box is carried as 'X'", p22.onlyPreselectedRaw === "X" && p24.onlyPreselectedRaw === "X");
    ok("not a private operating foundation (0 -> false)", p22.isPrivateOperatingFoundation === false);
    ok("financial-statement groups kept whole (110+ element values)", Object.keys(p22.financialStatementValues).length >= 100 && p22.financialStatementValues["PFQualifyingDistributionsGrp/QualifyingDistributionsAmt"] === "1104388");
    ok("the signing officer's SSN is not read into anything", !JSON.stringify(p22).includes("999009999"));
    ok("a grant's address kept by part; city and state", p22.grantsPaid[0].recipientNameLine1 === "AFRICA RENEWAL MINISTRY" && p22.grantsPaid[0].address?.city === "SAN ANTONIO" && p22.grantsPaid[0].address?.state === "TX");
  }

  section("Form 990-PF parser: a filing that cannot be understood is rejected with a reason");
  {
    const rej = (xml: string, re: RegExp) => throws(() => parseFiling990PF(xml), re) && (() => { try { parseFiling990PF(xml); } catch (e) { return e instanceof FilingRejected; } return false; })();
    ok("not XML", rej("this is not xml", /not well-formed|outside the root|no root/));
    ok("truncated XML", rej(X22.slice(0, 20000), /not well-formed/));
    ok("a Form 990 (not 990-PF)", rej(X22.replace("<ReturnTypeCd>990PF</ReturnTypeCd>", "<ReturnTypeCd>990</ReturnTypeCd>"), /not 990PF/));
    ok("no tax period end", rej(X22.replace(/<TaxPeriodEndDt>[^<]*<\/TaxPeriodEndDt>/, ""), /TaxPeriodEndDt is absent/));
    ok("a bad EIN", rej(X22.replace("<EIN>582218044</EIN>", "<EIN>58-2218044</EIN>"), /not nine digits/));
    ok("a figure that is not a whole number is rejected, not rounded", rej(X22.replace("<FMVAssetsEOYAmt>17049161</FMVAssetsEOYAmt>", "<FMVAssetsEOYAmt>17,049,161</FMVAssetsEOYAmt>"), /FMVAssetsEOYAmt is "17,049,161"/));
    ok("no IRS990PF body", rej(X22.replace(/<IRS990PF[\s\S]*<\/IRS990PF>/, ""), /no IRS990PF/));
    ok("the wrong root element", rej(X22.replace(/<Return /, "<Other ").replace(/<\/Return>\s*$/, "</Other>"), /not <Return>/));
  }

  section("Form 990-PF parser: absent stays absent, odd shapes are kept");
  {
    const noSite = parseFiling990PF(X22.replace(/<WebsiteAddressTxt>[^<]*<\/WebsiteAddressTxt>/, ""));
    ok("a return with no website element has none (null), not 'N/A', not ''", noSite.websiteAsStated === null);
    const noBox = parseFiling990PF(X22.replace(/<OnlyContriToPreselectedInd>[^<]*<\/OnlyContriToPreselectedInd>/, ""));
    ok("an unmarked preselected box is null", noBox.onlyPreselectedRaw === null);
    const noOfficers = parseFiling990PF(X22.replace(/<OfficerDirTrstKeyEmplInfoGrp>[\s\S]*?<\/OfficerDirTrstKeyEmplInfoGrp>/, ""));
    ok("no officer list: only the header signer remains", noOfficers.people.length === 1 && noOfficers.people[0].listedIn === "signer_on_return_header");
    const noFig = parseFiling990PF(X22.replace(/<MinimumInvestmentReturnGrp>[\s\S]*?<\/MinimumInvestmentReturnGrp>/, ""));
    ok("a missing group's figures are null, not 0", noFig.figures.minimum_investment_return_amt === null && noFig.figures.net_value_noncharitable_assets_amt === null);

    const extra = X22.replace(
      /<GrantOrContributionPdDurYrGrp>/,
      `<GrantOrContributionPdDurYrGrp><NewUnknownElement>keep me</NewUnknownElement><RecipientPersonNm>A PERSON</RecipientPersonNm>`
    );
    const pe = parseFiling990PF(extra);
    ok("an element the schema gains is kept in unmapped_fields, not dropped", pe.grantsPaid[0].unmappedFields["NewUnknownElement"] === "keep me");
    ok("a person recipient is kept as a person", pe.grantsPaid[0].recipientPersonName === "A PERSON");

    const foreign = X23.match(/<RecipientForeignAddress>[\s\S]*?<\/RecipientForeignAddress>/)?.[0];
    ok("the 2023 return really has a foreign-address recipient (test premise)", !!foreign);
    const fg = p23.grantsPaid.find((g) => g.address?.country);
    ok("a foreign recipient keeps its country and has no US state", !!fg && fg.address!.country !== null && /^[A-Z]{2}$/.test(fg.address!.country!));

    const twoApp = X22.replace(
      "</SupplementaryInformationGrp>",
      `<ApplicationSubmissionInfoGrp><RecipientPersonNm>J DOE</RecipientPersonNm><FormAndInfoAndMaterialsTxt>LETTER</FormAndInfoAndMaterialsTxt><SubmissionDeadlinesTxt>MARCH 1</SubmissionDeadlinesTxt></ApplicationSubmissionInfoGrp><ApplicationSubmissionInfoGrp><RecipientPersonNm>K ROE</RecipientPersonNm></ApplicationSubmissionInfoGrp></SupplementaryInformationGrp>`
    );
    const pa = parseFiling990PF(twoApp);
    ok("application groups: two kept, every field by name", pa.applicationGroups.length === 2 && pa.applicationGroups[0].rawFields["SubmissionDeadlinesTxt"] === "MARCH 1" && pa.applicationGroups[1].rawFields["RecipientPersonNm"] === "K ROE");

    const future = X22.replace(
      "</SupplementaryInformationGrp>",
      `<GrantOrContriApprvForFutGrp><RecipientBusinessName><BusinessNameLine1Txt>FUTURE ORG</BusinessNameLine1Txt></RecipientBusinessName><RecipientUSAddress><CityNm>FRESNO</CityNm><StateAbbreviationCd>CA</StateAbbreviationCd></RecipientUSAddress><GrantOrContributionPurposeTxt>BUILDING</GrantOrContributionPurposeTxt><Amt>5000</Amt></GrantOrContriApprvForFutGrp></SupplementaryInformationGrp>`
    );
    const pf = parseFiling990PF(future);
    ok("approved-for-future-payment grants are a separate kind", pf.grantsApproved.length === 1 && pf.grantsApproved[0].kind === "approved_for_future_payment" && pf.grantsApproved[0].amountAmt === 5000 && pf.grantsPaid.length === 30);

    const body = X22.replace(/<IRS990PF documentId="[^"]*">/, "<IRS990PF>");
    ok("a missing documentId attribute does not matter", parseFiling990PF(body).figures.fmv_assets_eoy_amt === 17049161);
  }

  section("header peek (used to find California filers without reading whole returns)");
  {
    const pk = peekHeader(X22.slice(0, 5000));
    ok("EIN, return type, period end and state from the first 5 KB", pk?.ein === "582218044" && pk.returnType === "990PF" && pk.taxPeriodEnd === "2022-12-31" && pk.state === "CA" && !pk.foreign);
    ok("a prefix that ends before the filer block gives null", peekHeader(X22.slice(0, 300)) === null);
    const fgn = X22.replace(/<USAddress>[\s\S]*?<\/USAddress>/, `<ForeignAddress><AddressLine1Txt>1 RUE</AddressLine1Txt><CityNm>PARIS</CityNm><CountryCd>FR</CountryCd></ForeignAddress>`);
    const pf = peekHeader(fgn.slice(0, 5000));
    ok("a foreign filer has no US state", pf?.foreign === true && pf.state === null);
  }

  // ------------------------------------------------------------------- derived
  section("size threshold and derived figures");
  {
    ok("the default threshold is the decision doc's suggestion, as named parameters", DEFAULT_THRESHOLD.minAssetsFmvAmt === 1_000_000 && DEFAULT_THRESHOLD.minContributionsPaidPerBooksAmt === 100_000);
    const a = assessThreshold(p22, DEFAULT_THRESHOLD);
    ok("Servant's Heart meets it by both tests, and the figures used are returned", a.meets && a.byAssets && a.byGiving && a.assetsUsed === 17049161 && a.givingUsed === 911323);
    const small = parseFiling990PF(X22.replace(/<TotalAssetsEOYFMVAmt>\d+<\/TotalAssetsEOYFMVAmt>/, "<TotalAssetsEOYFMVAmt>500000</TotalAssetsEOYFMVAmt>").replace(/<ContriPaidRevAndExpnssAmt>\d+<\/ContriPaidRevAndExpnssAmt>/, "<ContriPaidRevAndExpnssAmt>20000</ContriPaidRevAndExpnssAmt>"));
    const s = assessThreshold(small, DEFAULT_THRESHOLD);
    ok("a $500,000 foundation giving $20,000 is below it", !s.meets && !s.byAssets && !s.byGiving);
    ok("giving alone can qualify, assets alone can qualify", assessThreshold(small, { minAssetsFmvAmt: 1e9, minContributionsPaidPerBooksAmt: 10_000 }).meets && assessThreshold(small, { minAssetsFmvAmt: 400_000, minContributionsPaidPerBooksAmt: 1e9 }).meets);
    const noAssets = parseFiling990PF(X22.replace(/<TotalAssetsEOYFMVAmt>\d+<\/TotalAssetsEOYFMVAmt>/, "").replace(/<FMVAssetsEOYAmt>\d+<\/FMVAssetsEOYAmt>/, ""));
    ok("assets not stated: null, and not read as zero in a way that hides it", assessThreshold(noAssets, DEFAULT_THRESHOLD).assetsUsed === null);

    const st = deriveGrantStats(p22.grantsPaid, "CA", p22.figures.grants_paid_stated_total_amt);
    ok("2022 grant stats: count 30, sum 911,322, stated gap 0", st.count === 30 && st.sum === 911322 && st.minusStated === 0);
    ok("average, smallest, largest", st.avg === 30377.4 && st.min === 100 && st.max === 220148);
    ok("the derivation names the set and the filing's own list", /Part XV/.test(st.derivation) && /funder_reference_grants/.test(st.derivation) && /30 row/.test(st.derivation));
    ok("home-state share counts only US rows in the filer's state", (st.inFilerStateCount ?? 0) > 0 && (st.inFilerStateCount ?? 0) < 30);
    const g = (amt: number | null, state = "CA") => ({ ...p22.grantsPaid[0], amountAmt: amt, address: { line1: null, line2: null, city: null, state, zip: null, country: null } });
    ok("median of an even count is the mean of the middle two; of an odd count the middle one", deriveGrantStats([g(1), g(2), g(10), g(100)], "CA", null).median === 6 && deriveGrantStats([g(1), g(2), g(10)], "CA", null).median === 2);
    const none = deriveGrantStats([], "CA", 500);
    ok("no listed grants: every derived value is null, never 0, and it says why", none.count === null && none.sum === null && none.avg === null && none.minusStated === null && /holds no row/.test(none.derivation));
    ok("rows with no amount are excluded and the derivation says so", /1 row\(s\) with no amount are excluded/.test(deriveGrantStats([g(5), g(null)], "CA", null).derivation));
    ok("a stated total with no listed rows leaves the gap unknown, not the whole total", none.minusStated === null);
    const pr = derivePayoutRatio(1104388, 841321);
    ok("payout ratio names both figures it used", pr.ratio === 1.3127 && /qualifying_distributions_amt \/ minimum_investment_return_amt/.test(pr.derivation ?? ""));
    ok("payout ratio is null when either figure is missing or the base is zero", derivePayoutRatio(null, 5).ratio === null && derivePayoutRatio(5, null).ratio === null && derivePayoutRatio(5, 0).ratio === null);
  }

  // --------------------------------------------------------------------- index
  section("IRS index reading");
  {
    ok("quoted commas and doubled quotes", parseCsvLine(`1,EFILE,123456789,202212,2023,"A, B ""C"" FOUNDATION",990PF,9,8`).join("|") === `1|EFILE|123456789|202212|2023|A, B "C" FOUNDATION|990PF|9|8`);
    const dir = mkdtempSync(join(tmpdir(), "idx-"));
    const f = join(dir, "index_2024.csv");
    writeFileSync(
      f,
      [
        "RETURN_ID,FILING_TYPE,EIN,TAX_PERIOD,SUB_DATE,TAXPAYER_NAME,RETURN_TYPE,DLN,OBJECT_ID,XML_BATCH_ID",
        "1,EFILE,582218044,202312,2024,\"SERVANT'S HEART, INC\",990PF,d1,202403209349107935,2024_TEOS_XML_11A",
        "2,EFILE,582218044,202312,2024,SERVANT'S HEART FOUNDATION INC,990T,d2,202443209339304634,2024_TEOS_XML_11A",
        "3,EFILE,12345678,202206,2024,SHORT EIN,990PF,d3,202400009349100001,",
        "4,EFILE,999999999,202212,2024,OTHER,990PF,d4,202400009349100002,2024_TEOS_XML_01A",
        "",
      ].join("\n")
    );
    const all = await readIndex(f, { returnType: "990PF", periodYears: [2022, 2023, 2024], eins: null });
    ok("only Form 990-PF rows in the requested period years", all.rows.length === 3 && all.totalRows === 4);
    ok("a quoted name with a comma survives; a blank batch id is null; EINs are padded to 9 digits", all.rows[0].taxpayerName === "SERVANT'S HEART, INC" && all.rows[0].batchId === "2024_TEOS_XML_11A" && all.rows[1].batchId === null);
    const one = await readIndex(f, { returnType: "990PF", periodYears: [2022, 2023, 2024], eins: ["012345678"] });
    ok("filter by EIN, with a leading zero restored", one.rows.length === 1 && one.rows[0].objectId === "202400009349100001");
    ok("a lower-case batch id in the index (as the real 2024 index has) is matched to the archive's real name", canonicalArchiveName("2024_TEOS_XML_05a") === "2024_TEOS_XML_05A" && canonicalArchiveName("2025_TEOS_XML_11b") === "2025_TEOS_XML_11B" && canonicalArchiveName("2024_TEOS_XML_05A") === "2024_TEOS_XML_05A");
    ok("an id that is no known archive is kept as written", canonicalArchiveName("something_else") === "something_else");
    writeFileSync(f, "RETURN_ID,FILING_TYPE,EIN,TAX_PERIOD,SUB_DATE,TAXPAYER_NAME,RETURN_TYPE,DLN,OBJECT_ID,XML_BATCH_ID\n1,EFILE,111111111,202401,2024,X,990PF,d,202400000000000001,2024_TEOS_XML_06a\n");
    const lc = await readIndex(f, { returnType: "990PF", periodYears: [2024], eins: null });
    ok("readIndex hands the loader the canonical archive name", lc.rows[0].batchId === "2024_TEOS_XML_06A");
    writeFileSync(f, "A,B\n1,2\n");
    ok("an index without the expected columns is refused", await rejects(() => readIndex(f, { returnType: "990PF", periodYears: [2024], eins: null }), /no EIN column/));
    rmSync(dir, { recursive: true });
  }

  // ------------------------------------------------------------- Supabase sink
  section("the Supabase sink: call shapes against a recording stub (NOT a live project)");
  {
    const calls: Array<{ op: string; table?: string; args?: unknown }> = [];
    let failNext: string | null = null;
    const chain = (table: string) => {
      const q: Record<string, unknown> = {};
      const done = (op: string) => (args?: unknown) => {
        calls.push({ op, table, args });
        return q;
      };
      Object.assign(q, {
        insert: (a: unknown) => { calls.push({ op: "insert", table, args: a }); return Promise.resolve({ error: failNext ? { message: failNext } : null }); },
        update: done("update"),
        delete: done("delete"),
        select: done("select"),
        eq: () => Promise.resolve({ error: null }),
        in: (_c: string, ids: string[]) => { calls.push({ op: "in", table, args: ids.length }); return Promise.resolve({ data: ids.map((id) => ({ object_id: id, status: "loaded", status_note: null, xml_sha256: "h", loader_version: "v" })), error: null }); },
      });
      return q;
    };
    const stub = {
      from: (t: string) => chain(t),
      rpc: (fn: string, args: Record<string, unknown>) => { calls.push({ op: "rpc", table: fn, args }); return Promise.resolve({ data: "loaded", error: failNext ? { message: failNext } : null }); },
    };
    const sk = supabaseSink(stub as never);
    const doc = { filing: { object_id: "202300000000000001", ein: "123456789" }, foundation: null, figures: null, people: [], grants: [], application: null };
    ok("applyFiling calls the one write function with the whole document and returns its answer", (await sk.applyFiling(doc)) === "loaded" && calls.some((c) => c.op === "rpc" && c.table === "funder_reference_apply_filing" && (c.args as { doc: unknown }).doc === doc));
    const ids = Array.from({ length: 400 }, (_, i) => String(i).padStart(18, "0"));
    const got = await sk.existingFilings(ids);
    ok("existingFilings reads in chunks of 150 (URL-length safe) and merges them", got.size === 400 && calls.filter((c) => c.op === "in").map((c) => c.args).join() === "150,150,100");
    failNext = "permission denied for function funder_reference_apply_filing";
    ok("a database error becomes a thrown error naming the filing, never a silent success", await rejects(() => sk.applyFiling(doc), /apply filing 202300000000000001: permission denied/));
    ok("a failed run start throws", await rejects(() => sk.startRun({ id: "x", loaderVersion: "v", parameters: {} }), /start run: permission denied/));
    failNext = null;
    calls.length = 0;
    await sk.replaceCoverage(["1", "2"], [{ ein: "1", period_year: 2022, status: "no_filing_in_index", filing_object_id: null, note: "n", run_id: "r", checked_at: "t" }]);
    ok("coverage is replaced for the EINs considered: delete (filtered to those EINs) first, then insert", calls.map((c) => c.op).join() === "delete,in,insert");
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  if (fail > 0) process.exit(1);
}

void InflateError;
void ZipError;
main().catch((e) => {
  console.error(e);
  process.exit(1);
});
