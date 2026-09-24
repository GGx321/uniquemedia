import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ffmpegPath } from "../../node/ffmpegBinary";
import { openLibrary } from "./library";
import {
  PNG_1X1,
  SAMPLE_AVATAR,
  expectLibraryError,
  rejectionOf,
  samplePhotoMeta,
  sequentialIds,
  steppingClock,
  useTempDir,
} from "./testing/helpers";

const root = useTempDir("studio-thumb-");

/** A real PNG of the given size, rendered by the bundled ffmpeg. */
async function renderPng(width: number, height: number): Promise<Uint8Array> {
  const out = join(root(), `source-${width}x${height}.png`);
  const r = spawnSync(ffmpegPath(), [
    "-hide_banner", "-y", "-f", "lavfi", "-i", `testsrc2=size=${width}x${height}`, "-frames:v", "1", out,
  ]);
  if (r.status !== 0) throw new Error(`renderPng failed: ${r.stderr.toString()}`);
  return new Uint8Array(await readFile(out));
}

/** Width and height from a WebP header (lossy VP8, lossless VP8L or extended VP8X). */
function webpSize(b: Uint8Array): { width: number; height: number } {
  const ascii = (at: number, n: number) => String.fromCharCode(...b.subarray(at, at + n));
  if (ascii(0, 4) !== "RIFF" || ascii(8, 4) !== "WEBP") throw new Error("not a WebP file");
  const chunk = ascii(12, 4);
  if (chunk === "VP8 ") {
    return { width: (b[26] | (b[27] << 8)) & 0x3fff, height: (b[28] | (b[29] << 8)) & 0x3fff };
  }
  if (chunk === "VP8L") {
    const bits = b[21] | (b[22] << 8) | (b[23] << 16) | (b[24] << 24);
    return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
  }
  if (chunk === "VP8X") {
    const u24 = (i: number) => b[i] | (b[i + 1] << 8) | (b[i + 2] << 16);
    return { width: u24(24) + 1, height: u24(27) + 1 };
  }
  throw new Error(`unknown WebP chunk ${chunk}`);
}

async function libraryWithPortrait() {
  const { library } = await openLibrary(root(), { now: steppingClock(), newId: sequentialIds() });
  const avatar = await library.createAvatar(SAMPLE_AVATAR);
  const bytes = await renderPng(720, 960);
  const photo = await library.addPhoto(avatar.id, bytes, samplePhotoMeta({ width: 720, height: 960 }));
  return { library, avatar, photo };
}

describe("thumbnail", () => {
  test("renders a 360 px wide WebP into thumbs/<photoId>.webp, keeping the aspect ratio", async () => {
    const { library, avatar, photo } = await libraryWithPortrait();

    const path = await library.thumbnail(avatar.id, photo.id);

    expect(path).toBe(join(root(), "avatars", avatar.id, "thumbs", `${photo.id}.webp`));
    expect(webpSize(new Uint8Array(await readFile(path)))).toEqual({ width: 360, height: 480 });
    expect(await readdir(join(root(), "avatars", avatar.id, "thumbs"))).toEqual([`${photo.id}.webp`]);
  }, 30_000);

  test("returns the cached file on later calls instead of rendering again", async () => {
    const { library, avatar, photo } = await libraryWithPortrait();
    const path = await library.thumbnail(avatar.id, photo.id);
    await writeFile(path, "cached-marker");

    expect(await library.thumbnail(avatar.id, photo.id)).toBe(path);
    expect(await readFile(path, "utf8")).toBe("cached-marker");
  }, 30_000);

  test("a zero-byte file left at the thumbnail path is not a cache hit and gets rendered again", async () => {
    const { library, avatar, photo } = await libraryWithPortrait();
    const thumbsDir = join(root(), "avatars", avatar.id, "thumbs");
    await mkdir(thumbsDir, { recursive: true });
    await writeFile(join(thumbsDir, `${photo.id}.webp`), new Uint8Array(0));

    const path = await library.thumbnail(avatar.id, photo.id);

    expect(webpSize(new Uint8Array(await readFile(path)))).toEqual({ width: 360, height: 480 });
  }, 30_000);

  test("concurrent requests for the same thumbnail render it once", async () => {
    let renders = 0;
    const renderThumbnail = async (_input: string, output: string) => {
      renders++;
      await new Promise((resolve) => setTimeout(resolve, 20));
      await writeFile(output, "fake-webp");
    };
    const { library } = await openLibrary(root(), { newId: sequentialIds(), renderThumbnail });
    const avatar = await library.createAvatar(SAMPLE_AVATAR);
    const photo = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());

    const paths = await Promise.all([1, 2, 3].map(() => library.thumbnail(avatar.id, photo.id)));

    expect(renders).toBe(1);
    expect(new Set(paths).size).toBe(1);
    expect(await readFile(paths[0], "utf8")).toBe("fake-webp");
  });

  test("a crash before the rendered thumbnail is renamed into place leaves no thumbnail, and the next open sweeps the temp", async () => {
    const crash = new Error("simulated crash");
    const renderThumbnail = async (_input: string, output: string) => writeFile(output, "fake-webp");
    const { library } = await openLibrary(root(), {
      newId: sequentialIds(),
      renderThumbnail,
      testHooks: { beforeRename: (finalPath) => { if (finalPath.endsWith(".webp")) throw crash; } },
    });
    const avatar = await library.createAvatar(SAMPLE_AVATAR);
    const photo = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta());
    const thumbsDir = join(root(), "avatars", avatar.id, "thumbs");

    expect(await rejectionOf(library.thumbnail(avatar.id, photo.id))).toBe(crash);
    expect(await readdir(thumbsDir)).not.toContain(`${photo.id}.webp`);

    const { report } = await openLibrary(root());
    expect(report.quarantined.map((q) => q.reason)).toEqual(["temp-file"]);
    expect(await readdir(thumbsDir)).toEqual([]);
  });

  test("open sweeps ffmpeg's .part- leftovers out of thumbs", async () => {
    const { avatar, photo } = await libraryWithPortrait();
    const thumbsDir = join(root(), "avatars", avatar.id, "thumbs");
    await mkdir(thumbsDir, { recursive: true });
    await writeFile(join(thumbsDir, `${photo.id}.part-0b8f0e9c-7d7e-4c55-9a51-2f0d4c1b8e3a.webp`), "half");

    const { report } = await openLibrary(root());

    expect(report.quarantined.map((q) => [q.from, q.reason])).toEqual([
      [join("avatars", avatar.id, "thumbs", `${photo.id}.part-0b8f0e9c-7d7e-4c55-9a51-2f0d4c1b8e3a.webp`), "temp-file"],
    ]);
  }, 30_000);

  test("refuses a photo the library does not hold", async () => {
    const { library, avatar } = await libraryWithPortrait();
    await expectLibraryError(library.thumbnail(avatar.id, "not-a-photo"), "photo-not-found");
  }, 30_000);

  test("refuses a photo that belongs to another avatar", async () => {
    const { library, photo } = await libraryWithPortrait();
    const other = await library.createAvatar({ ...SAMPLE_AVATAR, name: "Lena" });
    await expectLibraryError(library.thumbnail(other.id, photo.id), "photo-not-found");
  }, 30_000);
});
