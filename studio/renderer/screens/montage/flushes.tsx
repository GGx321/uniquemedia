import { createContext, useContext } from "react";
import type { EngineError } from "../../../shared/engine";
import type { FlushResult } from "./autosave";

// The saves still on their way from editors that closed (3d.2 review, open question (b)). An editor sends its
// unsaved edit as it unmounts; opening the same draft again must read it only once that save answered, and a save
// that failed then is told on the reopen instead of vanishing. One per window (App provides it).

export class DraftFlushes {
  readonly #pending = new Map<string, Promise<FlushResult>>();
  readonly #lost = new Map<string, EngineError>();

  /** The flush of an editor of `montageId` that is closing; a newer one of the same draft replaces it. */
  track(montageId: string, flush: Promise<FlushResult>): void {
    this.#pending.set(montageId, flush);
    void flush.then((result) => {
      if (this.#pending.get(montageId) !== flush) return;
      this.#pending.delete(montageId);
      // A deleted draft lost nothing that could be reopened.
      if (!result.ok && result.error.code !== "NOT_FOUND") this.#lost.set(montageId, result.error);
      else this.#lost.delete(montageId);
    });
  }

  /** Waits for the draft's pending flush, if any; answers (once) why its last edit was not saved, or null. */
  async settle(montageId: string): Promise<EngineError | null> {
    for (let pending = this.#pending.get(montageId); pending !== undefined; pending = this.#pending.get(montageId)) {
      await pending;
      // Let `track`'s own continuation record the outcome before it is read.
      await Promise.resolve();
    }
    const lost = this.#lost.get(montageId) ?? null;
    this.#lost.delete(montageId);
    return lost;
  }
}

const DraftFlushesContext = createContext<DraftFlushes | null>(null);

export const DraftFlushesProvider = DraftFlushesContext.Provider;

export function useDraftFlushes(): DraftFlushes {
  const flushes = useContext(DraftFlushesContext);
  if (!flushes) throw new Error("useDraftFlushes must be used inside <DraftFlushesProvider>");
  return flushes;
}
