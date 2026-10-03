import { createHash } from "node:crypto";
import { lstat, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { Id } from "../../shared/engine";
import { inspectApng } from "../../shared/stickers/apng";
import { stickerById } from "../../shared/stickers/manifest";

// The built-in stickers as a render reads them (plan 3b.6). The shipped folder (`studio/assets/stickers/`, inside app.asar
// when packaged, under the integrity fuse) is read whole, once, and only what the catalogue vouches for is returned:
//   - the id must be in the catalogue, and the file name comes from the catalogue, never from the caller (and must be
//     `<lowercase-id-like>.apng`, so a tampered catalogue cannot point elsewhere);
//   - the file is not a link, its byte count and sha256 are the catalogue's;
//   - `inspectApng` re-runs (structure, caps), and the catalogue, the manifest and the file agree on the loop length in 30 fps
//     frames and on the canvas: the render loops at the STORED period, and a disagreement would make it drift from the preview;
//   - the verified copy is what every later read returns (a file swapped on disk afterwards changes nothing).
// The render writes these bytes into its own job folder; the original is never handed to ffmpeg.

export type StickerAssetProblem = "not-catalogued" | "unreadable" | "tampered" | "invalid" | "mismatch";

export class StickerAssetError extends Error {
  readonly code: StickerAssetProblem;
  constructor(code: StickerAssetProblem, message: string) {
    super(message);
    this.name = "StickerAssetError";
    this.code = code;
  }
}

export interface StickerAsset {
  /** The verified file, byte for byte. */
  readonly bytes: Uint8Array;
  /** The loop period in 30 fps frames. */
  readonly loopFrames: number;
  readonly width: number;
  readonly height: number;
}

export interface StickerFileSystem {
  readFile(path: string): Promise<Uint8Array>;
  lstat(path: string): Promise<{ isFile(): boolean; isSymbolicLink(): boolean }>;
}

export interface StickerAssets {
  /** The verified sticker, or rejects with a `StickerAssetError`. */
  read(stickerId: string): Promise<StickerAsset>;
}

const NODE_STICKER_FS: StickerFileSystem = { readFile: (path) => readFile(path), lstat: (path) => lstat(path) };

const Catalog = z.object({
  stickers: z.array(
    z.looseObject({
      id: Id,
      file: z.string().regex(/^[a-z0-9-]{1,64}\.apng$/),
      sha256: z.string().regex(/^[0-9a-f]{64}$/),
      bytes: z.int().positive(),
      width: z.int().positive(),
      height: z.int().positive(),
      loopFrames: z.int().positive(),
    }),
  ),
});

type CatalogEntry = z.infer<typeof Catalog>["stickers"][number];

export function createStickerAssets(dir: string, fs: StickerFileSystem = NODE_STICKER_FS): StickerAssets {
  let catalog: z.infer<typeof Catalog> | null = null;
  const kept = new Map<string, StickerAsset>();

  async function loadCatalog(): Promise<z.infer<typeof Catalog>> {
    if (catalog !== null) return catalog;
    let parsed: ReturnType<typeof Catalog.safeParse>;
    try {
      parsed = Catalog.safeParse(JSON.parse(Buffer.from(await fs.readFile(join(dir, "catalog.json"))).toString("utf8")));
    } catch {
      throw new StickerAssetError("unreadable", "the sticker catalogue could not be read");
    }
    if (!parsed.success) throw new StickerAssetError("unreadable", "the sticker catalogue is not valid");
    catalog = parsed.data;
    return catalog;
  }

  async function verify(entry: CatalogEntry): Promise<StickerAsset> {
    const path = join(dir, entry.file);
    let bytes: Uint8Array;
    try {
      const facts = await fs.lstat(path);
      if (facts.isSymbolicLink() || !facts.isFile()) throw new StickerAssetError("tampered", `sticker ${entry.id} is not a regular file`);
      bytes = await fs.readFile(path);
    } catch (error) {
      if (error instanceof StickerAssetError) throw error;
      throw new StickerAssetError("unreadable", `sticker ${entry.id} could not be read`);
    }
    if (bytes.length !== entry.bytes || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new StickerAssetError("tampered", `sticker ${entry.id} is not the file the catalogue lists`);
    }
    const inspected = inspectApng(bytes);
    if (!inspected.ok) throw new StickerAssetError("invalid", `sticker ${entry.id} is not a valid APNG (${inspected.code})`);
    const { info } = inspected;
    const authored = stickerById(entry.id);
    if (
      authored === undefined ||
      info.loopFrames !== entry.loopFrames ||
      info.loopFrames !== authored.loopFrames ||
      info.width !== entry.width ||
      info.height !== entry.height ||
      info.width !== authored.size ||
      info.height !== authored.size
    ) {
      throw new StickerAssetError("mismatch", `sticker ${entry.id}: the file, the catalogue and the manifest disagree on its loop or size`);
    }
    return { bytes, loopFrames: info.loopFrames, width: info.width, height: info.height };
  }

  return {
    async read(stickerId) {
      const known = kept.get(stickerId);
      if (known !== undefined) return known;
      const entry = (await loadCatalog()).stickers.find((sticker) => sticker.id === stickerId);
      if (entry === undefined) throw new StickerAssetError("not-catalogued", "no such built-in sticker");
      const asset = await verify(entry);
      kept.set(stickerId, asset);
      return asset;
    },
  };
}
