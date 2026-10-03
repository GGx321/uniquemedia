import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { STICKER_MANIFEST } from "../../shared/stickers/manifest";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { createStickerAssets, StickerAssetError, type StickerFileSystem } from "./stickerAssets";
useNativeGlobals();

// The built-in stickers as the render reads them (plan 3b.6): out of the shipped folder (the asar when packaged), whole,
// checked against the catalogue (its file name, byte count and sha256), re-inspected for structure, and checked against the
// manifest, before a single byte goes near ffmpeg. The renderer never names a path: a sticker is an id.

const DIR = join(import.meta.dir, "../../assets/stickers");
const realCatalog = JSON.parse(readFileSync(join(DIR, "catalog.json"), "utf8")) as { stickers: Array<Record<string, unknown>> };
const sha = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

interface FakeFile {
  bytes: Uint8Array;
  link?: boolean;
  notFile?: boolean;
}

/** A file system over `files` (by file name inside DIR) and `catalog` (the JSON text), counting what is read. */
function fakeFs(files: Record<string, FakeFile>, catalog: string): { fs: StickerFileSystem; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    fs: {
      readFile: async (path) => {
        reads.push(path);
        if (path === join(DIR, "catalog.json")) return new TextEncoder().encode(catalog);
        const f = files[path.slice(DIR.length + 1)];
        if (f === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return f.bytes;
      },
      lstat: async (path) => {
        const f = files[path.slice(DIR.length + 1)];
        if (f === undefined) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
        return { isFile: () => f.notFile !== true, isSymbolicLink: () => f.link === true };
      },
    },
  };
}

const realBytes = (file: string): Uint8Array => new Uint8Array(readFileSync(join(DIR, file)));
const catalogWith = (edit: (entries: Array<Record<string, unknown>>) => void): string => {
  const copy = structuredClone(realCatalog);
  edit(copy.stickers);
  return JSON.stringify(copy);
};
const entry = (entries: Array<Record<string, unknown>>, id: string): Record<string, unknown> => {
  const e = entries.find((x) => x.id === id);
  if (e === undefined) throw new Error(`no catalogue entry ${id}`);
  return e;
};
async function codeOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
    return "resolved";
  } catch (error) {
    return error instanceof StickerAssetError ? error.code : "another error";
  }
}

describe("createStickerAssets over the shipped folder", () => {
  const assets = createStickerAssets(DIR);

  test.each(STICKER_MANIFEST.map((s) => [s.id, s.loopFrames, s.size] as const))("reads %s whole, with its loop of %d frames and its %d px canvas", async (id, loopFrames, size) => {
    const asset = await assets.read(id);
    expect(asset.loopFrames).toBe(loopFrames);
    expect(asset.width).toBe(size);
    expect(asset.height).toBe(size);
    expect(sha(asset.bytes)).toBe(entry(realCatalog.stickers, id).sha256 as string);
  });

  test("answers the same bytes a second time, from what it verified", async () => {
    const [a, b] = [await assets.read("heart-pulse"), await assets.read("heart-pulse")];
    expect(sha(a.bytes)).toBe(sha(b.bytes));
  });
});

describe("createStickerAssets refuses what the catalogue does not vouch for", () => {
  const heart = realBytes("heart-pulse.apng");
  const intact = (): Record<string, FakeFile> => ({ "heart-pulse.apng": { bytes: heart } });

  test("an id that is not catalogued, without touching any file but the catalogue", async () => {
    const { fs, reads } = fakeFs(intact(), JSON.stringify(realCatalog));
    expect(await codeOf(createStickerAssets(DIR, fs).read("../../etc/passwd"))).toBe("not-catalogued");
    expect(reads).toEqual([join(DIR, "catalog.json")]);
  });

  test("a catalogue that cannot be read", async () => {
    const { fs } = fakeFs({}, "{ not json");
    expect(await codeOf(createStickerAssets(DIR, fs).read("heart-pulse"))).toBe("unreadable");
  });

  test("a catalogue whose file name leaves the folder", async () => {
    const catalog = catalogWith((e) => (entry(e, "heart-pulse").file = "../../secret.apng"));
    const { fs, reads } = fakeFs(intact(), catalog);
    expect(await codeOf(createStickerAssets(DIR, fs).read("heart-pulse"))).toBe("unreadable");
    expect(reads).toEqual([join(DIR, "catalog.json")]);
  });

  test("a file that is gone", async () => {
    const { fs } = fakeFs({}, JSON.stringify(realCatalog));
    expect(await codeOf(createStickerAssets(DIR, fs).read("heart-pulse"))).toBe("unreadable");
  });

  test("a symbolic link", async () => {
    const { fs } = fakeFs({ "heart-pulse.apng": { bytes: heart, link: true } }, JSON.stringify(realCatalog));
    expect(await codeOf(createStickerAssets(DIR, fs).read("heart-pulse"))).toBe("tampered");
  });

  test("something that is not a regular file", async () => {
    const { fs } = fakeFs({ "heart-pulse.apng": { bytes: heart, notFile: true } }, JSON.stringify(realCatalog));
    expect(await codeOf(createStickerAssets(DIR, fs).read("heart-pulse"))).toBe("tampered");
  });

  test("a file of another size than the catalogue says", async () => {
    const { fs } = fakeFs({ "heart-pulse.apng": { bytes: heart.subarray(0, heart.length - 1) } }, JSON.stringify(realCatalog));
    expect(await codeOf(createStickerAssets(DIR, fs).read("heart-pulse"))).toBe("tampered");
  });

  test("a file with one byte changed", async () => {
    const copy = heart.slice();
    copy[copy.length - 20] = (copy[copy.length - 20] ?? 0) ^ 1;
    const { fs } = fakeFs({ "heart-pulse.apng": { bytes: copy } }, JSON.stringify(realCatalog));
    expect(await codeOf(createStickerAssets(DIR, fs).read("heart-pulse"))).toBe("tampered");
  });

  test("a file the catalogue vouches for that is not an APNG", async () => {
    const junk = new TextEncoder().encode("not a png at all, but the catalogue says it is fine");
    const catalog = catalogWith((e) => Object.assign(entry(e, "heart-pulse"), { sha256: sha(junk), bytes: junk.length }));
    const { fs } = fakeFs({ "heart-pulse.apng": { bytes: junk } }, catalog);
    expect(await codeOf(createStickerAssets(DIR, fs).read("heart-pulse"))).toBe("invalid");
  });

  test("a catalogue whose loop length is not the file's", async () => {
    const catalog = catalogWith((e) => (entry(e, "heart-pulse").loopFrames = 25));
    const { fs } = fakeFs(intact(), catalog);
    expect(await codeOf(createStickerAssets(DIR, fs).read("heart-pulse"))).toBe("mismatch");
  });

  test("a catalogue whose canvas is not the file's", async () => {
    const catalog = catalogWith((e) => (entry(e, "heart-pulse").width = 322));
    const { fs } = fakeFs(intact(), catalog);
    expect(await codeOf(createStickerAssets(DIR, fs).read("heart-pulse"))).toBe("mismatch");
  });

  test("a sticker the catalogue has and the manifest does not", async () => {
    const extra = catalogWith((e) => e.push({ ...entry(e, "heart-pulse"), id: "extra-sticker-one" }));
    const { fs } = fakeFs(intact(), extra);
    expect(await codeOf(createStickerAssets(DIR, fs).read("extra-sticker-one"))).toBe("mismatch");
  });
});
