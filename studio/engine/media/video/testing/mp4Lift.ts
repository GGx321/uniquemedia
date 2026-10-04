// Test-only: real MP4s made hostile by moving the parts of a track out of `mdia` (3f.6 review, H1). ffmpeg's parse table does not care how deep a box is: `minf`, `stbl`
// and `stsd` found directly in a `trak` make a stream, and with no `hdlr` the sample entry's codec decides that it is a video. The helpers take a file whose `moov` is
// AFTER its `mdat` (what ffmpeg writes without `+faststart`), so the offsets of the samples do not move.

interface Box {
  readonly type: string;
  readonly start: number;
  readonly end: number;
  readonly body: number;
}

const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n);
  return b;
};
const cat = (...parts: Uint8Array[]): Uint8Array => {
  const out = new Uint8Array(parts.reduce((sum, p) => sum + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
};
const make = (type: string, body: Uint8Array): Uint8Array => cat(u32(body.length + 8), Uint8Array.from([...type].map((c) => c.charCodeAt(0))), body);

function kids(bytes: Uint8Array, start: number, end: number): Box[] {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const out: Box[] = [];
  for (let at = start; at + 8 <= end; ) {
    const size = view.getUint32(at);
    if (size < 8) break;
    out.push({ type: String.fromCharCode(...bytes.subarray(at + 4, at + 8)), start: at, end: at + size, body: at + 8 });
    at += size;
  }
  return out;
}

function movieOf(src: Uint8Array): { moov: Box; inMoov: Box[] } {
  const top = kids(src, 0, src.length);
  const moov = top.find((b) => b.type === "moov");
  const mdat = top.find((b) => b.type === "mdat");
  if (moov === undefined || mdat === undefined || mdat.start > moov.start) throw new Error("this helper needs a file with its moov after its mdat");
  return { moov, inMoov: kids(src, moov.body, moov.end) };
}

const handlerOf = (src: Uint8Array, trak: Box): string => {
  const mdia = kids(src, trak.body, trak.end).find((x) => x.type === "mdia");
  const hdlr = mdia === undefined ? undefined : kids(src, mdia.body, mdia.end).find((x) => x.type === "hdlr");
  return hdlr === undefined ? "" : String.fromCharCode(...src.subarray(hdlr.body + 8, hdlr.body + 12));
};

/** `trak` with its `mdia` replaced by what was in it, less its `hdlr`: `mdhd` and `minf` sit directly in the track. */
function lifted(src: Uint8Array, trak: Box): Uint8Array {
  const parts = kids(src, trak.body, trak.end).flatMap((x) => {
    if (x.type !== "mdia") return [src.subarray(x.start, x.end)];
    return kids(src, x.body, x.end)
      .filter((y) => y.type !== "hdlr")
      .map((y) => src.subarray(y.start, y.end));
  });
  return make("trak", cat(...parts));
}

/**
 * A copy whose VIDEO track has no `mdia`: its `mdhd` and `minf` are in the `trak` and its `hdlr` is gone. `videoFirst` puts that track before the others (a sound
 * track after it) or after them. A walker that skips a track with no `mdia` calls such a file «no video»; ffmpeg shows `Video: h264`.
 */
export function withVideoMdiaLifted(src: Uint8Array, videoFirst: boolean): Uint8Array {
  const { moov, inMoov } = movieOf(src);
  const pre: Uint8Array[] = [];
  const others: Uint8Array[] = [];
  let video: Uint8Array | null = null;
  for (const b of inMoov) {
    if (b.type !== "trak") {
      pre.push(src.subarray(b.start, b.end));
    } else if (video === null && handlerOf(src, b) === "vide") video = lifted(src, b);
    else others.push(src.subarray(b.start, b.end));
  }
  if (video === null) throw new Error("no video track");
  return cat(src.subarray(0, moov.start), make("moov", cat(...pre, ...(videoFirst ? [video, ...others] : [...others, video]))), src.subarray(moov.end));
}

/** A copy whose FIRST track (a video) has no `mdia`, in a file of two video tracks: the second is the one a walker judges. */
export function withFirstTrackMdiaLifted(src: Uint8Array): Uint8Array {
  const { moov, inMoov } = movieOf(src);
  let done = false;
  const parts = inMoov.map((b) => {
    if (b.type === "trak" && !done) {
      done = true;
      return lifted(src, b);
    }
    return src.subarray(b.start, b.end);
  });
  return cat(src.subarray(0, moov.start), make("moov", cat(...parts)), src.subarray(moov.end));
}

/** A copy whose video track's `mdia` is called `edts` (the box and its contents are what they were): ffmpeg reads the parts inside it as it reads them anywhere. */
export function withVideoMdiaRenamed(src: Uint8Array, to: string): Uint8Array {
  if (to.length !== 4) throw new Error("a box type is four characters");
  const out = Uint8Array.from(src);
  const { inMoov } = movieOf(out);
  for (const trak of inMoov.filter((b) => b.type === "trak")) {
    if (handlerOf(out, trak) !== "vide") continue;
    const mdia = kids(out, trak.body, trak.end).find((x) => x.type === "mdia");
    if (mdia === undefined) throw new Error("no mdia");
    out.set(Uint8Array.from([...to].map((c) => c.charCodeAt(0))), mdia.start + 4);
    return out;
  }
  throw new Error("no video track");
}
