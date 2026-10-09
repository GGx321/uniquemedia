import type { DropReason, LaunchAvatarView, LaunchStatus, LaunchView, LogLine, ResumeBlockedBy } from "../../shared/engine/autopilot";
import type { FileAvatar, LaunchFile } from "./launchFile";

// Stage 4 (plan §9, §19): a launch file as the window sees it. Pure: the orchestrator hands it the ledger's sum, what is in flight and the clock, so the same file and context
// always give the same view. The mirror fields of the paid path (the set, its revision, the scene counts, the slice) are null here until S4.6b1 records them in the file.

export interface ViewContext {
  /** The status as the window reads it: the file's, or `pausing` while the requests in flight finish. */
  status: LaunchStatus;
  nowMs: number;
  /** The ledger's sum over the launch's group (the very sum the Budget enforces), or the file's last one when the ledger cannot be read or the launch is over. */
  spentMicros: number;
  inFlight: { requests: number; openMicros: number };
  resumeBlockedBy: ResumeBlockedBy | null;
  logTail: readonly LogLine[];
}

/** The view, not yet checked: the caller runs `LaunchView.safeParse` on it before it is announced or put in the snapshot. */
export function launchViewOf(file: LaunchFile, ctx: ViewContext): unknown {
  const activeMs = file.activeMs + (file.activeSince === null ? 0 : Math.max(0, ctx.nowMs - Date.parse(file.activeSince)));
  const avatars = file.avatars.map(avatarView);
  const view = {
    launchId: file.launchId,
    createdAt: file.createdAt,
    endedAt: file.endedAt,
    activeMs,
    status: ctx.status,
    paused: file.paused,
    paidHold: file.paidHold,
    freeHold: file.freeHold,
    draft: file.draft,
    acceptedMicros: file.acceptedMicros,
    plannedWorstMicros: file.plannedWorstMicros,
    plannedExpectedMicros: file.plannedExpectedMicros,
    plan: file.plan,
    spentMicros: ctx.spentMicros,
    remainingMicros: Math.max(0, file.plannedWorstMicros - ctx.spentMicros),
    reviewWritesMicros: 0,
    inFlight: ctx.inFlight,
    waitingMusic: avatars.reduce((sum, a) => sum + a.waitingMusic, 0),
    resumeBlockedBy: ctx.resumeBlockedBy,
    avatars,
    logTail: ctx.logTail.slice(-20),
  } satisfies LaunchView;
  return view;
}

function avatarView(row: FileAvatar): LaunchAvatarView {
  const counted = row.videos.filter((v) => v.state !== "dropped");
  const done = counted.filter((v) => v.state === "done").length;
  const rendered = counted.filter((v) => v.state === "done" || v.state === "rendering").length;
  const photoTotal = row.generation === null ? 0 : row.generation.split.reduce((sum, s) => sum + s.count, 0);
  return {
    avatarId: row.avatarId,
    phase: row.phase,
    waiting: row.waiting,
    skipped: row.skipped,
    photos: { done: Math.min(row.photosDone, photoTotal), total: photoTotal },
    montage: { done: rendered, total: counted.length },
    videos: { done, total: counted.length },
    sceneSetId: null,
    setRevision: null,
    scenes: null,
    scenesWithoutText: null,
    continuePhotos: null,
    slice: null,
    dropped: droppedOf(row),
    waitingMusic: counted.filter((v) => v.state === "waiting-music").length,
    undrawnScenes: 0,
    resumableSlots: 0,
    drawAllocationMicros: row.generation === null ? null : row.allocation.drawMicros,
  };
}

/** How many videos were dropped and why: the reason most of them share (the first met on a tie). */
function droppedOf(row: FileAvatar): { count: number; reason: DropReason } | null {
  const reasons = new Map<DropReason, number>();
  for (const video of row.videos) if (video.dropReason !== null) reasons.set(video.dropReason, (reasons.get(video.dropReason) ?? 0) + 1);
  let best: { reason: DropReason; count: number } | null = null;
  for (const [reason, count] of reasons) if (best === null || count > best.count) best = { reason, count };
  const total = [...reasons.values()].reduce((sum, n) => sum + n, 0);
  return best === null ? null : { count: total, reason: best.reason };
}

export type { LaunchView };
