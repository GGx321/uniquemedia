import { z } from "zod";
import type { AvatarAllocation, LaunchEstimate } from "../../shared/autopilot/estimate";
import {
  AvatarPhase,
  DropReason,
  FreeHold,
  LaunchAvatarView,
  LaunchDraft,
  PaidHold,
  PausedCause,
  shapeSizeFits,
  VideoShape,
  type LaunchStatus,
} from "../../shared/engine/autopilot";
import { CategoryRef } from "../../shared/engine/categories";
import { Count, Id, LaunchId, LaunchVideoKey, Micros } from "../../shared/engine/primitives";
import { PriceSource } from "../../shared/engine/state";
import type { LaunchPlan } from "./planner";

// Stage 4 (plan §3.3): the launch file, `<library>/autopilot/<launchId>.json`, written whole (temp, fsync, rename) with a growing `revision`. It is on disk before the first
// paid call: the click, the recomputed figures, each avatar's allocation and the ids of its set and its set's run. The set file stays the source of truth for the approval and
// the slices; this file mirrors them for display and is re-read at open. Strict like every record of the library: a field it does not know is refused, so a newer build's file
// is never half-read and rewritten without what it held.

// The schema is strict: a build refuses a field it does not know, and an older build refuses a newer `schemaVersion` (it would lose the field on its next rewrite).
// So ANY new field of S4.6b / S4.6c (the set's mirrors, a video's result, a music mark...) must bump this version, or an older build would call the file unreadable.
export const LAUNCH_FILE_SCHEMA_VERSION = 1;

const IsoDateTime = z.iso.datetime();

/** The statuses a file holds: `pausing` is a view state and is never written. */
export const LaunchFileStatus = z.enum(["running", "paused", "stopping", "done", "stopped"]);
export type LaunchFileStatus = z.infer<typeof LaunchFileStatus>;

export const isEnded = (status: LaunchStatus): boolean => status === "done" || status === "stopped";

const Allocation = z.strictObject({ composeMicros: Micros, drawMicros: Micros });

/** What an avatar's paid path needs, issued BEFORE its first call (A4): the set and the set's run, the exact per-category split of the compose, the review switch. */
const Generation = z.strictObject({
  sceneSetId: Id,
  setRunId: Id,
  split: z.array(z.strictObject({ ref: CategoryRef, count: z.number().int().min(1) })).min(1),
  review: z.boolean(),
});
export type Generation = z.infer<typeof Generation>;

/** The states a planned video passes through (plan §3.5). Only the planner's (`planned`) and the drop at plan time are written by S4.6a. */
export const FILE_VIDEO_STATES = ["planned", "waiting-photos", "assigned", "rendering", "done", "waiting-music", "dropped"] as const;

const FileVideo = z
  .strictObject({
    key: LaunchVideoKey,
    shape: VideoShape,
    size: z.number().int().min(1).max(7),
    category: CategoryRef,
    source: z.enum(["library", "generated"]),
    photoIds: z.array(Id).max(7),
    state: z.enum(FILE_VIDEO_STATES),
    dropReason: DropReason.nullable(),
    videoId: Id.nullable(),
  })
  .superRefine((v, ctx) => {
    const fail = (path: string, message: string): void => void ctx.addIssue({ code: "custom", path: [path], message });
    if (!shapeSizeFits(v.shape, v.size)) fail("size", "a shape has its own sizes");
    if ((v.state === "dropped") !== (v.dropReason !== null)) fail("dropReason", "a dropped video says why, and only a dropped video does");
  });
export type FileVideo = z.infer<typeof FileVideo>;

const FileAvatar = z
  .strictObject({
    avatarId: Id,
    phase: AvatarPhase,
    waiting: LaunchAvatarView.shape.waiting,
    skipped: LaunchAvatarView.shape.skipped,
    /** The photos of this avatar's draw that arrived. */
    photosDone: Count,
    allocation: Allocation,
    generation: Generation.nullable(),
    videos: z.array(FileVideo).max(50),
  })
  .superRefine((row, ctx) => {
    const fail = (path: string, message: string): void => void ctx.addIssue({ code: "custom", path: [path], message });
    if ((row.phase === "waiting") !== (row.waiting !== null)) fail("waiting", "waiting is present exactly in the waiting phase");
    if ((row.phase === "skipped") !== (row.skipped !== null)) fail("skipped", "skipped is present exactly in the skipped phase");
  });
export type FileAvatar = z.infer<typeof FileAvatar>;

export const LaunchFile = z
  .strictObject({
    schemaVersion: z.literal(LAUNCH_FILE_SCHEMA_VERSION),
    launchId: LaunchId,
    /** Grows by one on every rewrite. */
    revision: z.number().int().min(1),
    createdAt: IsoDateTime,
    updatedAt: IsoDateTime,
    /** When the launch ended; null while it is not done or stopped. */
    endedAt: IsoDateTime.nullable(),
    draft: LaunchDraft,
    /** The click's amount, and the figures the start recomputed (W′ never above the click). */
    acceptedMicros: Micros,
    plannedWorstMicros: Micros,
    plannedExpectedMicros: Micros,
    priceSource: PriceSource,
    pricesAsOf: z.iso.date(),
    plan: z.strictObject({ videos: Count, photos: Count, fromLibrary: Count, toGenerate: Count }),
    status: LaunchFileStatus,
    /** The worked time before `activeSince` (paused and stopped time excluded); `activeSince` is set exactly while the launch runs. */
    activeMs: Count,
    activeSince: IsoDateTime.nullable(),
    paused: z.strictObject({ cause: PausedCause, at: IsoDateTime }).nullable(),
    paidHold: PaidHold.nullable(),
    freeHold: FreeHold.nullable(),
    /** The ledger's sum over the launch's group when the file was last written; the live figure is the ledger's, this is read when the ledger cannot be, and after the end. */
    spentMicros: Micros,
    avatars: z.array(FileAvatar).min(1),
  })
  .superRefine((f, ctx) => {
    const fail = (path: string, message: string): void => void ctx.addIssue({ code: "custom", path: [path], message });
    if ((f.status === "paused") !== (f.paused !== null)) fail("paused", "a pause is present exactly while the launch is paused");
    if (isEnded(f.status) !== (f.endedAt !== null)) fail("endedAt", "a launch has ended exactly when it is done or stopped");
    if ((f.status === "running") !== (f.activeSince !== null)) fail("activeSince", "the active clock runs exactly while the launch runs");
    if (f.plannedWorstMicros > f.acceptedMicros) fail("plannedWorstMicros", "the planned worst case never exceeds what the click accepted");
    if (f.plannedExpectedMicros > f.plannedWorstMicros) fail("plannedExpectedMicros", "the expected cost never exceeds the worst case");
    // A2: what the avatars may spend is exactly what the launch may (Σ allocations = W′), so the group's cap and the allocations cannot drift apart.
    if (f.avatars.reduce((sum, a) => sum + a.allocation.composeMicros + a.allocation.drawMicros, 0) !== f.plannedWorstMicros) fail("avatars", "the avatars' allocations add up to the planned worst case");
    const rows = f.avatars.map((a) => a.avatarId);
    if (rows.length !== f.draft.avatarIds.length || rows.some((id, i) => id !== f.draft.avatarIds[i])) fail("avatars", "the rows are the draft's avatars, in its order");
  });
export type LaunchFile = z.infer<typeof LaunchFile>;

/** A file before the store stamps it: no schema version, revision or write time. */
export type NewLaunchFile = Omit<LaunchFile, "schemaVersion" | "revision" | "updatedAt">;

export interface BuildLaunchFileInput {
  launchId: string;
  createdAt: string;
  draft: LaunchDraft;
  acceptedMicros: number;
  plan: LaunchPlan;
  estimate: LaunchEstimate;
  /** Per avatar that is not blocked, from `allocateLaunch`. */
  allocations: readonly AvatarAllocation[];
  /** Issues the set's and the run's id; called in the avatars' order, set first. */
  newId: () => string;
}

/** The smallest size of a shape: what a video dropped at plan time is listed with (it has no photos to count). */
const MIN_SIZE: Record<VideoShape, number> = { single: 1, collage: 2, slides: 5 };

/**
 * The file `autopilot.start` writes before any paid call (plan §3.3, §4.3): the plan's videos, each avatar's allocation, and, for an avatar that generates, the ids of its
 * set and the set's run, so a compose made again after a crash meets the same ones. Library photos are not recorded here: they are assigned later, from fresh snapshots.
 */
export function buildLaunchFile(input: BuildLaunchFileInput): NewLaunchFile {
  const { draft, plan, estimate } = input;
  const allocationOf = new Map(input.allocations.map((a) => [a.avatarId, a]));
  const avatars: FileAvatar[] = plan.avatars.map((avatarPlan) => {
    const allocation = allocationOf.get(avatarPlan.avatarId);
    const generates = avatarPlan.toGenerate > 0;
    const videos: FileVideo[] = [
      ...avatarPlan.videos.map(
        (v): FileVideo => ({ key: v.key, shape: v.shape, size: v.size, category: v.category, source: v.source, photoIds: [], state: "planned", dropReason: null, videoId: null }),
      ),
      ...avatarPlan.dropped.map(
        (v): FileVideo => ({
          key: v.key,
          shape: v.shape,
          size: MIN_SIZE[v.shape],
          category: draft.categories[0] ?? "home",
          source: "generated",
          photoIds: [],
          state: "dropped",
          dropReason: v.reason,
          videoId: null,
        }),
      ),
    ].sort((a, b) => keyOrder(a.key) - keyOrder(b.key));
    return {
      avatarId: avatarPlan.avatarId,
      phase: "planned",
      waiting: null,
      skipped: null,
      photosDone: 0,
      allocation: { composeMicros: allocation?.composeMicros ?? 0, drawMicros: allocation?.drawMicros ?? 0 },
      generation: generates
        ? { sceneSetId: input.newId(), setRunId: input.newId(), split: avatarPlan.generate.map((g) => ({ ref: g.category, count: g.count })), review: draft.sceneReview }
        : null,
      videos,
    };
  });
  return {
    launchId: input.launchId,
    createdAt: input.createdAt,
    endedAt: null,
    draft,
    acceptedMicros: input.acceptedMicros,
    plannedWorstMicros: estimate.worstMicros,
    plannedExpectedMicros: estimate.expectedMicros,
    priceSource: estimate.prices,
    pricesAsOf: estimate.pricesAsOf,
    plan: { videos: plan.totals.videos, photos: plan.totals.photosNeeded, fromLibrary: plan.totals.fromLibrary, toGenerate: plan.totals.toGenerate },
    status: "running",
    activeMs: 0,
    activeSince: input.createdAt,
    paused: null,
    paidHold: null,
    freeHold: null,
    spentMicros: 0,
    avatars,
  };
}

function keyOrder(key: string): number {
  const [avatar, video] = key.split("-");
  return Number(avatar) * 100 + Number(video);
}
