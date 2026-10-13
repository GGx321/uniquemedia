import * as nodePath from "node:path";

/**
 * `path.relative(from, to)` with forward slashes on every platform, for a test that compares a scanned file with a
 * POSIX literal such as "shared/scenes/template.ts" (Windows gives "shared\\scenes\\template.ts"). `flavour` lets a
 * test feed Windows paths on any host.
 */
export function relativePosix(from: string, to: string, flavour: Pick<typeof nodePath, "relative" | "sep"> = nodePath): string {
  return flavour.relative(from, to).split(flavour.sep).join("/");
}
