import { raiseBudgetToMicros } from "../../shared/autopilot/money";
import { isRemoved, joinVideoFacts, publishedOverall, type MarksRead } from "../../shared/autopilot/videoFacts";
import {
  LAUNCH_SLICE_MAX_PHOTOS,
  LaunchBlocker,
  LaunchPreview,
  LaunchPreviewAvatar,
  LaunchView,
  PROTOCOL_VERSION,
  shapeSizeFits,
  type AutoRefresh,
  type AvatarBlockerCode,
  type AvatarUsage,
  type CategoryRef,
  type EngineError,
  type Estimate,
  type ExportUnavailableReason,
  type FreeHold,
  type LaunchAvatarView,
  type LaunchBlockerCode,
  type LaunchDraft,
  type LaunchDraftInput,
  type LaunchStatus,
  type LaunchSummary,
  type LaunchVideo,
  type LogLine,
  type MonthFit,
  type PaidHold,
  type ResumeBlockedBy,
  type UnreadableLaunch,
  type UnsequencedEvent,
  type VideoShape,
} from "../../shared/engine";
import { MockRun, PAID_FAULTS, type PaidFault } from "./mockLaunchRun";

export { PAID_FAULTS, type PaidFault };

// The mock's autopilot (Stage 4, S4.1, completed by S4.8): the plan and the price, the commands, and a launch that RUNS on the mock's scheduler (mockLaunchRun.ts) the way the engine's
// orchestrator and steps run one.
//
//  - The PLAN and the PRICE follow the plan's rules with the mock's fixed unit prices: shapes by largest remainder, library photos first (slides, then collages, then
//    singles), the rest generated at fixed sizes (a collage of 3, slides of 5), an avatar blocked for an open scene set, over 100 new photos or an unreadable usage, and the
//    month's room against the expected and the worst case. What the engine's planner draws by the seed (the sizes of a library collage and of library slides, the order of the
//    shapes and the categories, the near-duplicate rule) the mock does not model: a plan against the same library may differ in its library photo counts and its keys.
//  - A launch it starts RUNS: it begins at `planned` with nothing spent, and every tick of the mock's clock advances it (composes, waits for the review, draws, assigns, renders), until it is
//    done, or paused, held or stopped by the owner, a fault the testkit armed, or the world (the key, the ledger, the month, the export folder, the tracks).
//  - `launchRun: "canned"` keeps the S4.1 behaviour for the renderer's fixtures and the parity stories that are bound to it: a launch put straight into a canned mid-run state (some videos
//    done, one rendering, spent a fifth of the expected cost) that moves only by the owner's clicks.
//  - It validates and refuses as the engine will, in the order the contract lists; the gates that belong to the mock engine (the library, the key and the ledger, the export
//    folder, the tracks) arrive through `MockAutopilotWorld`.

/** What the mock engine lets the autopilot see of its world, and the clock and the announcements. */
export interface MockAutopilotWorld {
  nowIso(): string;
  /** The time `ms` from now, as the mock's clock reads it (a hold's `nextAt`). */
  isoAfter(ms: number): string;
  nextEventId(): string;
  emit(event: UnsequencedEvent): void;
  /** The mock's scheduler and its step: what a launch's passes run on. */
  schedule(ms: number, task: () => void): () => void;
  readonly stepMs: number;
  usage(avatarId: string): AvatarUsage;
  /** Free scene photos of the avatar in these categories: eligible, in no video, held by no render, not rejected. */
  freePhotos(avatarId: string, categories: readonly CategoryRef[]): number;
  /** Another job of the avatar's own holds it now. */
  busy(avatarId: string): boolean;
  /** The avatar has an open scene set: one of the owner's own, or the unfinished launch's (composed, not drawn from yet). A plan that needs new photos for it cannot start. */
  hasOpenSet(avatarId: string): boolean;
  /** The avatar has an open scene set of the OWNER's own, other than `exceptSetId` (what a launch's compose waits for). */
  hasOwnersOpenSet(avatarId: string, exceptSetId: string): boolean;
  /** The avatar is a saved, active one (it can be archived while a launch is paused). */
  avatarActive(avatarId: string): boolean;
  /** The library can say which of the avatar's photos are free (its usage and drafts are known). */
  libraryKnown(avatarId: string): boolean;
  unit(): MockAutopilotUnit;
  prices(): { prices: Estimate["prices"]; pricesAsOf: string };
  /** The month's budget, and what is committed in it: spent, open, and (A21) the unspent rest of every running job's cap. */
  month(): { budgetMicros: number; committedMicros: number };
  /** The key, then the ledger's admission rule: the engine's first checks before any paid call. */
  paidGate(): EngineError | null;
  keyState(): "ok" | "missing" | "rejected";
  /** `Budget.blocked()` as the engine's launch reads it: a halt, an unreadable ledger, reserves of a previous process (never the reserves of this session). */
  admission(): EngineError | null;
  /** OpenRouter answered 401 to a paid step: the key is marked rejected. */
  rejectKey(): void;
  /** A settle came in above its reserve: the ledger halts until a reconcile. */
  haltLedger(): void;
  /** Reserves the ledger holds for the launch's requests. */
  openReserve(key: string, worstMicros: number): void;
  closeReserve(key: string, costMicros: number): void;
  hasReserve(key: string): boolean;
  /** A reserve of this session was left open (a request that got no answer): the settings screen asks for a reconcile. */
  noteOpenReserve(): void;
  exportReason(): ExportUnavailableReason | null;
  exportFreeBytes(): number | null;
  music(): { candidates: number; ownFlagged: number; explicitSkipped: number; autoRefresh: AutoRefresh; quotaRemaining: number | null };
  /** The track a video of this length is given, or null when none qualifies (no candidate, or every one is too short): the video waits for music. */
  trackFor(neededMs: number): NonNullable<LaunchVideo["track"]> | null;
  balance(): { micros: number; asOf: string } | null;
  /**
   * S4.6g: the ones of `videoIds` that have a record in the mock. A video the mock deleted (or its avatar's) has none: it reads removed, so the window never draws a tile it cannot act
   * on. Undefined: the records cannot be looked at, so nothing reads as removed.
   */
  recordsOf(avatarId: string, videoIds: readonly string[]): ReadonlySet<string> | undefined;
  /** S4.6g: the avatar's «Опубликовано» marks as its log reads (`absent` before the first mark, `unknown` while it is torn). */
  marksOf(avatarId: string): MarksRead;
  /** The library photos a library video takes: `n` free photos of the avatar in these categories that are not in `taken`, or null when there are not enough. */
  claimPhotos(avatarId: string, categories: readonly CategoryRef[], n: number, taken: ReadonlySet<string>): string[] | null;
  /** The photos a launch's videos hold are reserved (not free) until their record lands. */
  holdPhotos(photoIds: readonly string[], held: boolean): void;
  /**
   * The launch's scene set (S4.10 fix D), the way the engine's compose makes one: it exists from the compose's first request (`openLaunchSet`), the writer's answer gives it its sentences
   * (`writeLaunchSet`), the draw's start freezes its scenes (`freezeLaunchSet`), and the end of the launch lets it go (`releaseLaunchSet`: announced, no launch on it).
   */
  openLaunchSet(set: { avatarId: string; sceneSetId: string; count: number; categories: readonly CategoryRef[]; launchId: string }): void;
  /** The compose request goes out: the set's writer job is live (the set reads `writing`, the avatar is claimed) until `writeLaunchSet` or `endLaunchCompose`. */
  startLaunchCompose(sceneSetId: string): void;
  writeLaunchSet(sceneSetId: string): void;
  endLaunchCompose(sceneSetId: string, how: "cancelled" | "gone"): void;
  freezeLaunchSet(sceneSetId: string): void;
  releaseLaunchSet(sceneSetId: string): void;
  /** The set's revision as the library holds it (the owner's edits move it), or null with no such set. */
  launchSetRevision(sceneSetId: string): number | null;
  /**
   * A slice of the draw begins: its run and the job that holds the avatar. Answers the run's id (the first slice's is the set's pre-issued one, which uses the set). With `resume` it is the
   * run of a slice that was stopped (a hold, a pause): the same run under a new job.
   */
  startSlice(slice: { launchId: string; avatarId: string; sceneSetId: string; index: number; photos: number; capMicros: number; category: CategoryRef; resume?: string }): string;
  /** Photos of the slice arrived (their ids, the money they settled). */
  sliceProgress(runId: string, photoIds: readonly string[], settledMicros: number): void;
  /** The slice ended: `done` (its photos are in, or its cap ended it), `cancelled` (a stop or a pause), `gone` (the process died with it: nothing is announced). */
  endSlice(runId: string, how: "done" | "cancelled" | "gone"): void;
  /** `n` photos the launch's draw made for the avatar (new library photos), in order, as the photos of the slice run `runId`. */
  drawPhotos(avatarId: string, n: number, category: CategoryRef, runId: string | null): string[];
  newVideoId(): string;
  /** A render landed: the record of the video, its photos taken, its file in the export folder. */
  storeVideo(video: { launchId: string; avatarId: string; videoId: string; photoIds: readonly string[]; durationMs: number; bytes: number; track: NonNullable<LaunchVideo["track"]>; n: number }): void;
}

/** The mock's fixed unit prices, as the mock prices a run: an attempt, a photo (up to three attempts), the writer's chunk. */
export interface MockAutopilotUnit {
  attemptWorstMicros: number;
  photoExpectedMicros: number;
  photoWorstMicros: number;
  writerChunkWorstMicros: number;
  writerExpectedPerPhotoMicros: number;
}

const SHAPE_ORDER = ["single", "collage", "slides"] as const;
/** The photos a generated video has, and the canned launch's stand-in for the sizes the engine draws by seed. */
const SIZE: Readonly<Record<VideoShape, number>> = { single: 1, collage: 3, slides: 5 };
const DURATION_MS: Readonly<Record<VideoShape, number>> = { single: 8_000, collage: 8_500, slides: 9_000 };
const BYTES: Readonly<Record<VideoShape, number>> = { single: 2_200_000, collage: 2_300_000, slides: 3_100_000 };
const MAX_NEW_PHOTOS = 100;
/** A video's disk need: twice its size estimate. */
const DISK_PER_VIDEO = 9_000_000;
const MOCK_LAUNCH_TRACK = { source: "trending", title: "Soft Static", artist: "Ivo" } as const;

/** The shapes of `total` videos by the mix, by largest remainder; ties go to the earlier shape (single, collage, slides). Whole numbers throughout. */
export function shapeCounts(total: number, mix: { single: number; collage: number; slides: number }): { single: number; collage: number; slides: number } {
  const counts = { single: 0, collage: 0, slides: 0 };
  const remainders: { shape: VideoShape; remainder: number; at: number }[] = [];
  let left = total;
  SHAPE_ORDER.forEach((shape, at) => {
    const share = total * mix[shape];
    counts[shape] = Math.floor(share / 100);
    left -= counts[shape];
    remainders.push({ shape, remainder: share % 100, at });
  });
  remainders.sort((a, b) => b.remainder - a.remainder || a.at - b.at);
  for (const { shape } of remainders.slice(0, left)) counts[shape] += 1;
  return counts;
}

interface PlannedAvatar {
  readonly row: LaunchPreviewAvatar;
  /** The made videos in key order: slides first, then collages, then singles. */
  readonly shapes: readonly VideoShape[];
}

export interface MockLaunch {
  readonly launchId: string;
  readonly createdAt: string;
  endedAt: string | null;
  status: LaunchStatus;
  paused: { cause: "owner" | "quit" | "engine-restart"; at: string } | null;
  readonly draft: LaunchDraft;
  readonly acceptedMicros: number;
  readonly plannedWorstMicros: number;
  readonly plannedExpectedMicros: number;
  readonly plan: { videos: number; photos: number; fromLibrary: number; toGenerate: number };
  /** The figure of a launch the mock does not run (canned, seeded) and of one that ended; a running launch's is `run.spent()`. */
  spentMicros: number;
  activeMs: number;
  avatars: LaunchAvatarView[];
  videos: LaunchVideo[];
  log: LogLine[];
  /** S4.8: what holds the launch's paid work, and its free work. */
  paidHold: PaidHold | null;
  freeHold: FreeHold | null;
  /** S4.8: the owner's paid edits during the review (the mock models none; a seed may say). */
  reviewWritesMicros: number;
  /** The running launch's work; null for a canned or a seeded launch. */
  run: MockRun | null;
}

/**
 * A launch put straight into the library's history (S4.9c, a renderer test and dev control): what `autopilot.list` and `autopilot.get` then read of it, as if
 * the launch had run. Nothing is spent or checked; the view it makes is parsed by the contract, so a seed that breaks it fails loudly.
 */
export type MockSeededLaunch = Omit<MockLaunch, "launchId" | "paidHold" | "freeHold" | "reviewWritesMicros" | "run"> & Partial<Pick<MockLaunch, "paidHold" | "freeHold" | "reviewWritesMicros">>;

type Outcome<T> = { readonly ok: true; readonly result: T } | { readonly ok: false; readonly error: EngineError };
const done = <T>(result: T): Outcome<T> => ({ ok: true, result });
const refuse = (error: EngineError): Outcome<never> => ({ ok: false, error });

const isUnfinished = (status: LaunchStatus): boolean => status !== "done" && status !== "stopped";

export interface MockAutopilotOptions {
  /** `canned` keeps the S4.1 launch (see the header); the default runs it. */
  readonly launchRun?: "timers" | "canned";
}

export class MockAutopilot {
  readonly #world: MockAutopilotWorld;
  #unreadable: UnreadableLaunch[];
  readonly #canned: boolean;
  /** Oldest first. */
  #launches: MockLaunch[] = [];
  #launchCount = 0;
  #seedCount = 0;
  /** The faults armed for the paid steps (`MockEngine.failLaunchPaidStep`): shared with the run, so one armed before the start is met by the first paid step. */
  readonly #faults: PaidFault[] = [];
  /** The renders armed to fail (`MockEngine.failLaunchRender`), shared with the run like the paid faults. */
  readonly #renderFaults = { left: 0 };
  /** While a command or a pass is changing the launch, the money and the settings it causes do not announce it again (the pass announces once, at its end). */
  #depth = 0;

  constructor(world: MockAutopilotWorld, unreadable: readonly UnreadableLaunch[], options: MockAutopilotOptions = {}) {
    this.#world = world;
    this.#unreadable = [...unreadable];
    this.#canned = options.launchRun === "canned";
  }

  // ---------- the plan ----------

  #planAvatar(draft: LaunchDraftInput, avatarId: string): PlannedAvatar {
    const usage = this.#world.usage(avatarId);
    // An avatar whose usage cannot be trusted gives no library photos (§18.6): it is blocked for a plan that uses the library.
    const free = usage.state === "ok" ? this.#world.freePhotos(avatarId, draft.categories) : 0;
    const wanted = shapeCounts(draft.videosPerAvatar, draft.mix);
    let pool = draft.library ? free : 0;
    const made = { single: 0, collage: 0, slides: 0 };
    let fromLibrary = 0;
    let toGenerate = 0;
    for (const shape of ["slides", "collage", "single"] as const) {
      for (let n = 0; n < wanted[shape]; n++) {
        if (pool >= SIZE[shape]) {
          pool -= SIZE[shape];
          fromLibrary += SIZE[shape];
          made[shape] += 1;
        } else if (draft.generate) {
          toGenerate += SIZE[shape];
          made[shape] += 1;
        }
      }
    }
    const blocked: AvatarBlockerCode | null =
      usage.state === "unknown" && draft.library ? "usage-unknown" : toGenerate > MAX_NEW_PHOTOS ? "too-many-photos" : toGenerate > 0 && this.#world.hasOpenSet(avatarId) ? "open-set" : null;
    const shapes: VideoShape[] = [...Array<VideoShape>(made.slides).fill("slides"), ...Array<VideoShape>(made.collage).fill("collage"), ...Array<VideoShape>(made.single).fill("single")];
    const row = LaunchPreviewAvatar.parse({
      avatarId,
      videos: shapes.length,
      shapes: made,
      free,
      fromLibrary,
      toGenerate,
      busy: this.#world.busy(avatarId),
      blocked,
      usage,
    });
    return { row, shapes };
  }

  /** The unfinished launch, if any. */
  #unfinished(): MockLaunch | undefined {
    return this.#launches.find((l) => isUnfinished(l.status));
  }

  /** The plan with its price and everything the plan card shows. `seed` is the draft's own, else drawn here. */
  plan(draft: LaunchDraftInput): { preview: LaunchPreview; planned: readonly PlannedAvatar[] } {
    const planned = draft.avatarIds.map((avatarId) => this.#planAvatar(draft, avatarId));
    const counted = planned.filter((p) => p.row.blocked === null);
    const sum = (pick: (row: LaunchPreviewAvatar) => number): number => counted.reduce((total, p) => total + pick(p.row), 0);
    const totals = { videos: sum((r) => r.videos), photosNeeded: sum((r) => r.fromLibrary + r.toGenerate), fromLibrary: sum((r) => r.fromLibrary), toGenerate: sum((r) => r.toGenerate) };

    const unit = this.#world.unit();
    let worst = 0;
    let expected = 0;
    for (const { row } of counted) {
      worst += Math.ceil(row.toGenerate / LAUNCH_SLICE_MAX_PHOTOS) * unit.writerChunkWorstMicros + row.toGenerate * unit.photoWorstMicros;
      expected += row.toGenerate * unit.writerExpectedPerPhotoMicros + row.toGenerate * unit.photoExpectedMicros;
    }
    const prices = this.#world.prices();

    const month = this.#world.month();
    const live = this.#unfinished();
    const committedMicros = month.committedMicros + (live === undefined ? 0 : this.#remaining(live));
    const freeMicros = Math.max(0, month.budgetMicros - committedMicros);
    const fit: MonthFit = freeMicros >= worst ? "fits" : freeMicros >= expected ? "fits-expected" : "short";

    const blockers: LaunchBlocker[] = planned.flatMap((p) => (p.row.blocked === null ? [] : [LaunchBlocker.parse({ code: p.row.blocked, avatarId: p.row.avatarId })]));
    const global: LaunchBlockerCode[] = [];
    if (live !== undefined) global.push("launch-active");
    if (this.#unreadable.length > 0) global.push("launch-unreadable");
    if (!draft.library && !draft.generate) global.push("nothing-enabled");
    const gate = totals.toGenerate > 0 ? this.#world.paidGate() : null;
    if (gate !== null) global.push(gateBlocker(gate));
    if (totals.videos > 0 && this.#world.exportReason() !== null) global.push("export-unavailable");
    blockers.push(...global.map((code) => LaunchBlocker.parse({ code })));

    this.#seedCount += 1;
    const preview = LaunchPreview.parse({
      planSeed: draft.planSeed ?? this.#seedCount * 7_919,
      avatars: planned.map((p) => p.row),
      totals,
      estimate: { expectedMicros: expected, worstMicros: worst, prices: prices.prices, pricesAsOf: prices.pricesAsOf },
      perShapeExpectedMicros: { single: SIZE.single * unit.photoExpectedMicros, collage: SIZE.collage * unit.photoExpectedMicros, slides: SIZE.slides * unit.photoExpectedMicros },
      month: { budgetMicros: month.budgetMicros, committedMicros, freeMicros, fit, raiseToMicros: raiseBudgetToMicros({ budgetMicros: month.budgetMicros, committedMicros, freeMicros }, worst) },
      balance: this.#world.balance(),
      music: this.#world.music(),
      disk: { neededBytes: totals.videos * DISK_PER_VIDEO, freeBytes: this.#world.exportFreeBytes() },
      timeSeconds: totals.toGenerate * 6 + totals.videos * 12,
      blockers,
    });
    return { preview, planned };
  }

  // ---------- the commands ----------

  estimate(draft: LaunchDraftInput): LaunchPreview {
    return this.plan(draft).preview;
  }

  start(draft: LaunchDraft, acceptedWorstMicros: number): Outcome<{ launch: LaunchView }> {
    const { preview, planned } = this.plan(draft);
    const reason = (launchReason: "open-set" | "too-many-photos" | "usage-unknown" | "launch-unreadable" | "nothing-enabled", detail: string): Outcome<never> => refuse({ code: "VALIDATION", launchReason, detail });
    if (this.#unfinished() !== undefined) return refuse({ code: "IN_FLIGHT", detail: "a launch is already unfinished in this library; stop it or wait for it to end" });
    if (this.#unreadable.length > 0) return reason("launch-unreadable", "a launch file cannot be read; remove the entry first");
    if (!draft.library && !draft.generate) return reason("nothing-enabled", "both the library and the generation are off");
    for (const p of planned) {
      if (p.row.blocked !== null) return reason(p.row.blocked, `avatar ${p.row.avatarId} cannot be planned: ${p.row.blocked}`);
    }
    const gate = preview.totals.toGenerate > 0 ? this.#world.paidGate() : null;
    if (gate !== null) return refuse(gate);
    const exportReason = preview.totals.videos > 0 ? this.#world.exportReason() : null;
    if (exportReason !== null) return refuse({ code: "EXPORT_UNAVAILABLE", exportReason });
    if (acceptedWorstMicros < preview.estimate.worstMicros) return refuse({ code: "PRICE_CHANGED", detail: "the launch's worst case is above the accepted one" });
    if (preview.month.fit === "short") return refuse({ code: "BUDGET_EXCEEDED", detail: "the month has less room than the launch's expected cost" });

    const launch = this.#canned ? this.#buildCanned(draft, acceptedWorstMicros, preview, planned) : this.#buildRun(draft, acceptedWorstMicros, preview, planned);
    this.#launches.push(launch);
    const view = this.#announce(launch);
    launch.run?.begin();
    return done({ launch: view });
  }

  pause(launchId: string): Outcome<{ launch: LaunchView }> {
    const found = this.#find(launchId);
    if (!found.ok) return found;
    const launch = found.result;
    if (launch.status !== "running") return refuse({ code: "VALIDATION", detail: `launch ${launchId} is ${launch.status}, not running` });
    return this.#atomic(() => {
      const run = launch.run;
      if (run === null) {
        launch.status = "paused";
        launch.paused = { cause: "owner", at: this.#world.nowIso() };
        launch.log.push({ at: this.#world.nowIso(), kind: "pausing", requests: this.#inFlight(launch).requests, renders: 0 }, { at: this.#world.nowIso(), kind: "paused" });
        return done({ launch: this.#announce(launch) });
      }
      // The soft stop: with a request or a render in flight the launch is «pausing» until the next pass settles them; with none it is paused at once.
      const flight = run.flight();
      launch.log.push({ at: this.#world.nowIso(), kind: "pausing", requests: flight.requests, renders: flight.renders });
      if (run.softStop()) {
        launch.status = "paused";
        launch.paused = { cause: "owner", at: this.#world.nowIso() };
        launch.log.push({ at: this.#world.nowIso(), kind: "paused" });
      } else {
        launch.status = "pausing";
      }
      return done({ launch: this.#announce(launch) });
    });
  }

  resume(launchId: string, acceptedRemainingMicros: number): Outcome<{ launch: LaunchView }> {
    const found = this.#find(launchId);
    if (!found.ok) return found;
    const launch = found.result;
    // «Продолжить» also clears a paid hold of a launch that runs; a launch that runs with no hold has nothing to continue.
    const clearsHold = launch.status === "running" && launch.paidHold !== null;
    if (launch.status !== "paused" && !clearsHold) return refuse({ code: "VALIDATION", detail: `launch ${launchId} is ${launch.status}, not paused` });
    const blocked = this.#blockage(launch);
    if (blocked !== null) return refuse(blocked.error);
    if (acceptedRemainingMicros < this.#remaining(launch)) return refuse({ code: "PRICE_CHANGED", detail: "the launch's remaining worst case is above the accepted one" });
    return this.#atomic(() => {
      launch.status = "running";
      launch.paused = null;
      launch.paidHold = null;
      launch.log.push({ at: this.#world.nowIso(), kind: "resumed", acceptedRemainingMicros });
      if (launch.run === null) {
        launch.avatars = launch.avatars.map((a): LaunchAvatarView => (a.phase === "approved-waiting" ? { ...a, phase: "drawing", slice: { index: 1, total: Math.max(1, Math.ceil((a.continuePhotos ?? a.photos.total) / LAUNCH_SLICE_MAX_PHOTOS)) } } : a));
      } else {
        launch.run.resumed();
      }
      return done({ launch: this.#announce(launch) });
    });
  }

  stop(launchId: string): Outcome<{ launch: LaunchView }> {
    const found = this.#find(launchId);
    if (!found.ok) return found;
    const launch = found.result;
    if (launch.status !== "running" && launch.status !== "paused" && launch.status !== "pausing") return refuse({ code: "VALIDATION", detail: `launch ${launchId} is ${launch.status}: only a running or paused launch can be stopped` });
    return this.#atomic(() => {
      const run = launch.run;
      if (run === null) {
        launch.status = "stopped";
        launch.paused = null;
        launch.endedAt = this.#world.nowIso();
        // What was not finished is dropped, and the sets of the launch go back to the owner (here: they simply stop being the launch's).
        launch.videos = launch.videos.map((v): LaunchVideo => (v.state === "done" ? v : { ...v, state: "dropped", dropReason: "launch-stopped", videoId: null, bytes: null, publishedAt: null }));
        launch.avatars = launch.avatars.map((a): LaunchAvatarView => {
          const unfinished = launch.videos.filter((v) => v.avatarId === a.avatarId && v.state === "dropped").length;
          return { ...a, dropped: unfinished > 0 ? { count: unfinished, reason: "launch-stopped" } : null, waitingMusic: 0, resumableSlots: 0 };
        });
        launch.log.push({ at: this.#world.nowIso(), kind: "stopped", spentMicros: launch.spentMicros });
        return done({ launch: this.#announce(launch) });
      }
      // «Стоп» is the same soft stop; what is in flight finishes at the next pass, and the launch is «stopping» until then.
      launch.status = "stopping";
      launch.paused = null;
      if (run.softStop()) run.completeStop();
      return done({ launch: this.#announce(launch) });
    });
  }

  continueAfterReview(launchId: string, avatarId: string, sceneSetId: string, revision: number): Outcome<{ launch: LaunchView; draw: "started" | "waits-for-resume" }> {
    const found = this.#find(launchId);
    if (!found.ok) return found;
    const launch = found.result;
    const notAwaiting = refuse({ code: "VALIDATION", sceneReason: "not-awaiting", detail: `avatar ${avatarId} is not waiting for the review of set ${sceneSetId}` });
    const row = launch.avatars.find((a) => a.avatarId === avatarId);
    if (row === undefined || row.sceneSetId !== sceneSetId || row.phase !== "awaiting-review" || !isUnfinished(launch.status) || launch.status === "stopping") return notAwaiting;
    if (row.setRevision !== revision) return refuse({ code: "SCENES_CHANGED", detail: `scene set ${sceneSetId} moved since revision ${revision}` });
    const photos = row.continuePhotos ?? 0;
    // While the launch is paused or pausing the approval is only recorded; the draw waits for «Продолжить».
    const paused = launch.status !== "running";
    return this.#atomic(() => {
      if (launch.run === null) {
        launch.avatars = launch.avatars.map((a): LaunchAvatarView =>
          a.avatarId !== avatarId ? a : { ...a, phase: paused ? "approved-waiting" : "drawing", slice: paused ? null : { index: 1, total: Math.max(1, Math.ceil(photos / LAUNCH_SLICE_MAX_PHOTOS)) } },
        );
      } else {
        launch.run.review(avatarId, paused);
      }
      launch.log.push(
        paused ? { at: this.#world.nowIso(), kind: "review-approved-paused", avatarId, photos } : { at: this.#world.nowIso(), kind: "review-continued", avatarId, photos, writtenByOwner: 0 },
      );
      return done({ launch: this.#announce(launch), draw: paused ? ("waits-for-resume" as const) : ("started" as const) });
    });
  }

  list(): { launches: LaunchSummary[]; unreadable: UnreadableLaunch[] } {
    const launches = [...this.#launches].reverse().map(
      (l): LaunchSummary => ({
        launchId: l.launchId,
        createdAt: l.createdAt,
        endedAt: l.endedAt,
        status: l.status,
        avatarCount: l.draft.avatarIds.length,
        avatarIds: [...l.draft.avatarIds],
        videosDone: l.videos.filter((v) => v.state === "done" && !isRemoved(this.#recordsOf(l, v.avatarId), v.videoId)).length,
        videosPlanned: l.plan.videos,
        spentMicros: this.#spentOf(l),
        acceptedMicros: l.acceptedMicros,
        plannedWorstMicros: l.plannedWorstMicros,
      }),
    );
    return { launches, unreadable: [...this.#unreadable] };
  }

  get(launchId: string): Outcome<{ launch: LaunchView; log: LogLine[]; videos: LaunchVideo[]; published?: "ok" | "unknown" }> {
    const found = this.#find(launchId);
    if (!found.ok) return found;
    const launch = found.result;
    // S4.6g: the same join as the engine's (shared/autopilot/videoFacts.ts): the log's marks, and the videos whose records are gone.
    const avatars = [...new Set(launch.videos.filter((v) => v.state === "done").map((v) => v.avatarId))];
    const marks = new Map(avatars.map((avatarId) => [avatarId, this.#world.marksOf(avatarId)] as const));
    const videos = launch.videos.map((v) => joinVideoFacts(v, this.#recordsOf(launch, v.avatarId), marks.get(v.avatarId)));
    const published = publishedOverall([...marks.values()]);
    return done({ launch: this.#view(launch), log: launch.log.slice(-500), videos, ...(published === undefined ? {} : { published }) });
  }

  /**
   * S4.6p: what `runs.estimateImages { launchId, avatarId }` is priced for, from the view the window reads: the photos the unfinished launch still has to draw for the avatar
   * (before the draw: the ones «Продолжить запуск» would draw; while it draws: those not drawn yet; afterwards none) and the avatar's draw allocation. NOT_FOUND for a launch that is
   * not the unfinished one and for an avatar it does not hold, as the engine answers. The price is the engine's to put on them (`MockEngine`).
   */
  imagesLeft(launchId: string, avatarId: string): Outcome<{ photos: number; allocationMicros: number }> {
    const found = this.#find(launchId);
    if (!found.ok) return found;
    if (!isUnfinished(found.result.status)) return refuse({ code: "NOT_FOUND", detail: `no unfinished launch ${launchId}` });
    const row = this.#view(found.result).avatars.find((a) => a.avatarId === avatarId);
    if (row === undefined) return refuse({ code: "NOT_FOUND", detail: `launch ${launchId} holds no avatar ${avatarId}` });
    const beforeDraw = row.phase === "planned" || row.phase === "composing" || row.phase === "awaiting-review" || row.phase === "approved-waiting";
    // As the engine counts: an avatar the launch has finished with (done, montage, skipped) has none; one parked by a paid hold keeps the photos it has not drawn (none while its scenes are not written).
    const parked = row.phase === "waiting" && row.waiting?.reason === "paid-hold";
    const photos = beforeDraw ? (row.continuePhotos ?? 0) : row.phase === "drawing" || parked ? ((row.continuePhotos ?? 0) === 0 ? 0 : Math.max(0, row.photos.total - row.photos.done)) : 0;
    return done({ photos, allocationMicros: row.drawAllocationMicros ?? 0 });
  }

  /** The records the launch's videos of one avatar still have. */
  #recordsOf(launch: MockLaunch, avatarId: string): ReadonlySet<string> | undefined {
    return this.#world.recordsOf(
      avatarId,
      launch.videos.flatMap((v) => (v.avatarId === avatarId && v.videoId !== null ? [v.videoId] : [])),
    );
  }

  removeUnreadable(entryId: string): Outcome<Record<string, never>> {
    const at = this.#unreadable.findIndex((u) => u.entryId === entryId);
    if (at < 0) return refuse({ code: "NOT_FOUND", detail: "no unreadable launch entry matches" });
    this.#unreadable.splice(at, 1);
    return done({});
  }

  /**
   * S4.9c: a launch seeded into the history (`MockSeededLaunch`), built by `build` once its id is known (its videos' records name it). Kept in the order the
   * launches were made, so `list` stays newest first whatever order they are seeded in. Answers the launch's id.
   */
  seed(build: (launchId: string) => MockSeededLaunch): string {
    this.#launchCount += 1;
    const launchId = `launch-${String(this.#launchCount).padStart(8, "0")}`;
    const seeded = build(launchId);
    const launch: MockLaunch = { launchId, ...seeded, paidHold: seeded.paidHold ?? null, freeHold: seeded.freeHold ?? null, reviewWritesMicros: seeded.reviewWritesMicros ?? 0, run: null };
    // The contract judges the seed now, not at the first read.
    this.#view(launch);
    this.#launches.push(launch);
    this.#launches.sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
    return launchId;
  }

  /** Whether `launchId` names a launch of this library that is not done or stopped (a run or a set says it is the launch's only while so). */
  isUnfinished(launchId: string): boolean {
    return this.#launches.some((l) => l.launchId === launchId && isUnfinished(l.status));
  }

  /** The unfinished launch as `Snapshot.autopilot` shows it, or null. */
  active(): LaunchView | null {
    const live = this.#unfinished();
    return live === undefined ? null : this.#view(live);
  }

  // ---------- the engine's re-announcements and the testkit ----------

  /**
   * The unfinished launch is told again (S4.6w H1): what its view derives from the money, the key or the monthly budget changed without a write of the launch (a reconcile closed
   * its open reserves; R and what closes «Продолжить» moved). The mock engine calls it from its money and settings announcements, as the engine does from `#emitMoney` and `#emitSettings`.
   */
  refresh(): void {
    if (this.#depth > 0) return;
    const live = this.#unfinished();
    if (live !== undefined) this.#announce(live);
  }

  /** The owner changed a scene set the unfinished launch holds (an edit during the review): the launch reads its rows again (the set's revision) and is announced, as the engine's `onSetChanged` does. */
  setChanged(launchId: string, _sceneSetId: string): void {
    const launch = this.#launches.find((l) => l.launchId === launchId);
    if (launch === undefined || launch.run === null || !isUnfinished(launch.status)) return;
    launch.run.resync();
    if (this.#depth === 0) this.#announce(launch);
  }

  /** Whether the unfinished launch holds an open scene set of this avatar: composed, and no photo of it bought yet (the engine's library counts it as the avatar's open set). */
  holdsOpenSet(avatarId: string): boolean {
    return this.#unfinished()?.run?.holdsOpenSet(avatarId) ?? false;
  }

  /** Whether the unfinished launch has a paid request out: a reconcile refuses `IN_FLIGHT` while any paid job runs (a request in flight cannot be settled from outside). */
  hasLiveRequests(): boolean {
    return (this.#unfinished()?.run?.flight().requests ?? 0) > 0;
  }

  /** Arms `fault` for the next `times` paid steps of the running launch (or of the next one): they meet it as the engine's steps meet the same cause. */
  failPaidStep(fault: PaidFault, times: number): void {
    for (let i = 0; i < times; i++) this.#faults.push(fault);
  }

  /** Arms the next `times` landings of the running launch's renders to fail (the engine's `RENDER_FAILED`): the first failure of a video is retried free, the second drops it. */
  failRenders(times: number): void {
    this.#renderFaults.left += times;
  }

  /** The process ended (a crash or an automatic restart): the engine reads the running launch as paused by the restart, and its requests' reserves stay open. */
  engineRestarted(): void {
    this.#processEnded("engine-restart");
  }

  /** The owner quit the app: the running launch is persisted as paused by the quit. */
  quit(): void {
    this.#processEnded("quit");
  }

  #processEnded(cause: "quit" | "engine-restart"): void {
    const launch = this.#unfinished();
    const run = launch?.run ?? null;
    if (launch === undefined || run === null) return;
    this.#atomic(() => {
      if (launch.status === "stopping") {
        run.completeStop();
        return;
      }
      run.processEnded(cause);
      this.#announce(launch);
    });
  }

  // ---------- the launch ----------

  #find(launchId: string): Outcome<MockLaunch> {
    const launch = this.#launches.find((l) => l.launchId === launchId);
    return launch === undefined ? refuse({ code: "NOT_FOUND", detail: `no launch ${launchId} in the open library` }) : done(launch);
  }

  #atomic<T>(work: () => T): T {
    this.#depth += 1;
    try {
      return work();
    } finally {
      this.#depth -= 1;
    }
  }

  /** What the launch has spent: the running launch's committed money, else its figure. */
  #spentOf(launch: MockLaunch): number {
    return launch.run !== null && isUnfinished(launch.status) ? launch.run.spent() : launch.spentMicros;
  }

  /** What the launch can still spend: its planned worst case less what it spent. */
  #remaining(launch: MockLaunch): number {
    return isUnfinished(launch.status) ? Math.max(0, launch.plannedWorstMicros - this.#spentOf(launch)) : 0;
  }

  #inFlight(launch: MockLaunch): { requests: number; openMicros: number } {
    if (launch.run !== null) return launch.run.inFlight();
    if (launch.status !== "running") return { requests: 0, openMicros: 0 };
    // Open reserves are part of what the launch spent (the contract checks it), so no more requests are out than that sum can hold.
    const worst = this.#world.unit().attemptWorstMicros;
    const requests = Math.min(launch.avatars.filter((a) => a.phase === "drawing").length * 2, worst > 0 ? Math.floor(launch.spentMicros / worst) : 0);
    return { requests, openMicros: requests * worst };
  }

  /**
   * S4.6v: the open reserves no request is out for. A running launch's are the ones a drop abandoned and a restart left (the run tracks them). A canned launch has no process to die: it has them
   * only while PAUSED and the ledger asks for a reconcile, one request per drawing avatar's pair, bounded by what the launch spent.
   */
  #unsettled(launch: MockLaunch): { requests: number; openMicros: number } {
    const none = { requests: 0, openMicros: 0 };
    if (launch.run !== null) return launch.run.unsettled();
    if (launch.status !== "paused" || this.#world.paidGate()?.code !== "RECONCILE_REQUIRED") return none;
    const worst = this.#world.unit().attemptWorstMicros;
    const requests = Math.min(launch.avatars.filter((a) => a.phase === "drawing" || a.phase === "approved-waiting").length * 2, worst > 0 ? Math.floor(launch.spentMicros / worst) : 0);
    return requests > 0 ? { requests, openMicros: requests * worst } : none;
  }

  /**
   * Whether «Продолжить · до $R» may let paid work run, by the engine's one rule (A19): the ledger's admission and the key, then the launch's own hold, per reason. Never the settings
   * screen's `reconcileNeeded`, which turns on for any reserve of this session left open. A launch with no paid work (W′ = 0) needs neither the ledger nor the key.
   */
  #blockage(launch: MockLaunch): { by: ResumeBlockedBy; error: EngineError } | null {
    if (launch.plannedWorstMicros > 0) {
      const gate = this.#world.admission();
      if (gate !== null) return { by: blockedByOf(gate), error: gate };
      if (this.#world.keyState() !== "ok") return { by: "key", error: { code: "AUTH_INVALID", detail: "the stored OpenRouter API key cannot be used; store a new key to continue the launch" } };
    }
    const hold = launch.paidHold;
    if (hold === null) return null;
    switch (hold.reason) {
      case "budget": {
        const month = this.#world.month();
        const free = Math.max(0, month.budgetMicros - month.committedMicros);
        return free >= hold.detail.needMicros ? null : { by: "budget", error: { code: "VALIDATION", detail: `the month has ${free} µ$ of room, the held step needs ${hold.detail.needMicros} µ$` } };
      }
      case "network":
        // A hold with a retry still to come is the wait of an automatic continue: the click only skips the wait. One with none needs the launch's unanswered requests settled first.
        if (hold.detail.nextAt !== null) return null;
        return (launch.run?.openUnsettled() ?? 0) === 0 ? null : { by: "network", error: { code: "VALIDATION", detail: "requests of the launch got no answer; reconcile in Settings first, then continue" } };
      case "internal":
        // A job that failed in a way no row covers is retried by the click; the launch's own allocation check has no exit but «Стоп».
        if (hold.detail.kind === "job-failed") return null;
        return { by: "internal", error: { code: "VALIDATION", detail: "the launch's own check failed; its only exit is «Стоп»" } };
      case "credits":
      case "key":
      case "halt":
      case "price":
      case "price-unavailable":
        return null;
    }
  }

  /** What stops «Продолжить · до $R» now: only a paused launch, or a running one with a paid hold, has the button. */
  #resumeBlockedBy(launch: MockLaunch): ResumeBlockedBy | null {
    if (!(launch.status === "paused" || (launch.status === "running" && launch.paidHold !== null))) return null;
    return this.#blockage(launch)?.by ?? null;
  }

  #view(launch: MockLaunch): LaunchView {
    const spent = this.#spentOf(launch);
    return LaunchView.parse({
      launchId: launch.launchId,
      createdAt: launch.createdAt,
      endedAt: launch.endedAt,
      activeMs: launch.activeMs,
      status: launch.status,
      paused: launch.paused,
      paidHold: launch.paidHold,
      freeHold: launch.freeHold,
      draft: launch.draft,
      acceptedMicros: launch.acceptedMicros,
      plannedWorstMicros: launch.plannedWorstMicros,
      plannedExpectedMicros: launch.plannedExpectedMicros,
      plan: launch.plan,
      spentMicros: spent,
      remainingMicros: Math.max(0, launch.plannedWorstMicros - spent),
      reviewWritesMicros: launch.reviewWritesMicros,
      inFlight: this.#inFlight(launch),
      unsettled: this.#unsettled(launch),
      waitingMusic: launch.avatars.reduce((sum, a) => sum + a.waitingMusic, 0),
      resumeBlockedBy: this.#resumeBlockedBy(launch),
      avatars: launch.avatars,
      logTail: launch.log.slice(-20),
    });
  }

  /** The view, announced: `autopilot.changed` carries the launch whole. */
  #announce(launch: MockLaunch): LaunchView {
    const view = this.#view(launch);
    this.#world.emit({ v: PROTOCOL_VERSION, id: this.#world.nextEventId(), kind: "event", type: "autopilot.changed", payload: { launch: view } });
    return view;
  }

  /** A launch that runs: nothing spent, every avatar `planned`, the log at its first line; the passes do the rest. */
  #buildRun(draft: LaunchDraft, acceptedMicros: number, preview: LaunchPreview, planned: readonly PlannedAvatar[]): MockLaunch {
    this.#launchCount += 1;
    const number = String(this.#launchCount).padStart(8, "0");
    const launchId = `launch-${number}`;
    const createdAt = this.#world.nowIso();
    const launch: MockLaunch = {
      launchId,
      createdAt,
      endedAt: null,
      status: "running",
      paused: null,
      draft,
      acceptedMicros,
      plannedWorstMicros: preview.estimate.worstMicros,
      plannedExpectedMicros: preview.estimate.expectedMicros,
      plan: { videos: preview.totals.videos, photos: preview.totals.photosNeeded, fromLibrary: preview.totals.fromLibrary, toGenerate: preview.totals.toGenerate },
      spentMicros: 0,
      activeMs: 0,
      avatars: [],
      videos: [],
      log: [{ at: createdAt, kind: "start", acceptedMicros }],
      paidHold: null,
      freeHold: null,
      reviewWritesMicros: 0,
      run: null,
    };
    launch.run = new MockRun(
      launch,
      this.#world,
      {
        announce: () => {
          this.#announce(launch);
        },
        enter: () => {
          this.#depth += 1;
        },
        leave: () => {
          this.#depth -= 1;
        },
        faults: this.#faults,
        renderFaults: this.#renderFaults,
      },
      { avatars: planned.map((p) => ({ avatarId: p.row.avatarId, shapes: p.shapes, fromLibrary: p.row.fromLibrary, toGenerate: p.row.toGenerate })), categories: draft.categories, review: draft.sceneReview, number },
    );
    return launch;
  }

  /** A launch in a canned mid-run state, consistent in itself: its videos, rows, log and spend agree. */
  #buildCanned(draft: LaunchDraft, acceptedMicros: number, preview: LaunchPreview, planned: readonly PlannedAvatar[]): MockLaunch {
    this.#launchCount += 1;
    const number = String(this.#launchCount).padStart(8, "0");
    const launchId = `launch-${number}`;
    const createdAt = this.#world.nowIso();
    let firstToReview = true;
    const videos: LaunchVideo[] = [];
    const avatars: LaunchAvatarView[] = planned.map((p, index): LaunchAvatarView => {
      const { row } = p;
      const made = p.shapes.length;
      const finished = Math.floor(made / 3);
      const rendering = made > finished ? 1 : 0;
      p.shapes.forEach((shape, n) => {
        const key = `${index}-${n + 1}`;
        const base = { key, avatarId: row.avatarId, shape, size: SIZE[shape], dropReason: null, publishedAt: null } as const;
        if (n < finished) videos.push({ ...base, durationMs: DURATION_MS[shape], bytes: BYTES[shape], track: MOCK_LAUNCH_TRACK, state: "done", videoId: `video-mock-${number}-${key}` });
        else if (n < finished + rendering) videos.push({ ...base, durationMs: DURATION_MS[shape], bytes: null, track: MOCK_LAUNCH_TRACK, state: "rendering", videoId: `video-mock-${number}-${key}` });
      });
      const generating = row.toGenerate > 0;
      const sceneSetId = generating ? `set-mock-${number}-${index + 1}` : null;
      const review = generating && draft.sceneReview;
      const awaiting = review && firstToReview;
      if (awaiting) firstToReview = false;
      const phase: LaunchAvatarView["phase"] = !generating ? "montage" : awaiting ? "awaiting-review" : review ? "planned" : "drawing";
      const drawn = phase === "drawing" ? Math.floor(row.toGenerate / 2) : 0;
      return {
        avatarId: row.avatarId,
        phase,
        waiting: null,
        skipped: null,
        photos: { done: drawn, total: row.toGenerate },
        montage: { done: finished + rendering, total: made },
        videos: { done: finished, total: made },
        sceneSetId,
        setRevision: sceneSetId === null ? null : 1,
        scenes: sceneSetId === null ? null : row.toGenerate,
        scenesWithoutText: sceneSetId === null ? null : 0,
        continuePhotos: sceneSetId === null ? null : row.toGenerate,
        slice: phase === "drawing" ? { index: 1, total: Math.max(1, Math.ceil(row.toGenerate / LAUNCH_SLICE_MAX_PHOTOS)) } : null,
        dropped: null,
        waitingMusic: 0,
        undrawnScenes: phase === "drawing" ? row.toGenerate - drawn : 0,
        resumableSlots: phase === "drawing" ? row.toGenerate - drawn : 0,
        drawAllocationMicros: generating ? row.toGenerate * this.#world.unit().photoWorstMicros : null,
      };
    });

    const log: LogLine[] = [{ at: createdAt, kind: "start", acceptedMicros }];
    for (const a of avatars) {
      if (a.sceneSetId !== null && a.scenes !== null) log.push({ at: this.#world.nowIso(), kind: "scenes-ready", avatarId: a.avatarId, scenes: a.scenes, withoutText: 0 });
    }
    for (const v of videos) {
      if (v.state === "done" && v.durationMs !== null && v.bytes !== null && shapeSizeFits(v.shape, v.size)) {
        log.push({ at: this.#world.nowIso(), kind: "video-done", avatarId: v.avatarId, key: v.key, shape: v.shape, size: v.size, durationMs: v.durationMs, bytes: v.bytes });
      }
    }
    return {
      launchId,
      createdAt,
      endedAt: null,
      status: "running",
      paused: null,
      draft,
      acceptedMicros,
      plannedWorstMicros: preview.estimate.worstMicros,
      plannedExpectedMicros: preview.estimate.expectedMicros,
      plan: { videos: preview.totals.videos, photos: preview.totals.photosNeeded, fromLibrary: preview.totals.fromLibrary, toGenerate: preview.totals.toGenerate },
      // A fifth of the expected cost is spent, and the requests in flight (two per drawing avatar) are open reserves inside it.
      spentMicros: Math.min(preview.estimate.worstMicros, Math.max(Math.round(preview.estimate.expectedMicros / 5), avatars.filter((a) => a.phase === "drawing").length * 2 * this.#world.unit().attemptWorstMicros)),
      activeMs: 60_000,
      avatars,
      videos,
      log,
      paidHold: null,
      freeHold: null,
      reviewWritesMicros: 0,
      run: null,
    };
  }
}

/** What a refused admission blocks «Продолжить» as. */
function blockedByOf(error: EngineError): ResumeBlockedBy {
  if (error.code === "RECONCILE_REQUIRED") return "reconcile-required";
  if (error.code === "SETTLE_ABOVE_WORST" || error.code === "LEDGER_WRITE_FAILED") return "halt";
  return "ledger";
}

/** The blocker a refused paid gate stands for in the preview. */
function gateBlocker(error: EngineError): LaunchBlockerCode {
  if (error.code === "RECONCILE_REQUIRED") return "reconcile-required";
  if (error.code === "SETTLE_ABOVE_WORST" || error.code === "LEDGER_WRITE_FAILED") return "halt";
  if (error.code === "LEDGER_CORRUPT" || error.code === "LEDGER_UNREADABLE") return "ledger";
  return "no-key";
}
