import { fromFpsOf, MAX_LISTED_MEDIA, MEZZANINE_FPS, PROTOCOL_VERSION, type EngineError, type ImportPrepare, type ImportResult, type JobState, type MediaKind, type MediaSummary, type MediaUnsupportedReason, type UnsequencedEvent } from "../../shared/engine";
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

/**
 * The importer's own work, as the script says the mock plays it (3f.6). With none the job is a copy and its end, as it was in 3f.1b (the parity
 * suite's older stories hold that); with one the copy is followed by the prepare stage: `total` units from zero, `steps` announcements each a step of the
 * mock's clock apart, never full before the record. Every field is optional: with `{}` the mock counts in the engine's own units (a video's output frames at 30 fps,
 * a track's output milliseconds, three coarse steps for a photo and a sticker), says what the probe would have judged of a video from its facts, and takes up to four steps.
 */
export interface MockMediaPrepare {
  total?: number;
  steps?: number;
  /** What the probe judged (a video's). With none the mock reads it from the facts: `hdrToSdr` and the source rate when it is not 30. A photo, a track and a sticker say none. */
  judged?: ImportPrepare;
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
  /** The importer's own work after the copy (3f.6); absent: none is played. */
  prepare?: MockMediaPrepare;
  /**
   * A track's waveform (3f.4): one value per 50 ms, each 0 to 1000, as the importer's record keeps it. The record carries no such field in the contract; the
   * mock keeps it beside the record. With none, the mock makes a stable one of the track's own length (`defaultWaveform`).
   */
  waveform?: number[];
}

/** A file already in the library, for the dev build and for a test that starts with media (`MockEngine.seedOwnMedia`). */
export interface MockOwnSeed {
  kind: MediaKind;
  name: string;
  bytes: number;
  facts?: Partial<MockMediaFacts>;
  waveform?: number[];
  /** When it was imported; the mock's clock ticks for it when absent. */
  createdAt?: string;
}

/**
 * What the dev build's library holds: one own track (3f.4) and one own video (3f.3b), so the editor has a «свой трек» and a «своё видео» to place. A function, not a
 * constant: a release bundle that drops the mock must not keep it. The track stays FIRST (its id is `media-demo-0001`, which tests and stories name). The video is a
 * landscape clip of 14 s (the mezzanine's size within 1080 x 1920), long enough for a trim and a clip of any length the montage allows.
 */
export function demoOwnMedia(): MockOwnSeed[] {
  return [
    { kind: "audio", name: "demo-voiceover.mp3", bytes: 2_350_000, facts: { durationMs: 74_000 }, createdAt: "2026-09-20T09:00:00.000Z" },
    { kind: "video", name: "demo-clip.mov", bytes: 41_000_000, facts: { width: 1080, height: 608, durationMs: 14_000, sourceFps: 29.97 }, createdAt: "2026-09-21T09:00:00.000Z" },
  ];
}

/** The envelope of a track of `durationMs`, 0 to 1000 per 50 ms: stable (the same length gives the same values), and never flat, so the editor has a waveform to draw. */
export function defaultWaveform(durationMs: number): number[] {
  const steps = Math.max(1, Math.ceil(durationMs / 50));
  return Array.from({ length: steps }, (_, i) => Math.min(1000, 140 + Math.round(620 * Math.abs(Math.sin(i / 11) * Math.cos(i / 37))) + ((i * 41) % 90)));
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
  /** The units `done` counts: the file's bytes (`total` above), then (in the prepare stage) the importer's units (`units`). */
  stage: "copy" | "prepare";
  units: number;
  judged: ImportPrepare | undefined;
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
  /** The own tracks the owner marked «для автопилота» (Stage 4): the engine keeps the mark in an append-only log beside the records. */
  readonly #forAutopilot = new Set<string>();
  /** Each stored track's waveform (3f.4), kept beside its record as the engine keeps it in the record. */
  readonly #waveforms = new Map<string, readonly number[]>();
  /** How many files were seeded: the number in the next seed's id. */
  #seeded = 0;
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
      stage: "copy",
      units: accept.bytes,
      judged: undefined,
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
    const { prepare } = job.accept;
    if (prepare === undefined) {
      job.cancelTimers.push(this.#deps.scheduler.schedule(this.#deps.stepMs, () => this.#end(job)));
      return;
    }
    // The copy is one step, then the importer's work (3f.6): its begin, its steps, and the end.
    job.cancelTimers.push(this.#deps.scheduler.schedule(this.#deps.stepMs, () => this.#prepare(job, prepare)));
  }

  /** The units of a kind's own work, as the engine counts them: a video's output frames, a track's output milliseconds, three coarse steps for a picture. */
  #unitsOf(job: ImportJob, prepare: MockMediaPrepare): number {
    if (prepare.total !== undefined) return prepare.total;
    const facts = { ...DEFAULT_FACTS[job.mediaKind], ...job.accept.facts };
    if (job.mediaKind === "video") return Math.max(1, Math.round(((facts.durationMs ?? 0) * MEZZANINE_FPS) / 1000));
    if (job.mediaKind === "audio") return Math.max(1, facts.durationMs ?? 0);
    return 3;
  }

  /** What the probe would have judged: only a video has anything to say. */
  #judgedOf(job: ImportJob, prepare: MockMediaPrepare): ImportPrepare | undefined {
    if (prepare.judged !== undefined) return prepare.judged;
    if (job.mediaKind !== "video") return undefined;
    const facts = { ...DEFAULT_FACTS.video, ...job.accept.facts };
    return { hdrToSdr: facts.hdrToSdr, fromFps: fromFpsOf(facts.sourceFps ?? MEZZANINE_FPS) };
  }

  /** The copy is over: it is announced whole, the prepare stage begins at zero of its own total, and its steps follow, each a step of the clock apart. */
  #prepare(job: ImportJob, prepare: MockMediaPrepare): void {
    if (job.status !== "running" || !this.#jobs.includes(job)) return;
    const ref = { kind: "import" as const, jobId: job.jobId, mediaKind: job.mediaKind, name: job.name, mediaId: null };
    if (job.cancelRequested) {
      this.#end(job);
      return;
    }
    job.done = job.total;
    this.#event("job.progress", { ...ref, done: job.total, total: job.total });
    const units = this.#unitsOf(job, prepare);
    const steps = Math.max(0, Math.min(prepare.steps ?? 4, units - 1));
    const judged = this.#judgedOf(job, prepare);
    job.stage = "prepare";
    job.units = units;
    job.judged = judged;
    const announce = (done: number): void => {
      job.done = done;
      this.#event("job.progress", { ...ref, done, total: units, stage: "prepare", ...(judged === undefined ? {} : { prepare: judged }) });
    };
    announce(0);
    for (let step = 1; step <= steps; step++) {
      job.cancelTimers.push(
        this.#deps.scheduler.schedule(this.#deps.stepMs * step, () => {
          if (job.status === "running" && !job.cancelRequested && this.#jobs.includes(job)) announce(Math.floor((units * step) / (steps + 1)));
        }),
      );
    }
    job.cancelTimers.push(this.#deps.scheduler.schedule(this.#deps.stepMs * (steps + 1), () => this.#end(job)));
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
    // A job with a prepare stage announced its copy whole before it; the end of one without announces the copy's last step now.
    if (job.accept.prepare === undefined) {
      job.done = job.total;
      this.#event("job.progress", { ...ref, done: job.total, total: job.total });
    }
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
    if (summary.kind === "audio") this.#waveforms.set(summary.mediaId, job.accept.waveform ?? defaultWaveform(summary.durationMs ?? 0));
    this.#event("media.changed", { change: "upserted", media: summary });
    job.status = "done";
    // A finished job counts a full stage, in the units of the stage it ended in (as the engine's registry does).
    job.done = job.stage === "prepare" ? job.units : job.total;
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
  list(kind?: MediaKind, mediaIds?: readonly string[]): { media: MediaSummary[]; total: number } {
    const named = mediaIds === undefined ? undefined : new Set(mediaIds);
    const all = this.#records.filter((r) => (kind === undefined || r.kind === kind) && (named === undefined || named.has(r.mediaId))).reverse();
    return { media: all.slice(0, MAX_LISTED_MEDIA).map((r) => this.#shown(r)), total: all.length };
  }

  /** A record as the contract shows it: a track the owner marked says so; every other record is as it was stored (the mark is absent, not false). */
  #shown(record: MediaSummary): MediaSummary {
    return this.#forAutopilot.has(record.mediaId) ? { ...record, forAutopilot: true } : record;
  }

  /** Marks or unmarks an own track «для автопилота»; the record as it now stands, or undefined for a media that is not a track. */
  setForAutopilot(mediaId: string, on: boolean): MediaSummary | undefined {
    const record = this.#records.find((r) => r.mediaId === mediaId && r.kind === "audio");
    if (record === undefined) return undefined;
    if (on) this.#forAutopilot.add(mediaId);
    else this.#forAutopilot.delete(mediaId);
    const shown = this.#shown(record);
    this.#event("media.changed", { change: "upserted", media: shown });
    return shown;
  }

  /** How many own tracks are marked «для автопилота». */
  flaggedTracks(): number {
    return this.#records.filter((r) => r.kind === "audio" && this.#forAutopilot.has(r.mediaId)).length;
  }

  /** The own tracks marked «для автопилота» that have a length, in the order they were stored: what a launch's videos may be given as music. */
  flaggedTrackList(): { mediaId: string; name: string; durationMs: number }[] {
    return this.#records.flatMap((r) => (r.kind === "audio" && this.#forAutopilot.has(r.mediaId) && r.durationMs !== null ? [{ mediaId: r.mediaId, name: r.name, durationMs: r.durationMs }] : []));
  }

  /** Whether the library holds this media as a PHOTO: what a render's admission and a draft's referential check ask (3f.2). */
  holdsPhoto(mediaId: string): boolean {
    return this.#records.some((r) => r.mediaId === mediaId && r.kind === "photo");
  }

  /** Whether the library holds this media as a STICKER: what a render's admission and a draft's referential check ask for an own sticker (3f.5). */
  holdsSticker(mediaId: string): boolean {
    return this.#records.some((r) => r.mediaId === mediaId && r.kind === "sticker");
  }

  /** The stored sticker's record, or undefined for an id that is not an own sticker here (what `media.stickerBytes` resolves through, 3f.5). */
  stickerOf(mediaId: string): MediaSummary | undefined {
    return this.#records.find((r) => r.mediaId === mediaId && r.kind === "sticker");
  }

  /**
   * Seeds a stored record with no job and no event: the dev build's own sticker (3f.5), there from the start as one stored on disk would be.
   * Its ids are the mock's own and its time is the one the mock keeps, so the ids and times handed out later do not move.
   */
  seedRecord(summary: MediaSummary): void {
    this.#records.push(summary);
  }

  /** Whether the library holds this media as a TRACK a render can read, and how long it is (3f.4): what a render's admission and a draft's referential check ask. */
  holdsTrack(mediaId: string): { readonly durationMs: number } | null {
    const record = this.#records.find((r) => r.mediaId === mediaId && r.kind === "audio");
    return record === undefined || record.durationMs === null ? null : { durationMs: record.durationMs };
  }

  /**
   * Whether the library holds this media as a VIDEO a render can read, and how long its stored mezzanine is (3f.3b): what a render's admission and a draft's referential
   * check ask for an own video clip. Null for a media that is not there, is another kind, or has no length.
   */
  holdsVideo(mediaId: string): { readonly durationMs: number } | null {
    const record = this.#records.find((r) => r.mediaId === mediaId && r.kind === "video");
    return record === undefined || record.durationMs === null || record.width === null || record.height === null ? null : { durationMs: record.durationMs };
  }

  /** The display name of a stored track (3f.4): what the video's tile says of it; undefined for a media that is not there or is not a track. */
  nameOf(mediaId: string): string | undefined {
    return this.#records.find((r) => r.mediaId === mediaId && r.kind === "audio")?.name;
  }

  /** A stored track's waveform (3f.4), or undefined for a media that is not there or is not a track. */
  waveformOf(mediaId: string): readonly number[] | undefined {
    return this.holdsTrack(mediaId) === null ? undefined : this.#waveforms.get(mediaId);
  }

  /**
   * Puts files in the library as if they had been imported (the dev build's demo, a test that starts with media). Nothing is announced: it was there before
   * the window opened. A seed takes NO id from the mock's shared counter and (with a `createdAt` of its own) no tick of its clock, so the demo shifts none of
   * the ids and times the other stories name.
   */
  seed(seeds: readonly MockOwnSeed[]): void {
    for (const seed of seeds) {
      const summary: MediaSummary = {
        mediaId: `media-demo-${String(++this.#seeded).padStart(4, "0")}`,
        kind: seed.kind,
        name: seed.name,
        bytes: seed.bytes,
        createdAt: seed.createdAt ?? this.#deps.nowIso(),
        ...DEFAULT_FACTS[seed.kind],
        ...seed.facts,
      };
      this.#records.push(summary);
      if (seed.kind === "audio") this.#waveforms.set(summary.mediaId, seed.waveform ?? defaultWaveform(summary.durationMs ?? 0));
    }
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
    this.#waveforms.delete(mediaId);
    this.#forAutopilot.delete(mediaId);
    this.#records.splice(at, 1);
    this.#event("media.changed", { change: "removed", mediaId });
    return true;
  }

  /** The import jobs as a snapshot lists them. */
  jobStates(): JobState[] {
    return this.#jobs.map((job): JobState => {
      const staged = job.stage === "prepare" ? { stage: "prepare" as const, total: job.units, ...(job.judged === undefined ? {} : { prepare: job.judged }) } : { total: job.total };
      const common = { kind: "import" as const, jobId: job.jobId, mediaKind: job.mediaKind, name: job.name, mediaId: job.mediaId, done: job.done, ...staged };
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
