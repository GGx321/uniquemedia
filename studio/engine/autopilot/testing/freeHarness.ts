import type { LogLine } from "../../../shared/engine/autopilot";
import type { MontageDraft } from "../../../shared/engine/montage";
import type { TrackChoice, TrackUsage } from "../../../shared/autopilot/track";
import { emptyUsage } from "../../../shared/autopilot/track";
import { EngineFailure } from "../../engineFailure";
import type { FocusResult } from "../../focus/focusResolver";
import type { InternalRenderInput } from "../../videos/service";
import type { FreeLibrary, FreeStepsDeps, RenderLife } from "../freeSteps";
import { LaunchFile } from "../launchFile";
import type { PlanPhoto } from "../planner";
import type { KeyFinding, ProvenanceScan, VideoLookup } from "../provenanceScan";
import type { LaunchStepsContext } from "../steps";

// Test-only doubles for the free steps (S4.6c1): a launch held in memory behind the steps' context, a library of plain photos, a video service whose renders the test ends, and a provenance
// reader the test scripts. They keep the contract the real ones have (the context refuses writes while paused, the file is re-parsed on every write) so a step that breaks it fails here.

// ---------- the launch behind the context ----------

export interface MemoryLaunch {
  readonly ctx: LaunchStepsContext;
  file(): LaunchFile;
  readonly logs: LogLine[];
  readonly finished: () => boolean;
  /** True from `pause()` until `resume()`: the context says «not running» and refuses writes once `settlePause()` ran. */
  pause(): void;
  settlePause(): void;
  resume(): void;
  updates: number;
}

export function memoryLaunch(initial: LaunchFile, clock: () => number = () => Date.parse("2026-10-09T10:00:00.000Z")): MemoryLaunch {
  let file = initial;
  let pausing = false;
  let paused = false;
  let done = false;
  const logs: LogLine[] = [];
  const self: MemoryLaunch = {
    updates: 0,
    logs,
    file: () => file,
    finished: () => done,
    pause: () => {
      pausing = true;
    },
    settlePause: () => {
      paused = true;
      file = LaunchFile.parse({ ...file, status: "paused", paused: { cause: "owner", at: new Date(clock()).toISOString() }, activeSince: null });
    },
    resume: () => {
      pausing = false;
      paused = false;
      file = LaunchFile.parse({ ...file, status: "running", paused: null, activeSince: new Date(clock()).toISOString() });
    },
    ctx: {
      launchId: initial.launchId,
      // The steps under test never touch the registry or the groups (those are the paid path's).
      registry: undefined as never,
      groups: undefined as never,
      file: () => file,
      isRunning: () => !pausing && !paused && !done && file.status === "running",
      update: async (change) => {
        if (file.status !== "running" && file.status !== "stopping") throw new Error(`launch ${file.launchId} is ${file.status}: nothing of it continues`);
        const next = change(file);
        if (next === null) return file;
        file = LaunchFile.parse({ ...next, revision: file.revision + 1, updatedAt: new Date(clock()).toISOString() });
        self.updates += 1;
        return file;
      },
      setPaidHold: async (hold) => self.ctx.update((f) => ({ ...f, paidHold: hold })),
      setFreeHold: async (hold) => self.ctx.update((f) => ({ ...f, freeHold: hold })),
      log: async (line) => {
        logs.push(line);
      },
      finish: async () => {
        if (file.status !== "running") throw new Error(`launch ${file.launchId} is ${file.status}: only a running launch finishes`);
        done = true;
        const at = new Date(clock()).toISOString();
        file = LaunchFile.parse({ ...file, status: "done", endedAt: at, activeSince: null, revision: file.revision + 1, updatedAt: at });
        return file;
      },
    },
  };
  return self;
}

// ---------- a library of plain photos ----------

export class FakeLibrary implements FreeLibrary {
  readonly root = "/fake-library";
  readonly #photos = new Map<string, PlanPhoto[]>();
  readonly #usageBroken = new Set<string>();
  readonly #runs = new Map<string, string[]>();
  snapshots = 0;

  add(avatarId: string, photos: readonly PlanPhoto[]): this {
    this.#photos.set(avatarId, [...(this.#photos.get(avatarId) ?? []), ...photos]);
    return this;
  }

  snapshot(avatarId: string): { usageOk: boolean; photos: readonly PlanPhoto[] } {
    this.snapshots += 1;
    return { usageOk: !this.#usageBroken.has(avatarId), photos: (this.#photos.get(avatarId) ?? []).map((p) => ({ ...p })) };
  }

  photoIdsOfRun(avatarId: string, runId: string): string[] {
    return [...(this.#runs.get(`${avatarId}:${runId}`) ?? [])];
  }

  setRun(avatarId: string, runId: string, photoIds: readonly string[]): void {
    this.#runs.set(`${avatarId}:${runId}`, [...photoIds]);
  }

  breakUsage(avatarId: string, broken = true): void {
    if (broken) this.#usageBroken.add(avatarId);
    else this.#usageBroken.delete(avatarId);
  }

  /** Changes a photo the way the library's own verdict changes (a reject, a use, a reservation). */
  patch(photoId: string, change: Partial<PlanPhoto>): void {
    for (const photos of this.#photos.values()) {
      const at = photos.findIndex((p) => p.id === photoId);
      if (at >= 0) photos[at] = { ...(photos[at] as PlanPhoto), ...change };
    }
  }

  find(photoId: string): PlanPhoto | undefined {
    for (const photos of this.#photos.values()) {
      const found = photos.find((p) => p.id === photoId);
      if (found !== undefined) return found;
    }
    return undefined;
  }
}

// ---------- the provenance the library says ----------

export class FakeProvenance {
  readonly records = new Map<string, { videoId: string; durationMs: number; bytes: number }>();
  readonly intents = new Map<string, string>();
  readonly unreadable = new Set<string>();
  complete = true;
  scans = 0;
  lookups = 0;

  scan = async (_root: string, _avatarId: string, _launchId: string): Promise<ProvenanceScan> => {
    this.scans += 1;
    const byKey = new Map<string, KeyFinding>();
    for (const [key, intent] of this.intents) byKey.set(key, { kind: "intent", videoId: intent });
    for (const [key, record] of this.records) byKey.set(key, { kind: "record", ...record });
    return { byKey, complete: this.complete };
  };

  lookup = async (_root: string, _avatarId: string, videoId: string): Promise<VideoLookup> => {
    this.lookups += 1;
    if (this.unreadable.has(videoId)) return { kind: "unreadable" };
    for (const record of this.records.values()) if (record.videoId === videoId) return { kind: "record", durationMs: record.durationMs, bytes: record.bytes };
    return { kind: "missing" };
  };
}

// ---------- the video service ----------

export interface FakeJob {
  jobId: string;
  videoId: string;
  key: string;
  avatarId: string;
  input: InternalRenderInput;
  life: RenderLife;
}

/** A video service whose renders the test ends. `auto` ends each one by itself on the next turn, as a fast render would. */
export class FakeVideos {
  readonly calls: InternalRenderInput[] = [];
  readonly jobs = new Map<string, FakeJob>();
  readonly #fail: Array<Error | ((input: InternalRenderInput) => Error)> = [];
  #settled: Promise<void> = Promise.resolve();
  settledCalls = 0;
  maxUnfinished = 0;
  /** What a finished job writes to the library: set by the test (the provenance fake). */
  onDone: (job: FakeJob) => void = () => undefined;
  auto = false;
  #n = 0;

  constructor(private readonly provenance?: FakeProvenance) {}

  holdSettled(): () => void {
    let release = (): void => undefined;
    this.#settled = new Promise<void>((resolve) => {
      release = resolve;
    });
    return release;
  }

  /** The next calls throw these (a function sees the input, so a test can change the world at the moment of the failure). */
  failNext(...errors: Array<Error | ((input: InternalRenderInput) => Error)>): void {
    this.#fail.push(...errors);
  }

  readonly videos = {
    renderInternal: async (input: InternalRenderInput): Promise<{ jobId: string; videoId: string }> => {
      this.calls.push(input);
      const scripted = this.#fail.shift();
      if (scripted !== undefined) throw typeof scripted === "function" ? scripted(input) : scripted;
      this.#n += 1;
      const jobId = `job-${String(this.#n).padStart(8, "0")}`;
      const videoId = `video-${String(this.#n).padStart(8, "0")}`;
      const job: FakeJob = { jobId, videoId, key: input.provenance.launchVideoKey, avatarId: input.spec.avatarId, input, life: "running" };
      this.jobs.set(jobId, job);
      this.maxUnfinished = Math.max(this.maxUnfinished, this.unfinished());
      if (this.auto) setTimeout(() => this.finish(jobId, "done"), 0);
      return { jobId, videoId };
    },
    settled: async (): Promise<void> => {
      this.settledCalls += 1;
      await this.#settled;
    },
  };

  /** The jobs the queue still holds as live (what `FreeStepsDeps.liveRenders` reports). */
  live = (): ReadonlyArray<{ jobId: string; videoId: string; life: RenderLife }> =>
    [...this.jobs.values()].filter((j) => j.life === "queued" || j.life === "running").map((j) => ({ jobId: j.jobId, videoId: j.videoId, life: j.life }));

  /** A render that was already running before the steps looked (a lost track of it): a live job for `videoId` that carries the key. */
  plant(key: string, videoId: string, avatarId: string): FakeJob {
    const jobId = `job-planted-${videoId}`;
    const input = { montageId: null, spec: { avatarId, clips: [{ durationMs: 7000 }], layers: [], music: null, seed: 1, schemaVersion: 1 }, provenance: { origin: "autopilot", launchId: "launch-fixture-0001", launchVideoKey: key } } as unknown as InternalRenderInput;
    const job: FakeJob = { jobId, videoId, key, avatarId, input, life: "running" };
    this.jobs.set(jobId, job);
    return job;
  }

  unfinished(): number {
    return [...this.jobs.values()].filter((j) => j.life === "queued" || j.life === "running").length;
  }

  lifeOf = (jobId: string): RenderLife => this.jobs.get(jobId)?.life ?? "gone";

  /** Ends a job. A job that is done commits its record (into the provenance fake) unless `commit` is false. */
  finish(jobId: string, life: "done" | "failed" | "cancelled", options: { commit?: boolean } = {}): void {
    const job = this.jobs.get(jobId);
    if (job === undefined || (job.life !== "running" && job.life !== "queued")) return;
    job.life = life;
    if (life === "done" && options.commit !== false) {
      const total = job.input.spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0);
      this.provenance?.records.set(job.key, { videoId: job.videoId, durationMs: total, bytes: 4096 });
      this.onDone(job);
    }
  }

  finishAll(life: "done" | "failed" | "cancelled" = "done"): void {
    for (const job of this.jobs.values()) this.finish(job.jobId, life);
  }
}

export const failure = (error: ConstructorParameters<typeof EngineFailure>[0]): EngineFailure => new EngineFailure(error);

// ---------- the other ports ----------

export const prefetching = (log: string[] = [], focusOf: (photoId: string) => FocusResult = () => ({ focus: { x: 0.31, y: 0.27 }, resolved: true })): FreeStepsDeps["focus"] => ({
  prefetchFocus: async (avatarId, photoId) => {
    log.push(`${avatarId}:${photoId}`);
    return focusOf(photoId);
  },
});

/** A music chooser that always finds the same trending track (long enough for any autopilot video), and counts what it was asked. */
export function fixedMusic(trackId = "track-00000001"): { choose: NonNullable<FreeStepsDeps["chooseMusic"]>; asked: Array<{ avatarId: string; totalMs: number; seed: number; usage: TrackUsage }> } {
  const asked: Array<{ avatarId: string; totalMs: number; seed: number; usage: TrackUsage }> = [];
  const choose: NonNullable<FreeStepsDeps["chooseMusic"]> = async (input) => {
    asked.push(input);
    const choice: TrackChoice = { kind: "chosen", music: { source: "trending", trackId, startMs: 1500 } };
    return choice;
  };
  return { choose, asked };
}

export const noDrafts: FreeStepsDeps["photoIdsInDrafts"] = async () => ({ photoIds: new Set<string>(), complete: true });

export const noUsage: FreeStepsDeps["trackUsage"] = async () => emptyUsage();

/** Mirrors every spec a render was asked for, as the plain draft the video service takes. */
export const specsOf = (videos: FakeVideos): MontageDraft[] => videos.calls.map((c) => c.spec);
