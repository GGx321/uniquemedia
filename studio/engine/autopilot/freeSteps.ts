import { autopilotSpec, autopilotTotalMs, videoSeed } from "../../shared/autopilot/spec";
import { trackKey, withUse, type TrackChoice, type TrackUsage } from "../../shared/autopilot/track";
import { LogLine } from "../../shared/engine/autopilot";
import type { Cell, Clip, Focus, MontageSpec } from "../../shared/engine/montage";
import { EngineFailure } from "../engineFailure";
import type { FocusResult } from "../focus/focusResolver";
import type { InternalRenderInput } from "../videos/service";
import { readDraftHolds, type DraftHolds } from "./draftHolds";
import { assignArrived, assignLibrary, repick, type AvatarFacts, type PickOutcome } from "./freeAssign";
import type { FileMusic, FileVideo, LaunchFile } from "./launchFile";
import { planAvatarInput, type LibraryReads } from "./libraryInput";
import type { PlanPhoto } from "./planner";
import { lookupVideo, scanProvenance, type KeyFinding } from "./provenanceScan";
import type { LaunchSteps, LaunchStepsContext } from "./steps";

// Stage 4, S4.6c1 (plan §3.2, §3.6 rows 7-10, §5, §6, §8.1-§8.3): the FREE path of the orchestrator, plugged in behind `LaunchSteps`.
//
//   photos: library videos get their photos from a FRESH snapshot (the planner again, on what is free now); generated videos get theirs as slices arrive (`Library.photoIdsOfRun`);
//   track:  chosen once, with the assignment, from the avatar's usage read ONCE per launch and advanced with `withUse`; the choice itself is a port (`chooseMusic`, S4.6c2);
//   spec:   `autopilotSpec` with the object input, focus prefetched (`prefetchFocus`) so the render never touches the face lane;
//   render: `VideoService.renderInternal` with the video's provenance, at most 8 unfinished at once;
//   adopt:  after `videos.settled()`, by the provenance a record or a pending intent carries. «The record exists but does not read» is NOT «no record»: wait, never render again.
//
// The free path goes on while paid work is held (A13); it starts nothing while the launch is not running; it writes only free-path fields of the launch file, always on the file as it is.

/** The most renders of one launch that may be unfinished (queued plus running) at once: 8 of the 20 the queue allows, so the owner always has 12 (A10). */
export const MAX_AUTOPILOT_RENDERS = 8;
const DEFAULT_POLL_MS = 1_000;
const DEFAULT_IDLE_POLL_MS = 8_000;
const DEFAULT_RECHECK_MS = 5_000;
/** A render that fails for a reason that may pass is tried this many times before the video is dropped. */
const MAX_ATTEMPTS = 3;
const STAND_IN_NOTE = "no-focus";

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
  /** The render jobs the queue holds live now (queued or running), with the video each makes: a render this launch lost track of is found here and taken back, never rendered twice. */
  liveRenders?(): ReadonlyArray<{ jobId: string; videoId: string; life: RenderLife }>;
  focus: { prefetchFocus(avatarId: string, photoId: string, options?: { signal?: AbortSignal }): Promise<FocusResult> };
  /** S4.5c's `photoIdsInDrafts`, per avatar (it throws `DraftFolderError` for a folder that cannot be listed). */
  photoIdsInDrafts(avatarId: string): Promise<{ photoIds: ReadonlySet<string>; complete: boolean }>;
  /** The avatar's slice runs that have ended, and whether its draw is over (no slice will start). The paid path's facts. */
  sliceRuns(avatarId: string): Promise<{ runIds: readonly string[]; over: boolean }>;
  /** `trackUsage(root, avatarId)`: called once per avatar per launch. */
  trackUsage(avatarId: string): Promise<TrackUsage>;
  /** The track for one video (S4.6c2 plugs in `chooseTrack`). Absent: no video gets a track, and none is rendered (never silent, A9). */
  chooseMusic?(input: { avatarId: string; totalMs: number; seed: number; usage: TrackUsage }): Promise<TrackChoice>;
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
}

export function createFreeSteps(deps: FreeStepsDeps): FreeSteps {
  const runs = new Map<string, FreeRun>();
  /** A launch that has ended and has nothing in flight is forgotten. */
  const prune = (): void => {
    for (const [id, run] of runs) if (run.ended && run.unfinished() === 0) runs.delete(id);
  };
  return {
    begin(ctx) {
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
    },
    inFlight: () => {
      prune();
      return { requests: 0, renders: [...runs.values()].reduce((sum, run) => sum + run.unfinished(), 0) };
    },
    poke() {
      for (const run of runs.values()) run.poke();
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
  /** Avatars whose wait is already in the log (one line per wait). */
  readonly #loggedWait = new Set<string>();
  #finishPending = false;
  #idle: Array<() => void> = [];

  constructor(deps: FreeStepsDeps, ctx: LaunchStepsContext) {
    this.#d = deps;
    this.#ctx = ctx;
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
      const ms = this.#inflight.size > 0 ? (this.#d.pollMs ?? DEFAULT_POLL_MS) : (this.#d.idlePollMs ?? DEFAULT_IDLE_POLL_MS);
      // Not `unref`ed: a drain (and a release) wait on this loop, and while it sleeps THIS timer is what the process is waiting for. With an unref'd one Bun on Windows idles for ever with the
      // drain's promise pending, and not even a test's own timeout fires. The loop sleeps only while work is outstanding (`#waitsOnTheWorld`), and `dispose` wakes it, so it never holds a finished launch open.
      const timer = setTimeout(done, ms);
      function done(): void {
        clearTimeout(timer);
        resolve();
      }
      this.#wakeSleep = () => {
        this.#wakeSleep = null;
        done();
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
    this.#holds.clear();
    this.#notReady.clear();
    this.#settled ??= this.#d.videos.settled().catch(() => undefined);
    await this.#settled;
    let progressed = await this.#finalizeEnded();
    if (this.draining || !this.#ctx.isRunning()) return progressed;
    const library = this.#d.library();
    if (library === null) return progressed;
    if (await this.#resolveOrphans(library)) progressed = true;
    if (await this.#assign(library)) progressed = true;
    if (await this.#decorate()) progressed = true;
    if (await this.#submit(library)) progressed = true;
    if (await this.#tidy()) progressed = true;
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
      if (life === "failed" || life === "cancelled") this.#failed.add(flight.key);
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
        return this.#markDone(avatarId, key, found);
      case "intent":
      case "unknown":
        // Recovery adopts or drops an intent; an unreadable record may read again. Either way the key is never rendered again from here.
        this.#parked.set(key, { at: this.#now(), avatarId });
        return false;
      case "none":
        this.#parked.delete(key);
        if (how === "ended" || this.#failed.has(key)) return this.#drop(avatarId, key, "render-failed", true);
        // Neither an intent nor a record, in a scan that read everything: the render never happened. Submit it again.
        return this.#write((file) => mapVideo(file, avatarId, key, (v) => (v.state === "rendering" ? { ...v, state: "assigned", videoId: null } : null)));
    }
  }

  async #markDone(avatarId: string, key: string, found: Extract<Found, { kind: "record" }>): Promise<boolean> {
    let shape: FileVideo["shape"] | null = null;
    let size = 0;
    const ok = await this.#write((file) =>
      mapVideo(file, avatarId, key, (v) => {
        if (v.state === "done" || v.state === "dropped") return null;
        shape = v.shape;
        size = v.size;
        return { ...v, state: "done", videoId: found.videoId };
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
   * (§5.3: the generated photos of the launch go to its generated videos). Undefined when the avatar has no such video.
   */
  async #withheldOf(library: FreeLibrary, file: LaunchFile, avatarId: string): Promise<ReadonlySet<string> | undefined> {
    const row = file.avatars.find((a) => a.avatarId === avatarId);
    if (row === undefined || !row.videos.some(isOpenGenerated)) return undefined;
    return (await this.#sliceInfo(library, avatarId))?.arrived;
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
      facts.set(avatarId, { avatarId, ready: snapshot.usageOk && !unknown.has(avatarId), photos: snapshot.photos, ...(withheld === undefined ? {} : { withheld }) });
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
      const targets = row.videos.filter((v) => v.state === "assigned" && v.music === undefined && v.photoIds.length === v.size).sort(byKey);
      if (targets.length === 0) continue;
      let working: TrackUsage;
      try {
        working = await this.#usageOf(row.avatarId);
      } catch {
        continue;
      }
      const given = new Map<string, { music: FileMusic; previousStickerId: string | null }>();
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
          choice = await choose({ avatarId: row.avatarId, totalMs, seed, usage: working });
        } catch {
          continue;
        }
        if (choice.kind !== "chosen") continue;
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
      if (given.size === 0) continue;
      const ok = await this.#write((current) => {
        let next: LaunchFile | null = null;
        for (const [key, value] of given) {
          const changed = mapVideo(next ?? current, row.avatarId, key, (v) => (v.state === "assigned" && v.music === undefined ? { ...v, music: value.music, previousStickerId: value.previousStickerId } : null));
          if (changed !== null) next = changed;
        }
        return next;
      });
      if (ok) {
        this.#usage.set(row.avatarId, Promise.resolve(working));
        progressed = true;
      }
    }
    return progressed;
  }

  // ----- steps 8 and 9: focus, then the render -----

  #canStart(): boolean {
    return !this.draining && !this.ended && this.#ctx.isRunning();
  }

  /** Waits this long before the next submit after a refusal: for a render's end when some are in flight, else for the recheck interval. */
  #backoff(): number {
    return this.#inflight.size > 0 ? (this.#d.pollMs ?? DEFAULT_POLL_MS) : (this.#d.recheckMs ?? DEFAULT_RECHECK_MS);
  }

  async #submit(library: FreeLibrary): Promise<boolean> {
    let progressed = false;
    const max = this.#d.maxRenders ?? MAX_AUTOPILOT_RENDERS;
    // A video is taken once per call, whatever came of it: a refused step must not send the loop round to the same one again.
    const tried = new Set<string>();
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

    try {
      const { jobId, videoId } = await this.#d.videos.renderInternal({ montageId: null, spec, provenance: { origin: "autopilot", launchId: this.#ctx.launchId, launchVideoKey: video.key } });
      this.#inflight.set(video.key, { key: video.key, avatarId, jobId });
      this.#attempts.delete(video.key);
      await this.#write((current) => mapVideo(current, avatarId, video.key, (v) => (v.state === "rendering" && v.videoId === null ? { ...v, videoId } : null)));
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
      case "RENDER_QUEUE_FULL":
        // The owner's renders fill the queue: wait for a render's end.
      case "EXPORT_UNAVAILABLE":
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
    const tries = (this.#attempts.get(key) ?? 0) + 1;
    this.#attempts.set(key, tries);
    if (tries >= MAX_ATTEMPTS + 2) {
      await this.#drop(avatarId, key, "render-failed", true);
      return "go";
    }
    const file = this.#file();
    if (file === null) return "stop";
    const withheld = await this.#withheldOf(library, file, avatarId);
    const facts: AvatarFacts = { avatarId, ready, photos: snapshot.photos, ...(withheld === undefined ? {} : { withheld }) };
    const outcome = repick(file, avatarId, key, facts, holds.held);
    const applied = await this.#applyOutcome(avatarId, outcome, ["rendering"]);
    if (!applied) await this.#revert(avatarId, key);
    return "go";
  }

  // ----- the end -----

  async #tidy(): Promise<boolean> {
    const file = this.#file();
    if (file === null) return false;
    // Who waits on the library's answer: ONE log line per wait, for the owner to see. (The avatar row keeps its phase: the contract has no reason for this wait yet.)
    const waiting = new Set<string>([...this.#notReady, ...[...this.#parked.values()].map((p) => p.avatarId)]);
    for (const id of [...this.#loggedWait]) if (!waiting.has(id)) this.#loggedWait.delete(id);
    for (const id of waiting) {
      if (this.#loggedWait.has(id)) continue;
      this.#loggedWait.add(id);
      await this.#log({ at: this.#at(), avatarId: id, kind: "avatar-busy" });
    }
    // A pass that has nothing to tidy writes nothing: every write is an `autopilot.changed`.
    const changed = tidied(file) === null ? false : await this.#write((current) => tidied(current));
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
    else if (phase === "planned" && videos.some((v) => v.state === "assigned" || v.state === "rendering" || v.state === "done")) phase = "montage";
    if (phase === row.phase && videos.every((v, i) => v === row.videos[i])) return row;
    changed = true;
    return { ...row, phase, videos };
  });
  return changed ? { ...file, avatars } : null;
}
