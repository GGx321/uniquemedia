import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageSize, sniffImageMediaType } from "../engine/library/media";
import { __setFfmpegPathOverrideForTests, ffmpegPath } from "./ffmpegBinary";
import { downscaleCommand, downscaleToJpeg } from "./downscale";

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "studio-downscale-test-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function render(name: string, source: string, codecArgs: string[] = []): Uint8Array {
  const path = join(dir, name);
  const r = spawnSync(ffmpegPath(), ["-y", "-f", "lavfi", "-i", source, "-frames:v", "1", ...codecArgs, path]);
  if (r.status !== 0) throw new Error(`ffmpeg could not render ${name}: ${r.stderr.toString()}`);
  return new Uint8Array(readFileSync(path));
}

function mandelbrot(name: string, width: number, height: number, codecArgs: string[] = []): Uint8Array {
  return render(name, `mandelbrot=size=${width}x${height}`, codecArgs);
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

/**
 * Runs `work` with the system temp folder pointed at an empty folder of its
 * own and a watch on it: every name anything creates there is returned.
 */
async function tempWritesDuring(work: () => Promise<unknown>): Promise<string[]> {
  const temp = mkdtempSync(join(dir, "tmp-"));
  const saved = { TMPDIR: process.env.TMPDIR, TEMP: process.env.TEMP, TMP: process.env.TMP };
  const seen: string[] = [];
  const watcher = watch(temp, { recursive: true }, (_event, name) => {
    if (name !== null) seen.push(String(name));
  });
  Object.assign(process.env, { TMPDIR: temp, TEMP: temp, TMP: temp });
  try {
    await work().catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
  } finally {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    watcher.close();
  }
  return [...new Set([...seen, ...readdirSync(temp)])];
}

describe("downscaleToJpeg", () => {
  test("a 1K 3:4 portrait becomes a JPEG 768 px on its long side, same aspect", async () => {
    const out = await downscaleToJpeg(mandelbrot("portrait.png", 864, 1152), { maxSide: 768 });

    expect(sniffImageMediaType(out)).toBe("image/jpeg");
    expect(imageSize(out)).toEqual({ width: 576, height: 768 });
  });

  test("nothing is written to disk: the unverified image goes to ffmpeg through a pipe and comes back through one", async () => {
    const written = await tempWritesDuring(() => downscaleToJpeg(mandelbrot("private.png", 864, 1152), { maxSide: 768 }));

    expect(written).toEqual([]);
  });

  test("an image already within the limit keeps its size", async () => {
    const out = await downscaleToJpeg(mandelbrot("small.png", 40, 30), { maxSide: 768 });

    expect(imageSize(out)).toEqual({ width: 40, height: 30 });
  });

  test.each([
    ["a JPEG", "in.jpg", [] as string[]],
    ["a WebP", "in.webp", ["-c:v", "libwebp"]],
  ])("takes %s too", async (_label, name, codec) => {
    const out = await downscaleToJpeg(mandelbrot(name, 100, 200, codec), { maxSide: 50 });

    expect(sniffImageMediaType(out)).toBe("image/jpeg");
    expect(imageSize(out)).toEqual({ width: 25, height: 50 });
  });

  test("an image of more pixels than the cap is refused by the decoder (which counts its aligned buffer, so the cap is approximate)", async () => {
    const image = mandelbrot("capped.png", 60, 80);

    expect(await rejectionOf(downscaleToJpeg(image, { maxSide: 768, maxPixels: 1_000 }))).toBeInstanceOf(Error);
    expect(imageSize(await downscaleToJpeg(image, { maxSide: 768, maxPixels: 10_000 }))).toEqual({ width: 60, height: 80 });
  });

  test("PNG bytes ffmpeg cannot decode reject", async () => {
    const broken = Uint8Array.from([...mandelbrot("broken.png", 8, 8).subarray(0, 33), ...new Uint8Array(64).fill(7)]);

    expect(await rejectionOf(downscaleToJpeg(broken, { maxSide: 768 }))).toBeInstanceOf(Error);
  });

  test("bytes that are not a PNG, JPEG or WebP are refused before ffmpeg runs", async () => {
    expect(await rejectionOf(downscaleToJpeg(Uint8Array.from([1, 2, 3, 4, 5]), { maxSide: 768 }))).toBeInstanceOf(TypeError);
  });

  test("a missing ffmpeg rejects", async () => {
    const input = mandelbrot("missing.png", 8, 8);
    __setFfmpegPathOverrideForTests(join(dir, "no-such-ffmpeg"));
    try {
      expect(await rejectionOf(downscaleToJpeg(input, { maxSide: 768 }))).toMatchObject({ code: "ENOENT" });
    } finally {
      __setFfmpegPathOverrideForTests(undefined);
    }
  });

  test("an aborted signal rejects with its reason", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled");
    controller.abort(reason);

    expect(await rejectionOf(downscaleToJpeg(mandelbrot("abort.png", 8, 8), { maxSide: 768, signal: controller.signal }))).toBe(reason);
  });

  test("an abort while ffmpeg runs kills it and rejects with the abort's reason at once", async () => {
    // 16 MP: decoding and scaling it takes far longer than the 5 ms before the abort.
    const big = render("big.png", "color=c=gray:s=4000x4000");
    const controller = new AbortController();
    const reason = new Error("timed out");
    setTimeout(() => controller.abort(reason), 5);
    const started = performance.now();

    expect(await rejectionOf(downscaleToJpeg(big, { maxSide: 768, signal: controller.signal }))).toBe(reason);
    expect(performance.now() - started).toBeLessThan(2_000);
  });

  test.each([0, -1, 1.5, Number.NaN])("refuses a longest side of %p", async (maxSide) => {
    expect(await rejectionOf(downscaleToJpeg(mandelbrot("side.png", 8, 8), { maxSide }))).toBeInstanceOf(RangeError);
  });
});

describe("downscaleCommand", () => {
  const { args, env } = downscaleCommand("png_pipe", 768, 16_777_216);

  test("the environment passed to ffmpeg is explicitly empty: nothing of the app's (no OPENROUTER_*) is handed to it (invariant 10; on Windows libuv still adds the system variables)", () => {
    expect(env).toEqual({});
  });

  test("reads only from its stdin pipe, in the sniffed format, under a pixel cap, and writes a JPEG to its stdout", () => {
    const input = args.indexOf("-i");
    expect(args.slice(input - 6, input + 2)).toEqual(["-protocol_whitelist", "pipe", "-max_pixels", "16777216", "-f", "png_pipe", "-i", "pipe:0"]);
    expect(args.slice(-3)).toEqual(["-f", "mjpeg", "pipe:1"]);
    expect(args).toContain("scale=w='min(768,iw)':h='min(768,ih)':force_original_aspect_ratio=decrease");
  });
});
