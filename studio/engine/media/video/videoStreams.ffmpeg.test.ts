import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { FfmpegSpawner } from "../../../node/runFfmpeg";
import { useNativeGlobals } from "../../../testing/nativeGlobals";
import { tempDirFor } from "../../../testing/tempDir";
import { runFfmpegOk } from "../../render/ffmpeg.testkit";
import { printingChild } from "../musicFixtures.testkit";
import { withFirstTrackHiddenHandlerIn, withFirstVideoPartsIn, type HidingBox } from "./testing/mp4Lift";
import { checkVideoStreams, type VideoStreamsVerdict } from "./videoStreams";
useNativeGlobals();
setDefaultTimeout(120_000);

// 3f.6 review, H1 (round 2), LAYER 2: ffmpeg is the authority for how many video streams a file has, as it is for audio (3f.4). Whatever a parser hides, and wherever, the
// importer asks the bundled ffmpeg before it encodes: `-map 0:V:1` must match NOTHING, and the one video stream's stream line must be the codec and size the walker judged.
// These tests give the check files the WALKER WOULD NOT stop on its own account (it is not asked here): the forms of videoProbe.hiding.ffmpeg.test.ts, on real ffmpeg.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-video-streams-");
const signal = (): AbortSignal => new AbortController().signal;
const H264_128x64 = { codec: "h264", width: 128, height: 64 } as const;

async function made(name: string, args: string[]): Promise<Uint8Array> {
  const out = join(tmp(), name);
  await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-v", "error", ...args, out]);
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}
const VIDEO = (n: number, size = "128x64"): string[] => ["-f", "lavfi", "-i", `testsrc${n === 2 ? "2" : ""}=size=${size}:rate=30:duration=2`];
const X264 = ["-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"];
const oneVideo = (): Promise<Uint8Array> => made("one.mp4", [...VIDEO(1), ...X264]);
const twoVideos = (): Promise<Uint8Array> => made("two.mp4", [...VIDEO(1), ...VIDEO(2), "-map", "0:v", "-map", "1:v", ...X264]);

async function verdictOf(bytes: Uint8Array, expected: Parameters<typeof checkVideoStreams>[0]["expected"] = H264_128x64): Promise<VideoStreamsVerdict> {
  const path = join(tmp(), `subject-${Math.random().toString(36).slice(2)}.mp4`);
  await writeFile(path, bytes);
  return checkVideoStreams({ path, expected, signal: signal() });
}

describe("a file with exactly one video stream, as the walker judged it", () => {
  test("is ok", async () => {
    expect(await verdictOf(await oneVideo())).toBe("ok");
  });

  test("with a sound track beside it is ok", async () => {
    const bytes = await made("av.mp4", [...VIDEO(1), "-f", "lavfi", "-i", "sine=duration=2", "-map", "0:v", "-map", "1:a", ...X264, "-c:a", "aac"]);
    expect(await verdictOf(bytes)).toBe("ok");
  });

  test("with an attached picture (cover art) beside it is ok: a picture is not a video stream (`-map 0:V` leaves it out)", async () => {
    const cover = await made("c.png", ["-f", "lavfi", "-i", "color=c=red:size=32x32", "-frames:v", "1"]);
    await writeFile(join(tmp(), "cover.png"), cover);
    const bytes = await made("cover.mp4", [...VIDEO(1), "-i", join(tmp(), "cover.png"), "-map", "0:v", "-map", "1:v", ...X264, "-c:v:1", "png", "-disposition:v:1", "attached_pic"]);
    expect(await verdictOf(bytes)).toBe("ok");
  });
});

describe("a file with two video streams", () => {
  test("is several, asked of ffmpeg itself", async () => {
    expect(await verdictOf(await twoVideos())).toBe("several");
  });

  const FORMS: HidingBox[] = ["meta", "sinf", "schi", "wave", "traf", "mvex", "udta-meta", "tref", "udta"];
  test.each(FORMS)("whose first one has its stream parts hidden in trak/%s is several: ffmpeg counts what a parser hid", async (box) => {
    expect(await verdictOf(withFirstVideoPartsIn(await twoVideos(), box))).toBe("several");
  });

  test.each(["sinf", "wave", "traf", "meta"] as ("sinf" | "wave" | "traf" | "meta")[])("whose first one is called sound and hides `hdlr vide` in trak/%s is several", async (box) => {
    expect(await verdictOf(withFirstTrackHiddenHandlerIn(await twoVideos(), box))).toBe("several");
  });
});

describe("the one stream is not the clip the walker judged", () => {
  test("another codec is a mismatch", async () => {
    expect(await verdictOf(await oneVideo(), { codec: "hevc", width: 128, height: 64 })).toBe("mismatch");
  });

  test("another size is a mismatch, a width or a height", async () => {
    expect(await verdictOf(await oneVideo(), { codec: "h264", width: 64, height: 64 })).toBe("mismatch");
    expect(await verdictOf(await oneVideo(), { codec: "h264", width: 128, height: 66 })).toBe("mismatch");
  });

  test("a file with no video stream at all is a mismatch (the judged track is not there for ffmpeg)", async () => {
    expect(await verdictOf(await made("a.mp4", ["-f", "lavfi", "-i", "sine=duration=2", "-c:a", "aac"]))).toBe("mismatch");
  });
});

describe("what is read of ffmpeg's text", () => {
  const spawnerSaying = (text: string, code = 1): FfmpegSpawner => () => printingChild(code, text);
  const LINE = "  Stream #0:0[0x1](und): Video: h264 (High) (avc1 / 0x31637661), yuv420p(progressive), 128x64 [SAR 1:1 DAR 2:1], 30 fps, 30 tbr, 15360 tbn (default)";
  const check = (spawner: FfmpegSpawner): Promise<VideoStreamsVerdict> => checkVideoStreams({ path: join(tmp(), "x.mp4"), expected: H264_128x64, signal: signal(), spawner });

  test("a line ending in CRLF (Windows) reads like any other", async () => {
    // Two children are asked: the dump, then the selector, which must fail and say it matches no streams.
    let asked = 0;
    const spawner: FfmpegSpawner = () => (asked++ === 0 ? printingChild(1, `Input #0, mov,mp4\r\n${LINE}\r\n`) : printingChild(1, "Stream map '0:V:1' matches no streams.\r\n"));
    expect(await check(spawner)).toBe("ok");
  });

  test("a stream line that is not the grammar (a forged language) makes the dump unreadable: a mismatch, never skipped", async () => {
    const forged = "  Stream #0:0(x): Video: png (attached pic): Video: h264 (High), yuv420p, 128x64, 30 fps";
    expect(await check(spawnerSaying(`${forged}\n`))).toBe("mismatch");
  });

  test("a selector that ffmpeg did NOT refuse (it went on, or failed for another reason) is several: only `matches no streams` proves there is none", async () => {
    let asked = 0;
    const spawner: FfmpegSpawner = () => (asked++ === 0 ? printingChild(1, `${LINE}\n`) : printingChild(0, ""));
    expect(await check(spawner)).toBe("several");
    asked = 0;
    const other: FfmpegSpawner = () => (asked++ === 0 ? printingChild(1, `${LINE}\n`) : printingChild(1, "Error opening input\n"));
    expect(await check(other)).toBe("several");
  });

  test("numbering that skips a stream is not a plain list: a mismatch", async () => {
    expect(await check(spawnerSaying(`${LINE.replace("#0:0", "#0:1")}\n`))).toBe("mismatch");
  });

  test("both children hold the encode's own limits (round 3): no decoded picture past 4K, one thread, a capped allocation, the file protocol only, the demuxer forced", async () => {
    const argvs: string[][] = [];
    const spawner: FfmpegSpawner = (_command, args) => {
      argvs.push([...args]);
      return printingChild(1, argvs.length === 1 ? `${LINE}\n` : "Stream map '0:V:1' matches no streams.\n");
    };
    expect(await check(spawner)).toBe("ok");
    expect(argvs).toHaveLength(2);
    for (const argv of argvs) {
      const at = (flag: string): string | undefined => argv[argv.indexOf(flag) + 1];
      expect(Number(at("-max_pixels"))).toBe(4096 * 2160);
      expect(at("-threads")).toBe("1");
      expect(at("-protocol_whitelist")).toBe("file");
      expect(Number(at("-max_alloc"))).toBeGreaterThan(0);
      expect(at("-f")).toBe("mov");
      expect(argv.indexOf("-max_pixels")).toBeLessThan(argv.indexOf("-i"));
      expect(argv.indexOf("-threads")).toBeLessThan(argv.indexOf("-i"));
    }
  });

  test("a cancelled signal rejects, and nothing is started", async () => {
    const controller = new AbortController();
    controller.abort();
    let started = 0;
    const spawner: FfmpegSpawner = () => {
      started++;
      return printingChild(1, "");
    };
    await expect(checkVideoStreams({ path: join(tmp(), "x.mp4"), expected: H264_128x64, signal: controller.signal, spawner })).rejects.toThrow();
    expect(started).toBe(0);
  });
});
