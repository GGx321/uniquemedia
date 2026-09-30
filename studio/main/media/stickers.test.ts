import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { KINDS } from "./kinds";
import { createStickerLookup } from "./stickers";
useNativeGlobals();

// The built-in stickers are read whole (each is at most 5 MB, and inside app.asar a handle cannot be opened the way
// disk.ts does), so the protection here is different and just as strict: the file must be the one the catalogue names
// (its sha256 and byte count), and what is served is the verified copy in memory, never the file again.

const PNG_HEAD = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const apng = (fill: number, length = 64): Buffer => Buffer.concat([Buffer.from(PNG_HEAD), Buffer.alloc(length, fill)]);
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-stickers-"));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

interface Entry {
  id: string;
  file: string;
  sha256: string;
  bytes: number;
}
const entryFor = (id: string, bytes: Buffer, file = `${id}.apng`): Entry => ({ id, file, sha256: sha(bytes), bytes: bytes.length });
const writeCatalog = (stickers: unknown[]): Promise<void> => writeFile(join(dir, "catalog.json"), JSON.stringify({ version: 1, fps: 30, stickers }));

describe("createStickerLookup", () => {
  test("a catalogued sticker: its size and exact bytes", async () => {
    const bytes = apng(1);
    await writeFile(join(dir, "heart-pulse.apng"), bytes);
    await writeCatalog([entryFor("heart-pulse", bytes)]);
    const source = await createStickerLookup(dir)("heart-pulse");
    expect(source?.size).toBe(bytes.length);
    expect(Buffer.from((await source?.read(0, bytes.length)) ?? []).equals(bytes)).toBe(true);
    expect(Buffer.from((await source?.read(8, 4)) ?? []).equals(bytes.subarray(8, 12))).toBe(true);
  });

  test("an id that is not in the catalogue, even when a file of that name is there", async () => {
    const bytes = apng(1);
    await writeFile(join(dir, "heart-pulse.apng"), bytes);
    await writeFile(join(dir, "not-listed.apng"), bytes);
    await writeCatalog([entryFor("heart-pulse", bytes)]);
    expect(await createStickerLookup(dir)("not-listed")).toBeNull();
  });

  test("a file that is not the catalogued one (other bytes, same size) is refused", async () => {
    const bytes = apng(1);
    await writeFile(join(dir, "heart-pulse.apng"), apng(2));
    await writeCatalog([entryFor("heart-pulse", bytes)]);
    expect(await createStickerLookup(dir)("heart-pulse")).toBeNull();
  });

  test("a file of another size than the catalogue says is refused", async () => {
    const bytes = apng(1);
    await writeFile(join(dir, "heart-pulse.apng"), bytes);
    await writeCatalog([{ ...entryFor("heart-pulse", bytes), bytes: bytes.length + 1 }]);
    expect(await createStickerLookup(dir)("heart-pulse")).toBeNull();
  });

  test("a catalogued file that is not a PNG is refused even when its hash matches", async () => {
    const bytes = Buffer.from("<html>not a picture</html>");
    await writeFile(join(dir, "heart-pulse.apng"), bytes);
    await writeCatalog([entryFor("heart-pulse", bytes)]);
    expect(await createStickerLookup(dir)("heart-pulse")).toBeNull();
  });

  test("a missing file", async () => {
    await writeCatalog([entryFor("heart-pulse", apng(1))]);
    expect(await createStickerLookup(dir)("heart-pulse")).toBeNull();
  });

  test("a missing, unreadable or invalid catalogue", async () => {
    expect(await createStickerLookup(dir)("heart-pulse")).toBeNull();
    await writeFile(join(dir, "catalog.json"), "{not json");
    expect(await createStickerLookup(dir)("heart-pulse")).toBeNull();
    await writeFile(join(dir, "catalog.json"), JSON.stringify({ stickers: [{ id: "heart-pulse" }] }));
    expect(await createStickerLookup(dir)("heart-pulse")).toBeNull();
  });

  const hostileFiles = ["../secret.apng", "..\\secret.apng", "/etc/passwd", "sub/heart-pulse.apng", "heart-pulse.png", "heart-pulse.apng.exe", ".apng", "Heart-Pulse.apng", "heart-pulse.apng\0"];
  for (const file of hostileFiles) {
    test(`a catalogue naming the file ${JSON.stringify(file)} is refused before the disk is touched`, async () => {
      const bytes = apng(1);
      await writeFile(join(dir, "heart-pulse.apng"), bytes);
      await writeCatalog([entryFor("heart-pulse", bytes, file)]);
      let reads = 0;
      const lookup = createStickerLookup(dir, {
        readFile: async (path) => {
          reads++;
          return readFile(path);
        },
        lstat: async () => {
          reads++;
          throw new Error("no");
        },
      });
      expect(await lookup("heart-pulse")).toBeNull();
      // Only the catalogue itself may have been read.
      expect(reads).toBeLessThanOrEqual(1);
    });
  }

  test("a symlink where the sticker file should be is refused", async () => {
    const bytes = apng(1);
    await writeFile(join(dir, "real.apng"), bytes);
    try {
      await symlink(join(dir, "real.apng"), join(dir, "heart-pulse.apng"));
    } catch (error) {
      if (process.platform === "win32" && error instanceof Error && Reflect.get(error, "code") === "EPERM") return;
      throw error;
    }
    await writeCatalog([entryFor("heart-pulse", bytes)]);
    expect(await createStickerLookup(dir)("heart-pulse")).toBeNull();
  });

  test("a folder where the sticker file should be is refused", async () => {
    const bytes = apng(1);
    await mkdir(join(dir, "heart-pulse.apng"));
    await writeCatalog([entryFor("heart-pulse", bytes)]);
    expect(await createStickerLookup(dir)("heart-pulse")).toBeNull();
  });

  test("a file swapped after it was verified does not change what is served: the verified copy is", async () => {
    const bytes = apng(1);
    await writeFile(join(dir, "heart-pulse.apng"), bytes);
    await writeCatalog([entryFor("heart-pulse", bytes)]);
    const lookup = createStickerLookup(dir);
    const first = await lookup("heart-pulse");
    await writeFile(join(dir, "evil.apng"), apng(9));
    await rename(join(dir, "evil.apng"), join(dir, "heart-pulse.apng"));
    const second = await lookup("heart-pulse");
    expect(Buffer.from((await first?.read(0, bytes.length)) ?? []).equals(bytes)).toBe(true);
    expect(Buffer.from((await second?.read(0, bytes.length)) ?? []).equals(bytes)).toBe(true);
  });

  test("a read outside the sticker is refused", async () => {
    const bytes = apng(1);
    await writeFile(join(dir, "heart-pulse.apng"), bytes);
    await writeCatalog([entryFor("heart-pulse", bytes)]);
    const source = await createStickerLookup(dir)("heart-pulse");
    await expect(source?.read(bytes.length - 1, 2)).rejects.toThrow();
    await expect(source?.read(-1, 2)).rejects.toThrow();
  });

  test("the bytes a read hands back are a copy: changing them does not change the next read", async () => {
    const bytes = apng(1);
    await writeFile(join(dir, "heart-pulse.apng"), bytes);
    await writeCatalog([entryFor("heart-pulse", bytes)]);
    const source = await createStickerLookup(dir)("heart-pulse");
    (await source?.read(0, 8))?.fill(0);
    expect(Buffer.from((await source?.read(0, 8)) ?? []).equals(Buffer.from(PNG_HEAD))).toBe(true);
  });
});

describe("the bundled stickers", () => {
  const bundled = resolve(import.meta.dirname, "../../assets/stickers");

  test("every catalogued sticker of the app is found, verified and served as a PNG stream of its size", async () => {
    const catalog: { stickers: Entry[] } = JSON.parse(await readFile(join(bundled, "catalog.json"), "utf8"));
    expect(catalog.stickers.length).toBeGreaterThan(0);
    const lookup = createStickerLookup(bundled);
    for (const entry of catalog.stickers) {
      const source = await lookup(entry.id);
      expect(source?.size).toBe(entry.bytes);
      expect(KINDS.apng.sniff((await source?.read(0, 16)) ?? new Uint8Array(0))).toBe(true);
    }
  });
});
