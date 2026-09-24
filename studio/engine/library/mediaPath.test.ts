import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { resolveMediaPath, type MediaPathErrorCode, type MediaPathResult } from "./mediaPath";
import { JPEG_HEADER_ONLY, PNG_1X1, WEBP_HEADER_ONLY, useTempDir } from "./testing/helpers";

// One temp dir per test holding the library root and, beside it, an
// "outside" folder that symlinks try to reach.
const base = useTempDir("studio-media-");
const root = () => join(base(), "library");
const outside = () => join(base(), "outside");

const AVATAR = "avatar-0001";
const PHOTO = "photo-0001";

function photoPath(file: string, avatarId = AVATAR): string {
  return join(root(), "avatars", avatarId, "photos", file);
}

async function put(path: string, content: Uint8Array | string = PNG_1X1): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, content);
}

function expectError(result: MediaPathResult, code: MediaPathErrorCode): void {
  expect(result.ok ? "ok" : result.code).toBe(code);
}

describe("resolveMediaPath", () => {
  test("resolves a stored PNG to its real path and image/png", async () => {
    await put(photoPath(`${PHOTO}.png`));

    const result = await resolveMediaPath(root(), AVATAR, PHOTO);

    expect(result).toEqual({ ok: true, path: await realpath(photoPath(`${PHOTO}.png`)), mediaType: "image/png" });
  });

  test("resolves JPEG and WebP files with their media types", async () => {
    await put(photoPath("photo-jpeg-01.jpg"), JPEG_HEADER_ONLY);
    await put(photoPath("photo-webp-01.webp"), WEBP_HEADER_ONLY);

    expect(await resolveMediaPath(root(), AVATAR, "photo-jpeg-01")).toMatchObject({ ok: true, mediaType: "image/jpeg" });
    expect(await resolveMediaPath(root(), AVATAR, "photo-webp-01")).toMatchObject({ ok: true, mediaType: "image/webp" });
  });

  test("works when the root path itself goes through a symlink", async () => {
    await put(photoPath(`${PHOTO}.png`));
    const linkedRoot = join(base(), "linked-library");
    await symlink(root(), linkedRoot, "dir");

    expect(await resolveMediaPath(linkedRoot, AVATAR, PHOTO)).toEqual({
      ok: true,
      path: await realpath(photoPath(`${PHOTO}.png`)),
      mediaType: "image/png",
    });
  });

  test("rejects ids with ../ in them", async () => {
    await put(join(root(), "secret.png"));
    expectError(await resolveMediaPath(root(), "../../library", PHOTO), "invalid-id");
    expectError(await resolveMediaPath(root(), AVATAR, "../../../secret"), "invalid-id");
  });

  test("rejects uppercase ids even when a matching file exists", async () => {
    await put(photoPath("PHOTO-0001.png", "AVATAR-0001"));
    expectError(await resolveMediaPath(root(), "AVATAR-0001", "PHOTO-0001"), "invalid-id");
    expectError(await resolveMediaPath(root(), AVATAR, "Photo-0001"), "invalid-id");
  });

  test("rejects ids one char too short", async () => {
    expectError(await resolveMediaPath(root(), "avatar1", PHOTO), "invalid-id");
  });

  test("never serves an extension outside the image allowlist", async () => {
    await put(photoPath(`${PHOTO}.svg`), "<svg/>");
    await put(photoPath(`${PHOTO}.html`), "<script></script>");
    await put(photoPath(`${PHOTO}.jpeg`));
    await put(photoPath(`${PHOTO}.gif`));

    expectError(await resolveMediaPath(root(), AVATAR, PHOTO), "not-found");
  });

  test("reports not-found for a photo that does not exist", async () => {
    await mkdir(join(root(), "avatars", AVATAR, "photos"), { recursive: true });
    expectError(await resolveMediaPath(root(), AVATAR, PHOTO), "not-found");
  });

  test("reports not-found for a folder named like a photo", async () => {
    await mkdir(photoPath(`${PHOTO}.png`), { recursive: true });
    expectError(await resolveMediaPath(root(), AVATAR, PHOTO), "not-found");
  });

  test("rejects a photo symlink that points outside the root", async () => {
    await put(join(outside(), "private.png"));
    await mkdir(dirname(photoPath(`${PHOTO}.png`)), { recursive: true });
    await symlink(join(outside(), "private.png"), photoPath(`${PHOTO}.png`));

    expectError(await resolveMediaPath(root(), AVATAR, PHOTO), "outside-root");
  });

  test("rejects an avatar folder symlinked to outside the root", async () => {
    await put(join(outside(), "avatar", "photos", `${PHOTO}.png`));
    await mkdir(join(root(), "avatars"), { recursive: true });
    await symlink(join(outside(), "avatar"), join(root(), "avatars", AVATAR), "dir");

    expectError(await resolveMediaPath(root(), AVATAR, PHOTO), "outside-root");
  });

  test("rejects a symlink to a sibling folder whose name starts with the root's name", async () => {
    const sibling = `${root()}-evil`;
    await put(join(sibling, "x.png"));
    await mkdir(dirname(photoPath(`${PHOTO}.png`)), { recursive: true });
    await symlink(join(sibling, "x.png"), photoPath(`${PHOTO}.png`));

    expectError(await resolveMediaPath(root(), AVATAR, PHOTO), "outside-root");
  });

  test("serves a symlink whose target stays inside the root", async () => {
    await put(join(root(), "shared", "portrait.png"));
    await mkdir(dirname(photoPath(`${PHOTO}.png`)), { recursive: true });
    await symlink(join(root(), "shared", "portrait.png"), photoPath(`${PHOTO}.png`));

    expect(await resolveMediaPath(root(), AVATAR, PHOTO)).toEqual({
      ok: true,
      path: await realpath(join(root(), "shared", "portrait.png")),
      mediaType: "image/png",
    });
  });

  test("a symlink inside the root that points at avatar.json is not served as an image", async () => {
    await put(join(root(), "avatars", AVATAR, "avatar.json"), JSON.stringify({ id: AVATAR }));
    await mkdir(dirname(photoPath(`${PHOTO}.png`)), { recursive: true });
    await symlink(join(root(), "avatars", AVATAR, "avatar.json"), photoPath(`${PHOTO}.png`));

    expectError(await resolveMediaPath(root(), AVATAR, PHOTO), "not-an-image");
  });

  test("a .png whose bytes are a JPEG is not served", async () => {
    await put(photoPath(`${PHOTO}.png`), JPEG_HEADER_ONLY);
    expectError(await resolveMediaPath(root(), AVATAR, PHOTO), "not-an-image");
  });

  test("an empty file is not served", async () => {
    await put(photoPath(`${PHOTO}.webp`), new Uint8Array(0));
    expectError(await resolveMediaPath(root(), AVATAR, PHOTO), "not-an-image");
  });

  test.skipIf(process.platform === "win32")("a FIFO named like a photo is refused without being opened", async () => {
    await mkdir(dirname(photoPath(`${PHOTO}.png`)), { recursive: true });
    const made = spawnSync("mkfifo", [photoPath(`${PHOTO}.png`)]);
    if (made.status !== 0) throw new Error(`mkfifo failed: ${made.stderr.toString()}`);

    expectError(await resolveMediaPath(root(), AVATAR, PHOTO), "not-found");
  });

  test("reports not-found when the library root does not exist", async () => {
    const missing = await mkdtemp(join(tmpdir(), "studio-media-gone-"));
    await rm(missing, { recursive: true });
    expectError(await resolveMediaPath(missing, AVATAR, PHOTO), "not-found");
  });
});
