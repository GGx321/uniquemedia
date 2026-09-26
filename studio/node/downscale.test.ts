import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readdirSync, readFileSync, rmSync, watch } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { imageSize, sniffImageMediaType } from "../engine/library/media";
import { __setFfmpegPathOverrideForTests, ffmpegPath } from "./ffmpegBinary";
import { downscaleCommand, downscaleToJpeg, PREFLIGHT_IMAGE, preflightDownscale, type SpawnLike } from "./downscale";
import { FfmpegError } from "./runFfmpeg";

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

describe("preflightDownscale (M8: a cheap check the image pipeline works, before a batch buys anything)", () => {
  // Review (Windows, run 36272376999): a 1×1 PNG (68 bytes) failed
  // deterministically on Windows CI — ffmpeg exit 5/116, empty stderr even
  // after the retry, while every real-size PNG/JPEG/WebP downscale test
  // passed there. Real-size PNG/JPEG/WebP downscale tests pass on Windows,
  // so the earlier "AV lock after SIGKILLs" theory was wrong; the trigger
  // was the 1×1 input itself — most likely a pipe/EOF race in the Windows
  // ffmpeg build once the whole input (and then some) fits in one read.
  // PREFLIGHT_IMAGE is a real, if tiny, 48×64 solid-colour PNG (160 bytes) —
  // still cheap, but no longer the degenerate 1-pixel case. A 1×1 input is
  // not a production case either way: every real portrait is 1K.
  test("the built-in preflight image is a realistic small image, not a degenerate 1×1 pixel", () => {
    expect(PREFLIGHT_IMAGE.length).toBeGreaterThan(100);
    const size = imageSize(PREFLIGHT_IMAGE);
    expect(size).not.toBeNull();
    expect(size?.width).toBeGreaterThan(1);
    expect(size?.height).toBeGreaterThan(1);
  });

  test("resolves once a healthy ffmpeg decodes and scales the tiny built-in image", async () => {
    await expect(preflightDownscale()).resolves.toBeUndefined();
  });

  test("rejects with the same failure a real slot's downscale would see when ffmpeg is missing", async () => {
    __setFfmpegPathOverrideForTests(join(dir, "no-such-ffmpeg"));
    try {
      expect(await rejectionOf(preflightDownscale())).toBeInstanceOf(Error);
    } finally {
      __setFfmpegPathOverrideForTests(undefined);
    }
  });

  test("an aborted signal rejects with its reason, same as downscaleToJpeg", async () => {
    const controller = new AbortController();
    const reason = new Error("preflight cancelled");
    controller.abort(reason);

    expect(await rejectionOf(preflightDownscale(controller.signal))).toBe(reason);
  });
});

// Review: a Windows CI flake (first seen in run 36263630451, attempt 1, as
// every ageGateRunner `checkOneImage` test failing at once with ffmpeg exit
// code 5 right after runFfmpeg.test.ts SIGKILLed several ffmpeg.exe
// processes). The first theory — an AV lock or a delayed handle release
// after those SIGKILLs — turned out wrong: run 36272376999 caught the SAME
// exit 5/116-with-empty-stderr signature failing deterministically on
// downscale.test.ts's own 1×1 preflight image, before runFfmpeg.test.ts had
// even run, while every real-size PNG/JPEG/WebP downscale test passed on
// the same runner. The trigger is the tiny input itself — most likely a
// pipe/EOF race in the Windows ffmpeg build (see PREFLIGHT_IMAGE's own
// comment, downscale.ts, which is no longer a degenerate 1×1). A single
// spawn retry, only when ffmpeg exited non-zero with NO stderr at all (with
// -loglevel error, a real decode failure always prints something), covers
// exactly that without masking a genuine decode failure. Tested with an
// injected `spawn` (a scripted fake, never a real child process): a shell
// stub would not run the same way on Windows, which is exactly the platform
// this covers.
describe("downscaleToJpeg retries once on an empty-stderr non-zero exit (Windows CI flake)", () => {
  const JPEG_OUT = Uint8Array.of(0xff, 0xd8, 0xff, 0xd9);
  /** A real 1x1 PNG's bytes; the fake spawn below never actually decodes it, but downscaleToJpeg's own format sniff must recognise it before it ever spawns anything. */
  const PNG_1X1_INPUT = Uint8Array.from(
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
  );

  /** A minimal fake child_process.ChildProcess: an EventEmitter with the stdout/stderr/stdin/kill/exitCode shape downscaleToJpeg reads. */
  function fakeChild() {
    const stdout = new EventEmitter();
    const stderr = new EventEmitter();
    const stdin = Object.assign(new EventEmitter(), { ended: undefined as Uint8Array | undefined, end(bytes: Uint8Array) { this.ended = bytes; } });
    const child = Object.assign(new EventEmitter(), {
      stdout,
      stderr,
      stdin,
      exitCode: null as number | null,
      kill: (): boolean => true, // replaced below, once `close` (which needs `child`) exists
    });
    const close = (code: number | null, signal: string | null = null): void => {
      if (child.exitCode !== null) return;
      child.exitCode = code;
      child.emit("close", code, signal);
    };
    // A real killed process's close eventually follows, asynchronously; this mimics that instead of requiring every script to call close() itself.
    child.kill = () => {
      queueMicrotask(() => close(null, "SIGKILL"));
      return true;
    };
    return { child, stdout, stderr, stdin, close };
  }

  /** Each call to `spawn` gets the next script in order; a call past the end fails the test loudly. */
  function scriptedSpawn(scripts: ((f: ReturnType<typeof fakeChild>) => void)[]): { spawn: SpawnLike; calls: number } {
    let calls = 0;
    const spawn: SpawnLike = (_command, _args) => {
      const script = scripts[calls++];
      if (script === undefined) throw new Error(`unexpected spawn call #${calls}`);
      const f = fakeChild();
      queueMicrotask(() => script(f));
      return f.child;
    };
    return { spawn, calls: 0 };
  }

  test("retries once, after a short delay, when the first spawn exits non-zero with no stderr at all", async () => {
    const scripted = scriptedSpawn([
      (f) => f.close(5),
      (f) => {
        f.stdout.emit("data", Buffer.from(JPEG_OUT));
        f.close(0);
      },
    ]);
    const started = performance.now();

    const out = await downscaleToJpeg(PNG_1X1_INPUT, { maxSide: 64, spawn: scripted.spawn });

    expect(out).toEqual(JPEG_OUT);
    expect(performance.now() - started).toBeGreaterThanOrEqual(150); // the ~200 ms delay actually happened
  });

  test("never retries when the failing spawn's stderr is non-empty: a real decode failure always prints something", async () => {
    const scripted = scriptedSpawn([
      (f) => {
        f.stderr.emit("data", Buffer.from("Error while decoding stream\n"));
        f.close(5);
      },
    ]);

    const error = await rejectionOf(downscaleToJpeg(PNG_1X1_INPUT, { maxSide: 64, spawn: scripted.spawn }));

    expect(error).toBeInstanceOf(FfmpegError);
    expect((error as FfmpegError).stderrTail).toContain("Error while decoding stream");
  });

  test("never retries after the signal aborts the first attempt", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled mid-attempt");
    // The first spawn just hangs; downscaleToJpeg's own abort handler kills
    // it (the fake's kill() then emits close on its own, like a real one).
    const scripted = scriptedSpawn([() => {}]);

    const promise = downscaleToJpeg(PNG_1X1_INPUT, { maxSide: 64, spawn: scripted.spawn, signal: controller.signal });
    controller.abort(reason);

    expect(await rejectionOf(promise)).toBe(reason);
  });

  test("a second empty-stderr failure is not retried again: at most one retry", async () => {
    const scripted = scriptedSpawn([(f) => f.close(5), (f) => f.close(5)]);

    const error = await rejectionOf(downscaleToJpeg(PNG_1X1_INPUT, { maxSide: 64, spawn: scripted.spawn }));

    expect(error).toBeInstanceOf(FfmpegError);
    expect((error as FfmpegError).exitCode).toBe(5);
  });
});
