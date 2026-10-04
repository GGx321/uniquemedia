import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { MediaImportCall } from "./imports";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { JobRegistry } from "../jobs";
import { runFfmpegOk } from "../render/ffmpeg.testkit";
import { pickedIdentityOf } from "./identity";
import { routeIsoFile } from "./isoRoute";
import { createMusicImporter } from "./musicImporter";
import { MediaService } from "./service";
import { withFirstTrackMdiaLifted, withVideoMdiaLifted, withVideoMdiaRenamed } from "./video/testing/mp4Lift";
import { bytesSource, probeVideo } from "./video/videoProbe";
import { createVideoImporter } from "./videoImporter";
useNativeGlobals();
setDefaultTimeout(120_000);

// 3f.6 review H1, on REAL ffmpeg. ffmpeg reads a track's parts wherever they are: `minf/stbl/stsd(avc1)` directly in a `trak`, with no `mdia` and no `hdlr`, is a VIDEO
// stream. A walker that skipped such a track called the file «no video track» (and, with a sound track beside it, routed it to the audio importer) or judged ANOTHER
// video track while `-map 0:V:0` took the unjudged one and the import ended `done`. The walker now refuses a `minf`, `stbl`, `stsd` or `mdhd` anywhere but its place.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-nomdia-");
let counter = 0;
beforeEach(async () => {
  await mkdir(join(tmp(), "library"), { recursive: true });
  await mkdir(join(tmp(), "picked"), { recursive: true });
});

async function made(name: string, args: string[]): Promise<Uint8Array> {
  const out = join(tmp(), name);
  await runFfmpegOk(["-hide_banner", "-y", "-nostdin", "-v", "error", ...args, out]);
  return new Uint8Array(await Bun.file(out).arrayBuffer());
}

/** H.264 128 x 64 and AAC, five seconds: moov after mdat. */
const videoWithSound = (): Promise<Uint8Array> =>
  made("av.mp4", ["-f", "lavfi", "-i", "testsrc=size=128x64:rate=30:duration=5", "-f", "lavfi", "-i", "sine=duration=5", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p", "-c:a", "aac"]);

/** Two H.264 tracks of 128 x 64. */
const twoVideos = (): Promise<Uint8Array> =>
  made("two.mp4", ["-f", "lavfi", "-i", "testsrc=size=128x64:rate=30:duration=2", "-f", "lavfi", "-i", "testsrc2=size=128x64:rate=30:duration=2", "-map", "0:v", "-map", "1:v", "-c:v", "libx264", "-preset", "ultrafast", "-pix_fmt", "yuv420p"]);

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

describe("a track whose parts are not in its mdia", () => {
  test("the control: the unchanged file is a video the walker reads", async () => {
    expect((await probeVideo(bytesSource(await videoWithSound()))).ok).toBe(true);
  });

  test.each([true, false])("a video track with its mdhd and minf lifted into the trak (video first: %p) is refused by the walker, not skipped", async (first) => {
    const probe = await probeVideo(bytesSource(withVideoMdiaLifted(await videoWithSound(), first)));
    expect(probe).toEqual({ ok: false, reason: "hidden-track-box" });
  });

  test("a video track whose mdia is called edts is refused the same way", async () => {
    const probe = await probeVideo(bytesSource(withVideoMdiaRenamed(await videoWithSound(), "edts")));
    // Its `hdlr` is found first (hidden-handler); the parts the rule is about would be refused too, which the unit test below holds.
    expect(probe.ok).toBe(false);
  });

  test.each([true, false])("picked as any it is NOT routed to the audio importer (video first: %p): it stays a video and the video importer refuses its structure", async (first) => {
    const bytes = withVideoMdiaLifted(await videoWithSound(), first);
    expect(await routeIsoFile(bytesSource(bytes))).toBe("video");
    expect(await imported(bytes, "any")).toBe("failed:video:structure");
  });

  test("the edts variant is not routed to audio either", async () => {
    const bytes = withVideoMdiaRenamed(await videoWithSound(), "edts");
    expect(await routeIsoFile(bytesSource(bytes))).toBe("video");
    expect(await imported(bytes, "any")).toBe("failed:video:structure");
  });

  test("an unjudged mdia-less video track BEFORE a judged one is not imported: -map 0:V:0 would take the first, so the import never completes `done`", async () => {
    expect(await imported(withFirstTrackMdiaLifted(await twoVideos()), "video")).toBe("failed:video:structure");
  });

  test("the control: two ordinary video tracks are still refused as structure, and a plain video still imports", async () => {
    expect(await imported(await twoVideos(), "video")).toBe("failed:video:structure");
    expect(await imported(await videoWithSound(), "any")).toBe("done:video");
  });
});
