import type { Findings, Mp4Box } from "./boxes";
import { kids } from "./checks";
import { u32, u64 } from "./reader";

// The media data must be exactly what the index describes. ffmpeg writes the
// chunks of both tracks back to back, so the chunks, laid out from `stsc`,
// `stsz` and `stco`/`co64`, tile the payload of `mdat` with no gap, no overlap
// and no byte left over. Anything else (60 MiB of zeros appended to `mdat`, a
// chunk pointing outside it, two chunks sharing bytes) is media data the
// index does not account for, and a place to carry a payload.

interface Chunk {
  readonly start: number;
  readonly end: number;
}

/** The chunks of one track, or a description of why they cannot be read. */
function trackChunks(bytes: Uint8Array, stbl: Mp4Box): Chunk[] | string {
  const stsz = kids(stbl, "stsz")[0];
  const stsc = kids(stbl, "stsc")[0];
  const stco = kids(stbl, "stco")[0];
  const co64 = kids(stbl, "co64")[0];
  const offsets = stco ?? co64;
  if (!stsz || !stsc || !offsets) return "a track lacks stsz, stsc or a chunk offset table";

  const uniform = u32(bytes, stsz.body + 4);
  const samples = u32(bytes, stsz.body + 8);
  if (uniform === undefined || samples === undefined) return "stsz has no sample count";
  if (uniform === 0 && stsz.body + 12 + samples * 4 > stsz.end) return "stsz is shorter than its sample count";

  const runCount = u32(bytes, stsc.body + 4);
  if (runCount === undefined || runCount === 0 || stsc.body + 8 + runCount * 12 > stsc.end) return "stsc is unreadable";
  const chunkCount = u32(bytes, offsets.body + 4);
  const wide = offsets === co64;
  if (chunkCount === undefined || offsets.body + 8 + chunkCount * (wide ? 8 : 4) > offsets.end) return "the chunk offset table is unreadable";

  const runFirst = (i: number): number => u32(bytes, stsc.body + 8 + i * 12) ?? 0;
  const runSamples = (i: number): number => u32(bytes, stsc.body + 12 + i * 12) ?? 0;
  if (runFirst(0) !== 1) return "stsc does not start at chunk 1";

  const chunks: Chunk[] = [];
  let sample = 0;
  let run = 0;
  for (let chunk = 1; chunk <= chunkCount; chunk++) {
    while (run + 1 < runCount && runFirst(run + 1) <= chunk) run++;
    const per = runSamples(run);
    if (sample + per > samples) return "the chunks hold more samples than stsz lists";
    let length = 0;
    if (uniform !== 0) length = per * uniform;
    else for (let i = 0; i < per; i++) length += u32(bytes, stsz.body + 12 + (sample + i) * 4) ?? 0;
    sample += per;
    const at = offsets.body + 8 + (chunk - 1) * (wide ? 8 : 4);
    const start = wide ? u64(bytes, at) : u32(bytes, at);
    if (start === undefined) return "a chunk offset is unreadable";
    chunks.push({ start, end: start + length });
  }
  return sample === samples ? chunks : "the chunks hold fewer samples than stsz lists";
}

/**
 * Checks that the chunks of every track tile the payload of `mdat`
 * (`body` to `end`, absolute file offsets) exactly.
 */
export function checkMediaData(bytes: Uint8Array, moovChildren: readonly Mp4Box[], mdat: { readonly body: number; readonly end: number }, findings: Findings): void {
  const all: Chunk[] = [];
  for (const trak of moovChildren.filter((c) => c.type === "trak")) {
    const stbl = kids(kids(kids(trak, "mdia")[0] ?? trak, "minf")[0] ?? trak, "stbl")[0];
    const chunks = stbl ? trackChunks(bytes, stbl) : "a track has no stbl";
    if (typeof chunks === "string") return void findings.add("MEDIA_DATA_MISMATCH", chunks, trak.path);
    all.push(...chunks);
  }
  all.sort((a, b) => a.start - b.start || a.end - b.end);
  let cursor = mdat.body;
  for (const chunk of all) {
    if (chunk.start !== cursor) {
      return void findings.add("MEDIA_DATA_MISMATCH", `a chunk starts at byte ${chunk.start} where the media data continues at ${cursor} (a gap, an overlap, or an offset outside mdat)`, "mdat");
    }
    cursor = chunk.end;
  }
  if (cursor !== mdat.end) findings.add("MEDIA_DATA_MISMATCH", `the chunks end at byte ${cursor} but mdat ends at ${mdat.end}: ${mdat.end - cursor} bytes are not described by the index`, "mdat");
}
