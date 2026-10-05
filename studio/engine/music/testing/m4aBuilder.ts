/**
 * Test-only: builds the smallest MP4 the track probe reads (`ftyp`, then a `moov` holding one `trak` down to the sample
 * entry), with every field a test may want to break. It carries no audio, so nothing decodes it: a test that needs real
 * audio uses the 3c.1 fixtures, and one that needs a hostile or malformed container builds it here. Production code never
 * imports this file (it lives under `testing/`, which the purity guard and the bundle check keep out).
 */

const u8 = (...values: number[]): Uint8Array => Uint8Array.from(values);

export function u32(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

export function u16(value: number): Uint8Array {
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

const ascii = (text: string): Uint8Array => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));

/** A box: a 32-bit size, a four-char type, the payload. `size` overrides the honest size (a lying header). */
export function box(type: string, payload: Uint8Array = new Uint8Array(0), size?: number): Uint8Array {
  return concat(u32(size ?? 8 + payload.byteLength), ascii(type), payload);
}

/** A box with a 64-bit `largesize` header. */
export function largeBox(type: string, payload: Uint8Array, largesize: bigint): Uint8Array {
  const big = new Uint8Array(8);
  new DataView(big.buffer).setBigUint64(0, largesize);
  return concat(u32(1), ascii(type), big, payload);
}

/** A full box: a version byte and 24 bits of flags before the payload. */
export function fullBox(type: string, flags: number, payload: Uint8Array = new Uint8Array(0), version = 0): Uint8Array {
  return box(type, concat(u8(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), payload));
}

/** An MPEG-4 descriptor: a tag and a length in the one-to-four-byte form. */
function descriptor(tag: number, payload: Uint8Array): Uint8Array {
  const length = payload.byteLength;
  const bytes = length < 128 ? [length] : [0x80 | (length >> 7), length & 0x7f];
  return concat(u8(tag, ...bytes), payload);
}

/** The bits of an AudioSpecificConfig: the object type, the sampling-frequency index and the channel configuration (plus the SBR extension when `aot` is 5 or 29). */
export function audioSpecificConfig(aot: number, freqIndex: number, channelConfig: number): Uint8Array {
  const bits: number[] = [];
  const push = (value: number, count: number): void => {
    for (let i = count - 1; i >= 0; i--) bits.push((value >> i) & 1);
  };
  if (aot === 5 || aot === 29) {
    // Explicit hierarchical signalling: the outer type, the core's rate and channels, the extension's rate, the core type.
    push(aot, 5);
    push(freqIndex + 3 > 12 ? 12 : freqIndex + 3, 4);
    push(channelConfig, 4);
    push(freqIndex, 4);
    push(2, 5);
  } else {
    push(aot, 5);
    push(freqIndex, 4);
    push(channelConfig, 4);
  }
  while (bits.length % 8 !== 0) bits.push(0);
  const out = new Uint8Array(bits.length / 8);
  bits.forEach((bit, i) => {
    out[i >> 3] = (out[i >> 3] ?? 0) | (bit << (7 - (i & 7)));
  });
  return out;
}

/** An `esds` box for the given objectTypeIndication and AudioSpecificConfig: the box that tells a demuxer which decoder a stream gets. */
export function esdsBox(oti: number, aot = 2, freqIndex = 4, channels = 2): Uint8Array {
  const asc = audioSpecificConfig(aot, freqIndex, channels);
  const decoderConfig = descriptor(0x04, concat(u8(oti, 0x15, 0, 0, 0), u32(0), u32(0), descriptor(0x05, asc)));
  return fullBox("esds", 0, descriptor(0x03, concat(u16(1), u8(0), decoderConfig, descriptor(0x06, u8(2)))));
}

export interface M4aOptions {
  /** The `hdlr` handler type; `soun` for audio. */
  handler?: string;
  /** The sample entry's type; `mp4a` for AAC. */
  entry?: string;
  /** DecoderConfigDescriptor's objectTypeIndication; 0x40 is MPEG-4 audio. */
  oti?: number;
  /** AudioSpecificConfig's object type: 2 AAC-LC, 5 SBR (HE-AAC), 29 PS. */
  aot?: number;
  channels?: number;
  sampleRate?: number;
  timescale?: number;
  duration?: number;
  /** Leave the `esds` out of the sample entry. */
  noEsds?: boolean;
  /** Leave the whole `ftyp` out. */
  noFtyp?: boolean;
  /** `dref` entries' flags; 1 is self-contained. Default: one self-contained entry. */
  drefFlags?: number[];
  /** Extra `trak` boxes appended after the first (each given as its handler type). */
  extraTracks?: string[];
  /** Repeat one box of the first track inside its parent (`mdia`, `hdlr`, `mdhd`, `minf`, `dinf`, `dref`, `stbl`, `stsd`, `esds`). */
  dupBox?: string;
  /** Extra boxes inside the first track's sample entry (`mp4a`), after its `esds`. */
  entryExtra?: Uint8Array[];
  /** Extra boxes inside the first `trak`, and inside its `mdia`. */
  trakExtra?: Uint8Array[];
  mdiaExtra?: Uint8Array[];
  /** Extra boxes inside the first track's `minf`, `stbl` and `dinf`. */
  minfExtra?: Uint8Array[];
  stblExtra?: Uint8Array[];
  dinfExtra?: Uint8Array[];
  /** Extra boxes inside `moov`, after the tracks. */
  moovExtra?: Uint8Array[];
  /** Extra boxes at the top level, after `mdat`. */
  topExtra?: Uint8Array[];
  /** Extra bytes after `moov`, as `mdat` payload. */
  mdat?: Uint8Array;
}

const SAMPLE_RATE_INDEX: Readonly<Record<number, number>> = { 96000: 0, 88200: 1, 64000: 2, 48000: 3, 44100: 4, 32000: 5, 24000: 6, 22050: 7, 16000: 8, 12000: 9, 11025: 10, 8000: 11 };

function track(options: Required<Pick<M4aOptions, "handler" | "entry" | "oti" | "aot" | "channels" | "sampleRate" | "timescale" | "duration" | "drefFlags">> & Pick<M4aOptions, "noEsds" | "dupBox" | "entryExtra" | "trakExtra" | "mdiaExtra" | "minfExtra" | "stblExtra" | "dinfExtra">): Uint8Array {
  const twice = (type: string, one: Uint8Array): Uint8Array => (options.dupBox === type ? concat(one, one) : one);
  const freqIndex = SAMPLE_RATE_INDEX[options.sampleRate] ?? 4;
  const asc = audioSpecificConfig(options.aot, freqIndex, options.channels);
  const decoderConfig = descriptor(0x04, concat(u8(options.oti, 0x15, 0, 0, 0), u32(0), u32(0), descriptor(0x05, asc)));
  const esds = fullBox("esds", 0, descriptor(0x03, concat(u16(1), u8(0), decoderConfig, descriptor(0x06, u8(2)))));
  const entryBody = concat(
    new Uint8Array(6),
    u16(1),
    new Uint8Array(8),
    u16(options.channels),
    u16(16),
    u16(0),
    u16(0),
    u32((options.sampleRate & 0xffff) * 65536),
    options.noEsds === true ? new Uint8Array(0) : twice("esds", esds),
    ...(options.entryExtra ?? []),
  );
  const stsd = twice("stsd", fullBox("stsd", 0, concat(u32(1), box(options.entry, entryBody))));
  const dref = twice("dref", fullBox("dref", 0, concat(u32(options.drefFlags.length), ...options.drefFlags.map((flags) => fullBox("url ", flags)))));
  const minf = twice(
    "minf",
    box("minf", concat(twice("dinf", box("dinf", concat(dref, ...(options.dinfExtra ?? [])))), twice("stbl", box("stbl", concat(stsd, ...(options.stblExtra ?? [])))), ...(options.minfExtra ?? []))),
  );
  const mdhd = twice("mdhd", fullBox("mdhd", 0, concat(u32(0), u32(0), u32(options.timescale), u32(options.duration), u16(0x55c4), u16(0))));
  const hdlr = twice("hdlr", fullBox("hdlr", 0, concat(u32(0), ascii(options.handler), new Uint8Array(12), u8(0))));
  return box("trak", concat(twice("mdia", box("mdia", concat(mdhd, hdlr, minf, ...(options.mdiaExtra ?? [])))), ...(options.trakExtra ?? [])));
}

/** A minimal audio MP4 (an AAC-LC stereo one at 44.1 kHz by default). */
export function buildM4a(options: M4aOptions = {}): Uint8Array {
  const full = {
    handler: options.handler ?? "soun",
    entry: options.entry ?? "mp4a",
    oti: options.oti ?? 0x40,
    aot: options.aot ?? 2,
    channels: options.channels ?? 2,
    sampleRate: options.sampleRate ?? 44100,
    timescale: options.timescale ?? 44100,
    duration: options.duration ?? 44100 * 8,
    drefFlags: options.drefFlags ?? [1],
    ...(options.noEsds === undefined ? {} : { noEsds: options.noEsds }),
  };
  // Extra tracks are plain: only the first track carries a repeated box.
  const extra = (options.extraTracks ?? []).map((handler) => track({ ...full, handler }));
  const first = { ...full, ...(options.dupBox === undefined ? {} : { dupBox: options.dupBox }), ...(options.entryExtra === undefined ? {} : { entryExtra: options.entryExtra }), ...(options.trakExtra === undefined ? {} : { trakExtra: options.trakExtra }), ...(options.mdiaExtra === undefined ? {} : { mdiaExtra: options.mdiaExtra }), ...(options.minfExtra === undefined ? {} : { minfExtra: options.minfExtra }), ...(options.stblExtra === undefined ? {} : { stblExtra: options.stblExtra }), ...(options.dinfExtra === undefined ? {} : { dinfExtra: options.dinfExtra }) };
  const ftyp = options.noFtyp === true ? new Uint8Array(0) : box("ftyp", concat(ascii("isom"), u32(512), ascii("isom"), ascii("iso2"), ascii("mp41")));
  return concat(ftyp, box("moov", concat(track(first), ...extra, ...(options.moovExtra ?? []))), box("mdat", options.mdat ?? new Uint8Array(16)), ...(options.topExtra ?? []));
}

/**
 * A real file with `extra` appended inside its first `trak`, or at the end of its `moov` (after the tracks): the parent's and the moov's sizes are corrected
 * and, when the samples sit after the `moov`, every chunk offset is moved by the same amount, so the result still plays. Used to hide a box (a second `esds`,
 * a stray `hdlr`) where the walker's schema has no place for it, in a file whose audio is real.
 */
export function graft(file: Uint8Array, extra: Uint8Array, inside: "trak" | "moov"): Uint8Array {
  const out = Uint8Array.from(file);
  const view = new DataView(out.buffer);
  const type = (at: number): string => String.fromCharCode(...out.subarray(at + 4, at + 8));
  let moov = -1;
  let mdat = -1;
  for (let at = 0; at + 8 <= out.byteLength; at += view.getUint32(at)) {
    if (type(at) === "moov") moov = at;
    if (type(at) === "mdat") mdat = at;
  }
  if (moov < 0) throw new Error("no moov");
  let trak = -1;
  for (let at = moov + 8; at < moov + view.getUint32(moov); at += view.getUint32(at)) {
    if (type(at) === "trak") {
      trak = at;
      break;
    }
  }
  if (trak < 0) throw new Error("no trak");
  const parent = inside === "trak" ? trak : moov;
  const parentEnd = parent + view.getUint32(parent);
  const grown = concat(out.subarray(0, parentEnd), extra, out.subarray(parentEnd));
  const gv = new DataView(grown.buffer);
  gv.setUint32(parent, view.getUint32(parent) + extra.byteLength);
  if (parent !== moov) gv.setUint32(moov, view.getUint32(moov) + extra.byteLength);
  if (mdat > moov) {
    const stco = Buffer.from(grown).indexOf("stco", moov, "latin1") - 4;
    if (stco < moov) throw new Error("no stco");
    const count = gv.getUint32(stco + 12);
    for (let i = 0; i < count; i++) gv.setUint32(stco + 16 + i * 4, gv.getUint32(stco + 16 + i * 4) + extra.byteLength);
  }
  return grown;
}
