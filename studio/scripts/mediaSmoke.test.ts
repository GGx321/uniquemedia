import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PNG_1X1 } from "../engine/library/testing/sampleData";
import { SMOKE_TEST_PNG } from "../engine/decode/realBackend";
import { openFileSource } from "../engine/media/video/fileSource";
import { FIXTURES } from "../engine/media/video/testing/fixtures/index";
import { judgeVideo } from "../engine/media/video/videoPlan";
import { probeVideo } from "../engine/media/video/videoProbe";
import { webpInfo } from "../engine/media/webp";
import { formatOf, resolveMediaKind, unfitReason } from "../engine/media/sniff";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMusicImporter } from "../engine/media/musicImporter";
import { handoff } from "../engine/media/photoFixtures.testkit";
import { inspectGif } from "../shared/stickers/gif";
import { quantiseByAccumulatedTime } from "../shared/stickers/quantise";
import { jpegMetadataMarkers, MEDIA_SMOKE_CLIP, MEDIA_SMOKE_FILES, MEDIA_SMOKE_STORED, MEDIA_SMOKE_TRACK, mediaRecordFileProblems, STICKER_SMOKE_FILES, STICKER_SMOKE_STORED } from "./mediaSmoke";
useNativeGlobals();

// The packaged smoke's own-media files (3f.1b): one tiny file per kind, picked through `--studio-pick-media` with `any`. The table is
// checked here, against the engine's own sniffing, so a wrong byte in it fails a unit test and not a packaged run on two systems.

describe("the smoke's own-media files", () => {
  test("every file is as small as a smoke file should be", () => {
    for (const file of MEDIA_SMOKE_FILES) expect(file.bytes.length).toBeLessThan(200);
  });

  test("the photo is a real 2x2 PNG that the engine takes for a photo, and the photo importer takes", () => {
    const photo = MEDIA_SMOKE_FILES.find((f) => f.label === "photo");
    expect(photo?.bytes).toEqual(SMOKE_TEST_PNG);
    expect(resolveMediaKind("any", SMOKE_TEST_PNG)).toBe("photo");
    expect(formatOf(SMOKE_TEST_PNG)).toBe("png");
    expect(photo?.expect).toEqual({ job: true });
  });

  test("a 1x1 PNG is a photo by its bytes and is refused as too small by the importer (3f.2)", () => {
    const tiny = MEDIA_SMOKE_FILES.find((f) => f.label === "tiny");
    expect(tiny?.bytes).toEqual(PNG_1X1);
    expect(resolveMediaKind("any", PNG_1X1)).toBe("photo");
    expect(tiny?.expect).toEqual({ failed: "too-small" });
  });

  test("an animated WebP is a photo by its bytes, animated by its own header, and refused as such (3f.2)", () => {
    const animated = MEDIA_SMOKE_FILES.find((f) => f.label === "animated-webp");
    expect(resolveMediaKind("any", animated?.bytes ?? new Uint8Array())).toBe("photo");
    expect(formatOf(animated?.bytes ?? new Uint8Array())).toBe("webp");
    expect(webpInfo(animated?.bytes ?? new Uint8Array())?.animated).toBe(true);
    expect(animated?.expect).toEqual({ failed: "animated-webp" });
  });

  test("a video and a track are what their kind says", () => {
    const kinds = Object.fromEntries(MEDIA_SMOKE_FILES.map((f) => [f.label, resolveMediaKind("any", f.bytes)]));
    expect(kinds).toMatchObject({ video: "video", audio: "audio" });
  });

  test("every kind has an importer by now: no smoke file waits for one", () => {
    expect(MEDIA_SMOKE_FILES.filter((f) => "refused" in f.expect && f.expect.refused === "not-yet-supported")).toEqual([]);
  });

  test("a video has an importer (3f.3a): a bare header is accepted into a job that fails as a format", () => {
    expect(MEDIA_SMOKE_FILES.find((f) => f.label === "video")?.expect).toEqual({ failed: "format" });
  });

  test("an M4A head with no stream in it is audio by its bytes; the music importer (3f.4) takes it into a job and turns it away inside, as a format", () => {
    const audio = MEDIA_SMOKE_FILES.find((f) => f.label === "audio");
    expect(resolveMediaKind("any", audio?.bytes ?? new Uint8Array())).toBe("audio");
    expect(formatOf(audio?.bytes ?? new Uint8Array())).toBe("m4a");
    expect(audio?.expect).toEqual({ failed: "format" });
  });

  test("a GIF that is only a header is a sticker by its bytes (3f.5 gave stickers an importer) and the importer refuses it inside its job as format", () => {
    const broken = MEDIA_SMOKE_FILES.find((f) => f.label === "broken-gif");
    expect(resolveMediaKind("any", broken?.bytes ?? new Uint8Array())).toBe("sticker");
    expect(formatOf(broken?.bytes ?? new Uint8Array())).toBe("gif");
    expect(inspectGif(broken?.bytes ?? new Uint8Array()).ok).toBe(false);
    expect(broken?.expect).toEqual({ failed: "format" });
  });

  test("a text file is a format refusal and a HEIC picture its own reason, by the bytes and not the name", () => {
    const text = MEDIA_SMOKE_FILES.find((f) => f.label === "text");
    const heic = MEDIA_SMOKE_FILES.find((f) => f.label === "heic");
    expect(resolveMediaKind("any", text?.bytes ?? new Uint8Array())).toBeNull();
    expect(unfitReason("any", text?.bytes ?? new Uint8Array())).toBe("format");
    expect(unfitReason("any", heic?.bytes ?? new Uint8Array())).toBe("heic");
    expect(text?.expect).toEqual({ refused: "format" });
    expect(heic?.expect).toEqual({ refused: "heic" });
  });

  test("the table names each case once, photo first (it is the one that is stored)", () => {
    const labels = MEDIA_SMOKE_FILES.map((f) => f.label);
    expect(labels[0]).toBe("photo");
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("what the stored photo is expected to be: a 2x2 JPEG the importer made, under the name it was picked by", () => {
    expect(MEDIA_SMOKE_STORED).toEqual({ kind: "photo", name: "smoke-media.png", width: 2, height: 2, extension: "jpg" });
  });
});

describe("the smoke's own track (3f.4)", () => {
  test("is a WAV of a quarter of a second that the boundary takes for audio by its bytes, and is small", () => {
    expect(resolveMediaKind("any", MEDIA_SMOKE_TRACK.bytes)).toBe("audio");
    expect(resolveMediaKind("audio", MEDIA_SMOKE_TRACK.bytes)).toBe("audio");
    expect(formatOf(MEDIA_SMOKE_TRACK.bytes)).toBe("wav");
    expect(MEDIA_SMOKE_TRACK.bytes.length).toBeLessThan(4 * 1024);
  });

  test("the music importer turns it into an M4A of the length the smoke expects, with its waveform", async () => {
    const dir = await mkdtemp(join(tmpdir(), "studio-smoke-track-"));
    try {
      const hand = await handoff(dir, MEDIA_SMOKE_TRACK.bytes, { format: "wav", kind: "audio" });
      const outcome = await createMusicImporter()(hand.request);
      if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);
      expect(outcome.output?.format).toBe("m4a");
      expect(outcome.facts.durationMs).toBeGreaterThanOrEqual(MEDIA_SMOKE_TRACK.minMs);
      expect(outcome.facts.durationMs).toBeLessThanOrEqual(MEDIA_SMOKE_TRACK.maxMs);
      expect((outcome.waveform ?? []).length).toBeGreaterThanOrEqual(4);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("what the stored track is expected to be: an M4A under its own name, an audio record", () => {
    expect(MEDIA_SMOKE_TRACK).toMatchObject({ kind: "audio", extension: "m4a" });
  });
});

describe("jpegMetadataMarkers", () => {
  const jpeg = (...markers: number[]): Uint8Array => Uint8Array.from([0xff, 0xd8, ...markers.flatMap((m) => [0xff, m, 0, 4, 0, 0]), 0xff, 0xda, 0, 2, 0xff, 0xd9]);

  test("a JPEG with only its tables, frame and scan has no metadata marker", () => {
    expect(jpegMetadataMarkers(jpeg(0xdb, 0xc0, 0xc4))).toEqual([]);
  });

  test("names an APP segment (JFIF, EXIF, XMP) and a comment", () => {
    expect(jpegMetadataMarkers(jpeg(0xe0, 0xdb, 0xe1, 0xfe))).toEqual([0xe0, 0xe1, 0xfe]);
  });

  test("a buffer that is not a JPEG has no markers to name", () => {
    expect(jpegMetadataMarkers(Uint8Array.from([1, 2, 3]))).toEqual([]);
  });
});

describe("the real clip the smoke imports (3f.3a)", () => {
  test("is what the smoke expects of it: HEVC HLG, variable rate, a quarter turn, and a plan of 96 x 192", async () => {
    const opened = await openFileSource(FIXTURES[MEDIA_SMOKE_CLIP.fixture].file);
    try {
      const probe = await probeVideo(opened.source);
      if (!probe.ok) throw new Error(`the smoke's clip is refused: ${probe.reason}`);
      expect([probe.info.video.codec, probe.info.video.dynamicRange, probe.info.video.variableFrameRate, probe.info.video.rotation]).toEqual(["hevc", "hlg", true, 90]);
      expect(resolveMediaKind("any", new Uint8Array(await readFile(FIXTURES[MEDIA_SMOKE_CLIP.fixture].file)))).toBe("video");
      const judged = judgeVideo(probe, FIXTURES[MEDIA_SMOKE_CLIP.fixture].bytes);
      if (!judged.ok) throw new Error(`the smoke's clip is refused: ${judged.reason}`);
      expect([judged.plan.outWidth, judged.plan.outHeight, judged.plan.hdrToSdr]).toEqual([MEDIA_SMOKE_CLIP.width, MEDIA_SMOKE_CLIP.height, MEDIA_SMOKE_CLIP.hdrToSdr]);
      expect(probe.info.video.sourceFps).toBeCloseTo(19.091, 2);
    } finally {
      await opened.close();
    }
  });
});

describe("mediaRecordFileProblems", () => {
  const folder = ["media-abc.json", "media-abc.png"];

  test("a library folder with the stored file and its record, and nothing else, has no problem", () => {
    expect(mediaRecordFileProblems(folder, "media-abc", "png")).toEqual([]);
  });

  test("names a missing file or record", () => {
    expect(mediaRecordFileProblems(["media-abc.json"], "media-abc", "png")).toEqual(["media-abc.png is missing"]);
    expect(mediaRecordFileProblems(["media-abc.png"], "media-abc", "png")).toEqual(["media-abc.json is missing"]);
  });

  test("names what a crash or a failed import would leave: a copy, a partial copy, a temp file, an orphan", () => {
    const problems = mediaRecordFileProblems([...folder, "old-00000001.media", ".old-00000001.part", ".media-abc.json.0123456789ab.tmp", "orphan-00000001.png"], "media-abc", "png");
    expect(problems).toHaveLength(4);
  });
});

// 3f.5: the packaged smoke's own-sticker files. Picked with `any` through the same dialog stand-in; the engine's own sniffing and the bounded GIF reader
// agree with the table here, so a wrong byte fails a unit test and not a packaged run on two systems.
describe("the smoke's own-sticker files", () => {
  const byLabel = (label: string) => STICKER_SMOKE_FILES.find((f) => f.label === label);

  test("every file is a small GIF the engine takes for a sticker", () => {
    for (const file of STICKER_SMOKE_FILES) {
      expect(file.bytes.length).toBeLessThan(400);
      expect(resolveMediaKind("any", file.bytes)).toBe("sticker");
      expect(formatOf(file.bytes)).toBe("gif");
    }
  });

  test("the animated GIF is a job that ends in a record; the still one and the broken one fail inside their jobs, with their reasons", () => {
    expect(byLabel("animated-gif")?.expect).toEqual({ job: true });
    expect(byLabel("still-gif")?.expect).toEqual({ failed: "not-animated" });
    expect(byLabel("broken-gif")?.expect).toEqual({ failed: "format" });
  });

  test("the animated GIF has three frames of 10 cs, which the importer puts on the 30 fps grid as 3 slots each", () => {
    const inspected = inspectGif(byLabel("animated-gif")?.bytes ?? new Uint8Array());
    if (!inspected.ok) throw new Error(inspected.code);
    expect(inspected.info.frames.map((f) => f.playedCs)).toEqual([10, 10, 10]);
    expect(quantiseByAccumulatedTime(inspected.info.frames.map((f) => ({ num: f.playedCs, den: 100 }))).slots).toEqual([3, 3, 3]);
    expect([inspected.info.width, inspected.info.height]).toEqual([STICKER_SMOKE_STORED.width, STICKER_SMOKE_STORED.height]);
    const total = [...STICKER_SMOKE_STORED.delayFrames].reduce<number>((sum, d) => sum + d, 0);
    expect(total === STICKER_SMOKE_STORED.loopFrames).toBe(true);
  });

  test("the still GIF has one frame, and the broken one is refused by the bounded reader", () => {
    const still = inspectGif(byLabel("still-gif")?.bytes ?? new Uint8Array());
    expect(still.ok && still.info.frameCount).toBe(1);
    expect(inspectGif(byLabel("broken-gif")?.bytes ?? new Uint8Array()).ok).toBe(false);
  });

  test("the table names each case once, the animated one first (it is the one that is stored)", () => {
    const labels = STICKER_SMOKE_FILES.map((f) => f.label);
    expect(labels[0]).toBe("animated-gif");
    expect(new Set(labels).size).toBe(labels.length);
  });

  test("what the stored sticker is expected to be: an APNG named for the id, under the name it was picked by, on the grid", () => {
    expect(STICKER_SMOKE_STORED).toEqual({ kind: "sticker", name: "smoke-sticker.gif", width: 6, height: 4, loopFrames: 9, delayFrames: [3, 3, 3], extension: "png" });
  });
});
