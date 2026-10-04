import type { EngineError, EventMessage, ImportResult, JobProgress, JobState, MediaKind } from "../../shared/engine";
import { percentOf } from "./renderJobs";

// The own-media import model (3f.6, K29): pure logic, no screen. An import is no avatar's job, so the store keeps it apart from `jobs`
// (`EngineView.imports`): from the snapshot, then from `job.progress` / `job.done` / `job.failed` / `job.cancelled` of kind `import`.
// The «Мои» tab's tiles and its status card (M6, M14) read an import from here.
//
// The engine branch (`feat/studio-mine-engine`) adds two OPTIONAL fields to an import's progress: `stage` ("copy" | "prepare"; absent
// means copy) and, while a video is prepared, `prepare: {hdrToSdr, fromFps}`. `done / total` count bytes in the copy and the importer's
// own units in prepare, so only the percent is ever shown. Both fields are read defensively (`importStageOf`, `prepareFactsOf`): the
// view works the same whether the contract carries them or not, and never trusts a value it does not recognise.

export type ImportStage = "copy" | "prepare";

/** What normalising an own video changes, as the engine says it while it prepares one (M14: «HDR → SDR, 60 → 30 fps»). */
export interface PrepareFacts {
  readonly hdrToSdr: boolean;
  /** The source's frame rate when the importer changes it to the montage's 30 fps; null when it does not say. */
  readonly fromFps: number | null;
}

export type ImportStatus = JobState["status"];

/** An own-media import as the window sees it. */
export interface ImportView {
  readonly jobId: string;
  /** What the bytes are (the engine read them): where the tab shows the import. */
  readonly mediaKind: MediaKind;
  /** The picked file's base name, for display only. */
  readonly name: string;
  readonly status: ImportStatus;
  readonly stage: ImportStage;
  readonly done: number;
  readonly total: number;
  /** While a video is prepared: what is changed; null otherwise, and when the engine does not say. */
  readonly prepare: PrepareFacts | null;
  /** The stored record's id once the import is done. */
  readonly mediaId: string | null;
  /** Why it failed (MEDIA_UNSUPPORTED carries its `mediaReason`). */
  readonly error: EngineError | null;
  /**
   * This window asked to cancel it (`media.cancelImport` answered). The mark stays after the end: an active import with it reads
   * «отменяем…», a cancelled one with it was the owner's own (nothing to tell), one without it was cancelled by the engine.
   */
  readonly cancelRequested: boolean;
}

export type ImportProgress = Extract<JobProgress, { kind: "import" }>;
export type ImportFailure = Extract<Extract<EventMessage, { type: "job.failed" }>["payload"], { kind: "import" }>;
export type ImportCancel = Extract<Extract<EventMessage, { type: "job.cancelled" }>["payload"], { kind: "import" }>;
export type ImportState = Extract<JobState, { kind: "import" }>;

/** The finished imports kept at most (the newest); the active ones are never dropped. */
export const MAX_FINISHED_IMPORTS = 50;

export function isActiveImport(view: Pick<ImportView, "status">): boolean {
  return view.status === "queued" || view.status === "running";
}

/** The stage an import's progress (or state) says: "prepare" only when it says exactly that; absent or anything else is the copy. */
export function importStageOf(progress: object): ImportStage {
  return "stage" in progress && progress.stage === "prepare" ? "prepare" : "copy";
}

/** The normalising facts a progress carries (`prepare`), or null when it carries none; a flag that is not `true` is false, a rate that is not a positive finite number is none. */
export function prepareFactsOf(progress: object): PrepareFacts | null {
  if (!("prepare" in progress)) return null;
  const facts: unknown = progress.prepare;
  if (typeof facts !== "object" || facts === null) return null;
  const hdrToSdr = "hdrToSdr" in facts && facts.hdrToSdr === true;
  const rate = "fromFps" in facts ? facts.fromFps : null;
  const fromFps = typeof rate === "number" && Number.isFinite(rate) && rate > 0 ? rate : null;
  return { hdrToSdr, fromFps };
}

/** «40 %»: floor of done over total; a done import is whole. */
export function importPercent(view: Pick<ImportView, "status" | "done" | "total">): number {
  return view.status === "done" ? 100 : percentOf(view.done, view.total);
}

function fresh(ref: { readonly jobId: string; readonly mediaKind: MediaKind; readonly name: string }): ImportView {
  return { jobId: ref.jobId, mediaKind: ref.mediaKind, name: ref.name, status: "queued", stage: "copy", done: 0, total: 0, prepare: null, mediaId: null, error: null, cancelRequested: false };
}

/** The finished imports beyond the newest `MAX_FINISHED_IMPORTS` are dropped, oldest first; the order of the rest is kept. */
function capFinished(imports: readonly ImportView[]): readonly ImportView[] {
  const finished = imports.filter((i) => !isActiveImport(i));
  if (finished.length <= MAX_FINISHED_IMPORTS) return imports;
  const drop = new Set(finished.slice(0, finished.length - MAX_FINISHED_IMPORTS).map((i) => i.jobId));
  return imports.filter((i) => !drop.has(i.jobId));
}

/** `patch` applied to the import `ref` names, created from that identity when this is the first the window hears of it (appended). */
function patchImport(imports: readonly ImportView[], ref: Parameters<typeof fresh>[0], patch: (view: ImportView) => ImportView): readonly ImportView[] {
  const at = imports.findIndex((i) => i.jobId === ref.jobId);
  const current = at < 0 ? fresh(ref) : imports[at];
  if (current === undefined) return imports;
  const next = patch(current);
  if (next === current && at >= 0) return imports;
  return capFinished(at < 0 ? [...imports, next] : imports.map((i, n) => (n === at ? next : i)));
}

/** A `job.progress` of an import: queued or running, its stage, its counts; a finished import is never brought back. */
export function applyImportProgress(imports: readonly ImportView[], progress: ImportProgress): readonly ImportView[] {
  const known = imports.find((i) => i.jobId === progress.jobId);
  if (known !== undefined && !isActiveImport(known)) return imports;
  const stage = importStageOf(progress);
  return patchImport(imports, progress, (view) => ({
    ...view,
    // A queued announcement is the job waiting for its turn; a job that already runs is never taken back.
    status: progress.queued === true && view.status !== "running" ? "queued" : "running",
    stage,
    done: progress.done,
    total: progress.total,
    prepare: stage === "prepare" ? prepareFactsOf(progress) : null,
  }));
}

/** A `job.done` of an import: its record's id, the whole bar. One first heard of here is made from its record. */
export function applyImportDone(imports: readonly ImportView[], jobId: string, result: ImportResult): readonly ImportView[] {
  const ref = { jobId, mediaKind: result.media.kind, name: result.media.name };
  return patchImport(imports, ref, (view) => ({ ...view, status: "done", mediaId: result.mediaId, total: view.total, done: view.total, error: null }));
}

/** A `job.failed` of an import: the engine's error is kept (MEDIA_UNSUPPORTED's `mediaReason` says why). */
export function applyImportFailed(imports: readonly ImportView[], failed: ImportFailure): readonly ImportView[] {
  return patchImport(imports, failed, (view) => (isActiveImport(view) ? { ...view, status: "failed", error: failed.error } : view));
}

/** A `job.cancelled` of an import: an active one ends cancelled; a finished one stays as it ended. */
export function applyImportCancelled(imports: readonly ImportView[], cancelled: ImportCancel): readonly ImportView[] {
  return patchImport(imports, cancelled, (view) => (isActiveImport(view) ? { ...view, status: "cancelled" } : view));
}

/** This window asked to cancel `jobId`: marked (for good). Nothing for a job that is not active here. */
export function markImportCancelling(imports: readonly ImportView[], jobId: string): readonly ImportView[] {
  const at = imports.findIndex((i) => i.jobId === jobId);
  const view = imports[at];
  if (view === undefined || !isActiveImport(view) || view.cancelRequested) return imports;
  return imports.map((i, n) => (n === at ? { ...view, cancelRequested: true } : i));
}

/** The engine is gone for good (no event will end anything): every active import fails with `error`. */
export function failActiveImports(imports: readonly ImportView[], error: EngineError): readonly ImportView[] {
  if (!imports.some(isActiveImport)) return imports;
  return imports.map((i) => (isActiveImport(i) ? { ...i, status: "failed", error } : i));
}

/**
 * The view after a snapshot: the engine's import jobs in its order, minus the ones the owner dismissed. A snapshot that does not say the
 * stage keeps a running import's prepare as this window last heard it (and its facts); this window's cancel mark is kept.
 */
export function importsFromSnapshot(previous: readonly ImportView[], states: readonly ImportState[], dismissed: ReadonlySet<string>): readonly ImportView[] {
  const before = new Map(previous.map((i) => [i.jobId, i]));
  const views = states
    .filter((state) => !dismissed.has(state.jobId))
    .map((state): ImportView => {
      const was = before.get(state.jobId);
      const active = state.status === "queued" || state.status === "running";
      const says = "stage" in state;
      const keepPrepare = !says && active && was !== undefined && was.stage === "prepare";
      const stage = keepPrepare ? "prepare" : importStageOf(state);
      return {
        jobId: state.jobId,
        mediaKind: state.mediaKind,
        name: state.name,
        status: state.status,
        stage,
        done: state.done,
        total: state.total,
        prepare: stage !== "prepare" ? null : keepPrepare ? (was?.prepare ?? null) : prepareFactsOf(state),
        mediaId: state.mediaId,
        error: state.error ?? null,
        cancelRequested: was?.cancelRequested === true,
      };
    });
  return capFinished(views);
}
