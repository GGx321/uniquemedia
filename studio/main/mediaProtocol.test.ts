import { mkdir, mkdtemp, readFile, rename, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { videoPaths } from "../engine/videos/record";
import { canSymlink, countingFs, recordFor, useMediaWorld, type MediaWorld } from "./media/testing";
import { fakeVideoBytes } from "../engine/videos/testing/kit";
import { useNativeGlobals, useNativeWebClasses } from "../testing/nativeGlobals";
import { CHUNK_BYTES } from "./media/respond";
import { createStickerLookup } from "./media/stickers";
import { handleMediaRequest, MEDIA_SCHEME, MEDIA_SCHEME_PRIVILEGES, type MediaDeps, type MediaRequest } from "./mediaProtocol";
useNativeGlobals();
useNativeWebClasses();

// The `studio-media://` handler, end to end over real folders and the product's own `Response` class (not
// happy-dom's, which the repo's test setup installs): the routes of invariant 28, Range, and the ways a request
// can go wrong. The pieces have their own files under ./media; this one proves they are wired in the right order.

const AVATAR = "avatar-0001";
const PHOTO = "photo-00001";
const VIDEO = "video-00000001";
const TRACK = "track-000001";
const PNG = Uint8Array.from(Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcxjAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"));
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100, 1)]);
const MP4 = Buffer.concat([Buffer.from([0, 0, 0, 0x20]), Buffer.from("ftypisom"), Buffer.from(fakeVideoBytes(CHUNK_BYTES * 2 + 1000, 5))]);

const world = useMediaWorld();
let w: MediaWorld;
let outside = "";
let userData = "";
beforeEach(async () => {
  w = world();
  outside = await mkdtemp(join(tmpdir(), "studio-media-outside-"));
  userData = join(w.dir, "userdata");
  await mkdir(join(userData, "music", "tracks"), { recursive: true });
  await mkdir(join(userData, "render-tmp", "text"), { recursive: true });
  await mkdir(join(w.libraryRoot, "avatars", AVATAR, "photos"), { recursive: true });
  await mkdir(videoPaths(w.libraryRoot, w.avatarId).videosDir, { recursive: true });
});
afterEach(() => rm(outside, { recursive: true, force: true }));

const deps = (overrides: Partial<MediaDeps> = {}): MediaDeps => ({
  libraryRoot: () => w.libraryRoot,
  exportRoot: () => w.exportRoot,
  musicRoot: () => join(userData, "music"),
  textPreviewRoot: () => join(userData, "render-tmp", "text"),
  sticker: createStickerLookup(resolve(import.meta.dirname, "../assets/stickers")),
  ...overrides,
});

const get = (url: string, extra: Partial<MediaRequest> & { range?: string } = {}, overrides: Partial<MediaDeps> = {}): Promise<Response> => {
  const { range, ...rest } = extra;
  return handleMediaRequest({ url, method: "GET", headers: new Headers(range === undefined ? {} : { Range: range }), ...rest }, deps(overrides));
};

/** A committed video of `MP4` at the export root, with its record. */
async function commitVideo(): Promise<string> {
  const record = recordFor(w, { videoId: VIDEO, relPath: "Mia/2026-09-29_photo_001.mp4", bytes: MP4 });
  await writeFile(videoPaths(w.libraryRoot, w.avatarId).record(VIDEO), JSON.stringify(record));
  await mkdir(join(w.exportRoot, "Mia"), { recursive: true });
  const file = join(w.exportRoot, "Mia", "2026-09-29_photo_001.mp4");
  await writeFile(file, MP4);
  return file;
}
const videoUrl = (): string => `studio-media://video/${w.avatarId}/${VIDEO}`;

describe("photo: the route Stage 1 shipped stays as it was", () => {
  beforeEach(() => writeFile(join(w.libraryRoot, "avatars", AVATAR, "photos", `${PHOTO}.png`), PNG));

  test("serves a real photo with its image MIME type and nosniff", async () => {
    const response = await get(`studio-media://photo/${AVATAR}/${PHOTO}`);
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe("image/png");
    expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG);
  });

  test("an unknown photo or avatar is a 404 with nosniff", async () => {
    for (const url of [`studio-media://photo/${AVATAR}/photo-99999`, `studio-media://photo/avatar-9999/${PHOTO}`]) {
      const response = await get(url);
      expect(response.status).toBe(404);
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
    }
  });

  test.skipIf(!canSymlink)("a symlink out of the library is a 404", async () => {
    await writeFile(join(outside, "secret.png"), PNG);
    await symlink(join(outside, "secret.png"), join(w.libraryRoot, "avatars", AVATAR, "photos", "photo-00002.png"));
    expect((await get(`studio-media://photo/${AVATAR}/photo-00002`)).status).toBe(404);
  });

  test("a file whose bytes are not the image its extension claims is a 404", async () => {
    await writeFile(join(w.libraryRoot, "avatars", AVATAR, "photos", "photo-00003.png"), "<html>not an image</html>");
    expect((await get(`studio-media://photo/${AVATAR}/photo-00003`)).status).toBe(404);
  });

  test("a missing library root is a 404", async () => {
    expect((await get(`studio-media://photo/${AVATAR}/${PHOTO}`, {}, { libraryRoot: () => join(w.dir, "nope") })).status).toBe(404);
  });

  test("a photo answers a Range too", async () => {
    const response = await get(`studio-media://photo/${AVATAR}/${PHOTO}`, { range: "bytes=0-3" });
    expect(response.status).toBe(206);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(PNG.slice(0, 4));
  });
});

describe("every route answers over the wire shape the renderer sees", () => {
  test("video, poster, track, cover, sticker, text and media each serve their file with the right type", async () => {
    await commitVideo();
    const videos = videoPaths(w.libraryRoot, w.avatarId).videosDir;
    await writeFile(join(videos, `${VIDEO}.poster.jpg`), JPEG);
    await writeFile(join(userData, "music", "tracks", `${TRACK}.m4a`), MP4);
    await mkdir(join(userData, "music", "covers"), { recursive: true });
    await writeFile(join(userData, "music", "covers", `${TRACK}.jpg`), JPEG);
    await writeFile(join(userData, "render-tmp", "text", "preview-0001.png"), PNG);
    await mkdir(join(w.libraryRoot, "media"), { recursive: true });
    const gif = Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(20)]);
    await writeFile(join(w.libraryRoot, "media", "media-000001.gif"), gif);
    // 3f.2: an own upload is served through its record, so the engine's record sits beside the stored file.
    await writeFile(
      join(w.libraryRoot, "media", "media-000001.json"),
      JSON.stringify({ schemaVersion: 1, id: "media-000001", kind: "sticker", name: "x.gif", createdAt: "2026-10-04T10:00:00.000Z", bytes: gif.length, sha256: "a".repeat(64), format: "gif", file: "media-000001.gif", width: 10, height: 10, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: 3, delayFrames: [1, 1, 1] }),
    );
    const cases: [string, string][] = [
      [videoUrl(), "video/mp4"],
      [`studio-media://poster/${w.avatarId}/${VIDEO}`, "image/jpeg"],
      [`studio-media://track/${TRACK}`, "audio/mp4"],
      [`studio-media://cover/${TRACK}`, "image/jpeg"],
      ["studio-media://sticker/heart-pulse", "image/apng"],
      ["studio-media://text/preview-0001", "image/png"],
      ["studio-media://media/media-000001", "image/gif"],
    ];
    for (const [url, type] of cases) {
      const response = await get(url);
      expect([url, response.status]).toEqual([url, 200]);
      expect(response.headers.get("Content-Type")).toBe(type);
      expect(response.headers.get("Accept-Ranges")).toBe("bytes");
      expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
      await response.arrayBuffer();
    }
  });
});

describe("video: Range and streaming", () => {
  test("no Range: 200 with the whole file, streamed", async () => {
    await commitVideo();
    const response = await get(videoUrl());
    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Length")).toBe(String(MP4.length));
    expect(Buffer.from(await response.arrayBuffer()).equals(MP4)).toBe(true);
  });

  test("a seek: 206 with the bytes asked for and their Content-Range", async () => {
    await commitVideo();
    const response = await get(videoUrl(), { range: `bytes=${CHUNK_BYTES - 5}-${CHUNK_BYTES + 5}` });
    expect(response.status).toBe(206);
    expect(response.headers.get("Content-Range")).toBe(`bytes ${CHUNK_BYTES - 5}-${CHUNK_BYTES + 5}/${MP4.length}`);
    expect(Buffer.from(await response.arrayBuffer()).equals(MP4.subarray(CHUNK_BYTES - 5, CHUNK_BYTES + 6))).toBe(true);
  });

  test("the last byte, by suffix", async () => {
    await commitVideo();
    const response = await get(videoUrl(), { range: "bytes=-1" });
    expect(response.status).toBe(206);
    expect(Buffer.from(await response.arrayBuffer()).equals(MP4.subarray(MP4.length - 1))).toBe(true);
  });

  test("a range past the end is 416 with the size, and no body", async () => {
    await commitVideo();
    const response = await get(videoUrl(), { range: `bytes=${MP4.length}-` });
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Range")).toBe(`bytes */${MP4.length}`);
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  test("several ranges are 416", async () => {
    await commitVideo();
    expect((await get(videoUrl(), { range: "bytes=0-1,5-6" })).status).toBe(416);
  });

  test("a malformed Range is 416", async () => {
    await commitVideo();
    expect((await get(videoUrl(), { range: "bytes=abc" })).status).toBe(416);
  });

  test("a Range on a route that would 404 is still a 404, with no Content-Range", async () => {
    const response = await get(videoUrl(), { range: "bytes=0-1" });
    expect(response.status).toBe(404);
    expect(response.headers.get("Content-Range")).toBeNull();
  });
});

describe("video: the renderer goes away, and the file is deleted while it plays", () => {
  test("cancelling the response stops the reading and leaves nothing open", async () => {
    await commitVideo();
    const counted = countingFs();
    const response = await get(videoUrl(), {}, { fs: counted });
    const reader = response.body?.getReader();
    expect((await reader?.read())?.value?.length).toBe(CHUNK_BYTES);
    await reader?.cancel();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    const openedAtCancel = counted.opened;
    // Every handle that was opened is closed, and cancelling started no read after it.
    expect(counted.opened).toBeGreaterThan(0);
    expect(counted.closed).toBe(counted.opened);
    await rm(join(w.exportRoot, "Mia", "2026-09-29_photo_001.mp4"));
    expect(counted.opened).toBe(openedAtCancel);
  });

  test("an aborted request ends the stream with an error", async () => {
    await commitVideo();
    const controller = new AbortController();
    const response = await get(videoUrl(), { signal: controller.signal });
    const reader = response.body?.getReader();
    await reader?.read();
    controller.abort();
    await expect(reader?.read()).rejects.toBeDefined();
  });

  test("the file can be deleted between two chunks of a stream (what videos.delete does, and what a Windows handle would block), and the stream then fails instead of hanging", async () => {
    const file = await commitVideo();
    const response = await get(videoUrl());
    const reader = response.body?.getReader();
    expect((await reader?.read())?.value?.length).toBe(CHUNK_BYTES);
    await unlink(file);
    await expect(reader?.read()).rejects.toBeDefined();
  });

  test("a video replaced between two chunks does not leak the other file's bytes", async () => {
    const file = await commitVideo();
    const response = await get(videoUrl());
    const reader = response.body?.getReader();
    await reader?.read();
    await writeFile(`${file}.swap`, Buffer.concat([MP4.subarray(0, 12), Buffer.alloc(MP4.length - 12, 0x58)]));
    await rename(`${file}.swap`, file);
    await expect(reader?.read()).rejects.toBeDefined();
  });

  test("a stalled reader holds nothing: the file can be deleted while the renderer has stopped asking", async () => {
    const file = await commitVideo();
    const counted = countingFs();
    const response = await get(videoUrl(), {}, { fs: counted });
    const reader = response.body?.getReader();
    await reader?.read();
    await new Promise((resolveWait) => setTimeout(resolveWait, 20));
    // The renderer has stopped asking, the stream is open, and no handle of ours is: this is what a Windows delete needs.
    expect(counted.opened).toBeGreaterThan(0);
    expect(counted.closed).toBe(counted.opened);
    await unlink(file);
    await reader?.cancel();
    expect(counted.closed).toBe(counted.opened);
  });
});

describe("every refusal looks the same", () => {
  const plain = async (response: Response): Promise<unknown> => ({
    status: response.status,
    headers: [...response.headers.entries()].sort(),
    body: (await response.text()).length,
  });

  test("a 404 has no body and only nosniff: nothing in it names a file, an id or a reason", async () => {
    const response = await get(`studio-media://photo/${AVATAR}/photo-99999`);
    expect(response.status).toBe(404);
    expect([...response.headers.entries()]).toEqual([["x-content-type-options", "nosniff"]]);
    expect(await response.text()).toBe("");
  });

  test("a file that is not there, a file refused for its kind, a link and an unparsable URL all answer identically", async () => {
    const photos = join(w.libraryRoot, "avatars", AVATAR, "photos");
    await writeFile(join(photos, "photo-0000bad1.png"), "<html></html>");
    await writeFile(join(outside, "secret.png"), PNG);
    const linked = canSymlink;
    if (linked) await symlink(join(outside, "secret.png"), join(photos, "photo-0000bad2.png"));
    const urls = [
      `studio-media://photo/${AVATAR}/photo-0000none`,
      `studio-media://photo/${AVATAR}/photo-0000bad1`,
      ...(linked ? [`studio-media://photo/${AVATAR}/photo-0000bad2`] : []),
      `studio-media://photo/${AVATAR}/../../etc/passwd`,
      "studio-media://nothing/whatever",
      videoUrl(),
    ];
    const answers = await Promise.all(urls.map(async (url) => plain(await get(url))));
    for (const answer of answers) expect(answer).toEqual(answers[0]);
  });

  test("a method other than GET is a 404, on every route", async () => {
    await commitVideo();
    for (const method of ["POST", "PUT", "DELETE", "HEAD", "PATCH", "OPTIONS"]) {
      expect((await handleMediaRequest({ url: videoUrl(), method }, deps())).status).toBe(404);
    }
  });

  test("a malformed URL never reaches the file system", async () => {
    let touched = 0;
    const counting = deps({
      libraryRoot: () => {
        touched++;
        return w.libraryRoot;
      },
      exportRoot: () => {
        touched++;
        return w.exportRoot;
      },
      musicRoot: () => {
        touched++;
        return join(userData, "music");
      },
      textPreviewRoot: () => {
        touched++;
        return join(userData, "render-tmp", "text");
      },
    });
    for (const url of [`studio-media://video/${w.avatarId}/..%2f..%2fetc`, `studio-media://track/${TRACK}/x`, `studio-media://track/%2e%2e`, "studio-media://video/x/y"]) {
      expect((await handleMediaRequest({ url, method: "GET" }, counting)).status).toBe(404);
    }
    expect(touched).toBe(0);
  });

  test("a dependency that throws is a 404, not a crash", async () => {
    const response = await get(`studio-media://photo/${AVATAR}/${PHOTO}`, {}, {
      libraryRoot: () => {
        throw new Error("EIO: /secret/path");
      },
    });
    expect(response.status).toBe(404);
    expect(await response.text()).toBe("");
  });
});

describe("the scheme's privileges and the renderer's policy", () => {
  test("the scheme is registered standard, secure, fetch and stream, and nothing more", () => {
    expect(MEDIA_SCHEME).toBe("studio-media");
    expect(MEDIA_SCHEME_PRIVILEGES).toEqual({ standard: true, secure: true, supportFetchAPI: true, stream: true });
  });

  test("main registers exactly those privileges and never bypasses the CSP", async () => {
    const source = await readFile(resolve(import.meta.dirname, "main.ts"), "utf8");
    expect(source).toContain("privileges: MEDIA_SCHEME_PRIVILEGES");
    expect(source).not.toMatch(/bypassCSP\s*:/);
    expect(MEDIA_SCHEME_PRIVILEGES).not.toHaveProperty("bypassCSP");
  });

  // 3d.4 review (HIGH, verified on Electron 43.1.1): with `corsEnabled` the WHOLE scheme opens: an `<img crossorigin>` drawn on a
  // canvas reads any route from the app page (connect-src does not cover it), and any other page in the session (a data: page, a
  // foreign origin) fetches photos with type=basic, since Electron checks no CORS on protocol.handle answers and the handler sees no
  // Origin to refuse by. The preview's sticker bytes come over IPC instead (`stickers.bytes`, main/stickerBytesFlow.ts).
  test("the scheme is never CORS-enabled: no script, in the app or any other page, reads a route's bytes", async () => {
    expect(MEDIA_SCHEME_PRIVILEGES).not.toHaveProperty("corsEnabled");
    const source = await readFile(resolve(import.meta.dirname, "main.ts"), "utf8");
    expect(source).not.toMatch(/corsEnabled\s*:/);
  });

  test("the renderer CSP names no route of the scheme anywhere (connect-src stays the page's own)", async () => {
    const html = await readFile(resolve(import.meta.dirname, "../renderer/index.html"), "utf8");
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? "";
    const directives = Object.fromEntries(csp.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
    for (const [name, values] of Object.entries(directives)) expect([name, values.some((v) => v.startsWith("studio-media://"))]).toEqual([name, false]);
    expect(directives["connect-src"] ?? ["'self'"]).toEqual(["'self'"]);
  });

  test("the renderer CSP lets the whole scheme into img-src and media-src only", async () => {
    const html = await readFile(resolve(import.meta.dirname, "../renderer/index.html"), "utf8");
    const csp = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? "";
    const directives = Object.fromEntries(csp.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
    expect(directives["img-src"]).toContain("studio-media:");
    expect(directives["media-src"]).toEqual(["studio-media:"]);
    for (const [name, values] of Object.entries(directives)) {
      if (name !== "img-src" && name !== "media-src") expect([name, values.includes("studio-media:")]).toEqual([name, false]);
    }
    expect(directives["default-src"]).toEqual(["'self'"]);
  });
});
