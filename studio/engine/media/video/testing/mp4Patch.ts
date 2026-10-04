import { box, concat, fullBox, u32 } from "./mp4VideoBuilder";

// Test-only: edits a real MP4 or MOV the way a camera or an editor might have written it differently: another rotation, a Dolby Vision
// box in the sample entry, another transfer in `colr`. It trusts the file it is given (its own fixtures), unlike the probe. Used by the
// fixture generator and by tests. Production code never imports it.

interface Box {
  readonly type: string;
  readonly start: number;
  readonly body: number;
  readonly end: number;
}

const latin1 = (bytes: Uint8Array, from: number, to: number): string => String.fromCharCode(...bytes.subarray(from, to));

function children(bytes: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const found: Box[] = [];
  for (let at = start; at + 8 <= end; ) {
    const size = view.getUint32(at);
    if (size < 8) throw new Error("the fixture has a box this helper does not read");
    found.push({ type: latin1(bytes, at + 4, at + 8), start: at, body: at + 8, end: at + size });
    at += size;
  }
  return found;
}

function child(bytes: Uint8Array, parent: Box, type: string, skip = 0): Box {
  const found = children(bytes, parent.body + skip, parent.end).find((box) => box.type === type);
  if (found === undefined) throw new Error(`no ${type} box`);
  return found;
}

const top = (bytes: Uint8Array): Box => ({ type: "file", start: 0, body: 0, end: bytes.byteLength });

/** The video track's boxes on the way to its sample entry: moov, trak, mdia, minf, stbl, stsd, and the entry itself. */
function videoPath(bytes: Uint8Array): Box[] {
  const moov = child(bytes, top(bytes), "moov");
  const trak = children(bytes, moov.body, moov.end).find((box) => {
    if (box.type !== "trak") return false;
    const hdlr = child(bytes, child(bytes, box, "mdia"), "hdlr");
    return latin1(bytes, hdlr.body + 8, hdlr.body + 12) === "vide";
  });
  if (trak === undefined) throw new Error("no video track");
  const mdia = child(bytes, trak, "mdia");
  const minf = child(bytes, mdia, "minf");
  const stbl = child(bytes, minf, "stbl");
  const stsd = child(bytes, stbl, "stsd");
  const entry = children(bytes, stsd.body + 8, stsd.end)[0];
  if (entry === undefined) throw new Error("no sample entry");
  return [moov, trak, mdia, minf, stbl, stsd, entry];
}

/** A copy with the video track's display matrix set to a quarter turn (clockwise degrees). */
export function withRotation(source: Uint8Array, degrees: 0 | 90 | 180 | 270): Uint8Array {
  const bytes = Uint8Array.from(source);
  const trak = videoPath(bytes)[1];
  if (trak === undefined) throw new Error("no video track");
  const tkhd = child(bytes, trak, "tkhd");
  const view = new DataView(bytes.buffer);
  const matrixAt = tkhd.body + ((bytes[tkhd.body] ?? 0) === 1 ? 52 : 40);
  const [a, b, c, d] = { 0: [1, 0, 0, 1], 90: [0, 1, -1, 0], 180: [-1, 0, 0, -1], 270: [0, -1, 1, 0] }[degrees];
  view.setInt32(matrixAt, a * 0x10000);
  view.setInt32(matrixAt + 4, b * 0x10000);
  view.setInt32(matrixAt + 12, c * 0x10000);
  view.setInt32(matrixAt + 16, d * 0x10000);
  return bytes;
}

/**
 * A copy with `added` appended to the video sample entry. The sizes of the boxes above it grow; the chunk offsets are NOT fixed, so
 * the file must have its `moov` after its `mdat` (the generator writes the fixtures that are meant for this that way).
 */
export function withEntryBox(source: Uint8Array, added: Uint8Array): Uint8Array {
  const path = videoPath(source);
  const moov = path[0];
  const entry = path[path.length - 1];
  if (moov === undefined || entry === undefined) throw new Error("no sample entry");
  const mdat = children(source, 0, source.byteLength).find((box) => box.type === "mdat");
  if (mdat === undefined || mdat.start > moov.start) throw new Error("this helper needs a file with its moov after its mdat");
  const out = concat(source.subarray(0, entry.end), added, source.subarray(entry.end));
  const view = new DataView(out.buffer);
  for (const box of path) view.setUint32(box.start, view.getUint32(box.start) + added.byteLength);
  return out;
}

/**
 * A copy with cover art (an iTunes-style `udta/meta/ilst/covr` holding `picture`, a PNG) put in `moov` BEFORE the first track, where ffmpeg
 * makes an attached-picture video stream that comes ahead of the real one. Needs `moov` after `mdat`, as `withEntryBox` does.
 */
export function withCoverArt(source: Uint8Array, picture: Uint8Array): Uint8Array {
  const moov = child(source, top(source), "moov");
  const mdat = children(source, 0, source.byteLength).find((box) => box.type === "mdat");
  if (mdat === undefined || mdat.start > moov.start) throw new Error("this helper needs a file with its moov after its mdat");
  const first = children(source, moov.body, moov.end).find((box) => box.type === "trak");
  if (first === undefined) throw new Error("no track");
  const data = box("data", concat(Uint8Array.from([0, 0, 0, 14, 0, 0, 0, 0]), picture));
  const ilst = box("ilst", box("covr", data));
  const hdlr = fullBox("hdlr", 0, concat(u32(0), Uint8Array.from([0x6d, 0x64, 0x69, 0x72]), new Uint8Array(13)));
  const udta = box("udta", fullBox("meta", 0, concat(hdlr, ilst)));
  const out = concat(source.subarray(0, first.start), udta, source.subarray(first.start));
  const view = new DataView(out.buffer);
  view.setUint32(moov.start, view.getUint32(moov.start) + udta.byteLength);
  return out;
}

/** The first track of the file (whatever its kind) and the moov it is in; the file must have its moov after its mdat. */
function firstTrak(source: Uint8Array): { moov: Box; trak: Box } {
  const moov = child(source, top(source), "moov");
  const mdat = children(source, 0, source.byteLength).find((box) => box.type === "mdat");
  if (mdat === undefined || mdat.start > moov.start) throw new Error("this helper needs a file with its moov after its mdat");
  const trak = children(source, moov.body, moov.end).find((box) => box.type === "trak");
  if (trak === undefined) throw new Error("no track");
  return { moov, trak };
}

/** A copy whose FIRST track's `hdlr` says `handler` (four characters), in place: the track is what it was, but is no longer called what it was. */
export function withFirstTrackHandler(source: Uint8Array, handler: string): Uint8Array {
  const bytes = Uint8Array.from(source);
  const { trak } = firstTrak(bytes);
  const hdlr = child(bytes, child(bytes, trak, "mdia"), "hdlr");
  bytes.set(Uint8Array.from([...handler].map((c) => c.charCodeAt(0))), hdlr.body + 8);
  return bytes;
}

/**
 * A copy whose FIRST track is labelled SOUND in `mdia/hdlr` (the walker takes a sound track for sound) and carries a second `hdlr` that says
 * `vide`, where ffmpeg also parses one: at the start of `minf` (`where: "minf"`), or in a `meta` box at the end of the `trak` (`"meta"`). ffmpeg
 * lets the last handler it reads win, so it sees the track as video. The file needs its moov after its mdat.
 */
export function withHiddenVideoHandler(source: Uint8Array, where: "minf" | "meta"): Uint8Array {
  const labelled = withFirstTrackHandler(source, "soun");
  const { moov, trak } = firstTrak(labelled);
  const hdlr = fullBox("hdlr", 0, concat(u32(0), Uint8Array.from([0x76, 0x69, 0x64, 0x65]), new Uint8Array(13)));
  const mdia = child(labelled, trak, "mdia");
  const minf = child(labelled, mdia, "minf");
  const added = where === "minf" ? hdlr : box("meta", concat(u32(0), hdlr));
  const at = where === "minf" ? minf.body : trak.end;
  const out = concat(labelled.subarray(0, at), added, labelled.subarray(at));
  const view = new DataView(out.buffer);
  for (const b of where === "minf" ? [moov, trak, mdia, minf] : [moov, trak]) view.setUint32(b.start, view.getUint32(b.start) + added.byteLength);
  return out;
}

/** A copy whose FIRST track is moved out of `moov`, to the top level just before it. */
export function withFirstTrackAtTopLevel(source: Uint8Array): Uint8Array {
  const { moov, trak } = firstTrak(source);
  const rest = concat(source.subarray(moov.body, trak.start), source.subarray(trak.end, moov.end));
  return concat(source.subarray(0, moov.start), source.subarray(trak.start, trak.end), u32(rest.byteLength + 8), Uint8Array.from([0x6d, 0x6f, 0x6f, 0x76]), rest, source.subarray(moov.end));
}

/**
 * A copy whose video track has THIS edit list (version 0, replacing the `edts` it had, or added if it had none): each entry's segment duration
 * (movie timescale), media time (-1 for an empty edit) and rate (default 1.0). The file needs its moov after its mdat.
 */
export function withEditList(source: Uint8Array, entries: readonly { duration: number; mediaTime: number; rate?: readonly [number, number] }[]): Uint8Array {
  const path = videoPath(source);
  const moov = path[0];
  const trak = path[1];
  if (moov === undefined || trak === undefined) throw new Error("no video track");
  const mdat = children(source, 0, source.byteLength).find((b) => b.type === "mdat");
  if (mdat === undefined || mdat.start > moov.start) throw new Error("this helper needs a file with its moov after its mdat");
  const rows = entries.map((e) => concat(u32(e.duration), u32(e.mediaTime >>> 0), Uint8Array.from([0, e.rate?.[0] ?? 1, 0, e.rate?.[1] ?? 0])));
  const edts = box("edts", fullBox("elst", 0, concat(u32(entries.length), ...rows)));
  const old = children(source, trak.body, trak.end).find((b) => b.type === "edts");
  const cutFrom = old === undefined ? trak.body : old.start;
  const cutTo = old === undefined ? trak.body : old.end;
  const out = concat(source.subarray(0, cutFrom), edts, source.subarray(cutTo));
  const delta = edts.byteLength - (cutTo - cutFrom);
  const view = new DataView(out.buffer);
  for (const b of [moov, trak]) view.setUint32(b.start, view.getUint32(b.start) + delta);
  return out;
}

/** A copy that CLAIMS another picture size in `tkhd` and the sample entry (the bitstream is untouched, and says what it said). */
export function withClaimedSize(source: Uint8Array, width: number, height: number): Uint8Array {
  const bytes = Uint8Array.from(source);
  const path = videoPath(bytes);
  const trak = path[1];
  const entry = path[path.length - 1];
  if (trak === undefined || entry === undefined) throw new Error("no video track");
  const view = new DataView(bytes.buffer);
  const tkhd = child(bytes, trak, "tkhd");
  const sizeAt = tkhd.body + ((bytes[tkhd.body] ?? 0) === 1 ? 52 : 40) + 36;
  view.setUint32(sizeAt, width * 0x10000);
  view.setUint32(sizeAt + 4, height * 0x10000);
  view.setUint16(entry.body + 24, width);
  view.setUint16(entry.body + 26, height);
  return bytes;
}

/** A copy whose `colr` says another transfer (the pixels are untouched). */
export function withTransfer(source: Uint8Array, transfer: number): Uint8Array {
  const bytes = Uint8Array.from(source);
  const entry = videoPath(bytes).at(-1);
  if (entry === undefined) throw new Error("no sample entry");
  const colr = child(bytes, entry, "colr", 78);
  new DataView(bytes.buffer).setUint16(colr.body + 6, transfer);
  return bytes;
}
