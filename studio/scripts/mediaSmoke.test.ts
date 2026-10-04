import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { PNG_1X1 } from "../engine/library/testing/sampleData";
import { openFileSource } from "../engine/media/video/fileSource";
import { FIXTURES } from "../engine/media/video/testing/fixtures/index";
import { judgeVideo } from "../engine/media/video/videoPlan";
import { probeVideo } from "../engine/media/video/videoProbe";
import { formatOf, resolveMediaKind, unfitReason } from "../engine/media/sniff";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { MEDIA_SMOKE_CLIP, MEDIA_SMOKE_FILES, MEDIA_SMOKE_STORED, mediaRecordFileProblems } from "./mediaSmoke";
useNativeGlobals();

// The packaged smoke's own-media files (3f.1b): one tiny file per kind, picked through `--studio-pick-media` with `any`. The table is
// checked here, against the engine's own sniffing, so a wrong byte in it fails a unit test and not a packaged run on two systems.

describe("the smoke's own-media files", () => {
  test("every file is as small as a smoke file should be", () => {
    for (const file of MEDIA_SMOKE_FILES) expect(file.bytes.length).toBeLessThan(200);
  });

  test("the photo is a real PNG that the engine takes for a photo and the stand-in importer takes", () => {
    const photo = MEDIA_SMOKE_FILES.find((f) => f.label === "photo");
    expect(photo?.bytes).toEqual(PNG_1X1);
    expect(resolveMediaKind("any", PNG_1X1)).toBe("photo");
    expect(formatOf(PNG_1X1)).toBe("png");
    expect(photo?.expect).toEqual({ job: true });
  });

  test("a video, a track and a sticker are what their kind says", () => {
    const kinds = Object.fromEntries(MEDIA_SMOKE_FILES.map((f) => [f.label, resolveMediaKind("any", f.bytes)]));
    expect(kinds).toMatchObject({ video: "video", audio: "audio", sticker: "sticker" });
  });

  test("no importer takes a track or a sticker yet", () => {
    for (const label of ["audio", "sticker"]) expect(MEDIA_SMOKE_FILES.find((f) => f.label === label)?.expect).toEqual({ refused: "not-yet-supported" });
  });

  test("a video has an importer (3f.3a): a bare header is accepted into a job that fails as a format", () => {
    expect(MEDIA_SMOKE_FILES.find((f) => f.label === "video")?.expect).toEqual({ failsAs: "format" });
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

  test("what the stored photo is expected to be: the 1x1 PNG, under the name it was picked by", () => {
    expect(MEDIA_SMOKE_STORED).toMatchObject({ kind: "photo", name: "smoke-media.png", width: 1, height: 1, bytes: PNG_1X1.length });
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
