import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  createBackends,
  outputName,
  resolveEdgeMode,
  resolveExportFormat,
  routeForInput,
  uniquifyRoute,
} from "./node/mediaRoute";
import type { StartOptions } from "./core/types";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const input = process.argv[2];
  if (!input || input.startsWith("--")) {
    console.error("usage: uniquify <input.mp4|input.jpg> --count N [--strength 1.0] " +
      "[--format original|reels|feed|square] [--edges crop|fit|auto] [--out DIR] " +
      "[--target 45] [--seed 1] [--no-spoof]\n" +
      "  --format defaults to reels for video and original for photo, so a still keeps its framing.\n" +
      "  --edges says how a still carries its shift at the frame edge: crop cuts an off-centre\n" +
      "  window out, fit shrinks the picture and pads it back so nothing is lost, auto decides\n" +
      "  from the picture (the default) and is ignored for video.");
    process.exit(1);
  }

  const count = Number(arg("count", "5"));
  const outDir = arg("out", "out")!;
  const seedBase = Number(arg("seed", String(Math.floor(Date.now() % 1e6))));

  mkdirSync(outDir, { recursive: true });
  // The kind comes from the file's own bytes: a `.jpg` that is really an MP4
  // still goes down the video path. It is resolved before the options are built
  // because one of them — the export format — defaults differently per medium.
  const route = await routeForInput(input, createBackends());

  const opts: StartOptions = {
    strength: Number(arg("strength", "1.0")),
    exportFormat: resolveExportFormat(arg("format"), route),
    keepTrendAudio: arg("keep-audio") !== undefined,
    allowMirror: arg("mirror") !== undefined,
    targetDistance: Number(arg("target", "38")),
    spoofMetadata: arg("no-spoof") === undefined,
    edgeMode: resolveEdgeMode(arg("edges"), "auto"),
  };

  const results = await uniquifyRoute(route, input, opts, count, {
    seedBase,
    nowMs: Date.now(),
    outputPath: (i) => join(outDir, outputName("copy", i, route)),
    onProgress: (i, attempt) =>
      process.stdout.write(`\rcopy ${i + 1}/${count} (attempt ${attempt + 1})   `),
  });

  process.stdout.write("\n");
  for (const r of results) {
    const tag = r.verify.passed ? "OK " : "WARN";
    console.log(`[${tag}] copy ${r.index + 1}: distance=${r.verify.minDistance} -> ${r.outputPath}`);
  }
  const passed = results.filter((r) => r.verify.passed).length;
  console.log(`done: ${passed}/${results.length} passed target ${opts.targetDistance}`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
