import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { openFileSource } from "./video/fileSource";
import { judgeVideo } from "./video/videoPlan";
import { probeVideo } from "./video/videoProbe";
useNativeGlobals();
setDefaultTimeout(120_000);

// 3f.3a follow-up, review round 5: a regression probe on REAL files. Every fixture of the suite is made by ffmpeg, and both HIGHs of the round-5
// review (a zero terminator at the end of an Apple sample entry; a `trak/meta` with an `mdta` handler) were invisible to them: they only show on
// what Apple's own writers make. macOS ships hundreds of such movies in /System/Library. This test walks whatever of them the machine has and holds
// that the walker never refuses one for the structure of its boxes (`bad-box`, `hidden-handler`): a refusal of those kinds on a file Apple wrote
// is a walker that is stricter than ffmpeg. (Files refused for their codec, colour tags or having no video track are right to be.)
//
// It skips cleanly where there are no such files (CI's Linux and Windows runners; a machine that is not a Mac) and is tagged [heavy]. The files are
// Apple's: they are read in place and never copied into the repository. Real phone clips, when the owner supplies them, are committed as fixtures
// instead (video/testing/fixtures/README.md).

const ROOTS = [
  "/System/Library/CoreServices",
  "/System/Library/PrivateFrameworks",
  "/System/Library/Desktop Pictures",
  "/System/Library/Wallpapers",
  "/System/Library/Photos",
  "/System/Library/ExtensionKit",
];
const MAX_FILES = 400;
const MAX_BYTES = 400 * 1024 * 1024;

function collect(): string[] {
  const found: string[] = [];
  const visit = (dir: string, depth: number): void => {
    if (found.length >= MAX_FILES || depth > 9) return;
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch {
      return;
    }
    for (const name of names) {
      const path = join(dir, name);
      try {
        const stats = statSync(path);
        if (stats.isDirectory()) visit(path, depth + 1);
        else if (/\.(mov|mp4|m4v)$/i.test(name) && stats.size <= MAX_BYTES && found.length < MAX_FILES) found.push(path);
      } catch {
        // A link that goes nowhere, a file the sandbox hides: not ours to judge.
      }
    }
  };
  if (process.platform === "darwin") for (const root of ROOTS) visit(root, 0);
  return found;
}

const files = collect();

describe.skipIf(files.length === 0)(`[heavy] real Apple files: ${files.length} movies found on this machine`, () => {
  test("none is refused for the structure of its boxes", async () => {
    const refused: string[] = [];
    let read = 0;
    for (const path of files) {
      const opened = await openFileSource(path);
      try {
        const probe = await probeVideo(opened.source);
        if (probe.ok) {
          read++;
          judgeVideo(probe, opened.source.size);
        } else if (probe.reason === "bad-box" || probe.reason === "hidden-handler") {
          refused.push(`${path}: ${probe.reason}`);
        }
      } finally {
        await opened.close();
      }
    }
    // The count is the documentation: how many of this machine's system videos the walker reads (the rest are audio-only, or in a codec or colour
    // the importer does not take).
    console.log(`real Apple files: ${files.length} found, ${read} read by the walker, ${refused.length} refused for their boxes`);
    expect(refused).toEqual([]);
  });
});
