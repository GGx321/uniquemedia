import { allocateLaunch, launchEstimate, type LaunchUnitPrices } from "../../../shared/autopilot/estimate";
import { A, B } from "../../../shared/engine/autopilot.fixtures";
import type { LaunchDraft } from "../../../shared/engine/autopilot";
import { buildLaunchFile, LAUNCH_FILE_SCHEMA_VERSION, type LaunchFile, type NewLaunchFile } from "../launchFile";
import type { StartInput } from "../orchestrator";
import { planLaunch, type LaunchPlan, type PlanPhoto } from "../planner";
import { avatar, input } from "./planFixtures";

// Fixtures of the orchestrator's tests (S4.6a): one launch file built the way `autopilot.start` builds it, from a plan with no library photos, so every video is generated.
// Not part of the product.

export { A, B };

/** Prices as the plan's worked example has them: a photo's worst case $0.21 (three attempts), its expected cost $0.07, the writer's ceiling $0.0375. */
export const UNIT: LaunchUnitPrices = {
  photoWorstMicros: 210_000,
  photoExpectedMicros: 70_000,
  writerCeilingMicros: 37_500,
  writerChunkSlots: 25,
  writerMaxAttempts: 2,
  writerTypicalMicros: Array.from({ length: 101 }, (_, n) => n * 450),
  prices: "fallback",
  pricesAsOf: "2026-10-09",
};

export const CREATED = "2026-10-09T10:00:00.000Z";

export function settings(extra: Partial<LaunchDraft> = {}): LaunchDraft {
  return {
    avatarIds: [A],
    videosPerAvatar: 4,
    mix: { single: 50, collage: 25, slides: 25 },
    categories: ["home"],
    poses: { profile: false, back: false },
    library: false,
    generate: true,
    sceneReview: false,
    stickers: false,
    planSeed: 77,
    ...extra,
  };
}

/** The library photos each avatar had when the plan was made (S4.6c1): none by default, so every video is generated. */
export type PhotosByAvatar = Readonly<Record<string, readonly PlanPhoto[]>>;

export function planOf(draft: LaunchDraft, photos: PhotosByAvatar = {}): LaunchPlan {
  return planLaunch(input({ draft, avatars: draft.avatarIds.map((avatarId) => avatar(photos[avatarId] ?? [], { avatarId })) }));
}

/** A running launch file for `draft`, ids `set-fixture-<n>` / `run-fixture-<n>` in order. */
export function newLaunchFile(draftExtra: Partial<LaunchDraft> = {}, launchId = "launch-fixture-0001", acceptedMicros = 20_000_000, photos: PhotosByAvatar = {}): NewLaunchFile {
  const draft = settings(draftExtra);
  const plan = planOf(draft, photos);
  const estimate = launchEstimate(
    plan.avatars.filter((a) => a.blocked === null).map((a) => ({ avatarId: a.avatarId, photos: a.toGenerate })),
    UNIT,
  );
  const allocation = allocateLaunch(estimate, acceptedMicros);
  if (!allocation.ok) throw new Error("the fixture's accepted amount is below its plan");
  let n = 0;
  return buildLaunchFile({ launchId, createdAt: CREATED, draft, acceptedMicros, plan, estimate, allocations: allocation.avatars, newId: () => `fixture-${String(++n).padStart(4, "0")}` });
}

/** A launch file as the store would have written it. */
export function stampedFile(draftExtra: Partial<LaunchDraft> = {}, over: Partial<LaunchFile> = {}, photos: PhotosByAvatar = {}): LaunchFile {
  const file = newLaunchFile(draftExtra, "launch-fixture-0001", 20_000_000, photos);
  return { ...file, schemaVersion: LAUNCH_FILE_SCHEMA_VERSION, revision: 1, updatedAt: file.createdAt, ...over };
}

/** What `autopilot.start` hands the orchestrator once it has planned, priced and allocated. */
export function startInput(draftExtra: Partial<LaunchDraft> = {}, acceptedMicros = 20_000_000): StartInput {
  const draft = settings(draftExtra);
  const plan = planOf(draft);
  const estimate = launchEstimate(
    plan.avatars.filter((a) => a.blocked === null).map((a) => ({ avatarId: a.avatarId, photos: a.toGenerate })),
    UNIT,
  );
  const allocation = allocateLaunch(estimate, acceptedMicros);
  if (!allocation.ok) throw new Error("the fixture's accepted amount is below its plan");
  return { draft, acceptedMicros, plan, estimate, allocations: allocation.avatars };
}
