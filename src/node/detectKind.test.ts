import { test, expect, beforeAll, afterAll } from "bun:test";
import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { detectMediaKind } from "./detectKind";
import { makeSilentTestClip, makeTestClip, makeTestHeif, makeTestPhoto } from "./testClip";

let dir: string;
let clip: string;
let silentClip: string;
let jpg: string;
let png: string;
let heif: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-kind-"));
  clip = join(dir, "clip.mp4");
  silentClip = join(dir, "silent.mp4");
  jpg = join(dir, "still.jpg");
  png = join(dir, "still.png");
  heif = join(dir, "shot.heic");
  makeTestClip(clip);
  makeSilentTestClip(silentClip);
  makeTestPhoto(jpg);
  makeTestPhoto(png);
  makeTestHeif(heif);
}, 60_000);

afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("reports photo for a single-frame JPEG", async () => {
  expect(await detectMediaKind(jpg)).toBe("photo");
});

test("reports photo for a single-frame PNG", async () => {
  expect(await detectMediaKind(png)).toBe("photo");
});

test("reports video for a clip with an audio track", async () => {
  expect(await detectMediaKind(clip)).toBe("video");
});

test("reports video for a silent clip", async () => {
  // Guards against a detector that only ever looks at "is there audio".
  expect(await detectMediaKind(silentClip)).toBe("video");
});

test("reports photo for a still whose extension claims it is a video", async () => {
  const lying = join(dir, "actually-a-still.mp4");
  copyFileSync(jpg, lying);
  expect(await detectMediaKind(lying)).toBe("photo");
});

test("reports video for a clip whose extension claims it is a photo", async () => {
  const lying = join(dir, "actually-a-clip.jpg");
  copyFileSync(clip, lying);
  expect(await detectMediaKind(lying)).toBe("video");
});

test("rejects HEIF input with an error naming the format", async () => {
  const err = await detectMediaKind(heif).then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  const message = err instanceof Error ? err.message : "";
  expect(message).toContain("HEIC");
  // Actionable: it must say what to do, not just that something went wrong.
  expect(message.toLowerCase()).toContain("convert");
  expect(message).toContain(heif);
});

test("the HEIF rejection does not leak a raw ffprobe dump", async () => {
  const err = await detectMediaKind(heif).then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error); // or the assertions below pass vacuously
  const message = err instanceof Error ? err.message : "";
  // What ffprobe says about a HEIC, and what the user must never be shown.
  expect(message).not.toContain("moov atom not found");
  expect(message).not.toContain("Invalid data found");
  expect(message).not.toContain("ffprobe exited");
});

test("rejects HEIF content even when the extension hides it", async () => {
  // Detection is on the container's ftyp brand, not on the file name.
  const disguised = join(dir, "disguised.jpg");
  copyFileSync(heif, disguised);
  const err = await detectMediaKind(disguised).then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  expect(err instanceof Error ? err.message : "").toContain("HEIC");
});

test("does not mistake an MP4 ftyp box for HEIF", async () => {
  // An MP4 carries an ftyp box too; only the HEIF brands may trip the guard.
  expect(await detectMediaKind(clip)).toBe("video");
});

test("rejects a file it cannot read, naming the file", async () => {
  const missing = join(dir, "nope.jpg");
  const err = await detectMediaKind(missing).then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  expect(err instanceof Error ? err.message : "").toContain(missing);
});
