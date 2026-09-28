import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Buffer } from "node:buffer";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __setFfmpegPathOverrideForTests, ffmpegPath } from "./ffmpegBinary";
import { FfmpegError } from "./runFfmpeg";
import { decodeGray64, PDQ_GRAY_FRAME_BYTES, type SpawnLike } from "./pdqPixels";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// T7a: decodes an in-memory image (PNG, JPEG or WebP) to the 64x64 grayscale
// frame src/core/pdq's computePdqHash expects, through the same pipe-in/
// pipe-out ffmpeg spawn shape as downscale.ts's own decoder (never written to
// disk), including its one retry on an empty-stderr non-zero exit (see that
// file's own PREFLIGHT_IMAGE comment for the Windows-only flake this guards).

let dir = "";
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "studio-pdq-pixels-test-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function render(name: string, source: string, codecArgs: string[] = []): Uint8Array {
  const path = join(dir, name);
  const r = spawnSync(ffmpegPath(), ["-y", "-f", "lavfi", "-i", source, "-frames:v", "1", ...codecArgs, path]);
  if (r.status !== 0) throw new Error(`ffmpeg could not render ${name}: ${r.stderr.toString()}`);
  return new Uint8Array(readFileSync(path));
}

async function rejectionOf(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return error;
  }
  throw new Error("expected the promise to reject");
}

describe("decodeGray64", () => {
  test("a PNG becomes exactly 4096 grayscale bytes (64x64, one byte per pixel)", async () => {
    const png = render("a.png", "mandelbrot=size=200x150");
    const out = await decodeGray64(png);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.length).toBe(PDQ_GRAY_FRAME_BYTES);
  });

  test("a JPEG decodes the same way", async () => {
    const jpeg = render("a.jpg", "mandelbrot=size=200x150", ["-frames:v", "1"]);
    const out = await decodeGray64(jpeg);
    expect(out.length).toBe(PDQ_GRAY_FRAME_BYTES);
  });

  test("a WebP decodes the same way", async () => {
    const webp = render("a.webp", "mandelbrot=size=200x150", ["-c:v", "libwebp"]);
    const out = await decodeGray64(webp);
    expect(out.length).toBe(PDQ_GRAY_FRAME_BYTES);
  });

  test("two renders of the same source decode to the same bytes (deterministic, no aspect-ratio letterboxing)", async () => {
    const png = render("same.png", "mandelbrot=size=200x150");
    const a = await decodeGray64(png);
    const b = await decodeGray64(png);
    expect(a).toEqual(b);
  });

  test("bytes that are not a PNG, JPEG or WebP are refused before ffmpeg runs", async () => {
    await expect(decodeGray64(Uint8Array.of(1, 2, 3, 4))).rejects.toBeInstanceOf(TypeError);
  });

  test("a missing ffmpeg rejects", async () => {
    const png = render("missing.png", "mandelbrot=size=8x8");
    __setFfmpegPathOverrideForTests(join(dir, "no-such-ffmpeg"));
    try {
      expect(await rejectionOf(decodeGray64(png))).toMatchObject({ code: "ENOENT" });
    } finally {
      __setFfmpegPathOverrideForTests(undefined);
    }
  });

  test("an already-aborted signal rejects with its reason before ffmpeg is spawned", async () => {
    const controller = new AbortController();
    const reason = new Error("cancelled before decode");
    controller.abort(reason);
    const png = render("aborted.png", "mandelbrot=size=8x8");

    expect(await rejectionOf(decodeGray64(png, { signal: controller.signal }))).toBe(reason);
  });

  test("an abort while ffmpeg runs kills it and rejects with the abort's reason at once", async () => {
    // 16 MP: decoding and scaling it takes far longer than the 5 ms before the abort.
    const big = render("big.png", "color=c=gray:s=4000x4000");
    const controller = new AbortController();
    const reason = new Error("timed out");
    setTimeout(() => controller.abort(reason), 5);
    const started = performance.now();

    expect(await rejectionOf(decodeGray64(big, { signal: controller.signal }))).toBe(reason);
    expect(performance.now() - started).toBeLessThan(2_000);
  });
});

// A minimal fake child_process.ChildProcess, and a scripted spawn over it:
// the same technique downscale.test.ts uses for its own Windows-flake retry,
// since a shell stub would not behave the same way on that platform.
function fakeChild() {
  const stdout = new EventEmitter();
  const stderr = new EventEmitter();
  const stdin = Object.assign(new EventEmitter(), { ended: undefined as Uint8Array | undefined, end(bytes: Uint8Array) { this.ended = bytes; } });
  const child = Object.assign(new EventEmitter(), {
    stdout,
    stderr,
    stdin,
    exitCode: null as number | null,
    kill: (): boolean => true,
  });
  const close = (code: number | null, signal: string | null = null): void => {
    if (child.exitCode !== null) return;
    child.exitCode = code;
    child.emit("close", code, signal);
  };
  child.kill = () => {
    queueMicrotask(() => close(null, "SIGKILL"));
    return true;
  };
  return { child, stdout, stderr, stdin, close };
}

function scriptedSpawn(scripts: ((f: ReturnType<typeof fakeChild>) => void)[]): { spawn: SpawnLike } {
  let calls = 0;
  const spawn: SpawnLike = (_command, _args) => {
    const script = scripts[calls++];
    if (script === undefined) throw new Error(`unexpected spawn call #${calls}`);
    const f = fakeChild();
    queueMicrotask(() => script(f));
    return f.child;
  };
  return { spawn };
}

/** A real 1x1 PNG's bytes; the format sniff only needs to recognise the header, the fake spawn never really decodes it. */
const PNG_1X1_INPUT = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
);
const GRAY_OUT = new Uint8Array(PDQ_GRAY_FRAME_BYTES).fill(128);

describe("decodeGray64's own ffmpeg command (T7a review, LOW)", () => {
  test("scales with flags=area, closer to reference PDQ's own box filtering than ffmpeg's default", async () => {
    let seenArgs: string[] = [];
    const spawn: SpawnLike = (_command, args) => {
      seenArgs = args;
      const f = fakeChild();
      queueMicrotask(() => {
        f.stdout.emit("data", Buffer.from(GRAY_OUT));
        f.close(0);
      });
      return f.child;
    };

    await decodeGray64(PNG_1X1_INPUT, { spawn });

    const vf = seenArgs[seenArgs.indexOf("-vf") + 1];
    expect(vf).toBe("scale=64:64:flags=area,format=gray");
  });
});

describe("decodeGray64: a non-zero exit with real stderr never retries (a genuine decode failure)", () => {
  test("rejects with the ffmpeg stderr, no retry", async () => {
    const scripted = scriptedSpawn([
      (f) => {
        f.stderr.emit("data", Buffer.from("Error while decoding stream\n"));
        f.close(1);
      },
    ]);

    const error = await rejectionOf(decodeGray64(PNG_1X1_INPUT, { spawn: scripted.spawn }));
    expect(error).toBeInstanceOf(FfmpegError);
    expect((error as FfmpegError).stderrTail).toContain("Error while decoding stream");
  });
});

describe("decodeGray64 retries once on an empty-stderr non-zero exit (the same Windows-only flake downscale.ts guards against)", () => {
  test("retries once, then succeeds", async () => {
    const scripted = scriptedSpawn([
      (f) => f.close(5),
      (f) => {
        f.stdout.emit("data", Buffer.from(GRAY_OUT));
        f.close(0);
      },
    ]);

    const out = await decodeGray64(PNG_1X1_INPUT, { spawn: scripted.spawn });
    expect(out).toEqual(GRAY_OUT);
  });

  test("a second empty-stderr failure is not retried again", async () => {
    const scripted = scriptedSpawn([(f) => f.close(5), (f) => f.close(5)]);

    const error = await rejectionOf(decodeGray64(PNG_1X1_INPUT, { spawn: scripted.spawn }));
    expect(error).toBeInstanceOf(FfmpegError);
    expect((error as FfmpegError).exitCode).toBe(5);
  });

  test("an unexpected output size (ffmpeg wrote something, but not exactly 4096 bytes) rejects without retrying", async () => {
    const scripted = scriptedSpawn([
      (f) => {
        f.stdout.emit("data", Buffer.from(new Uint8Array(10)));
        f.close(0);
      },
    ]);

    await expect(decodeGray64(PNG_1X1_INPUT, { spawn: scripted.spawn })).rejects.toThrow(/4096/);
  });
});
