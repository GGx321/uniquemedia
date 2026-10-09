import { autopilotSpec, autopilotTotalMs, videoSeed } from "../../shared/autopilot/spec";
import { trackKey, withUse, type TrackChoice, type TrackUsage } from "../../shared/autopilot/track";
import { LogLine, type FreeHold } from "../../shared/engine/autopilot";
import type { Cell, Clip, Focus, MontageSpec } from "../../shared/engine/montage";
import type { ExportUnavailableReason, MusicStatus } from "../../shared/engine";
import { estimateBytesUpper } from "../../shared/montage/estimate";
import { EngineFailure } from "../engineFailure";
import type { FocusResult } from "../focus/focusResolver";
import type { InternalRenderInput } from "../videos/service";
import { readDraftHolds, type DraftHolds } from "./draftHolds";
import type { ExportGate, ExportGateAnswer } from "./exportGate";
import { assignArrived, assignLibrary, repick, type AvatarFacts, type PickOutcome } from "./freeAssign";
import { MAX_RENDER_RETRIES, type FileMusic, type FileVideo, type LaunchFile } from "./launchFile";
import { planAvatarInput, type LibraryReads } from "./libraryInput";
import type { AutoRefreshDep, ChooseMusicInput } from "./musicPorts";
import type { PlanPhoto } from "./planner";
import { lookupVideo, scanProvenance, type KeyFinding } from "./provenanceScan";
import type { LaunchSteps, LaunchStepsContext } from "./steps";

// Stage 4, S4.6c1 (plan §3.2, §3.6 rows 7-10, §5, §6, §8.1-§8.3): the FREE path of the orchestrator, plugged in behind `LaunchSteps`.
//
//   photos: library videos get their photos from a FRESH snapshot (the planner again, on what is free now); generated videos get theirs as slices arrive (`Library.photoIdsOfRun`);
//   track:  chosen once, with the assignment, from the avatar's usage read ONCE per launch and advanced with `withUse`; the choice itself is a port (`chooseMusic`, `musicPorts.ts`).
//           With no fitting track the video WAITS (`waiting-music`, photos kept) and is never rendered silent (A9); it goes on by itself when a track appears. A launch asks for ONE automatic
//           refresh of the trends (`autoRefresh`, A11): at its start and when videos wait, never retried;
//   spec:   `autopilotSpec` with the object input, focus prefetched (`prefetchFocus`) so the render never touches the face lane;
//   render: `VideoService.renderInternal` with the video's provenance, at most 8 unfinished at once; while the export folder or the disk cannot take a video (`exportGate`) the renders wait under
//           `freeHold { export }` (photos are not spent) and the hold clears by itself;
//   adopt:  after `videos.settled()`, by the provenance a record or a pending intent carries. «The record exists but does not read» is NOT «no record»: wait, never render again.
//
// The free path goes on while paid work is held (A13); it starts nothing while the launch is not running; it writes only free-path fields of the launch file, always on the file as it is.

/** The most renders of one launch that may be unfinished (queued plus running) at once: 8 of the 20 the queue allows, so the owner always has 12 (A10). */
export const MAX_AUTOPILOT_RENDERS = 8;
/** The name of the function a poll timer of the free steps runs: a test finds the sleeping loops of a launch by it (`testing/timerWatch.ts`), not by guessing at their length. */
export const FREE_POLL_TIMER = "freeStepsPollElapsed";
/** How often the free steps look while renders are in flight. */
export const FREE_POLL_MS = 1_000;
/** How often they look when nothing is in flight. */
export const FREE_IDLE_POLL_MS = 8_000;
const DEFAULT_RECHECK_MS = 5_000;
/** A render that fails for a reason that may pass is tried this many times before the video is dropped. */
const MAX_ATTEMPTS = 3;
/** With no export check to ask, a video whose render ended `EXPORT_UNAVAILABLE` this many times in a row is treated as a failed render (S4.6r). */
const MAX_EXPORT_LOSSES = 3;
/** Every pass of every launch gets its own number, so a port shared by launches never serves one launch the candidates another read. */
let passSequence = 0;
const STAND_IN_NOTE = "no-focus";
/** `MUSIC_UNAVAILABLE` reasons of an automatic refresh that failed BEFORE the request left: nothing was sent, so the launch keeps its attempt. */
const NOT_SENT: ReadonlySet<string> = new Set(["shutting-down", "not-available", "no-music-folder", "clock", "config", "log-held", "log-missing", "log-unwritable"]);

/** The library as the free steps read it. A snapshot is read NOW on every call, never kept (§19). */
export interface FreeLibrary {
  readonly root: string;
  snapshot(avatarId: string): { usageOk: boolean; photos: readonly PlanPhoto[] };
  photoIdsOfRun(avatarId: string, runId: string): string[];
}

/** The real library as a `FreeLibrary`: the planner's own reading of one avatar. */
export function freeLibraryOf(library: LibraryReads & { readonly root: string; photoIdsOfRun(avatarId: string, runId: string): string[] }): FreeLibrary {
  return {
    root: library.root,
    photoIdsOfRun: (avatarId, runId) => library.photoIdsOfRun(avatarId, runId),
    snapshot: (avatarId) => {
      const input = planAvatarInput(library, avatarId, false, true);
      return { usageOk: input.usage.state === "ok", photos: input.photos };
    },
  };
}

export type RenderLife = "queued" | "running" | "done" | "failed" | "cancelled" | "gone";

/** How a failed render job ended, as much as the free steps need of it: the error's code, and for `EXPORT_UNAVAILABLE` which of the folder's troubles it was. */
export interface RenderFailureFacts {
  readonly code: string;
  readonly exportReason?: ExportUnavailableReason | undefined;
}

export interface FreeStepsDeps {
  /** The live library; null while none is open (the steps wait). */
  library(): FreeLibrary | null;
  videos: {
    renderInternal(input: InternalRenderInput): Promise<{ jobId: string; videoId: string }>;
    /** Resolves when the background recovery of the open has settled (`VideoService.settled`). */
    settled(): Promise<void>;
  };
  /** Where a render job stands; `gone` for a job the registry has forgotten. */
  renderLife(jobId: string): RenderLife;
  /**
   * How a render job that failed ended (S4.6r). A render that failed with `EXPORT_UNAVAILABLE` (the folder was renamed, moved, unmounted, or could not be written) is not a failed render: the
   * launch holds on the folder and the video is submitted again, with no retry used. Absent, or `undefined` for a job: the failure counts as a failed render.
   */
  renderFailure?(jobId: string): RenderFailureFacts | undefined;
  /** The render jobs the queue holds live now (queued or running), with the video each makes: a render this launch lost track of is found here and taken back, never rendered twice. */
  liveRenders?(): ReadonlyArray<{ jobId: string; videoId: string; life: RenderLife }>;
  focus: { prefetchFocus(avatarId: string, photoId: string, options?: { signal?: AbortSignal }): Promise<FocusResult> };
  /** S4.5c's `photoIdsInDrafts`, per avatar (it throws `DraftFolderError` for a folder that cannot be listed). */
  photoIdsInDrafts(avatarId: string): Promise<{ photoIds: ReadonlySet<string>; complete: boolean }>;
  /** The avatar's slice runs that have ended, and whether its draw is over (no slice will start). The paid path's facts. */
  sliceRuns(avatarId: string): Promise<{ runIds: readonly string[]; over: boolean }>;
  /** `trackUsage(root, avatarId)`: called once per avatar per launch. */
  trackUsage(avatarId: string): Promise<TrackUsage>;
  /** The track for one video (`createMusicPorts`: `chooseTrack` over the candidates). Absent: no video gets a track, and none is rendered (never silent, A9). */
  chooseMusic?(input: ChooseMusicInput): Promise<TrackChoice>;
  /** The launch's one automatic refresh of the trends (`MusicService.autoRefresh`) and the service's memory of a closed launch. Absent: the videos just wait. */
  autoRefresh?: AutoRefreshDep;
  /** Whether the export folder and the disk can take a video of `requiredBytes` (`exportGateOf`). Absent: the engine's own refusal at the submit is the only check. */
  exportGate?: ExportGate;
  provenance?: { scan: typeof scanProvenance; lookup: typeof lookupVideo };
  maxRenders?: number;
  /** How often to look while renders are in flight. */
  pollMs?: number;
  /** How often to look when nothing is in flight (a long wait for slices or for the owner's review costs one cheap look this often). */
  idlePollMs?: number;
  /** How seldom a video that waits on the library's answer (an intent, an unreadable record) is looked up again. */
  recheckMs?: number;
  clock?: () => number;
  warn?: (line: string) => void;
}

export interface FreeSteps extends LaunchSteps {
  /** Something outside changed (a slice ended, a render ended, a candidate track appeared): look again now instead of at the next poll. */
  poke(): void;
  /**
   * The engine is shutting down: every run ends at once, whatever it still has in flight, and its loop with it (a run that waits on a render that never reports its end would otherwise sleep for ever on a
   * timer that is not unref'd). Nothing begins afterwards. Synchronous, idempotent, never throws.
   */
  dispose(): void;
}

export function createFreeSteps(deps: FreeStepsDeps): FreeSteps {
  const runs = new Map<string, FreeRun>();
  let disposed = false;
  /** A launch that has ended and has nothing in flight is forgotten. */
  const prune = (): void => {
    for (const [id, run] of runs) if (run.ended && run.unfinished() === 0) runs.delete(id);
  };
  /** The launch has closed (done or stopped): the music service forgets that it refreshed. A pause is not a close. */
  const closeLaunch = (launchId: string): void => {
    try {
      deps.autoRefresh?.release(launchId);
    } catch {
      // The service's memory is a courtesy to a long session; the launch closes either way.
    }
  };
  return {
    begin(ctx) {
      if (disposed) return;
      prune();
      let run = runs.get(ctx.launchId);
      if (run === undefined || run.ended) {
        run = new FreeRun(deps, ctx);
        runs.set(ctx.launchId, run);
      }
      run.resume(ctx);
    },
    async drain() {
      prune();
      await Promise.all([...runs.values()].map((run) => run.drain().catch(() => undefined)));
    },
    async release(ctx) {
      runs.get(ctx.launchId)?.dispose();
      runs.delete(ctx.launchId);
      closeLaunch(ctx.launchId);
      // «Стоп»: nothing of the launch waits on the export folder any more.
      try {
        if (ctx.file().freeHold !== null) await ctx.setFreeHold(null);
      } catch {
        // The launch is already over, or the write was refused: a stopped launch holds nothing either way.
      }
    },
    async complete(ctx) {
      closeLaunch(ctx.launchId);
    },
    inFlight: () => {
      prune();
      return { requests: 0, renders: [...runs.values()].reduce((sum, run) => sum + run.unfinished(), 0) };
    },
    poke() {
      for (const run of runs.values()) run.poke();
    },
    dispose() {
      disposed = true;
      for (const run of runs.values()) run.dispose();
      runs.clear();
    },
  };
}

// ---------- helpers ----------

interface Flight {
  key: string;
  avatarId: string;
  jobId: string;
}

type Found = { kind: "record"; videoId: string; durationMs: number; bytes: number } | { kind: "intent" } | { kind: "none" } | { kind: "unknown" };

const keyPart = (key: string): [number, number] => {
  const [avatar, video] = key.split("-");
  return [Number(avatar), Number(video)];
};
const byKey = (a: { key: string }, b: { key: string }): number => {
  const [aa, av] = keyPart(a.key);
  const [ba, bv] = keyPart(b.key);
  return aa - ba || av - bv;
};

const isFinal = (v: FileVideo): boolean => v.state === "done" || v.state === "dropped";
const isOpen = (v: FileVideo): boolean => (v.state === "planned" || v.state === "waiting-photos") && v.photoIds.length === 0;
const isOpenLibrary = (v: FileVideo): boolean => v.source === "library" && isOpen(v);
const isOpenGenerated = (v: FileVideo): boolean => v.source === "generated" && isOpen(v);
const musicKey = (music: FileMusic): string => (music.source === "trending" ? trackKey("trending", music.trackId) : trackKey("own", music.mediaId));

function withFocus(spec: MontageSpec, focusOf: (photoId: string) => Focus | null): MontageSpec {
  const fill = (cell: Cell): Cell => (cell.photo?.source === "scene" ? { ...cell, focus: focusOf(cell.photo.photoId) ?? cell.focus } : cell);
  const clips = spec.clips.map((clip): Clip => {
    if (clip.kind === "photo") return { ...clip, cell: fill(clip.cell) };
    if (clip.kind === "collage") return { ...clip, cells: clip.cells.map(fill) };
    return clip;
  });
  return { ...spec, clips };
}

/** The file with `change` applied to the video; null when the video is not there or `change` leaves it as it is. */
function mapVideo(file: LaunchFile, avatarId: string, key: string, change: (video: FileVideo) => FileVideo | null): LaunchFile | null {
  let changed = false;
  const avatars = file.avatars.map((row) => {
    if (row.avatarId !== avatarId) return row;
    return {
      ...row,
      videos: row.videos.map((video) => {
        if (video.key !== key) return video;
        const next = change(video);
        if (next === null) return video;
        changed = true;
        return next;
      }),
    };
  });
  return changed ? { ...file, avatars } : null;
}

function without<T extends object, K extends keyof T>(value: T, ...keys: K[]): Omit<T, K> {
  const copy = { ...value };
  for (const key of keys) delete copy[key];
  return copy;
}

// ---------- one launch's free work ----------

class FreeRun {
  readonly #d: FreeStepsDeps;
  #ctx: LaunchStepsContext;
  draining = false;
  ended = false;
  #loop: Promise<void> | null = null;
  #wake = false;
  #wakeSleep: (() => void) | null = null;
  #abort = new AbortController();
  #settled: Promise<void> | null = null;
  readonly #inflight = new Map<string, Flight>();
  readonly #submitting = new Set<string>();
  readonly #usage = new Map<string, Promise<TrackUsage>>();
  /** Keys that wait on the library's answer (an intent, an unreadable record): when last looked at, and whose they are. */
  readonly #parked = new Map<string, { at: number; avatarId: string }>();
  readonly #failed = new Set<string>();
  /** Keys whose render ended because the export folder went away: not a failed render, so no retry is used and no video is dropped for it. */
  readonly #exportFailed = new Map<string, ExportUnavailableReason>();
  /** Keys whose render was cancelled: dropped, never retried. */
  readonly #cancelled = new Set<string>();
  /** Set by `#exportAnswers` when the gate threw (its answer is «yes, the engine checks again» for a submit, but «unknown» for a render's end). */
  #gateThrew = false;
  /**
   * The outage epoch (S4.6r): counts the export outages this launch has seen: it moves only when the folder was seen refusing (the check's refusal, or the engine's own `EXPORT_UNAVAILABLE` at a submit) and NEVER when a render's end is read
   * as a loss, or two renders that fail for their own reasons would bump each other's epochs for ever. A render takes the epoch
   * at its submit (`#renderEpoch`); one that ends without a video after the epoch moved lived through an outage, so its failure is the folder's, whatever the check answers by the time its end is handled.
   */
  #outageEpoch = 0;
  readonly #renderEpoch = new Map<string, number>();
  /** Consecutive losses of the folder per key when there is no check to confirm them (see `#endedWithoutVideo`). */
  readonly #exportLosses = new Map<string, number>();
  readonly #retryAt = new Map<string, number>();
  readonly #attempts = new Map<string, number>();
  readonly #focus = new Map<string, Focus>();
  /** No submit before this time: the queue was full, the export folder or the engine refused. */
  #submitBackoffUntil = 0;
  /** What the generated assignment last looked at, per avatar: the slices' ids and whether the draw is over. It looks again only when this changes (or on a poke). */
  readonly #assignSig = new Map<string, string>();
  readonly #holds = new Map<string, Promise<DraftHolds>>();
  /** Avatars the library said «not ready» (usage or drafts unknown) in this pass. */
  readonly #notReady = new Set<string>();
  /**
   * Avatars in a `library-unknown` wait: one log line when it begins, and it ends only when the avatar is OBSERVED ready (a look that does not reach it, a backoff, does not end it), so a
   * long wait writes one line, not one per recheck.
   */
  readonly #episode = new Set<string>();
  /** The pass number: the music port reads its sources once per pass. It is unique across launches (see `passSequence`). */
  #pass = 0;
  /** The launch's automatic refresh: asked at its start and when videos wait (each at most once), and never again once it was attempted (A11: one attempt, never retried). */
  #askedAtStart = false;
  #askedWhileWaiting = false;
  #refreshAttempted = false;
  /** The refresh this launch started and has not yet told the log about: the tracks the store held before it. */
  #refreshWatch: { before: ReadonlySet<string> } | null = null;
  /** The export gate refused in this pass. */
  #gateRefused = false;
  #finishPending = false;
  #idle: Array<() => void> = [];

  constructor(deps: FreeStepsDeps, ctx: LaunchStepsContext) {
    this.#d = deps;
    this.#ctx = ctx;
    // The launch's one automatic refresh may already have been asked (a restart, a long pause): the file says so.
    this.#refreshAttempted = this.#file()?.autoRefreshAskedAt !== undefined;
  }

  // ----- the steps' contract -----

  resume(ctx: LaunchStepsContext): void {
    this.#ctx = ctx;
    if (this.draining) this.#abort = new AbortController();
    this.draining = false;
    this.poke();
  }

  unfinished(): number {
    return this.#inflight.size + this.#submitting.size;
  }

  drain(): Promise<void> {
    if (this.ended) return Promise.resolve();
    this.draining = true;
    this.#abort.abort();
    this.poke();
    return new Promise<void>((resolve) => {
      this.#idle.push(resolve);
      this.#checkIdle();
    });
  }

  dispose(): void {
    this.ended = true;
    this.#abort.abort();
    this.#wakeSleep?.();
    this.#inflight.clear();
    this.#renderEpoch.clear();
    this.#checkIdle();
  }

  poke(): void {
    this.#assignSig.clear();
    this.#wake = true;
    this.#wakeSleep?.();
    if (this.#loop === null && !this.ended) this.#loop = this.#run();
  }

  #checkIdle(): void {
    // A launch that is over (`ended`) is not waited for, whatever it still has in flight: those renders end by themselves (see `#file`), and a drain asked before the launch went must not outlive it.
    if (this.#loop !== null || (!this.ended && (this.#inflight.size > 0 || this.#submitting.size > 0))) return;
    for (const resolve of this.#idle.splice(0)) resolve();
  }

  // ----- the loop -----

  async #run(): Promise<void> {
    try {
      for (;;) {
        this.#wake = false;
        let progressed = false;
        try {
          progressed = await this.#tick();
        } catch (error) {
          this.#warn(`a tick failed (${error instanceof Error ? error.name : typeof error})`);
        }
        if (this.ended) break;
        if (this.draining && this.#inflight.size === 0 && this.#submitting.size === 0) break;
        if (progressed || this.#wake) continue;
        // Nothing is running and nothing may start: a `begin` (a resume) starts the loop again.
        if (!this.draining && !this.#ctx.isRunning() && this.#inflight.size === 0) break;
        if (!this.#waitsOnTheWorld()) break;
        await this.#sleep();
      }
    } finally {
      this.#loop = null;
      this.#checkIdle();
      if (this.#wake && !this.ended && !this.draining) this.#loop = this.#run();
    }
  }

  #sleep(): Promise<void> {
    return new Promise<void>((resolve) => {
      const ms = this.#inflight.size > 0 ? (this.#d.pollMs ?? FREE_POLL_MS) : (this.#d.idlePollMs ?? FREE_IDLE_POLL_MS);
      // Not `unref`ed: a drain (and a release) wait on this loop, and while it sleeps THIS timer is what the process is waiting for. With an unref'd one Bun on Windows idles for ever with the
      // drain's promise pending, and not even a test's own timeout fires. The loop sleeps only while work is outstanding (`#waitsOnTheWorld`), and `dispose` wakes it, so it never holds a finished launch open.
      const timer = setTimeout(freeStepsPollElapsed, ms);
      function freeStepsPollElapsed(): void {
        clearTimeout(timer);
        resolve();
      }
      this.#wakeSleep = () => {
        this.#wakeSleep = null;
        freeStepsPollElapsed();
      };
    });
  }

  #waitsOnTheWorld(): boolean {
    if (this.#inflight.size > 0 || this.#finishPending) return true;
    const file = this.#file();
    return file !== null && file.avatars.some((row) => row.videos.some((v) => !isFinal(v)));
  }

  #file(): LaunchFile | null {
    try {
      return this.#ctx.file();
    } catch {
      // The launch is over. What is still in flight is not forgotten: it ends by itself, and `drain` does not wait for a dead launch.
      this.ended = true;
      return null;
    }
  }

  #now(): number {
    return (this.#d.clock ?? Date.now)();
  }

  #at(): string {
    return new Date(this.#now()).toISOString();
  }

  #warn(line: string): void {
    (this.#d.warn ?? ((l: string) => console.warn(`studio engine: free steps: ${l}`)))(line);
  }

  /** `changed`: the file was rewritten. `same`: `change` left it as it is. `refused`: the write failed (before or after `change` ran): nothing is known to be on disk. */
  async #writeState(change: (file: LaunchFile) => LaunchFile | null): Promise<"changed" | "same" | "refused"> {
    // «Changed» is what really happened to the file (its revision moved), not what `change` asked for: behind the composer a filtered-away change writes nothing, and counting it as
    // progress would send the loop round again at once, for ever.
    let before = -1;
    try {
      const written = await this.#ctx.update((file) => {
        before = file.revision;
        return change(file);
      });
      return written.revision !== before ? "changed" : "same";
    } catch (error) {
      this.#warn(`a write was refused (${error instanceof Error ? error.name : typeof error})`);
      return "refused";
    }
  }

  /** True when the file was changed. */
  async #write(change: (file: LaunchFile) => LaunchFile | null): Promise<boolean> {
    return (await this.#writeState(change)) === "changed";
  }

  async #log(line: LogLine): Promise<void> {
    const parsed = LogLine.safeParse(line);
    if (parsed.success) await this.#ctx.log(parsed.data);
    else this.#warn(`a log line (${line.kind}) does not fit the contract and was not written`);
  }

  // ----- one pass -----

  async #tick(): Promise<boolean> {
    if (this.#file() === null) return false;
    this.#pass = ++passSequence;
    this.#holds.clear();
    this.#notReady.clear();
    this.#gateRefused = false;
    this.#settled ??= this.#d.videos.settled().catch(() => undefined);
    await this.#settled;
    let progressed = await this.#finalizeEnded();
    if (this.draining || !this.#ctx.isRunning()) return progressed;
    const library = this.#d.library();
    if (library === null) return progressed;
    if (await this.#resolveOrphans(library)) progressed = true;
    if (await this.#assign(library)) progressed = true;
    if (await this.#decorate()) progressed = true;
    await this.#askForRefresh();
    await this.#tellRefresh();
    if (await this.#submit(library)) progressed = true;
    if (await this.#tidy(library)) progressed = true;
    return progressed;
  }

  // ----- step 9: what a render left behind -----

  async #look(library: FreeLibrary, avatarId: string, key: string, videoId: string | null, scans: Map<string, ReturnType<typeof scanProvenance>>): Promise<Found> {
    const reader = this.#d.provenance ?? { scan: scanProvenance, lookup: lookupVideo };
    if (videoId !== null) {
      const one = await reader.lookup(library.root, avatarId, videoId);
      if (one.kind === "record") return { kind: "record", videoId, durationMs: one.durationMs, bytes: one.bytes };
      // The file is there and does not read: not «no record».
      if (one.kind === "unreadable") return { kind: "unknown" };
    }
    let scan = scans.get(avatarId);
    if (scan === undefined) {
      scan = reader.scan(library.root, avatarId, this.#ctx.launchId);
      scans.set(avatarId, scan);
    }
    const read = await scan.catch(() => null);
    if (read === null) return { kind: "unknown" };
    const finding: KeyFinding | undefined = read.byKey.get(key);
    if (finding?.kind === "record") return { kind: "record", videoId: finding.videoId, durationMs: finding.durationMs, bytes: finding.bytes };
    if (finding?.kind === "intent") return { kind: "intent" };
    return read.complete ? { kind: "none" } : { kind: "unknown" };
  }

  /** A render that ended: its record is the video; anything else waits or is dropped. */
  async #finalizeEnded(): Promise<boolean> {
    let progressed = false;
    const library = this.#d.library();
    const scans = new Map<string, ReturnType<typeof scanProvenance>>();
    for (const flight of [...this.#inflight.values()]) {
      const life = this.#d.renderLife(flight.jobId);
      if (life === "queued" || life === "running") continue;
      this.#inflight.delete(flight.key);
      progressed = true;
      if (life === "cancelled") {
        // The owner (or a shutdown) cancelled it: the video is dropped, not resubmitted against their wish.
        this.#cancelled.add(flight.key);
        this.#failed.add(flight.key);
      } else if (life === "failed") {
        const why = this.#d.renderFailure?.(flight.jobId);
        if (why?.code === "EXPORT_UNAVAILABLE") this.#exportFailed.set(flight.key, why.exportReason ?? "not-writable");
        else this.#failed.add(flight.key);
      }
      if (library === null) continue;
      const videoId = this.#videoIdOf(flight.avatarId, flight.key);
      const found = await this.#look(library, flight.avatarId, flight.key, videoId, scans);
      await this.#conclude(flight.avatarId, flight.key, found, "ended");
    }
    this.#checkIdle();
    return progressed;
  }

  /** Videos that say `rendering` and have no job here: after a restart, or a render whose end could not be settled. Adopted by provenance, never guessed. */
  async #resolveOrphans(library: FreeLibrary): Promise<boolean> {
    const file = this.#file();
    if (file === null) return false;
    const scans = new Map<string, ReturnType<typeof scanProvenance>>();
    let progressed = false;
    for (const row of file.avatars) {
      for (const video of row.videos) {
        if (video.state !== "rendering" || this.#inflight.has(video.key) || this.#submitting.has(video.key)) continue;
        // A render this launch lost track of may still be live: take it back before anything is looked up, so it is never submitted a second time.
        const live = video.videoId === null ? undefined : this.#d.liveRenders?.().find((job) => job.videoId === video.videoId && (job.life === "queued" || job.life === "running"));
        if (live !== undefined) {
          this.#inflight.set(video.key, { key: video.key, avatarId: row.avatarId, jobId: live.jobId });
          this.#renderEpoch.set(video.key, this.#outageEpoch);
          this.#parked.delete(video.key);
          continue;
        }
        const parked = this.#parked.get(video.key);
        if (parked !== undefined && this.#now() - parked.at < (this.#d.recheckMs ?? DEFAULT_RECHECK_MS)) continue;
        const found = await this.#look(library, row.avatarId, video.key, video.videoId, scans);
        if (await this.#conclude(row.avatarId, video.key, found, "orphan")) progressed = true;
      }
    }
    return progressed;
  }

  #videoIdOf(avatarId: string, key: string): string | null {
    return this.#file()?.avatars.find((a) => a.avatarId === avatarId)?.videos.find((v) => v.key === key)?.videoId ?? null;
  }

  /** What a look found, applied to the video. True when the file changed. */
  async #conclude(avatarId: string, key: string, found: Found, how: "ended" | "orphan"): Promise<boolean> {
    switch (found.kind) {
      case "record":
        this.#parked.delete(key);
        this.#exportFailed.delete(key);
        this.#exportLosses.delete(key);
        return this.#markDone(avatarId, key, found);
      case "intent":
      case "unknown":
        // Recovery adopts or drops an intent; an unreadable record may read again. Either way the key is never rendered again from here.
        this.#parked.set(key, { at: this.#now(), avatarId });
        return false;
      case "none":
        this.#parked.delete(key);
        if (this.#cancelled.delete(key)) {
          this.#failed.delete(key);
          return this.#renderFailed(avatarId, key, false);
        }
        if (this.#exportFailed.has(key) || how === "ended" || this.#failed.has(key)) return this.#endedWithoutVideo(avatarId, key);
        // Neither an intent nor a record, in a scan that read everything: the render never happened. Submit it again.
        return this.#write((file) => mapVideo(file, avatarId, key, (v) => (v.state === "rendering" ? { ...v, state: "assigned", videoId: null } : null)));
    }
  }

  /**
   * A render ended without a video and the library says «none». First rule: a render submitted before the latest outage the steps saw (`#outageEpoch`) lost its video to the folder, whatever the check answers
   * now, so it is an export loss with no retry used. For a render that lived through no outage, the folder is judged by its own check at this moment, not by the job's word: what the job reports
   * (`EXPORT_UNAVAILABLE`, or an ffmpeg write that failed as `RENDER_FAILED` when a volume went away) can be a cause the check cannot see (a subfolder taken by a file, a commit past its deadline), and
   * resubmitting for ever on it would flood the launch.
   * - the check refuses (or a drain aborted it): the folder holds the renders, the video goes back, no retry is used;
   * - the check answers, and the job said `EXPORT_UNAVAILABLE`: a failed render (one retry, then the drop);
   * - there is no check to ask (a test, never the engine) and the job said `EXPORT_UNAVAILABLE`: the folder holds, but only `MAX_EXPORT_LOSSES - 1` times in a row for a video; then it is a failed render;
   * - anything else: a failed render.
   */
  async #endedWithoutVideo(avatarId: string, key: string): Promise<boolean> {
    const said = this.#exportFailed.get(key);
    const file = this.#file();
    const video = file?.avatars.find((row) => row.avatarId === avatarId)?.videos.find((v) => v.key === key);
    // A render whose life overlapped an outage that was seen is an export loss, whatever the check answers now: the folder may be back by the time this end is handled.
    const submittedAt = this.#renderEpoch.get(key);
    if (submittedAt !== undefined && submittedAt < this.#outageEpoch) {
      this.#renderEpoch.delete(key);
      return this.#exportLost(avatarId, key, said ?? this.#file()?.freeHold?.detail.exportReason ?? "not-writable", false);
    }
    if (this.#d.exportGate !== undefined && file !== null && video !== undefined) {
      this.#gateThrew = false;
      const open = await this.#exportAnswers(file, avatarId, video);
      if (this.#gateThrew) {
        // The check itself failed: «unknown» is not «the folder answered». The folder holds and no retry is used, but not for ever: the same bound as with no check to ask.
        const losses = (this.#exportLosses.get(key) ?? 0) + 1;
        this.#exportLosses.set(key, losses);
        if (losses < MAX_EXPORT_LOSSES) return this.#exportLost(avatarId, key, said ?? "not-writable", true);
      } else if (!open) {
        return this.#exportLost(avatarId, key, said ?? this.#file()?.freeHold?.detail.exportReason ?? "not-writable", false);
      }
    } else if (said !== undefined) {
      const losses = (this.#exportLosses.get(key) ?? 0) + 1;
      this.#exportLosses.set(key, losses);
      if (losses < MAX_EXPORT_LOSSES) return this.#exportLost(avatarId, key, said, true);
    }
    this.#exportFailed.delete(key);
    return this.#renderFailed(avatarId, key, true);
  }

  /**
   * The render ended because the export folder went away (§4.6, `EXPORT_UNAVAILABLE`): not the video's fault. It goes back to `assigned` with its photos and track, the launch holds on the folder
   * (`freeHold { export }`), and it is submitted again when the folder answers. No retry is used and nothing is dropped. `writeHold`: the hold is not written by the check that refused.
   */
  async #exportLost(avatarId: string, key: string, exportReason: ExportUnavailableReason, writeHold: boolean): Promise<boolean> {
    this.#exportFailed.delete(key);
    this.#failed.delete(key);
    const ok = await this.#write((file) => mapVideo(file, avatarId, key, (v) => (v.state === "rendering" ? { ...v, state: "assigned", videoId: null } : null)));
    // The hold is written even when the video was already put back: the folder is the reason renders wait. A pass that finds the folder open again clears it (the gate, or the next render the engine takes).
    this.#gateRefused = true;
    if (writeHold) await this.#setHold(exportReason, { neededBytes: null, freeBytes: null });
    return ok;
  }

  /**
   * A render ended without a video (§4.6, `RENDER_FAILED` / a timeout): the first time the same assignment is submitted again, free; the second time the video is dropped and its photos are free. The
   * count is written in the SAME write that decides, so a restart cannot grant another retry. One log line for the retry, one for the drop.
   */
  async #renderFailed(avatarId: string, key: string, mayRetry: boolean): Promise<boolean> {
    const verdict: { kind: "retry" | "drop" | null } = { kind: null };
    const ok = await this.#write((file) => {
      verdict.kind = null;
      const video = file.avatars.find((row) => row.avatarId === avatarId)?.videos.find((v) => v.key === key);
      if (video === undefined || isFinal(video)) return null;
      const used = file.renderRetries?.[key] ?? 0;
      if (mayRetry && used < MAX_RENDER_RETRIES && video.state === "rendering") {
        const back = mapVideo(file, avatarId, key, (v) => ({ ...v, state: "assigned", videoId: null }));
        if (back === null) return null;
        verdict.kind = "retry";
        return { ...back, renderRetries: { ...file.renderRetries, [key]: used + 1 } };
      }
      const dropped = mapVideo(file, avatarId, key, (v) => ({ ...v, state: "dropped", dropReason: "render-failed" }));
      if (dropped !== null) verdict.kind = "drop";
      return dropped;
    });
    if (ok && verdict.kind === "retry") {
      this.#failed.delete(key);
      await this.#log({ at: this.#at(), avatarId, kind: "render-retry", key });
    }
    if (ok && verdict.kind === "drop") await this.#log({ at: this.#at(), avatarId, kind: "render-dropped", key });
    return ok;
  }

  async #markDone(avatarId: string, key: string, found: Extract<Found, { kind: "record" }>): Promise<boolean> {
    let shape: FileVideo["shape"] | null = null;
    let size = 0;
    const ok = await this.#write((file) =>
      mapVideo(file, avatarId, key, (v) => {
        if (v.state === "done" || v.state === "dropped") return null;
        shape = v.shape;
        size = v.size;
        // The finished file's length and size stay with the video, for the results list (`autopilot.get.videos`).
        return { ...v, state: "done", videoId: found.videoId, durationMs: Math.max(1, Math.round(found.durationMs)), bytes: Math.max(1, Math.round(found.bytes)) };
      }),
    );
    if (ok && shape !== null) await this.#log({ at: this.#at(), avatarId, kind: "video-done", key, shape, size, durationMs: found.durationMs, bytes: found.bytes });
    return ok;
  }

  async #drop(avatarId: string, key: string, reason: NonNullable<FileVideo["dropReason"]>, logIt: boolean): Promise<boolean> {
    const ok = await this.#write((file) => mapVideo(file, avatarId, key, (v) => (isFinal(v) ? null : { ...v, state: "dropped", dropReason: reason })));
    if (ok && logIt) await this.#log({ at: this.#at(), avatarId, kind: "render-dropped", key });
    return ok;
  }

  // ----- steps 7: photos -----

  #holdsOf(avatarId: string): Promise<DraftHolds> {
    let known = this.#holds.get(avatarId);
    if (known === undefined) {
      known = readDraftHolds([avatarId], this.#d.photoIdsInDrafts);
      this.#holds.set(avatarId, known);
    }
    return known;
  }

  /** The avatar's slice runs that have ended, the photos they brought, and a signature of that (the ids and whether the draw is over). Null when the paid path cannot say. */
  async #sliceInfo(library: FreeLibrary, avatarId: string): Promise<SliceInfo | null> {
    try {
      const slices = await this.#d.sliceRuns(avatarId);
      const arrived = new Set(slices.runIds.flatMap((runId) => library.photoIdsOfRun(avatarId, runId)));
      return { arrived, over: slices.over, sig: `${[...slices.runIds].sort().join(",")}|${slices.over}|${arrived.size}` };
    } catch {
      return null;
    }
  }

  /**
   * The photos of the launch's own slices while the avatar still has generated videos waiting for photos: they are THEIRS, not the library's, so a library video or a re-pick never takes one
   * (§5.3: the generated photos of the launch go to its generated videos). Undefined when the avatar has no such video. Null when the paid path cannot say.
   */
  async #withheldOf(library: FreeLibrary, file: LaunchFile, avatarId: string): Promise<ReadonlySet<string> | undefined | null> {
    const row = file.avatars.find((a) => a.avatarId === avatarId);
    if (row === undefined || !row.videos.some(isOpenGenerated)) return undefined;
    // The paid path could not say (a read that timed out): which photos are the launch's own is NOT known, and «nothing is withheld» would hand them to a library video. Null means wait.
    const info = await this.#sliceInfo(library, avatarId);
    return info === null ? null : info.arrived;
  }

  async #assign(library: FreeLibrary): Promise<boolean> {
    const file = this.#file();
    if (file === null) return false;
    const liveRows = file.avatars.filter((row) => row.phase !== "skipped");
    const libraryRows = liveRows.filter((row) => row.videos.some(isOpenLibrary));
    const generatedRows = liveRows.filter((row) => row.videos.some(isOpenGenerated));
    // The slices are asked about every pass (one cheap read each); the library and the drafts only when something changed, or a library video waits.
    const slices = new Map<string, SliceInfo>();
    for (const row of generatedRows) {
      const info = await this.#sliceInfo(library, row.avatarId);
      if (info !== null) slices.set(row.avatarId, info);
    }
    const generatedTodo = generatedRows.filter((row) => {
      const info = slices.get(row.avatarId);
      return info !== undefined && this.#assignSig.get(row.avatarId) !== info.sig;
    });
    if (libraryRows.length === 0 && generatedTodo.length === 0) return false;

    const ids = [...new Set([...libraryRows, ...generatedTodo].map((row) => row.avatarId))];
    const held = new Set<string>();
    const unknown = new Set<string>();
    for (const avatarId of ids) {
      const holds = await this.#holdsOf(avatarId);
      for (const photoId of holds.held) held.add(photoId);
      for (const id of holds.unknown) unknown.add(id);
    }
    const facts = new Map<string, AvatarFacts>();
    for (const avatarId of ids) {
      const snapshot = library.snapshot(avatarId);
      const withheld = slices.get(avatarId)?.arrived;
      // An avatar with generated videos still open whose slice runs could not be read is not ready: the launch's own photos cannot be told from the library's.
      const slicesUnknown = generatedRows.some((row) => row.avatarId === avatarId) && !slices.has(avatarId);
      facts.set(avatarId, { avatarId, ready: snapshot.usageOk && !unknown.has(avatarId) && !slicesUnknown, photos: snapshot.photos, ...(withheld === undefined ? {} : { withheld }) });
    }

    let progressed = false;
    if (libraryRows.length > 0) {
      const result = assignLibrary(file, facts, held);
      for (const id of result.waiting) this.#notReady.add(id);
      for (const [avatarId, outcome] of result.byAvatar) if (await this.#applyOutcome(avatarId, outcome, ["planned"])) progressed = true;
    }

    for (const row of generatedTodo) {
      const known = facts.get(row.avatarId);
      const info = slices.get(row.avatarId);
      if (known === undefined || info === undefined) continue;
      if (!known.ready) {
        this.#notReady.add(row.avatarId);
        this.#assignSig.delete(row.avatarId);
        continue;
      }
      const fresh = this.#file();
      if (fresh === null) return progressed;
      const outcome = assignArrived(fresh, row.avatarId, known, held, info.arrived, info.over);
      const applied = await this.#applyOutcome(row.avatarId, outcome, ["planned", "waiting-photos"]);
      if (applied) progressed = true;
      // What was looked at is remembered, so a long wait for the next slice costs no reads. A write that was refused is looked at again.
      if (applied || (outcome.picks.length === 0 && outcome.dropped.length === 0)) this.#assignSig.set(row.avatarId, info.sig);
    }
    return progressed;
  }

  /** Writes what an assignment decided, on the file as it is now: a video that is no longer in a state the pick was made for is left alone. */
  async #applyOutcome(avatarId: string, outcome: PickOutcome, from: ReadonlyArray<FileVideo["state"]>): Promise<boolean> {
    if (outcome.picks.length === 0 && outcome.dropped.length === 0) return false;
    const ok = await this.#write((file) => {
      let next: LaunchFile | null = null;
      for (const pick of outcome.picks) {
        const base: LaunchFile = next ?? file;
        const changed = mapVideo(base, avatarId, pick.key, (v) => {
          if (!from.includes(v.state)) return null;
          const same = v.shape === pick.shape && v.size === pick.size;
          // A different shape or size is a different length: the track chosen for the old one no longer stands.
          const kept = same ? v : without(v, "music", "previousStickerId");
          return { ...kept, shape: pick.shape, size: pick.size, category: pick.category, photoIds: [...pick.photoIds], state: "assigned", videoId: null };
        });
        if (changed !== null) next = changed;
      }
      for (const key of outcome.dropped) {
        const base: LaunchFile = next ?? file;
        const changed = mapVideo(base, avatarId, key, (v) => (from.includes(v.state) ? { ...v, state: "dropped", dropReason: "not-enough-photos" } : null));
        if (changed !== null) next = changed;
      }
      return next;
    });
    if (ok && (outcome.missingPhotos > 0 || outcome.dropped.length > 0)) {
      await this.#log({ at: this.#at(), avatarId, kind: "degrade", fewerVideos: outcome.dropped.length, missingPhotos: Math.max(1, outcome.missingPhotos) });
    }
    return ok;
  }

  // ----- the track and the sticker, with the assignment -----

  #usageOf(avatarId: string): Promise<TrackUsage> {
    const known = this.#usage.get(avatarId);
    if (known !== undefined) return known;
    const made = (async (): Promise<TrackUsage> => {
      let usage = await this.#d.trackUsage(avatarId);
      // What this launch already gave (a restart, a resume of a video not yet rendered): counted once, on top of the records.
      const row = this.#file()?.avatars.find((a) => a.avatarId === avatarId);
      for (const v of row?.videos ?? []) if (v.music !== undefined && (v.state === "assigned" || v.state === "rendering")) usage = withUse(usage, musicKey(v.music));
      return usage;
    })();
    this.#usage.set(avatarId, made);
    made.catch(() => this.#usage.delete(avatarId));
    return made;
  }

  /** The built-in sticker the video's spec carries (null when stickers are off). Pure. */
  #stickerOf(file: LaunchFile, avatarId: string, video: FileVideo, music: FileMusic, previousStickerId: string | null): string | null {
    if (!file.draft.stickers) return null;
    const spec = autopilotSpec({
      avatarId,
      shape: video.shape,
      photoIds: video.photoIds,
      seed: videoSeed(file.draft.planSeed, avatarId, video.key),
      music,
      options: { stickers: true, previousStickerId, captionSource: null },
    });
    const layer = spec.layers.find((l) => l.kind === "sticker");
    return layer?.kind === "sticker" && layer.sticker.source === "builtin" ? layer.sticker.stickerId : null;
  }

  async #decorate(): Promise<boolean> {
    const choose = this.#d.chooseMusic;
    const file = this.#file();
    if (choose === undefined || file === null) return false;
    let progressed = false;
    for (const row of file.avatars) {
      if (row.phase === "skipped") continue;
      // A video that waits for a track is looked at again at every pass: a track may have appeared (a finished refresh, a newly flagged own track).
      const targets = row.videos.filter((v) => (v.state === "assigned" || v.state === "waiting-music") && v.music === undefined && v.photoIds.length === v.size).sort(byKey);
      if (targets.length === 0) continue;
      let working: TrackUsage;
      try {
        working = await this.#usageOf(row.avatarId);
      } catch {
        continue;
      }
      const given = new Map<string, { music: FileMusic; previousStickerId: string | null }>();
      /** Videos the chooser said «waiting» for: with the length each would need. Nothing but this is written for them. */
      const waits = new Map<string, number>();
      const decorated = (video: FileVideo): { music: FileMusic; previousStickerId: string | null } | null => {
        const fresh = given.get(video.key);
        if (fresh !== undefined) return fresh;
        return video.music === undefined ? null : { music: video.music, previousStickerId: video.previousStickerId ?? null };
      };
      for (const video of targets) {
        const seed = videoSeed(file.draft.planSeed, row.avatarId, video.key);
        const totalMs = autopilotTotalMs(video.shape, video.size, seed);
        let choice: TrackChoice;
        try {
          choice = await choose({ avatarId: row.avatarId, totalMs, seed, usage: working, pass: this.#pass });
        } catch {
          // The sources could not be read: nothing is known, so the video neither waits nor gets a track; the next pass asks again.
          continue;
        }
        if (choice.kind !== "chosen") {
          // No candidate, or none long enough: the video waits, with its photos. It is never rendered without a track (A9).
          waits.set(video.key, totalMs);
          continue;
        }
        const music: FileMusic = choice.music;
        // The sticker avoids the one the avatar's video just before this one carries.
        const before = row.videos
          .filter((v) => byKey(v, video) < 0)
          .sort(byKey)
          .reverse()
          .map((v) => ({ v, d: decorated(v) }))
          .find((x) => x.d !== null);
        const previousStickerId = before?.d == null ? null : this.#stickerOf(file, row.avatarId, before.v, before.d.music, before.d.previousStickerId);
        given.set(video.key, { music, previousStickerId: file.draft.stickers ? previousStickerId : null });
        working = withUse(working, musicKey(music));
      }
      if (given.size > 0) {
        const ok = await this.#write((current) => {
          let next: LaunchFile | null = null;
          for (const [key, value] of given) {
            const changed = mapVideo(next ?? current, row.avatarId, key, (v) =>
              (v.state === "assigned" || v.state === "waiting-music") && v.music === undefined ? { ...v, state: "assigned", music: value.music, previousStickerId: value.previousStickerId } : null,
            );
            if (changed !== null) next = changed;
          }
          return next;
        });
        if (ok) {
          this.#usage.set(row.avatarId, Promise.resolve(working));
          progressed = true;
        }
      }
      if (waits.size > 0 && (await this.#markWaitingMusic(row.avatarId, waits))) progressed = true;
    }
    return progressed;
  }

  /** The videos that found no track go to `waiting-music` (the ones already there are left alone), and each is logged once, when it begins to wait. */
  async #markWaitingMusic(avatarId: string, waits: ReadonlyMap<string, number>): Promise<boolean> {
    const begun: string[] = [];
    const ok = await this.#write((file) => {
      begun.length = 0;
      let next: LaunchFile | null = null;
      for (const key of waits.keys()) {
        const changed = mapVideo(next ?? file, avatarId, key, (v) => {
          if (v.state !== "assigned" || v.music !== undefined) return null;
          begun.push(key);
          return { ...v, state: "waiting-music" };
        });
        if (changed !== null) next = changed;
      }
      return next;
    });
    if (!ok) return false;
    for (const key of begun) await this.#log({ at: this.#at(), avatarId, kind: "waiting-music", key, neededMs: waits.get(key) ?? 0 });
    return true;
  }

  // ----- the one automatic refresh of the trends (A11) -----

  /** Once the refresh this launch started has ended (done or failed), the log tells what it brought and what quota is left. One line; a launch that ends first never writes it. */
  async #tellRefresh(): Promise<void> {
    const watch = this.#refreshWatch;
    const dep = this.#d.autoRefresh;
    if (watch === null || dep === undefined) return;
    let status: MusicStatus;
    let now: readonly string[];
    try {
      status = await dep.status();
      if (status.refresh.state === "running") return;
      now = await dep.candidateKeys();
    } catch {
      return;
    }
    this.#refreshWatch = null;
    const local = Math.max(0, status.limit - status.sentLast31d);
    const remaining = status.serverRemaining === null ? local : Math.min(local, status.serverRemaining);
    await this.#log({ at: this.#at(), kind: "music-refresh", added: now.filter((key) => !watch.before.has(key)).length, remaining });
  }

  /**
   * Asks the music service for the launch's one automatic refresh: at the launch's start, and when videos wait for music (each at most once; the service's own rule decides whether anything is
   * sent). A refresh that started, failed or threw is the launch's attempt and is never repeated. Nothing is asked while the launch does not run, so a restart asks nothing before «Продолжить».
   */
  async #askForRefresh(): Promise<void> {
    const dep = this.#d.autoRefresh;
    if (dep === undefined || this.#refreshAttempted || !this.#canStart()) return;
    const file = this.#file();
    if (file === null) return;
    const rows = file.avatars.filter((row) => row.phase !== "skipped");
    if (!rows.some((row) => row.videos.some((v) => !isFinal(v)))) return;
    const waiting = rows.some((row) => row.videos.some((v) => v.state === "waiting-music"));
    if (this.#askedAtStart && !(waiting && !this.#askedWhileWaiting)) return;
    this.#askedAtStart = true;
    if (waiting) this.#askedWhileWaiting = true;
    let written = false;
    try {
      const candidateCount = await dep.candidateCount();
      // The tracks the store holds now, to tell the owner later which ones the refresh brought.
      const before = await dep.candidateKeys().then((keys) => new Set(keys), () => new Set<string>());
      // The pause that landed while the question was prepared: nothing is asked (the check is repeated right before the write).
      if (!this.#canStart()) return;
      // A4: the attempt is on disk BEFORE the request leaves, so a restart or a pause of any length finds it. A write that fails sends nothing.
      const stamp = this.#at();
      if ((await this.#writeState((f) => (f.autoRefreshAskedAt === undefined ? { ...f, autoRefreshAskedAt: stamp } : null))) === "refused") return;
      written = true;
      const answer = await dep.request({ launchId: this.#ctx.launchId, candidateCount });
      if (answer.kind === "declined" || (answer.kind === "failed" && NOT_SENT.has(answer.error.musicReason ?? ""))) {
        // Nothing was sent, so this was not the launch's attempt.
        await this.#write((f) => (f.autoRefreshAskedAt === undefined ? null : without(f, "autoRefreshAskedAt")));
        return;
      }
      this.#refreshAttempted = true;
      if (answer.kind === "started") this.#refreshWatch = { before };
    } catch (error) {
      // Whether the request left is not known: once the attempt is written it is not made again.
      if (written) this.#refreshAttempted = true;
      this.#warn(`the automatic music refresh could not be asked (${error instanceof Error ? error.name : typeof error})`);
    }
  }

  // ----- steps 8 and 9: focus, then the render -----

  #canStart(): boolean {
    return !this.draining && !this.ended && this.#ctx.isRunning();
  }

  /** Waits this long before the next submit after a refusal: for a render's end when some are in flight, else for the recheck interval. */
  #backoff(): number {
    return this.#inflight.size > 0 ? (this.#d.pollMs ?? FREE_POLL_MS) : (this.#d.recheckMs ?? DEFAULT_RECHECK_MS);
  }

  // ----- the export folder and the disk: `freeHold { export }` -----

  /** True when the folder can take the video (an absent gate answers yes: the engine's own check at the submit decides). A refusal sets the hold; an answer clears it. */
  async #exportAnswers(file: LaunchFile, avatarId: string, video: FileVideo): Promise<boolean> {
    const gate = this.#d.exportGate;
    if (gate === undefined) return true;
    const seed = videoSeed(file.draft.planSeed, avatarId, video.key);
    const requiredBytes = estimateBytesUpper([{ durationMs: autopilotTotalMs(video.shape, video.size, seed) }]);
    let answer: ExportGateAnswer;
    try {
      // A folder that does not answer must not hold a pause or a stop: the wait ends with the abort of a drain (the gate has its own deadline too).
      const raced = await this.#abortable(gate({ requiredBytes }));
      if (raced === null) return false;
      answer = raced.value;
    } catch {
      // No answer is not a refusal: the engine checks again at the submit.
      this.#warn("the export folder could not be asked");
      this.#gateThrew = true;
      return true;
    }
    if (answer.ok) {
      await this.#clearHold();
      return true;
    }
    this.#gateRefused = true;
    this.#sawOutage();
    await this.#setHold(answer.exportReason, answer.exportReason === "not-enough-space" ? { neededBytes: answer.neededBytes, freeBytes: answer.freeBytes } : { neededBytes: null, freeBytes: null });
    return false;
  }

  /** The folder was seen gone: every render submitted before now lived through it. */
  #sawOutage(): void {
    this.#outageEpoch += 1;
  }

  /** Writes the hold only when it is new or its reason changed: the figures move with every look and are not worth a write (every write is an `autopilot.changed`). */
  async #setHold(exportReason: Extract<FreeHold, { reason: "export" }>["detail"]["exportReason"], figures: { neededBytes: number | null; freeBytes: number | null }): Promise<void> {
    const held = this.#file()?.freeHold;
    // Rewritten when the reason changes, or when figures arrive for a hold that had none.
    if (held?.detail.exportReason === exportReason && (held.detail.neededBytes !== null || figures.neededBytes === null)) return;
    try {
      await this.#ctx.setFreeHold({ reason: "export", at: this.#at(), detail: { exportReason, ...figures } });
    } catch (error) {
      this.#warn(`the export hold could not be written (${error instanceof Error ? error.name : typeof error})`);
    }
  }

  /** The promise's value, or null when a drain or a stop aborted the wait first. */
  async #abortable<T>(promise: Promise<T>): Promise<{ value: T } | null> {
    const signal = this.#abort.signal;
    if (signal.aborted) return null;
    let onAbort = (): void => undefined;
    const aborted = new Promise<null>((resolve) => {
      onAbort = () => resolve(null);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([promise.then((value) => ({ value })), aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async #clearHold(): Promise<void> {
    if (this.#file()?.freeHold == null) return;
    try {
      await this.#ctx.setFreeHold(null);
    } catch (error) {
      this.#warn(`the export hold could not be cleared (${error instanceof Error ? error.name : typeof error})`);
    }
  }

  async #submit(library: FreeLibrary): Promise<boolean> {
    let progressed = false;
    const max = this.#d.maxRenders ?? MAX_AUTOPILOT_RENDERS;
    // A video is taken once per call, whatever came of it: a refused step must not send the loop round to the same one again.
    const tried = new Set<string>();
    // The folder is asked once per call; a fresh answer for every render is the engine's own check inside `renderInternal`.
    let folderAnswered = false;
    for (;;) {
      if (!this.#canStart() || this.#inflight.size + this.#submitting.size >= max || this.#now() < this.#submitBackoffUntil) break;
      const file = this.#file();
      if (file === null) break;
      const now = this.#now();
      let next: { avatarId: string; video: FileVideo } | null = null;
      for (const row of file.avatars) {
        if (row.phase === "skipped") continue;
        const ready = row.videos
          .filter((v) => v.state === "assigned" && v.music !== undefined && v.photoIds.length === v.size && (this.#retryAt.get(v.key) ?? 0) <= now && !this.#submitting.has(v.key) && !this.#inflight.has(v.key) && !tried.has(v.key))
          .sort(byKey)[0];
        if (ready !== undefined) {
          next = { avatarId: row.avatarId, video: ready };
          break;
        }
      }
      if (next === null) break;
      // The export folder and the disk are asked before a video is marked or a photo spent. A refusal holds the renders (not the free work, not the paid work) until it passes.
      if (!folderAnswered) {
        if (!(await this.#exportAnswers(file, next.avatarId, next.video))) break;
        folderAnswered = true;
      }
      this.#submitting.add(next.video.key);
      tried.add(next.video.key);
      let outcome: Outcome;
      try {
        outcome = await this.#submitOne(library, file, next.avatarId, next.video);
      } finally {
        this.#submitting.delete(next.video.key);
        this.#checkIdle();
      }
      // Only a step that changed something is progress: a refusal that is waited out must not send the loop round again at once.
      if (outcome === "go") progressed = true;
      if (outcome === "stop") break;
    }
    return progressed;
  }

  async #submitOne(library: FreeLibrary, file: LaunchFile, avatarId: string, video: FileVideo): Promise<Outcome> {
    const music = video.music;
    if (music === undefined) return "idle";

    // An avatar whose usage is distrusted is not submitted for.
    const snapshot = library.snapshot(avatarId);
    if (!snapshot.usageOk) return this.#notReadyYet(avatarId, video.key);

    // Focus first, with its own bound and no render deadline: the submitted spec then carries it and the render never waits in the face lane (§8.2). Only a JUDGED focus is kept for later.
    const focusOf = new Map<string, Focus>();
    for (const photoId of video.photoIds) {
      const kept = this.#focus.get(photoId);
      if (kept !== undefined) {
        focusOf.set(photoId, kept);
        continue;
      }
      try {
        const result = await this.#d.focus.prefetchFocus(avatarId, photoId, { signal: this.#abort.signal });
        focusOf.set(photoId, result.focus);
        if (result.resolved) this.#focus.set(photoId, result.focus);
      } catch {
        if (this.#abort.signal.aborted) return "stop";
        this.#warn(`${STAND_IN_NOTE}: the focus of a photo could not be prefetched`);
      }
    }
    if (!this.#canStart()) return "stop";

    // The drafts as they are NOW, read fresh for this submit and AFTER the focus (which can take minutes): a draft saved since the assignment holds a photo the engine would still render, because
    // the engine does not look at drafts. Unknown drafts wait; a held photo sends the video to other photos.
    const holds = await readDraftHolds([avatarId], this.#d.photoIdsInDrafts);
    if (holds.unknown.has(avatarId)) return this.#notReadyYet(avatarId, video.key);
    if (video.photoIds.some((photoId) => holds.held.has(photoId))) {
      const now = library.snapshot(avatarId);
      const facts: AvatarFacts = { avatarId, ready: now.usageOk, photos: now.photos };
      const withheld = await this.#withheldOf(library, file, avatarId);
      if (withheld === null) return this.#notReadyYet(avatarId, video.key);
      const outcome = repick(file, avatarId, video.key, withheld === undefined ? facts : { ...facts, withheld }, holds.held);
      const applied = await this.#applyOutcome(avatarId, outcome, ["assigned"]);
      if (!applied) this.#retryAt.set(video.key, this.#now() + (this.#d.recheckMs ?? DEFAULT_RECHECK_MS));
      return applied ? "go" : "idle";
    }

    const seed = videoSeed(file.draft.planSeed, avatarId, video.key);
    const spec = withFocus(
      autopilotSpec({ avatarId, shape: video.shape, photoIds: video.photoIds, seed, music, options: { stickers: file.draft.stickers, previousStickerId: video.previousStickerId ?? null, captionSource: null } }),
      (photoId) => focusOf.get(photoId) ?? null,
    );

    // «rendering» is written BEFORE the submit: a crash anywhere after it is resolved by provenance, never by a second render.
    // Only a write that SUCCEEDED lets the render go. A refused one (before or after its change) leaves the disk saying «assigned»: nothing is submitted, and nothing is tried again before the backoff.
    const marked = await this.#writeState((current) => mapVideo(current, avatarId, video.key, (v) => (v.state === "assigned" ? { ...v, state: "rendering", videoId: null } : null)));
    if (marked === "refused") {
      this.#submitBackoffUntil = this.#now() + this.#backoff();
      return "stop";
    }
    if (marked === "same") return "idle";

    // Taken before the submit: an outage seen while the render is being taken counts for it.
    const epochAtSubmit = this.#outageEpoch;
    try {
      const { jobId, videoId } = await this.#d.videos.renderInternal({ montageId: null, spec, provenance: { origin: "autopilot", launchId: this.#ctx.launchId, launchVideoKey: video.key } });
      this.#inflight.set(video.key, { key: video.key, avatarId, jobId });
      this.#renderEpoch.set(video.key, epochAtSubmit);
      this.#attempts.delete(video.key);
      await this.#write((current) => mapVideo(current, avatarId, video.key, (v) => (v.state === "rendering" && v.videoId === null ? { ...v, videoId } : null)));
      // The engine took a render, so the folder answered: a hold the gate could not clear (no gate, or a refusal of the engine's own) is over.
      await this.#clearHold();
      return "go";
    } catch (error) {
      return this.#submitFailed(library, avatarId, video.key, error);
    }
  }

  /** The avatar's usage or drafts are not known: this video waits and counts no attempt. */
  #notReadyYet(avatarId: string, key: string): Outcome {
    this.#notReady.add(avatarId);
    this.#retryAt.set(key, this.#now() + (this.#d.recheckMs ?? DEFAULT_RECHECK_MS));
    return "idle";
  }

  async #revert(avatarId: string, key: string, patch: (v: FileVideo) => FileVideo = (v) => v): Promise<void> {
    await this.#write((file) => mapVideo(file, avatarId, key, (v) => (v.state === "rendering" ? { ...patch(v), state: "assigned", videoId: null } : null)));
  }

  async #submitFailed(library: FreeLibrary, avatarId: string, key: string, error: unknown): Promise<Outcome> {
    const now = this.#now();
    const backoff = this.#backoff();
    // A refusal that may pass: the video goes back to «assigned», and nothing is submitted before the backoff is over.
    const wait = async (patch?: (v: FileVideo) => FileVideo): Promise<Outcome> => {
      this.#submitBackoffUntil = now + backoff;
      await this.#revert(avatarId, key, patch);
      return "stop";
    };
    const transient = async (patch?: (v: FileVideo) => FileVideo): Promise<Outcome> => {
      const tries = (this.#attempts.get(key) ?? 0) + 1;
      this.#attempts.set(key, tries);
      if (tries >= MAX_ATTEMPTS) {
        await this.#drop(avatarId, key, "render-failed", true);
        return "go";
      }
      this.#retryAt.set(key, now + backoff);
      await this.#revert(avatarId, key, patch);
      return "go";
    };
    if (!(error instanceof EngineFailure)) return transient();
    const e = error.error;
    switch (e.code) {
      case "EXPORT_UNAVAILABLE":
        // The engine's own check refused the folder or the disk (a folder that went away between the gate and the submit): the same hold, and the video goes back to «assigned».
        this.#gateRefused = true;
        this.#sawOutage();
        await this.#setHold(e.exportReason ?? "not-writable", { neededBytes: null, freeBytes: null });
        return wait();
      case "RENDER_QUEUE_FULL":
        // The owner's renders fill the queue: wait for a render's end.
      case "INTERNAL":
      case "IN_FLIGHT":
        return wait();
      case "PHOTO_UNAVAILABLE":
        return this.#photoUnavailable(library, avatarId, key, e.photoReason);
      case "NOT_FOUND":
        await this.#drop(avatarId, key, "avatar-gone", true);
        return "go";
      case "MONTAGE_INVALID": {
        const issues = e.issues ?? [];
        // The track is gone or too short: this video chooses again, a few times.
        if (issues.length > 0 && issues.every((issue) => issue.path[0] === "music")) return transient((v) => without(v, "music"));
        await this.#drop(avatarId, key, "render-failed", true);
        return "go";
      }
      default:
        await this.#drop(avatarId, key, "render-failed", true);
        return "go";
    }
  }

  /**
   * A photo of the video was taken meanwhile (§5.4). If a record or a pending intent carries this video's key, the photos are the video's own and recovery decides: wait. If the library cannot
   * say, wait too. A distrusted index (`index-stale`, `log-needs-repair`, or a usage that reads unknown now) is not a failed render either: it waits and counts no attempt. Only when the library
   * says «none» and can be trusted is the video given other photos.
   */
  async #photoUnavailable(library: FreeLibrary, avatarId: string, key: string, reason: string | undefined): Promise<Outcome> {
    const found = await this.#look(library, avatarId, key, null, new Map());
    if (found.kind !== "none") {
      await this.#conclude(avatarId, key, found, "orphan");
      return "go";
    }
    const holds = await this.#holdsOf(avatarId);
    const snapshot = library.snapshot(avatarId);
    const ready = snapshot.usageOk && !holds.unknown.has(avatarId);
    if (!ready || reason === "index-stale" || reason === "log-needs-repair") {
      if (!ready) this.#notReady.add(avatarId);
      this.#retryAt.set(key, this.#now() + (this.#d.recheckMs ?? DEFAULT_RECHECK_MS));
      await this.#revert(avatarId, key);
      return "go";
    }
    const file = this.#file();
    if (file === null) return "stop";
    // Which photos are the launch's own is read BEFORE an attempt is counted: when the paid path cannot say, this is a wait like an unknown usage, not a failed render.
    const withheld = await this.#withheldOf(library, file, avatarId);
    if (withheld === null) {
      this.#notReady.add(avatarId);
      this.#retryAt.set(key, this.#now() + (this.#d.recheckMs ?? DEFAULT_RECHECK_MS));
      await this.#revert(avatarId, key);
      return "go";
    }
    const tries = (this.#attempts.get(key) ?? 0) + 1;
    this.#attempts.set(key, tries);
    if (tries >= MAX_ATTEMPTS + 2) {
      await this.#drop(avatarId, key, "render-failed", true);
      return "go";
    }
    const facts: AvatarFacts = { avatarId, ready, photos: snapshot.photos, ...(withheld === undefined ? {} : { withheld }) };
    const outcome = repick(file, avatarId, key, facts, holds.held);
    const applied = await this.#applyOutcome(avatarId, outcome, ["rendering"]);
    if (!applied) await this.#revert(avatarId, key);
    return "go";
  }

  // ----- the end -----

  /**
   * Who waits on the library's answer: an avatar the library said «not ready» in this pass, or one with a key held by recovery. A wait begins with ONE log line (`library-unknown`); it ends
   * when the avatar has no open video left, or when the library is looked at and can say (usage known, drafts listed). A pass that does not reach the avatar leaves the wait as it is.
   */
  async #trackLibraryWaits(library: FreeLibrary, file: LaunchFile): Promise<void> {
    const blocked = new Set<string>([...this.#notReady, ...[...this.#parked.values()].map((p) => p.avatarId)]);
    for (const id of blocked) {
      if (this.#episode.has(id)) continue;
      this.#episode.add(id);
      await this.#log({ at: this.#at(), avatarId: id, kind: "library-unknown" });
    }
    for (const id of [...this.#episode]) {
      if (blocked.has(id)) continue;
      const open = file.avatars.find((row) => row.avatarId === id)?.videos.some((v) => !isFinal(v)) === true;
      if (open && !(await this.#libraryAnswers(library, id))) continue;
      this.#episode.delete(id);
    }
  }

  /** Whether the library can say which photos of the avatar are free now: its usage reads, and its drafts list. */
  async #libraryAnswers(library: FreeLibrary, avatarId: string): Promise<boolean> {
    try {
      if (!library.snapshot(avatarId).usageOk) return false;
      return !(await this.#holdsOf(avatarId)).unknown.has(avatarId);
    } catch {
      return false;
    }
  }

  async #tidy(library: FreeLibrary): Promise<boolean> {
    const file = this.#file();
    if (file === null) return false;
    // Who waits on the library's answer (`library-unknown`): ONE log line per wait, and the wait ends only when the avatar is observed ready.
    await this.#trackLibraryWaits(library, file);
    // A hold the gate did not refuse in this pass, with no video left that needs the folder, is over (a launch whose videos are all waiting for music or are done holds nothing).
    if (file.freeHold !== null && !this.#gateRefused && this.#ctx.isRunning() && !this.draining && !needsFolder(file)) await this.#clearHold();
    // A pass that has nothing to tidy writes nothing: every write is an `autopilot.changed`.
    const settled = (current: LaunchFile): LaunchFile | null => {
      const shown = waitsShown(current, this.#episode);
      return tidied(shown ?? current) ?? shown;
    };
    const changed = settled(file) === null ? false : await this.#write((current) => settled(current));
    const after = this.#file();
    if (after === null) return changed;
    const everyFinal = after.avatars.every((row) => row.videos.every(isFinal));
    if (everyFinal && this.#inflight.size === 0 && this.#submitting.size === 0 && this.#ctx.isRunning()) {
      try {
        await this.#ctx.finish();
        this.#finishPending = false;
        this.ended = true;
        return true;
      } catch (error) {
        // The launch is not over: look again at the next poll.
        this.#finishPending = true;
        this.#warn(`the launch could not be finished (${error instanceof Error ? error.name : typeof error})`);
      }
    }
    return changed;
  }
}

type Outcome = "go" | "stop" | "idle";

interface SliceInfo {
  arrived: Set<string>;
  over: boolean;
  sig: string;
}

/** Whether any video is ready to go to the export folder (photos, a track, not yet submitted). With none, a hold on the folder has nothing to hold. */
function needsFolder(file: LaunchFile): boolean {
  return file.avatars.some((row) => row.phase !== "skipped" && row.videos.some((v) => v.state === "assigned" && v.music !== undefined && v.photoIds.length === v.size));
}

/**
 * What the avatar rows say of a `library-unknown` wait, on the file as it is. Only a row with no generation is the free path's own (the composer restores what the paid path owns on the
 * others, and a paid row keeps its phase): it shows `waiting { library-unknown }` while the wait lasts and goes back to where its videos are when it ends. Null when nothing changes.
 */
function waitsShown(file: LaunchFile, episode: ReadonlySet<string>): LaunchFile | null {
  let changed = false;
  const avatars = file.avatars.map((row) => {
    if (row.generation !== null || row.phase === "skipped") return row;
    if (episode.has(row.avatarId) && (row.phase === "planned" || row.phase === "montage")) {
      changed = true;
      return { ...row, phase: "waiting" as const, waiting: { reason: "library-unknown" as const } };
    }
    if (!episode.has(row.avatarId) && row.phase === "waiting" && row.waiting?.reason === "library-unknown") {
      changed = true;
      return { ...row, phase: "planned" as const, waiting: null };
    }
    return row;
  });
  return changed ? { ...file, avatars } : null;
}

/**
 * The end-of-pass bookkeeping, on the file as it is: the videos of a skipped avatar that have not started are dropped (`avatar-skipped`), an avatar whose videos are all final is `done`, and an
 * avatar that has begun its montage says so. A row that has a `generation` is the paid path's: only its videos are touched, never its phase to anything but `done`/`montage`. Null when
 * nothing changes.
 */
function tidied(file: LaunchFile): LaunchFile | null {
  let changed = false;
  const avatars = file.avatars.map((row) => {
    const videos = row.phase === "skipped" ? row.videos.map((v) => (isFinal(v) || v.state === "rendering" ? v : { ...v, state: "dropped" as const, dropReason: "avatar-skipped" as const })) : row.videos;
    const allFinal = videos.length > 0 && videos.every(isFinal);
    let phase = row.phase;
    if (row.phase !== "skipped" && row.phase !== "waiting" && allFinal) phase = "done";
    else if (phase === "planned" && videos.some((v) => v.state === "assigned" || v.state === "waiting-music" || v.state === "rendering" || v.state === "done")) phase = "montage";
    if (phase === row.phase && videos.every((v, i) => v === row.videos[i])) return row;
    changed = true;
    return { ...row, phase, videos };
  });
  return changed ? { ...file, avatars } : null;
}
