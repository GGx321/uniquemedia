import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { mediaReasonRu } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { JobRegistry } from "../jobs";
import { runFfmpegOk } from "../render/ffmpeg.testkit";
import { pickedIdentityOf } from "./identity";
import { routeIsoFile } from "./isoRoute";
import { createMusicImporter } from "./musicImporter";
import { MediaService } from "./service";
import { buildMp4 } from "./video/testing/mp4VideoBuilder";
import { bytesSource } from "./video/videoProbe";
import { createVideoImporter } from "./videoImporter";
useNativeGlobals();
setDefaultTimeout(120_000);

// 3f.6 review M1. A FRAGMENTED audio-only MP4 (Safari's MediaRecorder writes exactly this: an empty `moov`, then `moof` and `mdat` pairs) is refused by the video walker
// (`fragmented`), which used to send every such file to the video importer: «Видео… собрано из частей», while the music picker takes the same file. For a fragmented file the
// staging now looks at the TRACKS in a light bounded pass (`moov/trak/mdia/hdlr` and the sample entry), and a file with a sound track and no picture goes to the audio
// importer, which judges it again with ffmpeg.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-anyroute-frag-");
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
const FRAGMENTED = ["-movflags", "frag_keyframe+empty_moov", "-f", "mp4"];
const fragmentedVoice = (): Promise<Uint8Array> => made("frag-voice.mp4", ["-f", "lavfi", "-i", "sine=duration=6", "-c:a", "aac", ...FRAGMENTED]);
const fragmentedVideo = (): Promise<Uint8Array> =>
  made("frag-video.mp4", ["-f", "lavfi", "-i", "testsrc=size=64x64:rate=30:duration=3", "-f", "lavfi", "-i", "sine=duration=3", "-map", "0:v", "-map", "1:a", "-c:v", "libx264", "-preset", "ultrafast", "-c:a", "aac", ...FRAGMENTED]);

async function imported(bytes: Uint8Array): Promise<string> {
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
  const result = await service.import({ pick: "any", path, name: "file.mp4", expected: pickedIdentityOf(await lstat(path, { bigint: true })) });
  if (!result.ok) return `door:${result.reason}`;
  await service.settled();
  const state = jobs.stateOf(result.jobId);
  if (state?.kind !== "import") return "no job";
  return state.status === "failed" ? `failed:${state.mediaKind}:${state.error?.mediaReason}` : `${state.status}:${state.mediaKind}`;
}

describe("a fragmented MP4 picked as any", () => {
  test("with a sound track only (Safari's recorder) is routed to the audio importer and imports as a track", async () => {
    const bytes = await fragmentedVoice();
    expect(await routeIsoFile(bytesSource(bytes))).toBe("audio");
    expect(await imported(bytes)).toBe("done:audio");
  });

  test("with a video track and a sound track stays a video: the video importer says what it is (structure)", async () => {
    const bytes = await fragmentedVideo();
    expect(await routeIsoFile(bytesSource(bytes))).toBe("video");
    expect(await imported(bytes)).toBe("failed:video:structure");
  });

  test("with neither a video nor a sound track stays a video (the walker's own refusal)", async () => {
    const bytes = buildMp4({ tracks: [{ handler: "meta" }], topExtra: [new Uint8Array([0, 0, 0, 16, 0x6d, 0x6f, 0x6f, 0x66, 0, 0, 0, 0, 0, 0, 0, 0])] });
    expect(await routeIsoFile(bytesSource(bytes))).toBe("video");
  });

  test("a sound track that hides a video handler is not a track, fragmented or not", async () => {
    // The light pass takes the same hidden-handler and stream-part rules as the walker: a track it cannot vouch for is a video's to refuse.
    const bytes = buildMp4({ tracks: [{ handler: "soun" }, { handler: "vide" }], topExtra: [new Uint8Array([0, 0, 0, 16, 0x6d, 0x6f, 0x6f, 0x66, 0, 0, 0, 0, 0, 0, 0, 0])] });
    expect(await routeIsoFile(bytesSource(bytes))).toBe("video");
  });
});

describe("what an owner is told when a file with sound is refused as a video", () => {
  test("the video's format text points to the music picker: «добавьте как музыку»", () => {
    expect(mediaReasonRu("format", "video")).toContain("добавьте как музыку");
  });

  test("an audio-only MP4 with an empty (0-sample) video track beside its sound is refused as a video, and the text above is what it is told", async () => {
    const bytes = buildMp4({ tracks: [{ handler: "soun" }, { handler: "vide", stts: [[0, 1000]] }] });
    expect(await imported(bytes)).toMatch(/^failed:video:/);
  });
});
