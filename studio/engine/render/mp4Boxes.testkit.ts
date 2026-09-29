// A small ISO-BMFF box walker for tests (the runtime verifier is 3a.7, which
// reuses `src/node/movSignature.ts`). It lists every box with its type and
// path, and reads the timestamps of `mvhd`, `tkhd` and `mdhd`.

export interface Box {
  readonly type: string;
  /** `moov/trak/mdia`, ... */
  readonly path: string;
  readonly start: number;
  readonly end: number;
}

/** Boxes that hold other boxes. `meta` is a full box (four bytes of version and flags precede its children). */
const CONTAINERS = new Set(["moov", "trak", "mdia", "minf", "stbl", "udta", "edts", "dinf", "ilst", "mvex"]);
const FULL_CONTAINERS = new Set(["meta"]);

function u32(bytes: Uint8Array, at: number): number {
  return ((bytes[at] ?? 0) * 0x1000000) + (((bytes[at + 1] ?? 0) << 16) | ((bytes[at + 2] ?? 0) << 8) | (bytes[at + 3] ?? 0));
}

function fourcc(bytes: Uint8Array, at: number): string {
  return String.fromCharCode(bytes[at] ?? 0, bytes[at + 1] ?? 0, bytes[at + 2] ?? 0, bytes[at + 3] ?? 0);
}

/** Every box in the file, depth first, in file order. */
export function walkBoxes(bytes: Uint8Array): Box[] {
  const out: Box[] = [];
  const walk = (from: number, to: number, parent: string): void => {
    let at = from;
    while (at + 8 <= to) {
      let size = u32(bytes, at);
      const type = fourcc(bytes, at + 4);
      let header = 8;
      if (size === 1) {
        size = u32(bytes, at + 8) * 0x100000000 + u32(bytes, at + 12);
        header = 16;
      } else if (size === 0) size = to - at;
      if (size < header || at + size > to) throw new Error(`bad box ${type} at ${at}, size ${size}`);
      const path = parent === "" ? type : `${parent}/${type}`;
      out.push({ type, path, start: at, end: at + size });
      if (CONTAINERS.has(type)) walk(at + header, at + size, path);
      else if (FULL_CONTAINERS.has(type)) walk(at + header + 4, at + size, path);
      at += size;
    }
  };
  walk(0, bytes.length, "");
  return out;
}

export interface BoxTimes {
  readonly creation: number;
  readonly modification: number;
}

/**
 * The creation and modification time (seconds since 1904) of EVERY box at
 * `path`, in file order: one `moov/mvhd`, and one `moov/trak/tkhd` and one
 * `moov/trak/mdia/mdhd` per track (the audio track too).
 */
export function readTimes(bytes: Uint8Array, boxes: readonly Box[], path: string): BoxTimes[] {
  const found = boxes.filter((b) => b.path === path);
  if (found.length === 0) throw new Error(`no ${path} box`);
  return found.map((box) => {
    const body = box.start + 8;
    const version = bytes[body] ?? 0;
    if (version === 1) {
      return { creation: u32(bytes, body + 4) * 0x100000000 + u32(bytes, body + 8), modification: u32(bytes, body + 12) * 0x100000000 + u32(bytes, body + 16) };
    }
    return { creation: u32(bytes, body + 4), modification: u32(bytes, body + 8) };
  });
}

/** The distinct box types found at exactly `depth` levels below the root (0 = top level). */
export function typesAt(boxes: readonly Box[], parentPath: string): string[] {
  const prefix = parentPath === "" ? "" : `${parentPath}/`;
  return boxes
    .filter((b) => b.path.startsWith(prefix) && !b.path.slice(prefix.length).includes("/") && (parentPath === "" || b.path !== parentPath))
    .map((b) => b.type);
}

/** Whether `needle` occurs anywhere in `bytes` (ASCII). */
export function containsAscii(bytes: Uint8Array, needle: string): boolean {
  const n = new TextEncoder().encode(needle);
  outer: for (let i = 0; i + n.length <= bytes.length; i++) {
    for (let j = 0; j < n.length; j++) if (bytes[i + j] !== n[j]) continue outer;
    return true;
  }
  return false;
}

/**
 * The vendor field of the first sample entry of every `stsd` (the video's
 * `avc1`, the audio's `mp4a`), as four characters with a zero byte written
 * `\0`. ffprobe shows it as the `vendor_id` tag, but only some builds print
 * a zero vendor, so the box is read directly.
 */
export function sampleEntryVendors(bytes: Uint8Array, boxes: readonly Box[]): string[] {
  return boxes
    .filter((b) => b.path.endsWith("/stsd"))
    .map((stsd) => {
      const entry = stsd.start + 8 + 8; // box header, then version/flags and the entry count
      const at = entry + 20; // size, type, reserved(6), data reference(2), version(2), revision(2)
      return [0, 1, 2, 3].map((i) => (bytes[at + i] === 0 ? "\\0" : String.fromCharCode(bytes[at + i] ?? 0))).join("");
    });
}
