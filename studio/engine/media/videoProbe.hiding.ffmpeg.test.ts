import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaImportCall } from "./imports";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { JobRegistry } from "../jobs";
import { runFfmpegOk } from "../render/ffmpeg.testkit";
import { pickedIdentityOf } from "./identity";
import { createMusicImporter } from "./musicImporter";
import { MediaService } from "./service";
import { withFirstTrackHiddenHandlerIn, withFirstTrakIn, withFirstVideoPartsIn, type HidingBox, type TrakHome } from "./video/testing/mp4Lift";
import { bytesSource, probeVideo } from "./video/videoProbe";
import { createVideoImporter } from "./videoImporter";
useNativeGlobals();
setDefaultTimeout(120_000);

// 3f.6 review, H1 as a CLASS (round 2). ffmpeg's parse table does not care how deep a box is: a track's stream parts in `trak/meta`, `sinf`, `schi`, `wave`, `traf`, `mvex` or
// `udta/meta`, a whole `trak` in `moov/udta`, `moov/meta` or a top-level `udta`, and an `hdlr vide` in `sinf`, `wave` or `traf` each make ffmpeg see a video stream that no
// `mdia` introduced. In a file of two video tracks the walker judged the SECOND while `-map 0:V:0` took the FIRST, and the import ended `done` with the unjudged stream.
// Layer 1 (this file): the walker mirrors the containers ffmpeg descends and refuses every such form. Layer 2 (videoStreams.ffmpeg.test.ts): ffmpeg's own count is the authority.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-hiding-");
let counter = 0;
beforeEach(async () => {
  await mkdir(join(tmp(), "library"), { recursive: true });
  await mkdir(join(tmp(), "picked"), { recursive: true });
});

/** Two H.264 tracks of 128 x 64: the first is the one a form hides. */
async function twoVideos(): Promise<Uint8Array> {
  const out = join(tmp(), "two.mp4");
  await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=128x64:rate=30:duration=2", "-f", "lavfi", "-i", "testsrc2=size=128x64:rate=30:duration=2", "-map", "0:v", "-map", "1:v", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", out]);
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

async function imported(bytes: Uint8Array, pick: MediaImportCall["pick"]): Promise<string> {
  const jobs = new JobRegistry();
  const service = new MediaService({
    jobs,
    emit: () => undefined,
    withLibrary: (work) => work({ root: join(tmp(), "library") }),
    newId: () => `id-${String(++counter).padStart(8, "0")}`,
    now: () => new Date("2026-10-04T10:00:00.000Z"),
    importers: { audio: createMusicImporter(), video: createVideoImporter() },
    log: () => undefined,
  });
  const path = join(tmp(), "picked", `file-${counter}.mp4`);
  await writeFile(path, bytes);
  const result = await service.import({ pick, path, name: "file.mp4", expected: pickedIdentityOf(await lstat(path, { bigint: true })) });
  if (!result.ok) return `door:${result.reason}`;
  await service.settled();
  const state = jobs.stateOf(result.jobId);
  if (state?.kind !== "import") return "no job";
  return state.status === "failed" ? `failed:${state.mediaKind}:${state.error?.mediaReason}` : `${state.status}:${state.mediaKind}`;
}

const STREAM_PART_BOXES: HidingBox[] = ["meta", "sinf", "schi", "wave", "traf", "mvex", "udta-meta", "tref", "udta"];
const HANDLER_BOXES: ("sinf" | "wave" | "traf" | "meta" | "schi" | "mvex")[] = ["sinf", "wave", "traf", "meta", "schi", "mvex"];
const TRAK_HOMES: TrakHome[] = ["moov/udta", "moov/meta", "top/udta"];

/** H.264 128 x 64 and AAC, five seconds: the video is the first track. */
async function videoWithSound(): Promise<Uint8Array> {
  const out = join(tmp(), "av.mp4");
  await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-v", "error", "-f", "lavfi", "-i", "testsrc=size=128x64:rate=30:duration=5", "-f", "lavfi", "-i", "sine=duration=5", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac", out]);
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

describe("the control", () => {
  test("two ordinary video tracks are refused by the walker as several, and a single one is read", async () => {
    const two = await twoVideos();
    expect(await probeVideo(bytesSource(two))).toEqual({ ok: false, reason: "several-video-tracks" });
  });
});

describe("a video track's stream parts hidden in a box of the trak that ffmpeg descends", () => {
  test.each(STREAM_PART_BOXES)("trak/%s: the walker refuses the file, it does not judge the second track and say ok", async (box) => {
    const probe = await probeVideo(bytesSource(withFirstVideoPartsIn(await twoVideos(), box)));
    expect(probe.ok).toBe(false);
    if (!probe.ok) expect(probe.reason).toMatch(/^hidden-/);
  });

  test.each(STREAM_PART_BOXES)("trak/%s: the import is not `done`, through video and through any", async (box) => {
    const bytes = withFirstVideoPartsIn(await twoVideos(), box);
    expect(await imported(bytes, "video")).toBe("failed:video:structure");
    expect(await imported(bytes, "any")).toBe("failed:video:structure");
  });
});

describe("an `hdlr vide` hidden in a box of a track the walker takes for sound", () => {
  test.each(HANDLER_BOXES)("trak/%s: refused as a hidden handler", async (box) => {
    const probe = await probeVideo(bytesSource(withFirstTrackHiddenHandlerIn(await twoVideos(), box)));
    expect(probe).toEqual({ ok: false, reason: "hidden-handler" });
  });
});

describe("a whole track in a box outside moov's own list of tracks (measured: ffmpeg does NOT read it as a stream)", () => {
  // The control that bounds the rule: a `trak` inside `moov/udta`, `moov/meta` or a top-level `udta` is NOT a stream (ffmpeg's `udta` is not a track's parent), so the walker is
  // right to judge only the tracks of `moov`, and refusing these would refuse files ffmpeg reads as they are. The file below has one video stream by ffmpeg's own count.
  test.each(TRAK_HOMES)("%s: ffmpeg sees ONE video stream, the second track, which the walker judged: the import is `done`", async (home) => {
    const bytes = withFirstTrakIn(await twoVideos(), home);
    expect((await probeVideo(bytesSource(bytes))).ok).toBe(true);
    expect(await imported(bytes, "video")).toBe("done:video");
  });
});

describe("the audio importer's own check (3f.4's `0:V` must match nothing) stands behind the route", () => {
  test.each(STREAM_PART_BOXES)("a video hidden in trak/%s beside a sound track: picked as audio it is refused as a format, and as any it is not `done`", async (box) => {
    const bytes = withFirstVideoPartsIn(await videoWithSound(), box);
    expect(await imported(bytes, "audio")).toBe("failed:audio:format");
    expect(await imported(bytes, "any")).not.toMatch(/^done/);
  });
});
