import { MAX_LISTED_MEDIA, PROTOCOL_VERSION, type EngineError, type ImportResult, type JobState, type MediaKind, type MediaSummary, type MediaUnsupportedReason, type UnsequencedEvent } from "../../shared/engine";
import type { Scheduler } from "./scheduler";

// The mock's own media (3f.1b): the engine's import jobs and records, on the mock's clock. The mock copies nothing and keeps no path: the
// dialog's script names a file by its DISPLAY NAME and says what the engine would learn of it (`MockMediaAccept`). An accepted file starts
// a job that ends in a record; a cancelled job stores nothing; a restart keeps the records (they are on disk) and drops the jobs (they are
// in memory). The parity suite (studio/engine/parity) holds this and the engine side by side; what differs on purpose is listed in
// transcript.ts.

/** What the engine's importer would say of a file: the facts a record holds (the contract's `MediaSummary`). */
export interface MockMediaFacts {
  width: number | null;
  height: number | null;
  durationMs: number | null;
  sourceFps: number | null;
  hdrToSdr: boolean;
  loopFrames: number | null;
  delayFrames: number[] | null;
}

/** A file the script accepts: its kind, its size in bytes (the job's `total`) and, when the story cares, the facts of its record. */
export interface MockMediaAccept {
  kind: MediaKind;
  bytes: number;
  facts?: Partial<MockMediaFacts>;
  /**
   * A photo whose face the detector would find (3f.2): `montages.focus` of it answers a point, not null. The record carries no such field; the
   * mock keeps it beside the record, as the engine keeps the face in pixels.
   */
  face?: boolean;
  /** The kind's importer turns the file away INSIDE the job (3f.2: `too-small`, `dimensions`, `animated-webp`, `format`...): the job fails with MEDIA_UNSUPPORTED and stores nothing. */
  failWith?: MediaUnsupportedReason;
}

const NO_FACTS: MockMediaFacts = { width: null, height: null, durationMs: null, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null };

/** What a kind's record has when the script says nothing: the fields the contract gives that kind, with plausible values. */
const DEFAULT_FACTS: Readonly<Record<MediaKind, MockMediaFacts>> = {
  photo: { ...NO_FACTS, width: 1080, height: 1440 },
  video: { ...NO_FACTS, width: 1080, height: 1920, durationMs: 6400, sourceFps: 30 },
  audio: { ...NO_FACTS, durationMs: 95_000 },
  sticker: { ...NO_FACTS, width: 320, height: 320, loopFrames: 6, delayFrames: [2, 2, 2] },
};

/** The most imports (queued and running) taken at once, as the engine takes them: each holds its file open. */
export const MOCK_MAX_PENDING_IMPORTS = 40;

/** A cancel that nothing holds ends the job after this long (the real engine's copy sees it between two chunks). */
const CANCEL_DELAY_MS = 50;

interface ImportJob {
  readonly jobId: string;
  readonly mediaKind: MediaKind;
  readonly name: string;
  readonly total: number;
  readonly accept: MockMediaAccept;
  done: number;
  status: "queued" | "running" | "done" | "failed" | "cancelled";
  mediaId: string | null;
  result: ImportResult | undefined;
  error: EngineError | undefined;
  cancelRequested: boolean;
  cancelTimers: (() => void)[];
}

export interface MockOwnMediaDeps {
  readonly scheduler: Scheduler;
  /** How long an accepted file's job runs before it ends. */
  readonly stepMs: number;
  readonly nextId: (prefix: string) => string;
  readonly nowIso: () => string;
  readonly emit: (event: UnsequencedEvent) => void;
}

export class MockOwnMedia {
  readonly #deps: MockOwnMediaDeps;
  /** In the order they were stored; the mock's clock moves on at every record, so this is also the order of `createdAt`. */
  #records: MediaSummary[] = [];
  /** The own photos the script says have a face (3f.2). */
  readonly #faces = new Set<string>();
  #jobs: ImportJob[] = [];
  /** Jobs that started while imports were held and wait for the let-go. */
  #waiting: ImportJob[] = [];
  #held = false;

  constructor(deps: MockOwnMediaDeps) {
    this.#deps = deps;
  }

  #event<T extends UnsequencedEvent["type"]>(type: T, payload: Extract<UnsequencedEvent, { type: T }>["payload"]): void {
    this.#deps.emit({ v: PROTOCOL_VERSION, id: this.#deps.nextId("evt"), kind: "event", type, payload } as UnsequencedEvent);
  }

  /** Starts the job of an accepted file and announces it at zero; its id, or null when too many are pending (the engine's `too-many`). */
  startImport(name: string, accept: MockMediaAccept): string | null {
    if (this.active() >= MOCK_MAX_PENDING_IMPORTS) return null;
    const job: ImportJob = {
      jobId: this.#deps.nextId("job"),
      mediaKind: accept.kind,
      name,
      total: accept.bytes,
      accept,
      done: 0,
      status: "running",
      mediaId: null,
      result: undefined,
      error: undefined,
      cancelRequested: false,
      cancelTimers: [],
    };
    // As the engine: imports run one at a time, and one that finds the turn taken waits in its queue, announced queued.
    if (this.active() > 0) job.status = "queued";
    this.#jobs.push(job);
    this.#announce(job);
    if (job.status === "running") this.#startRunning(job);
    return job.jobId;
  }

  /** How many imports are queued or running: the library is held for them, as the engine's `#busy()` holds it. */
  active(): number {
    return this.#jobs.filter((job) => job.status === "queued" || job.status === "running").length;
  }

  #announce(job: ImportJob): void {
    this.#event("job.progress", { kind: "import", jobId: job.jobId, mediaKind: job.mediaKind, name: job.name, mediaId: null, done: 0, total: job.total, ...(job.status === "queued" ? { queued: true } : {}) });
  }

  #startRunning(job: ImportJob): void {
    if (this.#held) this.#waiting.push(job);
    else this.#scheduleEnd(job);
  }

  /** The turn is free: the first job that waits runs, and is announced again at zero. */
  #promote(): void {
    // A job whose cancel is on its way never takes the turn.
    const next = this.#jobs.find((job) => job.status === "queued" && !job.cancelRequested);
    if (next === undefined || this.#jobs.some((job) => job.status === "running")) return;
    next.status = "running";
    this.#announce(next);
    this.#startRunning(next);
  }

  #scheduleEnd(job: ImportJob): void {
    job.cancelTimers.push(this.#deps.scheduler.schedule(this.#deps.stepMs, () => this.#end(job)));
  }

  /** While held, a job that starts waits for the let-go; letting go (false) sets every waiting job going. */
  hold(held: boolean): void {
    this.#held = held;
    if (held) return;
    for (const job of this.#waiting.splice(0)) this.#scheduleEnd(job);
  }

  #end(job: ImportJob): void {
    if (job.status !== "running" || !this.#jobs.includes(job)) return;
    const ref = { kind: "import" as const, jobId: job.jobId, mediaKind: job.mediaKind, name: job.name, mediaId: null };
    if (job.cancelRequested) {
      job.status = "cancelled";
      this.#event("job.cancelled", ref);
      this.#promote();
      return;
    }
    job.done = job.total;
    this.#event("job.progress", { ...ref, done: job.total, total: job.total });
    if (job.accept.failWith !== undefined) {
      // The copy is done and the importer turns the file away: the job fails with its reason, nothing is stored, the next job takes its turn.
      const error: EngineError = { code: "MEDIA_UNSUPPORTED", mediaReason: job.accept.failWith, detail: `the file was refused: ${job.accept.failWith}` };
      job.status = "failed";
      job.error = error;
      this.#event("job.failed", { ...ref, error });
      this.#promote();
      return;
    }
    const summary: MediaSummary = {
      mediaId: this.#deps.nextId("media"),
      kind: job.mediaKind,
      name: job.name,
      bytes: job.total,
      createdAt: this.#deps.nowIso(),
      ...DEFAULT_FACTS[job.mediaKind],
      ...job.accept.facts,
    };
    this.#records.push(summary);
    if (job.accept.face === true) this.#faces.add(summary.mediaId);
    this.#event("media.changed", { change: "upserted", media: summary });
    job.status = "done";
    job.mediaId = summary.mediaId;
    job.result = { kind: "import", mediaId: summary.mediaId, media: summary };
    this.#event("job.done", { jobId: job.jobId, result: job.result });
    this.#promote();
  }

  /** `media.cancelImport`: false for a job that is not an import here; a finished job stays as it ended. */
  cancel(jobId: string): boolean {
    const job = this.#jobs.find((j) => j.jobId === jobId);
    if (job === undefined) return false;
    if (job.status === "queued") {
      // A job still in its queue has copied nothing and ends soon, AFTER the answer (the engine's job closes its file first).
      job.cancelRequested = true;
      job.cancelTimers.push(
        this.#deps.scheduler.schedule(CANCEL_DELAY_MS, () => {
          if (job.status !== "queued" || !this.#jobs.includes(job)) return;
          job.status = "cancelled";
          this.#event("job.cancelled", { kind: "import", jobId: job.jobId, mediaKind: job.mediaKind, name: job.name, mediaId: null });
        }),
      );
      return true;
    }
    if (job.status !== "running") return true;
    job.cancelRequested = true;
    // A job still held ends when it is let go; one that is running ends soon on the clock.
    if (!this.#waiting.includes(job)) job.cancelTimers.push(this.#deps.scheduler.schedule(CANCEL_DELAY_MS, () => this.#end(job)));
    return true;
  }

  /** Newest first, cut as the engine cuts it: the contract's 500. */
  list(kind?: MediaKind): { media: MediaSummary[]; total: number } {
    const all = this.#records.filter((r) => kind === undefined || r.kind === kind).reverse();
    return { media: all.slice(0, MAX_LISTED_MEDIA), total: all.length };
  }

  /** Whether the library holds this media as a PHOTO: what a render's admission and a draft's referential check ask (3f.2). */
  holdsPhoto(mediaId: string): boolean {
    return this.#records.some((r) => r.mediaId === mediaId && r.kind === "photo");
  }

  /** Whether the library holds this media, of any kind (`media.delete` answers NOT_FOUND before it asks the reserved set). */
  has(mediaId: string): boolean {
    return this.#records.some((r) => r.mediaId === mediaId);
  }

  /** Whether the detector would find a face in this own photo (3f.2), as the script said. */
  hasFace(mediaId: string): boolean {
    return this.#faces.has(mediaId);
  }

  /** Removes a record and announces it; false for an id it does not hold. */
  delete(mediaId: string): boolean {
    const at = this.#records.findIndex((r) => r.mediaId === mediaId);
    if (at < 0) return false;
    this.#faces.delete(mediaId);
    this.#records.splice(at, 1);
    this.#event("media.changed", { change: "removed", mediaId });
    return true;
  }

  /** The import jobs as a snapshot lists them. */
  jobStates(): JobState[] {
    return this.#jobs.map((job): JobState => {
      const common = { kind: "import" as const, jobId: job.jobId, mediaKind: job.mediaKind, name: job.name, mediaId: job.mediaId, done: job.done, total: job.total };
      if (job.status === "done" && job.result !== undefined) return { ...common, status: "done", result: job.result };
      if (job.status === "failed" && job.error !== undefined) return { ...common, status: "failed", error: job.error };
      return { ...common, status: job.status === "cancelled" ? "cancelled" : job.status === "queued" ? "queued" : "running" };
    });
  }

  /** The engine process restarts: the records are on disk and stay, the jobs were in memory and are gone with it, with whatever they were about to store. */
  restart(): void {
    for (const job of this.#jobs) for (const cancel of job.cancelTimers) cancel();
    this.#jobs = [];
    this.#waiting = [];
  }
}
