import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { imageSize } from "../library/media";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { firstFrameSize, makeFirstFrame } from "./firstFrame";
import { meanRgb, runFfmpegForFixture } from "./testing/clipFixtures";
useNativeGlobals();

// §5.5 «The first frame»: the photo scaled to fit the clip's output (std and Grok 720 x 1280, pro 1080 x 1920), never upscaled, as a JPEG. A photo within 2 % of 9:16 is centre-cropped to
// exactly 9:16 first; beyond that it is `not-vertical`; bytes that are not an image are `photo-unreadable`. The scratch folder is left as it was found on every path.

let photosDir = "";
let scratch = "";
beforeAll(async () => {
  photosDir = await mkdtemp(join(tmpdir(), "studio-firstframe-photos-"));
});
afterAll(async () => {
  await rm(photosDir, { recursive: true, force: true });
});
beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "studio-firstframe-"));
});
afterEach(async () => {
  await rm(scratch, { recursive: true, force: true });
});

const made = new Map<string, Promise<Uint8Array>>();

/** A flat photo of the given size, as a PNG or a JPEG, made by ffmpeg (a gradient so a crop or a scale changes pixels, not only the size). */
function photo(width: number, height: number, format: "png" | "jpg" = "png"): Promise<Uint8Array> {
  const key = `${width}x${height}.${format}`;
  let bytes = made.get(key);
  if (bytes === undefined) {
    const path = join(photosDir, key);
    bytes = runFfmpegForFixture(["-f", "lavfi", "-i", `gradients=s=${width}x${height}:d=1:n=2`, "-frames:v", "1", ...(format === "jpg" ? ["-pix_fmt", "yuvj420p"] : []), path]).then(async () => new Uint8Array(await readFile(path)));
    made.set(key, bytes);
  }
  return bytes;
}

const isJpeg = (bytes: Uint8Array): boolean => bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;

async function frame(width: number, height: number, model: "kling" | "grok", quality: "std" | "pro", format: "png" | "jpg" = "png") {
  return makeFirstFrame({ photo: await photo(width, height, format), model, quality, scratchDir: scratch });
}

describe("firstFrameSize", () => {
  test("is 720 x 1280 for std", () => {
    expect(firstFrameSize("kling", "std")).toEqual({ width: 720, height: 1280 });
  });

  test("is 1080 x 1920 for pro", () => {
    expect(firstFrameSize("kling", "pro")).toEqual({ width: 1080, height: 1920 });
  });

  test("is 720 x 1280 for Grok whatever the quality says", () => {
    expect(firstFrameSize("grok", "pro")).toEqual({ width: 720, height: 1280 });
    expect(firstFrameSize("grok", "std")).toEqual({ width: 720, height: 1280 });
  });
});

describe("makeFirstFrame", () => {
  test("scales a 1152 x 2048 Seedream PNG to a 720 x 1280 JPEG for std", async () => {
    const result = await frame(1152, 2048, "kling", "std");
    if (!result.ok) throw new Error(result.reason);
    expect(isJpeg(result.jpeg)).toBe(true);
    expect(imageSize(result.jpeg)).toEqual({ width: 720, height: 1280 });
    expect([result.width, result.height]).toEqual([720, 1280]);
  });

  test("scales a 1152 x 2048 Seedream PNG to 1080 x 1920 for pro", async () => {
    const result = await frame(1152, 2048, "kling", "pro");
    if (!result.ok) throw new Error(result.reason);
    expect(imageSize(result.jpeg)).toEqual({ width: 1080, height: 1920 });
  });

  test("scales a 1152 x 2048 photo to 720 x 1280 for Grok", async () => {
    const result = await frame(1152, 2048, "grok", "pro");
    if (!result.ok) throw new Error(result.reason);
    expect(imageSize(result.jpeg)).toEqual({ width: 720, height: 1280 });
  });

  test("keeps a 720 x 1280 Grok still at 720 x 1280 for pro: it is never upscaled", async () => {
    const result = await frame(720, 1280, "kling", "pro", "jpg");
    if (!result.ok) throw new Error(result.reason);
    expect(imageSize(result.jpeg)).toEqual({ width: 720, height: 1280 });
    expect([result.width, result.height]).toEqual([720, 1280]);
  });

  test("centre-crops a photo a little off 9:16 to exactly 9:16", async () => {
    // 1000 x 1780 is 0.14 % off: the largest 9:16 inside it is 999 x 1776, which std scales to 720 x 1280.
    const result = await frame(1000, 1780, "kling", "std");
    if (!result.ok) throw new Error(result.reason);
    expect(imageSize(result.jpeg)).toEqual({ width: 720, height: 1280 });
  });

  test("keeps a small near-9:16 photo at its cropped size instead of upscaling it", async () => {
    // 450 x 802 -> 450 x 800 (9 x 50, 16 x 50), smaller than 720 x 1280.
    const result = await frame(450, 802, "kling", "std");
    if (!result.ok) throw new Error(result.reason);
    expect(imageSize(result.jpeg)).toEqual({ width: 450, height: 800 });
  });

  test("crops a photo that is a little too wide, and one that is a little too tall", async () => {
    const wide = await frame(1147, 2000, "kling", "std");
    const tall = await frame(1103, 2000, "kling", "std");
    if (!wide.ok || !tall.ok) throw new Error("expected both near-9:16 photos to be accepted");
    expect(imageSize(wide.jpeg)).toEqual({ width: 720, height: 1280 });
    expect(imageSize(tall.jpeg)).toEqual({ width: 720, height: 1280 });
  });

  test("refuses a photo 2 % and a hair too wide as not-vertical", async () => {
    expect(await frame(1148, 2000, "kling", "std")).toEqual({ ok: false, reason: "not-vertical" });
  });

  test("refuses a photo 2 % and a hair too narrow as not-vertical", async () => {
    expect(await frame(1102, 2000, "kling", "std")).toEqual({ ok: false, reason: "not-vertical" });
  });

  test("refuses a landscape photo as not-vertical, never as unreadable", async () => {
    expect(await frame(1280, 720, "kling", "std")).toEqual({ ok: false, reason: "not-vertical" });
  });

  test("refuses bytes that are not an image as photo-unreadable", async () => {
    const result = await makeFirstFrame({ photo: new TextEncoder().encode("this is not a picture at all"), model: "kling", quality: "std", scratchDir: scratch });
    expect(result).toEqual({ ok: false, reason: "photo-unreadable" });
  });

  test("refuses an empty photo as photo-unreadable", async () => {
    expect(await makeFirstFrame({ photo: new Uint8Array(0), model: "kling", quality: "std", scratchDir: scratch })).toEqual({ ok: false, reason: "photo-unreadable" });
  });

  test("refuses a PNG cut off after its header as photo-unreadable", async () => {
    const whole = await photo(1152, 2048);
    const result = await makeFirstFrame({ photo: whole.subarray(0, 60), model: "kling", quality: "std", scratchDir: scratch });
    expect(result).toEqual({ ok: false, reason: "photo-unreadable" });
  });

  test("refuses a cut-off near-9:16 PNG as photo-unreadable, on the cropping path too", async () => {
    const whole = await photo(1000, 1780);
    const result = await makeFirstFrame({ photo: whole.subarray(0, 60), model: "kling", quality: "std", scratchDir: scratch });
    expect(result).toEqual({ ok: false, reason: "photo-unreadable" });
  });

  for (const [name, hex, rgb, size] of [
    ["scaling", "0x2EB32E", [46, 179, 46], [1152, 2048]],
    ["cropping and scaling", "0xC43031", [196, 48, 47], [1000, 1780]],
  ] as const) {
    test(`keeps the colour of a photo through ${name} within 3 per channel`, async () => {
      const path = join(photosDir, `patch-${hex}.png`);
      await runFfmpegForFixture(["-f", "lavfi", "-i", `color=c=${hex}:s=${size[0]}x${size[1]}:d=1,format=rgb24`, "-frames:v", "1", path]);
      const result = await makeFirstFrame({ photo: new Uint8Array(await readFile(path)), model: "kling", quality: "std", scratchDir: scratch });
      if (!result.ok) throw new Error(result.reason);
      const got = await meanRgb(result.jpeg);
      got.forEach((channel, i) => expect(Math.abs(channel - (rgb[i] ?? 0))).toBeLessThanOrEqual(3));
    });
  }

  test("leaves the scratch folder empty after a crop", async () => {
    await frame(1000, 1780, "kling", "std");
    expect(await readdir(scratch)).toEqual([]);
  });

  test("leaves the scratch folder empty after every refusal", async () => {
    await frame(1280, 720, "kling", "std");
    await makeFirstFrame({ photo: new TextEncoder().encode("nope"), model: "kling", quality: "std", scratchDir: scratch });
    const whole = await photo(1000, 1780);
    await makeFirstFrame({ photo: whole.subarray(0, 60), model: "kling", quality: "std", scratchDir: scratch });
    expect(await readdir(scratch)).toEqual([]);
  });

  test("rejects with the signal's reason when the call is aborted, and leaves the scratch folder empty", async () => {
    const controller = new AbortController();
    controller.abort(new Error("cancelled by the owner"));
    const run = makeFirstFrame({ photo: await photo(1000, 1780), model: "kling", quality: "std", scratchDir: scratch, signal: controller.signal });
    await expect(run).rejects.toThrow("cancelled by the owner");
    expect(await readdir(scratch)).toEqual([]);
  });
});
