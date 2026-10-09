import type { LaunchEstimate, LaunchUnitPrices } from "../../shared/autopilot/estimate";
import { monthFit, raiseBudgetToMicros } from "../../shared/autopilot/money";
import { LaunchPreview, type LaunchBlocker, type LaunchBlockerCode, type LaunchDraft } from "../../shared/engine/autopilot";
import type { LaunchPlan } from "./planner";

// Stage 4 (plan §4.2, §4.4, §9): the preview `autopilot.estimate` answers, built from a plan and the engine's own figures. Pure: the engine hands it the plan, the estimate, the
// month's room and what it knows of the world, so the same inputs always give the same card.

export interface PreviewInput {
  draft: LaunchDraft;
  plan: LaunchPlan;
  /** Over the avatars that are not blocked. */
  estimate: LaunchEstimate;
  /** The unit prices; null when they could not be read (a plan that generates nothing needs none). */
  unit: LaunchUnitPrices | null;
  month: { budgetMicros: number; committedMicros: number; freeMicros: number };
  /** Avatars another job of its own holds now: information, not a refusal. */
  busy: ReadonlySet<string>;
  /** What blocks the whole launch (the engine decides which apply). */
  launchBlockers: readonly LaunchBlockerCode[];
  music: LaunchPreview["music"];
  balance: LaunchPreview["balance"];
  freeBytes: number | null;
}

/** A video's disk need: twice its size estimate (≈ 4.5 MB per 10 s video, plan §8). */
export const DISK_PER_VIDEO_BYTES = 9_000_000;
/** Provisional until the render spike (SP2) records real figures: seconds a new photo and a video take. */
export const SECONDS_PER_NEW_PHOTO = 6;
export const SECONDS_PER_VIDEO = 12;

/** The preview, checked against the contract: an input that breaks it is the engine's defect and throws. */
export function buildLaunchPreview(input: PreviewInput): LaunchPreview {
  const { plan, estimate, unit, month } = input;
  const photo = unit?.photoExpectedMicros ?? 0;
  const blockers: LaunchBlocker[] = [
    ...plan.avatars.flatMap((a): LaunchBlocker[] => (a.blocked === null ? [] : [{ code: a.blocked, avatarId: a.avatarId }])),
    ...input.launchBlockers.map((code: LaunchBlockerCode): LaunchBlocker => ({ code })),
  ];
  return LaunchPreview.parse({
    planSeed: input.draft.planSeed,
    avatars: plan.avatars.map((a) => ({
      avatarId: a.avatarId,
      videos: a.videos.length,
      shapes: a.shapes,
      free: a.free,
      fromLibrary: a.fromLibrary,
      toGenerate: a.toGenerate,
      busy: input.busy.has(a.avatarId),
      blocked: a.blocked,
      usage: a.usage,
    })),
    totals: plan.totals,
    estimate: { expectedMicros: estimate.expectedMicros, worstMicros: estimate.worstMicros, prices: estimate.prices, pricesAsOf: estimate.pricesAsOf },
    perShapeExpectedMicros: { single: photo, collage: 3 * photo, slides: 5 * photo },
    month: { ...month, fit: monthFit(month.freeMicros, estimate.expectedMicros, estimate.worstMicros), raiseToMicros: raiseBudgetToMicros(month, estimate.worstMicros) },
    balance: input.balance,
    music: input.music,
    disk: { neededBytes: plan.totals.videos * DISK_PER_VIDEO_BYTES, freeBytes: input.freeBytes },
    timeSeconds: plan.totals.toGenerate * SECONDS_PER_NEW_PHOTO + plan.totals.videos * SECONDS_PER_VIDEO,
    blockers,
  });
}
