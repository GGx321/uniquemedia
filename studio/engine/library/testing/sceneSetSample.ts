import type { CategoryRef } from "../../../shared/engine";
import { writerAttemptIds } from "../../runs/plan";
import { plan, plannerCategoryOf } from "../../scenes";
import { chunkSlots } from "../../scenes/writer";
import type { PlannedNewSceneSet } from "../sceneSets";

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

export function sampleSet(options: SampleSetOptions = {}): PlannedNewSceneSet {
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

// CS.4b: what a review-time write leaves in a set. Hand-built, so a test's oracle never depends on the code that writes them.

/** The four ids of write `k`: the answered attempts plus the spares, `${sceneSetId}:write-${k}#n`. */
export function writeIdsOf(sceneSetId: string, k: number): string[] {
  return Array.from({ length: 4 }, (_, i) => `${sceneSetId}:write-${k}#${i + 1}`);
}

/** An own scene as an accepted idea write adds it. */
export function ownScene(sceneId: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return { sceneId, origin: "own", idea: "кофе на балконе утром", shot: "friend", pose: "front", text: `She sips coffee on a balcony (${sceneId}).`, edited: false, removed: false, ...over };
}

/** An unresolved rewrite of scene `sceneIds` as write `k`, before its call. */
export function rewriteRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  const k = typeof over.k === "number" ? over.k : 2;
  return { kind: "rewrite", k, jobId: "job-aaaa-0002", attemptIds: writeIdsOf("set-aaaa-0001", k), closed: false, sceneIds: [2], redraw: false, slots: [], snapshots: [], ...over };
}

/** An unresolved idea write of two own scenes with the ids it reserved (from `firstId`), as write `k`, before its call. */
export function ideaRecord(over: Record<string, unknown> = {}): Record<string, unknown> {
  const k = typeof over.k === "number" ? over.k : 3;
  const first = typeof over.firstId === "number" ? over.firstId : 5;
  const { firstId: _first, ...rest } = over;
  return {
    kind: "idea",
    k,
    jobId: "job-aaaa-0003",
    attemptIds: writeIdsOf("set-aaaa-0001", k),
    closed: false,
    idea: "кофе на балконе утром",
    count: 2,
    shot: null,
    scenes: [
      { sceneId: first, shot: "friend", pose: "front" },
      { sceneId: first + 1, shot: "selfie", pose: "three-quarter" },
    ],
    ...rest,
  };
}
