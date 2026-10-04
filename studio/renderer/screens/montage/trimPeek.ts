import { FRAMES_PER_STEP, STEP_MS } from "../../../shared/montage";

// 3f.3b fix round 1 (L8): while «Обрезка» is dragged, the preview shows the stored frame at the edge being dragged, from what the drag holds; nothing is
// written to the draft until it is let go. The strip tells the preview through this small store (as the playhead is one, 3d.4), so a pointer move
// re-renders the preview's stage and the strip, never the whole editor.

/** The stored frame of own video clip `clipId` to show while its trim is dragged. */
export interface TrimPeek {
  readonly clipId: string;
  readonly frame: number;
}

/**
 * The stored frame at a dragged trim's edge: its first for the window and the left edge (`start`), its last for the right edge (`end`), within the
 * video's `storedFrames` (a clip asking past the video's end shows its last frame, as the preview does).
 */
export function trimPeekFrame(edge: "start" | "end", trim: { readonly startMs: number; readonly durationMs: number }, storedFrames: number): number {
  const at = (ms: number): number => (ms / STEP_MS) * FRAMES_PER_STEP;
  const frame = edge === "start" ? at(trim.startMs) : at(trim.startMs + trim.durationMs) - 1;
  return Math.max(0, Math.min(frame, storedFrames - 1));
}

/** The peek a trim drag holds, or null: its listeners hear each new one and its end. */
export class TrimPeekStore {
  #peek: TrimPeek | null = null;
  readonly #listeners = new Set<() => void>();

  /** The peek now: the same object until it changes (a React external store's snapshot). */
  readonly get = (): TrimPeek | null => this.#peek;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  set(peek: TrimPeek | null): void {
    const now = this.#peek;
    if (peek === null ? now === null : now !== null && now.clipId === peek.clipId && now.frame === peek.frame) return;
    this.#peek = peek;
    for (const listener of [...this.#listeners]) listener();
  }
}
