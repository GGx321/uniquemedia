/**
 * Generates the built-in sticker set (3b.5, S19): `bun studio/scripts/stickers/generateStickers.ts`.
 *
 * Each sticker in `studio/shared/stickers/manifest.ts` has a design
 * (./designs.ts) that draws frame i of its loop with a small software
 * rasteriser (./raster.ts); the frames are written as an APNG by ./apngWriter.ts,
 * every frame lasting exactly 1/30 s, so the frame count is the loop length in
 * 30 fps frames. Output goes to `studio/assets/stickers/`: one `<id>.apng` each
 * and `catalog.json` (file, sha256, size, loop length, category, tags).
 *
 * The output is deterministic: no clock, no randomness, no libm, our own
 * DEFLATE. A test regenerates the set and compares it byte for byte with what
 * is committed, so a changed design or generator cannot be committed without
 * its new files.
 *
 * Options: `--out <dir>` writes elsewhere; `--only id,id` generates just those
 * (and then writes no catalog).
 */
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { inspectApng, STICKER_LIMITS } from "../../shared/stickers/apng";
import { STICKER_MANIFEST, type StickerCategoryId, type StickerManifestEntry } from "../../shared/stickers/manifest";
import { encodeApng } from "./apngWriter";
import { DESIGNS } from "./designs";
import { Raster } from "./raster";

export interface GeneratedSticker {
  readonly entry: StickerManifestEntry;
  readonly file: string;
  readonly bytes: Uint8Array;
}

export interface CatalogEntry {
  readonly id: string;
  readonly file: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly width: number;
  readonly height: number;
  /** The loop period in 30 fps frames: what the render's loop and the preview's `mod` both use. */
  readonly loopFrames: number;
  readonly category: StickerCategoryId;
  /** The frame a thumbnail shows. */
  readonly posterFrame: number;
  readonly tags: readonly string[];
}

export interface Catalog {
  readonly version: 1;
  readonly fps: 30;
  readonly stickers: readonly CatalogEntry[];
}

export const STICKER_ASSET_DIR = join(import.meta.dir, "..", "..", "assets", "stickers");

/** The RGBA frames of a sticker's loop. Throws if the entry has no design. */
export function renderStickerFrames(entry: StickerManifestEntry): Uint8Array[] {
  const design = Object.hasOwn(DESIGNS, entry.id) ? DESIGNS[entry.id] : undefined;
  if (design === undefined) throw new Error(`no design for sticker "${entry.id}"`);
  const frames: Uint8Array[] = [];
  for (let i = 0; i < entry.loopFrames; i++) {
    const raster = new Raster(entry.size);
    design(raster, i, entry.loopFrames);
    frames.push(raster.toRgba());
  }
  return frames;
}

/** Renders (or takes the already rendered `frames` of), encodes and self-checks one sticker against the caps and the 30 fps grid. */
export function generateSticker(entry: StickerManifestEntry, frames?: readonly Uint8Array[]): GeneratedSticker {
  if (!Object.hasOwn(DESIGNS, entry.id)) throw new Error(`no design for sticker "${entry.id}"`);
  if (entry.size > STICKER_LIMITS.maxSide) throw new Error(`size ${entry.size} is over the ${STICKER_LIMITS.maxSide} px cap`);
  if (entry.loopFrames > STICKER_LIMITS.maxLoopFrames) throw new Error(`loop of ${entry.loopFrames} frames is over the ${STICKER_LIMITS.maxLoopFrames} frame cap`);
  const bytes = encodeApng({ width: entry.size, height: entry.size, frames: frames ?? renderStickerFrames(entry) });
  const checked = inspectApng(bytes, STICKER_LIMITS);
  if (!checked.ok) throw new Error(`${entry.id} fails its own check: ${checked.code}: ${checked.detail}`);
  if (checked.info.width !== entry.size || checked.info.height !== entry.size) throw new Error(`${entry.id} came out ${checked.info.width}x${checked.info.height}`);
  if (checked.info.frameCount !== entry.loopFrames || checked.info.loopFrames !== entry.loopFrames) {
    throw new Error(`${entry.id} came out with ${checked.info.frameCount} frames over ${checked.info.loopFrames} grid frames, expected ${entry.loopFrames}`);
  }
  return { entry, file: `${entry.id}.apng`, bytes };
}

/** Generates every manifest sticker, or only the ids in `only`, in manifest order. */
export function generateStickerSet(only?: readonly string[]): GeneratedSticker[] {
  const wanted = only === undefined ? STICKER_MANIFEST : STICKER_MANIFEST.filter((s) => only.includes(s.id));
  if (only !== undefined) {
    const unknown = only.filter((id) => !STICKER_MANIFEST.some((s) => s.id === id));
    if (unknown.length > 0) throw new Error(`unknown sticker id(s): ${unknown.join(", ")}`);
  }
  return wanted.map((entry) => generateSticker(entry));
}

export function buildCatalog(stickers: readonly GeneratedSticker[]): Catalog {
  return {
    version: 1,
    fps: 30,
    stickers: stickers.map(({ entry, file, bytes }) => ({
      id: entry.id,
      file,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      bytes: bytes.length,
      width: entry.size,
      height: entry.size,
      loopFrames: entry.loopFrames,
      category: entry.category,
      posterFrame: entry.posterFrame ?? 0,
      tags: entry.tags,
    })),
  };
}

export function catalogJson(catalog: Catalog): string {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

/** Deletes the `*.apng` files in `dir` that are not in `keep`. Only for the asset folder itself. */
export function removeStaleStickers(dir: string, keep: ReadonlySet<string>): void {
  for (const name of readdirSync(dir)) if (name.endsWith(".apng") && !keep.has(name)) rmSync(join(dir, name));
}

/**
 * Writes the stickers into `out`. A complete set also writes `catalog.json`.
 * Stale `*.apng` files are removed only when `out` is the committed asset
 * folder: any other folder may hold files that are not ours.
 */
export function writeStickerSet(out: string, set: readonly GeneratedSticker[], complete: boolean): void {
  mkdirSync(out, { recursive: true });
  for (const s of set) writeFileSync(join(out, s.file), s.bytes);
  if (!complete) return;
  writeFileSync(join(out, "catalog.json"), catalogJson(buildCatalog(set)));
  if (resolve(out) === resolve(STICKER_ASSET_DIR)) removeStaleStickers(out, new Set(set.map((s) => s.file)));
}

function optionValue(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const out = optionValue(args, "--out") ?? STICKER_ASSET_DIR;
  const onlyArg = optionValue(args, "--only");
  const only = onlyArg === undefined ? undefined : onlyArg.split(",").filter((s) => s.length > 0);
  const set = generateStickerSet(only);
  writeStickerSet(out, set, only === undefined);
  const total = set.reduce((n, s) => n + s.bytes.length, 0);
  console.log(`wrote ${set.length} stickers (${total} bytes) to ${out}`);
}
