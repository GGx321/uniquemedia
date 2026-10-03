/**
 * Measures the peak RSS of the layer pass and of pass 2 over it (3b.6): `bun studio/scripts/layers/measureLayerRss.ts`.
 *
 * It builds a 15 s timeline of ten 1.5 s photo clips through the real pass-1 builder, then, for each scenario, plans the
 * layer pass with the real planner and runs every call and then pass 2 under `/usr/bin/time`, with the real argv. Prints
 * each call's measured peak against what the cost model said (`LAYER_CALL_BUDGET_BYTES`) and pass 2's against the
 * 768 MiB `peakRSS` the render pool is sized by. For comparison it also runs pass 2 with the same layers as direct overlays
 * (the 3a.5 path): the numbers that decided the layer pass.
 *
 * Needs `/usr/bin/time` with `-l` (macOS) or `-v` (GNU). Run by hand; not part of the test suite.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
}

const SCENARIOS: readonly Scenario[] = [
  { name: "no layer", text: 0, stickers: 0, stickerSize: 0.203 },
  { name: "10 text", text: 10, stickers: 0, stickerSize: 0.203 },
  { name: "10 stickers, 0.203 (default, 219 px)", text: 0, stickers: 10, stickerSize: 0.203 },
  { name: "10 stickers, 0.6 (648 px)", text: 0, stickers: 10, stickerSize: 0.6 },
  { name: "10 text + 10 stickers, 0.203: the cap", text: 10, stickers: 10, stickerSize: 0.203 },
  { name: "10 text + 10 stickers, 0.6 (648 px): the cap at the largest size", text: 10, stickers: 10, stickerSize: 0.6 },
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
    // A caption raster is about 930 x 140 px: a translucent plaque, the shape of the engine's widest text PNG.
    const text = join(dir, "text.png");
    const textMade = await run([ffmpeg, "-hide_banner", "-y", "-nostdin", "-f", "lavfi", "-i", "color=c=white@0.85:s=930x140,format=rgba,noise=alls=30:allf=t:all_seed=3", "-frames:v", "1", "-c:v", "png", "-pix_fmt", "rgba", text]);
    if (textMade.code !== 0) throw new Error(textMade.stderr);

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
    const pass2Of = (overlays: readonly OverlayInput[]) => buildPass2({ clips, clipDir: dir, output: join(dir, "final.mp4"), overlays, audio: { kind: "silent" } });
    const prepare = (job: { cwd: string; listFileName: string; listFileContents: string }): void => {
      mkdirSync(job.cwd, { recursive: true });
      writeFileSync(join(job.cwd, job.listFileName), job.listFileContents);
    };

    console.log(`15 s, ${TOTAL_FRAMES} frames, peakRSS budget ${PEAK_RSS_BUDGET_MIB} MiB, a layer call's modelled budget ${LAYER_CALL_BUDGET_BYTES / MIB} MiB\n`);
    // An optional argument keeps only the scenarios whose name contains it: `bun measureLayerRss.ts "the cap"`.
    const only = process.argv[2];
    for (const sc of SCENARIOS.filter((s) => only === undefined || s.name.includes(only))) {
      const layers: OverlayInput[] = [];
      for (let k = 0; k < sc.text; k++) {
        layers.push({ path: text, format: "png", box: textBox({ x: 0.5, y: 0.05 + 0.04 * k }, { w: 930, h: 140 }), resize: false, startFrame: 3 * k, endFrame: TOTAL_FRAMES - 3 * k });
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

      if (layers.length > 0) {
        const direct = pass2Of(layers);
        prepare(direct);
        const d = await measured(direct.argv, direct.cwd);
        console.log(`  direct overlays in pass 2 (the 3a.5 path): ${d.mib.toFixed(0)} MiB, ${d.seconds.toFixed(1)} s, ${d.mib <= PEAK_RSS_BUDGET_MIB ? "within" : "OVER"}`);
      }

      const plan = buildLayerPass({ layers, totalFrames: TOTAL_FRAMES, clipDir: dir });
      let layerSeconds = 0;
      let worstCall = 0;
      for (const job of plan.jobs) {
        const m = await measured(job.argv);
        layerSeconds += m.seconds;
        worstCall = Math.max(worstCall, m.mib);
        console.log(`  layer call ${job.index}: ${job.layerCount} layers, ${m.mib.toFixed(0)} MiB measured, ${(job.modelledBytes / MIB).toFixed(0)} MiB modelled, ${m.seconds.toFixed(1)} s`);
      }
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
