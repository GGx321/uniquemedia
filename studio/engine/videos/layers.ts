import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Layer } from "../../shared/engine/montage";
import { layerRange, stickerBox, textBox } from "../../shared/montage";
import type { OverlayInput } from "../render";
import { RenderFailure } from "../renderQueue/queue";
import { captionFailure, type PreviewGate } from "../text/preview";
import { StickerAssetError, type StickerAssets } from "./stickerAssets";

// The spec's text and sticker layers as the render's overlay inputs (plan 3b.6).
//
// - A TEXT layer is drawn by the engine's own rasteriser, the very call behind `montages.textPreview`, so the render and the
//   preview are one picture; its box is `textBox(layer, raster)`: centred where the layer says, clamped into the frame.
// - A BUILT-IN sticker is read from the verified set (`stickerAssets.ts`: the catalogue's sha256, the structure, the loop and
//   size agreeing with the manifest) and placed by `stickerBox(layer)`; it is scaled to its box and loops at the period stored
//   with it.
// - Both are written into the JOB's own folder, under names this module makes (`text-NN.png`, `sticker-NN.apng`, NN being
//   the layer's place in z-order), exclusively: the renderer names no path, ffmpeg opens only files the engine made a moment
//   ago, and nothing already on disk is overwritten.
//
// `resolveLayers` does everything that can fail or wait (the rasteriser, the sticker checks) and writes nothing; `stage` then
// writes, once the runner has made the job's folder. So a bad caption fails the job before a single ffmpeg starts.

export interface LayerDeps {
  readonly gate: PreviewGate;
  readonly stickers: StickerAssets;
  /** Why the text worker did not load, if it did not, for the failure's detail. */
  readonly loadError?: () => string | undefined;
  /** Creates the file exclusively; `fs.writeFile` with `wx` when absent. A test supplies a faulty one. */
  readonly writeFile?: (path: string, bytes: Uint8Array) => Promise<void>;
}

export interface ResolvedLayers {
  /** In z-order, later on top, with absolute paths inside the job's folder. */
  readonly overlays: readonly OverlayInput[];
  /** Writes every file the overlays name into `dir`, which must be the job's folder. */
  stage(dir: string): Promise<void>;
}

const NN = (index: number): string => String(index).padStart(2, "0");

const defaultWrite = (path: string, bytes: Uint8Array): Promise<void> => writeFile(path, bytes, { flag: "wx" });

/** A layer that cannot be drawn fails the render with the engine's own answer (never a path: the job folder is the only one in play). */
function stickerFailure(error: unknown): unknown {
  if (error instanceof StickerAssetError) return new RenderFailure({ code: "RENDER_FAILED", detail: `a built-in sticker could not be used (${error.code})` });
  return error;
}

export async function resolveLayers(layers: readonly Layer[], jobDir: string, deps: LayerDeps, signal: AbortSignal): Promise<ResolvedLayers> {
  const overlays: OverlayInput[] = [];
  const files: Array<{ name: string; bytes: Uint8Array }> = [];

  for (const [index, layer] of layers.entries()) {
    signal.throwIfAborted();
    const range = layerRange(layer);
    if (layer.kind === "text") {
      let image: Awaited<ReturnType<PreviewGate["caption"]>>;
      try {
        image = await deps.gate.caption({ value: layer.value, font: layer.font, style: layer.style, color: layer.color, scale: layer.scale }, { signal });
      } catch (error) {
        const failure = captionFailure(error, deps.loadError);
        throw failure === null ? error : new RenderFailure(failure.error);
      }
      const name = `text-${NN(index)}.png`;
      files.push({ name, bytes: image.png });
      overlays.push({ path: join(jobDir, name), format: "png", box: textBox(layer, { w: image.width, h: image.height }), resize: false, startFrame: range.startFrame, endFrame: range.endFrame });
    } else {
      if (layer.sticker.source !== "builtin") throw new RenderFailure({ code: "INTERNAL", detail: "an own sticker cannot be rendered yet" });
      let asset: Awaited<ReturnType<StickerAssets["read"]>>;
      try {
        asset = await deps.stickers.read(layer.sticker.stickerId);
      } catch (error) {
        throw stickerFailure(error);
      }
      const name = `sticker-${NN(index)}.apng`;
      files.push({ name, bytes: asset.bytes });
      overlays.push({
        path: join(jobDir, name),
        format: "apng",
        box: stickerBox(layer, { w: asset.width, h: asset.height }),
        resize: true,
        startFrame: range.startFrame,
        endFrame: range.endFrame,
        loopFrames: asset.loopFrames,
        sourceSize: { w: asset.width, h: asset.height },
      });
    }
  }

  const write = deps.writeFile ?? defaultWrite;
  return {
    overlays,
    async stage(dir) {
      if (dir !== jobDir) throw new TypeError("layers are staged only into the job's own folder");
      for (const file of files) await write(join(dir, file.name), file.bytes);
    },
  };
}
