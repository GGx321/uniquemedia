import type { FileState, VideoSummary, CommandPayload, EngineError, UnsequencedEvent } from "../../shared/engine";
import { MAX_LISTED_VIDEOS, PROTOCOL_VERSION } from "../../shared/engine";
import { MAX_MONTAGE_ISSUES, montageIssues, type MontageDraft, type MontageIssue } from "../../shared/engine/montage";
import { estimateBytesUpper } from "../../shared/montage";
import { EngineFailure } from "../engineFailure";
import { safeName } from "../exportName";
import type { ExportRootCheck } from "../exportRoot";
import type { FocusResolver } from "../focus/focusResolver";
import { LibraryError, type Library } from "../library";
import type { PhotoSource } from "../render";
import type { RenderQueue, RenderQueueEvent } from "../renderQueue/queue";
import { sweepRenderTmp } from "../renderQueue/sweep";
import type { CommitFs } from "./commitFs";
import { deleteVideo, VideoDiskError, VideoNotFoundError, VideoRecordUnreadableError } from "./delete";
import { createRenderExecute, totalFramesOf, type RenderPlan, type VideoRenderDeps } from "./execute";
import { newHashBudget, type FileStateChecker } from "./fileState";
import { readVideoRecordFile, readVideoRecordFiles, videoSummaryOf } from "./listing";
import type { CommitTracker } from "./live";
import { scenePhotoIds, type VideoRecord } from "./record";
import { recoverVideos, type ExportRootRef, type RecoverDeps } from "./recovery";

// The command layer of the video pipeline (Stage 3 plan, 3a.8b.2): `videos.render`, `videos.cancel`, `videos.list` and
// `videos.delete`, the render queue's events as the contract's `job.*` and `video.changed`, and what happens around a
// library opening (recovery) and the engine stopping. The engine wires it; every disk, the queue, the focus resolver
// and the export check come in as dependencies, so each mapping is tested with a fake.
//
// `videos.render` is ONE step before `submit`, and nothing is claimed, reserved or written until `submit` answers ok:
//   1. the spec's structure and N9 (pure);           2. the avatar;
//   3. the export folder, checked afresh (invariant 35), its marker's id going into the plan;
//   4. eligibility and used (invariant 18) through the library's own refusal-aware function, BEFORE any focus work;
//   5. the focus is filled, under a budget;          6. eligibility again, synchronously, then the photos' files and
//      stored sizes, then `submit`, with no await between them: a photo rejected or taken while the focus was being
//      computed is caught, and the reservation `submit` makes closes the window for the next render.
// The whole step runs as a counted write on the library (`withLibrary`), so a library switch waits for it.

/** Renders the queue holds and the window may be told about; see `RenderQueueEvent`. */
export type VideoQueue = Pick<RenderQueue, "submit" | "cancel" | "states" | "idle">;

export interface VideoServiceDeps {
  readonly queue: VideoQueue;
  /** The live commits: the SAME instance every render's `execute` registers in, and recovery reads. */
  readonly tracker: CommitTracker;
  readonly checker: FileStateChecker;
  /** Runs `work` with the live library, counted as a write so a library switch cannot land inside it; throws the engine's own refusal (LIBRARY_UNAVAILABLE, IN_FLIGHT) when there is none. */
  readonly withLibrary: <T>(work: (library: Library) => Promise<T>) => Promise<T>;
  /** The open library, unchecked (reads only); null when none. */
  readonly openLibrary: () => Library | null;
  /** A FRESH check of the export folder (its marker read now, never a snapshot). With `requiredBytes` it also wants twice that free. Never rejects. */
  readonly checkExport: (requiredBytes?: number) => Promise<ExportRootCheck>;
  readonly caseProbe: { isCaseInsensitive(root: string): Promise<boolean> };
  /** The focus resolver of `library`, whose `fillMissingFocus` has its own budget. */
  readonly focus: (library: Library) => Pick<FocusResolver, "fillMissingFocus">;
  /** `userData/render-tmp`; a render is refused without it (no `os.tmpdir` fallback). */
  readonly renderTmpDir: string | undefined;
  readonly newId: () => string;
  readonly now: () => Date;
  readonly emit: (event: UnsequencedEvent) => void;
  /** Codes, ids and counts only: never a path, a message or a file's text. */
  readonly log: (line: string) => void;
  readonly fs?: CommitFs;
  /** Test seams of the render itself (ffmpeg, the verifier, the commit's steps, its deadline). */
  readonly renderOverrides?: Partial<Pick<VideoRenderDeps, "fs" | "folderFs" | "runJob" | "runDeps" | "verify" | "hooks" | "claimStartAt" | "commitDeadlineMs" | "createTemp">>;
  readonly recover?: { readonly run?: typeof recoverVideos; readonly deps?: RecoverDeps };
  /** Waits before each background retry of a stale used index; 2 s, 10 s, 60 s when absent. */
  readonly staleRetryDelaysMs?: readonly number[];
}

const DEFAULT_STALE_RETRY_DELAYS_MS: readonly number[] = [2_000, 10_000, 60_000];

// ---------- pure parts ----------

/** The kind token of the file name: `photo` for photo clips only, a collage's layout when every clip is a collage of it, else `mix`. */
export function videoKindOf(clips: readonly { readonly kind: string; readonly layout?: string }[]): string {
  if (clips.every((clip) => clip.kind === "photo")) return "photo";
  const layouts = new Set(clips.map((clip) => (clip.kind === "collage" ? clip.layout : undefined)));
  const [only] = [...layouts];
  return layouts.size === 1 && only !== undefined ? only : "mix";
}

/**
 * N9: the parts of a montage whose slice has not landed. A spec that uses one is REFUSED with `not-yet-supported` at
 * that spot, never rendered without it: own media (video clips, own photos, own stickers, own tracks) until 3f, layers
 * until 3b, music until 3c. Each slice lifts its own line here.
 */
export function notYetSupportedIssues(spec: Pick<MontageDraft, "clips" | "layers" | "music">): MontageIssue[] {
  const issues: MontageIssue[] = [];
  const add = (...path: (string | number)[]): void => void issues.push({ code: "not-yet-supported", path });
  spec.clips.forEach((clip, i) => {
    if (clip.kind === "video") add("clips", i);
    else if (clip.kind === "photo") {
      if (clip.cell.photo?.source === "own") add("clips", i, "cell");
    } else {
      clip.cells.forEach((cell, j) => {
        if (cell.photo?.source === "own") add("clips", i, "cells", j);
      });
    }
  });
  spec.layers.forEach((_layer, i) => add("layers", i));
  if (spec.music !== null) add("music");
  return issues;
}

interface SceneCell {
  readonly photoId: string;
  readonly path: (string | number)[];
}

/** Every scene-photo cell of a spec, in order, with where it is (the issue's path). */
function sceneCells(spec: Pick<MontageDraft, "clips">): SceneCell[] {
  const cells: SceneCell[] = [];
  spec.clips.forEach((clip, i) => {
    if (clip.kind === "photo") {
      if (clip.cell.photo?.source === "scene") cells.push({ photoId: clip.cell.photo.photoId, path: ["clips", i, "cell"] });
    } else if (clip.kind === "collage") {
      clip.cells.forEach((cell, j) => {
        if (cell.photo?.source === "scene") cells.push({ photoId: cell.photo.photoId, path: ["clips", i, "cells", j] });
      });
    }
  });
  return cells;
}

function codeOf(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "error";
}

/** What may be logged of an error: its class or errno code. Never its message (it may name the owner's paths). */
function kindOf(error: unknown): string {
  if (!(error instanceof Error)) return typeof error;
  return "code" in error && typeof error.code === "string" ? error.code : error.name;
}

const unavailable = (cells: readonly SceneCell[], detail?: string): EngineFailure =>
  new EngineFailure({ code: "PHOTO_UNAVAILABLE", issues: cells.slice(0, MAX_MONTAGE_ISSUES).map((cell) => ({ code: "photo-unavailable", path: cell.path })), ...(detail === undefined ? {} : { detail }) });

// ---------- the service ----------

export class VideoService {
  readonly #deps: VideoServiceDeps;
  #closing = false;
  /** Startup and recovery work, one after another. Never awaited by a command or by the library opening. */
  #background: Promise<void> = Promise.resolve();
  readonly #timers = new Set<ReturnType<typeof setTimeout>>();

  constructor(deps: VideoServiceDeps) {
    this.#deps = deps;
  }

  // ---------- videos.render ----------

  async render(payload: CommandPayload<"videos.render">): Promise<{ jobId: string; videoId: string }> {
    if (this.#closing) throw new EngineFailure({ code: "INTERNAL", detail: "the engine is shutting down" });
    if ("montageId" in payload) throw new EngineFailure({ code: "NOT_FOUND", detail: `no montage draft ${payload.montageId}: drafts are not available yet` });
    const { spec } = payload;
    const issues = [...montageIssues(spec, "spec"), ...notYetSupportedIssues(spec)].slice(0, MAX_MONTAGE_ISSUES);
    if (issues.length > 0) throw new EngineFailure({ code: "MONTAGE_INVALID", issues });
    const renderTmpDir = this.#deps.renderTmpDir;
    if (renderTmpDir === undefined) throw new EngineFailure({ code: "INTERNAL", detail: "no render folder is configured, so nothing can be rendered" });
    return this.#deps.withLibrary((library) => this.#render(library, spec, renderTmpDir));
  }

  async #render(library: Library, spec: MontageDraft, renderTmpDir: string): Promise<{ jobId: string; videoId: string }> {
    const deps = this.#deps;
    const avatar = library.getAvatar(spec.avatarId);
    if (avatar === undefined || avatar.status === "draft") throw new EngineFailure({ code: "NOT_FOUND", detail: `no avatar ${spec.avatarId} in the open library` });

    // Invariant 35: the export folder, checked NOW; its marker's id is the one the job commits against.
    const check = await deps.checkExport(estimateBytesUpper(spec.clips));
    if (!check.ok) throw new EngineFailure({ code: "EXPORT_UNAVAILABLE", exportReason: check.reason });

    const cells = sceneCells(spec);
    this.#assertAvailable(library, spec.avatarId, cells);

    let filled: MontageDraft;
    try {
      const result = await deps.focus(library).fillMissingFocus(spec);
      filled = result.spec;
      if (result.unresolved.length > 0) deps.log(`videos.render: ${result.unresolved.length} photo(s) could not be judged for their focus; the stand-in point is used`);
    } catch (error) {
      if (error instanceof LibraryError && error.code === "photo-not-found") throw unavailable(cells);
      throw error;
    }

    // From here to `submit` nothing is awaited.
    this.#assertAvailable(library, spec.avatarId, cells);
    if (this.#closing) throw new EngineFailure({ code: "INTERNAL", detail: "the engine is shutting down" });
    const sources = new Map<string, PhotoSource>();
    for (const cell of cells) {
      const sidecar = library.getPhoto(cell.photoId);
      const path = library.photoFilePath(cell.photoId);
      if (sidecar === undefined || path === undefined) throw unavailable(cells.filter((c) => c.photoId === cell.photoId));
      // The STORED size: what the sidecar reports (the graph reads the file with -noautorotate).
      sources.set(cell.photoId, { path, width: sidecar.width, height: sidecar.height });
    }

    const jobId = deps.newId();
    const videoId = deps.newId();
    const plan: RenderPlan = {
      jobId,
      videoId,
      avatarId: spec.avatarId,
      safeName: safeName(avatar.name, avatar.id),
      exportRoot: { root: check.root, rootId: check.rootId },
      spec: filled,
      resolvePhoto: (ref) => (ref.source === "scene" ? sources.get(ref.photoId) : undefined),
      overlays: [],
      audio: { kind: "silent" },
      montageId: null,
      videoKind: videoKindOf(filled.clips),
      music: null,
    };
    const execute = createRenderExecute({
      library,
      tracker: deps.tracker,
      renderTmpDir,
      caseProbe: deps.caseProbe,
      now: deps.now,
      log: deps.log,
      onCommitted: (record) => this.#committed(record),
      ...deps.renderOverrides,
    });
    // ONE number of frames: the queue's total, and the verifier's expectation (execute), come from the same function.
    const result = deps.queue.submit({ jobId, ref: { videoId, avatarId: spec.avatarId, montageId: null }, totalFrames: totalFramesOf(filled.clips), photoIds: scenePhotoIds(filled.clips), execute: execute(plan) });
    if (!result.ok) {
      if (result.code === "QUEUE_FULL") throw new EngineFailure({ code: "RENDER_QUEUE_FULL", detail: `the render queue is full: ${result.limit} renders are already queued or running` });
      const held = new Set(result.photoIds);
      throw unavailable(cells.filter((cell) => held.has(cell.photoId)), "another render that is queued or running holds this photo");
    }

    // A render that has to wait is announced now; one that started already was, by its `started` event.
    const state = deps.queue.states().find((s) => s.jobId === jobId);
    if (state?.kind === "render" && state.status === "queued") this.#emitProgress(state);
    return { jobId, videoId };
  }

  /**
   * Eligibility and used for every scene cell, through the library's own refusal-aware function (`eligibleUnusedPhotos`:
   * it throws while the avatar's usage cannot be trusted; `photoStates` and `isEligible` know nothing of that).
   */
  #assertAvailable(library: Library, avatarId: string, cells: readonly SceneCell[]): void {
    let free: Set<string>;
    try {
      free = new Set(library.eligibleUnusedPhotos(avatarId).map((photo) => photo.id));
    } catch (error) {
      if (error instanceof LibraryError) {
        if (error.code === "library-too-new") throw new EngineFailure({ code: "LIBRARY_TOO_NEW", detail: "a video record of this avatar was written by a newer version of Studio" });
        if (error.code === "index-stale" || error.code === "log-needs-repair") {
          // The library's message names a record file; the code is what the owner's window may be told.
          throw unavailable(cells, `the usage of this avatar's photos cannot be trusted right now (${error.code})`);
        }
      }
      throw error;
    }
    const missing = cells.filter((cell) => !free.has(cell.photoId));
    if (missing.length > 0) throw unavailable(missing);
  }

  // ---------- videos.cancel ----------

  /** Render jobs only: any other id (an avatar job, an unknown one) is NOT_FOUND. A cancel past the commit's claim is ignored by the commit, so the answer is still ok and the job ends `done`. */
  cancel(jobId: string): { jobId: string } {
    if (!this.#deps.queue.cancel(jobId)) throw new EngineFailure({ code: "NOT_FOUND", detail: `no render job ${jobId}` });
    return { jobId };
  }

  // ---------- videos.list ----------

  async list(avatarId: string): Promise<VideoSummary[]> {
    const library = this.#deps.openLibrary();
    if (library?.getAvatar(avatarId) === undefined) throw new EngineFailure({ code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
    const read = await readVideoRecordFiles(library.root, avatarId);
    if (read.skipped > 0) this.#deps.log(`videos.list: ${read.skipped} record file(s) of avatar ${avatarId} could not be used and are left out`);
    if (read.truncated) this.#deps.log(`videos.list: avatar ${avatarId} has more record files than one listing reads`);
    // One fresh look at the export root, one hash budget for the whole listing.
    const root = await this.#freshRoot();
    const budget = newHashBudget();
    const summaries: VideoSummary[] = [];
    for (const record of read.records.slice(0, MAX_LISTED_VIDEOS)) {
      let state: FileState;
      try {
        state = await this.#deps.checker.check(record, root, { verify: "cheap", budget });
      } catch (error) {
        // A disk that cannot be looked at is "cannot look in the root" (`elsewhere`), not a claim that the file is gone, and not a failed list.
        this.#deps.log(`videos.list: the file of ${record.id} could not be checked (${kindOf(error)})`);
        state = "elsewhere";
      }
      summaries.push(videoSummaryOf(record, state));
    }
    return summaries;
  }

  // ---------- videos.delete ----------

  /**
   * The file (when the FULL check finds it present) and the record. «Удалить запись» for a `missing`, `changed` or
   * `elsewhere` file: only the record goes and the photos are freed. For `elsewhere` that is deliberate: the file lives on
   * in another export folder, and the owner who deletes the record is telling Studio to forget the video, not to reach
   * into a folder it cannot vouch for.
   */
  async delete(videoId: string): Promise<{ videoId: string }> {
    return this.#deps.withLibrary(async (library) => {
      const root = await this.#freshRoot();
      let avatarId: string;
      try {
        ({ avatarId } = await deleteVideo(videoId, { library, exportRoot: root, checker: this.#deps.checker, ...(this.#deps.fs === undefined ? {} : { fs: this.#deps.fs }), log: this.#deps.log }));
      } catch (error) {
        throw this.#deleteFailure(videoId, error);
      }
      this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "video.changed", payload: { change: "removed", videoId, avatarId } });
      return { videoId };
    });
  }

  #deleteFailure(videoId: string, error: unknown): EngineFailure {
    if (error instanceof EngineFailure) return error;
    if (error instanceof VideoNotFoundError) return new EngineFailure({ code: "NOT_FOUND", detail: `no video ${videoId}` });
    if (error instanceof VideoRecordUnreadableError) return new EngineFailure({ code: "INTERNAL", detail: "the video's record cannot be read" });
    if (error instanceof LibraryError && error.code === "library-too-new") return new EngineFailure({ code: "LIBRARY_TOO_NEW", detail: "this video's record was written by a newer version of Studio" });
    // Its message names no path: `VideoDiskError` builds it from a fixed phrase and the disk's code.
    if (error instanceof VideoDiskError) return new EngineFailure({ code: "INTERNAL", detail: error.message });
    // Anything else is a raw Node error, whose message names the owner's path: only its code is told.
    this.#deps.log(`videos.delete: ${videoId} failed (${kindOf(error)})`);
    return new EngineFailure({ code: "INTERNAL", detail: `the video could not be deleted (${codeOf(error)})` });
  }

  // ---------- events ----------

  /** The render queue's events as the contract's. A state and its result travel; the error's `cause` (raw, path-bearing) never does. */
  onQueueEvent(event: RenderQueueEvent): void {
    try {
      switch (event.type) {
        case "started":
          if (event.state.kind === "render") this.#emitProgress(event.state);
          break;
        case "progress":
          this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "job.progress", payload: event.progress });
          break;
        case "ended":
          this.#ended(event);
          break;
      }
    } catch (error) {
      this.#deps.log(`render queue: an event could not be announced (${kindOf(error)})`);
    }
  }

  /** Where a broken event listener is reported. It logs the error's kind and cannot throw, even if the log does. */
  onListenerError(error: unknown): void {
    try {
      this.#deps.log(`render queue: an event listener threw (${kindOf(error)})`);
    } catch {
      // The last resort of a last resort: the queue must go on.
    }
  }

  #emitProgress(state: Extract<ReturnType<VideoQueue["states"]>[number], { kind: "render" }>): void {
    this.#emit({
      v: PROTOCOL_VERSION,
      id: this.#deps.newId(),
      kind: "event",
      type: "job.progress",
      payload: { kind: "render", jobId: state.jobId, videoId: state.videoId, avatarId: state.avatarId, montageId: state.montageId, done: state.done, total: state.total },
    });
  }

  #ended(event: Extract<RenderQueueEvent, { type: "ended" }>): void {
    const { state } = event;
    if (state.kind !== "render") return;
    const ref = { kind: "render" as const, jobId: state.jobId, videoId: state.videoId, avatarId: state.avatarId, montageId: state.montageId };
    // The cause is for the log, by its kind: it is the RAW error, and Node's system errors carry `path`, `dest` and `spawnargs`.
    this.#deps.log(`render ${state.jobId} ended ${state.status}${event.cause === undefined ? "" : ` (${kindOf(event.cause)})`}`);
    if (state.status === "done" && state.result !== undefined) {
      this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "job.done", payload: { jobId: state.jobId, result: state.result } });
    } else if (state.status === "failed") {
      const error: EngineError = state.error ?? { code: "INTERNAL", detail: "the render failed" };
      this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "job.failed", payload: { ...ref, error } });
    } else if (state.status === "cancelled") {
      this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "job.cancelled", payload: ref });
    }
    // A commit whose index update failed left the avatar closed (`index-stale`): read the record back in the background.
    const library = this.#deps.openLibrary();
    if (library !== null) this.#scheduleStaleRetry(library, state.avatarId, 0);
  }

  /** A record is committed and the used index has it: the window learns of it now, before `job.done`. */
  #committed(record: VideoRecord): void {
    this.#emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type: "video.changed", payload: { change: "upserted", video: videoSummaryOf(record, "present") } });
  }

  /** Emits, and never throws: a closed window must not fail a commit or stop the queue. */
  #emit(event: UnsequencedEvent): void {
    try {
      this.#deps.emit(event);
    } catch (error) {
      this.#deps.log(`an event (${event.type}) could not be emitted (${kindOf(error)})`);
    }
  }

  // ---------- the export root ----------

  /** The export root as it is right now (its marker read now), or null when it is unusable: what the file states, delete and recovery judge files against. */
  async #freshRoot(): Promise<ExportRootRef | null> {
    const check = await this.#deps.checkExport();
    if (!check.ok) return null;
    let caseInsensitive = true; // the cautious answer: it can only make comparisons stricter
    try {
      caseInsensitive = await this.#deps.caseProbe.isCaseInsensitive(check.root);
    } catch (error) {
      this.#deps.log(`the export folder's case rule could not be probed (${kindOf(error)}); the cautious one is used`);
    }
    return { root: check.root, rootId: check.rootId, caseInsensitive };
  }

  // ---------- startup, recovery, stale index ----------

  /**
   * At engine start: sweeps `render-tmp` (leaving the folders of live renders) and settles the open library's crash
   * windows. In the BACKGROUND: neither is awaited by the start, by a command or by a render; a hung disk costs nothing but
   * its own task, and a failure is logged. Never called from a commit path.
   */
  startup(library: Library | null): void {
    this.#chain(async () => {
      await this.#sweepRenderTmp();
      if (library !== null) await this.#recover(library);
    });
  }

  /** A library became the live one (a switch): settle its crash windows, in the background. */
  libraryOpened(library: Library): void {
    this.#chain(() => this.#recover(library));
  }

  /** Resolves once the background work queued so far is done (tests, and shutdown). Never rejects. */
  settled(): Promise<void> {
    return this.#background;
  }

  #chain(work: () => Promise<void>): void {
    this.#background = this.#background.then(work).catch((error: unknown) => {
      this.#deps.log(`background work failed (${kindOf(error)})`);
    });
  }

  async #sweepRenderTmp(): Promise<void> {
    const dir = this.#deps.renderTmpDir;
    if (dir === undefined) return;
    const swept = await sweepRenderTmp(dir, { keep: (name) => this.#deps.tracker.hasJob(name) });
    for (const { code } of swept.skipped) this.#deps.log(`a leftover in render-tmp could not be removed (${code}); the next start tries again`);
  }

  async #recover(library: Library): Promise<void> {
    const deps = this.#deps;
    // A FRESH look at the root, and the SAME tracker the renders register in: a live commit is never taken for a crash's leftover.
    const exportRoot = await this.#freshRoot();
    const run = deps.recover?.run ?? recoverVideos;
    const report = await run({ library, exportRoot, live: deps.tracker }, { log: deps.log, ...deps.recover?.deps });
    deps.log(`recovery: ${report.adopted.length} adopted, ${report.dropped.length} dropped, ${report.deferred.length} deferred, ${report.left.length} left, ${report.skipped.length} skipped`);
    // Adopted records are new to the windows; a library that is no longer the live one has no windows to tell.
    if (deps.openLibrary() === library) {
      for (const videoId of report.adopted) await this.#announceAdopted(library, videoId);
    }
    for (const manifest of library.listAvatars()) this.#scheduleStaleRetry(library, manifest.id, 0);
  }

  async #announceAdopted(library: Library, videoId: string): Promise<void> {
    for (const manifest of library.listAvatars()) {
      let record: VideoRecord | null;
      try {
        record = await readVideoRecordFile(library.root, manifest.id, videoId);
      } catch (error) {
        this.#deps.log(`recovery: the adopted record ${videoId} could not be read back (${kindOf(error)})`);
        continue;
      }
      // Recovery has just verified the file's size and sha256: it is present.
      if (record !== null) return this.#committed(record);
    }
  }

  /** The used index of `avatarId` is behind its committed videos (`index-stale`): read the records again, a few times, in the background. */
  #scheduleStaleRetry(library: Library, avatarId: string, attempt: number): void {
    const delays = this.#deps.staleRetryDelaysMs ?? DEFAULT_STALE_RETRY_DELAYS_MS;
    if (this.#closing || attempt >= delays.length || library.videoIndexStale(avatarId).length === 0) return;
    const timer = setTimeout(() => {
      this.#timers.delete(timer);
      void this.#retryStale(library, avatarId, attempt);
    }, delays[attempt]);
    // A retry must never keep the engine alive.
    if (typeof timer === "object" && "unref" in timer) timer.unref();
    this.#timers.add(timer);
  }

  async #retryStale(library: Library, avatarId: string, attempt: number): Promise<void> {
    if (this.#closing || this.#deps.openLibrary() !== library) return;
    try {
      await library.reloadVideoRecords(avatarId);
    } catch (error) {
      this.#deps.log(`the used index of avatar ${avatarId} could not be rebuilt (${kindOf(error)})`);
    }
    // Nothing else clears the flag: a quarantine or a "repair" must never act on it (no record is broken).
    this.#scheduleStaleRetry(library, avatarId, attempt + 1);
  }

  // ---------- stop ----------

  /**
   * The engine is stopping (the app quits): no render is accepted from now on, every queued and running render is
   * cancelled, and a bounded wait lets a commit that is past its claim finish (its record and file are then complete,
   * and the used index has them). `idle` says whether every job had ended within the bound; if not, the engine's
   * process is ended anyway and the next start's recovery settles what is left. Orphaned ffmpeg children die with
   * their parent's cancel, so none keeps writing into the export folder.
   */
  async shutdown(boundMs: number): Promise<{ idle: boolean }> {
    this.#closing = true;
    for (const timer of this.#timers) clearTimeout(timer);
    this.#timers.clear();
    for (const state of this.#deps.queue.states()) {
      if (state.kind === "render" && (state.status === "queued" || state.status === "running")) this.#deps.queue.cancel(state.jobId);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<"timeout">((resolve) => {
      timer = setTimeout(() => resolve("timeout"), boundMs);
    });
    try {
      const outcome = await Promise.race([this.#deps.queue.idle().then(() => "idle" as const), bound]);
      return { idle: outcome === "idle" };
    } finally {
      clearTimeout(timer);
    }
  }
}
