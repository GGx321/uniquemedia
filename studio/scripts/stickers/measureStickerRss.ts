/**
 * Measures pass-2 peak RSS with animated stickers (3b.5, data for 3b.6's choice
 * between the loop-cache options): `bun studio/scripts/stickers/measureStickerRss.ts`.
 *
 * It builds a 15 s timeline of ten 1.5 s photo clips through the real pass-1 and
 * pass-2 builders and the bundled ffmpeg, then runs pass 2 alone under
 * `/usr/bin/time` with no sticker, one, three and ten of them, at the largest
 * size the UI allows (0.6 of the frame width, 648 px) and at the default one.
 * Prints the peak RSS of the pass-2 ffmpeg process against `peakRSS` (768 MiB)
 * and against 3b.6's option (b) byte formula, frames x w x h x 2.5.
 *
 * Needs `/usr/bin/time` with `-l` (macOS) or `-v` (GNU). Run by hand; not part of the test suite.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Clip } from "../../shared/engine/montage";
import { STICKER_MANIFEST } from "../../shared/stickers/manifest";
import { stickerBox } from "../../shared/montage";

/** The peak RSS in bytes from `/usr/bin/time -l` (macOS, bytes) or `-v` (GNU, kilobytes) output, if it is there. */
export function parseMaxRssBytes(stderr: string): number | undefined {
  const mac = /^\s*(\d+)\s+maximum resident set size\s*$/m.exec(stderr);
  if (mac?.[1] !== undefined) return Number(mac[1]);
  const gnu = /Maximum resident set size \(kbytes\):\s*(\d+)/.exec(stderr);
  if (gnu?.[1] !== undefined) return Number(gnu[1]) * 1024;
  return undefined;
}

const MIB = 1024 * 1024;
const PEAK_RSS_BUDGET_MIB = 768;

interface Scenario {
  readonly name: string;
  readonly stickers: readonly { readonly id: string; readonly size: number }[];
}

function scenarios(): Scenario[] {
  const ids = STICKER_MANIFEST.map((s) => s.id);
  const longest = STICKER_MANIFEST.reduce((a, b) => (b.loopFrames > a.loopFrames ? b : a)).id;
  const tenAt = (size: number): Scenario["stickers"] => Array.from({ length: 10 }, (_, i) => ({ id: ids[i % ids.length] ?? longest, size }));
  return [
    { name: "no sticker", stickers: [] },
    { name: "1 x heart-pulse, 0.203 (219 px, the default)", stickers: [{ id: "heart-pulse", size: 0.203 }] },
    { name: `1 x ${longest}, 0.6 (648 px)`, stickers: [{ id: longest, size: 0.6 }] },
    { name: "3 x the longest three, 0.6 (648 px)", stickers: [...STICKER_MANIFEST].sort((a, b) => b.loopFrames - a.loopFrames).slice(0, 3).map((s) => ({ id: s.id, size: 0.6 })) },
    { name: "10 x the set, 0.203 (default)", stickers: tenAt(0.203) },
    { name: "10 x the set, 0.6 (648 px): the cap at the largest size", stickers: tenAt(0.6) },
    { name: `10 x ${longest}, 0.6 (648 px): the worst of this set`, stickers: Array.from({ length: 10 }, () => ({ id: longest, size: 0.6 })) },
  ];
}

async function run(argv: readonly string[], cwd?: string): Promise<{ code: number; stderr: string }> {
  const proc = Bun.spawn([...argv], { stdout: "ignore", stderr: "pipe", cwd });
  const [stderr, code] = await Promise.all([Bun.readableStreamToText(proc.stderr), proc.exited]);
  return { code, stderr };
}

async function main(): Promise<void> {
  const { ffmpegPath } = await import("../../node/ffmpegBinary");
  const { buildPass1 } = await import("../../engine/render/pass1");
  const { buildPass2 } = await import("../../engine/render/pass2");
  const { STICKER_ASSET_DIR } = await import("./generateStickers");
  const ffmpeg = ffmpegPath();
  const dir = mkdtempSync(join(tmpdir(), "b5-rss-"));
  try {
    const photo = join(dir, "photo.jpg");
    const made = await run([ffmpeg, "-hide_banner", "-y", "-nostdin", "-f", "lavfi", "-i", "testsrc2=s=720x1280,noise=alls=20:allf=t+u:all_seed=7", "-frames:v", "1", "-c:v", "mjpeg", "-q:v", "2", "-pix_fmt", "yuvj420p", photo]);
    if (made.code !== 0) throw new Error(made.stderr);

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
    const totalFrames = 450;

    const timeFlag = process.platform === "darwin" ? "-l" : "-v";
    let baseline = 0;
    console.log(`pass 2 over ${clips.length} clips, ${totalFrames} frames (15 s), peakRSS budget ${PEAK_RSS_BUDGET_MIB} MiB\n`);
    for (const sc of scenarios()) {
      const overlays = sc.stickers.map((s) => ({
        path: join(STICKER_ASSET_DIR, `${s.id}.apng`),
        format: "apng" as const,
        box: stickerBox({ x: 0.5, y: 0.5, size: s.size }),
        resize: true,
        startFrame: 0,
        endFrame: totalFrames,
      }));
      const output = join(dir, "final.mp4");
      const job = buildPass2({ clips, clipDir: dir, output, overlays, audio: { kind: "silent" } });
      mkdirSync(job.cwd, { recursive: true });
      writeFileSync(join(job.cwd, job.listFileName), job.listFileContents);
      const started = performance.now();
      const r = await run(["/usr/bin/time", timeFlag, ffmpeg, ...job.argv], job.cwd);
      const seconds = (performance.now() - started) / 1000;
      if (r.code !== 0) throw new Error(`${sc.name}: ffmpeg exited ${r.code}\n${r.stderr.slice(-800)}`);
      const rss = parseMaxRssBytes(r.stderr);
      if (rss === undefined) throw new Error(`${sc.name}: no peak RSS in the output of time`);
      const mib = rss / MIB;
      if (sc.stickers.length === 0) baseline = mib;
      const predicted =
        sc.stickers.reduce((n, s) => {
          const entry = STICKER_MANIFEST.find((m) => m.id === s.id);
          const box = stickerBox({ x: 0.5, y: 0.5, size: s.size });
          return n + (entry?.loopFrames ?? 0) * box.w * box.h * 2.5;
        }, 0) / MIB;
      const verdict = mib <= PEAK_RSS_BUDGET_MIB ? "within" : "OVER";
      console.log(`${sc.name}\n  peak RSS ${mib.toFixed(0)} MiB (${(mib - baseline >= 0 ? "+" : "") + (mib - baseline).toFixed(0)} vs none), ${verdict} ${PEAK_RSS_BUDGET_MIB}; formula frames x w x h x 2.5 = ${predicted.toFixed(0)} MiB; ${seconds.toFixed(1)} s\n`);
      rmSync(output, { force: true });
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (import.meta.main) await main();
