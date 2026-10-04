import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MAX_STORED_VIDEO_BYTES } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { NODE_OPEN_OPS, type OpenRegularOps } from "../library/openRegular";
import { RenderFailure } from "../renderQueue/queue";
import { lyingHandle } from "./testing/handleKit";
import { copyVerifiedOwnMedia, OwnMediaUnavailableError, OWN_COPY_FREE_MARGIN_BYTES, type DestFile, type StoredFile, type StreamCopyIo } from "./ownMedia";
useNativeGlobals();

// The STREAMING copy of a stored own file (3f.3b): an own video's mezzanine is far too large to read into memory (up to three minutes of 1080 x 1920 at CRF 16), so the
// render's verified copy is made a chunk at a time: opened as staging opens a file (no link followed, the handle's own size against the record), the volume asked for room
// first, written with `wx` while it is hashed, compared with the record at the END, and removed on every failure. Whatever fails fails the job without a path in its text.

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-own-copy-");
const libraryDir = (): string => join(tmp(), "library");
const jobDir = (): string => join(tmp(), "job");
const destOf = (): string => join(jobDir(), "own-media-0000001.mp4");

beforeEach(async () => {
  await mkdir(libraryDir(), { recursive: true });
  await mkdir(jobDir(), { recursive: true });
});

const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");
/** Bytes that differ from place to place, so a chunk copied to the wrong place cannot pass. */
const pattern = (length: number, seed = 1) => Uint8Array.from({ length }, (_, i) => (i * 31 + seed * 7 + (i >> 8)) & 0xff);

async function stored(bytes: Uint8Array, name = "media-0000001.mp4"): Promise<StoredFile> {
  const path = join(libraryDir(), name);
  await writeFile(path, bytes);
  return { path, sha256: sha(bytes), bytes: bytes.length };
}

const signal = (): AbortSignal => new AbortController().signal;

async function failureOf(work: Promise<unknown>): Promise<RenderFailure> {
  try {
    await work;
  } catch (error) {
    if (error instanceof RenderFailure) return error;
    throw error;
  }
  throw new Error("expected a RenderFailure");
}

const SMALL: StreamCopyIo = { chunkBytes: 16, freeBytes: async () => null };

describe("copyVerifiedOwnMedia: the copy", () => {
  test("writes a byte-identical private copy, over several chunks", async () => {
    const bytes = pattern(100);
    await copyVerifiedOwnMedia(await stored(bytes), "video", destOf(), signal(), SMALL);
    expect(new Uint8Array(await readFile(destOf()))).toEqual(bytes);
  });

  test("a file that is an exact multiple of the chunk, and one a byte over it, are copied whole", async () => {
    for (const length of [16, 17, 32, 33, 1]) {
      const bytes = pattern(length, length);
      const dest = join(jobDir(), `copy-${length}.mp4`);
      await copyVerifiedOwnMedia(await stored(bytes, `m-${length}.mp4`), "video", dest, signal(), SMALL);
      expect(new Uint8Array(await readFile(dest))).toEqual(bytes);
    }
  });

  test("never holds more than one chunk: the reads ask for no more than the chunk size, however large the file", async () => {
    const bytes = pattern(1000);
    const file = await stored(bytes);
    const asked: number[] = [];
    const real = await open(file.path, "r");
    const spy = new Proxy(real, {
      get(target, property) {
        if (property === "read") {
          return (buffer: Uint8Array, offset: number, length: number, position: number) => {
            asked.push(length);
            return target.read(buffer, offset, length, position);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    await copyVerifiedOwnMedia(file, "video", destOf(), signal(), { ...SMALL, open: { ...NODE_OPEN_OPS, open: async () => spy } });
    expect(Math.max(...asked)).toBeLessThanOrEqual(16);
    expect(asked.length).toBeGreaterThan(1000 / 16 - 1);
    await real.close().catch(() => undefined);
  });

  test("a change to the library file after the copy does not reach the copy", async () => {
    const bytes = pattern(50);
    const file = await stored(bytes);
    await copyVerifiedOwnMedia(file, "video", destOf(), signal(), SMALL);
    await writeFile(file.path, pattern(50, 9));
    expect(new Uint8Array(await readFile(destOf()))).toEqual(bytes);
  });

  test("the real chunk size copies a file of several MiB whole", async () => {
    const bytes = pattern(3 * 1024 * 1024 + 123);
    await copyVerifiedOwnMedia(await stored(bytes), "video", destOf(), signal(), { freeBytes: async () => null });
    expect(sha(new Uint8Array(await readFile(destOf())))).toBe(sha(bytes));
  });
});

describe("copyVerifiedOwnMedia: the hash is compared with the record at the end", () => {
  test("a file whose bytes changed but whose size did not is refused, and its copy is removed", async () => {
    const bytes = pattern(100);
    const file = await stored(bytes);
    const changed = Uint8Array.from(bytes);
    changed[99] = (changed[99] ?? 0) ^ 1;
    await writeFile(file.path, changed);
    const failure = await failureOf(copyVerifiedOwnMedia(file, "video", destOf(), signal(), SMALL));
    expect(failure.engineError.code).toBe("RENDER_FAILED");
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("a record whose sha256 is another file's is refused although the bytes are the file's own", async () => {
    const file = await stored(pattern(100));
    await failureOf(copyVerifiedOwnMedia({ ...file, sha256: sha(pattern(100, 5)) }, "video", destOf(), signal(), SMALL));
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("the last byte of the file is hashed too: a change in it is caught", async () => {
    const bytes = pattern(33);
    const file = await stored(bytes);
    const changed = Uint8Array.from(bytes);
    changed[32] = (changed[32] ?? 0) ^ 0xff;
    await writeFile(file.path, changed);
    await failureOf(copyVerifiedOwnMedia(file, "video", destOf(), signal(), SMALL));
    expect(await readdir(jobDir())).toEqual([]);
  });
});

describe("copyVerifiedOwnMedia: the size is bound by the record", () => {
  test("a file one byte longer than its record is refused", async () => {
    const file = await stored(pattern(50));
    await writeFile(file.path, pattern(51));
    await failureOf(copyVerifiedOwnMedia(file, "video", destOf(), signal(), SMALL));
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("a file one byte shorter than its record is refused", async () => {
    const file = await stored(pattern(50));
    await writeFile(file.path, pattern(49));
    await failureOf(copyVerifiedOwnMedia(file, "video", destOf(), signal(), SMALL));
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("a handle whose size is not the record's is refused before a byte is read or a file made", async () => {
    const file = await stored(pattern(50));
    const real = await open(file.path, "r");
    const lying = lyingHandle(real, { lyingSize: 10 ** 12, fill: "none" });
    await failureOf(copyVerifiedOwnMedia(file, "video", destOf(), signal(), { ...SMALL, open: { ...NODE_OPEN_OPS, open: async () => lying.handle } }));
    expect(lying.reads()).toBe(0);
    expect(await readdir(jobDir())).toEqual([]);
    await real.close().catch(() => undefined);
  });

  test("a file that grows DURING the copy is refused, and the read never goes past the record's size plus one byte", async () => {
    const bytes = pattern(100);
    const file = await stored(bytes);
    const real = await open(file.path, "r");
    let reads = 0;
    let end = 0;
    const growing = new Proxy(real, {
      get(target, property) {
        if (property === "read") {
          return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
            reads++;
            // After the first chunk has been read, the file grows by 40 bytes.
            if (reads === 2) await appendFile(file.path, pattern(40, 3));
            const answer = await target.read(buffer, offset, length, position);
            end = Math.max(end, position + answer.bytesRead);
            return answer;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const failure = await failureOf(copyVerifiedOwnMedia(file, "video", destOf(), signal(), { ...SMALL, open: { ...NODE_OPEN_OPS, open: async () => growing } }));
    expect(failure.engineError.code).toBe("RENDER_FAILED");
    expect(end).toBeLessThanOrEqual(101);
    expect(await readdir(jobDir())).toEqual([]);
    await real.close().catch(() => undefined);
  });

  test("a record over the video byte cap is refused without opening the file", async () => {
    const file = await stored(pattern(50));
    let opened = 0;
    const ops: OpenRegularOps = { ...NODE_OPEN_OPS, open: async (...args) => (opened++, NODE_OPEN_OPS.open(...args)) };
    await failureOf(copyVerifiedOwnMedia({ ...file, bytes: MAX_STORED_VIDEO_BYTES + 1 }, "video", destOf(), signal(), { ...SMALL, open: ops }));
    expect(opened).toBe(0);
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("the cap is the shared stored-video cap, and a lower one given by the caller holds: one byte over is refused, one at it is copied", async () => {
    const bytes = pattern(50);
    const file = await stored(bytes);
    await failureOf(copyVerifiedOwnMedia(file, "video", destOf(), signal(), { ...SMALL, maxBytes: 49 }));
    expect(await readdir(jobDir())).toEqual([]);
    await copyVerifiedOwnMedia(file, "video", destOf(), signal(), { ...SMALL, maxBytes: 50 });
    expect(new Uint8Array(await readFile(destOf()))).toEqual(bytes);
  });

  test("a record of zero bytes, or a negative or fractional one, is refused without opening the file", async () => {
    const file = await stored(pattern(50));
    let opened = 0;
    const ops: OpenRegularOps = { ...NODE_OPEN_OPS, open: async (...args) => (opened++, NODE_OPEN_OPS.open(...args)) };
    for (const bytes of [0, -1, 1.5, Number.NaN]) await failureOf(copyVerifiedOwnMedia({ ...file, bytes }, "video", destOf(), signal(), { ...SMALL, open: ops }));
    expect(opened).toBe(0);
  });
});

describe("copyVerifiedOwnMedia: only a plain file of ours is read", () => {
  test("a library file that became a symlink, even to a file with the right bytes, is refused", async () => {
    const bytes = pattern(60);
    const real = await stored(bytes, "media-0000002.mp4");
    const link = join(libraryDir(), "media-0000001.mp4");
    await symlink(real.path, link);
    await failureOf(copyVerifiedOwnMedia({ ...real, path: link }, "video", destOf(), signal(), SMALL));
    expect(await readdir(jobDir())).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("a FIFO where the file should be is refused at once, not waited on", async () => {
    const file = await stored(pattern(60));
    const fifo = join(libraryDir(), "fifo.mp4");
    execFileSync("mkfifo", [fifo]);
    await failureOf(copyVerifiedOwnMedia({ ...file, path: fifo }, "video", destOf(), signal(), SMALL));
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("a name swapped for a link between the lstat and the open is refused (the handle must be the file the name led to)", async () => {
    const file = await stored(pattern(60));
    const other = await stored(pattern(60, 4), "media-0000003.mp4");
    const swapping: OpenRegularOps = {
      lstat: (path) => NODE_OPEN_OPS.lstat(path),
      open: async (path, flags) => {
        await rm(file.path);
        await symlink(other.path, file.path);
        return NODE_OPEN_OPS.open(path, flags);
      },
    };
    await failureOf(copyVerifiedOwnMedia(file, "video", destOf(), signal(), { ...SMALL, open: swapping }));
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("a file that is gone is refused", async () => {
    const file = await stored(pattern(60));
    await failureOf(copyVerifiedOwnMedia({ ...file, path: join(libraryDir(), "nothing.mp4") }, "video", destOf(), signal(), SMALL));
  });

  test("a failure names no path and no media id", async () => {
    const file = await stored(pattern(60));
    await writeFile(file.path, pattern(60, 2));
    const failure = await failureOf(copyVerifiedOwnMedia(file, "video", destOf(), signal(), SMALL));
    for (const text of [JSON.stringify(failure.engineError), failure.message]) {
      expect(text).not.toContain(tmp());
      expect(text).not.toContain("media-0000001");
    }
  });
});

describe("copyVerifiedOwnMedia: only a file that is really not there or not that file is `unavailable` (L-3)", () => {
  const erroring = (code: string, where: "lstat" | "open"): OpenRegularOps => {
    const fail = (): never => {
      throw Object.assign(new Error(`${code}: the disk said no`), { code });
    };
    return where === "lstat" ? { ...NODE_OPEN_OPS, lstat: async () => fail() } : { ...NODE_OPEN_OPS, open: async () => fail() };
  };
  const kindOf = async (io: StreamCopyIo): Promise<"unavailable" | "failed"> => {
    const file = await stored(pattern(50));
    const error = await copyVerifiedOwnMedia(file, "video", destOf(), signal(), io).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RenderFailure);
    expect(await readdir(jobDir())).toEqual([]);
    return error instanceof OwnMediaUnavailableError ? "unavailable" : "failed";
  };

  test.each(["ENOENT", "ELOOP"])("%s at the lstat and at the open is unavailable: the file is gone or is a link", async (code) => {
    expect(await kindOf({ ...SMALL, open: erroring(code, "lstat") })).toBe("unavailable");
    expect(await kindOf({ ...SMALL, open: erroring(code, "open") })).toBe("unavailable");
  });

  test.each(["EIO", "EMFILE", "EBUSY", "EACCES", "EPERM"])("%s at the lstat and at the open is a failed read, NOT the file being gone", async (code) => {
    expect(await kindOf({ ...SMALL, open: erroring(code, "lstat") })).toBe("failed");
    expect(await kindOf({ ...SMALL, open: erroring(code, "open") })).toBe("failed");
  });

  test("a read error in the middle of the copy (EIO) is a failed read, and the partial copy is removed", async () => {
    const file = await stored(pattern(100));
    const real = await open(file.path, "r");
    let reads = 0;
    const flaky = new Proxy(real, {
      get(target, property) {
        if (property === "read") {
          return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
            if (++reads === 3) throw Object.assign(new Error("EIO: i/o error"), { code: "EIO" });
            return target.read(buffer, offset, length, position);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    const error = await copyVerifiedOwnMedia(file, "video", destOf(), signal(), { ...SMALL, open: { ...NODE_OPEN_OPS, open: async () => flaky } }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RenderFailure);
    expect(error).not.toBeInstanceOf(OwnMediaUnavailableError);
    expect(await readdir(jobDir())).toEqual([]);
    await real.close().catch(() => undefined);
  });

  test("a link, a changed identity, a wrong size and a wrong hash are unavailable", async () => {
    const bytes = pattern(60);
    const real = await stored(bytes, "media-0000002.mp4");
    const link = join(libraryDir(), "media-0000001.mp4");
    await symlink(real.path, link);
    const asLink = await copyVerifiedOwnMedia({ ...real, path: link }, "video", destOf(), signal(), SMALL).catch((e: unknown) => e);
    expect(asLink).toBeInstanceOf(OwnMediaUnavailableError);
    const wrongSize = await copyVerifiedOwnMedia({ ...real, bytes: 59 }, "video", destOf(), signal(), SMALL).catch((e: unknown) => e);
    expect(wrongSize).toBeInstanceOf(OwnMediaUnavailableError);
    const wrongHash = await copyVerifiedOwnMedia({ ...real, sha256: sha(pattern(60, 3)) }, "video", destOf(), signal(), SMALL).catch((e: unknown) => e);
    expect(wrongHash).toBeInstanceOf(OwnMediaUnavailableError);
    const swapping: OpenRegularOps = {
      lstat: (path) => NODE_OPEN_OPS.lstat(path),
      open: async (path, flags) => {
        await rm(real.path);
        await symlink(link, real.path).catch(() => undefined);
        return NODE_OPEN_OPS.open(path, flags);
      },
    };
    const swapped = await copyVerifiedOwnMedia(real, "video", destOf(), signal(), { ...SMALL, open: swapping }).catch((e: unknown) => e);
    expect(swapped).toBeInstanceOf(OwnMediaUnavailableError);
  });
});

describe("copyVerifiedOwnMedia: progress", () => {
  test("reports the bytes copied of THIS file after each chunk, ending at its whole size", async () => {
    const seen: number[] = [];
    await copyVerifiedOwnMedia(await stored(pattern(100)), "video", destOf(), signal(), { ...SMALL, onBytes: (n) => void seen.push(n) });
    expect(seen.at(-1)).toBe(100);
    expect(seen).toEqual([...seen].sort((a, b) => a - b));
    expect(seen.length).toBeGreaterThan(3);
  });
});

describe("copyVerifiedOwnMedia: the copy is made with wx", () => {
  test("never writes through a name that is already in the job folder, and leaves it as it was", async () => {
    const file = await stored(pattern(60));
    const target = join(tmp(), "elsewhere.bin");
    await writeFile(target, "keep me");
    await symlink(target, destOf());
    await failureOf(copyVerifiedOwnMedia(file, "video", destOf(), signal(), SMALL));
    expect(await readFile(target, "utf8")).toBe("keep me");
    expect((await readdir(jobDir())).sort()).toEqual(["own-media-0000001.mp4"]);
  });

  test("a regular file already at the name is left untouched, not truncated and not removed", async () => {
    const file = await stored(pattern(60));
    await writeFile(destOf(), "someone else's");
    await failureOf(copyVerifiedOwnMedia(file, "video", destOf(), signal(), SMALL));
    expect(await readFile(destOf(), "utf8")).toBe("someone else's");
  });
});

describe("copyVerifiedOwnMedia: the room is asked for first", () => {
  test("a volume with less than the file plus the margin refuses before the file is opened or anything is made", async () => {
    const file = await stored(pattern(60));
    let opened = 0;
    const ops: OpenRegularOps = { ...NODE_OPEN_OPS, open: async (...args) => (opened++, NODE_OPEN_OPS.open(...args)) };
    const failure = await failureOf(copyVerifiedOwnMedia(file, "video", destOf(), signal(), { ...SMALL, open: ops, freeBytes: async () => file.bytes + OWN_COPY_FREE_MARGIN_BYTES - 1 }));
    expect(failure.engineError.code).toBe("RENDER_FAILED");
    expect(failure.engineError.detail).toMatch(/free space/);
    expect(opened).toBe(0);
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("a volume with exactly the file plus the margin is enough", async () => {
    const bytes = pattern(60);
    await copyVerifiedOwnMedia(await stored(bytes), "video", destOf(), signal(), { ...SMALL, freeBytes: async (dir) => (dir === jobDir() ? 60 + OWN_COPY_FREE_MARGIN_BYTES : 0) });
    expect(new Uint8Array(await readFile(destOf()))).toEqual(bytes);
  });

  test("the volume asked is the one the copy goes to: the job folder's", async () => {
    const asked: string[] = [];
    await copyVerifiedOwnMedia(await stored(pattern(60)), "video", destOf(), signal(), {
      ...SMALL,
      freeBytes: async (dir) => {
        asked.push(dir);
        return null;
      },
    });
    expect(asked).toEqual([jobDir()]);
  });

  test("a volume that cannot say is not refused", async () => {
    const bytes = pattern(60);
    await copyVerifiedOwnMedia(await stored(bytes), "video", destOf(), signal(), { ...SMALL, freeBytes: async () => null });
    expect(new Uint8Array(await readFile(destOf()))).toEqual(bytes);
  });

  test("the real statfs is used when none is given, and a normal volume has the room", async () => {
    const bytes = pattern(60);
    await copyVerifiedOwnMedia(await stored(bytes), "video", destOf(), signal(), { chunkBytes: 16 });
    expect(new Uint8Array(await readFile(destOf()))).toEqual(bytes);
  });

  test("a disk that fills up DURING the copy (ENOSPC on a write) is the same refusal, and the partial copy is removed", async () => {
    const file = await stored(pattern(100));
    const real = await open(destOf(), "wx");
    let writes = 0;
    const dest: DestFile = {
      write: async (buffer, offset, length) => {
        if (++writes === 3) throw Object.assign(new Error("ENOSPC: no space left on device, write"), { code: "ENOSPC" });
        return real.write(buffer, offset, length);
      },
      close: () => real.close(),
    };
    const failure = await failureOf(copyVerifiedOwnMedia(file, "video", destOf(), signal(), { ...SMALL, openDest: async () => dest }));
    expect(failure.engineError.detail).toMatch(/free space/);
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("an ENOSPC at the creation of the copy is the same refusal", async () => {
    const file = await stored(pattern(100));
    const failure = await failureOf(
      copyVerifiedOwnMedia(file, "video", destOf(), signal(), {
        ...SMALL,
        openDest: async () => {
          throw Object.assign(new Error("ENOSPC"), { code: "ENOSPC" });
        },
      }),
    );
    expect(failure.engineError.detail).toMatch(/free space/);
  });

  test("any other write error is a failure of the render's folder, with no path in it, and the partial copy is removed", async () => {
    const file = await stored(pattern(100));
    const real = await open(destOf(), "wx");
    let writes = 0;
    const dest: DestFile = {
      write: async (buffer, offset, length) => {
        if (++writes === 2) throw Object.assign(new Error(`EIO: i/o error, write '${destOf()}'`), { code: "EIO" });
        return real.write(buffer, offset, length);
      },
      close: () => real.close(),
    };
    const failure = await failureOf(copyVerifiedOwnMedia(file, "video", destOf(), signal(), { ...SMALL, openDest: async () => dest }));
    expect(failure.engineError.code).toBe("RENDER_FAILED");
    expect(JSON.stringify(failure.engineError)).not.toContain(tmp());
    expect(failure.message).not.toContain(tmp());
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("a write that takes only part of a chunk is written again until the chunk is whole", async () => {
    const bytes = pattern(100);
    const real = await open(destOf(), "wx");
    const dest: DestFile = { write: (buffer, offset, length) => real.write(buffer, offset, Math.min(length, 5)), close: () => real.close() };
    await copyVerifiedOwnMedia(await stored(bytes), "video", destOf(), signal(), { ...SMALL, openDest: async () => dest });
    expect(new Uint8Array(await readFile(destOf()))).toEqual(bytes);
  });
});

describe("copyVerifiedOwnMedia: a cancel stops the copy at once", () => {
  test("an abort that is already there copies nothing and makes no file", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(copyVerifiedOwnMedia(await stored(pattern(60)), "video", destOf(), controller.signal, SMALL)).rejects.toThrow("stopped");
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("an abort in the middle stops before the next chunk is read, rejects with the signal's own reason, and leaves no partial file", async () => {
    const file = await stored(pattern(1000));
    const controller = new AbortController();
    const real = await open(file.path, "r");
    let reads = 0;
    const counting = new Proxy(real, {
      get(target, property) {
        if (property === "read") {
          return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
            reads++;
            if (reads === 3) controller.abort(new Error("stopped"));
            return target.read(buffer, offset, length, position);
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    await expect(copyVerifiedOwnMedia(file, "video", destOf(), controller.signal, { ...SMALL, open: { ...NODE_OPEN_OPS, open: async () => counting } })).rejects.toThrow("stopped");
    expect(reads).toBe(3);
    expect(await readdir(jobDir())).toEqual([]);
    await real.close().catch(() => undefined);
  });

  test("an abort during a write is the signal's reason, not a failure of the folder", async () => {
    const file = await stored(pattern(100));
    const controller = new AbortController();
    const real = await open(destOf(), "wx");
    let writes = 0;
    const dest: DestFile = {
      write: async (buffer, offset, length) => {
        if (++writes === 2) controller.abort(new Error("stopped"));
        return real.write(buffer, offset, length);
      },
      close: () => real.close(),
    };
    await expect(copyVerifiedOwnMedia(file, "video", destOf(), controller.signal, { ...SMALL, openDest: async () => dest })).rejects.toThrow("stopped");
    expect(await readdir(jobDir())).toEqual([]);
  });

  test("an abort at the very end, after the last byte was read, still wins: nothing is left", async () => {
    const file = await stored(pattern(32));
    const controller = new AbortController();
    const real = await open(file.path, "r");
    const proxy = new Proxy(real, {
      get(target, property) {
        if (property === "read") {
          return async (buffer: Uint8Array, offset: number, length: number, position: number) => {
            const answer = await target.read(buffer, offset, length, position);
            // The read that finds the end of the file (nothing more to read) is the last thing the loop does.
            if (answer.bytesRead === 0) controller.abort(new Error("stopped"));
            return answer;
          };
        }
        const value: unknown = Reflect.get(target, property);
        return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
      },
    });
    await expect(copyVerifiedOwnMedia(file, "video", destOf(), controller.signal, { ...SMALL, open: { ...NODE_OPEN_OPS, open: async () => proxy } })).rejects.toThrow("stopped");
    expect(await readdir(jobDir())).toEqual([]);
    await real.close().catch(() => undefined);
  });

  test("both handles are closed on a success, on a refusal and on a cancel", async () => {
    const closed: boolean[] = [];
    const track = <T extends { close(): Promise<void> }>(real: T): T => {
      const index = closed.push(false) - 1;
      return new Proxy(real, {
        get(target, property) {
          if (property === "close") {
            return () => {
              closed[index] = true;
              return real.close();
            };
          }
          const value: unknown = Reflect.get(target, property);
          return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
        },
      });
    };
    const io: StreamCopyIo = {
      ...SMALL,
      open: { lstat: (path) => NODE_OPEN_OPS.lstat(path), open: async (path, flags) => track(await NODE_OPEN_OPS.open(path, flags)) },
      openDest: async (path) => track(await open(path, "wx")),
    };
    const good = await stored(pattern(100));
    await copyVerifiedOwnMedia(good, "video", destOf(), signal(), io);
    await rm(destOf());
    await failureOf(copyVerifiedOwnMedia({ ...good, sha256: sha(pattern(100, 8)) }, "video", destOf(), signal(), io));
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(copyVerifiedOwnMedia(good, "video", destOf(), controller.signal, io)).rejects.toThrow("stopped");
    const reads = new AbortController();
    const aborting: StreamCopyIo = { ...io, openDest: async (path) => { reads.abort(new Error("stopped")); return track(await open(path, "wx")); } };
    await expect(copyVerifiedOwnMedia(good, "video", destOf(), reads.signal, aborting)).rejects.toThrow("stopped");
    expect(closed.length).toBeGreaterThanOrEqual(4);
    expect(closed.every(Boolean)).toBe(true);
    // And nothing holds the library file: it can be replaced and removed at once.
    await writeFile(good.path, pattern(100, 3));
    await rm(good.path);
    expect(await stat(libraryDir()).then((s) => s.isDirectory())).toBe(true);
  });
});
