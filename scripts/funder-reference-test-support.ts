// Item 110: test helpers for the funder-reference suites -- a ZIP writer that can
// produce the shapes the IRS archives actually have (ZIP64, bytes before the
// archive, Deflate64 members, members in a folder or at the top level) and the
// shapes that break readers (a wrong CRC, an unsupported method).

import { crc32, deflateRawSync } from "node:zlib";

export interface ZipItem {
  name: string;
  data: Uint8Array; // the uncompressed bytes (used for size and CRC unless overridden)
  method?: 0 | 8 | 9 | 99;
  /** For method 9 (or any pre-compressed member): the bytes to store as they are. */
  precompressed?: Uint8Array;
  /** Record a wrong CRC-32 for this member. */
  wrongCrc?: boolean;
}

export interface ZipOptions {
  zip64?: boolean;
  /** Bytes placed before the archive; recorded offsets ignore them, as in a concatenated archive. */
  prefixBytes?: number;
}

const le = (n: number, bytes: number): Buffer => {
  const b = Buffer.alloc(bytes);
  if (bytes === 8) b.writeBigUInt64LE(BigInt(n));
  else if (bytes === 4) b.writeUInt32LE(n >>> 0);
  else b.writeUInt16LE(n);
  return b;
};

export function makeZip(items: ZipItem[], opts: ZipOptions = {}): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const it of items) {
    const method = it.method ?? 8;
    const body = it.precompressed ? Buffer.from(it.precompressed) : method === 0 ? Buffer.from(it.data) : method === 8 ? deflateRawSync(it.data) : Buffer.from(it.data);
    const crc = (crc32(it.data) ^ (it.wrongCrc ? 0xdeadbeef : 0)) >>> 0;
    const name = Buffer.from(it.name);
    const local = Buffer.concat([le(0x04034b50, 4), le(20, 2), le(0, 2), le(method, 2), le(0, 2), le(0x21, 2), le(crc, 4), le(body.length, 4), le(it.data.length, 4), le(name.length, 2), le(0, 2), name]);
    parts.push(local, body);
    const z64 = opts.zip64
      ? Buffer.concat([le(0x0001, 2), le(24, 2), le(it.data.length, 8), le(body.length, 8), le(offset, 8)])
      : Buffer.alloc(0);
    central.push(
      Buffer.concat([
        le(0x02014b50, 4), le(45, 2), le(45, 2), le(0, 2), le(method, 2), le(0, 2), le(0x21, 2), le(crc, 4),
        le(opts.zip64 ? 0xffffffff : body.length, 4), le(opts.zip64 ? 0xffffffff : it.data.length, 4),
        le(name.length, 2), le(z64.length, 2), le(0, 2), le(0, 2), le(0, 2), le(0, 4),
        le(opts.zip64 ? 0xffffffff : offset, 4), name, z64,
      ])
    );
    offset += local.length + body.length;
  }
  const cd = Buffer.concat(central);
  const cdOffset = offset;
  const out: Buffer[] = [...parts, cd];
  if (opts.zip64) {
    const z64EocdAt = cdOffset + cd.length;
    out.push(
      Buffer.concat([le(0x06064b50, 4), le(44, 8), le(45, 2), le(45, 2), le(0, 4), le(0, 4), le(items.length, 8), le(items.length, 8), le(cd.length, 8), le(cdOffset, 8)]),
      Buffer.concat([le(0x07064b50, 4), le(0, 4), le(z64EocdAt, 8), le(1, 4)]),
      Buffer.concat([le(0x06054b50, 4), le(0, 2), le(0, 2), le(0xffff, 2), le(0xffff, 2), le(0xffffffff, 4), le(0xffffffff, 4), le(0, 2)])
    );
  } else {
    out.push(Buffer.concat([le(0x06054b50, 4), le(0, 2), le(0, 2), le(items.length, 2), le(items.length, 2), le(cd.length, 4), le(cdOffset, 4), le(0, 2)]));
  }
  const body = Buffer.concat(out);
  return opts.prefixBytes ? Buffer.concat([Buffer.alloc(opts.prefixBytes, 0x41), body]) : body;
}
