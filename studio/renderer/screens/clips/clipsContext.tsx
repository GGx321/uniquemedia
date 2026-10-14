import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import type { AvatarSummary, ClipSummary, EngineError, PhotoSummary } from "../../../shared/engine";
import { useEngine } from "../../engine/react";
import { isActiveJob, type EngineStore, type EngineView, type JobView } from "../../engine/store";

// Stage 5, 5b.1, S5.V8: what the avatar's screen shares with its clips — the «Клипы» tab, the photo viewer's «Оживить» and the sheet. The clips are listed on demand (`clips.list`,
// plan s5b1 §5.2: no event of their own) and read again when a clip job of the avatar ends and when the export folder's state moves (every export is judged against it).

/** What this window knows of a clip it started (the sheet's choice), by the clip's id: a running tile names its motion and its photo, and its money line what may still go. */
export interface ClipIntent {
  readonly clipId: string;
  readonly avatarId: string;
  readonly photoId: string;
  readonly motionLabel: string;
  /** `grok`: started by «Снять на Grok» (the offer's clip), so Grok is not a fallback behind a refusal. */
  readonly requestModel: "kling" | "grok";
  readonly seconds: 5 | 10;
  /** The accepted worst, the engine's figure the click sent. */
  readonly acceptedWorstMicros: number;
  /** The reserve of each model's attempt (the engine's estimates of Kling alone and of Grok, from the same `clips.options`): what a late attempt holds open. */
  readonly klingWorstMicros: number;
  readonly grokWorstMicros: number;
}

const INTENTS = new WeakMap<EngineStore, Map<string, ClipIntent>>();

/** The intents of this window's store: kept for the window's life, so a screen left and come back to (or a restart's recovery of the same clip) still knows them. */
export function clipIntents(store: EngineStore): Map<string, ClipIntent> {
  let intents = INTENTS.get(store);
  if (intents === undefined) {
    intents = new Map();
    INTENTS.set(store, intents);
  }
  return intents;
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
  /** A clip job this window started (a create from the sheet or a tile): tracked, remembered, and the «Клипы» tab shown. */
  readonly started: (jobId: string, intent: ClipIntent) => void;
  /** Show a photo in the «Фото» tab's viewer («Из фото»). */
  readonly showPhoto: (photoId: string) => void;
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
  readonly error: EngineError | null;
  /** The clip jobs (ids) that had ended when the list on show was asked for: a job that ended after that may not be listed yet. Null until the first answer. */
  readonly readEnded: ReadonlySet<string> | null;
  readonly reread: () => void;
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
  const [state, setState] = useState<{ clips: readonly ClipSummary[] | null; error: EngineError | null; readEnded: ReadonlySet<string> | null }>({ clips: null, error: null, readEnded: null });
  // The jobs that had ended when a read began, kept in a ref so the read's effect reruns on the ends' key alone.
  const jobsRef = useRef(view.jobs);
  jobsRef.current = view.jobs;

  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const asked = new Set(endedJobs(jobsRef.current, avatarId).map((job) => job.jobId));
    void client.request("clips.list", { avatarId }).then((reply) => {
      if (!alive) return;
      if (reply.ok) setState({ clips: reply.result.clips, error: null, readEnded: asked });
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
