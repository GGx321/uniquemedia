// SP3 probe: per-platform facts of the ffmpeg binary Studio ships (ffmpeg-static).
// Usage: bun spike/ffmpeg-facts/probe.ts [report.json]
// Exits non-zero if an item the Stage 3 plan REQUIRES is missing or a smoke fails.
import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";
import { ffmpegPath } from "../../studio/node/ffmpegBinary";

const require = createRequire(import.meta.url);
const FFMPEG = ffmpegPath();

// Items the plan requires. drawtext, ffv1, libx264rgb and the hardware
// encoders are recorded but never fail the run.
const FILTERS_REQUIRED = [
  "zoompan", "overlay", "fade", "xfade", "concat", "fps", "transpose", "zscale",
  "tonemap", "colorspace", "ebur128", "volume", "aresample", "apad", "atrim",
  "anullsrc", "scale", "crop", "pad", "format", "setsar", "setpts", "trim",
  "loudnorm", "alimiter", "split",
];
const FILTERS_RECORD = ["drawtext", "acrossfade", "amix", "aformat", "afade", "atempo", "hstack"];
const DEMUXERS_REQUIRED = ["concat", "mov", "matroska", "gif", "apng", "image2", "mp3", "aac", "wav", "flac", "ogg"];
const DECODERS_REQUIRED = [
  "h264", "hevc", "vp9", "av1", "prores", "png", "mjpeg", "gif", "apng", "webp",
  "mp3", "aac", "aac_latm", "flac", "alac", "pcm_s16le", "vorbis", "opus",
];
const ENCODERS_REQUIRED = ["libx264", "aac", "png"];
const HW_ENCODERS = ["h264_videotoolbox", "h264_nvenc", "h264_qsv", "h264_amf", "h264_mf"];
const ENCODERS_RECORD = [...HW_ENCODERS, "ffv1", "libx264rgb"];

type Run = { code: number; stdout: string; stderr: string; ms: number };

async function run(bin: string, args: string[]): Promise<Run> {
  const t0 = performance.now();
  const p = Bun.spawn([bin, ...args], { stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr, ms: Math.round(performance.now() - t0) };
}

const ff = (args: string[]) => run(FFMPEG, ["-hide_banner", ...args]);

// Rows of `-filters` / `-encoders` etc. look like " <flags> <name> ..." with a single
// leading space; the legend lines above them use two spaces or carry "=".
function listNames(out: string): Set<string> {
  const names = new Set<string>();
  for (const line of out.split(/\r?\n/)) {
    const m = /^ [A-Z.|]{1,8} +([^\s=]+)/.exec(line);
    if (m?.[1]) for (const n of m[1].split(",")) names.add(n);
  }
  return names;
}

function presence(all: Set<string>, wanted: string[]): Record<string, boolean> {
  return Object.fromEntries(wanted.map((n) => [n, all.has(n)]));
}

function ffprobePath(): string | null {
  try {
    const p = require("ffprobe-static") as { path?: string };
    return p.path && existsSync(p.path) ? p.path : null;
  } catch {
    return null;
  }
}

type Smoke = { name: string; ok: boolean; ms: number; detail: string };
type Measure = { duration: number; frames: number; via: string };

async function main() {
  const reportPath = process.argv[2] ?? `ffmpeg-facts-${process.platform}-${process.arch}.json`;
  const missing: string[] = [];

  const version = await ff(["-version"]);
  const versionLine = version.stdout.split(/\r?\n/)[0] ?? "";
  const buildconf = await ff(["-buildconf"]);
  const configure = buildconf.stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.startsWith("--"));
  const lic = await ff(["-L"]);
  const licenseText = lic.stdout.split(/\r?\n/).slice(0, 3).join(" ").trim();
  const isNonfree = configure.includes("--enable-nonfree");
  const isGpl = configure.includes("--enable-gpl") || /GNU General Public/i.test(licenseText);

  const filters = listNames((await ff(["-filters"])).stdout);
  const demuxers = listNames((await ff(["-demuxers"])).stdout);
  const decoders = listNames((await ff(["-decoders"])).stdout);
  const encoders = listNames((await ff(["-encoders"])).stdout);
  const hw = (await ff(["-hwaccels"])).stdout
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("Hardware acceleration methods"));

  const f = presence(filters, [...FILTERS_REQUIRED, ...FILTERS_RECORD]);
  const d = presence(demuxers, DEMUXERS_REQUIRED);
  const dec = presence(decoders, DECODERS_REQUIRED);
  const enc = presence(encoders, [...ENCODERS_REQUIRED, ...ENCODERS_RECORD]);
  for (const n of FILTERS_REQUIRED) if (!f[n]) missing.push(`filter:${n}`);
  for (const n of DEMUXERS_REQUIRED) if (!d[n]) missing.push(`demuxer:${n}`);
  for (const n of DECODERS_REQUIRED) if (!dec[n]) missing.push(`decoder:${n}`);
  for (const n of ENCODERS_REQUIRED) if (!enc[n]) missing.push(`encoder:${n}`);

  const dir = mkdtempSync(join(tmpdir(), "ffmpeg-facts-"));
  const smokes: Smoke[] = [];
  const probe = ffprobePath();

  async function measure(file: string): Promise<Measure> {
    if (probe) {
      const r = await run(probe, [
        "-v", "error", "-count_frames", "-select_streams", "v:0",
        "-show_entries", "stream=nb_read_frames:format=duration", "-of", "json", file,
      ]);
      const j = JSON.parse(r.stdout) as {
        streams?: { nb_read_frames?: string }[];
        format?: { duration?: string };
      };
      return {
        duration: Number(j.format?.duration ?? Number.NaN),
        frames: Number(j.streams?.[0]?.nb_read_frames ?? Number.NaN),
        via: "ffprobe-static",
      };
    }
    const r = await ff(["-i", file, "-map", "0:v:0", "-f", "null", "-"]);
    const fm = [...r.stderr.matchAll(/frame=\s*(\d+)/g)].pop();
    const tm = [...r.stderr.matchAll(/time=(\d+):(\d+):([\d.]+)/g)].pop();
    return {
      duration: tm ? Number(tm[1]) * 3600 + Number(tm[2]) * 60 + Number(tm[3]) : Number.NaN,
      frames: fm ? Number(fm[1]) : Number.NaN,
      via: "ffmpeg -f null",
    };
  }

  async function smoke(
    name: string,
    args: string[],
    check?: (m: Measure) => string | null,
    outFile?: string,
  ): Promise<void> {
    const r = await ff(["-y", ...args]);
    let ok = r.code === 0;
    let detail = ok
      ? "ok"
      : `exit ${r.code}: ${r.stderr.trim().split(/\r?\n/).slice(-3).join(" | ")}`;
    if (ok && check && outFile) {
      const m = await measure(outFile);
      const problem = check(m);
      if (problem) {
        ok = false;
        detail = problem;
      } else {
        detail = `ok (duration ${m.duration.toFixed(3)} s, ${m.frames} frames, via ${m.via})`;
      }
    }
    smokes.push({ name, ok, ms: r.ms, detail });
    if (!ok) missing.push(`smoke:${name}`);
  }

  const lav = (spec: string) => ["-f", "lavfi", "-i", spec];

  // 1. Main graph. Two 1 s clips crossfaded by 0.4 s => 1.6 s at 30 fps => 48 frames.
  const mainFile = join(dir, "main.mp4");
  await smoke(
    "graph zoompan+overlay+xfade+ebur128+aresample+apad+atrim -> libx264+aac",
    [
      ...lav("testsrc2=s=320x240:d=1:r=30"),
      ...lav("testsrc2=s=320x240:d=1:r=30,hue=h=90"),
      ...lav("color=c=red@0.5:s=64x64:d=2:r=30,format=yuva420p"),
      ...lav("sine=f=440:d=1"),
      "-filter_complex",
      "[0:v]zoompan=z='min(zoom+0.01,1.3)':d=1:s=320x240:fps=30[a];" +
        "[1:v]zoompan=z='min(zoom+0.01,1.3)':d=1:s=320x240:fps=30[b];" +
        "[a][b]xfade=transition=fade:duration=0.4:offset=0.6[x];" +
        "[x][2:v]overlay=10:10:eof_action=endall,format=yuv420p[v];" +
        "[3:a]ebur128=peak=true,aresample=48000,apad=whole_dur=1.6,atrim=end=1.6[a]",
      "-map", "[v]", "-map", "[a]", "-c:v", "libx264", "-crf", "18", "-c:a", "aac", "-b:a", "128k",
      "-movflags", "+faststart", mainFile,
    ],
    (m) => {
      if (Math.abs(m.duration - 1.6) > 0.1) return `duration ${m.duration} != ~1.6 (${m.via})`;
      if (m.frames !== 48) return `frames ${m.frames} != 48 (${m.via})`;
      return null;
    },
    mainFile,
  );

  // 2. Concat demuxer over two copies of the main clip (the pass-2 shape).
  if (existsSync(mainFile)) {
    const list = join(dir, "list.txt");
    const p = mainFile.replace(/\\/g, "/");
    writeFileSync(list, `file '${p}'\nfile '${p}'\n`);
    const cat = join(dir, "cat.mp4");
    await smoke(
      "concat demuxer with -protocol_whitelist, stream copy",
      ["-protocol_whitelist", "file", "-f", "concat", "-safe", "0", "-i", list, "-c", "copy", cat],
      (m) => (Math.abs(m.duration - 3.2) > 0.2 ? `duration ${m.duration} != ~3.2 (${m.via})` : null),
      cat,
    );
  }

  // 3. HDR tonemap chain and colorspace. The input must be colour-tagged: an untagged
  // frame makes zscale fail with "no path between colorspaces".
  await smoke("HDR (PQ, tagged) zscale+tonemap chain to BT.709", [
    ...lav("testsrc2=s=320x240:d=0.5:r=30"),
    "-vf",
    "format=yuv420p10le,setparams=colorspace=bt2020nc:color_primaries=bt2020:color_trc=smpte2084:range=tv,zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p",
    "-f", "null", "-",
  ]);
  await smoke("colorspace filter", [
    ...lav("testsrc2=s=320x240:d=0.5:r=30"),
    "-vf", "format=yuv420p,colorspace=all=bt709:iall=bt601-6-625:fast=1",
    "-f", "null", "-",
  ]);

  // 4. Video plumbing filters.
  await smoke("fps+transpose+scale+crop+pad+setsar+setpts+trim+fade+split", [
    ...lav("testsrc2=s=320x240:d=1:r=25"),
    "-filter_complex",
    "[0:v]fps=30,transpose=1,scale=180:-2,crop=160:200,pad=180:220:10:10,setsar=1,setpts=PTS-STARTPTS,trim=duration=0.8,fade=t=in:d=0.2,split[a][b];[a][b]hstack",
    "-f", "null", "-",
  ]);

  // 5. Audio chain.
  await smoke("anullsrc+volume+loudnorm+alimiter", [
    ...lav("anullsrc=r=48000:cl=stereo"),
    ...lav("sine=f=1000:d=1"),
    "-filter_complex",
    "[1:a]volume=0.5,loudnorm=I=-16:TP=-1.5:LRA=11,alimiter=limit=0.9[a]",
    "-map", "[a]", "-t", "1", "-f", "null", "-",
  ]);

  // 6. PNG and APNG (alpha) round trip.
  await smoke("png encode with alpha", [
    ...lav("color=c=red@0.5:s=32x32:d=0.1:r=10,format=rgba"),
    "-frames:v", "1", join(dir, "a.png"),
  ]);
  await smoke("apng encode", [
    ...lav("testsrc2=s=64x64:d=0.5:r=10,format=rgba"),
    "-plays", "0", "-f", "apng", join(dir, "a.apng"),
  ]);
  if (existsSync(join(dir, "a.apng"))) {
    await smoke("apng demux and decode", ["-i", join(dir, "a.apng"), "-f", "null", "-"]);
  }

  // 7. Hardware H.264 encoders: informational, never fail the run.
  const hwSmokes: Smoke[] = [];
  for (const e of HW_ENCODERS) {
    if (!enc[e]) continue;
    const r = await ff(["-y", ...lav("testsrc2=s=320x240:d=0.5:r=30"), "-c:v", e, "-f", "null", "-"]);
    hwSmokes.push({
      name: `hw encode ${e} (informational)`,
      ok: r.code === 0,
      ms: r.ms,
      detail: r.code === 0 ? "ok" : (r.stderr.trim().split(/\r?\n/).pop() ?? ""),
    });
  }

  rmSync(dir, { recursive: true, force: true });

  const report = {
    platform: process.platform,
    arch: process.arch,
    bun: Bun.version,
    ffmpegPath: FFMPEG,
    ffprobe: probe ? "ffprobe-static" : "unavailable (ffmpeg -f null fallback)",
    versionLine,
    license: licenseText,
    isGpl,
    isNonfree,
    configure,
    hwaccels: hw,
    filters: f,
    demuxers: d,
    decoders: dec,
    encoders: enc,
    smokes,
    hwSmokes,
    missingRequired: missing,
  };
  writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`);

  const yn = (r: Record<string, boolean>) =>
    Object.entries(r)
      .map(([k, v]) => `${v ? "+" : "-"}${k}`)
      .join(" ");
  console.log(`ffmpeg: ${versionLine}`);
  console.log(`platform: ${process.platform}-${process.arch}, binary: ${FFMPEG}`);
  console.log(`license: ${isNonfree ? "NONFREE" : isGpl ? "GPL" : "LGPL"} (${licenseText})`);
  console.log(`hwaccels: ${hw.join(", ") || "none"}`);
  console.log(`filters:  ${yn(f)}`);
  console.log(`demuxers: ${yn(d)}`);
  console.log(`decoders: ${yn(dec)}`);
  console.log(`encoders: ${yn(enc)}`);
  for (const s of [...smokes, ...hwSmokes]) {
    console.log(`smoke ${s.ok ? "PASS" : "FAIL"} ${String(s.ms).padStart(5)}ms  ${s.name}: ${s.detail}`);
  }
  console.log(`report: ${reportPath}`);
  if (missing.length > 0) {
    console.error(`\nFAIL: required items missing or failing: ${missing.join(", ")}`);
    process.exit(1);
  }
  console.log("\nOK: every required item present, all smokes passed");
}

await main();
