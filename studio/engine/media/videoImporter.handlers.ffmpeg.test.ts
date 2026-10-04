import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { runFfmpegArgv } from "../../node/runFfmpeg";
import { tempDirFor } from "../../testing/tempDir";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { decodeFirstFrame, requestFor, stage } from "./video/testing/importKit";
import { FIXTURES } from "./video/testing/fixtures/index";
import { withHiddenVideoHandler } from "./video/testing/mp4Patch";
import { judgeVideo, videoArgs } from "./video/videoPlan";
import { bytesSource, probeVideo } from "./video/videoProbe";
import { createVideoImporter } from "./videoImporter";
useNativeGlobals();
setDefaultTimeout(60_000);

// 3f.3a follow-up (review round 4, variants D and E), on real ffmpeg. A track labelled sound in `mdia` carries H.264; a second `hdlr` that says
// `vide` is hidden where ffmpeg also parses one (the last one wins), and the walker must refuse the file before ffmpeg is started. The probe
// of the review made the import succeed with the pixels of the hidden track (255, 23, 0). The same rule must not refuse an ordinary camera file.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-video-handlers-");

const bytesOf = async (name: keyof typeof FIXTURES): Promise<Uint8Array> => new Uint8Array(await readFile(FIXTURES[name].file));

async function importBytes(bytes: Uint8Array) {
  const started: string[] = [];
  const rig = requestFor(tmp(), await stage(tmp(), bytes));
  const outcome = await createVideoImporter({
    run: async (options) => {
      started.push("ffmpeg");
      await runFfmpegArgv(options);
    },
  })(rig.request);
  return { outcome, started };
}

/** Runs the bundled ffmpeg with these arguments and throws its words when it fails. */
function ffmpeg(args: string[]): void {
  const run = spawnSync(ffmpegPath(), ["-hide_banner", "-v", "error", "-nostdin", "-y", ...args], { maxBuffer: 1 << 26 });
  if (run.status !== 0) throw new Error(`ffmpeg failed: ${run.stderr.toString()}`);
}

/** Two H.264 video tracks of one size, the first RED and the second BLUE, moov after mdat (ffmpeg's default for an MP4): what the review's probe used. */
async function redThenBlue(): Promise<Uint8Array> {
  const out = join(tmp(), "two.mp4");
  ffmpeg(["-f", "lavfi", "-i", "color=red:s=128x72:r=30:d=0.5", "-f", "lavfi", "-i", "color=blue:s=128x72:r=30:d=0.5", "-map", "0", "-map", "1", "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", out]);
  return new Uint8Array(await readFile(out));
}

/** The Cr of the first frame's middle: about 240 for red, about 110 for blue. */
function crOfFirstFrame(path: string): number {
  const raw = decodeFirstFrame(path);
  const width = 128;
  const height = 72;
  return raw[width * height + (width / 2) * (height / 2) + (height / 4) * (width / 2) + width / 4] ?? -1;
}

describe("D and E: a sound-labelled track with a video handler hidden inside a child of minf", () => {
  test.each(["stbl", "dinf", "trak", "minf", "meta"] as const)("the handler hidden in %s is refused as a structure, and ffmpeg is not started", async (where) => {
    const { outcome, started } = await importBytes(withHiddenVideoHandler(await redThenBlue(), where));
    expect(outcome).toEqual({ ok: false, reason: "structure" });
    expect(started).toEqual([]);
  });

  // (A handler directly in the trak comes after the sample entry, so ffmpeg makes a video stream of it with no codec: no control for it, it is
  // refused all the same.)
  test.each(["stbl", "dinf"] as const)(
    "control:the importer's own arguments over the file with the handler in %s make ffmpeg take the HIDDEN (red) track, so the refusal is not a refusal of a harmless file",
    async (where) => {
      // The plan of a clean one-track blue clip; the walker would have judged the blue track of the hidden file in just the same way.
      const clean = join(tmp(), "blue.mp4");
      ffmpeg(["-f", "lavfi", "-i", "color=blue:s=128x72:r=30:d=0.5", "-c:v", "libx264", "-bf", "0", "-pix_fmt", "yuv420p", clean]);
      const judged = judgeVideo(await probeVideo(bytesSource(new Uint8Array(await readFile(clean)))), 1000);
      if (!judged.ok) throw new Error("the control clip is refused");
      const input = join(tmp(), "hidden.media");
      const output = join(tmp(), "out.media");
      await writeFile(input, withHiddenVideoHandler(await redThenBlue(), where));
      await runFfmpegArgv({ argv: videoArgs(input, judged.plan, output), output, timeoutMs: 30_000 });
      expect(crOfFirstFrame(output)).toBeGreaterThan(200);
    },
  );
});

describe("an ordinary QuickTime camera file keeps importing under the one rule", () => {
  /** What a camera or an editor writes: H.264, PCM audio (`sowt`), a chapter track (`text`), a timecode track (`tmcd`) and `mdta` metadata. */
  async function cameraMov(): Promise<Uint8Array> {
    const chapters = join(tmp(), "chapters.txt");
    await writeFile(chapters, ";FFMETADATA1\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=0\nEND=500\ntitle=one\n[CHAPTER]\nTIMEBASE=1/1000\nSTART=500\nEND=1000\ntitle=two\n");
    const out = join(tmp(), "camera.mov");
    ffmpeg([
      ...["-f", "lavfi", "-i", "testsrc2=s=128x72:r=30:d=1"],
      ...["-f", "lavfi", "-i", "sine=d=1"],
      ...["-i", chapters, "-map", "0:v", "-map", "1:a", "-map_metadata", "2", "-map_chapters", "2"],
      ...["-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "pcm_s16le", "-timecode", "01:00:00:00"],
      ...["-movflags", "+use_metadata_tags", "-metadata", "com.apple.quicktime.make=Apple", out],
    ]);
    return new Uint8Array(await readFile(out));
  }

  test("sowt audio, a text chapter track, a tmcd timecode track and mdta metadata: imported", async () => {
    const source = await cameraMov();
    const text = Buffer.from(source).toString("latin1");
    // The file is what the test says it is, so that a pass is not a pass over a plain clip.
    for (const part of ["sowt", "tmcd", "text", "mdta", "dhlr"]) expect(text).toContain(part);
    const { outcome, started } = await importBytes(source);
    expect(outcome.ok).toBe(true);
    expect(started).toEqual(["ffmpeg"]);
  });

  test("the ProRes MOV, whose minf has a data handler, imports", async () => {
    const source = await bytesOf("prores-hq-chart.mov");
    expect(Buffer.from(source).toString("latin1")).toContain("dhlr");
    const { outcome } = await importBytes(source);
    expect(outcome.ok).toBe(true);
  });

  test("the phone-style H.264 file with a sound track and track metadata imports", async () => {
    const { outcome } = await importBytes(await bytesOf("h264-sdr-chart.mp4"));
    expect(outcome.ok).toBe(true);
  });
});
