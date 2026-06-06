import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { FfmpegExecutor } from "./node/ffmpegExecutor";
import { uniquify } from "./core/pipeline";
import type { CopyOptions, ExportFormat } from "./core/types";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : fallback;
}

async function main() {
  const input = process.argv[2];
  if (!input || input.startsWith("--")) {
    console.error("usage: uniquify <input.mp4> --count N [--strength 1.0] " +
      "[--format reels|feed|square] [--out DIR] [--target 90] [--seed 1]");
    process.exit(1);
  }

  const count = Number(arg("count", "5"));
  const outDir = arg("out", "out")!;
  const opts: CopyOptions = {
    strength: Number(arg("strength", "1.0")),
    exportFormat: (arg("format", "reels") as ExportFormat),
    keepTrendAudio: arg("keep-audio") !== undefined,
    allowMirror: arg("mirror") !== undefined,
    targetDistance: Number(arg("target", "90")),
  };
  const seedBase = Number(arg("seed", String(Math.floor(Date.now() % 1e6))));

  mkdirSync(outDir, { recursive: true });
  const executor = new FfmpegExecutor();

  const results = await uniquify(input, opts, executor, count, {
    seedBase,
    outputPath: (i) => join(outDir, `copy_${i + 1}.mp4`),
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
