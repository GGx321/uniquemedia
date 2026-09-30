// What the packaged E2E records about each rendered MP4 on each OS (plan 3a.9): the FULL box tree (the verifier's allowlist is
// strict, so a box Windows' ffmpeg writes outside it would refuse every render, and this shows which), the `ftyp` brands, the
// creation and modification times, the `©too` string and the compressor name. A reader for the smoke, not a verifier: it
// lists whatever is there, known or not, and never judges. The verifier (studio/engine/verify) is the judge.

export interface BoxNode {
  readonly type: string;
  readonly children: readonly BoxNode[];
}

/** Boxes that only hold other boxes. `meta` and `dref` are full boxes: four bytes of version and flags precede the children (`dref` adds a count). */
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "dinf", "udta", "edts", "ilst", "©too", "mvex"]);
const FULL_CONTAINER_SKIP: ReadonlyMap<string, number> = new Map([
  ["meta", 4],
  ["dref", 8],
]);
/** An `avc1` (and other visual) sample entry's fixed fields before its child boxes; an `mp4a`'s. */
const VISUAL_ENTRY_FIELDS = 78;
const AUDIO_ENTRY_FIELDS = 28;
/** Where the 32-byte Pascal compressor name sits among the visual entry's fixed fields. */
const COMPRESSOR_AT = 42;
const COMPRESSOR_BYTES = 32;
const VISUAL_ENTRIES = new Set(["avc1", "avc3", "hvc1", "hev1", "mp4v"]);

function u32(bytes: Uint8Array, at: number): number {
  return (bytes[at] ?? 0) * 0x1000000 + (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0));
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
}

interface RawBox {
  readonly type: string;
  /** Where the box starts, and where its payload starts and ends. */
  readonly start: number;
  readonly body: number;
  readonly end: number;
}

function readBoxes(bytes: Uint8Array, from: number, to: number): RawBox[] {
  const boxes: RawBox[] = [];
  let at = from;
  while (at + 8 <= to) {
    let size = u32(bytes, at);
    const type = fourcc(bytes, at + 4);
    let header = 8;
    if (size === 1) {
      size = u32(bytes, at + 8) * 0x100000000 + u32(bytes, at + 12);
      header = 16;
    } else if (size === 0) size = to - at;
    if (size < header || at + size > to) throw new Error(`bad box ${JSON.stringify(type)} at ${at}, size ${size}`);
    boxes.push({ type, start: at, body: at + header, end: at + size });
    at += size;
  }
  return boxes;
}

function nodeOf(bytes: Uint8Array, box: RawBox): BoxNode {
  if (CONTAINERS.has(box.type)) return { type: box.type, children: readBoxes(bytes, box.body, box.end).map((child) => nodeOf(bytes, child)) };
  const skip = FULL_CONTAINER_SKIP.get(box.type);
  if (skip !== undefined) return { type: box.type, children: readBoxes(bytes, box.body + skip, box.end).map((child) => nodeOf(bytes, child)) };
  if (box.type === "stsd") {
    // version/flags (4) and the entry count (4), then the sample entries, each a box with fixed fields before its children.
    const entries = readBoxes(bytes, box.body + 8, box.end).map((entry): BoxNode => {
      const fields = VISUAL_ENTRIES.has(entry.type) ? VISUAL_ENTRY_FIELDS : entry.type === "mp4a" ? AUDIO_ENTRY_FIELDS : null;
      return { type: entry.type, children: fields === null || entry.body + fields > entry.end ? [] : readBoxes(bytes, entry.body + fields, entry.end).map((child) => nodeOf(bytes, child)) };
    });
    return { type: "stsd", children: entries };
  }
  return { type: box.type, children: [] };
}

/** Every box in the file, nested: the top level in file order, containers and sample entries opened. */
export function boxTree(bytes: Uint8Array): BoxNode[] {
  return readBoxes(bytes, 0, bytes.length).map((box) => nodeOf(bytes, box));
}

/** `ftyp moov(mvhd trak(tkhd ...)) free mdat`: a node with children prints them in parentheses. */
export function formatBoxTree(nodes: readonly BoxNode[]): string {
  return nodes.map((node) => (node.children.length === 0 ? node.type : `${node.type}(${formatBoxTree(node.children)})`)).join(" ");
}

export interface BoxTimes {
  readonly creation: number;
  readonly modification: number;
}

export interface Mp4Facts {
  readonly brands: { readonly major: string; readonly minor: number; readonly compatible: readonly string[] };
  /** Seconds since 1904, per box, in file order: one `mvhd`, and one `tkhd` and one `mdhd` per track. */
  readonly times: { readonly mvhd: readonly BoxTimes[]; readonly tkhd: readonly BoxTimes[]; readonly mdhd: readonly BoxTimes[] };
  /** The `©too` string (`Lavf...`), or null. */
  readonly tool: string | null;
  /** The first video sample entry's compressor name (`Lavc... libx264`), or null. */
  readonly compressor: string | null;
}

/** Every box of a type, at any depth, with its place in the file. */
function findAll(bytes: Uint8Array, type: string, from = 0, to = bytes.length, into: RawBox[] = []): RawBox[] {
  for (const box of readBoxes(bytes, from, to)) {
    if (box.type === type) into.push(box);
    if (CONTAINERS.has(box.type)) findAll(bytes, type, box.body, box.end, into);
    else if (box.type === "meta") findAll(bytes, type, box.body + 4, box.end, into);
  }
  return into;
}

function timesOf(bytes: Uint8Array, box: RawBox): BoxTimes {
  const version = bytes[box.body] ?? 0;
  if (version === 1) return { creation: u32(bytes, box.body + 4) * 0x100000000 + u32(bytes, box.body + 8), modification: u32(bytes, box.body + 12) * 0x100000000 + u32(bytes, box.body + 16) };
  return { creation: u32(bytes, box.body + 4), modification: u32(bytes, box.body + 8) };
}

function compressorOf(bytes: Uint8Array): string | null {
  for (const stsd of findAll(bytes, "stsd")) {
    for (const entry of readBoxes(bytes, stsd.body + 8, stsd.end)) {
      if (!VISUAL_ENTRIES.has(entry.type)) continue;
      const at = entry.body + COMPRESSOR_AT;
      const length = Math.min(bytes[at] ?? 0, COMPRESSOR_BYTES - 1);
      return new TextDecoder("latin1").decode(bytes.subarray(at + 1, at + 1 + length));
    }
  }
  return null;
}

function toolOf(bytes: Uint8Array): string | null {
  for (const too of findAll(bytes, "©too")) {
    for (const data of readBoxes(bytes, too.body, too.end)) {
      // `data`: type indicator (4), locale (4), then the text.
      if (data.type === "data") return new TextDecoder("latin1").decode(bytes.subarray(data.body + 8, data.end));
    }
  }
  return null;
}

export function mp4Facts(bytes: Uint8Array): Mp4Facts {
  const [ftyp] = readBoxes(bytes, 0, bytes.length).filter((box) => box.type === "ftyp");
  if (ftyp === undefined) throw new Error("the file has no ftyp box");
  const compatible: string[] = [];
  for (let at = ftyp.body + 8; at + 4 <= ftyp.end; at += 4) compatible.push(fourcc(bytes, at));
  return {
    brands: { major: fourcc(bytes, ftyp.body), minor: u32(bytes, ftyp.body + 4), compatible },
    times: {
      mvhd: findAll(bytes, "mvhd").map((box) => timesOf(bytes, box)),
      tkhd: findAll(bytes, "tkhd").map((box) => timesOf(bytes, box)),
      mdhd: findAll(bytes, "mdhd").map((box) => timesOf(bytes, box)),
    },
    tool: toolOf(bytes),
    compressor: compressorOf(bytes),
  };
}
