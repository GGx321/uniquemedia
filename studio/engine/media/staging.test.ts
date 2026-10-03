import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, truncateSync } from "node:fs";
import { lstat, mkdir, open, readdir, readFile, rename, rename as fsRename, rm, symlink, truncate, writeFile, type FileHandle } from "node:fs/promises";
import { join } from "node:path";
import { MEDIA_BYTE_CAPS, type MediaKind, type PickedFileIdentity } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import type { OpenRegularOps } from "../library/openRegular";
import { pickedIdentityOf } from "./identity";
import { MediaStaging, type MediaStagingOptions, type StageRequest, type StageResult } from "./staging";
useNativeGlobals();

// 3f.1, invariant 34: the engine's side of the own-media hand-off. It opens a user-picked path ONCE, refuses what is not a plain file
// of ours, copies at most the kind's cap into its own staging folder, and from then on nothing reads the user's path again.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-media-staging-");
const libraryRoot = (): string => join(tmp(), "library");
const stagingDir = (): string => join(libraryRoot(), "media", ".staging");
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
  // The library's own folder exists before anything is staged in it: an engine only stages into a library it has opened.
  await mkdir(libraryRoot(), { recursive: true });
});

let ids = 0;
const NOTHING: PickedFileIdentity = { dev: "0", ino: "0", size: "0", mtimeNs: "0", birthtimeNs: "0" };

/** The staging under test, which takes the identity of the file as it stands when a test does not say one (main always sends it). */
class TestStaging extends MediaStaging {
  override async stage(request: Omit<StageRequest, "expected"> & { expected?: PickedFileIdentity }): Promise<StageResult> {
    const expected = request.expected ?? (await identityOf(request.path).catch(() => NOTHING));
    return super.stage({ ...request, expected });
  }
}

function staging(extra: Partial<MediaStagingOptions> = {}): TestStaging {
  return new TestStaging({ root: libraryRoot(), newId: () => `staged-${String(++ids).padStart(8, "0")}`, ...extra });
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
async function identityOf(path: string): Promise<PickedFileIdentity> {
  return pickedIdentityOf(await lstat(path, { bigint: true }));
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

  test("a file that grows far past the cap WHILE it is copied is refused as changed, and leaves nothing", async () => {
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
    expect(refusal(result)).toBe("changed");
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

// ---------- round 2: what the 3f.1 security review found ----------

/** A folder with a file in it, standing for something of the owner's that a staging folder must never touch. */
async function victim(): Promise<string> {
  const folder = join(tmp(), "victim");
  await mkdir(folder, { recursive: true });
  await writeFile(join(folder, "keep-me.txt"), "the owner's data");
  await writeFile(join(folder, ".owner-00000001.part"), "even a name that looks like ours, in a folder that is not ours");
  return folder;
}

describe("the staging folder is the library's own and nothing else", () => {
  test("a .staging that is a symlink to another folder is refused: that folder is not emptied and nothing is written into it", async () => {
    const other = await victim();
    await mkdir(join(libraryRoot(), "media"), { recursive: true });
    if (!(await tryLink(other, stagingDir()))) return;
    const result = await staging().stage({ path: await put("p.jpg", jpeg()), kind: "photo" });
    expect(refusal(result)).toBe("unreadable");
    expect((await readdir(other)).sort()).toEqual([".owner-00000001.part", "keep-me.txt"]);
  });

  test("a media folder that is a symlink to another folder is refused the same way", async () => {
    const other = await victim();
    await mkdir(libraryRoot(), { recursive: true });
    if (!(await tryLink(other, join(libraryRoot(), "media")))) return;
    const result = await staging().stage({ path: await put("p.jpg", jpeg()), kind: "photo" });
    expect(refusal(result)).toBe("unreadable");
    expect((await readdir(other)).sort()).toEqual([".owner-00000001.part", "keep-me.txt"]);
  });

  test("the cleanup alone, run at the library's opening, does not follow a .staging link either", async () => {
    const other = await victim();
    await mkdir(join(libraryRoot(), "media"), { recursive: true });
    if (!(await tryLink(other, stagingDir()))) return;
    await staging().sweep();
    expect((await readdir(other)).sort()).toEqual([".owner-00000001.part", "keep-me.txt"]);
  });

  test("a library reached through a link is still a library: the staging folder inside it is used", async () => {
    await mkdir(libraryRoot(), { recursive: true });
    const via = join(tmp(), "via-library");
    if (!(await tryLink(libraryRoot(), via))) return;
    const result = await staging({ root: via }).stage({ path: await put("p.jpg", jpeg()), kind: "photo" });
    expect(result.ok).toBe(true);
  });

  test("the cleanup removes only the files that have the shape of ours and leaves everything else alone", async () => {
    await mkdir(stagingDir(), { recursive: true });
    await writeFile(join(stagingDir(), ".staged-00000001.part"), "ours");
    await writeFile(join(stagingDir(), "staged-00000002.media"), "ours");
    await writeFile(join(stagingDir(), "notes.txt"), "not ours");
    await writeFile(join(stagingDir(), ".st-1.part"), "too short an id to be ours");
    await writeFile(join(stagingDir(), "STAGED-00000003.media"), "capitals are not ours");
    await staging().sweep();
    expect(await leftovers()).toEqual([".st-1.part", "STAGED-00000003.media", "notes.txt"]);
  });

  test("the cleanup is not recursive: a folder that has the name of ours is left, with what is in it", async () => {
    await mkdir(join(stagingDir(), "staged-00000004.media"), { recursive: true });
    await writeFile(join(stagingDir(), "staged-00000004.media", "inside.txt"), "kept");
    await staging().sweep();
    expect(await readdir(join(stagingDir(), "staged-00000004.media"))).toEqual(["inside.txt"]);
  });

  test("the cleanup with no staging folder yet creates nothing", async () => {
    await staging().sweep();
    expect(await readdir(libraryRoot()).catch(() => [])).toEqual([]);
  });

  test("a cleanup that cannot remove a file says so once, without its path, and goes on with the rest", async () => {
    await mkdir(stagingDir(), { recursive: true });
    await writeFile(join(stagingDir(), ".staged-00000001.part"), "locked");
    await writeFile(join(stagingDir(), ".staged-00000002.part"), "free");
    const warned: string[] = [];
    const unlink = async (path: string): Promise<void> => {
      if (path.endsWith("00000001.part")) throw Object.assign(new Error("busy"), { code: "EBUSY" });
      await rm(path);
    };
    await staging({ fs: { unlink, platform: "linux" }, warn: (text) => warned.push(text) }).sweep();
    expect(await leftovers()).toEqual([".staged-00000001.part"]);
    expect(warned).toHaveLength(1);
    expect(warned[0]?.includes(tmp())).toBe(false);
  });
});

describe("a failed first use is not remembered for ever", () => {
  test("once the obstacle is gone, the next file is staged", async () => {
    await mkdir(libraryRoot(), { recursive: true });
    await writeFile(join(libraryRoot(), "media"), "a file where the folder should be");
    const s = staging();
    const path = await put("q.jpg", jpeg());
    expect(refusal(await s.stage({ path, kind: "photo" }))).toBe("unreadable");
    await rm(join(libraryRoot(), "media"));
    expect((await s.stage({ path, kind: "photo" })).ok).toBe(true);
  });
});

describe("the copy reads no more than the file's own size plus one byte", () => {
  /** A handle that counts the bytes `read` hands out. */
  function counting(counter: { bytes: number }): OpenRegularOps {
    return {
      lstat: (p) => lstat(p, { bigint: true }),
      open: async (p, flags) => {
        const handle = await open(p, flags);
        let reads = 0;
        return new Proxy(handle, {
          get(target, prop) {
            if (prop === "read") {
              return async (buffer: Buffer, offset: number, length: number, position: number | null) => {
                const result = await target.read(buffer, offset, length, position);
                // The first read is the look at the start of the file; every other one is the copy's.
                if (++reads > 1) counter.bytes += result.bytesRead;
                return result;
              };
            }
            const value: unknown = Reflect.get(target, prop);
            return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
          },
        }) as FileHandle;
      },
    };
  }

  test("a file that grows by a thousand times its size is refused as changed after one byte past the size it was opened at", async () => {
    const path = await put("growing.jpg", jpeg(40));
    const counter = { bytes: 0 };
    let grown = false;
    const caps = { photo: 1_000_000, video: 1_000_000, audio: 1_000_000, sticker: 1_000_000 };
    const result = await staging({ caps, chunkBytes: 16, ops: counting(counter) }).stage({
      path,
      kind: "photo",
      onProgress: () => {
        if (grown) return;
        grown = true;
        appendFileSync(path, Buffer.alloc(40_000, 1));
      },
    });
    expect(refusal(result)).toBe("changed");
    expect(counter.bytes).toBeLessThanOrEqual(41);
    expect(await leftovers()).toEqual([]);
  });
});

describe("a copy that did not land whole", () => {
  /** An output file whose writes are cut short: `reportsFull` says whether it also lies about it. */
  function shortOut(reportsFull: boolean): (path: string) => Promise<FileHandle> {
    return async (path) => {
      const handle = await open(path, "wx");
      return new Proxy(handle, {
        get(target, prop) {
          if (prop === "write") {
            return async (buffer: Buffer, offset: number, length: number) => {
              const half = Math.max(1, Math.floor(length / 2));
              await target.write(buffer, offset, half);
              return { bytesWritten: reportsFull ? length : half, buffer };
            };
          }
          const value: unknown = Reflect.get(target, prop);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      }) as FileHandle;
    };
  }

  test("a write that says it wrote less than it was given is refused as unreadable and leaves nothing", async () => {
    const result = await staging({ fs: { openOut: shortOut(false) } }).stage({ path: await put("a.jpg", jpeg(500)), kind: "photo" });
    expect(refusal(result)).toBe("unreadable");
    expect(await leftovers()).toEqual([]);
  });

  test("a copy that is shorter on disk than the bytes read, though every write said it was whole, is refused too", async () => {
    const result = await staging({ fs: { openOut: shortOut(true) } }).stage({ path: await put("a.jpg", jpeg(500)), kind: "photo" });
    expect(refusal(result)).toBe("unreadable");
    expect(await leftovers()).toEqual([]);
  });
});

describe("room for the copy", () => {
  test("a library disk with less free than the file and the margin is refused as no-space before a byte is copied", async () => {
    const copied: number[] = [];
    const result = await staging({ freeBytes: async () => 120, freeMarginBytes: 50 }).stage({ path: await put("a.jpg", jpeg(100)), kind: "photo", onProgress: (n) => copied.push(n) });
    expect(refusal(result)).toBe("no-space");
    expect(copied).toEqual([]);
    expect(await leftovers()).toEqual([]);
  });

  test("exactly the file and the margin free is enough", async () => {
    const result = await staging({ freeBytes: async () => 150, freeMarginBytes: 50 }).stage({ path: await put("a.jpg", jpeg(100)), kind: "photo" });
    expect(result.ok).toBe(true);
  });

  test("one byte short of that is not", async () => {
    const result = await staging({ freeBytes: async () => 149, freeMarginBytes: 50 }).stage({ path: await put("a.jpg", jpeg(100)), kind: "photo" });
    expect(refusal(result)).toBe("no-space");
  });

  test("a disk that cannot say how much is free does not stop the copy", async () => {
    const result = await staging({ freeBytes: async () => null }).stage({ path: await put("a.jpg", jpeg(100)), kind: "photo" });
    expect(result.ok).toBe(true);
    const failing = await staging({
      freeBytes: async () => {
        throw new Error("statfs is not there");
      },
    }).stage({ path: await put("b.jpg", jpeg(100)), kind: "photo" });
    expect(failing.ok).toBe(true);
  });

  test("the real disk has room for a small file with the default margin", async () => {
    expect((await staging().stage({ path: await put("a.jpg", jpeg(100)), kind: "photo" })).ok).toBe(true);
  });
});

describe("Windows: a fresh file is renamed and removed with the retries a held handle needs", () => {
  const eperm = (): Error => Object.assign(new Error("EPERM: operation not permitted"), { code: "EPERM" });

  test("the rename of the finished copy is retried when an antivirus holds it, and the copy lands", async () => {
    let attempts = 0;
    const rename = async (from: string, to: string): Promise<void> => {
      if (++attempts < 3) throw eperm();
      await fsRename(from, to);
    };
    const result = await staging({ fs: { rename, platform: "win32", sleep: async () => undefined } }).stage({ path: await put("a.jpg", jpeg()), kind: "photo" });
    expect(result.ok).toBe(true);
    expect(attempts).toBe(3);
  });

  test("a rename that never gives is a refusal as unreadable, and the part file is removed", async () => {
    const rename = async (): Promise<void> => {
      throw eperm();
    };
    const result = await staging({ fs: { rename, platform: "win32", sleep: async () => undefined, delaysMs: [1, 1] } }).stage({ path: await put("a.jpg", jpeg()), kind: "photo" });
    expect(refusal(result)).toBe("unreadable");
    expect(await leftovers()).toEqual([]);
  });

  test("dispose never throws: a copy that cannot be removed is left to the next cleanup, and the failure is told without a path", async () => {
    const warned: string[] = [];
    const unlink = async (): Promise<void> => {
      throw Object.assign(new Error("EBUSY: resource busy"), { code: "EBUSY" });
    };
    const result = await staging({ fs: { unlink, platform: "win32", sleep: async () => undefined, delaysMs: [1] }, warn: (text) => warned.push(text) }).stage({ path: await put("a.jpg", jpeg()), kind: "photo" });
    if (!result.ok) throw new Error("refused");
    await result.staged.dispose();
    expect(await leftovers()).toHaveLength(1);
    expect(warned).toHaveLength(1);
    expect(warned[0]?.includes(tmp())).toBe(false);
  });

  test("dispose retries a transient failure and removes the copy", async () => {
    let attempts = 0;
    const unlink = async (path: string): Promise<void> => {
      if (++attempts < 3) throw eperm();
      await rm(path);
    };
    const result = await staging({ fs: { unlink, platform: "win32", sleep: async () => undefined } }).stage({ path: await put("a.jpg", jpeg()), kind: "photo" });
    if (!result.ok) throw new Error("refused");
    await result.staged.dispose();
    expect(await leftovers()).toEqual([]);
  });
});

describe("a path that is never a plain file is refused by the engine too", () => {
  test("a Windows device, pipe or stream path is not-a-file without the disk being touched", async () => {
    let touched = false;
    const ops: OpenRegularOps = {
      lstat: async () => {
        touched = true;
        throw new Error("no");
      },
      open: async () => {
        touched = true;
        throw new Error("no");
      },
    };
    for (const path of ["\\\\.\\pipe\\studio", "\\\\?\\GLOBALROOT\\Device\\HarddiskVolume1\\a.jpg", "C:\\Users\\me\\a.jpg:secret", "C:\\Users\\me\\CON"]) {
      expect(refusal(await staging({ ops, platform: "win32" }).stage({ path, kind: "photo" }))).toBe("not-a-file");
    }
    expect(touched).toBe(false);
  });
});

describe("what is staged says which container it is", () => {
  const ftypBox = (brand: string): Buffer => Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from(`ftyp${brand}`), Buffer.alloc(40)]);
  const cases: [string, Buffer, MediaKind, string][] = [
    ["a JPEG", jpeg(), "photo", "jpeg"],
    ["a GIF", Buffer.concat([Buffer.from("GIF89a"), Buffer.alloc(40)]), "sticker", "gif"],
    ["an MP4", ftypBox("isom"), "video", "mp4"],
    ["a MOV", ftypBox("qt  "), "video", "mov"],
    ["an M4A", ftypBox("M4A "), "audio", "m4a"],
    ["a WAV", Buffer.concat([Buffer.from("RIFF\0\0\0\0WAVEfmt "), Buffer.alloc(30)]), "audio", "wav"],
    ["a FLAC", Buffer.concat([Buffer.from("fLaC"), Buffer.alloc(40)]), "audio", "flac"],
  ];
  test.each(cases)("%s is named by its bytes: its kind and its container", async (_name, bytes, kind, format) => {
    const result = await staging().stage({ path: await put("thing.dat", bytes), kind: "any" });
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    expect(result.staged.kind).toBe(kind);
    expect(String(result.staged.format)).toBe(format);
    expect(result.staged.path.endsWith(".media")).toBe(true);
  });
});

describe("the handle the open gives is the file that is read, not the path", () => {
  /** The path is re-pointed to another file right AFTER the open: the path now names something else than the handle does. */
  function swappingAfterOpen(path: string, replacement: string): OpenRegularOps {
    return {
      lstat: (p) => lstat(p, { bigint: true }),
      open: async (p, flags) => {
        const handle = await open(p, flags);
        await rename(replacement, path);
        return handle;
      },
    };
  }

  test("the identity and the bytes are the opened file's: a swap after the open changes nothing", async () => {
    const bytes = jpeg(120);
    const path = await put("a.jpg", bytes);
    const expected = await identityOf(path);
    const other = await put("b.jpg", jpeg(300));
    let result: StageResult;
    try {
      result = await staging({ ops: swappingAfterOpen(path, other) }).stage({ path, kind: "photo", expected });
    } catch (error) {
      // Windows may refuse to replace a file that is open.
      if (process.platform === "win32") return;
      throw error;
    }
    if (!result.ok) throw new Error(`refused: ${result.reason}`);
    expect(await readFile(result.staged.path)).toEqual(bytes);
  });
});
