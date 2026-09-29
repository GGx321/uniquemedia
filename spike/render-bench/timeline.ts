// Q2-Q4: a mixed 15 s timeline (photo KB 4 s, collage3 3 s, photo pan 3 s, collage2 3 s,
// collage4 2 s, one sticker over 2-6 s, silent exact-length audio) rendered
//   (a) as a SINGLE graph straight to the final encode (the reference), and
//   (b) TWO-PASS: pass 1 each clip -> intermediate (qp0 / crf8 / crf10), pass 2 concat
//       demuxer + sticker overlay + audio + final encode.
// Also: preset comparison for the final encode, and SSIM of every final vs the reference.
// Usage: bun spike/render-bench/timeline.ts [tech=zp4] [runs=3] [outName=timeline]
import { mkdirSync, writeFileSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadavg } from "node:os";
import { ff, OUT, PHOTOS, STICKER, median, saveResult, machine, frameCount, ptsDeltas, probeJson, run, FFMPEG, type Run } from "./common";
import {
  clipPart, pass1Args, mixedTimeline, INTERS, finalVideoArgs, audioArgs, overlayFilters, stickerInput,
  SILENCE, type Tech, type Inter, type ClipSpec,
} from "./graphs";

const TECH = (process.argv[2] ?? "zp4") as Tech;
const RUNS = Number(process.argv[3] ?? 3);
const NAME = process.argv[4] ?? "timeline";
const STRESS = process.env.STRESS === "1"; // 20 collage4 clips of 0.7 s: 80 photo inputs, the plan's caps
const SPECS: ClipSpec[] = STRESS
  ? Array.from({ length: 20 }, (_, i): ClipSpec => ({
      kind: "collage4", seconds: 0.7, motion: i % 2 ? "pan" : "kb", stagger: true, dir: 1,
      photos: [0, 1, 2, 3].map((k) => PHOTOS[(i + k) % PHOTOS.length]!),
    }))
  : mixedTimeline(PHOTOS);
const INTER_SET = STRESS ? INTERS.filter((i) => i.name === "crf8") : INTERS;
const TOTAL_S = SPECS.reduce((a, s) => a + s.seconds, 0);
const TOTAL_FRAMES = Math.round(TOTAL_S * 30);
const STICKER_AT = { file: STICKER, x: 70, y: 1500, start: 2, end: 6 };
const dir = join(OUT, `tl-${TECH}${STRESS ? "-stress" : ""}${process.env.CAPS === "1" ? "-capped" : ""}`);
mkdirSync(dir, { recursive: true });

// CAPS=1: -filter_threads 2 -filter_complex_threads 2 on every render command
const CAPS = process.env.CAPS === "1" ? ["-filter_threads", "2", "-filter_complex_threads", "2"] : [];
const load = () => Math.round(loadavg()[0]! * 10) / 10;
const mb = (p: string) => +(statSync(p).size / 1048576).toFixed(2);
const stat = (rs: Run[]) => ({
  medianMs: Math.round(median(rs.map((r) => r.ms))),
  runsMs: rs.map((r) => Math.round(r.ms)),
  peakRssMB: Math.round(Math.max(...rs.map((r) => r.rssMB))),
  load1: load(),
});

/** (a) single graph -> final MP4 */
function singleArgs(preset: string, out: string): string[] {
  const inputs: string[] = [];
  const filters: string[] = [];
  const outs: string[] = [];
  let idx = 0;
  SPECS.forEach((s, i) => {
    const part = clipPart(s, TECH, idx, `k${i}_`);
    idx += part.inputs.length / 2;
    inputs.push(...part.inputs);
    filters.push(...part.filters, `[${part.out}]setsar=1[k${i}_v]`);
    outs.push(`[k${i}_v]`);
  });
  filters.push(`${outs.join("")}concat=n=${outs.length}:v=1:a=0[cat]`);
  filters.push(...overlayFilters("cat", STICKER_AT, idx, 0, "v"));
  filters.push(`${SILENCE(TOTAL_S)}[a]`);
  return [
    ...inputs, ...stickerInput(STICKER, TOTAL_S + 1),
    "-filter_complex", filters.join(";"), "-map", "[v]", "-map", "[a]",
    ...finalVideoArgs(preset), ...audioArgs(), "-movflags", "+faststart", "-map_metadata", "-1", "-map_chapters", "-1", out,
  ];
}

/** (b) pass 1: every clip -> `<inter>/clip-NN.mkv`. Returns per-clip Runs. */
async function pass1(inter: Inter): Promise<{ runs: Run[]; dir: string }> {
  const d = join(dir, inter.name);
  mkdirSync(d, { recursive: true });
  const runs: Run[] = [];
  for (let i = 0; i < SPECS.length; i++) {
    runs.push(await ff([...CAPS, ...pass1Args(SPECS[i]!, TECH, join(d, `clip-${String(i).padStart(2, "0")}.mkv`), inter)]));
  }
  return { runs, dir: d };
}

/** (b) pass 2: concat demuxer + overlay + audio + final encode. */
async function pass2(d: string, preset: string, out: string): Promise<Run> {
  const list = SPECS.map((_, i) => `file 'clip-${String(i).padStart(2, "0")}.mkv'`).join("\n") + "\n";
  writeFileSync(join(d, "list.txt"), list);
  const f = [
    "[0:v]setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv[base]",
    ...overlayFilters("base", STICKER_AT, 1, 0, "v"),
    `${SILENCE(TOTAL_S)}[a]`,
  ];
  return ff([...CAPS,
    "-f", "concat", "-protocol_whitelist", "file", "-i", "list.txt", ...stickerInput(STICKER, TOTAL_S + 1),
    "-filter_complex", f.join(";"), "-map", "[v]", "-map", "[a]",
    ...finalVideoArgs(preset), ...audioArgs(), "-movflags", "+faststart", "-map_metadata", "-1", "-map_chapters", "-1", out,
  ], { cwd: d });
}

/** SSIM All and PSNR average between two videos (video streams only), optional per-frame min. */
async function compare(a: string, b: string, perFrame = false): Promise<{ ssim: number; psnr: number; minFrameSsim?: number }> {
  const statsFile = join(OUT, "ssim-stats.txt");
  const r1 = await ff(["-i", a, "-i", b, "-lavfi", `[0:v][1:v]ssim=stats_file=${statsFile}`, "-f", "null", "-"]);
  const m = /SSIM Y:[\d.]+ \([\d.]+\) U:[\d.]+ \([\d.]+\) V:[\d.]+ \([\d.]+\) All:([\d.]+)/.exec(r1.stderr);
  const r2 = await ff(["-i", a, "-i", b, "-lavfi", "[0:v][1:v]psnr", "-f", "null", "-"]);
  const p = /PSNR y:[\d.]+ u:[\d.]+ v:[\d.]+ average:([\d.inf]+)/.exec(r2.stderr);
  let minFrameSsim: number | undefined;
  if (perFrame) {
    const vals = [...readFileSync(statsFile, "utf8").matchAll(/All:([\d.]+)/g)].map((x) => Number(x[1]));
    minFrameSsim = Math.min(...vals);
  }
  return { ssim: Number(m?.[1] ?? NaN), psnr: p?.[1] === "inf" ? Infinity : Number(p?.[1] ?? NaN), minFrameSsim };
}

async function facts(path: string) {
  const j = await probeJson(path, ["-show_entries", "stream=codec_name,profile,width,height,pix_fmt,r_frame_rate,color_range,color_space,color_transfer,color_primaries,sample_rate,channels,nb_frames,duration:format=duration,size"]);
  const d = await ptsDeltas(path);
  return {
    frames: await frameCount(path),
    ptsDeltaMs: { min: Math.min(...d), max: Math.max(...d) },
    streams: j.streams,
    container: j.format,
  };
}

const result: Record<string, unknown> = { tech: TECH, runs: RUNS, totalSeconds: TOTAL_S, totalFrames: TOTAL_FRAMES, machine: machine() };

// ---- (a) single graph, medium ----
const singleOut = join(dir, "single-medium.mp4");
const singleRuns: Run[] = [];
for (let i = 0; i < RUNS; i++) singleRuns.push(await ff([...CAPS, ...singleArgs("medium", singleOut)]));
result.single = { ...stat(singleRuns), sizeMB: mb(singleOut), facts: await facts(singleOut) };
console.log("single", JSON.stringify((result.single as any).medianMs), (result.single as any).peakRssMB, "MB");

// ---- (b) two-pass per intermediate ----
const twoPass: Record<string, unknown> = {};
const finals: Record<string, string> = {};
for (const inter of INTER_SET) {
  const rounds: Run[][] = [];
  let d = "";
  for (let i = 0; i < RUNS; i++) {
    const r = await pass1(inter);
    rounds.push(r.runs);
    d = r.dir;
  }
  const perClipMs = SPECS.map((_, c) => Math.round(median(rounds.map((r) => r[c]!.ms))));
  const perClipRss = SPECS.map((_, c) => Math.round(Math.max(...rounds.map((r) => r[c]!.rssMB))));
  const perClipMB = SPECS.map((_, c) => mb(join(d, `clip-${String(c).padStart(2, "0")}.mkv`)));
  const out = join(dir, `two-${inter.name}-medium.mp4`);
  const p2: Run[] = [];
  for (let i = 0; i < RUNS; i++) p2.push(await pass2(d, "medium", out));
  finals[inter.name] = out;
  const pass1Ms = perClipMs.reduce((a, b) => a + b, 0);
  const p2s = stat(p2);
  twoPass[inter.name] = {
    perClip: SPECS.map((s: ClipSpec, c) => ({ kind: s.kind, motion: s.motion, seconds: s.seconds, ms: perClipMs[c], rssMB: perClipRss[c], sizeMB: perClipMB[c] })),
    pass1TotalMs: pass1Ms,
    pass1PeakRssMB: Math.max(...perClipRss),
    intermediatesTotalMB: +perClipMB.reduce((a, b) => a + b, 0).toFixed(1),
    pass2: p2s,
    totalMs: pass1Ms + p2s.medianMs,
    peakRssMB: Math.max(...perClipRss, p2s.peakRssMB),
    finalSizeMB: mb(out),
    facts: await facts(out),
  };
  console.log(inter.name, "pass1", pass1Ms, "ms; pass2", p2s.medianMs, "ms; rss", (twoPass[inter.name] as any).peakRssMB, "MB; inter", (twoPass[inter.name] as any).intermediatesTotalMB, "MB");
}
result.twoPass = twoPass;

// ---- quality: SSIM of each two-pass final vs the single graph, and vs the qp0 two-pass ----
const quality: Record<string, unknown> = {};
for (const inter of INTER_SET) {
  quality[inter.name] = {
    vsSingle: await compare(finals[inter.name]!, singleOut, true),
    vsQp0Final: inter.name === "qp0" || !finals.qp0 ? null : await compare(finals[inter.name]!, finals.qp0!, true),
  };
  console.log("quality", inter.name, JSON.stringify(quality[inter.name]));
}
result.quality = quality;

// ---- Q4: presets on the final encode (pass 2 from the crf8 intermediates) ----
const presets: Record<string, unknown> = {};
async function concatCopy(d: string, out: string) {
  await ff(["-f", "concat", "-protocol_whitelist", "file", "-i", "list.txt", "-c", "copy", out], { cwd: d });
  return out;
}
if (!STRESS) {
  // fidelity of the intermediates themselves (decoded, vs qp0)
  const refQ = await concatCopy(join(dir, "qp0"), join(dir, "qp0-concat.mkv"));
  const fid: Record<string, unknown> = {};
  for (const n of ["crf8", "crf10"]) {
    fid[n] = await compare(await concatCopy(join(dir, n), join(dir, `${n}-concat.mkv`)), refQ);
    console.log("intermediate fidelity", n, JSON.stringify(fid[n]));
  }
  result.intermediateFidelity = fid;
  for (const preset of ["fast", "medium", "slow"]) {
    const out = join(dir, `preset-${preset}.mp4`);
    const rs: Run[] = [];
    const hashes: string[] = [];
    for (let i = 0; i < RUNS; i++) {
      rs.push(await pass2(join(dir, "crf8"), preset, out));
      hashes.push(new Bun.CryptoHasher("sha256").update(readFileSync(out)).digest("hex").slice(0, 12));
    }
    presets[preset] = {
      ...stat(rs), deterministic: new Set(hashes).size === 1, sizeMB: mb(out),
      kbps: Math.round((statSync(out).size * 8) / TOTAL_S / 1000), vsLossless: await compare(out, refQ),
    };
    console.log("preset", preset, JSON.stringify(presets[preset]));
  }
}
result.presets = presets;
result.loadavgEnd = loadavg().map((x) => Math.round(x * 10) / 10);
saveResult(NAME, result);
void FFMPEG; void run;
