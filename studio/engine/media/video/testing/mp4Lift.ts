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

// ---------- round 2: every container ffmpeg descends (3f.6 review, H1 class) ----------

const ascii = (text: string): Uint8Array => Uint8Array.from([...text].map((c) => c.charCodeAt(0)));
const hdlrBox = (subtype: string): Uint8Array => make("hdlr", cat(u32(0), u32(0), ascii(subtype), new Uint8Array(13)));

/** The boxes ffmpeg's parse table descends into, in which a track's stream parts (or a whole track, or a handler) can be put: `meta` is read from its own `hdlr`. */
export type HidingBox = "meta" | "sinf" | "schi" | "wave" | "traf" | "mvex" | "udta-meta" | "tref" | "udta";

/** The stream parts of a video track (its `mdhd` and `minf`, no `hdlr`) wrapped in `box`, as `HidingBox` says. */
function wrapped(box: HidingBox, stream: readonly Uint8Array[]): Uint8Array {
  if (box === "meta") return make("meta", cat(u32(0), hdlrBox("mdta"), ...stream));
  if (box === "udta-meta") return make("udta", make("meta", cat(u32(0), hdlrBox("mdta"), ...stream)));
  return make(box, cat(...stream));
}

function partsOf(src: Uint8Array, trak: Box): { head: Uint8Array[]; stream: Uint8Array[] } {
  const head: Uint8Array[] = [];
  const stream: Uint8Array[] = [];
  for (const x of kids(src, trak.body, trak.end)) {
    if (x.type !== "mdia") head.push(src.subarray(x.start, x.end));
    else for (const y of kids(src, x.body, x.end)) if (y.type !== "hdlr") stream.push(src.subarray(y.start, y.end));
  }
  return { head, stream };
}

/**
 * A copy whose FIRST track (a video; the file has two) has no `mdia`: its stream parts (`mdhd`, `minf`) are inside a `box` in the `trak`. ffmpeg descends `box` and finds a
 * video stream; the SECOND track is the one a walker judges, and `-map 0:V:0` takes the first.
 */
export function withFirstVideoPartsIn(src: Uint8Array, box: HidingBox): Uint8Array {
  const { moov, inMoov } = movieOf(src);
  let done = false;
  const parts = inMoov.map((b) => {
    if (b.type === "trak" && !done) {
      done = true;
      const { head, stream } = partsOf(src, b);
      return make("trak", cat(...head, wrapped(box, stream)));
    }
    return src.subarray(b.start, b.end);
  });
  return cat(src.subarray(0, moov.start), make("moov", cat(...parts)), src.subarray(moov.end));
}

/**
 * A copy whose FIRST track is relabelled SOUND in its `mdia/hdlr` and carries a second `hdlr vide` inside a `box` of the `trak`: the walker takes it for sound; ffmpeg
 * reads the last handler it finds.
 */
export function withFirstTrackHiddenHandlerIn(src: Uint8Array, box: "sinf" | "wave" | "traf" | "meta" | "schi" | "mvex"): Uint8Array {
  const relabelled = Uint8Array.from(src);
  const { moov, inMoov } = movieOf(relabelled);
  const first = inMoov.find((b) => b.type === "trak");
  if (first === undefined) throw new Error("no track");
  const mdia = kids(relabelled, first.body, first.end).find((x) => x.type === "mdia");
  const hdlr = mdia === undefined ? undefined : kids(relabelled, mdia.body, mdia.end).find((x) => x.type === "hdlr");
  if (hdlr === undefined) throw new Error("no handler");
  relabelled.set(ascii("soun"), hdlr.body + 8);
  const hidden = box === "meta" ? make("meta", cat(u32(0), hdlrBox("vide"))) : make(box, hdlrBox("vide"));
  const parts = inMoov.map((b) => (b === first ? make("trak", cat(relabelled.subarray(b.body, b.end), hidden)) : relabelled.subarray(b.start, b.end)));
  return cat(relabelled.subarray(0, moov.start), make("moov", cat(...parts)), relabelled.subarray(moov.end));
}

/** Where a whole `trak` can be put outside `moov`'s own list of tracks, in a box ffmpeg descends: `moov/udta`, `moov/meta` (handler `mdir`), or a top-level `udta` before `moov`. */
export type TrakHome = "moov/udta" | "moov/meta" | "top/udta";

/**
 * A copy whose FIRST track is inside `home` instead of directly in `moov`. In a file of two video tracks the second is the one a walker judges. ffmpeg's parse table is
 * level-independent, so it reads the moved track as a stream all the same.
 */
export function withFirstTrakIn(src: Uint8Array, home: TrakHome): Uint8Array {
  const { moov, inMoov } = movieOf(src);
  const first = inMoov.find((b) => b.type === "trak");
  if (first === undefined) throw new Error("no track");
  const moved = src.subarray(first.start, first.end);
  const rest = inMoov.filter((b) => b !== first).map((b) => src.subarray(b.start, b.end));
  if (home === "top/udta") return cat(src.subarray(0, moov.start), make("udta", moved), make("moov", cat(...rest)), src.subarray(moov.end));
  const holder = home === "moov/udta" ? make("udta", moved) : make("meta", cat(u32(0), hdlrBox("mdir"), moved));
  return cat(src.subarray(0, moov.start), make("moov", cat(...rest, holder)), src.subarray(moov.end));
}

/**
 * A copy whose FIRST video track is `trak{tkhd, minf}`: no `mdia`, no `mdhd` and no `hdlr` (ffmpeg takes the timescale from `mvhd`), the form that leaves nothing a walker looks
 * for in the places it looks.
 */
export function withVideoMinfOnly(src: Uint8Array): Uint8Array {
  const { moov, inMoov } = movieOf(src);
  const first = inMoov.find((b) => b.type === "trak");
  if (first === undefined) throw new Error("no track");
  const parts = inMoov.map((b) => {
    if (b !== first) return src.subarray(b.start, b.end);
    const tk = kids(src, b.body, b.end);
    const mdia = tk.find((x) => x.type === "mdia");
    const minf = mdia === undefined ? undefined : kids(src, mdia.body, mdia.end).find((y) => y.type === "minf");
    if (mdia === undefined || minf === undefined) throw new Error("no minf");
    return make("trak", cat(...tk.filter((x) => x.type !== "mdia").map((x) => src.subarray(x.start, x.end)), src.subarray(minf.start, minf.end)));
  });
  return cat(src.subarray(0, moov.start), make("moov", cat(...parts)), src.subarray(moov.end));
}
