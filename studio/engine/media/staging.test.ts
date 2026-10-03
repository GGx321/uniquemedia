import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, truncateSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rm, symlink, truncate, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { MEDIA_BYTE_CAPS, type MediaKind } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import type { FileIdentity, OpenRegularOps } from "../library/openRegular";
import { MediaStaging, type MediaStagingOptions, type StageResult } from "./staging";
useNativeGlobals();

// 3f.1, invariant 34: the engine's side of the own-media hand-off. It opens a user-picked path ONCE, refuses what is not a plain file
// of ours, copies at most the kind's cap into its own staging folder, and from then on nothing reads the user's path again.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-media-staging-");
const stagingDir = (): string => join(tmp(), "library", "media", ".staging");
const sourceDir = (): string => join(tmp(), "picked");

const ascii = (text: string): number[] => [...text].map((c) => c.charCodeAt(0));
/** A JPEG-looking file of `size` bytes (the signature, then filler): all the boundary reads is the start. */
const jpeg = (size = 64): Buffer<ArrayBuffer> => {
  const buffer = Buffer.alloc(Math.max(4, size), 7);
  buffer.set([0xff, 0xd8, 0xff, 0xe0]);
  return buffer;
};
const SCRIPT = Buffer.from("#!/bin/sh\nrm -rf ~\n");

beforeEach(async () => {
  await mkdir(sourceDir(), { recursive: true });
});

let ids = 0;
function staging(extra: Partial<MediaStagingOptions> = {}): MediaStaging {
  return new MediaStaging({ dir: stagingDir(), newId: () => `staged-${String(++ids).padStart(8, "0")}`, ...extra });
}
async function put(name: string, bytes: Buffer): Promise<string> {
  const path = join(sourceDir(), name);
  await writeFile(path, bytes);
  return path;
}
async function leftovers(): Promise<string[]> {
  return (await readdir(stagingDir()).catch(() => [])).sort();
}
function refusal(result: StageResult): string {
  return result.ok ? "ok" : result.reason;
}
async function identityOf(path: string): Promise<FileIdentity> {
  const info = await lstat(path, { bigint: true });
  return { dev: String(info.dev), ino: String(info.ino) };
}
/** A symlink, or null when this platform will not make one for this user (Windows without the privilege): the test then has nothing to say. */
async function tryLink(target: string, path: string): Promise<boolean> {
  try {
    await symlink(target, path);
    return true;
  } catch (error) {
    if (process.platform === "win32" && error instanceof Error && Reflect.get(error, "code") === "EPERM") return false;
    throw error;
  }
}

describe("a plain file is staged", () => {
  test("its bytes are copied into the staging folder, with their size and sha256 and the kind they are", async () => {
    const bytes = jpeg(5000);
    const path = await put("photo.jpg", bytes);
    const result = await staging().stage({ path, kind: "photo" });
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    expect(result.staged.kind).toBe("photo");
    expect(result.staged.bytes).toBe(5000);
    expect(result.staged.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
    expect(result.staged.path.startsWith(stagingDir())).toBe(true);
    expect(await readFile(result.staged.path)).toEqual(bytes);
    expect([...result.staged.head.subarray(0, 4)]).toEqual([0xff, 0xd8, 0xff, 0xe0]);
  });

  test("the staged copy has a name of its own, never the picked file's", async () => {
    const path = await put("holiday-2026.jpg", jpeg());
    const result = await staging().stage({ path, kind: "photo" });
    if (!result.ok) throw new Error("refused");
    expect(result.staged.path.includes("holiday")).toBe(false);
  });

  test("after staging nothing reads the user's path: the copy is the same whether the source is changed or deleted", async () => {
    const bytes = jpeg(300);
    const path = await put("photo.jpg", bytes);
    const result = await staging().stage({ path, kind: "photo" });
    if (!result.ok) throw new Error("refused");
    await writeFile(path, SCRIPT);
    expect(await readFile(result.staged.path)).toEqual(bytes);
    await rm(path);
    expect(await readFile(result.staged.path)).toEqual(bytes);
  });

  test("the picked file itself is left as it was", async () => {
    const bytes = jpeg(300);
    const path = await put("photo.jpg", bytes);
    await staging().stage({ path, kind: "photo" });
    expect(await readFile(path)).toEqual(bytes);
  });

  test("two files get two staging ids", async () => {
    const a = await staging().stage({ path: await put("a.jpg", jpeg()), kind: "photo" });
    const b = await staging().stage({ path: await put("b.jpg", jpeg()), kind: "photo" });
    if (!a.ok || !b.ok) throw new Error("refused");
    expect(a.staged.stagingId).not.toBe(b.staged.stagingId);
  });

  test("progress reports the bytes copied so far, up to the whole file", async () => {
    const path = await put("photo.jpg", jpeg(100));
    const seen: [number, number][] = [];
    const result = await staging({ chunkBytes: 32 }).stage({ path, kind: "photo", onProgress: (copied, total) => seen.push([copied, total]) });
    expect(result.ok).toBe(true);
    expect(seen).toEqual([
      [32, 100],
      [64, 100],
      [96, 100],
      [100, 100],
    ]);
  });

  test("disposing removes the staged copy, and disposing twice is harmless", async () => {
    const result = await staging().stage({ path: await put("a.jpg", jpeg()), kind: "photo" });
    if (!result.ok) throw new Error("refused");
    await result.staged.dispose();
    expect(await leftovers()).toEqual([]);
    await result.staged.dispose();
  });
});

describe("what is not a plain file of ours is refused as not-a-file", () => {
  test("a symlink to a real photo", async () => {
    const real = await put("real.jpg", jpeg());
    const link = join(sourceDir(), "link.jpg");
    if (!(await tryLink(real, link))) return;
    expect(refusal(await staging().stage({ path: link, kind: "photo" }))).toBe("not-a-file");
    expect(await leftovers()).toEqual([]);
  });

  test("a symlink, on a platform that has no O_NOFOLLOW (the Windows case)", async () => {
    const real = await put("real.jpg", jpeg());
    const link = join(sourceDir(), "link.jpg");
    if (!(await tryLink(real, link))) return;
    expect(refusal(await staging({ noFollow: 0 }).stage({ path: link, kind: "photo" }))).toBe("not-a-file");
    expect(await leftovers()).toEqual([]);
  });

  test("a dangling symlink", async () => {
    const link = join(sourceDir(), "dangling.jpg");
    if (!(await tryLink(join(sourceDir(), "nothing"), link))) return;
    expect(refusal(await staging().stage({ path: link, kind: "photo" }))).toBe("not-a-file");
  });

  test("a directory, even one named like a photo", async () => {
    const dir = join(sourceDir(), "album.jpg");
    await mkdir(dir);
    expect(refusal(await staging().stage({ path: dir, kind: "photo" }))).toBe("not-a-file");
    expect(await leftovers()).toEqual([]);
  });

  test("a path with nothing at it", async () => {
    expect(refusal(await staging().stage({ path: join(sourceDir(), "gone.jpg"), kind: "photo" }))).toBe("not-a-file");
  });

  test.skipIf(process.platform === "win32")("a FIFO is refused without opening it for a blocking read", async () => {
    const path = join(sourceDir(), "pipe.jpg");
    execFileSync("mkfifo", [path]);
    expect(refusal(await staging().stage({ path, kind: "photo" }))).toBe("not-a-file");
  });

  test.skipIf(process.platform === "win32")("a FIFO swapped in after the lstat is refused by the stat of the OPEN handle, not the path", async () => {
    const path = await put("photo.jpg", jpeg());
    const fifo = join(sourceDir(), "fifo");
    execFileSync("mkfifo", [fifo]);
    // The path lstat's as a plain file, and then opens as something else: the playing disk answers `open` with the FIFO.
    const ops: OpenRegularOps = {
      lstat: (p) => lstat(p, { bigint: true }),
      open: (_p, flags) => open(fifo, flags),
    };
    expect(refusal(await staging({ ops }).stage({ path, kind: "photo" }))).toBe("not-a-file");
    expect(await leftovers()).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("a character device", async () => {
    expect(refusal(await staging().stage({ path: "/dev/zero", kind: "photo" }))).toBe("not-a-file");
  });
});

describe("size", () => {
  const caps: Record<MediaKind, number> = { photo: 100, video: 1000, audio: 500, sticker: 50 };

  test("a zero-byte file is refused as empty, and nothing is created", async () => {
    const path = await put("empty.jpg", Buffer.alloc(0));
    expect(refusal(await staging().stage({ path, kind: "photo" }))).toBe("empty");
    expect(await leftovers()).toEqual([]);
  });

  test("a file one byte over the kind's cap is refused as too-large before a byte is copied", async () => {
    const path = await put("big.jpg", jpeg(101));
    const copied: number[] = [];
    const result = await staging({ caps }).stage({ path, kind: "photo", onProgress: (n) => copied.push(n) });
    expect(refusal(result)).toBe("too-large");
    expect(copied).toEqual([]);
    expect(await leftovers()).toEqual([]);
  });

  test("a file far over the cap is refused before the first chunk is read, not after the cap's worth was copied", async () => {
    const path = await put("big.jpg", jpeg(300));
    const copied: number[] = [];
    const result = await staging({ caps, chunkBytes: 16 }).stage({ path, kind: "photo", onProgress: (n) => copied.push(n) });
    expect(refusal(result)).toBe("too-large");
    expect(copied).toEqual([]);
  });

  test("a file of exactly the cap is staged", async () => {
    const path = await put("edge.jpg", jpeg(100));
    const result = await staging({ caps }).stage({ path, kind: "photo" });
    expect(result.ok && result.staged.bytes).toBe(100);
  });

  test("a one byte file that is a signature short of a photo is refused as format, not as empty", async () => {
    const path = await put("one.jpg", Buffer.from([0xff]));
    expect(refusal(await staging().stage({ path, kind: "photo" }))).toBe("format");
  });

  test("the real caps are the contract's: a sparse file one byte over the photo cap is refused without being read", async () => {
    const path = join(sourceDir(), "sparse.jpg");
    await writeFile(path, jpeg());
    await truncate(path, MEDIA_BYTE_CAPS.photo + 1);
    const result = await staging().stage({ path, kind: "photo" });
    expect(refusal(result)).toBe("too-large");
    expect(await leftovers()).toEqual([]);
  });

  test("a file that grows past the cap WHILE it is copied stops at the cap, is refused as too-large and leaves nothing", async () => {
    const path = await put("growing.jpg", jpeg(60));
    let grown = false;
    const result = await staging({ caps, chunkBytes: 16 }).stage({
      path,
      kind: "photo",
      onProgress: () => {
        if (grown) return;
        grown = true;
        appendFileSync(path, Buffer.alloc(500, 1));
      },
    });
    expect(refusal(result)).toBe("too-large");
    expect(await leftovers()).toEqual([]);
  });

  test("a file that grows but stays under the cap is refused as changed: its copy would not be the file the owner picked", async () => {
    const path = await put("growing.jpg", jpeg(40));
    let grown = false;
    const result = await staging({ caps, chunkBytes: 16 }).stage({
      path,
      kind: "photo",
      onProgress: () => {
        if (grown) return;
        grown = true;
        appendFileSync(path, Buffer.alloc(20, 1));
      },
    });
    expect(refusal(result)).toBe("changed");
    expect(await leftovers()).toEqual([]);
  });

  test("a file that shrinks while it is copied is refused as changed", async () => {
    const path = await put("shrinking.jpg", jpeg(80));
    let cut = false;
    const result = await staging({ chunkBytes: 16 }).stage({
      path,
      kind: "photo",
      onProgress: () => {
        if (cut) return;
        cut = true;
        truncateSync(path, 20);
      },
    });
    expect(refusal(result)).toBe("changed");
    expect(await leftovers()).toEqual([]);
  });

  test("`any` is held to the cap of the kind the bytes turn out to be: a photo over the photo cap is too-large", async () => {
    const path = await put("big.jpg", jpeg(101));
    expect(refusal(await staging({ caps }).stage({ path, kind: "any" }))).toBe("too-large");
  });

  test("`any` lets a file through that is over a smaller kind's cap but within its own", async () => {
    const path = await put("clip.mp4", Buffer.concat([Buffer.from([0, 0, 0, 24, ...ascii("ftypisom")]), Buffer.alloc(300, 1)]));
    const result = await staging({ caps }).stage({ path, kind: "any" });
    expect(result.ok && result.staged.kind).toBe("video");
  });

  test("a file over the largest cap is refused under `any` before it is read", async () => {
    const path = await put("huge.mp4", Buffer.concat([Buffer.from([0, 0, 0, 24, ...ascii("ftypisom")]), Buffer.alloc(1100, 1)]));
    const copied: number[] = [];
    const result = await staging({ caps, chunkBytes: 64 }).stage({ path, kind: "any", onProgress: (n) => copied.push(n) });
    expect(refusal(result)).toBe("too-large");
    expect(copied).toEqual([]);
  });
});

describe("a file replaced between the dialog and the open", () => {
  test("is refused as changed when it is another file than the one the dialog's check saw", async () => {
    const path = await put("photo.jpg", jpeg(100));
    const seen = await identityOf(path);
    // Another file arrives under the same name while the first still exists (so it cannot reuse its inode): an atomic save does exactly this.
    const other = await put("other.jpg", jpeg(100));
    await rename(other, path);
    expect(refusal(await staging().stage({ path, kind: "photo", expected: seen }))).toBe("changed");
    expect(await leftovers()).toEqual([]);
  });

  test("is not refused when it is the very file that was checked", async () => {
    const path = await put("photo.jpg", jpeg(100));
    const result = await staging().stage({ path, kind: "photo", expected: await identityOf(path) });
    expect(result.ok).toBe(true);
  });

  test("is refused when a symlink took the name in the gap, on a platform that follows a link in open", async () => {
    const path = await put("photo.jpg", jpeg(100));
    const secret = await put("secret.jpg", jpeg(100));
    const seen = await identityOf(path);
    await rm(path);
    if (!(await tryLink(secret, path))) return;
    expect(refusal(await staging({ noFollow: 0 }).stage({ path, kind: "photo", expected: seen }))).toBe("not-a-file");
    expect(await leftovers()).toEqual([]);
  });
});

describe("the extension is never trusted, only the bytes", () => {
  test("a script named photo.jpg is refused as format, and nothing is copied", async () => {
    const path = await put("photo.jpg", SCRIPT);
    expect(refusal(await staging().stage({ path, kind: "photo" }))).toBe("format");
    expect(await leftovers()).toEqual([]);
  });

  test("a JPEG with no extension, or a wrong one, is a photo", async () => {
    for (const name of ["photo", "photo.txt", "photo.mp4"]) {
      const result = await staging().stage({ path: await put(name, jpeg()), kind: "photo" });
      expect(result.ok && result.staged.kind).toBe("photo");
    }
  });

  test("a PNG picked as a video is refused as format", async () => {
    const png = Buffer.concat([Buffer.from([0x89, ...ascii("PNG"), 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(40)]);
    expect(refusal(await staging().stage({ path: await put("movie.mp4", png), kind: "video" }))).toBe("format");
  });

  test("a HEIC photo is refused as heic, so the owner is told to save it as a JPEG", async () => {
    const heic = Buffer.concat([Buffer.from([0, 0, 0, 24, ...ascii("ftypheic")]), Buffer.alloc(60)]);
    expect(refusal(await staging().stage({ path: await put("IMG_0001.HEIC", heic), kind: "photo" }))).toBe("heic");
    expect(refusal(await staging().stage({ path: await put("IMG_0002.HEIC", heic), kind: "any" }))).toBe("heic");
    expect(refusal(await staging().stage({ path: await put("IMG_0003.HEIC", heic), kind: "video" }))).toBe("format");
    expect(await leftovers()).toEqual([]);
  });

  test("`any` names the kind from the bytes", async () => {
    const gif = Buffer.concat([Buffer.from(ascii("GIF89a")), Buffer.alloc(40)]);
    const result = await staging().stage({ path: await put("thing.dat", gif), kind: "any" });
    expect(result.ok && result.staged.kind).toBe("sticker");
  });

  test("`any` refuses bytes that are no kind at all", async () => {
    expect(refusal(await staging().stage({ path: await put("thing.jpg", SCRIPT), kind: "any" }))).toBe("format");
  });

  test("a file whose start is swapped for something else between the first look and the copy is refused: the STAGED bytes are judged", async () => {
    const path = await put("photo.jpg", jpeg(64));
    // The disk plays a file that reads as a JPEG the first time its start is read and as a script when it is read again for the copy.
    const ops: OpenRegularOps = {
      lstat: (p) => lstat(p, { bigint: true }),
      open: async (p, flags) => {
        const handle = await open(p, flags);
        let startReads = 0;
        return new Proxy(handle, {
          get(target, prop) {
            if (prop === "read") {
              return async (buffer: Buffer, offset: number, length: number, position: number | null) => {
                const result = await target.read(buffer, offset, length, position);
                if (position === 0 && ++startReads > 1) SCRIPT.copy(buffer, offset);
                return result;
              };
            }
            const value: unknown = Reflect.get(target, prop);
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        }) as FileHandle;
      },
    };
    expect(refusal(await staging({ ops }).stage({ path, kind: "photo" }))).toBe("changed");
    expect(await leftovers()).toEqual([]);
  });
});

describe("a kind with no importer yet", () => {
  test("is refused as not-yet-supported before a byte is copied", async () => {
    const path = await put("photo.jpg", jpeg(100));
    const copied: number[] = [];
    const result = await staging({ supports: (kind) => kind !== "photo" }).stage({ path, kind: "photo", onProgress: (n) => copied.push(n) });
    expect(refusal(result)).toBe("not-yet-supported");
    expect(copied).toEqual([]);
    expect(await leftovers()).toEqual([]);
  });

  test("and a format refusal still comes first: the wrong bytes are no kind", async () => {
    const path = await put("photo.jpg", SCRIPT);
    expect(refusal(await staging({ supports: () => false }).stage({ path, kind: "photo" }))).toBe("format");
  });
});

describe("cancel", () => {
  test("an abort in the middle of the copy ends it as cancelled and leaves no partial file", async () => {
    const path = await put("photo.jpg", jpeg(200));
    const controller = new AbortController();
    const result = await staging({ chunkBytes: 16 }).stage({ path, kind: "photo", signal: controller.signal, onProgress: () => controller.abort() });
    expect(refusal(result)).toBe("cancelled");
    expect(await leftovers()).toEqual([]);
  });

  test("a signal that is already aborted copies nothing", async () => {
    const path = await put("photo.jpg", jpeg(200));
    const copied: number[] = [];
    const result = await staging().stage({ path, kind: "photo", signal: AbortSignal.abort(), onProgress: (n) => copied.push(n) });
    expect(refusal(result)).toBe("cancelled");
    expect(copied).toEqual([]);
    expect(await leftovers()).toEqual([]);
  });
});

describe("the staging folder", () => {
  test("is swept the first time it is used: what a crash left behind is removed, what is staged now is kept", async () => {
    await mkdir(stagingDir(), { recursive: true });
    await writeFile(join(stagingDir(), "old-00000001.media"), "left by a crash");
    await writeFile(join(stagingDir(), ".old-00000002.part"), "left by a crash");
    const s = staging();
    const first = await s.stage({ path: await put("a.jpg", jpeg()), kind: "photo" });
    const second = await s.stage({ path: await put("b.jpg", jpeg()), kind: "photo" });
    if (!first.ok || !second.ok) throw new Error("refused");
    expect(await leftovers()).toEqual([`${first.staged.stagingId}.media`, `${second.staged.stagingId}.media`].sort());
  });

  test("is created on first use, with the folders above it", async () => {
    await staging().stage({ path: await put("a.jpg", jpeg()), kind: "photo" });
    expect((await lstat(stagingDir())).isDirectory()).toBe(true);
  });

  test("a staged copy cannot be opened through the picked path's name: the staged name holds no separator or dot segment", async () => {
    const result = await staging({ newId: () => "../../escape" }).stage({ path: await put("a.jpg", jpeg()), kind: "photo" });
    expect(refusal(result)).toBe("unreadable");
    expect(await readdir(join(tmp(), "library", "media")).catch(() => [])).not.toContain("escape.media");
  });
});
