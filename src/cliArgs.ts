import {
  resolveEdgeMode,
  resolveExportFormat,
  resolveFirstFrameMode,
  resolveIdentityMode,
  type MediaRoute,
} from "./node/mediaRoute";
import type { FirstFrameMode, StartOptions } from "./core/types";

/**
 * The CLI's argument reading, apart from the process so it can be exercised
 * on an argv array. `cli.ts` runs `main()` on import, which is why nothing in
 * it can be imported by a test without starting a batch.
 */

/** A valued option: the token after `--name`, or `fallback` when absent. */
export function arg(argv: readonly string[], name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
}

/** A bare switch: present or not, whatever sits after it. Read this way rather
 *  than through `arg`, which takes the next token as the value and so misses a
 *  switch that comes last on the line. */
export function flag(argv: readonly string[], name: string): boolean {
  return argv.includes(`--${name}`);
}

/**
 * `--first-frame` and `--cover` together. The mode says whether a cover is
 * wanted and the cover is a file the route will open, so a line with one and
 * not the other is refused here, before a route is chosen: `photo` with no
 * `--cover` has nothing to put on frame 0, and `--cover` with another mode
 * would be a flag that does nothing, in silence.
 */
function parseFirstFrame(argv: readonly string[]): { firstFrame: FirstFrameMode; coverPath: string | null } {
  // `--black-first-frame` predates the modes and meant the middle one. It is
  // kept as the fallback for an absent `--first-frame` so an existing
  // invocation does not break; a line that names a mode gets that mode.
  const firstFrame = resolveFirstFrameMode(
    arg(argv, "first-frame"),
    flag(argv, "black-first-frame") ? "black" : "off"
  );
  const cover = arg(argv, "cover");
  if (firstFrame === "photo") {
    if (cover === undefined || cover.startsWith("--")) {
      throw new Error("--first-frame photo needs the picture to put on frame 0: add --cover <path>.");
    }
    return { firstFrame, coverPath: cover };
  }
  if (cover !== undefined) {
    throw new Error(`--cover only applies with --first-frame photo (the first frame is ${firstFrame}).`);
  }
  return { firstFrame, coverPath: null };
}

/** The options a batch starts with, as the command line states them. The route
 *  is needed for one of them: the export format defaults differently per medium. */
export function parseStartOptions(argv: readonly string[], route: MediaRoute): StartOptions {
  return {
    strength: Number(arg(argv, "strength", "1.0")),
    exportFormat: resolveExportFormat(arg(argv, "format"), route),
    keepTrendAudio: flag(argv, "keep-audio"),
    allowMirror: flag(argv, "mirror"),
    targetDistance: Number(arg(argv, "target", "38")),
    // `--no-spoof` predates the modes and meant "leave the encoder's own
    // signature", which is `engine` now. It is kept as the fallback for an
    // absent `--identity` so an existing invocation does not break; a line
    // that names a mode gets that mode.
    identity: resolveIdentityMode(arg(argv, "identity"), flag(argv, "no-spoof") ? "engine" : "iphone"),
    edgeMode: resolveEdgeMode(arg(argv, "edges"), "auto"),
    ...parseFirstFrame(argv),
  };
}
