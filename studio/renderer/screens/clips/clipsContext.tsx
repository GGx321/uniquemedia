import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AvatarSummary, ClipBatchSummary, ClipSummary, CommandResult, EngineError, PhotoSummary } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { isActiveJob, type EngineStore, type EngineView, type JobView } from "../../engine/store";
import { viewerStorage } from "../photos/sceneReview";

// Stage 5, 5b.1, S5.V8: what the avatar's screen shares with its clips — the «Клипы» tab, the photo viewer's «Оживить» and the sheet. The clips are listed on demand (`clips.list`,
// plan s5b1 §5.2: no event of their own) and read again when a clip job of the avatar ends and when the export folder's state moves (every export is judged against it).

const DISMISSALS = new WeakMap<EngineStore, Set<string>>();
/** How many put-away «Клип не снят» tiles a window remembers (the oldest are forgotten first, as the store's dismissed imports are). */
export const MAX_DISMISSED_CLIP_JOBS = 200;

/** The failed clip jobs whose tile the owner put away, for the window's life: the job stays in the store's view for the session, so the tab (left and come back to, or another avatar between) must not bring its tile back. */
export function clipDismissals(store: EngineStore): ReadonlySet<string> {
  return DISMISSALS.get(store) ?? new Set();
}

/** Puts a failed clip job's tile away for good; bounded, the oldest forgotten first. */
export function dismissClipJob(store: EngineStore, jobId: string): void {
  let set = DISMISSALS.get(store);
  if (set === undefined) {
    set = new Set();
    DISMISSALS.set(store, set);
  }
  set.add(jobId);
  for (const old of set) {
    if (set.size <= MAX_DISMISSED_CLIP_JOBS) break;
    set.delete(old);
  }
}

/**
 * 5b.2 (S5.WB4b, review L10): the batch headers the owner closed (✕) are remembered on this machine, per batch id, so the next window does not bring a closed header back. A per-viewer convenience:
 * a storage that cannot be read or written (a private window, blocked site data) closes the header for this window only, and never throws.
 */
export const CLOSED_BATCHES_KEY = "studio.clips.closedBatches";
/** How many closed batches are remembered: the newest; an older one can only be a header nobody would show again anyway (the header is the newest batch's). */
export const MAX_CLOSED_BATCHES = 50;

/** The batch ids closed on this machine, oldest first; whatever else the key holds is ignored. */
function readClosed(storage: Pick<Storage, "getItem"> | null): string[] {
  if (storage === null) return [];
  try {
    const raw = storage.getItem(CLOSED_BATCHES_KEY);
    const parsed: unknown = raw === null ? [] : JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function closedBatches(storage: Pick<Storage, "getItem"> | null): ReadonlySet<string> {
  return new Set(readClosed(storage));
}

export function closeBatch(storage: Pick<Storage, "getItem" | "setItem"> | null, batchId: string): void {
  if (storage === null) return;
  const ids = [...readClosed(storage).filter((id) => id !== batchId), batchId].slice(-MAX_CLOSED_BATCHES);
  try {
    storage.setItem(CLOSED_BATCHES_KEY, JSON.stringify(ids));
  } catch {
    // Not kept on this machine: the window still remembers it (`dismissBatch`).
  }
}

const BATCH_DISMISSALS = new WeakMap<EngineStore, Set<string>>();

/** 5b.2 (60b–60f): the batches whose header the owner closed (✕): this window's own, and those closed on this machine before. */
export function batchDismissals(store: EngineStore): ReadonlySet<string> {
  return new Set([...(BATCH_DISMISSALS.get(store) ?? []), ...closedBatches(viewerStorage())]);
}

/** Puts a batch's header away, in this window and on this machine; the window's own set is bounded like the dismissed clip jobs, the oldest forgotten first. */
export function dismissBatch(store: EngineStore, batchId: string): void {
  let set = BATCH_DISMISSALS.get(store);
  if (set === undefined) {
    set = new Set();
    BATCH_DISMISSALS.set(store, set);
  }
  set.add(batchId);
  for (const old of set) {
    if (set.size <= MAX_DISMISSED_CLIP_JOBS) break;
    set.delete(old);
  }
  closeBatch(viewerStorage(), batchId);
}

/** Where a gallery photo stands in the pages read: its place newest first, and the gallery's size. */
export interface PhotoPlace {
  readonly photo: PhotoSummary;
  readonly position: number;
  readonly total: number;
  /** Its category as the gallery names it («Дом», «Ночнушки и бельё», a custom category's own name). */
  readonly label: string;
}

export interface ClipsControl {
  readonly avatar: AvatarSummary;
  readonly view: EngineView;
  readonly list: ClipList;
  /** A gallery photo by id, from the pages read; null when they do not hold it. */
  readonly photoInfo: (photoId: string) => PhotoPlace | null;
  /** Every page of the gallery is in: a photo it does not hold is gone. */
  readonly galleryComplete: boolean;
  /** A clip job this window started (a create from the sheet or a tile): tracked, and the «Клипы» tab shown. What its tile shows is the engine's own, told by the job. */
  readonly started: (jobId: string) => void;
  /** Show a photo in the «Фото» tab's viewer («Из фото»). */
  readonly showPhoto: (photoId: string) => void;
  /** 5b.2 (37e): «отмените оставшиеся» — the «Клипы» tab, where the batch's header has the button; the tab's heading takes the focus. */
  readonly showClips: () => void;
  /** 5b.2 (60e «Отметить их снова», 58 #again): «Фото» in «для клипов» with these photos picked, in this order. */
  readonly pickAgain: (photoIds: readonly string[]) => void;
}

const ClipsContext = createContext<ClipsControl | null>(null);

export const ClipsProvider = ClipsContext.Provider;

/** The avatar's clips control, or null outside an avatar's screen (the viewer then offers no «Оживить»). */
export function useClips(): ClipsControl | null {
  return useContext(ClipsContext);
}

export interface ClipList {
  /** Newest first; null until `clips.list` first answers. */
  readonly clips: readonly ClipSummary[] | null;
  /**
   * 5b.2 (S5.WB2c): the avatar's batch summaries as the engine wrote them, newest first; empty when it has none, null until `clips.list` first answers. A batch's header reads its members and its money from
   * here, never from the records (a deleted clip is not a member that was dropped unshot).
   */
  readonly batches: readonly ClipBatchSummary[] | null;
  readonly error: EngineError | null;
  /** The clip jobs (ids) that had ended when the list on show was asked for: a job that ended after that may not be listed yet. Null until the first answer. */
  readonly readEnded: ReadonlySet<string> | null;
  readonly reread: () => void;
}

type ClipListState = Omit<ClipList, "reread">;

/** What the window keeps of a `clips.list` answer: the clips, the engine's batch summaries (an answer without them is an avatar with none), and the jobs that had ended when it was asked for. */
export function clipListStateOf(result: CommandResult<"clips.list">, asked: ReadonlySet<string>): ClipListState {
  return { clips: result.clips, batches: result.batches ?? [], error: null, readEnded: asked };
}

/** The ended clip jobs of an avatar, as one key: a new end reads the list again. */
function endsOf(jobs: readonly JobView[], avatarId: string): string {
  return endedJobs(jobs, avatarId)
    .map((job) => `${job.jobId}:${job.status}`)
    .join("|");
}

function endedJobs(jobs: readonly JobView[], avatarId: string): JobView[] {
  return jobs.filter((job) => job.kind === "clip" && job.avatarId === avatarId && !isActiveJob(job));
}

/** The avatar's `clips.list`, read on open, after each clip job of the avatar ends, when the export folder's state moves, and on demand (a delete, a «новый» seen). */
export function useClipList(avatarId: string, view: EngineView): ClipList {
  const { client } = useEngine();
  const ready = view.phase === "ready";
  const ends = endsOf(view.jobs, avatarId);
  const exportKey = view.exportStatus === null ? "none" : view.exportStatus.status === "ok" ? "ok" : `unavailable:${view.exportStatus.reason}`;
  const [reread, setReread] = useState(0);
  const [state, setState] = useState<ClipListState>({ clips: null, batches: null, error: null, readEnded: null });
  // The jobs that had ended when a read began, kept in a ref so the read's effect reruns on the ends' key alone.
  const jobsRef = useRef(view.jobs);
  jobsRef.current = view.jobs;

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const asked = new Set(endedJobs(jobsRef.current, avatarId).map((job) => job.jobId));
    void client.request("clips.list", { avatarId }).then((reply) => {
      if (!alive) return;
      if (reply.ok) setState(clipListStateOf(reply.result, asked));
      else setState((now) => ({ ...now, error: reply.error }));
    });
    return () => {
      alive = false;
    };
  }, [ready, client, avatarId, ends, exportKey, reread]);

  return useMemo(() => ({ ...state, reread: () => setReread((n) => n + 1) }), [state]);
}

/** How many ready clips the owner has not opened yet: the «Клипы» tab's count (README §S5.VD decision 11). */
export function unseenCount(list: ClipList): number {
  return (list.clips ?? []).filter((clip) => clip.status === "ready" && !clip.seen).length;
}
