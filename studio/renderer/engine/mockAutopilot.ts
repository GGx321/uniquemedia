import { raiseBudgetToMicros } from "../../shared/autopilot/money";
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
  type LaunchAvatarView,
  type LaunchBlockerCode,
  type LaunchDraft,
  type LaunchDraftInput,
  type LaunchStatus,
  type LaunchSummary,
  type LaunchVideo,
  type LogLine,
  type MonthFit,
  type ResumeBlockedBy,
  type UnreadableLaunch,
  type UnsequencedEvent,
  type VideoShape,
} from "../../shared/engine";

// The mock's autopilot (Stage 4, S4.1): the stubs the screens are built on until the engine's orchestrator lands (S4.6) and the mock runs a launch on timers (S4.8).
//
//  - The PLAN and the PRICE follow the plan's rules with the mock's fixed unit prices: shapes by largest remainder, library photos first (slides, then collages, then
//    singles), the rest generated at fixed sizes (a collage of 3, slides of 5), an avatar blocked for an open scene set, over 100 new photos or an unreadable usage, and the
//    month's room against the expected and the worst case. S4.2's `launchEstimate` and S4.3's planner replace the arithmetic; the answers' shape does not change.
//  - A launch it starts is held in a CANNED, consistent mid-run state (some videos done, one rendering, spent a fifth of the expected cost) and moves only by the owner's
//    clicks: pause, resume, stop and the review hand-off. Nothing advances by itself.
//  - It validates and refuses as the engine will, in the order the contract lists; the gates that belong to the mock engine (the library, the key and the ledger, the export
//    folder) arrive through `MockAutopilotWorld`.

/** What the mock engine lets the autopilot see of its world, and the clock and the announcements. */
export interface MockAutopilotWorld {
  nowIso(): string;
  nextEventId(): string;
  emit(event: UnsequencedEvent): void;
  usage(avatarId: string): AvatarUsage;
  /** Free scene photos of the avatar in these categories: eligible, in no video, held by no render, not rejected. */
  freePhotos(avatarId: string, categories: readonly CategoryRef[]): number;
  /** Another job of the avatar's own holds it now. */
  busy(avatarId: string): boolean;
  hasOpenSet(avatarId: string): boolean;
  unit(): MockAutopilotUnit;
  prices(): { prices: Estimate["prices"]; pricesAsOf: string };
  /** The month's budget, and what is spent and reserved in it. */
  month(): { budgetMicros: number; spentAndOpenMicros: number };
  /** The key and the ledger: the engine's first checks before any paid call. */
  paidGate(): EngineError | null;
  exportReason(): ExportUnavailableReason | null;
  exportFreeBytes(): number | null;
  music(): { candidates: number; ownFlagged: number; explicitSkipped: number; autoRefresh: AutoRefresh; quotaRemaining: number | null };
  balance(): { micros: number; asOf: string } | null;
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
/** The photos a generated video has, and the library's stand-in for the sizes it draws by seed. */
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

interface MockLaunch {
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
  readonly spentMicros: number;
  readonly activeMs: number;
  avatars: LaunchAvatarView[];
  videos: LaunchVideo[];
  log: LogLine[];
}

type Outcome<T> = { readonly ok: true; readonly result: T } | { readonly ok: false; readonly error: EngineError };
const done = <T>(result: T): Outcome<T> => ({ ok: true, result });
const refuse = (error: EngineError): Outcome<never> => ({ ok: false, error });

const isUnfinished = (status: LaunchStatus): boolean => status !== "done" && status !== "stopped";

export class MockAutopilot {
  readonly #world: MockAutopilotWorld;
  #unreadable: UnreadableLaunch[];
  /** Oldest first. */
  #launches: MockLaunch[] = [];
  #launchCount = 0;
  #seedCount = 0;

  constructor(world: MockAutopilotWorld, unreadable: readonly UnreadableLaunch[]) {
    this.#world = world;
    this.#unreadable = [...unreadable];
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
    const committedMicros = month.spentAndOpenMicros + (live === undefined ? 0 : this.#remaining(live));
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

    const launch = this.#build(draft, acceptedWorstMicros, preview, planned);
    this.#launches.push(launch);
    return done({ launch: this.#announce(launch) });
  }

  pause(launchId: string): Outcome<{ launch: LaunchView }> {
    const found = this.#find(launchId);
    if (!found.ok) return found;
    const launch = found.result;
    if (launch.status !== "running") return refuse({ code: "VALIDATION", detail: `launch ${launchId} is ${launch.status}, not running` });
    launch.status = "paused";
    launch.paused = { cause: "owner", at: this.#world.nowIso() };
    launch.log.push({ at: this.#world.nowIso(), kind: "pausing", requests: this.#inFlight(launch).requests, renders: 0 }, { at: this.#world.nowIso(), kind: "paused" });
    return done({ launch: this.#announce(launch) });
  }

  resume(launchId: string, acceptedRemainingMicros: number): Outcome<{ launch: LaunchView }> {
    const found = this.#find(launchId);
    if (!found.ok) return found;
    const launch = found.result;
    if (launch.status !== "paused") return refuse({ code: "VALIDATION", detail: `launch ${launchId} is ${launch.status}, not paused` });
    const gate = this.#world.paidGate();
    if (gate !== null) return refuse(gate);
    if (acceptedRemainingMicros < this.#remaining(launch)) return refuse({ code: "PRICE_CHANGED", detail: "the launch's remaining worst case is above the accepted one" });
    launch.status = "running";
    launch.paused = null;
    launch.avatars = launch.avatars.map((a): LaunchAvatarView => (a.phase === "approved-waiting" ? { ...a, phase: "drawing", slice: { index: 1, total: Math.max(1, Math.ceil((a.continuePhotos ?? a.photos.total) / LAUNCH_SLICE_MAX_PHOTOS)) } } : a));
    launch.log.push({ at: this.#world.nowIso(), kind: "resumed", acceptedRemainingMicros });
    return done({ launch: this.#announce(launch) });
  }

  stop(launchId: string): Outcome<{ launch: LaunchView }> {
    const found = this.#find(launchId);
    if (!found.ok) return found;
    const launch = found.result;
    if (launch.status !== "running" && launch.status !== "paused") return refuse({ code: "VALIDATION", detail: `launch ${launchId} is ${launch.status}: only a running or paused launch can be stopped` });
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

  continueAfterReview(launchId: string, avatarId: string, sceneSetId: string, revision: number): Outcome<{ launch: LaunchView; draw: "started" | "waits-for-resume" }> {
    const found = this.#find(launchId);
    if (!found.ok) return found;
    const launch = found.result;
    const notAwaiting = refuse({ code: "VALIDATION", sceneReason: "not-awaiting", detail: `avatar ${avatarId} is not waiting for the review of set ${sceneSetId}` });
    const row = launch.avatars.find((a) => a.avatarId === avatarId);
    if (row === undefined || row.sceneSetId !== sceneSetId || row.phase !== "awaiting-review" || !isUnfinished(launch.status) || launch.status === "stopping") return notAwaiting;
    if (row.setRevision !== revision) return refuse({ code: "SCENES_CHANGED", detail: `scene set ${sceneSetId} moved since revision ${revision}` });
    const photos = row.continuePhotos ?? 0;
    const paused = launch.status === "paused";
    launch.avatars = launch.avatars.map((a): LaunchAvatarView =>
      a.avatarId !== avatarId ? a : { ...a, phase: paused ? "approved-waiting" : "drawing", slice: paused ? null : { index: 1, total: Math.max(1, Math.ceil(photos / LAUNCH_SLICE_MAX_PHOTOS)) } },
    );
    launch.log.push(
      paused ? { at: this.#world.nowIso(), kind: "review-approved-paused", avatarId, photos } : { at: this.#world.nowIso(), kind: "review-continued", avatarId, photos, writtenByOwner: 0 },
    );
    return done({ launch: this.#announce(launch), draw: paused ? "waits-for-resume" : "started" });
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
        videosDone: l.videos.filter((v) => v.state === "done").length,
        videosPlanned: l.plan.videos,
        spentMicros: l.spentMicros,
        acceptedMicros: l.acceptedMicros,
        plannedWorstMicros: l.plannedWorstMicros,
      }),
    );
    return { launches, unreadable: [...this.#unreadable] };
  }

  get(launchId: string): Outcome<{ launch: LaunchView; log: LogLine[]; videos: LaunchVideo[] }> {
    const found = this.#find(launchId);
    if (!found.ok) return found;
    const launch = found.result;
    return done({ launch: this.#view(launch), log: launch.log.slice(-500), videos: [...launch.videos] });
  }

  removeUnreadable(entryId: string): Outcome<Record<string, never>> {
    const at = this.#unreadable.findIndex((u) => u.entryId === entryId);
    if (at < 0) return refuse({ code: "NOT_FOUND", detail: "no unreadable launch entry matches" });
    this.#unreadable.splice(at, 1);
    return done({});
  }

  /** The unfinished launch as `Snapshot.autopilot` shows it, or null. */
  active(): LaunchView | null {
    const live = this.#unfinished();
    return live === undefined ? null : this.#view(live);
  }

  // ---------- the launch ----------

  #find(launchId: string): Outcome<MockLaunch> {
    const launch = this.#launches.find((l) => l.launchId === launchId);
    return launch === undefined ? refuse({ code: "NOT_FOUND", detail: `no launch ${launchId} in the open library` }) : done(launch);
  }

  /** What the launch can still spend: its planned worst case less what it spent. */
  #remaining(launch: MockLaunch): number {
    return isUnfinished(launch.status) ? Math.max(0, launch.plannedWorstMicros - launch.spentMicros) : 0;
  }

  #inFlight(launch: MockLaunch): { requests: number; openMicros: number } {
    if (launch.status !== "running") return { requests: 0, openMicros: 0 };
    const requests = launch.avatars.filter((a) => a.phase === "drawing").length * 2;
    return { requests, openMicros: requests * this.#world.unit().attemptWorstMicros };
  }

  /** What stops «Продолжить · до $R» now, from the key and the ledger as they stand. */
  #resumeBlockedBy(launch: MockLaunch): ResumeBlockedBy | null {
    if (!isUnfinished(launch.status)) return null;
    const gate = this.#world.paidGate();
    if (gate === null) return null;
    if (gate.code === "RECONCILE_REQUIRED") return "reconcile-required";
    if (gate.code === "SETTLE_ABOVE_WORST" || gate.code === "LEDGER_WRITE_FAILED") return "halt";
    if (gate.code === "LEDGER_CORRUPT" || gate.code === "LEDGER_UNREADABLE") return "ledger";
    return gate.code === "AUTH_INVALID" ? "key" : null;
  }

  #view(launch: MockLaunch): LaunchView {
    return LaunchView.parse({
      launchId: launch.launchId,
      createdAt: launch.createdAt,
      endedAt: launch.endedAt,
      activeMs: launch.activeMs,
      status: launch.status,
      paused: launch.paused,
      paidHold: null,
      freeHold: null,
      draft: launch.draft,
      acceptedMicros: launch.acceptedMicros,
      plannedWorstMicros: launch.plannedWorstMicros,
      plannedExpectedMicros: launch.plannedExpectedMicros,
      plan: launch.plan,
      spentMicros: launch.spentMicros,
      remainingMicros: Math.max(0, launch.plannedWorstMicros - launch.spentMicros),
      reviewWritesMicros: 0,
      inFlight: this.#inFlight(launch),
      waitingMusic: 0,
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

  /** A launch in a canned mid-run state, consistent in itself: its videos, rows, log and spend agree. */
  #build(draft: LaunchDraft, acceptedMicros: number, preview: LaunchPreview, planned: readonly PlannedAvatar[]): MockLaunch {
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
      spentMicros: Math.min(preview.estimate.worstMicros, Math.round(preview.estimate.expectedMicros / 5)),
      activeMs: 60_000,
      avatars,
      videos,
      log,
    };
  }
}

/** The blocker a refused paid gate stands for in the preview. */
function gateBlocker(error: EngineError): LaunchBlockerCode {
  if (error.code === "RECONCILE_REQUIRED") return "reconcile-required";
  if (error.code === "SETTLE_ABOVE_WORST" || error.code === "LEDGER_WRITE_FAILED") return "halt";
  if (error.code === "LEDGER_CORRUPT" || error.code === "LEDGER_UNREADABLE") return "ledger";
  return "no-key";
}
