import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { useClipFixtures } from "./testing/clipFixtures";
import { DURATION_TOLERANCE_MS, judgeClipFacts, MIN_CLIP_WIDTH, validateClipFile, type ClipFacts } from "./validate";
useNativeGlobals();

// I5.54: a paid file is accepted when it is one H.264 video stream, 9:16, at least 720 wide, within half a second of the length asked. Audio is allowed (Grok's stray track).
// `judgeClipFacts` holds the rule; `validateClipFile` reads the facts from the file's own boxes (the app's walker, never ffmpeg's text).

const clip = useClipFixtures();
let dir = "";
afterEach(async () => {
  if (dir !== "") await rm(dir, { recursive: true, force: true });
  dir = "";
});

const GOOD: ClipFacts = { codec: "h264", width: 720, height: 1280, durationMs: 5_000 };

describe("judgeClipFacts", () => {
  test("accepts a 720 x 1280 H.264 clip of the length asked", () => {
    expect(judgeClipFacts(GOOD, 5)).toEqual({ ok: true });
  });

  test("accepts a 1080 x 1920 clip", () => {
    expect(judgeClipFacts({ ...GOOD, width: 1080, height: 1920 }, 5)).toEqual({ ok: true });
  });

  test("accepts a wider 9:16 clip than the one asked for", () => {
    expect(judgeClipFacts({ ...GOOD, width: 810, height: 1440 }, 5)).toEqual({ ok: true });
  });

  test("refuses a 16:9 clip", () => {
    expect(judgeClipFacts({ ...GOOD, width: 1280, height: 720 }, 5)).toEqual({ ok: false, reason: "not-vertical" });
  });

  test("refuses a square clip", () => {
    expect(judgeClipFacts({ ...GOOD, width: 1024, height: 1024 }, 5)).toEqual({ ok: false, reason: "not-vertical" });
  });

  test("refuses a vertical clip that is not 9:16", () => {
    expect(judgeClipFacts({ ...GOOD, width: 720, height: 1500 }, 5)).toEqual({ ok: false, reason: "not-vertical" });
  });

  test("accepts a 9:16 clip that is one pixel off in a dimension", () => {
    expect(judgeClipFacts({ ...GOOD, width: 720, height: 1281 }, 5)).toEqual({ ok: true });
  });

  test("refuses a 9:16 clip narrower than the minimum width", () => {
    // 711 x 1264 is 9:16 to within a pixel; 711 < 720.
    expect(MIN_CLIP_WIDTH).toBe(720);
    expect(judgeClipFacts({ ...GOOD, width: 711, height: 1264 }, 5)).toEqual({ ok: false, reason: "too-narrow" });
  });

  test("refuses an HEVC stream", () => {
    expect(judgeClipFacts({ ...GOOD, codec: "hevc" }, 5)).toEqual({ ok: false, reason: "not-h264" });
  });

  test("refuses a clip a millisecond past half a second short of the length asked", () => {
    expect(DURATION_TOLERANCE_MS).toBe(500);
    expect(judgeClipFacts({ ...GOOD, durationMs: 4_499 }, 5)).toEqual({ ok: false, reason: "wrong-duration" });
  });

  test("accepts a clip exactly half a second short", () => {
    expect(judgeClipFacts({ ...GOOD, durationMs: 4_500 }, 5)).toEqual({ ok: true });
  });

  test("accepts a clip exactly half a second long", () => {
    expect(judgeClipFacts({ ...GOOD, durationMs: 5_500 }, 5)).toEqual({ ok: true });
  });

  test("refuses a clip a millisecond past half a second long", () => {
    expect(judgeClipFacts({ ...GOOD, durationMs: 5_501 }, 5)).toEqual({ ok: false, reason: "wrong-duration" });
  });

  test("refuses a 5 s clip when 10 s were asked", () => {
    expect(judgeClipFacts(GOOD, 10)).toEqual({ ok: false, reason: "wrong-duration" });
  });
});

describe("validateClipFile", () => {
  test("accepts a 720 x 1280 H.264 clip and reports its real size, length and rate", async () => {
    const path = await clip({ width: 720, height: 1280, seconds: 5, fps: 24 });
    const result = await validateClipFile(path, 5);
    if (!result.ok) throw new Error(`expected a valid clip, got ${result.reason}`);
    expect(result.clip.width).toBe(720);
    expect(result.clip.height).toBe(1280);
    expect(Math.abs(result.clip.durationMs - 5_000)).toBeLessThanOrEqual(100);
    expect(result.clip.fps).toBe(24);
    expect(result.clip.hasAudio).toBe(false);
    expect(result.clip.bytes).toBe((await readFile(path)).byteLength);
  });

  test("accepts a 1080 x 1920 clip and reports 1080 x 1920", async () => {
    const path = await clip({ width: 1080, height: 1920, seconds: 5 });
    const result = await validateClipFile(path, 5);
    if (!result.ok) throw new Error(`expected a valid clip, got ${result.reason}`);
    expect([result.clip.width, result.clip.height]).toEqual([1080, 1920]);
  });

  test("accepts a 10 s clip when 10 s were asked", async () => {
    const path = await clip({ width: 720, height: 1280, seconds: 10 });
    expect((await validateClipFile(path, 10)).ok).toBe(true);
  });

  test("accepts a clip with an audio track and says it has one", async () => {
    const path = await clip({ width: 720, height: 1280, seconds: 5, audio: true });
    const result = await validateClipFile(path, 5);
    if (!result.ok) throw new Error(`expected a valid clip, got ${result.reason}`);
    expect(result.clip.hasAudio).toBe(true);
  });

  test("refuses a 16:9 file", async () => {
    const path = await clip({ width: 1280, height: 720, seconds: 5 });
    const result = await validateClipFile(path, 5);
    expect(result.ok ? "ok" : result.reason).toBe("not-vertical");
  });

  test("refuses a 9:16 file narrower than 720", async () => {
    const path = await clip({ width: 540, height: 960, seconds: 5 });
    const result = await validateClipFile(path, 5);
    expect(result.ok ? "ok" : result.reason).toBe("too-narrow");
  });

  test("refuses an HEVC stream", async () => {
    const path = await clip({ width: 720, height: 1280, seconds: 5, codec: "hevc" });
    const result = await validateClipFile(path, 5);
    expect(result.ok ? "ok" : result.reason).toBe("not-h264");
  });

  test("refuses a file with a second video stream", async () => {
    const path = await clip({ width: 720, height: 1280, seconds: 5, secondVideo: true });
    const result = await validateClipFile(path, 5);
    expect(result.ok ? "ok" : result.reason).toBe("several-video-streams");
  });

  test("refuses a 4 s file when 5 s were asked", async () => {
    const path = await clip({ width: 720, height: 1280, seconds: 4 });
    const result = await validateClipFile(path, 5);
    expect(result.ok ? "ok" : result.reason).toBe("wrong-duration");
  });

  test("refuses a file that is not an MP4", async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-validate-"));
    const path = join(dir, "page.mp4");
    await writeFile(path, "<html><body>rate limited</body></html>");
    const result = await validateClipFile(path, 5);
    expect(result.ok ? "ok" : result.reason).toBe("not-mp4");
  });

  test("refuses an empty file", async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-validate-"));
    const path = join(dir, "empty.mp4");
    await writeFile(path, new Uint8Array(0));
    const result = await validateClipFile(path, 5);
    expect(result.ok ? "ok" : result.reason).toBe("not-mp4");
  });

  test("refuses a file cut off in the middle", async () => {
    const whole = await readFile(await clip({ width: 720, height: 1280, seconds: 5 }));
    dir = await mkdtemp(join(tmpdir(), "studio-validate-"));
    const path = join(dir, "cut.mp4");
    await writeFile(path, whole.subarray(0, Math.floor(whole.byteLength * 0.6)));
    const result = await validateClipFile(path, 5);
    expect(result.ok ? "ok" : result.reason).toBe("unreadable");
  });

  test("refuses a file that is not there, without throwing", async () => {
    dir = await mkdtemp(join(tmpdir(), "studio-validate-"));
    const result = await validateClipFile(join(dir, "nothing.mp4"), 5);
    expect(result.ok ? "ok" : result.reason).toBe("unreadable");
  });
});
