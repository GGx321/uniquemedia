import type { CategoryRef } from "../../../shared/engine";
import { writerAttemptIds } from "../../runs/plan";
import { plan, plannerCategoryOf } from "../../scenes";
import { chunkSlots } from "../../scenes/writer";
import type { NewSceneSet } from "../sceneSets";

// A valid scene set for tests, planned by the real planner over built-in categories only (no custom snapshot needed), with every attempt id
// issued the way compose issues them. No test-runner import, like sampleData.ts.

export interface SampleSetOptions {
  sceneSetId?: string;
  avatarId?: string;
  runId?: string;
  count?: number;
  categories?: readonly CategoryRef[];
  seed?: number;
  /** Give the first N scenes a sentence, as a written chunk would. */
  written?: number;
}

export function sampleSet(options: SampleSetOptions = {}): NewSceneSet {
  const sceneSetId = options.sceneSetId ?? "set-aaaa-0001";
  const categories = options.categories ?? ["home"];
  const slots = plan({ seed: options.seed ?? 7, count: options.count ?? 4, categories: categories.map(plannerCategoryOf) }).slots;
  return {
    sceneSetId,
    avatarId: options.avatarId ?? "avatar-aaaa-0001",
    runId: options.runId ?? "run-aaaa-0001",
    request: { count: slots.length, categories: [...categories], poses: { profile: false, back: false } },
    models: { text: "x-ai/grok-4.3" },
    scenes: slots.map((slot, i) => ({
      sceneId: slot.slotIndex,
      origin: "planned" as const,
      slot,
      text: i < (options.written ?? 0) ? `A friend catches her at the ${slot.location} (${slot.slotIndex}).` : null,
      edited: false,
      removed: false,
    })),
    chunks: chunkSlots(slots).map((chunk, i) => ({ chunk: i + 1, sceneIds: chunk.map((s) => s.slotIndex), attemptIds: writerAttemptIds(sceneSetId, i + 1) })),
    write: null,
    writes: 0,
  };
}
