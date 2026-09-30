import { mkdir, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { TextLayer } from "../../shared/engine/montage";
import { EngineFailure } from "../engineFailure";
import { RasterError } from "./rasterTypes";
import type { TextGate } from "./worker/textGate";

/**
 * `montages.textPreview` (plan 3b.4b, K20): the engine's own picture of a text layer, the very PNG a render will use,
 * written where the media route serves it (`userData/render-tmp/text/<previewId>.png`, `studio-media://text/<previewId>`).
 *
 * - **Stale previews.** The window asks again on every keystroke (debounced). A preview still WAITING for the worker when a
 *   newer one of the same layer arrives is dropped (answered `TEXT_PREVIEW_SUPERSEDED`), which costs nothing. One that is
 *   already being drawn is never cancelled: cancelling a running call terminates the worker, and a sequence of edits
 *   would keep killing it. It finishes and is answered. Different layers never cancel each other.
 * - **Files.** Written to a temp name and renamed, so the media route never serves half a PNG. At most `maxFiles` are kept,
 *   the oldest go first, except that a layer's newest preview (what its window shows) goes last, and the first write of a run
 *   clears what an earlier run left.
 * - **Errors.** A caption rule the worker names is `TEXT_INVALID` with the rule. Everything else that goes wrong is
 *   `RENDER_FAILED` (a timeout, the wall or the worker's own, adds a hint to shrink the caption or change the style; it is
 *   never retried here) or, for something unforeseen, `INTERNAL` with no message: a message may carry a path.
 */

/** The folder of previews inside `render-tmp`; main serves it as `studio-media://text/<previewId>` and the render-tmp sweep leaves it alone. */
export const TEXT_PREVIEW_DIR = "text";

/** The hint that goes with a text render that ran out of time (the owner's wording, 2026-09-30). */
export const PREVIEW_HINT_RU = "уменьшите размер или смените стиль";

/** What the service needs of the gate. */
export type PreviewGate = Pick<TextGate, "caption">;

export interface TextPreviewDeps {
  gate: PreviewGate;
  /** `userData/render-tmp/text`, or null when the engine was given no render-tmp folder. */
  dir: () => string | null;
  newId: () => string;
  /** Codes and counts only: never a path or a caption. */
  log: (line: string) => void;
  /** Why the worker could not be loaded at start-up, as far as the engine knows now. */
  loadError?: () => string | undefined;
  /** At most this many previews stay on disk; 64 when absent. */
  maxFiles?: number;
}

export interface TextPreviewResult {
  previewId: string;
  width: number;
  height: number;
}

const DEFAULT_MAX_FILES = 64;
/** `EngineError.detail` travels as `SafeText`, at most 500 characters. */
const MAX_DETAIL = 500;
const SUPERSEDED = new Error("superseded by a newer preview of the same layer");

interface Pending {
  readonly controller: AbortController;
  started: boolean;
}

/** One line, no control characters, at most the wire's bound. */
function detailOf(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, MAX_DETAIL);
}

export class TextPreviewService {
  readonly #deps: TextPreviewDeps;
  readonly #pending = new Map<string, Pending>();
  /** The previews this run wrote, oldest first, with the layer each is of. */
  readonly #written: { id: string; layerId: string }[] = [];
  /** Each layer's newest preview: what its window is showing now, so it is the last to go. */
  readonly #newest = new Map<string, string>();
  #cleared: Promise<void> | null = null;

  constructor(deps: TextPreviewDeps) {
    this.#deps = deps;
  }

  async preview(layer: TextLayer): Promise<TextPreviewResult> {
    const dir = this.#deps.dir();
    if (dir === null) throw new EngineFailure({ code: "RENDER_FAILED", detail: "the engine has no folder for text previews" });

    const entry: Pending = { controller: new AbortController(), started: false };
    const older = this.#pending.get(layer.layerId);
    if (older !== undefined && !older.started) older.controller.abort(SUPERSEDED);
    this.#pending.set(layer.layerId, entry);
    try {
      const image = await this.#deps.gate.caption(
        { value: layer.value, font: layer.font, style: layer.style, color: layer.color, scale: layer.scale },
        {
          signal: entry.controller.signal,
          onStart: () => {
            entry.started = true;
          },
        },
      );
      const previewId = this.#deps.newId();
      await this.#write(dir, layer.layerId, previewId, image.png);
      return { previewId, width: image.width, height: image.height };
    } catch (error) {
      throw this.#answer(error);
    } finally {
      if (this.#pending.get(layer.layerId) === entry) this.#pending.delete(layer.layerId);
    }
  }

  async #write(dir: string, layerId: string, previewId: string, png: Uint8Array): Promise<void> {
    try {
      await mkdir(dir, { recursive: true });
      this.#cleared ??= this.#clear(dir);
      await this.#cleared;
      const temp = join(dir, `.${previewId}.tmp`);
      await writeFile(temp, png);
      await rename(temp, join(dir, `${previewId}.png`));
    } catch (error) {
      this.#deps.log(`a text preview could not be written (${kindOf(error)})`);
      throw new EngineFailure({ code: "RENDER_FAILED", detail: "the text preview could not be written to disk" });
    }
    this.#written.push({ id: previewId, layerId });
    this.#newest.set(layerId, previewId);
    await this.#evict(dir);
  }

  /**
   * Over `maxFiles`, the oldest preview that is not a layer's newest goes first: dragging one layer's size makes a preview per
   * frame, and must not take the pictures of the other layers away (their `<img>` would 404 on a remount). When only newest
   * ones are left the folder stays over the soft bound, up to four times it; past that a caller is inventing layers, and the oldest go.
   */
  async #evict(dir: string): Promise<void> {
    const soft = this.#deps.maxFiles ?? DEFAULT_MAX_FILES;
    const remove = async (at: number): Promise<void> => {
      const [gone] = this.#written.splice(at, 1);
      if (gone === undefined) return;
      if (this.#newest.get(gone.layerId) === gone.id) this.#newest.delete(gone.layerId);
      await rm(join(dir, `${gone.id}.png`), { force: true }).catch(() => undefined);
    };
    while (this.#written.length > soft) {
      const at = this.#written.findIndex((entry) => this.#newest.get(entry.layerId) !== entry.id);
      if (at < 0) break;
      await remove(at);
    }
    while (this.#written.length > 4 * soft) await remove(0);
  }

  /** What an earlier run left in the folder belongs to no window any more. A failure to clear is logged, never fatal. */
  async #clear(dir: string): Promise<void> {
    try {
      for (const name of await readdir(dir)) await rm(join(dir, name), { recursive: true, force: true });
    } catch (error) {
      this.#deps.log(`leftover text previews could not be cleared (${kindOf(error)})`);
    }
  }

  #answer(error: unknown): EngineFailure {
    if (error instanceof EngineFailure) return error;
    if (error === SUPERSEDED) return new EngineFailure({ code: "TEXT_PREVIEW_SUPERSEDED" });
    if (error instanceof RasterError) {
      if (error.code === "CAPTION_INVALID" && error.captionIssue !== undefined) {
        return new EngineFailure({ code: "TEXT_INVALID", captionIssue: error.captionIssue, detail: detailOf(error.message) });
      }
      if (error.code === "RENDER_TIMEOUT") {
        return new EngineFailure({ code: "RENDER_FAILED", detail: detailOf(`text rendering ran out of time: ${PREVIEW_HINT_RU}`) });
      }
      const load = error.code === "WORKER_FAILED" ? this.#deps.loadError?.() : undefined;
      const why = load === undefined ? "" : ` (the text worker did not load: ${load})`;
      return new EngineFailure({ code: "RENDER_FAILED", detail: detailOf(`text rendering failed (${error.code}): ${error.message}${why}`) });
    }
    this.#deps.log(`a text preview failed unexpectedly (${kindOf(error)})`);
    return new EngineFailure({ code: "INTERNAL", detail: "the text preview failed unexpectedly" });
  }
}

function kindOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return "code" in error && typeof error.code === "string" ? error.code : error.name;
}

export function createTextPreviewService(deps: TextPreviewDeps): TextPreviewService {
  return new TextPreviewService(deps);
}
