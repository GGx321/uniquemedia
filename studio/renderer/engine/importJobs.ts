import type { EngineError, EventMessage, ImportPrepare, ImportResult, ImportStage, JobProgress, JobState, MediaKind } from "../../shared/engine";

// The own-media import model (3f.6, K29): pure logic, no screen. An import is no avatar's job, so the store keeps it apart from `jobs`
// (`EngineView.imports`): from the snapshot, then from `job.progress` / `job.done` / `job.failed` / `job.cancelled` of kind `import`.
// The «Мои» tab's tiles and its status card (M6, M14) read an import from here.
//
// An import's progress says its `stage` (the contract's `ImportStage`: absent is the copy) and, while a video is prepared, what the probe judged
// (`ImportPrepare`, «HDR → SDR, 60 → 30 fps»). `done / total` count bytes in the copy and the importer's own units in prepare, from zero again:
// the window shows one bar over both stages (`importPercent`), which never goes back.

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
  /** While a video is prepared: what the probe judged it changes; null otherwise, and until the probe has judged. */
  readonly prepare: ImportPrepare | null;
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

/**
 * The share of the bar the copy fills (round 2, L8): the copy runs 0 to 30, the prepare 30 to 99, the end 100. The two stages count different units
 * from zero each, so a bar of either alone would fall back from full to empty at the move; one bar over both never goes back. The prepare's last
 * unit is the job's own end (the contract), so a job still working never reads 100.
 */
export const COPY_SHARE = 30;

/** «40 %»: the import's place on one bar over its copy and its prepare; a done import is whole. */
export function importPercent(view: Pick<ImportView, "status" | "stage" | "done" | "total">): number {
  if (view.status === "done") return 100;
  const part = (share: number): number => (view.total > 0 ? Math.floor((Math.min(view.done, view.total) * share) / view.total) : 0);
  return view.stage === "prepare" ? Math.min(99, COPY_SHARE + part(100 - COPY_SHARE)) : part(COPY_SHARE);
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
  const stage = progress.stage ?? "copy";
  return patchImport(imports, progress, (view) => ({
    ...view,
    // A queued announcement is the job waiting for its turn; a job that already runs is never taken back.
    status: progress.queued === true && view.status !== "running" ? "queued" : "running",
    stage,
    done: progress.done,
    total: progress.total,
    prepare: stage === "prepare" ? (progress.prepare ?? null) : null,
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

/** An import a cancel can still be the owner's: running, waiting, or already cancelled (its end may beat the cancel's answer). */
const cancellable = (view: ImportView): boolean => isActiveImport(view) || view.status === "cancelled";

/**
 * This window asked to cancel `jobId`: marked (for good). An import already cancelled is marked too: the engine's `job.cancelled` may land before
 * the cancel's answer (round 1, L1), and it is still the owner's own cancel. Nothing for an import that is done or failed, or not here.
 */
export function markImportCancelling(imports: readonly ImportView[], jobId: string): readonly ImportView[] {
  const at = imports.findIndex((i) => i.jobId === jobId);
  const view = imports[at];
  if (view === undefined || !cancellable(view) || view.cancelRequested) return imports;
  return imports.map((i, n) => (n === at ? { ...view, cancelRequested: true } : i));
}

/** The engine refused the cancel: the import goes on, and is not the owner's cancel any more. */
export function unmarkImportCancelling(imports: readonly ImportView[], jobId: string): readonly ImportView[] {
  const at = imports.findIndex((i) => i.jobId === jobId);
  const view = imports[at];
  if (view === undefined || !view.cancelRequested) return imports;
  return imports.map((i, n) => (n === at ? { ...view, cancelRequested: false } : i));
}

/** The cancels this window asked for, put back on the imports they name (one first heard of after the ask, by an event or a snapshot). */
export function applyCancelAsks(imports: readonly ImportView[], asked: ReadonlySet<string>): readonly ImportView[] {
  if (asked.size === 0 || !imports.some((i) => asked.has(i.jobId) && !i.cancelRequested && cancellable(i))) return imports;
  return imports.map((i) => (asked.has(i.jobId) && !i.cancelRequested && cancellable(i) ? { ...i, cancelRequested: true } : i));
}

/** The engine is gone for good (no event will end anything): every active import fails with `error`. */
export function failActiveImports(imports: readonly ImportView[], error: EngineError): readonly ImportView[] {
  if (!imports.some(isActiveImport)) return imports;
  return imports.map((i) => (isActiveImport(i) ? { ...i, status: "failed", error } : i));
}

/**
 * The view after a snapshot: the engine's import jobs in its order (each with the stage and what was judged as the snapshot says them), minus the
 * ones the owner dismissed; this window's cancel asks (`asked`) are put on the jobs they name.
 */
export function importsFromSnapshot(states: readonly ImportState[], dismissed: ReadonlySet<string>, asked: ReadonlySet<string> = new Set()): readonly ImportView[] {
  const views = states
    .filter((state) => !dismissed.has(state.jobId))
    .map((state): ImportView => {
      const stage = state.stage ?? "copy";
      return {
        jobId: state.jobId,
        mediaKind: state.mediaKind,
        name: state.name,
        status: state.status,
        stage,
        done: state.done,
        total: state.total,
        prepare: stage === "prepare" ? (state.prepare ?? null) : null,
        mediaId: state.mediaId,
        error: state.error ?? null,
        cancelRequested: asked.has(state.jobId) && (state.status === "queued" || state.status === "running" || state.status === "cancelled"),
      };
    });
  return capFinished(views);
}
