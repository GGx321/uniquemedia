import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Id } from "../../shared/engine";
import type { ByteSource } from "./diskSource";
import { KINDS } from "./kinds";

// The built-in stickers (`studio/assets/stickers/`: 10 APNGs and catalog.json, shipped inside app.asar under the
// integrity fuse). Inside the asar a file handle cannot be opened the way diskSource.ts does, and each sticker is
// at most 5 MB, so a sticker is read whole, once, and served from memory:
//   - the id must be in the catalogue, and the file's name comes from the catalogue, never from the request;
//   - the catalogue's file name must be `<lowercase-id-like>.apng`: a tampered catalogue cannot point elsewhere;
//   - the file is not a link, its byte count and sha256 are the catalogue's, and it starts like a PNG;
//   - only then is it kept, and the kept copy is what every later request is served from (a file swapped on disk
//     afterwards changes nothing).

export interface StickerFs {
  readFile(path: string): Promise<Uint8Array>;
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
}

const NODE_STICKER_FS: StickerFs = { readFile: (path) => readFile(path), lstat: (path) => lstat(path) };

const Catalog = z.object({
  stickers: z.array(
    z.looseObject({
      id: Id,
      file: z.string().regex(/^[a-z0-9-]{1,64}\.apng$/),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      bytes: z.int().positive().max(KINDS.apng.maxBytes),
    }),
  ),
});

function memorySource(bytes: Uint8Array): ByteSource {
  return {
    size: bytes.length,
    async read(offset, length) {
      if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(length) || offset < 0 || length < 0 || offset + length > bytes.length) {
        throw new RangeError("the read is outside the sticker");
      }
      // A copy: a `Buffer`'s own `slice` is a view, and a caller must never be able to write into the verified bytes.
      return new Uint8Array(bytes.subarray(offset, offset + length));
    },
  };
}

/** A lookup from a sticker id to its verified bytes, over the sticker folder `dir`; null for anything not catalogued and intact. */
export function createStickerLookup(dir: string, fs: StickerFs = NODE_STICKER_FS): (stickerId: string) => Promise<ByteSource | null> {
  let catalog: z.infer<typeof Catalog> | null = null;
  const kept = new Map<string, ByteSource>();

  async function loadCatalog(): Promise<z.infer<typeof Catalog> | null> {
    if (catalog !== null) return catalog;
    try {
      const parsed = Catalog.safeParse(JSON.parse(Buffer.from(await fs.readFile(join(dir, "catalog.json"))).toString("utf8")));
      if (parsed.success) catalog = parsed.data;
    } catch {
      // Unreadable or not JSON: no sticker is served, and the next request tries again.
    }
    return catalog;
  }

  return async (stickerId) => {
    const known = kept.get(stickerId);
    if (known !== undefined) return known;
    try {
      const entry = (await loadCatalog())?.stickers.find((sticker) => sticker.id === stickerId);
      if (entry === undefined) return null;
      const path = join(dir, entry.file);
      const facts = await fs.lstat(path);
      if (facts.isSymbolicLink() || !facts.isFile()) return null;
      const bytes = await fs.readFile(path);
      if (bytes.length !== entry.bytes) return null;
      if (createHash("sha256").update(bytes).digest("hex") !== entry.sha256) return null;
      if (!KINDS.apng.sniff(bytes.subarray(0, 16))) return null;
      const source = memorySource(bytes);
      kept.set(stickerId, source);
      return source;
    } catch {
      return null;
    }
  };
}
