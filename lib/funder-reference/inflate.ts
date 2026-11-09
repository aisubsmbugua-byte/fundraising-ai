// Item 110 (ruling 0045): an inflater that reads both Deflate and Deflate64.
//
// WHY THIS EXISTS. Some of the IRS's monthly return archives (observed:
// 2025_TEOS_XML_11B) store their members with ZIP method 9, Deflate64. Node's
// zlib reads only plain Deflate (method 8), and neither Python's zipfile nor the
// macOS `unzip` and `bsdtar` read these archives (checked 2026-11-06: Python
// raises NotImplementedError "That compression method is not supported";
// `unzip` and `bsdtar` report a damaged archive). A loader that skipped them
// would drop whole months of filings, so it reads them itself.
//
// SHAPE. This follows the structure of zlib's reference `puff.c` (canonical
// Huffman decoding by code length counts), with the three Deflate64 changes:
//   1. length code 285 means "3 + 16 extra bits" instead of "258";
//   2. distance codes 30 and 31 are valid (base 32769 and 49153, 14 extra bits);
//   3. the window is 64 KiB (immaterial here: the whole output is kept).
// Plain Deflate (method 8) is the same code with deflate64 = false; the unit
// test compares it with node:zlib on real data so a mistake in the shared part
// shows up there, and Deflate64 output is checked against the CRC-32 that every
// ZIP entry carries.

export class InflateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InflateError";
  }
}

const MAXBITS = 15;

interface Huffman {
  count: Uint16Array; // number of codes of each length
  symbol: Uint16Array; // symbols ordered by code
}

function buildHuffman(lengths: ArrayLike<number>, n: number): Huffman {
  const count = new Uint16Array(MAXBITS + 1);
  for (let s = 0; s < n; s++) count[lengths[s]]++;
  const symbol = new Uint16Array(n);
  const offs = new Uint16Array(MAXBITS + 2);
  for (let l = 1; l <= MAXBITS; l++) offs[l + 1] = offs[l] + count[l];
  for (let s = 0; s < n; s++) if (lengths[s] !== 0) symbol[offs[lengths[s]]++] = s;
  return { count, symbol };
}

const LBASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LEXT = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DBASE = [
  1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577,
  32769, 49153,
];
const DEXT = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 14, 14];
const CLEN_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

let FIXED: { lit: Huffman; dist: Huffman } | null = null;
function fixedTables() {
  if (FIXED) return FIXED;
  const l = new Uint8Array(288);
  for (let i = 0; i < 144; i++) l[i] = 8;
  for (let i = 144; i < 256; i++) l[i] = 9;
  for (let i = 256; i < 280; i++) l[i] = 7;
  for (let i = 280; i < 288; i++) l[i] = 8;
  const d = new Uint8Array(32).fill(5);
  FIXED = { lit: buildHuffman(l, 288), dist: buildHuffman(d, 32) };
  return FIXED;
}

export interface InflateOptions {
  /** true for ZIP method 9. */
  deflate64?: boolean;
  /** Exact size the entry declares; used to allocate once and to check at the end. */
  expectedSize?: number;
  /** Stop once at least this many bytes are produced and return the prefix (a partial read). */
  maxOutput?: number;
}

export function inflate(input: Uint8Array, opts: InflateOptions = {}): Uint8Array {
  const deflate64 = opts.deflate64 === true;
  const maxOut = opts.maxOutput ?? Infinity;
  let out = new Uint8Array(Math.min(opts.expectedSize ?? Math.max(input.length * 6, 1024), 1 << 30));
  let outLen = 0;
  let pos = 0; // input byte position
  let bitBuf = 0;
  let bitCnt = 0;

  const ensure = (extra: number) => {
    if (outLen + extra <= out.length) return;
    let cap = out.length * 2;
    while (cap < outLen + extra) cap *= 2;
    const bigger = new Uint8Array(cap);
    bigger.set(out.subarray(0, outLen));
    out = bigger;
  };

  const bits = (need: number): number => {
    // need <= 16
    while (bitCnt < need) {
      if (pos >= input.length) throw new InflateError("ran out of input");
      bitBuf |= input[pos++] << bitCnt;
      bitCnt += 8;
    }
    const v = bitBuf & ((1 << need) - 1);
    bitBuf >>>= need;
    bitCnt -= need;
    return v;
  };

  const decode = (h: Huffman): number => {
    let code = 0;
    let first = 0;
    let index = 0;
    for (let len = 1; len <= MAXBITS; len++) {
      code |= bits(1);
      const c = h.count[len];
      if (code - c < first) return h.symbol[index + (code - first)];
      index += c;
      first += c;
      first <<= 1;
      code <<= 1;
    }
    throw new InflateError("invalid Huffman code");
  };

  const codes = (lit: Huffman, dist: Huffman): boolean => {
    for (;;) {
      let sym = decode(lit);
      if (sym < 256) {
        ensure(1);
        out[outLen++] = sym;
        if (outLen >= maxOut) return true;
      } else if (sym === 256) {
        return false;
      } else {
        sym -= 257;
        if (sym >= 29) throw new InflateError("invalid length symbol");
        let len: number;
        if (sym === 28 && deflate64) len = 3 + bits(16);
        else len = LBASE[sym] + bits(LEXT[sym]);
        const ds = decode(dist);
        if (ds >= (deflate64 ? 32 : 30)) throw new InflateError("invalid distance symbol");
        const d = DBASE[ds] + bits(DEXT[ds]);
        if (d > outLen) throw new InflateError("distance reaches before the start of the output");
        ensure(len);
        for (let k = 0; k < len; k++) {
          out[outLen] = out[outLen - d];
          outLen++;
        }
        if (outLen >= maxOut) return true;
      }
    }
  };

  let stopped = false;
  let last = 0;
  do {
    last = bits(1);
    const type = bits(2);
    if (type === 0) {
      bitBuf = 0;
      bitCnt = 0; // discard the rest of the byte
      if (pos + 4 > input.length) throw new InflateError("ran out of input");
      const len = input[pos] | (input[pos + 1] << 8);
      const nlen = input[pos + 2] | (input[pos + 3] << 8);
      if ((len ^ 0xffff) !== nlen) throw new InflateError("stored block length check failed");
      pos += 4;
      if (pos + len > input.length) throw new InflateError("ran out of input");
      ensure(len);
      out.set(input.subarray(pos, pos + len), outLen);
      outLen += len;
      pos += len;
      if (outLen >= maxOut) stopped = true;
    } else if (type === 1) {
      const f = fixedTables();
      stopped = codes(f.lit, f.dist);
    } else if (type === 2) {
      const nlen = bits(5) + 257;
      const ndist = bits(5) + 1;
      const ncode = bits(4) + 4;
      if (nlen > 286 || ndist > (deflate64 ? 32 : 30)) throw new InflateError("bad dynamic block counts");
      const lengths = new Uint8Array(320);
      for (let i = 0; i < ncode; i++) lengths[CLEN_ORDER[i]] = bits(3);
      const clen = buildHuffman(lengths.subarray(0, 19), 19);
      const lens = new Uint8Array(nlen + ndist);
      let idx = 0;
      while (idx < nlen + ndist) {
        const sym = decode(clen);
        if (sym < 16) {
          lens[idx++] = sym;
        } else {
          let prev = 0;
          let rep: number;
          if (sym === 16) {
            if (idx === 0) throw new InflateError("repeat with no previous length");
            prev = lens[idx - 1];
            rep = 3 + bits(2);
          } else if (sym === 17) rep = 3 + bits(3);
          else rep = 11 + bits(7);
          if (idx + rep > nlen + ndist) throw new InflateError("too many code lengths");
          while (rep--) lens[idx++] = prev;
        }
      }
      if (lens[256] === 0) throw new InflateError("no end-of-block code");
      const lit = buildHuffman(lens.subarray(0, nlen), nlen);
      const dist = buildHuffman(lens.subarray(nlen), ndist);
      stopped = codes(lit, dist);
    } else {
      throw new InflateError("invalid block type");
    }
    if (stopped) break;
  } while (!last);

  if (!stopped && opts.expectedSize !== undefined && outLen !== opts.expectedSize) {
    throw new InflateError(`produced ${outLen} bytes, entry declares ${opts.expectedSize}`);
  }
  return out.subarray(0, outLen);
}
