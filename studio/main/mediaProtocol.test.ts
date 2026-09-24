import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleMediaRequest, parseMediaUrl } from "./mediaProtocol";

const AVATAR = "avatar-0001";
const PHOTO = "photo-00001";
const PNG = Uint8Array.from(
  Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"),
);

describe("parseMediaUrl", () => {
  test("accepts studio-media://photo/<avatarId>/<photoId>", () => {
    expect(parseMediaUrl(`studio-media://photo/${AVATAR}/${PHOTO}`)).toEqual({ avatarId: AVATAR, photoId: PHOTO });
  });

  const rejected: [string, string][] = [
    ["another host", `studio-media://video/${AVATAR}/${PHOTO}`],
    ["another scheme", `file://photo/${AVATAR}/${PHOTO}`],
    ["a missing photo id", `studio-media://photo/${AVATAR}`],
    ["a trailing slash", `studio-media://photo/${AVATAR}/${PHOTO}/`],
    ["an extra segment", `studio-media://photo/${AVATAR}/${PHOTO}/x`],
    ["an empty segment", `studio-media://photo//${AVATAR}/${PHOTO}`],
    ["a dot-dot walk", `studio-media://photo/${AVATAR}/../../etc/passwd`],
    ["an encoded dot-dot", `studio-media://photo/%2e%2e/${PHOTO}`],
    ["an encoded slash", `studio-media://photo/${AVATAR}%2f${PHOTO}/x`],
    ["uppercase ids", `studio-media://photo/AVATAR-0001/${PHOTO}`],
    ["a short id", `studio-media://photo/abc/${PHOTO}`],
    ["an id longer than 64", `studio-media://photo/${"a".repeat(65)}/${PHOTO}`],
    ["an extension in the id", `studio-media://photo/${AVATAR}/${PHOTO}.png`],
    ["a query", `studio-media://photo/${AVATAR}/${PHOTO}?x=1`],
    ["a fragment", `studio-media://photo/${AVATAR}/${PHOTO}#x`],
    ["credentials", `studio-media://user:pw@photo/${AVATAR}/${PHOTO}`],
    ["a port", `studio-media://photo:81/${AVATAR}/${PHOTO}`],
    ["garbage", "not a url"],
  ];
  for (const [name, url] of rejected) {
    test(`rejects ${name}`, () => {
      expect(parseMediaUrl(url)).toBeNull();
    });
  }

  test("accepts ids at the 8 and 64 char limits", () => {
    const long = "a".repeat(64);
    expect(parseMediaUrl(`studio-media://photo/abcdefgh/${long}`)).toEqual({ avatarId: "abcdefgh", photoId: long });
    expect(parseMediaUrl(`studio-media://photo/abcdefg/${PHOTO}`)).toBeNull();
  });
});

describe("handleMediaRequest", () => {
  let root = "";
  let outside = "";
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "studio-media-"));
    outside = await mkdtemp(join(tmpdir(), "studio-media-outside-"));
    await mkdir(join(root, "avatars", AVATAR, "photos"), { recursive: true });
    await writeFile(join(root, "avatars", AVATAR, "photos", `${PHOTO}.png`), PNG);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  });

  const get = (url: string) => handleMediaRequest({ url, method: "GET" }, { libraryRoot: () => root });

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

  test("a malformed URL is a 404 and never reaches the file system", async () => {
    let resolved = 0;
    const response = await handleMediaRequest(
      { url: `studio-media://photo/${AVATAR}/../../x`, method: "GET" },
      {
        libraryRoot: () => root,
        resolve: async () => {
          resolved++;
          return { ok: false, code: "not-found", message: "" };
        },
      },
    );
    expect(response.status).toBe(404);
    expect(resolved).toBe(0);
  });

  test("a method other than GET is a 404", async () => {
    const response = await handleMediaRequest({ url: `studio-media://photo/${AVATAR}/${PHOTO}`, method: "POST" }, { libraryRoot: () => root });
    expect(response.status).toBe(404);
  });

  test("a symlink out of the library is a 404", async () => {
    await writeFile(join(outside, "secret.png"), PNG);
    await symlink(join(outside, "secret.png"), join(root, "avatars", AVATAR, "photos", "photo-00002.png"));
    expect((await get(`studio-media://photo/${AVATAR}/photo-00002`)).status).toBe(404);
  });

  test("a file whose bytes are not the image its extension claims is a 404", async () => {
    await writeFile(join(root, "avatars", AVATAR, "photos", "photo-00003.png"), "<html>not an image</html>");
    expect((await get(`studio-media://photo/${AVATAR}/photo-00003`)).status).toBe(404);
  });

  test("a missing library root is a 404", async () => {
    const response = await handleMediaRequest({ url: `studio-media://photo/${AVATAR}/${PHOTO}`, method: "GET" }, { libraryRoot: () => join(root, "nope") });
    expect(response.status).toBe(404);
  });

  test("a read error is a 404, not a crash", async () => {
    const response = await handleMediaRequest(
      { url: `studio-media://photo/${AVATAR}/${PHOTO}`, method: "GET" },
      { libraryRoot: () => root, read: async () => { throw new Error("EIO"); } },
    );
    expect(response.status).toBe(404);
  });
});
