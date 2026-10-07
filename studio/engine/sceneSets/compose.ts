import { createHash } from "node:crypto";
import type { CategoryRef, CategorySnapshot } from "../../shared/engine";
import type { PlannedNewSceneSet } from "../library/sceneSets";
import { writerAttemptIds } from "../runs/plan";
import { planWithPools, plannerCategoryOf, type Pool } from "../scenes";
import { chunkSlots } from "../scenes/writer";

// CS.4a: a compose plans the set with the planner a run uses, issues the set's run id and every writer chunk's attempt ids, and records the first
// write: the whole of it is the set that is written BEFORE the first call, so a crash after any call finds the ids it must never send again.

export interface ComposeInput {
  sceneSetId: string;
  avatarId: string;
  /** The run id issued now and kept for the set's life: the set is used exactly when `runs/<runId>/` exists. */
  runId: string;
  /** The compose job's id, recorded with the first write. */
  jobId: string;
  count: number;
  categories: readonly CategoryRef[];
  poses: { profile: boolean; back: boolean };
  /** Every pool the categories name, by planner name or custom id. */
  pools: Record<string, Pool>;
  /** A snapshot of every custom category the set uses (none for a built-in-only set). */
  snapshots: readonly CategorySnapshot[];
  /** The avatar's recent (location, outfit) pairs the planner steers away from. */
  recentPairs: readonly { location: string; outfit: string }[];
  textModel: string;
}

/** A set's planner seed: fixed by its id (as a run's is by its own), so the plan is reproducible from the set alone. */
export function seedOfSet(sceneSetId: string): number {
  return Number.parseInt(createHash("sha256").update(sceneSetId).digest("hex").slice(0, 8), 16);
}

/** The set a compose writes before its first call. Count 0 is an empty set: no scene, no chunk, no write, nothing to pay. */
export function planSceneSet(input: ComposeInput): PlannedNewSceneSet {
  const slots =
    input.count === 0
      ? []
      : planWithPools(
          {
            seed: seedOfSet(input.sceneSetId),
            count: input.count,
            categories: input.categories.map(plannerCategoryOf),
            excludePairs: input.recentPairs.map(({ location, outfit }) => ({ location, outfit })),
            poses: input.poses,
          },
          input.pools,
        ).slots;
  return {
    sceneSetId: input.sceneSetId,
    avatarId: input.avatarId,
    runId: input.runId,
    request: { count: input.count, categories: [...input.categories], poses: { ...input.poses } },
    // Omitted, not empty, for a built-in-only set: the same rule as a built-in run's plan.json.
    ...(input.snapshots.length === 0 ? {} : { categories: [...input.snapshots] }),
    models: { text: input.textModel },
    scenes: slots.map((slot) => ({ sceneId: slot.slotIndex, origin: "planned" as const, slot, text: null, edited: false, removed: false })),
    chunks: chunkSlots(slots).map((chunk, i) => ({ chunk: i + 1, sceneIds: chunk.map((slot) => slot.slotIndex), attemptIds: writerAttemptIds(input.sceneSetId, i + 1) })),
    write: slots.length === 0 ? null : { k: 1, kind: "compose", jobId: input.jobId },
    writes: slots.length === 0 ? 0 : 1,
  };
}
