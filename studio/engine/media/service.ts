import {
  Id,
  PROTOCOL_VERSION,
  type EngineError,
  type MediaKind,
  type MediaSummary,
  type MediaUnsupportedReason,
  type UnsequencedEvent,
} from "../../shared/engine";
import type { JobRegistry } from "../jobs";
import { MediaCommitError, MediaDiskError, MediaRecords, type MediaRecordsOptions } from "../library/mediaRecords";
import type { MediaImportCall, MediaImporters, MediaImportResult } from "./imports";
import { open } from "node:fs/promises";
import { formatOf, SNIFF_HEAD_BYTES, type MediaFormat } from "./sniff";
import { MediaStaging, type MediaStagingOptions, type OpenedMedia, type StagedMedia, type WorkFile } from "./staging";

// The own-media import JOB (Stage 3, 3f.1b; K29) and the records' commands (K28).
//
// `media.import` is short now: it opens the picked path ONCE (identity, size, the kind its bytes name, the kind's cap, an importer for the
// kind), starts a job and answers its id. Everything that takes time runs INSIDE the job, with `done / total` bytes of progress and a
// cancel that works at every phase:
//
//   waiting (jobs run one at a time)  ->  copy  ->  importer  ->  store the file and write the record  ->  done
//
// The job ends in exactly one of three ways, and in each the staged copy, the importer's work files and the file handle are gone:
//   - done:      the file and its record are durable (`MediaRecords.commit`), then `media.changed`, then `job.done`;
//   - failed:    `MEDIA_UNSUPPORTED` with a `mediaReason`; nothing is stored;
//   - cancelled: `media.cancelImport`, or the engine stopping; nothing is stored. A cancel that lands after the record is durable
//                changes nothing (the media is stored and the job is done).
// The cancel is looked at after the copy and BEFORE the importer is called (an importer is never started for a cancelled job), handed to
// the importer as its signal, looked at again when the importer answers (an answer after the signal is thrown away), and looked at
// inside the commit between the stored file and its record.
//
// The library is held for the whole job: a running import counts in the engine's `#busy()` (`JobRegistry.activeImports`), so a library
// switch is refused with IN_FLIGHT; the hold is dropped only after the cleanup, never before. Jobs run ONE AT A TIME: twenty 2 GiB
// copies at once would thrash one disk, and each one's free-room check would pass before any of them had written a byte.
//
// RESTART. An import that a crash interrupted is CLEANED UP, never resumed: the picked path is kept nowhere (invariant 34), so there is
// nothing to resume from. At a library opening the staging folder is swept (what a crash left, never a copy a running import owns) and
// the records are recovered (an orphan stored file, a record's temp file and a dangling record go; a record that cannot be read or comes
// from a newer Studio is left as it is). The owner picks the file again.

export interface MediaServiceDeps {
  readonly jobs: JobRegistry;
  readonly emit: (event: UnsequencedEvent) => void;
  /** Runs `work` with the live library as a counted small write; refuses like every write (LIBRARY_UNAVAILABLE, IN_FLIGHT during a switch). */
  readonly withLibrary: <T>(work: (library: { readonly root: string }) => Promise<T>) => Promise<T>;
  readonly newId: () => string;
  /** Where a media id comes from; `newId` unless a test needs to name the ids a record is stored under. */
  readonly newMediaId?: (() => string) | undefined;
  readonly now: () => Date;
  readonly importers?: MediaImporters | undefined;
  /** Test knobs: the disk calls, `O_NOFOLLOW`, chunk size and caps of the staging copy. */
  readonly staging?: Pick<MediaStagingOptions, "ops" | "noFollow" | "chunkBytes" | "caps" | "freeBytes" | "freeMarginBytes" | "fs" | "warn"> | undefined;
  /** Test knobs: the records' disk calls and crash points. */
  readonly records?: Pick<MediaRecordsOptions, "fs" | "hooks" | "warn"> | undefined;
  readonly log: (line: string) => void;
  /**
   * Whether a queued or running render uses this media (the render queue's reserved set, as photos have): `media.delete` refuses it
   * (`in-use`) until the render ends. Absent: nothing is reserved. Every task that lifts N9 for a kind of own media (3f.2 photos, 3f.3b
   * video, 3f.4 music, 3f.5 stickers) must wire the real one and test it.
   */
  readonly reservedMedia?: ((mediaId: string) => boolean) | undefined;
  /** How long an importer that ignores the cancel is given before its answer is dropped and the job moves on; 5 s by default. */
  readonly importerGraceMs?: number | undefined;
  /** How long `stop` waits for the jobs to clean up; 10 s by default. */
  readonly stopWaitMs?: number | undefined;
  /** How many imports (queued and running) are taken at once; each holds its file open. 40 by default. */
  readonly maxPendingImports?: number | undefined;
}

interface Area {
  /** Jobs of this library that have not ended: while any is running its area is never replaced (a new staging would not know what the job owns). */
  active: number;
  readonly staging: MediaStaging;
  readonly records: MediaRecords;
  /** The library's crash windows are settled: nothing reads or writes the media folder before this. */
  readonly ready: Promise<void>;
}

type End =
  | { status: "done"; media: MediaSummary }
  | { status: "failed"; reason: MediaUnsupportedReason; detail: string }
  | { status: "cancelled" };

/** How many times a record whose id is already taken is retried with the next id (a collision is a freak: ids are random). */
const COMMIT_ATTEMPTS = 3;
const DEFAULT_IMPORTER_GRACE_MS = 5_000;
const DEFAULT_STOP_WAIT_MS = 10_000;
const DEFAULT_MAX_PENDING_IMPORTS = 40;

/** Resolves with `aborted` once `signal` fires, or with the value of `work`: a wait that must not outlive a cancel. */
function untilAborted<T>(work: Promise<T>, signal: AbortSignal | undefined): Promise<{ aborted: true } | { aborted: false; value: T }> {
  if (signal === undefined) return work.then((value) => ({ aborted: false as const, value }));
  if (signal.aborted) return Promise.resolve({ aborted: true as const });
  return new Promise((resolve, reject) => {
    const onAbort = (): void => resolve({ aborted: true });
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve({ aborted: false, value });
      },
      (error: unknown) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function errorCodeOf(error: unknown): string {
  return error instanceof Error && "code" in error && typeof error.code === "string" ? error.code : "error";
}

/** The first bytes of a file, for a check of what it is. */
async function headOf(path: string): Promise<Uint8Array> {
  const handle = await open(path, "r");
  try {
    const buffer = Buffer.alloc(SNIFF_HEAD_BYTES);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    return Uint8Array.from(buffer.subarray(0, bytesRead));
  } finally {
    await handle.close();
  }
}

/** One stored media as `lookup` answers it. */
export interface MediaLookup {
  readonly summary: MediaSummary;
  readonly path: string;
  readonly sha256: string;
  readonly bytes: number;
  readonly format: MediaFormat;
}

export class MediaService {
  readonly #deps: MediaServiceDeps;
  /** One staging area and record index per library, by the folder's root. */
  readonly #areas = new Map<string, Area>();
  /** The jobs running, so that `settled` and `stop` can wait for their cleanup. */
  readonly #running = new Set<Promise<void>>();
  /** The turn: one job copies and imports at a time. */
  #active = false;
  readonly #waiting: { resolve: (go: boolean) => void }[] = [];
  #stopping = false;

  constructor(deps: MediaServiceDeps) {
    this.#deps = deps;
  }

  // ---------- the library's areas ----------

  #newArea(root: string): Area {
    const importers = this.#deps.importers ?? {};
    const staging = new MediaStaging({
      ...this.#deps.staging,
      root,
      newId: this.#deps.newId,
      supports: (kind) => importers[kind] !== undefined,
    });
    const records = new MediaRecords({
      ...this.#deps.records,
      root,
      newId: this.#deps.newMediaId ?? this.#deps.newId,
      now: this.#deps.now,
      warn: this.#deps.records?.warn ?? ((text) => this.#deps.log(text)),
    });
    // Settled in the background; a copy or a listing waits for it. Neither part throws for a file.
    const ready = (async () => {
      await records.recover();
      await staging.sweep();
    })().catch(() => this.#deps.log("a library's own media could not be read at its opening"));
    return { active: 0, staging, records, ready };
  }

  #areaOf(root: string): Area {
    let area = this.#areas.get(root);
    if (area === undefined) {
      area = this.#newArea(root);
      this.#areas.set(root, area);
    }
    return area;
  }

  /**
   * A library has just become the live one (the engine's start, or a switch): its staging folder is swept and its records are read
   * afresh. In the background; never rejects. A switch is refused while an import runs, so no job owns anything in the library that
   * is being (re)opened; and the sweep leaves what a copy of this staging still holds either way.
   */
  libraryOpened(library: { readonly root: string }): void {
    const known = this.#areas.get(library.root);
    if (known !== undefined && known.active > 0) {
      // A job is running here (the engine does not switch libraries then, but never rely on it): the same staging, which knows what the
      // job owns, does the cleanup.
      void known.staging.sweep();
      return;
    }
    this.#areas.set(library.root, this.#newArea(library.root));
  }

  // ---------- media.import ----------

  /**
   * Opens the picked file and starts its job. `signal` governs this short call only (main's abort, the engine's deadline, shutdown);
   * the job's own cancel is `cancel`. A refusal is a result and starts no job.
   */
  async import(call: MediaImportCall, signal?: AbortSignal): Promise<MediaImportResult> {
    if (this.#stopping) return { ok: false, reason: "cancelled", detail: "the engine is stopping" };
    return this.#deps.withLibrary(async (library) => {
      const area = this.#areaOf(library.root);
      // A cancel does not wait for a recovery that is slow (a dead drive): the call answers cancelled and starts nothing.
      if ((await untilAborted(area.ready, signal)).aborted) return { ok: false, reason: "cancelled", detail: "the import was cancelled" };
      // Each pending job holds its file open: beyond the cap a file is turned away before it is opened.
      if (this.#deps.jobs.activeImports() >= (this.#deps.maxPendingImports ?? DEFAULT_MAX_PENDING_IMPORTS)) {
        return { ok: false, reason: "too-many", detail: "too many imports are waiting; add the file when some have ended" };
      }
      const result = await area.staging.open({ path: call.path, kind: call.pick, expected: call.expected }, signal);
      if (!result.ok) return { ok: false, reason: result.reason, detail: result.detail };
      const { opened } = result;
      const jobId = this.#deps.newId();
      if (!Id.safeParse(jobId).success) {
        await opened.close();
        return { ok: false, reason: "failed", detail: "no job id could be made" };
      }
      // Registered before the call's own hold ends: there is no moment when the library is neither held by the call nor by the job.
      let jobSignal: AbortSignal;
      try {
        // A job that finds the turn taken is queued: it holds its file open and waits.
        jobSignal = this.#deps.jobs.startImport(jobId, { mediaKind: opened.kind, name: call.name }, opened.bytes, { queued: this.#active });
      } catch {
        await opened.close();
        return { ok: false, reason: "failed", detail: "the import could not be registered" };
      }
      this.#announce(jobId);
      area.active++;
      const run: Promise<void> = this.#run(jobId, area, opened, call.name, jobSignal).finally(() => {
        area.active--;
        this.#running.delete(run);
      });
      this.#running.add(run);
      return { ok: true, jobId };
    });
  }

  /** `media.cancelImport`: true for an import job of this engine (a finished one stays as it ended); false for any other job or an unknown one. */
  cancel(jobId: string): boolean {
    if (this.#deps.jobs.stateOf(jobId)?.kind !== "import") return false;
    this.#deps.jobs.cancel(jobId);
    return true;
  }

  /** Resolves once the recovery of every opened library and every running import (and its cleanup) are done. Tests wait on it; nothing else does. */
  async settled(): Promise<void> {
    while (this.#running.size > 0) await Promise.allSettled([...this.#running]);
    await Promise.allSettled([...this.#areas.values()].map((area) => area.ready));
  }

  /**
   * The engine stops: no import is taken, every queued and running one is cancelled, and this returns once each has cleaned up, or after
   * `stopWaitMs` (an importer that ignores the cancel must not keep the engine from stopping).
   */
  async stop(): Promise<void> {
    this.#stopping = true;
    for (const state of this.#deps.jobs.states()) if (state.kind === "import" && (state.status === "running" || state.status === "queued")) this.#deps.jobs.cancel(state.jobId);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const bound = new Promise<void>((resolve) => {
      timer = setTimeout(resolve, this.#deps.stopWaitMs ?? DEFAULT_STOP_WAIT_MS);
    });
    await Promise.race([this.settled(), bound]);
    clearTimeout(timer);
  }

  // ---------- the records ----------

  async list(kind?: MediaKind, mediaIds?: readonly string[]): Promise<{ media: MediaSummary[]; total: number }> {
    return this.#deps.withLibrary(async (library) => {
      const area = this.#areaOf(library.root);
      await area.ready;
      return area.records.list(kind, mediaIds);
    });
  }

  /**
   * One stored media as the engine itself reads it (never a window): its summary, the file's path, and what the record holds to check the
   * file against (size, sha256, container). Undefined for an id the library does not hold, or holds as another kind than the one asked for.
   * This is the seam of the per-kind tasks: the referential check («own media exists and has the right kind»), and the render's copy of
   * a stored file, which checks it again before it reads.
   *
   * `onFound` is the render's ADMISSION (3f.2, fix round 3 M1): it runs SYNCHRONOUSLY, in the same step that reads the record and before
   * the answer travels back, so a render reserves the media with no await between the lookup and the reservation. `media.delete` takes a
   * media out of the index in its first tick and only then asks the reserved provider, so a media is either found here and then refused
   * to the delete (`in-use`), or already gone from this lookup. It is not called for a media that is not found; a throw from it is the
   * lookup's own.
   */
  async lookup(
    mediaId: string,
    kind?: MediaKind,
    onFound?: (found: MediaLookup) => void,
  ): Promise<MediaLookup | undefined> {
    return this.#deps.withLibrary(async (library) => {
      const area = this.#areaOf(library.root);
      await area.ready;
      const summary = area.records.get(mediaId);
      const path = area.records.filePath(mediaId);
      const integrity = area.records.integrityOf(mediaId);
      if (summary === undefined || path === undefined || integrity === undefined || (kind !== undefined && summary.kind !== kind)) return undefined;
      const found = { summary, path, ...integrity };
      onFound?.(found);
      return found;
    });
  }

  /**
   * A stored track's waveform (3f.4: one value per 50 ms, 0 to 1000), for `music.peaks`; undefined for an id the library does not hold, a media that
   * is not a track, or a record whose waveform cannot be trusted. Read from the record on disk; a media being deleted is out of it from the first tick.
   */
  async waveform(mediaId: string): Promise<number[] | undefined> {
    return this.#deps.withLibrary(async (library) => {
      const area = this.#areaOf(library.root);
      await area.ready;
      return area.records.waveformOf(mediaId);
    });
  }

  /** Which of `mediaIds` the library holds as `kind` (a draft's referential check): one pass under one hold. A media being deleted is not held. */
  async holding(mediaIds: readonly string[], kind: MediaKind): Promise<Set<string>> {
    return this.#deps.withLibrary(async (library) => {
      const area = this.#areaOf(library.root);
      await area.ready;
      const held = new Set<string>();
      for (const mediaId of mediaIds) if (area.records.get(mediaId)?.kind === kind) held.add(mediaId);
      return held;
    });
  }

  /**
   * Removes the file and its record. `not-found` for an id the library does not hold; `in-use` while a queued or running render uses it
   * (the reserved provider: the plan keeps a draft's reference and reads it as `media-unavailable`, but a render in flight reads the file);
   * otherwise `deleted`. A disk that fails throws `MediaDiskError` (no path in it).
   */
  async delete(mediaId: string): Promise<"deleted" | "not-found" | "in-use"> {
    return this.#deps.withLibrary(async (library) => {
      const area = this.#areaOf(library.root);
      await area.ready;
      if (!area.records.has(mediaId)) return "not-found";
      if (this.#deps.reservedMedia?.(mediaId) === true) return "in-use";
      const removed = await area.records.remove(mediaId);
      if (!removed) return "not-found";
      this.#event("media.changed", { change: "removed", mediaId });
      return "deleted";
    });
  }

  // ---------- the job ----------

  async #run(jobId: string, area: Area, opened: OpenedMedia, name: string, signal: AbortSignal): Promise<void> {
    let end: End;
    try {
      end = await this.#execute(jobId, area, opened, name, signal);
    } catch (error) {
      // A bug or a disk failure that nothing below classified: only the fact and the code travel, never a message that may name a path.
      this.#deps.log(`import job ${jobId} failed unexpectedly (${errorCodeOf(error)})`);
      end = { status: "failed", reason: "failed", detail: "the import failed" };
    }
    try {
      // The handle goes before the job is told to be over; the staged copy and the work files already went.
      await opened.close();
    } finally {
      this.#finish(jobId, opened.kind, name, end);
    }
  }

  async #execute(jobId: string, area: Area, opened: OpenedMedia, name: string, signal: AbortSignal): Promise<End> {
    if (!(await this.#turn(signal))) return { status: "cancelled" };
    // Its turn came: a job that waited is announced again, now running.
    if (this.#deps.jobs.startImportRunning(jobId)) this.#announce(jobId);
    const works: WorkFile[] = [];
    // Sealed when the job ends: an importer that was dropped (it ignored the cancel) and asks for a file later gets none, so nothing is
    // created that no cleanup would ever take (a held name is skipped by the staging's sweep).
    let sealed = false;
    let staged: StagedMedia | null = null;
    try {
      let lastPercent = 0;
      const copy = await opened.copy({
        signal,
        onProgress: (copied, total) => {
          const percent = total === 0 ? 100 : Math.floor((copied * 100) / total);
          const payload = this.#deps.jobs.progress(jobId, copied);
          if (payload !== null && percent > lastPercent) {
            lastPercent = percent;
            this.#event("job.progress", payload);
          }
        },
      });
      if (!copy.ok) return copy.reason === "cancelled" ? { status: "cancelled" } : { status: "failed", reason: copy.reason, detail: copy.detail };
      staged = copy.staged;

      // Looked at BEFORE the importer is called: a cancel that landed during the last step of the copy never starts one.
      if (signal.aborted) return { status: "cancelled" };
      const importer = this.#deps.importers?.[staged.kind];
      if (importer === undefined) return { status: "failed", reason: "not-yet-supported", detail: `${staged.kind} files cannot be imported yet` };
      const answered = importer({
        staged,
        name,
        signal,
        workFile: async () => {
          if (sealed) throw new Error("the import has ended");
          const work = await area.staging.workFile();
          if (sealed) {
            // The job ended while the name was being made: it is let go at once, never left held.
            await work.release();
            throw new Error("the import has ended");
          }
          works.push(work);
          return work;
        },
      }).then(
        (value) => ({ answer: "value" as const, value }),
        () => ({ answer: "threw" as const }),
      );
      // An importer owes the job a stop within seconds of the signal. One that does not is given a grace window, and then its answer
      // is dropped, its work files are released and the turn moves on: a hung importer must not hold every later import and the library.
      const grace = this.#graceAfterAbort(signal);
      const given = await Promise.race([answered, grace.promise]);
      grace.cancel();
      if (given.answer === "hung") {
        this.#deps.log(`import job ${jobId}: the importer did not stop after the cancel; its answer is dropped`);
        return { status: "cancelled" };
      }
      // The importer's own message may name its working files: only the fact travels.
      if (given.answer === "threw") return { status: "failed", reason: "failed", detail: "the importer failed" };
      const outcome = given.value;
      // Whatever an importer answers after the signal is thrown away; its work files are released below.
      if (signal.aborted) return { status: "cancelled" };
      if (!outcome.ok) return outcome.reason === "cancelled" ? { status: "cancelled" } : { status: "failed", reason: outcome.reason, detail: `the file was refused: ${outcome.reason}` };

      // The container an importer declares is its word: the file's own first bytes must say the same (the staged copy was judged by the staging).
      if (outcome.output !== undefined) {
        let actual: MediaFormat | null = null;
        try {
          actual = formatOf(await headOf(outcome.output.file.path));
        } catch {
          return { status: "failed", reason: "failed", detail: "the importer's file could not be read" };
        }
        if (actual !== outcome.output.format) return { status: "failed", reason: "failed", detail: "the importer's file is not the container it says" };
      }

      const input = {
        sourcePath: outcome.output?.file.path ?? staged.path,
        kind: staged.kind,
        format: outcome.output?.format ?? staged.format,
        name,
        facts: outcome.facts,
        ...(outcome.waveform === undefined ? {} : { waveform: outcome.waveform }),
        ...(outcome.output === undefined ? { sha256: staged.sha256 } : outcome.output.sha256 === undefined ? {} : { sha256: outcome.output.sha256 }),
      };
      let media: MediaSummary;
      for (let attempt = 1; ; attempt++) {
        try {
          media = await area.records.commit(input, signal);
          break;
        } catch (error) {
          if (error instanceof MediaCommitError && error.code === "exists" && attempt < COMMIT_ATTEMPTS) continue;
          return endOfCommitFailure(error);
        }
      }
      // Told at once, before anything else can happen to the record: a delete that lands while the job cleans up is announced after it.
      this.#event("media.changed", { change: "upserted", media });
      return { status: "done", media };
    } finally {
      // Before the job ends and drops the library hold: the staged copy and every work file are gone whichever way it ended. The turn
      // is handed on whatever the cleanup does: a failing disposal must not stop every later import.
      sealed = true;
      try {
        await staged?.dispose();
        for (const work of works) await work.release();
      } finally {
        this.#release();
      }
    }
  }

  /** Resolves `hung` a grace window after `signal` fires; `cancel` stops the wait when the importer answered first. */
  #graceAfterAbort(signal: AbortSignal): { promise: Promise<{ answer: "hung" }>; cancel: () => void } {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let onAbort: (() => void) | undefined;
    const promise = new Promise<{ answer: "hung" }>((resolve) => {
      const start = (): void => {
        timer = setTimeout(() => resolve({ answer: "hung" }), this.#deps.importerGraceMs ?? DEFAULT_IMPORTER_GRACE_MS);
      };
      if (signal.aborted) start();
      else {
        onAbort = start;
        signal.addEventListener("abort", start, { once: true });
      }
    });
    return {
      promise,
      cancel: () => {
        clearTimeout(timer);
        if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
      },
    };
  }

  #finish(jobId: string, mediaKind: MediaKind, name: string, end: End): void {
    const ref = { kind: "import" as const, jobId, mediaKind, name, mediaId: null };
    switch (end.status) {
      case "done": {
        const state = this.#deps.jobs.finishImport(jobId, { status: "done", result: { kind: "import", mediaId: end.media.mediaId, media: end.media } });
        if (state === null || state.kind !== "import" || state.result === undefined) return;
        this.#event("job.done", { jobId, result: state.result });
        return;
      }
      case "failed": {
        const error: EngineError = { code: "MEDIA_UNSUPPORTED", mediaReason: end.reason, detail: end.detail };
        if (this.#deps.jobs.finishImport(jobId, { status: "failed", error }) !== null) this.#event("job.failed", { ...ref, error });
        return;
      }
      case "cancelled":
        if (this.#deps.jobs.finishImport(jobId, { status: "cancelled" }) !== null) this.#event("job.cancelled", ref);
        return;
    }
  }

  // ---------- the turn: one import at a time ----------

  /** Resolves true when it is this job's turn, false when the job was cancelled while it waited (it then never takes the turn). */
  #turn(signal: AbortSignal): Promise<boolean> {
    if (signal.aborted) return Promise.resolve(false);
    if (!this.#active) {
      this.#active = true;
      return Promise.resolve(true);
    }
    return new Promise<boolean>((resolve) => {
      const entry = { resolve };
      this.#waiting.push(entry);
      signal.addEventListener(
        "abort",
        () => {
          const at = this.#waiting.indexOf(entry);
          if (at === -1) return;
          this.#waiting.splice(at, 1);
          resolve(false);
        },
        { once: true },
      );
    });
  }

  /** Hands the turn to the next waiting job, or frees it. */
  #release(): void {
    const next = this.#waiting.shift();
    if (next === undefined) this.#active = false;
    else next.resolve(true);
  }

  // ---------- events ----------

  /** Announces a queued or running import at zero (`queued: true` while it waits). */
  #announce(jobId: string): void {
    const payload = this.#deps.jobs.announceImport(jobId);
    if (payload !== null) this.#event("job.progress", payload);
  }

  #event<T extends UnsequencedEvent["type"]>(type: T, payload: Extract<UnsequencedEvent, { type: T }>["payload"]): void {
    this.#deps.emit({ v: PROTOCOL_VERSION, id: this.#deps.newId(), kind: "event", type, payload } as UnsequencedEvent);
  }
}

/** What a commit that did not happen is, as the job's end. The message never names a path. */
function endOfCommitFailure(error: unknown): End {
  if (error instanceof MediaCommitError) {
    if (error.code === "cancelled") return { status: "cancelled" };
    if (error.code === "disk") return { status: "failed", reason: "unreadable", detail: error.message };
    return { status: "failed", reason: "failed", detail: error.message };
  }
  if (error instanceof MediaDiskError) return { status: "failed", reason: "unreadable", detail: error.message };
  return { status: "failed", reason: "failed", detail: "the media could not be stored" };
}
