import { Focus, MontageDraft, MontageName, type Montage } from "../../../shared/engine";
import type { Scheduler } from "../../engine/scheduler";
import type { MontageChange } from "../../engine/store";
import { DraftAutosave, type FlushResult, type SaveState, type SendSave } from "./autosave";
import { cellsOf, fillFocus, fillOwnFocus } from "./clipOps";
import { canRedo, canUndo, commitVersion, type CommitOptions, type History, redoVersion, rewriteVersions, sealVersion, startHistory, undoVersion } from "./history";
import { sameJson } from "./json";

// One open draft in the editor (3d.2): the undo/redo history of its spec (at most 100 versions, renderer only)
// in front of the serialised autosave. Every task that edits the draft (the timeline 3d.3a/3d.3b, the preview
// 3d.4, the properties 3d.5) goes through `edit`, so each change is one undo step and is saved the same way.

export interface SessionState {
  /** The spec the window shows: the history's present. */
  readonly spec: MontageDraft;
  /** The draft's name; null shows «без названия». Not part of undo. */
  readonly name: string | null;
  readonly canUndo: boolean;
  readonly canRedo: boolean;
  readonly save: SaveState;
  /** The draft as the engine last answered it. */
  readonly saved: Montage;
}

/**
 * What `receive` did with a `montage.changed`:
 * - `own`: the echo of this window's save; nothing changes;
 * - `adopted`: a save from elsewhere, taken as the newest version (this window had nothing unsaved);
 * - `kept`: a save from elsewhere, left alone: this window's unsaved edit is saved after it and wins;
 * - `stale`: older than what the engine already answered (a re-read overtaken by this window's save); ignored;
 * - `removed`: this draft was deleted; the session saves nothing any more;
 * - `other`: another draft's change.
 */
export type Received = "own" | "adopted" | "kept" | "stale" | "removed" | "other";

export interface SessionOptions {
  readonly montage: Montage;
  readonly send: SendSave;
  readonly scheduler: Scheduler;
  readonly debounceMs?: number;
  readonly maxWaitMs?: number;
}

const sameSave = (a: SaveState, b: SaveState): boolean => a.kind === b.kind && (a.kind !== "failed" || (b.kind === "failed" && a.error === b.error));

/** One focus a save filled in: for a scene photo, or for an own photo (3f.6). */
type FocusFill = { readonly source: "scene" | "own"; readonly id: string; readonly focus: Focus };

const applyFill = (spec: MontageDraft, fill: FocusFill): MontageDraft => (fill.source === "scene" ? fillFocus(spec, fill.id, fill.focus) : fillOwnFocus(spec, fill.id, fill.focus));

/**
 * The focuses `remote` filled in, when filling them is ALL that tells it from `present` (each photo's focus, scene or own, null
 * here, found there); null when anything else differs, or nothing does.
 */
function focusFills(present: MontageDraft, remote: MontageDraft): FocusFill[] | null {
  const fills: FocusFill[] = [];
  for (const clip of remote.clips) {
    for (const cell of cellsOf(clip)) {
      if (cell.photo === null || cell.focus === null) continue;
      fills.push(cell.photo.source === "scene" ? { source: "scene", id: cell.photo.photoId, focus: cell.focus } : { source: "own", id: cell.photo.mediaId, focus: cell.focus });
    }
  }
  const filled = fills.reduce(applyFill, present);
  return filled !== present && sameJson(filled, remote) ? fills : null;
}

export class DraftSession {
  readonly #montageId: string;
  readonly #avatarId: string;
  readonly #autosave: DraftAutosave;
  #history: History<MontageDraft>;
  #state: SessionState;
  readonly #listeners = new Set<() => void>();

  constructor(options: SessionOptions) {
    this.#montageId = options.montage.montageId;
    this.#avatarId = options.montage.spec.avatarId;
    this.#autosave = new DraftAutosave(options);
    this.#history = startHistory(options.montage.spec);
    this.#state = this.#build();
    this.#autosave.subscribe(() => this.#refresh());
  }

  get montageId(): string {
    return this.#montageId;
  }

  get state(): SessionState {
    return this.#state;
  }

  subscribe(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  /**
   * `next` as the draft's new version, saved after the quiet spell. Refused (false, nothing changes) when it
   * breaks the draft contract or names another avatar, so no version the engine would refuse ever enters the
   * history, and once the draft is gone.
   */
  edit(next: MontageDraft, options: Pick<CommitOptions, "mergeKey"> = {}): boolean {
    if (this.#state.save.kind === "gone") return false;
    if (next.avatarId !== this.#avatarId || !MontageDraft.safeParse(next).success) return false;
    this.#history = commitVersion(this.#history, next, options);
    this.#push();
    return true;
  }

  /**
   * The face focus `montages.focus` found for a photo placed earlier (K6): written into every version that holds
   * the photo unresolved, past and undone ones too, so an undo or a redo never brings the photo back without it.
   * Not an undo step. True when the draft on screen changed (it is then saved like an edit).
   */
  fillFocus(photoId: string, focus: Focus): boolean {
    return this.#fillFocus({ source: "scene", id: photoId, focus });
  }

  /** `fillFocus` for an own photo placed from «Мои» (3f.6): the same rules, the own photo's cells. */
  fillOwnFocus(mediaId: string, focus: Focus): boolean {
    return this.#fillFocus({ source: "own", id: mediaId, focus });
  }

  #fillFocus(fill: FocusFill): boolean {
    if (this.#state.save.kind === "gone") return false;
    // The focus itself is checked first: it is written into undone versions too, which no later edit re-checks, so
    // the session never relies on the client having validated the engine's answer.
    if (!Focus.safeParse(fill.focus).success) return false;
    const before = this.#history.present;
    const next = rewriteVersions(this.#history, (spec) => applyFill(spec, fill));
    // Like an edit: a present the contract would refuse never enters.
    if (next === this.#history || !MontageDraft.safeParse(next.present).success) return false;
    this.#history = next;
    if (next.present === before) {
      this.#refresh();
      return false;
    }
    this.#push();
    return true;
  }

  /** The end of a gesture (pointerup): the next keyed edit is a new undo step even with the same `mergeKey`. */
  endMerge(): void {
    this.#history = sealVersion(this.#history);
  }

  undo(): boolean {
    if (!canUndo(this.#history) || this.#state.save.kind === "gone") return false;
    this.#history = undoVersion(this.#history);
    this.#push();
    return true;
  }

  redo(): boolean {
    if (!canRedo(this.#history) || this.#state.save.kind === "gone") return false;
    this.#history = redoVersion(this.#history);
    this.#push();
    return true;
  }

  /**
   * Renames the draft, saved at once (the owner confirmed it). Surrounding spaces are dropped and a blank name
   * clears it (the window then says «без названия»). False for a name the contract refuses.
   */
  rename(raw: string): boolean {
    const trimmed = raw.trim();
    const name = trimmed.length === 0 ? null : trimmed;
    if (name !== null && !MontageName.safeParse(name).success) return false;
    if (name === this.#autosave.content.name) return true;
    this.#autosave.set({ spec: this.#history.present, name }, { now: true });
    this.#refresh();
    return true;
  }

  /** A `montage.changed` as the store applied it. */
  receive(change: MontageChange): Received {
    if (change.change === "removed") {
      if (change.montageId !== this.#montageId) return "other";
      this.#autosave.markGone();
      return "removed";
    }
    const { montage } = change;
    if (montage.montageId !== this.#montageId) return "other";
    if (this.#autosave.isOwnEcho(montage)) return "own";
    if (this.#autosave.isStale(montage)) return "stale";
    if (!this.#autosave.adoptRemote(montage)) {
      // Not adopted, but it is what the engine holds now: this window's unsaved edit is measured against it.
      this.#autosave.noteKept(montage);
      this.#refresh();
      return "kept";
    }
    // A save that only filled in face focuses (another window's `montages.focus` answers) is written into every version,
    // as this window's own would be: never an undo step that ⌘Z here would silently take back.
    const fills = focusFills(this.#history.present, montage.spec);
    this.#history = fills === null ? commitVersion(this.#history, montage.spec) : rewriteVersions(this.#history, (spec) => fills.reduce(applyFill, spec));
    this.#refresh();
    return "adopted";
  }

  /** Saves whatever is unsaved now; «Рендер» and leaving the editor wait for it. */
  flush(): Promise<FlushResult> {
    return this.#autosave.flush();
  }

  retry(): void {
    this.#autosave.retry();
  }

  /** The editor is closing: flush, then take no more edits. */
  close(): Promise<FlushResult> {
    return this.#autosave.close();
  }

  /** The history's present goes to the autosave with the current name. */
  #push(): void {
    this.#autosave.set({ spec: this.#history.present, name: this.#autosave.content.name });
    this.#refresh();
  }

  #build(): SessionState {
    return {
      spec: this.#history.present,
      name: this.#autosave.content.name,
      canUndo: canUndo(this.#history),
      canRedo: canRedo(this.#history),
      save: this.#autosave.state,
      saved: this.#autosave.saved,
    };
  }

  /** A new state object only when something in it changed, so React re-renders exactly then. */
  #refresh(): void {
    const next = this.#build();
    const prev = this.#state;
    const same =
      prev.spec === next.spec &&
      prev.name === next.name &&
      prev.canUndo === next.canUndo &&
      prev.canRedo === next.canRedo &&
      prev.saved === next.saved &&
      sameSave(prev.save, next.save);
    if (same) return;
    this.#state = next;
    for (const listener of [...this.#listeners]) listener();
  }
}
