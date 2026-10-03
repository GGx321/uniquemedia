/**
 * Measures the peak RSS of the layer pass and of pass 2 over it (3b.6): `bun studio/scripts/layers/measureLayerRss.ts`.
 *
 * It builds a 15 s timeline of ten 1.5 s photo clips through the real pass-1 builder, then, for each scenario, plans the
 * layer pass with the real planner and runs every call and then pass 2 under `/usr/bin/time`, with the real argv. Prints
 * each call's measured peak against what the cost model said (`LAYER_CALL_BUDGET_BYTES`) and pass 2's against the
 * 768 MiB `peakRSS` the render pool is sized by, and the disk the layer files take. The cheap way to see how much memory the layers
 * cost WITHOUT the layer pass is gone with the path (3b.5 measured it: ten default stickers took pass 2 to 816 MiB).
 *
 * `--music` adds a 20 s stored track (AAC in a mov, as the track store keeps them) to every pass-2 call, which also puts the process under
 * the track input's `-max_alloc 64 MiB`, so the FFV1 layer file is measured decoding under it.
 *
 * Needs `/usr/bin/time` with `-l` (macOS) or `-v` (GNU). Run by hand; not part of the test suite.
 */
import { mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clip } from "../../shared/engine/montage";
import { stickerBox, textBox } from "../../shared/montage";
import { STICKER_MANIFEST } from "../../shared/stickers/manifest";
import { parseMaxRssBytes } from "../stickers/measureStickerRss";

const MIB = 1024 * 1024;
const PEAK_RSS_BUDGET_MIB = 768;
const TOTAL_FRAMES = 450;

interface Scenario {
  readonly name: string;
  readonly text: number;
  readonly stickers: number;
  /** The sticker box's width as a fraction of the frame width. */
  readonly stickerSize: number;
  /** Text layers are REAL captions drawn by the engine's rasteriser («Без фона», emoji, scale 1.6) and last the whole timeline: the heaviest on disk. */
  readonly real?: boolean;
}

const SCENARIOS: readonly Scenario[] = [
  { name: "no layer", text: 0, stickers: 0, stickerSize: 0.203 },
  { name: "10 text", text: 10, stickers: 0, stickerSize: 0.203 },
  { name: "10 stickers, 0.203 (default, 219 px)", text: 0, stickers: 10, stickerSize: 0.203 },
  { name: "10 stickers, 0.6 (648 px)", text: 0, stickers: 10, stickerSize: 0.6 },
  { name: "10 text + 10 stickers, 0.203: the cap", text: 10, stickers: 10, stickerSize: 0.203 },
  { name: "10 text + 10 stickers, 0.6 (648 px): the cap at the largest size", text: 10, stickers: 10, stickerSize: 0.6 },
  { name: "10 REAL captions (shadow, emoji, 1.6, whole timeline) + 10 stickers, 0.6 (648 px)", text: 10, stickers: 10, stickerSize: 0.6, real: true },
];

async function run(argv: readonly string[], cwd?: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([...argv], { stdout: "ignore", stderr: "pipe", ...(cwd === undefined ? {} : { cwd }) });
  const [stderr, code] = await Promise.all([Bun.readableStreamToText(proc.stderr), proc.exited]);
  return { code, stderr };
}

async function main(): Promise<void> {
  const { ffmpegPath } = await import("../../node/ffmpegBinary");
  const { buildPass1 } = await import("../../engine/render/pass1");
  const { buildPass2 } = await import("../../engine/render/pass2");
  const { buildLayerPass, LAYER_CALL_BUDGET_BYTES } = await import("../../engine/render/layerPass");
  const { STICKER_ASSET_DIR } = await import("../stickers/generateStickers");
  type OverlayInput = import("../../engine/render/types").OverlayInput;
  const ffmpeg = ffmpegPath();
  // An optional argument keeps only the scenarios whose name contains it: `bun measureLayerRss.ts "REAL"`.
  const only = process.argv.slice(2).find((a) => !a.startsWith("--"));
  const withMusic = process.argv.includes("--music");
  const timeFlag = process.platform === "darwin" ? "-l" : "-v";
  const dir = mkdtempSync(join(tmpdir(), "b6-rss-"));

  /** `/usr/bin/time` around one ffmpeg call: the peak RSS in MiB and the wall time in seconds. */
  async function measured(argv: readonly string[], cwd?: string): Promise<{ mib: number; seconds: number }> {
    const started = performance.now();
    const r = await run(["/usr/bin/time", timeFlag, ffmpeg, ...argv], cwd);
    const seconds = (performance.now() - started) / 1000;
    if (r.code !== 0) throw new Error(`ffmpeg exited ${r.code}\n${r.stderr.slice(-800)}`);
    const rss = parseMaxRssBytes(r.stderr);
    if (rss === undefined) throw new Error("no peak RSS in the output of time");
    return { mib: rss / MIB, seconds };
  }

  try {
    const photo = join(dir, "photo.jpg");
    const made = await run([ffmpeg, "-hide_banner", "-y", "-nostdin", "-f", "lavfi", "-i", "testsrc2=s=720x1280,noise=alls=20:allf=t+u:all_seed=7", "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj420p", photo]);
    if (made.code !== 0) throw new Error(made.stderr);
    // A caption raster is about 930 x 140 px: an opaque plaque with two bars of black ink, the shape of the engine's widest text PNG (flat colours, as a real raster is: noise would not compress and would measure the disk, not the render).
    const text = join(dir, "text.png");
    const textMade = await run([ffmpeg, "-hide_banner", "-y", "-nostdin", "-f", "lavfi", "-i", "color=c=0xffd166:s=930x140,format=rgba,drawbox=x=36:y=36:w=858:h=24:c=black:t=fill,drawbox=x=36:y=80:w=640:h=24:c=black:t=fill", "-frames:v", "1", "-c:v", "png", "-pix_fmt", "rgba", text]);
    if (textMade.code !== 0) throw new Error(textMade.stderr);

    // Real captions: the engine's own renderer (resvg-wasm, the bundled fonts and emoji), «Без фона» (the shadow), scale 1.6, emoji at both ends.
    const realCaptions: { path: string; w: number; h: number }[] = [];
    if (SCENARIOS.some((sc) => sc.real === true && (only === undefined || sc.name.includes(only)))) {
      const { createTextRasteriser, RASTER_WASM } = await import("../../engine/text/rasteriser");
      const { createCaptionRenderer } = await import("../../engine/text/caption/renderer");
      const { openEmojiFont } = await import("../../engine/text/emoji/emojiFont");
      const { loadPinnedEmojiFont } = await import("../../engine/text/emoji/emojiFont.testkit");
      const root = join(import.meta.dir, "..", "..", "..");
      const rasteriser = createTextRasteriser({ wasmPath: join(root, "node_modules", "@resvg", "resvg-wasm", RASTER_WASM.file), fontDir: join(root, "studio", "assets", "fonts") });
      await rasteriser.init();
      const renderer = createCaptionRenderer({ rasteriser, emoji: openEmojiFont(await loadPinnedEmojiFont()) });
      for (let k = 0; k < 10; k++) {
        const image = await renderer.render({ value: `\u2600\uFE0F slow morning in lisbon ${k} \u2615`, font: "manrope", style: "none", color: "#ffffff", scale: 1.6 });
        const path = join(dir, `real-${k}.png`);
        writeFileSync(path, image.png);
        realCaptions.push({ path, w: image.width, h: image.height });
      }
    }

    const clips: Clip[] = Array.from({ length: 10 }, (_, i) => ({
      clipId: `c${i}`,
      durationMs: 1500,
      transitionIn: "cut",
      kind: "photo",
      cell: { photo: { source: "scene", photoId: "p" }, focus: null },
      motion: "static",
    }));
    for (const job of buildPass1({ seed: 1, clips, resolvePhoto: () => ({ path: photo, width: 720, height: 1280 }), clipDir: dir })) {
      const r = await run([ffmpeg, ...job.argv]);
      if (r.code !== 0) throw new Error(r.stderr.slice(-800));
    }
    // A stored track is AAC in a mov (the track store's own shape); 20 s is longer than the 15 s timeline.
    const track = join(dir, "track.m4a");
    if (withMusic) {
      const made = await run([ffmpeg, "-hide_banner", "-y", "-nostdin", "-f", "lavfi", "-i", "sine=frequency=440:duration=20,aformat=channel_layouts=stereo:sample_rates=48000", "-c:a", "aac", "-b:a", "192k", "-f", "mov", track]);
      if (made.code !== 0) throw new Error(made.stderr);
    }
    const pass2Of = (overlays: readonly OverlayInput[]) =>
      buildPass2({ clips, clipDir: dir, output: join(dir, "final.mp4"), overlays, audio: withMusic ? { kind: "music", path: track, startMs: 0, gainDb: 0 } : { kind: "silent" } });
    const prepare = (job: { cwd: string; listFileName: string; listFileContents: string }): void => {
      mkdirSync(job.cwd, { recursive: true });
      writeFileSync(join(job.cwd, job.listFileName), job.listFileContents);
    };

    console.log(`15 s${withMusic ? " with a 20 s track" : ""}, ${TOTAL_FRAMES} frames, peakRSS budget ${PEAK_RSS_BUDGET_MIB} MiB, a layer call's modelled budget ${LAYER_CALL_BUDGET_BYTES / MIB} MiB\n`);
    for (const sc of SCENARIOS.filter((s) => only === undefined || s.name.includes(only))) {
      const layers: OverlayInput[] = [];
      for (let k = 0; k < sc.text; k++) {
        const real = sc.real === true ? realCaptions[k] : undefined;
        if (sc.real === true && real === undefined) throw new Error("the real captions were not made");
        layers.push({
          path: real?.path ?? text,
          format: "png",
          box: textBox({ x: 0.5, y: 0.05 + 0.04 * k }, { w: real?.w ?? 930, h: real?.h ?? 140 }),
          resize: false,
          startFrame: sc.real === true ? 0 : 3 * k,
          endFrame: sc.real === true ? TOTAL_FRAMES : TOTAL_FRAMES - 3 * k,
        });
      }
      for (let k = 0; k < sc.stickers; k++) {
        const entry = STICKER_MANIFEST[k % STICKER_MANIFEST.length];
        if (entry === undefined) throw new Error("empty sticker manifest");
        layers.push({
          path: join(STICKER_ASSET_DIR, `${entry.id}.apng`),
          format: "apng",
          box: stickerBox({ x: 0.2 + 0.06 * k, y: 0.5, size: sc.stickerSize }),
          resize: true,
          startFrame: 0,
          endFrame: TOTAL_FRAMES,
          loopFrames: entry.loopFrames,
          sourceSize: { w: entry.size, h: entry.size },
        });
      }
      console.log(sc.name);

      const plan = buildLayerPass({ layers, totalFrames: TOTAL_FRAMES, clipDir: dir });
      let layerSeconds = 0;
      let worstCall = 0;
      for (const job of plan.jobs) {
        const m = await measured(job.argv);
        layerSeconds += m.seconds;
        worstCall = Math.max(worstCall, m.mib);
        console.log(`  layer call ${job.index}: ${job.layerCount} layers, ${m.mib.toFixed(0)} MiB measured, ${(job.modelledBytes / MIB).toFixed(0)} MiB modelled, ${m.seconds.toFixed(1)} s`);
      }
      // The job folder's disk at its fullest, before pass 2 ends it: the pass-1 clips (CRF 8) and every layer file (kept until the job ends).
      const sizeOf = (match: RegExp): number => readdirSync(dir).filter((f) => match.test(f)).reduce((n, f) => n + statSync(join(dir, f)).size, 0) / MIB;
      if (plan.jobs.length > 0) console.log(`  disk: ${sizeOf(/^clip-\d+\.mkv$/).toFixed(0)} MiB of clips + ${sizeOf(/^layers-\d+\.mkv$/).toFixed(0)} MiB of layer files (${plan.jobs.length} call${plan.jobs.length === 1 ? "" : "s"})`);
      const pass2 = pass2Of(plan.final === null ? [] : [plan.final]);
      prepare(pass2);
      const p = await measured(pass2.argv, pass2.cwd);
      console.log(`  pass 2 over the layer file: ${p.mib.toFixed(0)} MiB, ${p.seconds.toFixed(1)} s, ${p.mib <= PEAK_RSS_BUDGET_MIB ? "within" : "OVER"}; worst layer call ${worstCall.toFixed(0)} MiB, layer pass ${layerSeconds.toFixed(1)} s in all\n`);
      for (const job of plan.jobs) rmSync(job.output, { force: true });
      rmSync(join(dir, "final.mp4"), { force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
