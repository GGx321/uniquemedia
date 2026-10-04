import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { openFileSource } from "./video/fileSource";
import { judgeVideo } from "./video/videoPlan";
import { probeVideo, type ProbeRefusal } from "./video/videoProbe";
import { checkVideoStreams } from "./video/videoStreams";
useNativeGlobals();
setDefaultTimeout(120_000);

// 3f.3a follow-up, review round 5: a regression probe on REAL files. Every fixture of the suite is made by ffmpeg, and both HIGHs of the round-5
// review (a zero terminator at the end of an Apple sample entry; a `trak/meta` with an `mdta` handler) were invisible to them: they only show on
// what Apple's own writers make. macOS ships hundreds of such movies in /System/Library. This test walks whatever of them the machine has and holds
// that the walker never refuses one for the structure of its boxes (any code but its codec, colour, no video track or fragmented): a refusal of those kinds on a file Apple wrote
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

/**
 * What a real file is right to be refused for, by CODE: its codec, having no video track, being fragmented (the importer does not take those). Nothing about its boxes.
 * Two refusals are pinned by file NAME instead, because they are facts about those very files (measured on macOS, 3f.6 review round 3), and a third file refused for the
 * same code is a regression to look at, not a case to wave through.
 */
const RIGHT_TO_REFUSE: ReadonlySet<ProbeRefusal> = new Set<ProbeRefusal>(["no-video-track", "unsupported-codec", "fragmented"]);
/** A colour track and an alpha track (two video tracks): the pointer-animation movies of the Mouse and Trackpad panes. */
const TWO_VIDEO_TRACKS = new Set(["Mouse.mov", "Mouse-dark.mov", "Mouse-rtl.mov", "Mouse-rtl-dark.mov", "Trackpad.mov", "Trackpad-dark.mov", "Trackpad-rtl.mov", "Trackpad-rtl-dark.mov"]);
/** HDR the importer does not take (its colour tags are not a transfer it knows). */
const UNSUPPORTED_COLOUR = new Set(["SiriEnablementChoiceVision.mov"]);

function rightToRefuse(path: string, reason: ProbeRefusal): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (RIGHT_TO_REFUSE.has(reason)) return true;
  if (reason === "several-video-tracks") return TWO_VIDEO_TRACKS.has(name);
  if (reason === "unsupported-colour") return UNSUPPORTED_COLOUR.has(name);
  return false;
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
        } else if (!rightToRefuse(path, probe.reason)) {
          // ANY structural refusal counts (bad-box, hidden-handler, hidden-track-box, stray-track...), not a list of two: the codes grow with the walker's rules, and a new rule that
          // trips on a file Apple wrote is a walker stricter than ffmpeg (3f.6 review).
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

describe.skipIf(files.length === 0)(`[heavy] real Apple files: layer 2 (ffmpeg's own stream check) takes every file the walker takes`, () => {
  test("none is refused by the stream check: ffmpeg sees one video stream, the walker's codec, a size within a codec's crop", async () => {
    const refused: string[] = [];
    let checked = 0;
    for (const path of files) {
      const opened = await openFileSource(path);
      try {
        const probe = await probeVideo(opened.source);
        if (!probe.ok) continue;
        const { codec, width, height } = probe.info.video;
        const verdict = await checkVideoStreams({ path, expected: { codec, width, height }, signal: new AbortController().signal });
        checked++;
        if (verdict !== "ok") refused.push(`${path}: ${verdict} (the walker says ${codec} ${width} x ${height})`);
      } finally {
        await opened.close();
      }
    }
    console.log(`real Apple files: ${checked} passed to the stream check, ${refused.length} refused by it`);
    expect(refused).toEqual([]);
  });
});
