import * as nodePath from "node:path";
import { dirname } from "node:path";
import { CLIP_FILE_DAMAGED_DETAIL, EXPORT_CHANGING_DETAIL, EXPORT_FPS, PROTOCOL_VERSION, type ClipExportLine, type CommandPayload, type EngineError, type ExportUnavailableReason } from "../../shared/engine";
import type { UnsequencedEvent } from "../../shared/engine/events";
import { FfmpegTimeoutError, runFfmpegArgv, type RunFfmpegArgvOptions } from "../../node/runFfmpeg";
import { EngineFailure } from "../engineFailure";
import { claimExportName, ExportFolderError, ExportNamesExhaustedError, formatExportDate, NODE_EXPORT_FOLDER_FS, placeOf, prepareExportFolder, safeName, type ExportFolderFs, type PreparedFolder } from "../exportName";
import type { ExportRootCheck } from "../exportRoot";
import { FREE_MARGIN_BYTES, isNoSpaceError } from "../freeBytes";
import type { ClipJobEnd, JobRegistry } from "../jobs";
import { hasErrorCode } from "../library/durableFs";
import { openFileSource } from "../media/video/fileSource";
import { probeVideo, type VideoInfo } from "../media/video/videoProbe";
import { checkVideoStreams, type VideoStreamsOptions, type VideoStreamsVerdict } from "../media/video/videoStreams";
import { assertFolderContained, ContainmentError } from "../videos/commit";
import { NODE_COMMIT_FS, type CommitFs, type FileFacts, type FileIdentity } from "../videos/commitFs";
import { CLIP_EXPORT_KIND, highestNamedNumber, type ExportNumberLibrary, type NumberFs } from "../videos/exportNumbers";
import { hashFile } from "../videos/fileBytes";
import type { CommitTracker } from "../videos/live";
import { partNameOf } from "../videos/record";
import { readRootId } from "../videos/rootMarker";
import type { RootLockOptions } from "../videos/rootLock";
import { clipExportArgv, EXPORT_HEIGHT, EXPORT_PROFILE_OF, EXPORT_RATE_OF, EXPORT_WIDTH, expectedExportBytes, expectedExportFrames, type ExportFpsMode } from "./exportProfile";
import { verifyClipExport } from "./exportVerify";
import type { ClipRecords } from "./records";
import type { ClipRecord } from "./schemas";
import type { ClipColour } from "./validate";
import { clipFilePath, readClipRecord } from "./store";

// Stage 5, 5b.1, S5.V4c (plan s5b1 §5.13, I5.55, I5.58; owner Q-C, 2026-10-13): «Сохранить в папку». `clips.export {avatarId, clipId}` checks its refusals for free and starts an
// EXPORT JOB: kind `clip`, phase `exporting`, its done/total the frames the encode has written. It is registered with its avatar (a delete waits) and counted in the clip service's work
// (a library switch waits). One export runs at a time; the next waits its turn in a FIFO at 0 %.
//
// The job re-encodes the LIBRARY'S file (the provider's bytes, never touched: I5.54) into the avatar's folder inside the export root and COMMITS EXACTLY AS A RENDER DOES
// (videos/commit.ts; commitFs.ts: «deliberately no copy»):
//   the folder checked again -> the library's file (the bytes its record names) judged by the walker, then by ffmpeg itself (one video stream, before `-map 0:V:0`) -> `<folder>/.studio-part-<jobId>.mp4` registered
//   in the renders' live commits and created empty by the job -> the encode (bounded, under the job's signal) -> the temp probed (H.264 1080 x 1920 at the profile's rate, no sound,
//   the source's length) and checked by `verifyClipExport` (I5.58) -> fsync -> THE ROOT LOCK: the marker and the folder looked at again, the number above `highestNamedNumber`
//   (which sees every clip record), `claimExportName` (the placeholder registered live), the temp and the placeholder re-checked, RENAME (an EXDEV is a refusal, never a copy), the
//   folder flushed -> the lock released -> the record's export line (the I5.53 rewrite) -> both paths leave the live commits.
//
// CANCEL: a quit (the clip service's stop), the library going away and a cancel of the job are honoured up to the claim; from the claim on the export runs to its record ("done
// wins", as a render's commit). FAILURES are free and leave the library's file as it was: an encode error, a timeout or a failed check is INTERNAL (the window's text: «Не удалось
// сохранить клип в папку — файл в Studio цел.»), except a library file that is itself not usable, whose INTERNAL carries `CLIP_FILE_DAMAGED_DETAIL` (the window never calls it intact);
// a full disk or a folder that cannot take the file is the render's EXPORT_UNAVAILABLE and its reason; the temp and the placeholder are
// removed while they are still ours (their inode and shape). A CRASH leaves at most a `.studio-part-*` and an empty placeholder of the render's pattern, which the render recovery
// sweeps once they are no longer live; a crash after the rename leaves a whole file no record names, and the next claim steps over its name.

/** The encode's bound (§5.13), set by the slowest mode: a 10 s 1080p clip in `interpolate` takes about a minute on the owner's Mac (the default `duplicate` takes seconds). */
export const EXPORT_ENCODE_TIMEOUT_MS = 10 * 60_000;
/** How long one group of export-volume calls may take before the volume counts as not answering (the render's `EXPORT_STEP_DEADLINE_MS`). */
export const EXPORT_STEP_MS = 30_000;
/** ffmpeg's look at how many video streams the library's file has. */
const STREAMS_TIMEOUT_MS = 30_000;
/** The probed export may differ from the source's length by about two frames (the 24 -> 30 step ends on a whole frame). */
const DURATION_TOLERANCE_MS = 100;
/** An export's rate is a whole 30 or 24; the walker gives it to three decimals. */
const RATE_TOLERANCE = 0.01;

/** The moments a test can stand in (`hooks.reached`). */
export type ClipExportStep = "encoding" | "encoded" | "verified" | "name-claimed" | "renamed" | "dir-synced" | "recorded";

/** The open library, as the export needs it. `key` names this library instance, so an export can tell that the library it started in is still the open one. */
export interface ClipExportLibrary {
  readonly key: object;
  clipsDirOf(avatarId: string): string;
  avatar(avatarId: string): { readonly id: string; readonly name: string } | undefined;
}

export interface ClipExportsDeps {
  newId: () => string;
  /** Wall clock, epoch ms: the export's `creation_time`, its date in the name and its record line. */
  clock: () => number;
  log: (line: string) => void;
  library: () => ClipExportLibrary | null;
  pendingDelete: (avatarId: string) => boolean;
  jobs: Pick<JobRegistry, "startClip" | "clipPhase" | "finishClip">;
  emit: (event: UnsequencedEvent) => void;
  /** The clip service's per-clip guard and work count (`begin` holds both until the returned end), and its stop (a quit). */
  host: { busy: (clipId: string) => boolean; begin: (clipId: string) => () => void; stop: AbortSignal };
  /** The records' own lock: the start is decided between a delete and a rewrite, never in the middle of one. */
  withClipLock: <T>(clipId: string, work: () => Promise<T>) => Promise<T>;
  /** The records' one gate for a committed record's rewrite (I5.53): an appended export line. */
  rewrite: ClipRecords["rewrite"];
  /** The export folder checked now; with an estimate it also wants room for it (the render's check). Never rejects. */
  exportStatus: (requiredBytes?: number) => Promise<ExportRootCheck>;
  liveCommits: CommitTracker;
  withRootLock: <T>(root: string, work: () => Promise<T>, options?: RootLockOptions) => Promise<T>;
  /** What `highestNamedNumber` reads of the live library, or null when none is open. */
  exportNumbers: () => { library: ExportNumberLibrary; libraryRoot: string } | null;
  /** The engine's export folder switch (the render's `exportSwitch`): a pick waiting for its settings, and the folder the settings name now. */
  exportSwitch?: { pending(): boolean; currentPath(): string };
  /** `EXPORT_FPS` unless a test picks another mode. */
  fps?: ExportFpsMode;
  // ----- test seams -----
  fs?: CommitFs;
  folderFs?: ExportFolderFs;
  encode?: (options: RunFfmpegArgvOptions) => Promise<void>;
  videoStreams?: (options: VideoStreamsOptions) => Promise<VideoStreamsVerdict>;
  verify?: typeof verifyClipExport;
  encodeTimeoutMs?: number;
  stepMs?: number;
  numberFs?: NumberFs;
  hooks?: { reached?: (step: ClipExportStep, at: { jobId: string; temp: string; placeholder: string | null }) => void | Promise<void> };
}

/** One export, from its start to its end. */
interface ExportJob {
  readonly jobId: string;
  readonly avatarId: string;
  readonly clipId: string;
  readonly avatarName: string;
  readonly clipsDir: string;
  readonly record: ClipRecord;
  readonly durationMs: number;
  readonly mode: ExportFpsMode;
  readonly libraryKey: object;
  /** A cancel of the job, the clip service's stop or the library going away. */
  readonly signal: AbortSignal;
  /** Gives the clip back to its other commands and the library to a switch. */
  readonly end: () => void;
}

/** What the walker judged of the library's file. */
interface JudgedSource {
  readonly codec: "h264";
  /** The coded picture (what ffmpeg's stream line shows). */
  readonly width: number;
  readonly height: number;
  readonly colour: ClipColour;
  readonly durationMs: number;
}

/** What of a run the cleanup and the end need to know. */
interface RunState {
  /** From the claim on a stop is no longer honoured. */
  pastNoReturn: boolean;
  folder: PreparedFolder | null;
  temp: string | null;
  tempIdentity: FileIdentity | null;
  /** The temp as it was verified (size, mtime, inode). */
  verified: FileFacts | null;
  placeholder: { path: string; identity: FileIdentity } | null;
  placed: boolean;
  recorded: boolean;
}

const failure = (error: EngineError): EngineFailure => new EngineFailure(error);
const exportRefusal = (exportReason: ExportUnavailableReason, detail: string): EngineFailure => failure({ code: "EXPORT_UNAVAILABLE", exportReason, detail });
const internal = (detail: string): EngineFailure => failure({ code: "INTERNAL", detail });

function codeOf(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "error";
}

/** A disk call on the export volume failed: what the window is told (never the path), as the render's commit tells it. */
function exportVolumeFailure(error: unknown): EngineFailure {
  if (error instanceof EngineFailure) return error;
  if (error instanceof ExportFolderError) return exportRefusal(error.reason, "the avatar's export folder cannot be used");
  if (error instanceof ContainmentError) return exportRefusal("not-writable", "the export folder changed while the clip was being saved");
  if (isNoSpaceError(error)) return exportRefusal("not-enough-space", "the export folder's disk is full");
  const code = codeOf(error);
  if (code === "EXDEV") return exportRefusal("not-writable", "the export folder spans two volumes; a clip is never copied across");
  if (code === "ENOENT" || code === "ENOTDIR") return exportRefusal("missing", "the export folder is gone");
  return exportRefusal("not-writable", `the export folder could not be written (${code})`);
}

/** `work` on the export volume, given up after `ms` (a dropped network drive answers no call) or at the job's stop; its errors are the export volume's. */
async function onExportVolume<T>(signal: AbortSignal, ms: number, work: () => Promise<T>): Promise<T> {
  signal.throwIfAborted();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onAbort: (() => void) | undefined;
  const out = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(exportRefusal("not-writable", "the export folder did not answer in time")), ms);
    onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
  });
  out.catch(() => undefined);
  try {
    return await Promise.race([work().catch((error: unknown) => Promise.reject(signal.aborted ? signal.reason : exportVolumeFailure(error))), out]);
  } finally {
    clearTimeout(timer);
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

/** The root's marker still holds the id that was checked (a volume swapped in at the same path passes every containment check). */
async function assertSameRoot(root: string, rootId: string): Promise<void> {
  const marker = await readRootId(root);
  if (marker.rootId === rootId) return;
  if (marker.rootId === null && marker.code !== "ENOENT" && marker.code !== "ENOTDIR" && marker.code !== "invalid") throw exportRefusal("not-writable", `the export folder's marker could not be read (${marker.code})`);
  throw exportRefusal("missing", "the export folder is not the one that was checked");
}

const sameFile = (a: FileFacts, b: FileFacts): boolean => a.size === b.size && a.mtimeMs === b.mtimeMs && a.ino === b.ino && a.dev === b.dev;
const isIdentity = (facts: FileFacts, identity: FileIdentity): boolean => facts.dev === identity.dev && facts.ino === identity.ino;

/** The length of the picture in ms (the edit's, else the samples'): what an export keeps of the source. */
const pictureMs = (info: VideoInfo): number => (info.video.presentation.ticks / info.video.presentation.timescale) * 1000;

/** Resolves when `turn` does, or as soon as `signal` fires (never rejects). */
function untilTurnOrStop(turn: Promise<void>, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const stop = (): void => resolve();
    signal.addEventListener("abort", stop, { once: true });
    void turn.then(() => {
      signal.removeEventListener("abort", stop);
      resolve();
    });
  });
}

async function probeFile(path: string): Promise<ReturnType<typeof probeVideo>> {
  const opened = await openFileSource(path);
  try {
    return await probeVideo(opened.source);
  } finally {
    await opened.close();
  }
}

export class ClipExports {
  readonly #deps: ClipExportsDeps;
  readonly #fs: CommitFs;
  /** The tail of the FIFO: one export runs at a time. */
  #queue: Promise<void> = Promise.resolve();
  /** The cancel of each export that has started and not ended. */
  readonly #running = new Map<string, AbortController>();
  /** Fired when the library goes away: every export of it stops (a new one gets a fresh signal). */
  #libraryStop = new AbortController();

  constructor(deps: ClipExportsDeps) {
    this.#deps = deps;
    this.#fs = deps.fs ?? NODE_COMMIT_FS;
  }

  /** An export job of this service that has not ended. */
  owns(jobId: string): boolean {
    return this.#running.has(jobId);
  }

  /** The exports queued or running: each will save into the export folder the settings name, so a pick of another folder waits for them (`export.choose`). */
  active(): number {
    return this.#running.size;
  }

  /**
   * The folder an export commits into is the one the settings name, and none may be being switched (the render's rule, `videos/service.ts`): a copy saved into the old folder
   * after the owner was told what the new one holds would read `elsewhere` and could not be shown. IN_FLIGHT, before any byte or before the claim.
   */
  #assertNoSwitch(root: string): void {
    const exportSwitch = this.#deps.exportSwitch;
    if (exportSwitch !== undefined && (exportSwitch.pending() || root !== exportSwitch.currentPath())) throw failure({ code: "IN_FLIGHT", detail: EXPORT_CHANGING_DETAIL });
  }

  /** Stops an export (honoured until its name is claimed). */
  cancel(jobId: string): void {
    this.#running.get(jobId)?.abort(new DOMException("the export was cancelled", "AbortError"));
  }

  /** The open library went away: its exports stop. */
  libraryGone(): void {
    this.#libraryStop.abort(new DOMException("the library is no longer open", "AbortError"));
    this.#libraryStop = new AbortController();
  }

  /** The avatar's library, or the refusal: LIBRARY_UNAVAILABLE with none open, NOT_FOUND for an avatar that is not in it or is being deleted. */
  #libraryFor(avatarId: string): { library: ClipExportLibrary; avatar: { id: string; name: string } } {
    const library = this.#deps.library();
    if (library === null) throw failure({ code: "LIBRARY_UNAVAILABLE", detail: "no library is open: its folder is missing or unreadable; choose one in Settings" });
    const avatar = library.avatar(avatarId);
    if (avatar === undefined || this.#deps.pendingDelete(avatarId)) throw failure({ code: "NOT_FOUND", detail: `no avatar ${avatarId} in the open library` });
    return { library, avatar };
  }

  // ---------- clips.export ----------

  /**
   * §5.2's refusals, in order and all free: NOT_FOUND (the clip, its avatar, a pending delete), VALIDATION `not-ready`, IN_FLIGHT `job-running` (any job on this clip, an export
   * included), EXPORT_UNAVAILABLE with the render's reason (the folder through `exportStatus`, with room for the clip at the 12 Mbit/s cap: `not-enough-space`). Then the job is
   * registered, and queued.
   */
  async start(payload: CommandPayload<"clips.export">): Promise<{ jobId: string }> {
    const deps = this.#deps;
    const { avatarId, clipId } = payload;
    const first = this.#libraryFor(avatarId);
    const clipsDir = first.library.clipsDirOf(avatarId);
    return deps.withClipLock(clipId, async () => {
      const read = await readClipRecord(clipsDir, clipId);
      if (read.kind !== "record" || read.record.id !== clipId || read.record.avatarId !== avatarId) throw failure({ code: "NOT_FOUND", detail: `no clip ${clipId} in this avatar's clips` });
      const record = read.record;
      if (record.outcome.status !== "ready") throw failure({ code: "VALIDATION", clipReason: "not-ready", detail: `clip ${clipId} has no file to save` });
      if (deps.host.busy(clipId)) throw failure({ code: "IN_FLIGHT", clipReason: "job-running", detail: `a job is working on clip ${clipId}` });
      const durationMs = record.outcome.durationMs;
      const check = await deps.exportStatus(expectedExportBytes(durationMs) + FREE_MARGIN_BYTES);
      if (!check.ok) throw exportRefusal(check.reason, "the export folder cannot take the clip");
      // Nothing awaited from here to the job's registration: a delete prepared meanwhile, the library switched away, or a pick of another export folder, wins.
      this.#assertNoSwitch(check.root);
      const now = this.#libraryFor(avatarId);
      if (now.library.key !== first.library.key) throw failure({ code: "NOT_FOUND", detail: `avatar ${avatarId} is no longer in the library its clip was read from` });
      if (deps.host.busy(clipId)) throw failure({ code: "IN_FLIGHT", clipReason: "job-running", detail: `a job is working on clip ${clipId}` });
      const mode = deps.fps ?? EXPORT_FPS;
      const jobId = deps.newId();
      const registry = deps.jobs.startClip(jobId, { avatarId, clipId }, "exporting", expectedExportFrames(durationMs, mode));
      const own = new AbortController();
      this.#running.set(jobId, own);
      const job: ExportJob = {
        jobId,
        avatarId,
        clipId,
        avatarName: now.avatar.name,
        clipsDir,
        record,
        durationMs,
        mode,
        libraryKey: now.library.key,
        signal: AbortSignal.any([registry, own.signal, deps.host.stop, this.#libraryStop.signal]),
        end: deps.host.begin(clipId),
      };
      // FIFO: the export runs once every export ahead of it has ended. A stop while it waits ends it at once (it finds its signal fired and makes nothing), and the queue's tail
      // still waits for the ones ahead, so the next export never overtakes them.
      const turn = this.#queue;
      const run = untilTurnOrStop(turn, job.signal).then(() => this.#run(job));
      this.#queue = Promise.all([turn, run]).then(
        () => undefined,
        () => undefined,
      );
      return { jobId };
    });
  }

  // ---------- the job ----------

  async #run(job: ExportJob): Promise<void> {
    const deps = this.#deps;
    const ref = { kind: "clip" as const, jobId: job.jobId, avatarId: job.avatarId, clipId: job.clipId };
    const state: RunState = { pastNoReturn: false, folder: null, temp: null, tempIdentity: null, verified: null, placeholder: null, placed: false, recorded: false };
    let end: ClipJobEnd;
    try {
      end = await this.#export(job, state);
    } catch (error) {
      if (job.signal.aborted && !state.pastNoReturn) end = { status: "cancelled" };
      else {
        const engineError = error instanceof EngineFailure ? error.error : { code: "INTERNAL" as const, detail: "the clip could not be saved to the export folder" };
        deps.log(`[clip] ${job.clipId}: the export failed (${engineError.code}${error instanceof EngineFailure ? "" : `, ${error instanceof Error ? error.name : typeof error}`})`);
        end = { status: "failed", error: engineError };
      }
      await this.#cleanUp(job, state);
    } finally {
      if (state.temp !== null) deps.liveCommits.release(state.temp, ...(state.placeholder === null ? [] : [state.placeholder.path]));
      this.#running.delete(job.jobId);
      job.end();
    }
    try {
      const final = deps.jobs.finishClip(job.jobId, end);
      const v = PROTOCOL_VERSION;
      if (final?.status === "done" && final.result !== undefined) deps.emit({ v, id: deps.newId(), kind: "event", type: "job.done", payload: { jobId: job.jobId, result: final.result } });
      else if (end.status === "failed") deps.emit({ v, id: deps.newId(), kind: "event", type: "job.failed", payload: { ...ref, error: end.error } });
      else if (end.status === "cancelled") deps.emit({ v, id: deps.newId(), kind: "event", type: "job.cancelled", payload: ref });
    } catch (error) {
      deps.log(`[clip] the end of export ${job.jobId} could not be announced (${error instanceof Error ? error.name : typeof error})`);
    }
  }

  async #export(job: ExportJob, state: RunState): Promise<ClipJobEnd> {
    const deps = this.#deps;
    const fs = this.#fs;
    const { signal } = job;
    const stepMs = deps.stepMs ?? EXPORT_STEP_MS;
    const reached = async (step: ClipExportStep): Promise<void> => {
      await deps.hooks?.reached?.(step, { jobId: job.jobId, temp: state.temp ?? "", placeholder: state.placeholder?.path ?? null });
    };
    let shown = -1;
    const progress = (frames: number): void => {
      const update = deps.jobs.clipPhase(job.jobId, { phase: "exporting", done: frames });
      if (update === null || update.done <= shown) return;
      shown = update.done;
      deps.emit({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "event", type: "job.progress", payload: update });
    };
    signal.throwIfAborted();
    if (deps.library()?.key !== job.libraryKey) throw new DOMException("the library is no longer open", "AbortError");
    progress(0);

    // 1. The folder again: the queue may have waited, and minutes may pass before the claim.
    const check = await deps.exportStatus(expectedExportBytes(job.durationMs) + FREE_MARGIN_BYTES);
    if (!check.ok) throw exportRefusal(check.reason, "the export folder cannot take the clip");
    this.#assertNoSwitch(check.root);
    signal.throwIfAborted();

    // 2. The library's file: the bytes its record names (I5.54: the provider's, kept as they came), judged by the walker, then by ffmpeg itself: one video stream, the one the walker
    //    judged (the encode maps `0:V:0`).
    // S5.V8 follow-up: each refusal of the library's own file is the one INTERNAL after which the file is NOT whole (`CLIP_FILE_DAMAGED_DETAIL`); the log keeps why.
    const source = clipFilePath(job.clipsDir, job.clipId);
    const sourceSha = await hashFile(source).catch((error: unknown) => Promise.reject(this.#damaged(`cannot be read (${codeOf(error)})`)));
    if (job.record.outcome.status !== "ready" || sourceSha !== job.record.outcome.sha256) throw this.#damaged("is not the file its record names");
    signal.throwIfAborted();
    const judged = await this.#judge(source);
    const streams = await (deps.videoStreams ?? checkVideoStreams)({ path: source, expected: { codec: judged.codec, width: judged.width, height: judged.height }, signal, timeoutMs: STREAMS_TIMEOUT_MS });
    if (streams !== "ok") throw this.#damaged(`is not one plain video stream to ffmpeg (${streams})`);
    signal.throwIfAborted();

    // 3. The avatar's folder inside the export root, and the temp in it: live BEFORE its first byte, and made empty by the job (ffmpeg only truncates it).
    const folder = await onExportVolume(signal, stepMs, async () => {
      const prepared = await prepareExportFolder({ fs: deps.folderFs ?? NODE_EXPORT_FOLDER_FS, root: check.root, safeName: safeName(job.avatarName, job.avatarId), avatarId: job.avatarId, caseInsensitive: true });
      // A folder this job just made is an entry in the root: durable before anything goes into it.
      await fs.fsyncDir(check.root).catch((error: unknown) => deps.log(`[clip] ${job.clipId}: the export folder could not be flushed (${codeOf(error)})`));
      return prepared;
    });
    state.folder = folder;
    const temp = folder.fileIn(partNameOf(job.jobId));
    state.temp = temp;
    deps.liveCommits.addTemp(temp);
    state.tempIdentity = await onExportVolume(signal, stepMs, () => fs.createExclusive(temp));

    // 4. The encode.
    const exportedAt = new Date(deps.clock());
    await reached("encoding");
    try {
      await (deps.encode ?? runFfmpegArgv)({
        argv: clipExportArgv({ input: source, output: temp, mode: job.mode, colour: judged.colour, exportedAt }),
        output: temp,
        signal,
        timeoutMs: deps.encodeTimeoutMs ?? EXPORT_ENCODE_TIMEOUT_MS,
        onFrames: progress,
      });
    } catch (error) {
      if (signal.aborted) throw error;
      if (isNoSpaceError(error)) throw exportRefusal("not-enough-space", "the export folder's disk filled up during the encode");
      // The folder (or the whole volume) vanished while ffmpeg ran, so its second pass could not finish: the same refusal as the check before the claim (state 43b), not an INTERNAL.
      // Bounded like every call on the export volume; only its «missing» answer changes the outcome, any other trouble leaves the encode's own failure.
      await onExportVolume(signal, stepMs, () => fs.lstat(temp)).catch((probe: unknown) => {
        if (probe instanceof EngineFailure && probe.error.code === "EXPORT_UNAVAILABLE" && probe.error.exportReason === "missing") throw probe;
      });
      throw internal(error instanceof FfmpegTimeoutError ? "the clip's encode took too long" : "the clip could not be encoded");
    }
    await reached("encoded");
    signal.throwIfAborted();

    // 5. The file: the profile's video, and nothing in it but what I5.58 allows.
    const facts = await onExportVolume(signal, stepMs, () => fs.lstat(temp));
    if (facts.isSymbolicLink || !facts.isFile || state.tempIdentity === null || !isIdentity(facts, state.tempIdentity)) throw exportRefusal("not-writable", "the export's temp file is not the file the job made");
    await this.#checkOutput(temp, judged, job.mode);
    const verdict = await (deps.verify ?? verifyClipExport)(temp, { createdAt: exportedAt });
    if (!verdict.ok) {
      // Codes and box paths only: a reason's message may quote the file.
      for (const reason of verdict.reasons) deps.log(`[clip] ${job.clipId}: the export was refused: ${reason.code}${reason.path === undefined ? "" : ` at ${reason.path}`}`);
      throw internal("the exported file failed its check");
    }
    if (verdict.sha256 === null || verdict.bytes !== facts.size) throw internal("the exported file changed while it was checked");
    const sha256 = verdict.sha256;
    state.verified = facts;
    await reached("verified");
    await onExportVolume(signal, stepMs, () => fs.fsyncFile(temp));
    signal.throwIfAborted();

    // 6. The commit, under the export root's lock from the claim to the rename (the render recovery holds it too, so it never sees this half done).
    const numbers = deps.exportNumbers();
    if (numbers === null || deps.library()?.key !== job.libraryKey) throw new DOMException("the library is no longer open", "AbortError");
    const date = formatExportDate(exportedAt);
    const relPath = await deps.withRootLock(
      check.root,
      async (): Promise<string> => {
        // The LAST cancel point (after the wait for the lock).
        signal.throwIfAborted();
        await onExportVolume(signal, stepMs, async () => {
          await assertSameRoot(check.root, check.rootId);
          await assertFolderContained(fs, folder, check.root, true);
        });
        const highest = await highestNamedNumber(
          numbers.library,
          numbers.libraryRoot,
          { rootId: check.rootId, folderName: folder.name, date, kind: CLIP_EXPORT_KIND, caseInsensitive: true },
          signal,
          deps.log,
          deps.numberFs,
        );
        // The point of no return: nothing is awaited between these looks (a cancel; the folder still the one the settings name) and the claim's start.
        signal.throwIfAborted();
        this.#assertNoSwitch(check.root);
        state.pastNoReturn = true;
        let identity: FileIdentity | null = null;
        let claim: Awaited<ReturnType<typeof claimExportName>>;
        try {
          claim = await claimExportName({
            fs: {
              createExclusive: async (path) => {
                identity = await fs.createExclusive(path);
              },
            },
            folder,
            date,
            kind: CLIP_EXPORT_KIND,
            startAt: highest + 1,
          });
        } catch (error) {
          if (error instanceof ExportNamesExhaustedError) throw internal("no free export name is left for today");
          throw exportVolumeFailure(error);
        }
        if (identity === null) throw internal("the claim reported no identity");
        state.placeholder = { path: claim.absPath, identity };
        deps.liveCommits.addPlaceholder(claim.absPath);
        await reached("name-claimed");

        // Containment, the temp and the placeholder are looked at again BEFORE the rename; then the rename, the only move.
        try {
          await assertFolderContained(fs, folder, check.root, true);
          const now = await fs.lstat(temp);
          if (!sameFile(facts, now)) throw internal("the exported file changed after it was checked");
          const placeholder = await fs.lstat(claim.absPath);
          if (placeholder.isSymbolicLink || !placeholder.isFile || placeholder.size !== 0 || placeholder.nlink > 1 || !isIdentity(placeholder, identity)) throw new ContainmentError("the claimed name no longer leads to our placeholder");
          // Temp and placeholder share one folder, so this cannot cross a volume; an EXDEV is a refusal, never a copy.
          await fs.rename(temp, claim.absPath);
          state.placed = true;
          await reached("renamed");
          // ...and AFTER it: the name leads to the temp's own file, of the checked size, in the folder that was checked.
          const placed = await fs.lstat(claim.absPath);
          if (placed.isSymbolicLink || !placed.isFile || placed.nlink > 1 || placed.size !== facts.size || !isIdentity(placed, facts)) throw new ContainmentError("the saved file is not the file that was written");
          const realFolder = await assertFolderContained(fs, folder, check.root, true);
          if (placeOf(nodePath, dirname(await fs.realpath(claim.absPath)), true) !== placeOf(nodePath, realFolder, true)) throw new ContainmentError("the saved file resolves outside its folder");
          await fs.fsyncDir(folder.path);
        } catch (error) {
          throw exportVolumeFailure(error);
        }
        await reached("dir-synced");
        return claim.relPath;
      },
      { signal },
    );

    // 7. The record's line (I5.53: an appended export), once the file is in place under its name.
    const line: ClipExportLine = { rootId: check.rootId, relPath, profile: EXPORT_PROFILE_OF[job.mode], at: exportedAt.toISOString(), bytes: facts.size, sha256 };
    let rewritten: Awaited<ReturnType<ClipRecords["rewrite"]>>;
    try {
      rewritten = await deps.rewrite(job.avatarId, job.clipId, (current) => (current.outcome.status === "ready" ? { ...current, exports: [...current.exports, line] } : null));
    } catch (error) {
      if (error instanceof EngineFailure) throw error;
      throw internal(`the clip's record could not take its export line (${codeOf(error)})`);
    }
    if (rewritten === null) throw internal("the clip is no longer ready");
    state.recorded = true;
    await reached("recorded");
    return { status: "done", exported: { relPath } };
  }

  /** The library's own file stopped the export (I5.54): logged with why, and answered with the detail the window reads as a damaged file, never an intact one (S5.V8 follow-up). */
  #damaged(why: string): EngineFailure {
    this.#deps.log(`[clip] the clip's file in Studio ${why}; the export stops`);
    return internal(CLIP_FILE_DAMAGED_DETAIL);
  }

  /** The library's file as the walker judges it: one H.264 video track (or the refusal, INTERNAL: the file in Studio is the provider's and was judged when it came). */
  async #judge(path: string): Promise<JudgedSource> {
    let probe: Awaited<ReturnType<typeof probeVideo>>;
    try {
      probe = await probeFile(path);
    } catch (error) {
      throw this.#damaged(`cannot be read (${codeOf(error)})`);
    }
    if (!probe.ok) throw this.#damaged(`was refused by the walker (${probe.reason})`);
    const { video } = probe.info;
    if (video.codec !== "h264") throw this.#damaged(`is ${video.codec}, not H.264`);
    if (video.dynamicRange !== "sdr") this.#deps.log(`[clip] the clip is ${video.dynamicRange}; its export is not tone-mapped`);
    return {
      codec: "h264",
      width: video.width,
      height: video.height,
      colour: { matrix: video.colour.matrix, fullRange: video.colour.fullRange, dynamicRange: video.dynamicRange },
      durationMs: pictureMs(probe.info),
    };
  }

  /** The encoded temp is the profile's video: H.264, 1080 x 1920, the mode's rate, one video track and no sound, the source's length. */
  async #checkOutput(path: string, source: JudgedSource, mode: ExportFpsMode): Promise<void> {
    let probe: Awaited<ReturnType<typeof probeVideo>>;
    try {
      probe = await probeFile(path);
    } catch (error) {
      throw internal(`the exported file cannot be read (${codeOf(error)})`);
    }
    if (!probe.ok) throw internal(`the exported file was refused by the walker (${probe.reason})`);
    const { video, audioTracks } = probe.info;
    const rate = EXPORT_RATE_OF[mode];
    const turned = video.rotation === 90 || video.rotation === 270;
    const [width, height] = turned ? [video.height, video.width] : [video.width, video.height];
    const ok =
      video.codec === "h264" &&
      width === EXPORT_WIDTH &&
      height === EXPORT_HEIGHT &&
      Math.abs(video.sourceFps - rate) <= RATE_TOLERANCE &&
      audioTracks === 0 &&
      Math.abs(pictureMs(probe.info) - source.durationMs) <= DURATION_TOLERANCE_MS;
    if (!ok) throw internal(`the exported file is not the profile's video (${video.codec} ${width} x ${height}, ${video.sourceFps} fps, ${audioTracks} sound track(s))`);
  }

  /** What the job made and still owns goes: the placed file (no record names it), else the placeholder (empty, ours) and the temp (ours). Never throws. */
  async #cleanUp(job: ExportJob, state: RunState): Promise<void> {
    if (state.recorded) return;
    const fs = this.#fs;
    const log = this.#deps.log;
    const removeIfOurs = async (what: string, path: string, identity: FileIdentity, shape: (facts: FileFacts) => boolean): Promise<void> => {
      let facts: FileFacts;
      try {
        facts = await fs.lstat(path);
      } catch (error) {
        if (!hasErrorCode(error, "ENOENT")) log(`[clip] ${job.clipId}: could not look at the export's ${what} (${codeOf(error)})`);
        return;
      }
      if (facts.isSymbolicLink || !facts.isFile || !isIdentity(facts, identity) || !shape(facts)) {
        log(`[clip] ${job.clipId}: the export's ${what} is no longer ours; it is left as it is`);
        return;
      }
      await fs.unlink(path).catch((error: unknown) => {
        if (!hasErrorCode(error, "ENOENT")) log(`[clip] ${job.clipId}: could not remove the export's ${what} (${codeOf(error)})`);
      });
    };
    const verified = state.verified;
    if (state.placed && state.placeholder !== null && verified !== null) {
      await removeIfOurs("saved file", state.placeholder.path, verified, (facts) => facts.size === verified.size && facts.mtimeMs === verified.mtimeMs);
    } else {
      if (state.placeholder !== null) await removeIfOurs("placeholder", state.placeholder.path, state.placeholder.identity, (facts) => facts.size === 0);
      if (state.temp !== null && state.tempIdentity !== null) await removeIfOurs("temp file", state.temp, state.tempIdentity, () => true);
    }
    if (state.folder !== null) await fs.fsyncDir(state.folder.path).catch((error: unknown) => log(`[clip] ${job.clipId}: the export folder could not be flushed after the cleanup (${codeOf(error)})`));
  }
}
