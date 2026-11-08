// Item 110 (ruling 0045): a random-access reader for the IRS's monthly return
// archives.
//
// WHY NOT `unzip`. Checked 2026-11-06 against 2025_TEOS_XML_11B.zip (80,283
// members, ZIP64, Deflate64 members, 76 stray bytes before the archive proper):
// macOS `unzip` and `bsdtar` both call it damaged, and Python's zipfile cannot
// decompress its members. This reader handles all four properties, reads only
// the bytes it needs (the central directory, then one member at a time) from a
// local file or from an HTTP server that honours Range, and checks every full
// member against the CRC-32 the archive records for it.

import { open as fsOpen } from "node:fs/promises";
import { crc32, inflateRawSync, constants as zc } from "node:zlib";
import { inflate } from "./inflate";

export interface ByteSource {
  readonly label: string; // where the bytes live; recorded as the document location
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close?(): Promise<void>;
}

export async function fileSource(path: string): Promise<ByteSource> {
  const fh = await fsOpen(path, "r");
  const size = (await fh.stat()).size;
  return {
    label: path,
    size,
    async read(offset, length) {
      const len = Math.max(0, Math.min(length, size - offset));
      const buf = Buffer.allocUnsafe(len);
      let got = 0;
      while (got < len) {
        const { bytesRead } = await fh.read(buf, got, len - got, offset + got);
        if (bytesRead === 0) throw new Error(`short read from ${path} at ${offset + got}`);
        got += bytesRead;
      }
      return buf;
    },
    close: () => fh.close(),
  };
}

/** An HTTP(S) resource read with Range requests. Retries transient failures. */
export async function httpSource(url: string, userAgent: string): Promise<ByteSource> {
  const head = await fetchRetry(url, { method: "HEAD", headers: { "user-agent": userAgent } });
  const size = Number(head.headers.get("content-length"));
  if (!Number.isFinite(size) || size <= 0) throw new Error(`${url}: no content-length`);
  if ((head.headers.get("accept-ranges") ?? "").toLowerCase() !== "bytes") throw new Error(`${url}: server does not advertise byte ranges`);
  return {
    label: url,
    size,
    async read(offset, length) {
      const len = Math.max(0, Math.min(length, size - offset));
      if (len === 0) return new Uint8Array(0);
      const res = await fetchRetry(url, {
        headers: { "user-agent": userAgent, range: `bytes=${offset}-${offset + len - 1}` },
      });
      if (res.status !== 206) throw new Error(`${url}: expected 206 for a range read, got ${res.status}`);
      const b = new Uint8Array(await res.arrayBuffer());
      if (b.length !== len) throw new Error(`${url}: asked for ${len} bytes at ${offset}, got ${b.length}`);
      return b;
    },
  };
}

async function fetchRetry(url: string, init: RequestInit, tries = 5): Promise<Response> {
  let last: unknown;
  for (let k = 0; k < tries; k++) {
    try {
      const res = await fetch(url, init);
      if (res.status >= 500 || res.status === 429) throw new Error(`HTTP ${res.status}`);
      if (!res.ok) throw new Error(`${url}: HTTP ${res.status}`);
      return res;
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, 500 * 2 ** k));
    }
  }
  throw new Error(`${url}: ${(last as Error)?.message ?? last}`);
}

export interface ZipEntry {
  name: string;
  method: number; // 0 stored, 8 deflate, 9 deflate64
  crc32: number;
  compressedSize: number;
  size: number;
  localHeaderOffset: number; // already corrected for any bytes before the archive
}

export class ZipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ZipError";
  }
}

const u16 = (b: Uint8Array, o: number) => b[o] | (b[o + 1] << 8);
const u32 = (b: Uint8Array, o: number) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
const u64 = (b: Uint8Array, o: number) => u32(b, o) + u32(b, o + 4) * 2 ** 32;

export class ZipArchive {
  constructor(
    readonly source: ByteSource,
    readonly entries: ZipEntry[],
    private readonly byName: Map<string, ZipEntry>,
    readonly prefixBytes: number
  ) {}

  find(name: string): ZipEntry | undefined {
    return this.byName.get(name);
  }

  private byBase: Map<string, ZipEntry> | null = null;
  /**
   * The member for an IRS OBJECT_ID. Archives differ in whether members sit in a
   * folder (2023_TEOS_XML_11A/…) or at the top level (2025_TEOS_XML_11B), so the
   * lookup is by file name alone.
   */
  findObject(objectId: string): ZipEntry | undefined {
    if (!this.byBase) {
      this.byBase = new Map();
      for (const e of this.entries) this.byBase.set(e.name.slice(e.name.lastIndexOf("/") + 1), e);
    }
    return this.byBase.get(`${objectId}_public.xml`);
  }

  private async dataStart(e: ZipEntry): Promise<number> {
    const h = await this.source.read(e.localHeaderOffset, 30);
    if (h.length < 30 || u32(h, 0) !== 0x04034b50) throw new ZipError(`${e.name}: no local header at ${e.localHeaderOffset}`);
    return e.localHeaderOffset + 30 + u16(h, 26) + u16(h, 28);
  }

  /** Whole member, decompressed and checked against its recorded CRC-32 and size. */
  async read(e: ZipEntry): Promise<Uint8Array> {
    const start = await this.dataStart(e);
    const raw = await this.source.read(start, e.compressedSize);
    let out: Uint8Array;
    if (e.method === 0) out = raw;
    else if (e.method === 8) out = inflateRawSync(raw);
    else if (e.method === 9) out = inflate(raw, { deflate64: true, expectedSize: e.size });
    else throw new ZipError(`${e.name}: compression method ${e.method} is not supported`);
    if (out.length !== e.size) throw new ZipError(`${e.name}: decompressed to ${out.length} bytes, archive records ${e.size}`);
    const c = crc32(out);
    if (c !== e.crc32) throw new ZipError(`${e.name}: CRC-32 ${c.toString(16)} does not match the archive's ${e.crc32.toString(16)}`);
    return out;
  }

  /**
   * The first `want` bytes (or a little more) of a member, without reading all of
   * it and WITHOUT the CRC check (a prefix cannot be checked against a whole-file
   * CRC). Used only to look at a return's header; anything kept is read whole.
   */
  async readPrefix(e: ZipEntry, want: number): Promise<Uint8Array> {
    if (e.size <= want) return this.read(e);
    const start = await this.dataStart(e);
    if (e.method === 0) return this.source.read(start, want);
    if (e.method === 9) {
      // Deflate64 cannot be cut at an arbitrary byte, but a prefix of the compressed
      // stream decodes up to the cut; ask for generous compressed input.
      const take = Math.min(e.compressedSize, Math.max(4096, want));
      const raw = await this.source.read(start, take);
      return inflate(raw, { deflate64: true, maxOutput: want, expectedSize: undefined });
    }
    if (e.method !== 8) throw new ZipError(`${e.name}: compression method ${e.method} is not supported`);
    for (let take = Math.min(e.compressedSize, Math.max(2048, Math.ceil(want / 4))); ; take = Math.min(e.compressedSize, take * 4)) {
      const raw = await this.source.read(start, take);
      // Z_SYNC_FLUSH lets zlib hand back what it could decode from a truncated stream.
      const out = inflateRawSync(raw, { finishFlush: zc.Z_SYNC_FLUSH });
      if (out.length >= want || take >= e.compressedSize) return out;
    }
  }

  async close() {
    await this.source.close?.();
  }
}

/** Opens an archive; if it cannot be opened the source is closed, never leaked. */
export async function openZip(source: ByteSource): Promise<ZipArchive> {
  try {
    return await openZipInner(source);
  } catch (e) {
    await source.close?.();
    throw e;
  }
}

async function openZipInner(source: ByteSource): Promise<ZipArchive> {
  const tailLen = Math.min(source.size, 65_535 + 22 + 20 + 56 + 64);
  const tailStart = source.size - tailLen;
  const tail = await source.read(tailStart, tailLen);

  let eocd = -1;
  for (let i = tail.length - 22; i >= 0; i--) {
    if (u32(tail, i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0) throw new ZipError(`${source.label}: no end-of-central-directory record`);

  let total = u16(tail, eocd + 10);
  let cdSize = u32(tail, eocd + 12);
  let cdOffset = u32(tail, eocd + 16);
  let cdEndAbs = tailStart + eocd; // absolute position where the central directory ends
  const needsZip64 = total === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff;
  const loc = eocd - 20;
  if (loc >= 0 && u32(tail, loc) === 0x07064b50) {
    const z64Abs = u64(tail, loc + 8);
    // The record is normally 56 bytes immediately before the locator, but if bytes
    // were prepended its recorded offset is off; read it from where it sits.
    const recAbs = tailStart + loc - 56;
    const recRel = recAbs - tailStart;
    if (recRel >= 0 && u32(tail, recRel) === 0x06064b50) {
      total = u64(tail, recRel + 32);
      cdSize = u64(tail, recRel + 40);
      cdOffset = u64(tail, recRel + 48);
      cdEndAbs = recAbs;
    } else if (needsZip64) {
      throw new ZipError(`${source.label}: ZIP64 record not where expected (locator points at ${z64Abs})`);
    }
  } else if (needsZip64) {
    throw new ZipError(`${source.label}: ZIP64 values present but no ZIP64 locator`);
  }

  // The central directory sits immediately before the (zip64) end record, so its
  // true start gives how many bytes precede the archive proper.
  const cdStartAbs = cdEndAbs - cdSize;
  const prefix = cdStartAbs - cdOffset;
  if (prefix < 0) throw new ZipError(`${source.label}: central directory offset is inconsistent`);

  const cd = await source.read(cdStartAbs, cdSize);
  const entries: ZipEntry[] = [];
  const byName = new Map<string, ZipEntry>();
  let p = 0;
  const dec = new TextDecoder("utf-8");
  for (let k = 0; k < total; k++) {
    if (p + 46 > cd.length || u32(cd, p) !== 0x02014b50) throw new ZipError(`${source.label}: bad central directory entry ${k}`);
    const flags = u16(cd, p + 8);
    const method = u16(cd, p + 10);
    const crc = u32(cd, p + 16);
    let csize = u32(cd, p + 20);
    let size = u32(cd, p + 24);
    const nlen = u16(cd, p + 28);
    const xlen = u16(cd, p + 30);
    const clen = u16(cd, p + 32);
    let lho = u32(cd, p + 42);
    const name = dec.decode(cd.subarray(p + 46, p + 46 + nlen));
    void flags;
    // ZIP64 extended information, in the order the spec fixes: size, csize, offset.
    let x = p + 46 + nlen;
    const xend = x + xlen;
    while (x + 4 <= xend) {
      const id = u16(cd, x);
      const len = u16(cd, x + 2);
      if (id === 0x0001) {
        let o = x + 4;
        if (size === 0xffffffff) {
          size = u64(cd, o);
          o += 8;
        }
        if (csize === 0xffffffff) {
          csize = u64(cd, o);
          o += 8;
        }
        if (lho === 0xffffffff) {
          lho = u64(cd, o);
          o += 8;
        }
      }
      x += 4 + len;
    }
    const e: ZipEntry = { name, method, crc32: crc, compressedSize: csize, size, localHeaderOffset: lho + prefix };
    entries.push(e);
    byName.set(name, e);
    p += 46 + nlen + xlen + clen;
  }
  return new ZipArchive(source, entries, byName, prefix);
}
