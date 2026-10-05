import { createContext, useContext } from "react";
import type { MediaTab } from "./MediaPanel";
import type { Selection } from "./selection";
import type { DraftSession } from "./session";

// Slice review 5-M2: the editors that closed in this window, kept by draft. The editor itself sends the owner elsewhere (Settings, for the
// trending list's refresh, the export folder, an error's link); coming back to the same draft must not cost its undo history or the place the
// owner was at. An editor leaves its session and its place here as it unmounts; the next editor of that draft in this window takes them up. One
// per window (App provides it), next to `DraftFlushes`, which holds the save each closing editor sends on its way out.
//
// Only a session with nothing left to save goes on: one whose last edit was refused (and left behind) or whose draft was deleted is let go, and the
// draft opens as Studio holds it. The engine's copy is still read on the reopen and goes through the session's echo / adopt rules, so a save made
// elsewhere meanwhile is taken on top of the history, as it is while the editor is open.

/** How many closed editors a window keeps: the ones left longest ago go first. */
export const KEPT_DRAFTS = 8;

/** Where the owner was in an editor: the media tab, the selection, the playhead and the timeline's zoom. */
export interface EditorPlace {
  readonly tab: MediaTab;
  readonly selection: Selection | null;
  readonly playheadMs: number;
  readonly zoom: number;
}

export interface KeptDraft {
  readonly session: DraftSession;
  readonly place: EditorPlace;
}

/** Whether a kept session can go on: everything in it was saved (nothing on its way, nothing refused, the draft not deleted). */
const resumable = (kept: KeptDraft): boolean => kept.session.state.save.kind === "saved";

export class DraftSessions {
  /** In the order they were left, oldest first. */
  readonly #kept = new Map<string, KeptDraft>();

  /** The editor of `montageId` closed: its session and place are kept, as the newest; the oldest goes beyond `KEPT_DRAFTS`. */
  keep(montageId: string, kept: KeptDraft): void {
    this.#kept.delete(montageId);
    this.#kept.set(montageId, kept);
    for (const oldest of this.#kept.keys()) {
      if (this.#kept.size <= KEPT_DRAFTS) break;
      this.#kept.delete(oldest);
    }
  }

  /**
   * The kept editor of `montageId` when its session can go on; null otherwise (and one that cannot is let go). Not used up: an editor that
   * mounts twice (React's StrictMode) finds the same one.
   */
  resume(montageId: string): KeptDraft | null {
    const kept = this.#kept.get(montageId);
    if (kept === undefined) return null;
    if (resumable(kept)) return kept;
    this.#kept.delete(montageId);
    return null;
  }

  /** What `resume` would answer, without letting anything go: Settings reads the draft's title from it. */
  peek(montageId: string): KeptDraft | null {
    const kept = this.#kept.get(montageId);
    return kept !== undefined && resumable(kept) ? kept : null;
  }

  /** Drops the kept editor of `montageId`: the draft opens as Studio holds it (its last edit was lost), or it is gone. */
  forget(montageId: string): void {
    this.#kept.delete(montageId);
  }
}

const DraftSessionsContext = createContext<DraftSessions | null>(null);

export const DraftSessionsProvider = DraftSessionsContext.Provider;

export function useDraftSessions(): DraftSessions {
  const sessions = useContext(DraftSessionsContext);
  if (!sessions) throw new Error("useDraftSessions must be used inside <DraftSessionsProvider>");
  return sessions;
}
