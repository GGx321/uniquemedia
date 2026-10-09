import {
  LAUNCH_SLICE_MAX_PHOTOS,
  type AvatarPhase,
  type CategoryRef,
  type DropReason,
  type FreeHold,
  type LaunchAvatarView,
  type LaunchVideo,
  type LogLine,
  type PaidHold,
  type SkipReason,
  type VideoShape,
  type WaitingReason,
} from "../../shared/engine";
import type { MockAutopilotWorld, MockLaunch } from "./mockAutopilot";

// The mock's launch, run on its scheduler (Stage 4, S4.8). The engine's orchestrator and steps advance a launch in the background; this advances the mock's the same way, one pass per
// tick of the mock's clock, so the window can be developed and tested against it end to end:
//
//   start ─► per avatar that generates: compose (the writer) ─► [review wait, switch ON] ─► draw in slices ─► montage; per video: photos assigned ─► a track ─► the export folder ─► render ─► done
//
// What it keeps from the engine, because the window and the parity suite depend on it (the plan's sections are named where they matter):
//  - the view is the engine's: `pausing` while requests or renders are in flight (§3.7), `paused` with a cause, `stopping`, `done`; the rows' phases and waits; the open reserves split
//    into `inFlight` (a request is out) and `unsettled` (none is: a drop, a restart), inside `spentMicros`;
//  - every paid hold of §4.6 and its release (the bounded automatic continues after 1 and 5 minutes, the price list's retries after 5, 15 and 60, the holds that wait for a person), the
//    free hold of the export folder (a missing folder or a full disk), the waiting reasons, and a video that waits for a track;
//  - money is booked in the mock's ledger as the engine books it: a reserve at the attempt's worst case, settled at the expected cost on the next tick, so a launch's «Потрачено» moves.
//
// What it does NOT model (the engine does): the planner's seeded sizes and PDQ rules (the plan is the mock's own, mockAutopilot.ts), photos that fail the face or moderation gates (so the
// failure-rate guard and a degraded video never happen), an owner's edit of the scenes during the review. A render that fails is a testkit switch (`failLaunchRender`): one free retry, then the
// video is dropped (S4.6r); a folder that goes away while a render runs holds the renders without using the retry.

/** The photos a video of a shape has when its photos are generated, as the engine's planner draws them (`GENERATED_SIZE`). */
export const GENERATED_SIZE: Readonly<Record<VideoShape, number>> = { single: 1, collage: 3, slides: 5 };
/** How long a mock launch's video lasts and weighs, by shape: inside the 10 s the autopilot allows, and short enough for a stored track. */
export const RUN_DURATION_MS: Readonly<Record<VideoShape, number>> = { single: 6_500, collage: 6_500, slides: 6_500 };
export const RUN_BYTES: Readonly<Record<VideoShape, number>> = { single: 2_200_000, collage: 2_300_000, slides: 3_100_000 };

/** The automatic continues of a job that got no answer (plan §4.6, Q2 = A), and the price list's retries. The engine's `NETWORK_WAITS_MS` and `PRICE_WAITS_MS`. */
export const MOCK_NETWORK_WAITS_MS: readonly number[] = [60_000, 300_000];
export const MOCK_PRICE_WAITS_MS: readonly number[] = [300_000, 900_000, 3_600_000];
/** The engine's `MAX_AUTOPILOT_RENDERS`. */
const MAX_RENDERS = 8;
/** Requests the mock sends at once for one avatar's draw. */
const DRAW_BATCH = 6;
/** Ticks a render takes in the mock. */
const RENDER_TICKS = 2;
/** The disk a video needs: twice its size estimate. */
export const MOCK_DISK_PER_VIDEO = 9_000_000;

/** What a paid step can meet that holds the launch (`MockEngine.failLaunchPaidStep`). */
export const PAID_FAULTS = ["credits", "key", "price", "budget", "price-unavailable", "network", "halt", "internal", "job-failed"] as const;
export type PaidFault = (typeof PAID_FAULTS)[number];

type Track = NonNullable<LaunchVideo["track"]>;
type SlotState = "planned" | "assigned" | "waiting-music" | "rendering" | "done" | "dropped";

interface Slot {
  readonly key: string;
  readonly shape: VideoShape;
  readonly size: number;
  readonly source: "library" | "generated";
  readonly category: CategoryRef;
  /** For a generated video: the photos drawn for the videos before it, plus its own: it is assigned once this many have arrived. */
  readonly needDrawn: number;
  photoIds: string[];
  state: SlotState;
  videoId: string | null;
  track: Track | null;
  renderLeft: number;
  /** The free retry of a failed render has been used (plan §4.6: one, then the video is dropped). Kept across a restart, as the engine keeps it in the launch file. */
  retried: boolean;
  dropReason: DropReason | null;
}

interface Work {
  readonly avatarId: string;
  readonly index: number;
  readonly toGenerate: number;
  readonly slots: Slot[];
  /** The paid path's own phase; the row shows `waiting` while `waiting` is set. */
  phase: AvatarPhase;
  waiting: WaitingReason | null;
  skipped: LaunchAvatarView["skipped"];
  setId: string | null;
  /** The writer has answered: the set's scenes have their sentences. A set exists (and shows) from the compose's start, with none written. */
  written: boolean;
  revision: number;
  drawn: number;
  drawnIds: string[];
  libraryDone: boolean;
  /** The launch's cap is used up (the engine's `RUN_CAP_EXCEEDED`): the avatar's draw is over with the photos it has, and the videos they cannot fill are dropped. */
  capped: boolean;
  busyLogged: boolean;
  unknownLogged: boolean;
}

interface Reserve {
  readonly worst: number;
  /** A request of this process is out for it; false for a reserve a drop or a restart abandoned. */
  live: boolean;
  readonly avatarId: string | null;
  readonly kind: "writer" | "image";
}

/** What `MockRun` needs of its caller. */
export interface RunHost {
  /** `autopilot.changed`, carrying the launch's view as it stands. */
  announce(): void;
  /** A pass is changing the launch: the money and the settings it causes do not announce it again until `leave`. */
  enter(): void;
  leave(): void;
  /** The faults the testkit armed for the paid steps, in order (shared, so one armed before the start is met by its first paid step). */
  readonly faults: PaidFault[];
  /** The renders the testkit armed to fail (`MockEngine.failLaunchRender`): how many of the next landings fail. Shared, like `faults`. */
  readonly renderFaults: { left: number };
}

export interface RunStart {
  readonly avatars: readonly { avatarId: string; shapes: readonly VideoShape[]; fromLibrary: number; toGenerate: number }[];
  readonly categories: readonly CategoryRef[];
  readonly review: boolean;
  readonly number: string;
}

const iso = (ms: number): string => new Date(ms).toISOString();

export class MockRun {
  readonly #launch: MockLaunch;
  readonly #w: MockAutopilotWorld;
  readonly #host: RunHost;
  readonly #review: boolean;
  readonly #categories: readonly CategoryRef[];
  readonly #number: string;
  readonly #work: Work[];
  readonly #open = new Map<string, Reserve>();
  #settled = 0;
  #seq = 0;
  #tick: (() => void) | null = null;
  #retry: (() => void) | null = null;
  readonly #drops = new Map<string, { drops: number; continues: number }>();
  #priceRetries = 0;
  /** «Продолжить» was accepted (or a wait ended): the next pass starts by putting the rows right. */
  #resumePending = false;
  #exportLogged: string | null = null;
  /** Whether the hold the last `#raise` asked for is the one that stands now. */
  #raiseWon = false;
  #worldWait = false;
  #lastView = "";

  constructor(launch: MockLaunch, world: MockAutopilotWorld, host: RunHost, start: RunStart) {
    this.#launch = launch;
    this.#w = world;
    this.#host = host;
    this.#review = start.review;
    this.#categories = start.categories;
    this.#number = start.number;
    this.#work = start.avatars.map((a, index): Work => {
      let cumulative = 0;
      const slots = a.shapes.map((shape, n): Slot => {
        const key = `${index}-${n + 1}`;
        const category = start.categories[0] ?? "home";
        return { key, shape, size: 0, source: "library", category, needDrawn: 0, photoIds: [], state: "planned", videoId: null, track: null, renderLeft: 0, retried: false, dropReason: null };
      });
      // The plan fills the library first (slides, then collages, then singles), the rest is generated: the first videos of the list by `fromLibrary`.
      let libraryLeft = a.fromLibrary;
      const sized = slots.map((slot): Slot => {
        const wanted = GENERATED_SIZE[slot.shape];
        const fromLibrary = libraryLeft >= wanted;
        if (fromLibrary) libraryLeft -= wanted;
        if (!fromLibrary) cumulative += wanted;
        return { ...slot, size: wanted, source: fromLibrary ? "library" : "generated", needDrawn: fromLibrary ? 0 : cumulative };
      });
      return {
        avatarId: a.avatarId,
        index,
        toGenerate: a.toGenerate,
        slots: sized,
        phase: "planned",
        waiting: null,
        skipped: null,
        setId: null,
        written: false,
        revision: 1,
        drawn: 0,
        drawnIds: [],
        libraryDone: false,
        capped: false,
        busyLogged: false,
        unknownLogged: false,
      };
    });
    this.#sync();
  }

  // ---------- what the view reads ----------

  /** The launch's committed money: settled at cost, open reserves at their worst case. */
  spent(): number {
    let open = 0;
    for (const reserve of this.#open.values()) open += reserve.worst;
    return this.#settled + open;
  }

  inFlight(): { requests: number; openMicros: number } {
    return this.#split(true);
  }

  unsettled(): { requests: number; openMicros: number } {
    return this.#split(false);
  }

  #split(live: boolean): { requests: number; openMicros: number } {
    if (!this.#unfinished()) return { requests: 0, openMicros: 0 };
    let requests = 0;
    let openMicros = 0;
    for (const [key, reserve] of this.#open) {
      if (reserve.live !== live) continue;
      // A reserve a reconcile closed is no longer open (the sweep books it at its worst case at the next pass).
      if (!live && !this.#w.hasReserve(key)) continue;
      requests += 1;
      openMicros += reserve.worst;
    }
    return { requests, openMicros };
  }

  #unfinished(): boolean {
    return this.#launch.status !== "done" && this.#launch.status !== "stopped";
  }

  /** What the rows of `launch.avatars` and the videos of `launch.videos` say, derived from the work. */
  #sync(): void {
    this.#sweep();
    const videos: LaunchVideo[] = [];
    this.#launch.avatars = this.#work.map((work): LaunchAvatarView => {
      const counted = work.slots.filter((s) => s.state !== "dropped");
      const done = counted.filter((s) => s.state === "done").length;
      const rendered = counted.filter((s) => s.state === "done" || s.state === "rendering").length;
      for (const slot of work.slots) {
        const video = this.#videoOf(work, slot);
        if (video !== null) videos.push(video);
      }
      const generating = work.toGenerate > 0;
      const phase: AvatarPhase = work.skipped !== null ? "skipped" : work.waiting !== null ? "waiting" : this.#phaseOf(work, counted.length, rendered, done);
      const drawing = phase === "drawing" || (work.waiting !== null && work.phase === "drawing");
      const left = work.toGenerate - work.drawn;
      const dropped = work.slots.filter((s) => s.dropReason !== null);
      const reasons = new Map<DropReason, number>();
      for (const slot of dropped) if (slot.dropReason !== null) reasons.set(slot.dropReason, (reasons.get(slot.dropReason) ?? 0) + 1);
      const topReason = [...reasons.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
      const sliceTotal = Math.max(1, Math.ceil(work.toGenerate / LAUNCH_SLICE_MAX_PHOTOS));
      // An ended launch has let its sets go (the engine's `complete` and `release` clear the mirrors): the rows name no set.
      const setId = this.#unfinished() ? work.setId : null;
      return {
        avatarId: work.avatarId,
        phase,
        waiting: work.waiting !== null && work.skipped === null ? { reason: work.waiting } : null,
        skipped: work.skipped,
        photos: { done: work.drawn, total: work.toGenerate },
        montage: { done: rendered, total: counted.length },
        videos: { done, total: counted.length },
        sceneSetId: setId,
        setRevision: setId === null ? null : work.revision,
        scenes: setId === null ? null : work.toGenerate,
        scenesWithoutText: setId === null ? null : 0,
        continuePhotos: setId === null ? null : work.written ? work.toGenerate : 0,
        slice: drawing && generating ? { index: Math.min(sliceTotal, Math.floor(work.drawn / LAUNCH_SLICE_MAX_PHOTOS) + 1), total: sliceTotal } : null,
        dropped: topReason === undefined ? null : { count: dropped.length, reason: topReason },
        waitingMusic: work.slots.filter((s) => s.state === "waiting-music").length,
        undrawnScenes: drawing ? left : 0,
        resumableSlots: drawing ? left : 0,
        drawAllocationMicros: generating ? work.toGenerate * this.#w.unit().photoWorstMicros : null,
      };
    });
    this.#launch.videos = videos;
  }

  /** The row's phase when no wait or skip overrides it. */
  #phaseOf(work: Work, counted: number, rendered: number, done: number): AvatarPhase {
    if (work.phase === "done") return "done";
    if (work.toGenerate > 0 && (work.phase === "planned" || work.phase === "composing" || work.phase === "awaiting-review" || work.phase === "approved-waiting" || work.phase === "drawing")) return work.phase;
    if (counted > 0 && done === counted) return "done";
    if (work.phase === "montage") return "montage";
    return rendered > 0 || done > 0 || work.slots.some((s) => s.state === "assigned" || s.state === "waiting-music") ? "montage" : "planned";
  }

  #videoOf(work: Work, slot: Slot): LaunchVideo | null {
    const base = { key: slot.key, avatarId: work.avatarId, shape: slot.shape, size: slot.size, dropReason: null, publishedAt: null } as const;
    switch (slot.state) {
      case "done":
        return { ...base, durationMs: RUN_DURATION_MS[slot.shape], bytes: RUN_BYTES[slot.shape], track: slot.track, state: "done", videoId: slot.videoId };
      case "rendering":
        return { ...base, durationMs: RUN_DURATION_MS[slot.shape], bytes: null, track: slot.track, state: "rendering", videoId: slot.videoId };
      case "waiting-music":
        return { ...base, durationMs: null, bytes: null, track: null, state: "waiting-music", videoId: null };
      case "dropped":
        return { ...base, durationMs: null, bytes: null, track: null, state: "dropped", dropReason: slot.dropReason, videoId: null };
      default:
        return null;
    }
  }

  // ---------- the log ----------

  #log(line: LogLine): void {
    this.#launch.log.push(line);
  }

  #at(): string {
    return this.#w.nowIso();
  }

  // ---------- the clock ----------

  /** Starts the passes (after a start or an accepted resume). */
  begin(): void {
    this.#schedule(true);
  }

  #schedule(want: boolean): void {
    if (!want || this.#tick !== null) return;
    this.#tick = this.#w.schedule(this.#w.stepMs, () => {
      this.#tick = null;
      this.#pass();
    });
  }

  #cancelAll(): void {
    this.#tick?.();
    this.#tick = null;
    this.#retry?.();
    this.#retry = null;
  }

  /** One tick: the passes run, the view is announced once if it moved, and the next tick is asked for only while something can still move (the world may change under it). */
  #pass(): void {
    this.#host.enter();
    try {
      this.#passOnce();
    } finally {
      this.#host.leave();
    }
  }

  #passOnce(): void {
    const status = this.#launch.status;
    if (status === "pausing" || status === "stopping") {
      this.#drain();
      return;
    }
    if (status !== "running") return;
    if (this.#resumePending) this.#applyResume();
    this.#launch.activeMs += this.#w.stepMs;
    this.#worldWait = false;
    const freed = this.#settleLive();
    const moved = this.#free() || freed;
    const paid = this.#paid();
    if (this.#finished()) {
      this.#finish();
      return;
    }
    this.#sync();
    this.#announceIfChanged();
    const busy = [...this.#open.values()].some((r) => r.live) || this.#work.some((work) => work.slots.some((s) => s.state === "rendering"));
    this.#schedule(moved || paid || busy || this.#worldWait);
  }

  #announceIfChanged(): void {
    const sig = JSON.stringify([this.#launch.status, this.#launch.paidHold, this.#launch.freeHold, this.#launch.avatars, this.#launch.log.length, this.spent(), this.inFlight()]);
    if (sig === this.#lastView) return;
    this.#lastView = sig;
    this.#host.announce();
  }

  // ---------- money ----------

  /** The reserves a reconcile closed since the last look are booked at their worst case, as the ledger closes them. */
  #sweep(): void {
    for (const [key, reserve] of [...this.#open]) {
      if (reserve.live || this.#w.hasReserve(key)) continue;
      this.#settled += reserve.worst;
      this.#open.delete(key);
    }
  }

  #reserve(kind: "writer" | "image", avatarId: string, worst: number, live: boolean): string {
    this.#seq += 1;
    const key = `${this.#launch.launchId}:${kind}-${this.#seq}`;
    this.#w.openReserve(key, worst);
    this.#open.set(key, { worst, live, avatarId, kind });
    return key;
  }

  #close(key: string, cost: number): void {
    const reserve = this.#open.get(key);
    if (reserve === undefined) return;
    this.#open.delete(key);
    this.#settled += cost;
    this.#w.closeReserve(key, cost);
  }

  /** Settles the requests of the last tick at their expected cost and books what they brought. */
  #settleLive(): boolean {
    let moved = false;
    const arrived = new Map<Work, number>();
    for (const [key, reserve] of [...this.#open]) {
      if (!reserve.live) continue;
      const work = this.#work.find((w) => w.avatarId === reserve.avatarId);
      if (work === undefined) continue;
      moved = true;
      if (reserve.kind === "writer") {
        this.#close(key, work.toGenerate * this.#w.unit().writerExpectedPerPhotoMicros);
        if (work.phase === "composing") {
          this.#openSet(work);
          work.written = true;
          this.#log({ at: this.#at(), kind: "scenes-ready", avatarId: work.avatarId, scenes: work.toGenerate, withoutText: 0 });
          work.phase = this.#review ? "awaiting-review" : "drawing";
        }
      } else {
        this.#close(key, this.#w.unit().photoExpectedMicros);
        arrived.set(work, (arrived.get(work) ?? 0) + 1);
      }
    }
    for (const [work, count] of arrived) {
      work.drawnIds.push(...this.#w.drawPhotos(work.avatarId, count, this.#categories[0] ?? "home"));
      for (let i = 0; i < count; i++) {
        work.drawn += 1;
        this.#log({ at: this.#at(), kind: "photo", avatarId: work.avatarId, done: work.drawn, total: work.toGenerate });
      }
      if (work.drawn >= work.toGenerate) work.phase = "montage";
    }
    return moved;
  }

  // ---------- the paid path ----------

  /** One pass of the paid path: at most one compose and one draw step, in the order of the rows. */
  #paid(): boolean {
    if (this.#launch.paidHold !== null) return false;
    let moved = false;
    let composed = false;
    let drawing = false;
    for (const work of this.#work) {
      if (work.toGenerate === 0 || work.skipped !== null) continue;
      if (work.phase === "planned" && !composed) {
        const step = this.#step(work, "compose");
        if (step === "held") return true;
        if (step === "moved") {
          composed = true;
          moved = true;
        }
      } else if (work.phase === "drawing" && !drawing) {
        const step = this.#step(work, "draw");
        if (step === "held") return true;
        if (step === "moved") {
          drawing = true;
          moved = true;
        }
      }
    }
    return moved;
  }

  /** One step for one avatar: the avatar's own waits first, then the faults and gates of the paid call, then the call. */
  #step(work: Work, step: "compose" | "draw"): "moved" | "held" | "waits" {
    if (this.#w.busy(work.avatarId)) {
      if (!work.busyLogged) {
        work.busyLogged = true;
        this.#log({ at: this.#at(), kind: "avatar-busy", avatarId: work.avatarId });
      }
      work.waiting = "avatar-busy";
      this.#worldWait = true;
      return "waits";
    }
    work.busyLogged = false;
    if (step === "compose" && this.#w.hasOwnersOpenSet(work.avatarId)) {
      work.waiting = "open-set";
      this.#worldWait = true;
      return "waits";
    }
    work.waiting = null;
    const unit = this.#w.unit();
    const left = work.toGenerate - work.drawn;
    const batch = Math.min(DRAW_BATCH, left);
    const chunks = Math.ceil(work.toGenerate / LAUNCH_SLICE_MAX_PHOTOS);
    const need = step === "compose" ? chunks * unit.writerChunkWorstMicros : unit.photoWorstMicros;
    // The launch's group cap is W′: a request that would commit more than it is not sent (the engine's `RUN_CAP_EXCEEDED`). The slice is over with what it has.
    const send = step === "compose" ? chunks * unit.writerChunkWorstMicros : batch * unit.attemptWorstMicros;
    if (this.spent() + send > this.#launch.plannedWorstMicros) {
      this.#capEnd(work);
      return "moved";
    }
    const hold = this.#gate(work, step, need, left);
    if (hold !== "clear") return hold;
    this.#priceRetries = 0;
    if (step === "compose") {
      work.phase = "composing";
      this.#openSet(work);
      this.#log({ at: this.#at(), kind: "scenes-writing", avatarId: work.avatarId, scenes: work.toGenerate });
      this.#reserve("writer", work.avatarId, chunks * unit.writerChunkWorstMicros, true);
      return "moved";
    }
    if (work.drawn % LAUNCH_SLICE_MAX_PHOTOS === 0 && !this.#openImages(work)) {
      const photos = Math.min(LAUNCH_SLICE_MAX_PHOTOS, left);
      this.#log({
        at: this.#at(),
        kind: "slice-start",
        avatarId: work.avatarId,
        index: Math.floor(work.drawn / LAUNCH_SLICE_MAX_PHOTOS) + 1,
        total: Math.max(1, Math.ceil(work.toGenerate / LAUNCH_SLICE_MAX_PHOTOS)),
        photos,
        capMicros: photos * unit.photoWorstMicros,
      });
    }
    for (let i = 0; i < batch; i++) this.#reserve("image", work.avatarId, unit.attemptWorstMicros, true);
    return "moved";
  }

  /** The avatar's scene set exists from the compose's first request on, with none of its scenes written yet. */
  #openSet(work: Work): void {
    if (work.setId !== null) return;
    work.setId = `set-mock-${this.#number}-${work.index + 1}`;
    work.revision = 1;
  }

  /** The cap is used: no more is bought for this avatar; the videos its photos cannot fill are dropped, the rest go on (the engine's §4.6 `RUN_CAP_EXCEEDED` row). */
  #capEnd(work: Work): void {
    work.capped = true;
    work.phase = "montage";
    let missing = 0;
    let fewer = 0;
    for (const slot of work.slots) {
      if (slot.source !== "generated" || slot.state !== "planned" || work.drawn >= slot.needDrawn) continue;
      slot.state = "dropped";
      slot.dropReason = "not-enough-photos";
      missing += slot.size;
      fewer += 1;
    }
    if (missing > 0) this.#log({ at: this.#at(), kind: "degrade", avatarId: work.avatarId, fewerVideos: fewer, missingPhotos: missing });
  }

  #openImages(work: Work): boolean {
    return [...this.#open.values()].some((r) => r.avatarId === work.avatarId && r.kind === "image");
  }

  /**
   * What stands between a paid step and its call: a fault the testkit armed, the key, the ledger, the month. A cause raises the hold the plan's table gives it and the step ends ("held");
   * otherwise the step may go on ("clear").
   */
  #gate(work: Work, step: "compose" | "draw", needMicros: number, left: number): "clear" | "held" {
    // A job that ends INTERNAL is a slice's run (its master photo cannot be prepared before the first image request): the compose, which does not read the master, never meets that fault.
    // It does not block the faults armed behind it: the first fault this step can meet is the one taken.
    const at0 = this.#host.faults.findIndex((f) => !(f === "job-failed" && step === "compose"));
    const fault = at0 < 0 ? undefined : this.#host.faults.splice(at0, 1)[0];
    const at = this.#at();
    const job = step === "compose" ? `${work.avatarId}:scenes` : `${work.avatarId}:slice-${Math.floor(work.drawn / LAUNCH_SLICE_MAX_PHOTOS) + 1}`;
    if (fault !== undefined) {
      switch (fault) {
        // OpenRouter's refusals come in answer to the request: the compose's set is already made, with nothing written.
        case "credits":
          if (step === "compose") this.#openSet(work);
          return this.#raise(work, { reason: "credits", at, detail: {} });
        case "key":
          if (step === "compose") this.#openSet(work);
          this.#w.rejectKey();
          return this.#raise(work, { reason: "key", at, detail: {} });
        case "halt":
          this.#w.haltLedger();
          return this.#raise(work, { reason: "halt", at, detail: { code: "SETTLE_ABOVE_WORST" } });
        case "internal":
          return this.#raise(work, { reason: "internal", at, detail: { kind: "allocation-exceeded" } });
        case "job-failed":
          // S4.6r: a job that ended INTERNAL (a master photo that cannot be prepared) is a hold with the job's words; «Продолжить» runs it again.
          return this.#raise(work, { reason: "internal", at, detail: { kind: "job-failed", message: "INTERNAL: the master photo could not be prepared as the face reference" } });
        case "price":
          return this.#raise(
            work,
            step === "compose"
              ? { reason: "price", at, detail: { stage: "compose", needMicros, leftMicros: Math.max(0, needMicros - 1) } }
              : { reason: "price", at, detail: { stage: "slice", fromPhotos: Math.min(LAUNCH_SLICE_MAX_PHOTOS, left), toPhotos: 0 } },
          );
        case "budget":
          return this.#raise(work, { reason: "budget", at, detail: { freeMicros: Math.max(0, this.#room() - 1), needMicros: Math.max(1, this.#room()), kind: this.#budgetKind(work, step) } });
        case "price-unavailable":
          return this.#priceUnavailable(work);
        case "network":
          return this.#networkDrop(work, step, job);
      }
    }
    if (this.#w.keyState() !== "ok") return this.#raise(work, { reason: "key", at, detail: {} });
    const gate = this.#w.admission();
    if (gate !== null) {
      if (gate.code === "SETTLE_ABOVE_WORST" || gate.code === "LEDGER_WRITE_FAILED") return this.#raise(work, { reason: "halt", at, detail: { code: gate.code } });
      // A ledger that holds reserves it cannot vouch for, met in a running launch: the same exit as a network hold, with no retry (A19).
      return this.#networkDrop(work, step, job, true);
    }
    const room = this.#room();
    if (room < needMicros) {
      return this.#raise(work, { reason: "budget", at, detail: { freeMicros: room, needMicros, kind: this.#budgetKind(work, step) } });
    }
    return "clear";
  }

  #room(): number {
    const month = this.#w.month();
    return Math.max(0, month.budgetMicros - month.spentAndOpenMicros);
  }

  #budgetKind(work: Work, step: "compose" | "draw"): "new-slice" | "resume-slice" {
    return step === "draw" && work.drawn % LAUNCH_SLICE_MAX_PHOTOS !== 0 ? "resume-slice" : "new-slice";
  }

  /** A hold for a person (or a wait): written, logged, the avatar parked, and the paid path ends for this pass. */
  #raise(work: Work, hold: PaidHold): "held" {
    // One hold stands, by rank (the engine's `holdRank`, S4.6b2 and S4.6r): a hold displaces the one that stands only by a higher rank, and among equals the first stays. The avatar is parked either way.
    const standing = this.#launch.paidHold;
    this.#raiseWon = standing === null || holdRank(hold) > holdRank(standing);
    work.waiting = "paid-hold";
    for (const other of this.#work) if (other !== work && other.toGenerate > 0 && other.skipped === null && other.phase !== "montage" && other.phase !== "done" && other.phase !== "awaiting-review") other.waiting = "paid-hold";
    if (!this.#raiseWon) return "held";
    // The timer of a waiting hold that this one displaces belongs to a hold that is gone.
    if (standing !== null && holdRank(standing) === 0) {
      this.#retry?.();
      this.#retry = null;
    }
    this.#launch.paidHold = hold;
    this.#log(holdLine(hold, this.#at()));
    if (hold.reason === "budget" && hold.detail.kind === "resume-slice") this.#log({ at: this.#at(), kind: "budget-ended", done: work.drawn, total: work.toGenerate });
    return "held";
  }

  /** No answer: the request's reserve stays open at its worst case; the job continues by itself after the first and the second drop, and holds for a person at the third. */
  #networkDrop(work: Work, step: "compose" | "draw", job: string, reconcile = false): "held" {
    const unit = this.#w.unit();
    const chunks = Math.ceil(work.toGenerate / LAUNCH_SLICE_MAX_PHOTOS);
    if (!reconcile) {
      if (step === "compose") this.#openSet(work);
      // The requests left and got no answer: their reserves stay open at the worst case until a reconcile.
      if (step === "compose") this.#reserve("writer", work.avatarId, chunks * unit.writerChunkWorstMicros, false);
      else for (let i = 0; i < Math.min(DRAW_BATCH, work.toGenerate - work.drawn); i++) this.#reserve("image", work.avatarId, unit.attemptWorstMicros, false);
      this.#w.noteOpenReserve();
    }
    const count = this.#drops.get(job) ?? { drops: 0, continues: 0 };
    count.drops += 1;
    const at = this.#at();
    const waits = MOCK_NETWORK_WAITS_MS;
    if (!reconcile && count.continues < waits.length && count.drops <= waits.length) {
      count.continues += 1;
      this.#drops.set(job, count);
      const afterMs = waits[count.continues - 1] ?? 0;
      this.#log({ at, kind: "network-retry", avatarId: work.avatarId, attempt: count.continues, attempts: waits.length, afterMs });
      const hold: PaidHold = { reason: "network", at, detail: { drops: count.drops, attempt: count.continues, nextAt: this.#w.isoAfter(afterMs) } };
      this.#raise(work, hold);
      if (this.#raiseWon) this.#armRetry(hold, afterMs);
      return "held";
    }
    this.#drops.set(job, count);
    return this.#raise(work, { reason: "network", at, detail: { drops: count.drops, attempt: count.continues, nextAt: null } });
  }

  /** The price list did not load: retried after 5, 15 and 60 minutes, then it holds for a person. */
  #priceUnavailable(work: Work): "held" {
    const at = this.#at();
    const used = this.#priceRetries;
    if (used >= MOCK_PRICE_WAITS_MS.length) return this.#raise(work, { reason: "price-unavailable", at, detail: { attempt: used, nextAt: null } });
    this.#priceRetries = used + 1;
    const afterMs = MOCK_PRICE_WAITS_MS[used] ?? 0;
    const hold: PaidHold = { reason: "price-unavailable", at, detail: { attempt: used + 1, nextAt: this.#w.isoAfter(afterMs) } };
    this.#raise(work, hold);
    if (this.#raiseWon) this.#armRetry(hold, afterMs);
    return "held";
  }

  /** The timer of a waiting hold: when it fires the launch runs on, if it still runs, the hold is still the one that stands and the ledger admits it. */
  #armRetry(hold: PaidHold, afterMs: number): void {
    this.#retry?.();
    this.#retry = this.#w.schedule(afterMs, () => {
      this.#retry = null;
      if (this.#launch.status !== "running" || this.#launch.paidHold !== hold) return;
      this.#host.enter();
      try {
        if (this.#w.admission() !== null || this.#w.keyState() !== "ok") {
          // The wait ends and a person decides: the same hold with no retry left.
          if (hold.reason === "network") this.#launch.paidHold = { ...hold, detail: { ...hold.detail, nextAt: null } };
          else if (hold.reason === "price-unavailable") this.#launch.paidHold = { ...hold, detail: { ...hold.detail, nextAt: null } };
        } else {
          this.#launch.paidHold = null;
          this.#resumePending = true;
          this.#schedule(true);
        }
        this.#sync();
        this.#announceIfChanged();
      } finally {
        this.#host.leave();
      }
    });
  }

  /** The avatars a hold parked go back to where they were. */
  #unpark(): void {
    for (const work of this.#work) if (work.waiting === "paid-hold") work.waiting = null;
  }

  /**
   * What «Продолжить» (or the end of a wait) lets the first pass after it do, as the engine's `begin` does: the parked avatars go back to their phase, an approved set draws, an avatar
   * archived meanwhile leaves. The answer to the click still shows the rows as they were, as the engine's does: the rows move when the pass runs.
   */
  #applyResume(): void {
    this.#resumePending = false;
    this.#unpark();
    for (const work of this.#work) {
      if (work.skipped === null && !this.#w.avatarActive(work.avatarId)) this.#skip(work, "archived");
      else if (work.phase === "approved-waiting") work.phase = "drawing";
      // A compose whose request died with the process is made again (its set stays; the ids are the same).
      else if (work.phase === "composing" && ![...this.#open.values()].some((r) => r.live && r.avatarId === work.avatarId)) work.phase = "planned";
    }
  }

  // ---------- the free path ----------

  /** One pass of the free path: photos to videos, videos to a track, to the export folder, to a render, to done. */
  #free(): boolean {
    let moved = false;
    const folder = this.#exportGate();
    for (const work of this.#work) {
      if (work.skipped !== null) continue;
      if (!this.#w.libraryKnown(work.avatarId)) {
        this.#libraryUnknown(work);
        continue;
      }
      if (work.unknownLogged) {
        work.unknownLogged = false;
        if (work.waiting === "library-unknown") work.waiting = null;
      }
      if (!work.libraryDone) {
        work.libraryDone = true;
        moved = this.#assignLibrary(work) || moved;
      }
      moved = this.#assignGenerated(work) || moved;
      moved = this.#advance(work, folder) || moved;
    }
    this.#holdExport(folder);
    return moved;
  }

  /** The library cannot say which photos are free: nothing is picked or dropped, the row of a free-path avatar says so, and the wait is logged once. */
  #libraryUnknown(work: Work): void {
    this.#worldWait = true;
    if (!work.unknownLogged) {
      work.unknownLogged = true;
      this.#log({ at: this.#at(), kind: "library-unknown", avatarId: work.avatarId });
    }
    if (work.toGenerate === 0 && work.waiting === null) work.waiting = "library-unknown";
  }

  #assignLibrary(work: Work): boolean {
    let moved = false;
    const taken = new Set(this.#work.flatMap((w) => w.slots.flatMap((s) => s.photoIds)));
    for (const slot of work.slots) {
      if (slot.source !== "library" || slot.state !== "planned") continue;
      const ids = this.#w.claimPhotos(work.avatarId, this.#categories, slot.size, taken);
      moved = true;
      if (ids === null) {
        slot.state = "dropped";
        slot.dropReason = "not-enough-photos";
        continue;
      }
      for (const id of ids) taken.add(id);
      slot.photoIds = ids;
      slot.state = "assigned";
    }
    return moved;
  }

  /**
   * Generated videos take the photos that arrived, the first videos first. As in the engine, only the photos of a slice that has ENDED arrive (`sliceRuns` lists the runs that ended): a
   * slice is 25 photos, so an avatar of 10 photos has its videos assigned when the whole draw is done, and one of 60 gets its first videos after the first 25.
   */
  #assignGenerated(work: Work): boolean {
    let moved = false;
    let start = 0;
    const arrived = work.drawn >= work.toGenerate ? work.drawn : Math.floor(work.drawn / LAUNCH_SLICE_MAX_PHOTOS) * LAUNCH_SLICE_MAX_PHOTOS;
    for (const slot of work.slots) {
      if (slot.source !== "generated") continue;
      const end = slot.needDrawn;
      if (slot.state === "planned" && arrived >= end) {
        slot.photoIds = work.drawnIds.slice(start, end);
        slot.state = "assigned";
        moved = true;
      }
      start = end;
    }
    return moved;
  }

  #exportGate(): { reason: NonNullable<FreeHold>["detail"]["exportReason"]; neededBytes: number | null; freeBytes: number | null } | null {
    const reason = this.#w.exportReason();
    if (reason !== null) return { reason, neededBytes: null, freeBytes: null };
    const free = this.#w.exportFreeBytes();
    if (free !== null && free < MOCK_DISK_PER_VIDEO) return { reason: "not-enough-space", neededBytes: MOCK_DISK_PER_VIDEO, freeBytes: free };
    return null;
  }

  /** The free hold of the export folder, written when the reason changes and cleared when the folder answers or no video needs it. */
  #holdExport(folder: { reason: NonNullable<FreeHold>["detail"]["exportReason"]; neededBytes: number | null; freeBytes: number | null } | null): void {
    const waiting = this.#work.some((w) => w.skipped === null && w.slots.some((s) => s.state === "assigned" && s.track !== null));
    if (folder === null || !waiting) {
      if (this.#launch.freeHold !== null) this.#launch.freeHold = null;
      this.#exportLogged = null;
      return;
    }
    this.#worldWait = true;
    const sig = JSON.stringify([folder.reason, folder.neededBytes, folder.freeBytes]);
    if (sig === this.#exportLogged && this.#launch.freeHold !== null) return;
    this.#exportLogged = sig;
    this.#launch.freeHold = { reason: "export", at: this.#at(), detail: { exportReason: folder.reason, neededBytes: folder.neededBytes, freeBytes: folder.freeBytes } };
    this.#log({ at: this.#at(), kind: "hold-export", exportReason: folder.reason });
  }

  /** Assigned videos get a track and a render when the folder allows it; renders count down and land. */
  #advance(work: Work, folder: { reason: string } | null): boolean {
    let moved = false;
    for (const slot of work.slots) {
      if (slot.state === "rendering") {
        moved = true;
        // The folder went away while the render ran (the engine's job ends EXPORT_UNAVAILABLE): not a failed render. The video goes back with its photos and track, the folder holds the renders,
        // and no retry is used.
        if (folder !== null) {
          this.#w.holdPhotos(slot.photoIds, false);
          slot.state = "assigned";
          slot.videoId = null;
          continue;
        }
        slot.renderLeft -= 1;
        if (slot.renderLeft > 0) continue;
        if (this.#host.renderFaults.left > 0) this.#renderFailed(work, slot);
        else this.#land(work, slot);
        continue;
      }
      if (slot.state !== "assigned" && slot.state !== "waiting-music") continue;
      const track = this.#w.trackFor(RUN_DURATION_MS[slot.shape]);
      if (track === null) {
        if (slot.state === "assigned") {
          slot.state = "waiting-music";
          this.#log({ at: this.#at(), kind: "waiting-music", avatarId: work.avatarId, key: slot.key, neededMs: RUN_DURATION_MS[slot.shape] });
          moved = true;
        }
        this.#worldWait = true;
        continue;
      }
      // The track is chosen before the folder is asked, as the engine does: a video that has one and no folder to go to is what the free hold is about.
      slot.track = track;
      slot.state = "assigned";
      if (folder !== null) continue;
      const rendering = this.#work.reduce((sum, w) => sum + w.slots.filter((s) => s.state === "rendering").length, 0);
      if (rendering >= MAX_RENDERS) continue;
      slot.state = "rendering";
      slot.renderLeft = RENDER_TICKS;
      slot.videoId = this.#w.newVideoId();
      this.#w.holdPhotos(slot.photoIds, true);
      moved = true;
    }
    return moved;
  }

  /** A render ended without a video (the engine's `RENDER_FAILED` / a timeout): the first time the video is submitted again, free; the second time it is dropped and its photos are free (§4.6). */
  #renderFailed(work: Work, slot: Slot): void {
    this.#host.renderFaults.left -= 1;
    this.#w.holdPhotos(slot.photoIds, false);
    slot.videoId = null;
    if (!slot.retried) {
      slot.retried = true;
      slot.state = "assigned";
      this.#log({ at: this.#at(), kind: "render-retry", avatarId: work.avatarId, key: slot.key });
      return;
    }
    slot.state = "dropped";
    slot.dropReason = "render-failed";
    this.#log({ at: this.#at(), kind: "render-dropped", avatarId: work.avatarId, key: slot.key });
  }

  /** A render lands: the record is the library's, the log says so. */
  #land(work: Work, slot: Slot): void {
    const track = slot.track;
    if (slot.videoId === null || track === null) return;
    this.#w.storeVideo({
      launchId: this.#launch.launchId,
      avatarId: work.avatarId,
      videoId: slot.videoId,
      photoIds: slot.photoIds,
      durationMs: RUN_DURATION_MS[slot.shape],
      bytes: RUN_BYTES[slot.shape],
      track,
      n: Number(slot.key.split("-")[1] ?? 1),
    });
    this.#w.holdPhotos(slot.photoIds, false);
    slot.state = "done";
    this.#log({ at: this.#at(), kind: "video-done", avatarId: work.avatarId, key: slot.key, shape: slot.shape, size: slot.size, durationMs: RUN_DURATION_MS[slot.shape], bytes: RUN_BYTES[slot.shape] });
  }

  // ---------- the end ----------

  #finished(): boolean {
    if ([...this.#open.values()].some((r) => r.live)) return false;
    return this.#work.every((work) => {
      if (work.skipped !== null) return true;
      if (work.toGenerate > 0 && work.drawn < work.toGenerate && !work.capped) return false;
      return work.slots.every((s) => s.state === "done" || s.state === "dropped");
    });
  }

  /** A `job-failed` fault is for a draw step; a launch that ends without meeting it does not leave it armed for the next launch. */
  #dropUnmetJobFaults(): void {
    for (let i = this.#host.faults.length - 1; i >= 0; i--) if (this.#host.faults[i] === "job-failed") this.#host.faults.splice(i, 1);
  }

  #finish(): void {
    this.#dropUnmetJobFaults();
    this.#cancelAll();
    for (const work of this.#work) if (work.skipped === null) work.phase = "done";
    const launch = this.#launch;
    launch.paidHold = null;
    launch.freeHold = null;
    for (const work of this.#work) work.waiting = null;
    this.#sync();
    // What the abandoned requests left open stays open in the ledger until a reconcile; the launch's figure counts it at its worst case.
    launch.spentMicros = this.spent();
    this.#open.clear();
    launch.status = "done";
    launch.endedAt = this.#at();
    const videosDone = this.#work.reduce((sum, w) => sum + w.slots.filter((s) => s.state === "done").length, 0);
    this.#log({ at: launch.endedAt, kind: "done", videosDone, videosPlanned: launch.plan.videos });
    this.#sync();
    this.#lastView = "";
    this.#host.announce();
  }

  // ---------- the owner's clicks ----------

  /** How many requests and renders are in flight (what «Ставим на паузу…» counts). */
  flight(): { requests: number; renders: number } {
    return {
      requests: [...this.#open.values()].filter((r) => r.live).length,
      renders: this.#work.reduce((sum, w) => sum + w.slots.filter((s) => s.state === "rendering").length, 0),
    };
  }

  /** The soft stop: what is in flight finishes at the next pass. With nothing in flight it is over at once. Answers whether the launch is drained. */
  softStop(): boolean {
    this.#retry?.();
    this.#retry = null;
    const { requests, renders } = this.flight();
    if (requests === 0 && renders === 0) {
      this.#cancelAll();
      return true;
    }
    this.#schedule(true);
    return false;
  }

  /** The drain tick of a pause or a stop: the requests in flight settle, the renders land, then the launch is paused or stopped. */
  #drain(): void {
    this.#settleLive();
    for (const work of this.#work) for (const slot of work.slots) if (slot.state === "rendering") this.#land(work, slot);
    const launch = this.#launch;
    if (launch.status === "pausing") {
      launch.status = "paused";
      launch.paused = { cause: "owner", at: this.#at() };
      this.#log({ at: this.#at(), kind: "paused" });
    } else {
      this.completeStop();
      return;
    }
    this.#sync();
    this.#lastView = "";
    this.#host.announce();
  }

  /** The end of a stop: what was not finished is dropped, the sets go back to the owner, the figure is what the ledger holds. */
  completeStop(): void {
    this.#dropUnmetJobFaults();
    this.#cancelAll();
    this.#settleLive();
    for (const work of this.#work) for (const slot of work.slots) if (slot.state === "rendering") this.#land(work, slot);
    const launch = this.#launch;
    for (const work of this.#work) {
      work.waiting = null;
      for (const slot of work.slots) {
        if (slot.state === "done" || slot.state === "dropped") continue;
        this.#w.holdPhotos(slot.photoIds, false);
        slot.state = "dropped";
        slot.dropReason = "launch-stopped";
      }
      // A set the launch composed and never drew from goes back to the owner as an open set of their own (§3.7): a draw that began has used it.
      if (work.setId !== null && work.drawn === 0) this.#w.leaveOpenSet(work.avatarId, work.setId, work.written ? work.toGenerate : 0, work.toGenerate);
    }
    launch.paidHold = null;
    launch.freeHold = null;
    launch.paused = null;
    this.#sync();
    launch.spentMicros = this.spent();
    this.#open.clear();
    launch.status = "stopped";
    launch.endedAt = this.#at();
    this.#log({ at: launch.endedAt, kind: "stopped", spentMicros: launch.spentMicros });
    this.#sync();
    this.#lastView = "";
    this.#host.announce();
  }

  /** «Продолжить»: the hold is cleared and the passes start again; the first of them puts the rows right (`#applyResume`). */
  resumed(): void {
    this.#launch.paidHold = null;
    this.#retry?.();
    this.#retry = null;
    this.#resumePending = true;
    this.#schedule(true);
  }

  #skip(work: Work, reason: Extract<SkipReason, "archived">): void {
    work.skipped = { reason };
    this.#log({ at: this.#at(), kind: "skipped", avatarId: work.avatarId, reason });
    for (const slot of work.slots) {
      if (slot.state === "done" || slot.state === "rendering") continue;
      this.#w.holdPhotos(slot.photoIds, false);
      slot.state = "dropped";
      slot.dropReason = "avatar-skipped";
    }
  }

  /** The owner reviewed an avatar's set. Answers false when the avatar is not waiting for it. */
  review(avatarId: string, paused: boolean): number | null {
    const work = this.#work.find((w) => w.avatarId === avatarId);
    if (work === undefined || work.phase !== "awaiting-review") return null;
    work.phase = paused ? "approved-waiting" : "drawing";
    this.#sync();
    if (!paused) this.#schedule(true);
    return work.toGenerate;
  }

  /** The process died (or the app quit): nothing is in flight any more, the requests' reserves stay open, the renders are gone. */
  processEnded(cause: "quit" | "engine-restart"): { requests: number } {
    this.#cancelAll();
    const requests = [...this.#open.values()].filter((r) => r.live).length;
    for (const reserve of this.#open.values()) reserve.live = false;
    for (const work of this.#work) {
      for (const slot of work.slots) {
        if (slot.state === "rendering") {
          this.#w.holdPhotos(slot.photoIds, false);
          slot.state = "assigned";
          slot.videoId = null;
          slot.track = null;
        }
      }
      work.waiting = work.waiting === "library-unknown" || work.waiting === "paid-hold" ? work.waiting : null;
    }
    const launch = this.#launch;
    const at = this.#at();
    if (launch.status === "running" || launch.status === "pausing") {
      launch.status = "paused";
      launch.paused = { cause, at };
      // A graceful quit writes the pause itself («host-quit»); the next process then finds a launch already paused and has nothing to add. A crash leaves `running` on the disk, and the
      // next process reads it as paused and says so («app-restarted»).
      this.#log(cause === "quit" ? { at, kind: "host-quit", requests } : { at, kind: "app-restarted", cause, requests });
    }
    this.#sync();
    this.#lastView = "";
    return { requests };
  }

  /** The avatar's scene set of this launch is open in the library until the first slice is bought: composed (or being), and no image requested. */
  holdsOpenSet(avatarId: string): boolean {
    const work = this.#work.find((w) => w.avatarId === avatarId);
    if (work === undefined || work.setId === null || work.drawn > 0 || !this.#unfinished()) return false;
    return ![...this.#open.values()].some((r) => r.avatarId === avatarId && r.kind === "image");
  }

  /** A count the admission rule needs: open reserves no request is out for. */
  openUnsettled(): number {
    return this.unsettled().requests;
  }
}

/**
 * How much a hold must be respected, as the engine's `holdRank` has it: 0 a retry is scheduled; 1 a person acts and a click clears it (credits, key, price, the month, a price list that stayed
 * unavailable, a failed job's `internal`); 2 a network hold with no retry (only a reconcile makes the click safe, A19); 3 halt and the allocation check. The mock cannot import the engine's.
 */
export function holdRank(hold: PaidHold): 0 | 1 | 2 | 3 {
  if (hold.reason === "network") return hold.detail.nextAt === null ? 2 : 0;
  if (hold.reason === "price-unavailable") return hold.detail.nextAt === null ? 1 : 0;
  if (hold.reason === "internal") return hold.detail.kind === "job-failed" ? 1 : 3;
  return hold.reason === "halt" ? 3 : 1;
}

/** The log line a hold writes when it is raised. */
export function holdLine(hold: PaidHold, at: string): LogLine {
  switch (hold.reason) {
    case "budget":
      return { at, kind: "hold-budget", holdKind: hold.detail.kind, freeMicros: hold.detail.freeMicros, needMicros: hold.detail.needMicros };
    case "credits":
      return { at, kind: "hold-credits" };
    case "key":
      return { at, kind: "hold-key" };
    case "halt":
      return { at, kind: "hold-halt", code: hold.detail.code };
    case "network":
      return { at, kind: "hold-network", drops: hold.detail.drops };
    case "price-unavailable":
      return { at, kind: "hold-price-unavailable", attempt: hold.detail.attempt };
    case "price":
      return { at, kind: "hold-price", detail: hold.detail };
    case "internal":
      return { at, kind: "hold-internal", holdKind: hold.detail.kind, ...(hold.detail.message === undefined ? {} : { detail: hold.detail.message }) };
  }
}
