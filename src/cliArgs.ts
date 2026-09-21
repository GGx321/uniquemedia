import { resolveEdgeMode, resolveExportFormat, type MediaRoute } from "./node/mediaRoute";
import type { StartOptions } from "./core/types";

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

/** The options a batch starts with, as the command line states them. The route
 *  is needed for one of them: the export format defaults differently per medium. */
export function parseStartOptions(argv: readonly string[], route: MediaRoute): StartOptions {
  return {
    strength: Number(arg(argv, "strength", "1.0")),
    exportFormat: resolveExportFormat(arg(argv, "format"), route),
    keepTrendAudio: arg(argv, "keep-audio") !== undefined,
    allowMirror: arg(argv, "mirror") !== undefined,
    targetDistance: Number(arg(argv, "target", "38")),
    spoofMetadata: arg(argv, "no-spoof") === undefined,
    edgeMode: resolveEdgeMode(arg(argv, "edges"), "auto"),
    blackFirstFrame: flag(argv, "black-first-frame"),
  };
}
