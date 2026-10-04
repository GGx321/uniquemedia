// A small, deterministic DEFLATE (RFC 1951) and zlib (RFC 1950) writer.
//
// Why it exists: the committed sticker files must be byte-identical to a fresh
// generation on every machine that runs the tests. `node:zlib` and ffmpeg's
// APNG muxer both compress with whatever zlib the runtime or the binary was
// built against (ffmpeg is 6.0 on macOS and 6.1.1 on Windows), so their bytes
// can differ by platform. This writer uses only integer arithmetic and fixed
// tie-breaking: the same input gives the same bytes anywhere.
//
// It is greedy LZ77 over a 32 KiB window (hash chains on 3 bytes) with dynamic
// Huffman blocks. It is not fast and not the smallest; it is reproducible.

const WINDOW = 32768;
const MIN_MATCH = 3;
const MAX_MATCH = 258;
const HASH_BITS = 15;
const MAX_CHAIN = 64;
const NICE_LENGTH = 160;
const BLOCK_TOKENS = 16384;

const LENGTH_BASE = [3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 15, 17, 19, 23, 27, 31, 35, 43, 51, 59, 67, 83, 99, 115, 131, 163, 195, 227, 258];
const LENGTH_EXTRA = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0];
const DIST_BASE = [1, 2, 3, 4, 5, 7, 9, 13, 17, 25, 33, 49, 65, 97, 129, 193, 257, 385, 513, 769, 1025, 1537, 2049, 3073, 4097, 6145, 8193, 12289, 16385, 24577];
const DIST_EXTRA = [0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13];
const CODE_LENGTH_ORDER = [16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15];

const LENGTH_CODE: Uint8Array = (() => {
  const table = new Uint8Array(MAX_MATCH + 1);
  for (let code = 0; code < LENGTH_BASE.length; code++) {
    const base = LENGTH_BASE[code] ?? 0;
    const top = code === LENGTH_BASE.length - 1 ? MAX_MATCH : (LENGTH_BASE[code + 1] ?? 0) - 1;
    for (let len = base; len <= top; len++) table[len] = code;
  }
  table[MAX_MATCH] = LENGTH_BASE.length - 1;
  return table;
})();

function distCode(distance: number): number {
  let code = 0;
  while (code + 1 < DIST_BASE.length && (DIST_BASE[code + 1] ?? Infinity) <= distance) code += 1;
  return code;
}

class BitWriter {
  private out = new Uint8Array(1024);
  private length = 0;
  private acc = 0;
  private accBits = 0;

  bits(value: number, count: number): void {
    this.acc |= value << this.accBits;
    this.accBits += count;
    while (this.accBits >= 8) {
      this.push(this.acc & 255);
      this.acc >>>= 8;
      this.accBits -= 8;
    }
  }

  private push(byte: number): void {
    if (this.length === this.out.length) {
      const grown = new Uint8Array(this.out.length * 2);
      grown.set(this.out);
      this.out = grown;
    }
    this.out[this.length] = byte;
    this.length += 1;
  }

  finish(): Uint8Array {
    if (this.accBits > 0) this.push(this.acc & 255);
    this.acc = 0;
    this.accBits = 0;
    return this.out.slice(0, this.length);
  }
}

interface Tokens {
  /** 0 for a literal, else the match length. */
  readonly len: Uint16Array;
  /** The literal byte, or the match distance. */
  readonly val: Uint16Array;
  count: number;
}

function lz77(data: Uint8Array): Tokens {
  const n = data.length;
  const tokens: Tokens = { len: new Uint16Array(n), val: new Uint16Array(n), count: 0 };
  const head = new Int32Array(1 << HASH_BITS).fill(-1);
  const prev = new Int32Array(WINDOW).fill(-1);
  const mask = WINDOW - 1;
  const hashAt = (i: number): number => (((data[i] ?? 0) << 10) ^ ((data[i + 1] ?? 0) << 5) ^ (data[i + 2] ?? 0)) & ((1 << HASH_BITS) - 1);
  const insert = (i: number): void => {
    if (i + MIN_MATCH > n) return;
    const h = hashAt(i);
    prev[i & mask] = head[h] ?? -1;
    head[h] = i;
  };

  let i = 0;
  while (i < n) {
    let bestLen = 0;
    let bestDist = 0;
    if (i + MIN_MATCH <= n) {
      const limit = Math.min(MAX_MATCH, n - i);
      let cand = head[hashAt(i)] ?? -1;
      let chain = MAX_CHAIN;
      while (cand >= 0 && i - cand <= WINDOW && chain > 0) {
        let l = 0;
        while (l < limit && data[cand + l] === data[i + l]) l += 1;
        if (l > bestLen) {
          bestLen = l;
          bestDist = i - cand;
          if (l >= NICE_LENGTH || l === limit) break;
        }
        const next = prev[cand & mask] ?? -1;
        if (next >= cand) break;
        cand = next;
        chain -= 1;
      }
    }
    if (bestLen >= MIN_MATCH) {
      tokens.len[tokens.count] = bestLen;
      tokens.val[tokens.count] = bestDist;
      tokens.count += 1;
      for (let k = 0; k < bestLen; k++) insert(i + k);
      i += bestLen;
    } else {
      tokens.len[tokens.count] = 0;
      tokens.val[tokens.count] = data[i] ?? 0;
      tokens.count += 1;
      insert(i);
      i += 1;
    }
  }
  return tokens;
}

/** Code lengths (0 = unused) for `freqs`, none above `maxLen`; ties broken by symbol index, so the result is unique. */
function huffmanLengths(freqs: readonly number[], maxLen: number): number[] {
  let work = freqs.slice();
  for (;;) {
    const lengths = new Array<number>(work.length).fill(0);
    interface Node {
      readonly weight: number;
      readonly order: number;
      readonly symbols: readonly number[];
    }
    let nodes: Node[] = [];
    work.forEach((w, s) => {
      if (w > 0) nodes.push({ weight: w, order: s, symbols: [s] });
    });
    if (nodes.length === 0) return lengths;
    if (nodes.length === 1) {
      lengths[nodes[0]?.symbols[0] ?? 0] = 1;
      return lengths;
    }
    let nextOrder = work.length;
    while (nodes.length > 1) {
      nodes.sort((a, b) => a.weight - b.weight || a.order - b.order);
      const a = nodes[0];
      const b = nodes[1];
      if (a === undefined || b === undefined) break;
      for (const s of a.symbols) lengths[s] = (lengths[s] ?? 0) + 1;
      for (const s of b.symbols) lengths[s] = (lengths[s] ?? 0) + 1;
      nodes = [...nodes.slice(2), { weight: a.weight + b.weight, order: nextOrder, symbols: [...a.symbols, ...b.symbols] }];
      nextOrder += 1;
    }
    if (Math.max(...lengths) <= maxLen) return lengths;
    work = work.map((w) => (w === 0 ? 0 : (w + 1) >> 1));
  }
}

/** Canonical codes for `lengths`, bit-reversed for a least-significant-bit-first writer. */
function canonicalCodes(lengths: readonly number[]): number[] {
  const maxLen = Math.max(0, ...lengths);
  const count = new Array<number>(maxLen + 2).fill(0);
  for (const l of lengths) if (l > 0) count[l] = (count[l] ?? 0) + 1;
  const next = new Array<number>(maxLen + 2).fill(0);
  let code = 0;
  for (let l = 1; l <= maxLen; l++) {
    code = (code + (count[l - 1] ?? 0)) << 1;
    next[l] = code;
  }
  return lengths.map((l) => {
    if (l === 0) return 0;
    const c = next[l] ?? 0;
    next[l] = c + 1;
    let reversed = 0;
    for (let b = 0; b < l; b++) reversed |= ((c >> b) & 1) << (l - 1 - b);
    return reversed;
  });
}

interface CodeLengthSymbol {
  readonly symbol: number;
  readonly extraBits: number;
  readonly extraValue: number;
}

function runLengthEncode(lengths: readonly number[]): CodeLengthSymbol[] {
  const out: CodeLengthSymbol[] = [];
  let i = 0;
  while (i < lengths.length) {
    const value = lengths[i] ?? 0;
    let run = 1;
    while (i + run < lengths.length && lengths[i + run] === value) run += 1;
    let left = run;
    if (value === 0) {
      while (left >= 11) {
        const take = Math.min(left, 138);
        out.push({ symbol: 18, extraBits: 7, extraValue: take - 11 });
        left -= take;
      }
      if (left >= 3) {
        out.push({ symbol: 17, extraBits: 3, extraValue: left - 3 });
        left = 0;
      }
      while (left > 0) {
        out.push({ symbol: 0, extraBits: 0, extraValue: 0 });
        left -= 1;
      }
    } else {
      out.push({ symbol: value, extraBits: 0, extraValue: 0 });
      left -= 1;
      while (left >= 3) {
        const take = Math.min(left, 6);
        out.push({ symbol: 16, extraBits: 2, extraValue: take - 3 });
        left -= take;
      }
      while (left > 0) {
        out.push({ symbol: value, extraBits: 0, extraValue: 0 });
        left -= 1;
      }
    }
    i += run;
  }
  return out;
}

function writeBlock(w: BitWriter, tokens: Tokens, from: number, to: number, final: boolean): void {
  const litFreq = new Array<number>(286).fill(0);
  const distFreq = new Array<number>(30).fill(0);
  for (let t = from; t < to; t++) {
    const len = tokens.len[t] ?? 0;
    if (len === 0) litFreq[tokens.val[t] ?? 0] = (litFreq[tokens.val[t] ?? 0] ?? 0) + 1;
    else {
      const lc = 257 + (LENGTH_CODE[len] ?? 0);
      litFreq[lc] = (litFreq[lc] ?? 0) + 1;
      const dc = distCode(tokens.val[t] ?? 1);
      distFreq[dc] = (distFreq[dc] ?? 0) + 1;
    }
  }
  litFreq[256] = 1;
  if (!distFreq.some((f) => f > 0)) distFreq[0] = 1;

  const litLengths = huffmanLengths(litFreq, 15);
  const distLengths = huffmanLengths(distFreq, 15);
  const litCodes = canonicalCodes(litLengths);
  const distCodes = canonicalCodes(distLengths);

  let hlit = 286;
  while (hlit > 257 && litLengths[hlit - 1] === 0) hlit -= 1;
  let hdist = 30;
  while (hdist > 1 && distLengths[hdist - 1] === 0) hdist -= 1;
  const rle = runLengthEncode([...litLengths.slice(0, hlit), ...distLengths.slice(0, hdist)]);
  const clFreq = new Array<number>(19).fill(0);
  for (const s of rle) clFreq[s.symbol] = (clFreq[s.symbol] ?? 0) + 1;
  const clLengths = huffmanLengths(clFreq, 7);
  const clCodes = canonicalCodes(clLengths);
  let hclen = 19;
  while (hclen > 4 && clLengths[CODE_LENGTH_ORDER[hclen - 1] ?? 0] === 0) hclen -= 1;

  w.bits(final ? 1 : 0, 1);
  w.bits(2, 2);
  w.bits(hlit - 257, 5);
  w.bits(hdist - 1, 5);
  w.bits(hclen - 4, 4);
  for (let k = 0; k < hclen; k++) w.bits(clLengths[CODE_LENGTH_ORDER[k] ?? 0] ?? 0, 3);
  for (const s of rle) {
    w.bits(clCodes[s.symbol] ?? 0, clLengths[s.symbol] ?? 0);
    if (s.extraBits > 0) w.bits(s.extraValue, s.extraBits);
  }
  for (let t = from; t < to; t++) {
    const len = tokens.len[t] ?? 0;
    const val = tokens.val[t] ?? 0;
    if (len === 0) {
      w.bits(litCodes[val] ?? 0, litLengths[val] ?? 0);
      continue;
    }
    const lc = LENGTH_CODE[len] ?? 0;
    w.bits(litCodes[257 + lc] ?? 0, litLengths[257 + lc] ?? 0);
    if ((LENGTH_EXTRA[lc] ?? 0) > 0) w.bits(len - (LENGTH_BASE[lc] ?? 0), LENGTH_EXTRA[lc] ?? 0);
    const dc = distCode(val);
    w.bits(distCodes[dc] ?? 0, distLengths[dc] ?? 0);
    if ((DIST_EXTRA[dc] ?? 0) > 0) w.bits(val - (DIST_BASE[dc] ?? 0), DIST_EXTRA[dc] ?? 0);
  }
  w.bits(litCodes[256] ?? 0, litLengths[256] ?? 0);
}

/** A raw DEFLATE stream of `data`. */
export function deflateRaw(data: Uint8Array): Uint8Array {
  const w = new BitWriter();
  if (data.length === 0) {
    // One final fixed-Huffman block holding only the end-of-block code.
    w.bits(1, 1);
    w.bits(1, 2);
    w.bits(0, 7);
    return w.finish();
  }
  const tokens = lz77(data);
  for (let from = 0; from < tokens.count; from += BLOCK_TOKENS) {
    const to = Math.min(tokens.count, from + BLOCK_TOKENS);
    writeBlock(w, tokens, from, to, to === tokens.count);
  }
  return w.finish();
}

function adler32(data: Uint8Array): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < data.length; ) {
    const end = Math.min(data.length, i + 5552);
    for (; i < end; i++) {
      a += data[i] ?? 0;
      b += a;
    }
    a %= 65521;
    b %= 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** A zlib stream (header, DEFLATE, Adler-32) of `data`. */
export function zlibCompress(data: Uint8Array): Uint8Array {
  const body = deflateRaw(data);
  const out = new Uint8Array(2 + body.length + 4);
  out[0] = 0x78;
  out[1] = 0xda;
  out.set(body, 2);
  const sum = adler32(data);
  out[out.length - 4] = (sum >>> 24) & 255;
  out[out.length - 3] = (sum >>> 16) & 255;
  out[out.length - 2] = (sum >>> 8) & 255;
  out[out.length - 1] = sum & 255;
  return out;
}
