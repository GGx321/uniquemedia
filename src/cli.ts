import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { createBackends, outputName, routeForInput, uniquifyRoute } from "./node/mediaRoute";
import { arg, parseStartOptions } from "./cliArgs";

async function main() {
  const argv = process.argv;
  const input = argv[2];
  if (!input || input.startsWith("--")) {
    console.error("usage: uniquify <input.mp4|input.jpg> --count N [--strength 1.0] " +
      "[--format original|reels|feed|square] [--edges crop|fit|auto] [--out DIR] " +
      "[--target 45] [--seed 1] [--identity engine|iphone|clean] " +
      "[--first-frame off|black|photo] [--cover <image>]\n" +
      "  --format defaults to reels for video and original for photo, so a still keeps its framing.\n" +
      "  --edges says how a still carries its shift at the frame edge: crop cuts an off-centre\n" +
      "  window out, fit shrinks the picture and pads it back so nothing is lost, auto decides\n" +
      "  from the picture (the default). For video it applies to the cover, if there is one.\n" +
      "  --identity says what a copy claims about itself: engine leaves ffmpeg's own signature,\n" +
      "  iphone (the default) makes it look shot on an iPhone, clean leaves no metadata at all.\n" +
      "  --no-spoof is the old spelling of --identity engine and still works.\n" +
      "  --first-frame says what every video copy opens on: off (the default) leaves the footage,\n" +
      "  black paints one pure black frame, photo puts the --cover image there — run through the\n" +
      "  photo recipe with each copy's own seed, then fitted to the video. Ignored for a still.\n" +
      "  --black-first-frame is the old spelling of --first-frame black and still works.");
    process.exit(1);
  }

  const count = Number(arg(argv, "count", "5"));
  const outDir = arg(argv, "out", "out")!;
  const seedBase = Number(arg(argv, "seed", String(Math.floor(Date.now() % 1e6))));

  // The kind comes from the file's own bytes: a `.jpg` that is really an MP4
  // still goes down the video path. It is resolved before the options are built
  // because one of them — the export format — defaults differently per medium.
  const route = await routeForInput(input, createBackends());

  const opts = parseStartOptions(argv, route);

  // After the options: a line the parser refuses leaves no directory behind.
  mkdirSync(outDir, { recursive: true });

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
