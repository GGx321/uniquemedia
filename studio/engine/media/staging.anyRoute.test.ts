import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { lstat, mkdir, open as openFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { PickedFileIdentity } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { pickedIdentityOf } from "./identity";
import { fixtureBytes } from "./fixtures/music";
import { MediaStaging, type OpenResult, type StageResult } from "./staging";
import { buildMp4 } from "./video/testing/mp4VideoBuilder";
import { FIXTURES } from "./video/testing/fixtures/index";
import { withHiddenVideoHandler } from "./video/testing/mp4Patch";
useNativeGlobals();

// 3f.6: the ONE drop zone (`kind: "any"`) cannot tell an audio-only MP4 from a video by its head: Android recorders write voice notes as `isom` or `mp42` files
// with sound tracks only. For a file of the MP4 or MOV family picked as `any`, the staging looks at the TRACKS with the same bounded walker the video importer uses:
// no video track and a sound track is a TRACK (the audio importer), a video track is a video as before, and a file with neither is refused. A file the walker refuses
// for any other reason stays a video, so the video importer says why in its own words.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-media-anyroute-");
const libraryRoot = (): string => join(tmp(), "library");
const sourceDir = (): string => join(tmp(), "picked");
let ids = 0;

beforeEach(async () => {
  await mkdir(sourceDir(), { recursive: true });
  await mkdir(libraryRoot(), { recursive: true });
});

function staging(): MediaStaging {
  return new MediaStaging({ root: libraryRoot(), newId: () => `staged-${String(++ids).padStart(8, "0")}` });
}

async function put(name: string, bytes: Uint8Array): Promise<{ path: string; expected: PickedFileIdentity }> {
  const path = join(sourceDir(), name);
  await writeFile(path, bytes);
  return { path, expected: pickedIdentityOf(await lstat(path, { bigint: true })) };
}

async function open(name: string, bytes: Uint8Array, kind: "any" | "video" | "audio" = "any"): Promise<OpenResult> {
  const file = await put(name, bytes);
  return staging().open({ ...file, kind });
}

async function kindOf(name: string, bytes: Uint8Array, kind: "any" | "video" | "audio" = "any"): Promise<string> {
  const result = await open(name, bytes, kind);
  if (!result.ok) return `refused: ${result.reason}`;
  const { kind: found } = result.opened;
  await result.opened.close();
  return found;
}

const AUDIO_ONLY = (): Uint8Array => fixtureBytes("isomMp4");
const BT709 = { type: "nclx", primaries: 1, transfer: 1, matrix: 1 } as const;

async function videoBytes(): Promise<Uint8Array> {
  return new Uint8Array(await Bun.file(FIXTURES["h264-bframes.mp4"].file).arrayBuffer());
}

describe("an MP4 picked as any", () => {
  test("with sound tracks only (an Android recorder's isom file) is a track", async () => {
    expect(await kindOf("voice.m4a", AUDIO_ONLY())).toBe("audio");
  });

  test("the audio-only fixture really is an isom file the sniff alone takes for a video: that is what the routing is for", async () => {
    const head = AUDIO_ONLY().subarray(0, 12);
    expect(Buffer.from(head.subarray(8, 12)).toString("latin1")).toBe("isom");
  });

  test("with a video track is a video, as before", async () => {
    expect(await kindOf("clip.mp4", await videoBytes())).toBe("video");
  });

  test("with a video track and a sound track is a video", async () => {
    const both = buildMp4({ tracks: [{ handler: "vide", entry: { fourcc: "avc1", width: 192, height: 96, colr: BT709 }, mdhdTimescale: 30000, stts: [[30, 1000]] }, { handler: "soun" }] });
    expect(await kindOf("clip.mp4", both)).toBe("video");
  });

  test("with neither a video nor a sound track is refused, as a format, before a byte is copied", async () => {
    const empty = buildMp4({ tracks: [] });
    const result = await open("empty.mp4", empty);
    expect(result).toMatchObject({ ok: false, reason: "format" });
    if (!result.ok) expect(result.detail).toMatch(/neither a video nor a sound track/);
  });

  test("with tracks that are neither (a text and a metadata track) is refused the same way", async () => {
    expect(await kindOf("notes.mp4", buildMp4({ tracks: [{ handler: "meta" }, { handler: "text" }] }))).toBe("refused: format");
  });

  test("a file the walker refuses for another reason stays a video: the video importer will say why", async () => {
    // Two video tracks: refused by the walker as `several-video-tracks`, which is the video importer's to turn into `structure`.
    const two = buildMp4({
      tracks: [
        { handler: "vide", entry: { fourcc: "avc1", width: 192, height: 96, colr: BT709 }, mdhdTimescale: 30000, stts: [[30, 1000]] },
        { handler: "vide", entry: { fourcc: "avc1", width: 192, height: 96, colr: BT709 }, mdhdTimescale: 30000, stts: [[30, 1000]] },
      ],
    });
    expect(await kindOf("two.mp4", two)).toBe("video");
  });

  test("a sound track that hides a video handler is NOT a track: the walker refuses it, so it stays a video and the video importer refuses it", async () => {
    const hidden = withHiddenVideoHandler(new Uint8Array(await Bun.file(FIXTURES["hevc-hlg-chart.mp4"].file).arrayBuffer()), "minf");
    expect(await kindOf("sneaky.mp4", hidden)).toBe("video");
  });

  test("a head that is only an ftyp (no moov at all) stays a video", async () => {
    const head = new Uint8Array([0, 0, 0, 16, 102, 116, 121, 112, 105, 115, 111, 109, 0, 0, 0, 0]);
    expect(await kindOf("cut.mp4", head)).toBe("video");
  });
});

describe("what is not routed", () => {
  test("a pick of video stays a video: the owner asked for one, and the video importer says what it is not", async () => {
    expect(await kindOf("voice.mp4", AUDIO_ONLY(), "video")).toBe("video");
  });

  test("a pick of audio takes the audio-only file as before", async () => {
    expect(await kindOf("voice.mp4", AUDIO_ONLY(), "audio")).toBe("audio");
  });

  test("a QuickTime file (brand qt) with a sound track only is routed like an MP4, and the MP4 brands an Android recorder writes (mp42, M4A-less isom) alike", async () => {
    for (const brand of ["qt  ", "mp42", "isom", "iso2"]) expect(await kindOf(`memo-${brand.trim()}.mov`, buildMp4({ brand, tracks: [{ handler: "soun" }] }))).toBe("audio");
  });

  test("a photo and a sticker are untouched", async () => {
    expect(await kindOf("a.jpg", new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 0, 0, 0, 0, 0]))).toBe("photo");
  });
});

describe("the copy of a routed file", () => {
  test("is staged as a track, with the container its bytes are (mp4), and the job's importer is the audio one", async () => {
    const file = await put("voice.m4a", AUDIO_ONLY());
    const result: StageResult = await staging().stage({ ...file, kind: "any" });
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    expect(result.staged.kind).toBe("audio");
    expect(result.staged.format).toBe("mp4");
    await result.staged.dispose();
  });

  test("a file whose start is changed in place between the open and the copy to a picture's is `changed`: the leniency is for the MP4 family only", async () => {
    const file = await put("voice.m4a", AUDIO_ONLY());
    const opened = await staging().open({ ...file, kind: "any" });
    if (!opened.ok) throw new Error(`refused: ${opened.reason}`);
    expect(opened.opened.kind).toBe("audio");
    // The same inode, the same size, a JPEG's first bytes: the copy checks the START of what it wrote against the kind it was judged as.
    const handle = await openFile(file.path, "r+");
    await handle.write(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]), 0, 4, 0);
    await handle.close();
    const copied = await opened.opened.copy({});
    expect(copied).toMatchObject({ ok: false, reason: "changed" });
    await opened.opened.close();
  });

  test("a file whose start is changed in place to another MP4-family head is still a track: the importer judges the streams again", async () => {
    const file = await put("voice.m4a", AUDIO_ONLY());
    const opened = await staging().open({ ...file, kind: "any" });
    if (!opened.ok) throw new Error(`refused: ${opened.reason}`);
    const copied = await opened.opened.copy({});
    expect(copied.ok).toBe(true);
    if (copied.ok) await copied.staged.dispose();
    await opened.opened.close();
  });
});
