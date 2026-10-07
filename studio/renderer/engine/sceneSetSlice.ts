import type { EngineError, Estimate, PoolShot, SceneSetView } from "../../shared/engine";
import type { EngineClient } from "./client";
import type { EngineStore, SceneSetSignal, SceneSetStoreChange } from "./store";

// CS.6: the window's scene set slice, built on the store's scene set listeners (CS.4a). One per window (the engine provider owns it), so what a Photos
// screen started outlives the screen. It holds:
// - each shown avatar's set (`scenes.get`: its open set, else its newest used one), asked when a screen first retains the avatar, again after a snapshot
//   taken again (the store's `resynced`: a gap, a restarted engine, a library switch), after a removal (a used set may be what is left) and after a reconcile
//   (which changes what a set spent with no event of its own); kept current by `scenes.changed` in seq order and by the answers of the free edits;
// - what only this window knows: the price it accepted for a scenes job it started (the task line's «≈ … · до …»; the contract carries no price for a live
//   write), the scenes its own rewrites replaced («новая»; the view keeps no such mark), an open reserve it saw a reconcile close (the notices' «закрыт
//   при сверке»), and the «Готово … не составлены» notices the owner closed.

export type SceneSetEntry =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly error: EngineError }
  | { readonly status: "ready"; readonly sceneSet: SceneSetView | null; readonly unreadable: number };

/** A scenes job this window started: what it writes and the price its click accepted. */
export interface SceneJobNote {
  readonly sceneSetId: string;
  readonly kind: "compose" | "unwritten" | "rewrite" | "idea" | "resume";
  /** Null when the click accepted no price this window can tell (none is shown then). */
  readonly price: Estimate | null;
  /** A rewrite's scenes. */
  readonly sceneIds: readonly number[] | null;
  /** An idea write's request, for its placeholders and, if it fails for good, the form opened again with it. */
  readonly idea: { readonly idea: string; readonly count: number; readonly shot: PoolShot | null } | null;
}

export interface SceneSetSliceView {
  /** By avatar: only the avatars a screen showed. */
  readonly sets: ReadonlyMap<string, SceneSetEntry>;
  /** By job id. */
  readonly jobs: ReadonlyMap<string, SceneJobNote>;
  /** By set: the scenes this window's rewrites replaced. */
  readonly fresh: ReadonlyMap<string, ReadonlySet<number>>;
  /** By set: the open reserve this window saw, now closed by a reconcile. */
  readonly reconciled: ReadonlyMap<string, number>;
  /** The sets whose «Готово … не составлены» the owner closed. */
  readonly dismissed: ReadonlySet<string>;
  /** The jobs this window started from the generate card, whose «Отменить» is to take the focus once the column shows it (README «Keyboard and focus»). */
  readonly cancelFocus: ReadonlySet<string>;
}

const INITIAL: SceneSetSliceView = { sets: new Map(), jobs: new Map(), fresh: new Map(), reconciled: new Map(), dismissed: new Set(), cancelFocus: new Set() };

/** Which of two views of one avatar's set to show: a set it did not show before wins; the same set, its newer revision. */
function newer(current: SceneSetView | null, incoming: SceneSetView): boolean {
  return current === null || current.sceneSetId !== incoming.sceneSetId || incoming.revision >= current.revision;
}

export class SceneSetSlice {
  #view: SceneSetSliceView = INITIAL;
  readonly #listeners = new Set<() => void>();
  /** How many screens show each avatar. */
  readonly #retained = new Map<string, number>();
  /** The reads on their way, by avatar: their generation, and the changes heard meanwhile (applied to their answer). */
  readonly #reading = new Map<string, { generation: number; early: SceneSetStoreChange[] }>();
  #generation = 0;
  /** The open reserve last seen on each set. */
  readonly #lastOpen = new Map<string, number>();
  /** The jobs whose end was already read (a rewrite's «новая» is marked once). */
  readonly #ended = new Set<string>();
  #reconcileNeeded: boolean | null = null;
  #stop: (() => void) | null = null;

  constructor(
    private readonly client: Pick<EngineClient, "request">,
    private readonly store: Pick<EngineStore, "getView" | "subscribe" | "subscribeSceneSets">,
  ) {}

  // ---------- React glue (useSyncExternalStore) ----------

  readonly getView = (): SceneSetSliceView => this.#view;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  };

  // ---------- lifecycle ----------

  /** Follows the store: `scenes.changed`, a snapshot taken again, a reconcile, and the ends of the jobs this window started. */
  start(): () => void {
    this.#stop?.();
    const stopSets = this.store.subscribeSceneSets((signal) => this.#onSignal(signal));
    const stopView = this.store.subscribe(() => this.#onStore());
    this.#onStore();
    this.#stop = () => {
      stopSets();
      stopView();
    };
    return () => {
      this.#stop?.();
      this.#stop = null;
    };
  }

  /** A screen shows `avatarId`'s set: the first one has it read. Returns its release. */
  retain(avatarId: string): () => void {
    const count = this.#retained.get(avatarId) ?? 0;
    this.#retained.set(avatarId, count + 1);
    if (count === 0) {
      if (!this.#view.sets.has(avatarId)) this.#setEntry(avatarId, { status: "loading" });
      this.#read(avatarId);
    }
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const left = (this.#retained.get(avatarId) ?? 1) - 1;
      if (left > 0) this.#retained.set(avatarId, left);
      else this.#retained.delete(avatarId);
    };
  }

  /** Reads the set again (a retry, or a refusal that says it moved), keeping what is shown meanwhile. */
  reload(avatarId: string): void {
    const entry = this.#view.sets.get(avatarId);
    if (entry?.status === "failed") this.#setEntry(avatarId, { status: "loading" });
    this.#read(avatarId);
  }

  /** A free edit's answer: shown at once, unless a newer revision of the set is already on show. */
  apply(sceneSet: SceneSetView): void {
    const entry = this.#view.sets.get(sceneSet.avatarId);
    if (entry === undefined) return;
    const current = entry.status === "ready" ? entry.sceneSet : null;
    if (current !== null && current.sceneSetId === sceneSet.sceneSetId && sceneSet.revision <= current.revision) return;
    this.#show(sceneSet.avatarId, sceneSet, entry.status === "ready" ? entry.unreadable : 0);
  }

  /** A scenes job this window just started, with what its click accepted. */
  trackJob(jobId: string, note: SceneJobNote): void {
    this.#update({ jobs: new Map(this.#view.jobs).set(jobId, note) });
    this.#onStore();
  }

  /** The focus is to go to the job's «Отменить» (the card's «Дописать» started it, and the cancel button lives in the column). */
  requestCancelFocus(jobId: string): void {
    if (this.#view.cancelFocus.has(jobId)) return;
    this.#update({ cancelFocus: new Set(this.#view.cancelFocus).add(jobId) });
  }

  /** The column took that request (it moves the focus once): asked for again only by a new job. */
  cancelFocusTaken(jobId: string): void {
    if (!this.#view.cancelFocus.has(jobId)) return;
    const next = new Set(this.#view.cancelFocus);
    next.delete(jobId);
    this.#update({ cancelFocus: next });
  }

  /** «×» on «Готово … не составлены»: closed for that set (the header's counter stays). */
  dismissGaveUp(sceneSetId: string): void {
    if (this.#view.dismissed.has(sceneSetId)) return;
    this.#update({ dismissed: new Set(this.#view.dismissed).add(sceneSetId) });
  }

  // ---------- internals ----------

  #onSignal(signal: SceneSetSignal): void {
    if (signal.change === "resynced") {
      for (const avatarId of this.#retained.keys()) this.#read(avatarId);
      // An avatar no screen shows any more is read afresh when one does.
      this.#forgetUnretained();
      return;
    }
    const avatarId = signal.change === "upserted" ? signal.sceneSet.avatarId : signal.avatarId;
    const reading = this.#reading.get(avatarId);
    if (reading !== undefined) reading.early.push(signal);
    this.#change(avatarId, signal);
  }

  #change(avatarId: string, change: SceneSetStoreChange): void {
    const entry = this.#view.sets.get(avatarId);
    if (entry === undefined || entry.status !== "ready") return;
    if (change.change === "upserted") {
      if (newer(entry.sceneSet, change.sceneSet)) this.#show(avatarId, change.sceneSet, entry.unreadable);
      return;
    }
    if (entry.sceneSet?.sceneSetId !== change.sceneSetId) return;
    // Gone (discarded, or its avatar deleted): dropped at once, and read again — the avatar's newest used set, if any, is what is left.
    this.#show(avatarId, null, entry.unreadable);
    if (this.#retained.has(avatarId)) this.#read(avatarId);
  }

  #read(avatarId: string): void {
    const generation = ++this.#generation;
    this.#reading.set(avatarId, { generation, early: [] });
    void this.client.request("scenes.get", { avatarId }).then((reply) => {
      const reading = this.#reading.get(avatarId);
      if (reading === undefined || reading.generation !== generation) return;
      this.#reading.delete(avatarId);
      if (!reply.ok) {
        const entry = this.#view.sets.get(avatarId);
        // A failed read again keeps the set on show; only a first one says so.
        if (entry === undefined || entry.status !== "ready") this.#setEntry(avatarId, { status: "failed", error: reply.error });
        return;
      }
      // The answer as it is, then the changes heard while it was on its way (they may be newer than it).
      this.#show(avatarId, reply.result.sceneSet, reply.result.unreadable);
      for (const change of reading.early) this.#change(avatarId, change);
    });
  }

  /** Puts `sceneSet` on show for the avatar. */
  #show(avatarId: string, sceneSet: SceneSetView | null, unreadable: number): void {
    if (sceneSet !== null) this.#remember(sceneSet);
    this.#setEntry(avatarId, { status: "ready", sceneSet, unreadable });
  }

  /** The reserve a set had open, and the reconcile that closed it. */
  #remember(set: SceneSetView): void {
    const open = set.openReserveMicros;
    if (open === null) return;
    const id = set.sceneSetId;
    if (open > 0) {
      this.#lastOpen.set(id, open);
      if (this.#view.reconciled.has(id)) {
        const reconciled = new Map(this.#view.reconciled);
        reconciled.delete(id);
        this.#update({ reconciled });
      }
      return;
    }
    const seen = this.#lastOpen.get(id);
    if (seen !== undefined) {
      this.#lastOpen.delete(id);
      this.#update({ reconciled: new Map(this.#view.reconciled).set(id, seen) });
    }
  }

  #onStore(): void {
    const view = this.store.getView();
    // A reconcile closes reserves with no `scenes.changed`: what each set spent is read again.
    const needed = view.money === null ? null : view.money.reconcileNeeded;
    if (this.#reconcileNeeded !== null && needed !== null && needed !== this.#reconcileNeeded) for (const avatarId of this.#retained.keys()) this.#read(avatarId);
    if (needed !== null) this.#reconcileNeeded = needed;
    // A rewrite of this window that ended done: its scenes are «новая».
    for (const [jobId, note] of this.#view.jobs) {
      if (note.kind !== "rewrite" || note.sceneIds === null || this.#ended.has(jobId)) continue;
      const job = view.jobs.find((j) => j.jobId === jobId);
      if (job === undefined || (job.status !== "done" && job.status !== "failed" && job.status !== "cancelled")) continue;
      this.#ended.add(jobId);
      if (job.status !== "done") continue;
      const fresh = new Set(this.#view.fresh.get(note.sceneSetId) ?? []);
      for (const sceneId of note.sceneIds) fresh.add(sceneId);
      this.#update({ fresh: new Map(this.#view.fresh).set(note.sceneSetId, fresh) });
    }
  }

  #forgetUnretained(): void {
    const sets = new Map(this.#view.sets);
    let changed = false;
    for (const avatarId of sets.keys()) {
      if (this.#retained.has(avatarId)) continue;
      sets.delete(avatarId);
      changed = true;
    }
    if (changed) this.#update({ sets });
  }

  #setEntry(avatarId: string, entry: SceneSetEntry): void {
    this.#update({ sets: new Map(this.#view.sets).set(avatarId, entry) });
  }

  #update(patch: Partial<SceneSetSliceView>): void {
    this.#view = { ...this.#view, ...patch };
    for (const listener of [...this.#listeners]) listener();
  }
}
