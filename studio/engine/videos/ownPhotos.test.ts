import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { RenderFailure } from "../renderQueue/queue";
import { copyOwnPhotos, ownPhotoCopyName, readVerifiedOwnPhoto, type OwnPhotoSource } from "./ownPhotos";
useNativeGlobals();

// The render reads a VERIFIED COPY of each own photo (3f.2), as it does for a built-in sticker (sha-checked, copied with `wx` into the job
// folder) and a track (`track.m4a`): ffmpeg is never pointed at the library file, so a file swapped, truncated or replaced by a link after
// the render was admitted changes nothing it reads. Whatever fails here fails the job without a path in its text.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-own-photos-");
const libraryDir = (): string => join(tmp(), "library");
const jobDir = (): string => join(tmp(), "job");

beforeEach(async () => {
  await mkdir(libraryDir(), { recursive: true });
  await mkdir(jobDir(), { recursive: true });
});

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

async function stored(mediaId: string, bytes: Uint8Array): Promise<OwnPhotoSource> {
  const path = join(libraryDir(), `${mediaId}.jpg`);
  await writeFile(path, bytes);
  return { mediaId, path, sha256: sha(bytes), bytes: bytes.length, width: 40, height: 30 };
}

const failureOf = async (work: Promise<unknown>): Promise<RenderFailure> => {
  try {
    await work;
  } catch (error) {
    if (error instanceof RenderFailure) return error;
    throw error;
  }
  throw new Error("expected a RenderFailure");
};

describe("ownPhotoCopyName", () => {
  test("names the copy after the media id, in the job folder", () => {
    expect(ownPhotoCopyName("media-0000001")).toBe("own-media-0000001.jpg");
  });

  test("two media never share a name", () => {
    expect(ownPhotoCopyName("media-0000001")).not.toBe(ownPhotoCopyName("media-0000002"));
  });
});

describe("copyOwnPhotos", () => {
  test("writes a byte-identical private copy of each photo into the job folder", async () => {
    const a = await stored("media-0000001", Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    const b = await stored("media-0000002", Uint8Array.from([0xff, 0xd8, 0xff, 9, 8, 7, 6]));
    await copyOwnPhotos(jobDir(), [a, b], new AbortController().signal);
    expect(new Uint8Array(await readFile(join(jobDir(), ownPhotoCopyName("media-0000001"))))).toEqual(Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    expect(new Uint8Array(await readFile(join(jobDir(), ownPhotoCopyName("media-0000002"))))).toEqual(Uint8Array.from([0xff, 0xd8, 0xff, 9, 8, 7, 6]));
  });

  test("a change to the library file after the copy does not reach the copy", async () => {
    const a = await stored("media-0000001", Uint8Array.from([0xff, 0xd8, 0xff, 1]));
    await copyOwnPhotos(jobDir(), [a], new AbortController().signal);
    await writeFile(a.path, Uint8Array.from([0xff, 0xd8, 0xff, 99]));
    expect(new Uint8Array(await readFile(join(jobDir(), ownPhotoCopyName("media-0000001"))))).toEqual(Uint8Array.from([0xff, 0xd8, 0xff, 1]));
  });

  test("copies nothing for no photos", async () => {
    await copyOwnPhotos(jobDir(), [], new AbortController().signal);
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("refuses a file whose bytes changed but whose size did not, and leaves no copy", async () => {
    const a = await stored("media-0000001", Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    await writeFile(a.path, Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 4]));
    const failure = await failureOf(copyOwnPhotos(jobDir(), [a], new AbortController().signal));
    expect(failure.engineError.code).toBe("RENDER_FAILED");
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("refuses a file that grew by one byte", async () => {
    const a = await stored("media-0000001", Uint8Array.from([0xff, 0xd8, 0xff, 1]));
    await writeFile(a.path, Uint8Array.from([0xff, 0xd8, 0xff, 1, 0]));
    await failureOf(copyOwnPhotos(jobDir(), [a], new AbortController().signal));
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("refuses a file that shrank by one byte", async () => {
    const a = await stored("media-0000001", Uint8Array.from([0xff, 0xd8, 0xff, 1, 2]));
    await writeFile(a.path, Uint8Array.from([0xff, 0xd8, 0xff, 1]));
    await failureOf(copyOwnPhotos(jobDir(), [a], new AbortController().signal));
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("refuses a file that is gone", async () => {
    const a = await stored("media-0000001", Uint8Array.from([0xff, 0xd8, 0xff, 1]));
    await writeFile(a.path, new Uint8Array(0));
    const missing: OwnPhotoSource = { ...a, path: join(libraryDir(), "nothing.jpg") };
    await failureOf(copyOwnPhotos(jobDir(), [missing], new AbortController().signal));
  });

  test("refuses a library file that is a link, even to a file with the right bytes", async () => {
    const bytes = Uint8Array.from([0xff, 0xd8, 0xff, 5, 5, 5]);
    const real = await stored("media-0000002", bytes);
    const link = join(libraryDir(), "media-0000001.jpg");
    await symlink(real.path, link);
    await failureOf(copyOwnPhotos(jobDir(), [{ ...real, mediaId: "media-0000001", path: link }], new AbortController().signal));
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("never writes through a name that is already in the job folder", async () => {
    const a = await stored("media-0000001", Uint8Array.from([0xff, 0xd8, 0xff, 1]));
    const target = join(tmp(), "elsewhere.bin");
    await writeFile(target, "keep me");
    await symlink(target, join(jobDir(), ownPhotoCopyName("media-0000001")));
    await failureOf(copyOwnPhotos(jobDir(), [a], new AbortController().signal));
    expect(await readFile(target, "utf8")).toBe("keep me");
  });

  test("a failure names no path", async () => {
    const a = await stored("media-0000001", Uint8Array.from([0xff, 0xd8, 0xff, 1]));
    await writeFile(a.path, Uint8Array.from([0xff, 0xd8, 0xff, 2]));
    const failure = await failureOf(copyOwnPhotos(jobDir(), [a], new AbortController().signal));
    expect(JSON.stringify(failure.engineError)).not.toContain(tmp());
    expect(failure.message).not.toContain(tmp());
  });

  test("a cancel stops it before the next photo is copied", async () => {
    const a = await stored("media-0000001", Uint8Array.from([0xff, 0xd8, 0xff, 1]));
    const b = await stored("media-0000002", Uint8Array.from([0xff, 0xd8, 0xff, 2]));
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(copyOwnPhotos(jobDir(), [a, b], controller.signal)).rejects.toThrow("stopped");
    expect(await readdir(jobDir())).toEqual([]);
  });
});

describe("readVerifiedOwnPhoto (what the focus is judged from)", () => {
  test("answers the bytes of a file that is the size and hash its record gave", async () => {
    const a = await stored("media-0000001", Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    expect(await readVerifiedOwnPhoto(a, new AbortController().signal)).toEqual(Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]));
  });

  test("refuses a file whose bytes changed, a file that is gone and a link", async () => {
    const a = await stored("media-0000001", Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3]));
    await writeFile(a.path, Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 4]));
    await failureOf(readVerifiedOwnPhoto(a, new AbortController().signal));
    await failureOf(readVerifiedOwnPhoto({ ...a, path: join(libraryDir(), "nothing.jpg") }, new AbortController().signal));
    const link = join(libraryDir(), "link.jpg");
    await symlink(a.path, link);
    await failureOf(readVerifiedOwnPhoto({ ...a, path: link }, new AbortController().signal));
  });

  test("a cancel rejects with the signal's reason", async () => {
    const a = await stored("media-0000001", Uint8Array.from([0xff, 0xd8, 0xff, 1]));
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(readVerifiedOwnPhoto(a, controller.signal)).rejects.toThrow("stopped");
  });
});
