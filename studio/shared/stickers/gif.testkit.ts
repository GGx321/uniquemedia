// Test support (3f.5): a deterministic GIF writer for the validator's and the importer's tests. Pure, no I/O, no randomness: a fixture is a
// function of its description, so a committed fixture can be regenerated and compared byte for byte.
//
// A frame's pixels are colour INDICES into a four-colour palette (minimum LZW code size 2). The LZW stream is real: it is encoded the
// way a decoder will read it (the code width grows with the table), so ffmpeg and the validator read the same pictures. The hostile
// shapes in the tests are built from the same pieces (`gifHeader`, `screen`, `gce`, `descriptor`, `lzw`, `subBlocks`...), so each piece
// can be wrong on its own.

export const concatBytes = (parts: readonly Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};

const ascii = (s: string): number[] => Array.from(s, (c) => c.charCodeAt(0));
const le16 = (n: number): number[] => [n & 255, (n >>> 8) & 255];

/** Four colours: red, green, blue, white (RGB). */
export const TEST_PALETTE: readonly number[] = [255, 0, 0, 0, 255, 0, 0, 0, 255, 255, 255, 255];

export const gifHeader = (version: "87a" | "89a" = "89a"): Uint8Array => Uint8Array.from(ascii(`GIF${version}`));

/** The logical screen descriptor, with a four-colour global table when `globalTable` is true (the table's bytes follow it). */
export function screen(width: number, height: number, globalTable = true): Uint8Array {
  // packed: global table flag, colour resolution 7, not sorted, table size 2 (4 entries)
  const packed = globalTable ? 0b1111_0001 : 0b0111_0000;
  return Uint8Array.from([...le16(width), ...le16(height), packed, 0, 0, ...(globalTable ? TEST_PALETTE : [])]);
}

/** Splits `data` into sub-blocks of at most `size` bytes with the zero terminator. */
export function subBlocks(data: Uint8Array, size = 255): Uint8Array {
  const parts: number[] = [];
  for (let at = 0; at < data.length; at += size) {
    const piece = data.subarray(at, at + size);
    parts.push(piece.length, ...piece);
  }
  parts.push(0);
  return Uint8Array.from(parts);
}

/** A graphic control extension: delay in centiseconds, disposal 0..7, a transparent colour index or null. */
export function gce(delayCs: number, disposal = 0, transparent: number | null = null): Uint8Array {
  const packed = ((disposal & 7) << 2) | (transparent === null ? 0 : 1);
  return Uint8Array.from([0x21, 0xf9, 4, packed, ...le16(delayCs), transparent ?? 0, 0]);
}

/** The NETSCAPE2.0 looping extension; `count` 0 is forever. */
export function netscape(count: number, id = "NETSCAPE2.0"): Uint8Array {
  return Uint8Array.from([0x21, 0xff, 11, ...ascii(id), 3, 1, ...le16(count), 0]);
}

export const comment = (text: string): Uint8Array => Uint8Array.from([0x21, 0xfe, ...subBlocks(Uint8Array.from(ascii(text)))]);

/** An image descriptor with no local table, followed by nothing: the caller appends the minimum code size and the data. */
export function descriptor(x: number, y: number, width: number, height: number, interlaced = false): Uint8Array {
  return Uint8Array.from([0x2c, ...le16(x), ...le16(y), ...le16(width), ...le16(height), interlaced ? 0x40 : 0]);
}

export const TRAILER = Uint8Array.of(0x3b);

/**
 * A valid LZW stream (LSB-first codes, a clear code first, an end code last) for `indices`, written as a decoder will read it. The table
 * is reset before it fills, so the code width stays within 12 bits.
 */
export function lzw(indices: ArrayLike<number>, minCodeSize = 2): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  const put = (code: number, width: number): void => {
    acc |= code << bits;
    bits += width;
    while (bits >= 8) {
      out.push(acc & 255);
      acc >>>= 8;
      bits -= 8;
    }
  };
  let width = minCodeSize + 1;
  let next = eoi + 1;
  let first = true;
  put(clear, width);
  for (let i = 0; i < indices.length; i++) {
    put(indices[i] ?? 0, width);
    // The decoder adds a table entry for every code after the first one that follows a clear.
    if (first) {
      first = false;
    } else {
      next += 1;
      if (next === 1 << width && width < 12) width += 1;
    }
    if (next >= 4093) {
      put(clear, width);
      width = minCodeSize + 1;
      next = eoi + 1;
      first = true;
    }
  }
  put(eoi, width);
  if (bits > 0) out.push(acc & 255);
  return Uint8Array.from(out);
}

/**
 * A COMPRESSING LZW encoder (a dictionary of strings, as a real GIF writer has): the same stream shape as `lzw` (a clear code first, an end code
 * last, the width growing with the table as a decoder reads it, the table cleared before it fills) but a flat frame is a few KB, not as big as the
 * picture. For the fixtures that must stay within a sticker's 5 MB cap at the largest size (a 720 x 720 GIF of 300 frames).
 */
export function lzwCompress(indices: ArrayLike<number>, minCodeSize = 2): Uint8Array {
  const clear = 1 << minCodeSize;
  const eoi = clear + 1;
  const out: number[] = [];
  let acc = 0;
  let bits = 0;
  const put = (code: number, width: number): void => {
    acc |= code << bits;
    bits += width;
    while (bits >= 8) {
      out.push(acc & 255);
      acc >>>= 8;
      bits -= 8;
    }
  };
  // The decoder's own state, which is what the width of each code follows: it adds one entry per code after the first that follows a clear.
  let width = minCodeSize + 1;
  let decoderNext = eoi + 1;
  let first = true;
  // The encoder's dictionary: (prefix code, next symbol) to the code of that string.
  let dictionary = new Map<number, number>();
  let encoderNext = eoi + 1;
  const emit = (code: number): void => {
    put(code, width);
    if (first) {
      first = false;
    } else {
      decoderNext += 1;
      if (decoderNext === 1 << width && width < 12) width += 1;
    }
  };
  const restart = (): void => {
    put(clear, width);
    width = minCodeSize + 1;
    decoderNext = eoi + 1;
    first = true;
    dictionary = new Map();
    encoderNext = eoi + 1;
  };
  put(clear, width);
  if (indices.length === 0) {
    put(eoi, width);
    if (bits > 0) out.push(acc & 255);
    return Uint8Array.from(out);
  }
  let prefix = indices[0] ?? 0;
  for (let i = 1; i < indices.length; i++) {
    const symbol = indices[i] ?? 0;
    const known = dictionary.get((prefix << 8) | symbol);
    if (known !== undefined) {
      prefix = known;
      continue;
    }
    emit(prefix);
    dictionary.set((prefix << 8) | symbol, encoderNext);
    encoderNext += 1;
    prefix = symbol;
    if (decoderNext >= 4093) restart();
  }
  emit(prefix);
  put(eoi, width);
  if (bits > 0) out.push(acc & 255);
  return Uint8Array.from(out);
}

export interface TestGifFrame {
  /** Centiseconds as written; `null` writes no graphic control extension at all. Default 3. */
  readonly delayCs?: number | null;
  readonly x?: number;
  readonly y?: number;
  readonly width?: number;
  readonly height?: number;
  readonly disposal?: number;
  readonly transparent?: number | null;
  readonly interlaced?: boolean;
  /** Palette indices (0..3), `width * height` of them. Default: a flat fill that depends on the frame's place, so frames differ. */
  readonly indices?: ArrayLike<number>;
  /** The minimum LZW code size byte, when it should differ from the 2 the stream is written for. */
  readonly minCodeSize?: number;
  /** The image data as it goes on the wire (a hostile stream); replaces the encoded one. */
  readonly rawData?: Uint8Array;
  /** Write the pixels with the compressing encoder (`lzwCompress`) instead of the literal-only one. */
  readonly compress?: boolean;
}

export interface TestGif {
  readonly width?: number;
  readonly height?: number;
  readonly frames: readonly TestGifFrame[];
  /** The loop count of a NETSCAPE2.0 block; `null` writes none. Default 0 (forever). */
  readonly loop?: number | null;
  readonly version?: "87a" | "89a";
  readonly omitTrailer?: boolean;
  readonly trailing?: Uint8Array;
  /** Bytes written between the logical screen and the first frame (extensions, hostile or not). */
  readonly early?: readonly Uint8Array[];
}

/** A whole GIF. */
export function buildGif(spec: TestGif): Uint8Array {
  const width = spec.width ?? 8;
  const height = spec.height ?? 8;
  const parts: Uint8Array[] = [gifHeader(spec.version ?? "89a"), screen(width, height)];
  const loop = spec.loop === undefined ? 0 : spec.loop;
  if (loop !== null) parts.push(netscape(loop));
  parts.push(...(spec.early ?? []));
  spec.frames.forEach((frame, i) => {
    const w = frame.width ?? width;
    const h = frame.height ?? height;
    const delay = frame.delayCs === undefined ? 3 : frame.delayCs;
    if (delay !== null) parts.push(gce(delay, frame.disposal ?? 0, frame.transparent ?? null));
    parts.push(descriptor(frame.x ?? 0, frame.y ?? 0, w, h, frame.interlaced ?? false));
    parts.push(Uint8Array.of(frame.minCodeSize ?? 2));
    const indices = frame.indices ?? Array.from({ length: w * h }, (_, p) => (i + (p % 5 === 0 ? 1 : 0)) % 4);
    parts.push(subBlocks(frame.rawData ?? (frame.compress === true ? lzwCompress(indices) : lzw(indices))));
  });
  if (!spec.omitTrailer) parts.push(TRAILER);
  if (spec.trailing !== undefined) parts.push(spec.trailing);
  return concatBytes(parts);
}

/** `count` frames that each last `delayCs`; every frame is a different picture. */
export const framesOf = (count: number, delayCs = 3): TestGifFrame[] => Array.from({ length: count }, () => ({ delayCs }));
