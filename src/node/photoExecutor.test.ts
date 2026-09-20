import { test, expect, beforeAll, afterAll } from "bun:test";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import ffmpegPath from "ffmpeg-static";
import { PhotoExecutor } from "./photoExecutor";
import { makeTestPhoto } from "./testClip";
import { samplePhotoRecipe } from "../core/photo/sampler";
import type { ResolvedPhotoOptions } from "../core/photo/types";

const FFMPEG = (ffmpegPath as string).replace("app.asar", "app.asar.unpacked");

const OPTS: ResolvedPhotoOptions = {
  strength: 1.0,
  exportFormat: "original",
  allowMirror: false,
  targetDistance: 30,
  spoofMetadata: false,
  // These predate the edge option and pin the crop behaviour they were
  // written against; the fit direction has its own tests.
  edge: { mode: "crop" },
};

/** Fully decodes `path` and returns the raw pixel byte count. A JPEG that is
 *  truncated or mis-encoded decodes short or not at all, so this is the check
 *  that the file is really an image and not just a plausible header. */
function decodedByteCount(path: string): number {
  const r = spawnSync(
    FFMPEG,
    ["-v", "error", "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    { encoding: "buffer", maxBuffer: 1 << 28 }
  );
  if (r.status !== 0) throw new Error("decode failed: " + r.stderr.toString());
  return r.stdout.length;
}

let dir: string;
let input: string;
const exec = new PhotoExecutor();

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-photo-"));
  input = join(dir, "in.jpg");
  makeTestPhoto(input, 640, 480);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("warmup resolves rather than throwing, so app startup survives it", async () => {
  // Electron calls warmup() on the route's executor at app-ready and discards
  // the result. An executor that cannot answer — a missing binary, a Gatekeeper
  // prompt — must still settle, never reject into an unhandled rejection.
  await expect(new PhotoExecutor().warmup()).resolves.toBeUndefined();
});

test("probe reports kind photo", async () => {
  const info = await exec.probe(input);
  expect(info.kind).toBe("photo");
});

test("probe reports the real pixel dimensions", async () => {
  const info = await exec.probe(input);
  expect(info.width).toBe(640);
  expect(info.height).toBe(480);
});

test("probe reports zero duration and no audio for a still", async () => {
  const info = await exec.probe(input);
  expect(info.durationSec).toBe(0);
  expect(info.hasAudio).toBe(false);
});

test("probe rejects a file it cannot read, naming the file", async () => {
  const missing = join(dir, "nope.jpg");
  const err = await exec.probe(missing).then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  expect(err instanceof Error ? err.message : "").toContain(missing);
});

test("render produces a decodable JPEG at the source size", async () => {
  const info = await exec.probe(input);
  const out = join(dir, "render-original.jpg");
  await exec.render(input, info, samplePhotoRecipe(OPTS, 11, 1), out);

  expect(statSync(out).size).toBeGreaterThan(1000);
  expect(decodedByteCount(out)).toBe(640 * 480 * 3);

  const outInfo = await exec.probe(out);
  expect(outInfo.kind).toBe("photo");
  expect(outInfo.width).toBe(640);
  expect(outInfo.height).toBe(480);
});

test("render honours the export format", async () => {
  const info = await exec.probe(input);
  const out = join(dir, "render-square.jpg");
  const recipe = samplePhotoRecipe({ ...OPTS, exportFormat: "square" }, 11, 1);
  await exec.render(input, info, recipe, out);

  const outInfo = await exec.probe(out);
  expect(outInfo.width).toBe(1080);
  expect(outInfo.height).toBe(1080);
  expect(decodedByteCount(out)).toBe(1080 * 1080 * 3);
});

test("render reports progress exactly once, as complete", async () => {
  // A still renders in one shot: there is no progress stream to sample, so the
  // contract is a single 1 on success rather than a silent executor.
  const info = await exec.probe(input);
  const out = join(dir, "render-progress.jpg");
  const seen: number[] = [];
  await exec.render(input, info, samplePhotoRecipe(OPTS, 12, 1), out, (f) => seen.push(f));
  expect(seen).toEqual([1]);
});

test("render does not report progress when the render fails", async () => {
  const info = await exec.probe(input);
  const seen: number[] = [];
  const err = await exec
    .render(input, info, samplePhotoRecipe(OPTS, 12, 1), join(dir, "no-such-dir", "x.jpg"), (f) =>
      seen.push(f)
    )
    .then(
      () => null,
      (e: unknown) => e
    );
  expect(err).toBeInstanceOf(Error);
  expect(seen).toEqual([]);
});

test("cancel kills an in-flight render and removes its partial output", async () => {
  // No sleep, and so no flake: `render` spawns synchronously, so the child is
  // already registered by the time the promise is handed back.
  const big = join(dir, "big.jpg");
  makeTestPhoto(big, 4800, 3600);
  const info = await exec.probe(big);
  const out = join(dir, "cancelled.jpg");

  const pending = exec.render(big, info, samplePhotoRecipe(OPTS, 21, 1), out);
  exec.cancel();

  const err = await pending.then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  expect(existsSync(out)).toBe(false);
}, 60_000);

test("a render after a cancel still succeeds", async () => {
  // Proves cancel cleared its bookkeeping rather than leaving a dead child
  // behind that the next cancel would try to kill again.
  const info = await exec.probe(input);
  const out = join(dir, "after-cancel.jpg");
  await exec.render(input, info, samplePhotoRecipe(OPTS, 22, 1), out);
  expect(decodedByteCount(out)).toBe(640 * 480 * 3);

  exec.cancel(); // nothing in flight: must be a no-op, not a throw
  expect(existsSync(out)).toBe(true);
});

test("extractGrayFrames returns exactly one 4096-byte frame when asked for four", async () => {
  // A still has one frame. The count is accepted for interface compatibility
  // with the video executor and deliberately ignored.
  const frames = await exec.extractGrayFrames(input, 4);
  expect(frames.length).toBe(1);
  expect(frames[0].length).toBe(64 * 64);
});

test("extractGrayFrames returns the same single frame whatever the count", async () => {
  const one = await exec.extractGrayFrames(input, 1);
  const four = await exec.extractGrayFrames(input, 4);
  expect(one.length).toBe(1);
  expect(Array.from(four[0])).toEqual(Array.from(one[0]));
  // A blank buffer would satisfy the equality above while proving nothing was
  // decoded, so require the frame to carry actual image content.
  expect(new Set(one[0]).size).toBeGreaterThan(8);
});

test("extractGrayFrames rejects a file it cannot decode", async () => {
  const err = await exec.extractGrayFrames(join(dir, "nope.jpg"), 1).then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
});

test("extractThumbnail returns a 180px-tall JPEG data URL", async () => {
  const url = await exec.extractThumbnail(input);
  expect(url.startsWith("data:image/jpeg;base64,")).toBe(true);

  const jpeg = Buffer.from(url.slice("data:image/jpeg;base64,".length), "base64");
  const thumbPath = join(dir, "thumb.jpg");
  await Bun.write(thumbPath, jpeg);
  const info = await exec.probe(thumbPath);
  expect(info.height).toBe(180);
  expect(info.width).toBe(240); // scale=-2:180 on a 4:3 source
});
