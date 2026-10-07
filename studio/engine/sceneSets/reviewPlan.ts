import { isCustomCategory, MAX_SCENES_PER_SET, type CategoryRef, type CategorySnapshot, type SceneWriteTarget } from "../../shared/engine";
import { EngineFailure } from "../engineFailure";
import { snapshotOf, type StoredCategory } from "../library/categories";
import { MAX_REVIEW_WRITES, type StoredSceneSet } from "../library/sceneSets";
import type { LedgerView } from "../runs/journal";
import { POOLS, type PlanSlot, type PlannerCategory, type Pool } from "../scenes";
import { poolOf } from "../scenes/poolGen";
import { drawOwnScenes, redrawSlot } from "../scenes/redraw";
import { seedOfSet } from "./compose";
import { beginIdea, beginRewrite, resumeReviewWrite } from "./reviewMutations";
import { nextSceneId, reservedIdeaScenes, reviewWriteState, reviewWritesOf } from "./reviewWrites";

// CS.4b: what a rewrite, an idea write or the resume of one is, decided from the set as it is NOW and nothing else: every refusal (all free, all before a
// price is asked or a reserve made) and every draw (deterministic per set seed, write number and scene, made once and stored with the write BEFORE its
// call). The service prices the plan, and applies `begin` to the record under the set's lock on the revision the window showed.

type ReviewTarget = Exclude<SceneWriteTarget, { kind: "unwritten" }>;

export interface ReviewPlan {
  kind: "rewrite" | "idea";
  /** The write's number: a new write takes the set's next, a resume keeps its own. */
  k: number;
  /** How many scenes the write covers (1..5). */
  count: number;
  /** The scenes a rewrite names (a live rewrite says them). */
  sceneIds?: number[];
  /** The attempts the write may still use: two for a new write, what the ledger leaves a resumed one. */
  attemptsLeft: number;
  /** The set with this write recorded (or resumed under `jobId`): applied under the set's lock. */
  begin: (current: StoredSceneSet, jobId: string) => StoredSceneSet;
}

const invalid = (detail: string): EngineFailure => new EngineFailure({ code: "VALIDATION", detail });

function targetsOf(set: StoredSceneSet, sceneIds: readonly number[]): StoredSceneSet["scenes"] {
  return sceneIds.map((sceneId) => {
    const scene = set.scenes.find((s) => s.sceneId === sceneId);
    if (scene === undefined) throw invalid(`the set has no scene ${sceneId}`);
    if (scene.removed) throw invalid(`scene ${sceneId} is removed; restore it before writing it again`);
    return scene;
  });
}

function planRewrite(set: StoredSceneSet, target: Extract<ReviewTarget, { kind: "rewrite" }>, pools: PoolsOf): ReviewPlan {
  const scenes = targetsOf(set, target.sceneIds);
  const planned = scenes.flatMap((s) => (s.origin === "planned" ? [s] : []));
  if (planned.length !== 0 && planned.length !== scenes.length) throw invalid("a rewrite covers planned scenes or own scenes, not both: they are written from different prompts");
  const k = set.writes + 1;
  const draws: PlanSlot[] = [];
  const snapshots: CategorySnapshot[] = [];
  if (target.redraw) {
    if (planned.length !== scenes.length) throw invalid("only a planned scene has a place to redraw; an own scene is written again from its idea");
    const avoid = {
      locations: new Set(set.scenes.flatMap((s) => (s.origin === "planned" && !s.removed ? [s.slot.location] : []))),
      outfits: new Set(set.scenes.flatMap((s) => (s.origin === "planned" && !s.removed ? [s.slot.outfit] : []))),
    };
    for (const scene of planned) {
      const pool = pools.of(scene.slot.category);
      const drawn = redrawSlot({ seed: seedOfSet(set.sceneSetId), k, slot: scene.slot, pool, avoid, poses: set.request.poses });
      avoid.locations.add(drawn.location);
      avoid.outfits.add(drawn.outfit);
      draws.push(drawn);
      const fresh = pools.snapshotOf(scene.slot.category);
      if (fresh !== null && !snapshots.some((s) => s.ref === fresh.ref)) snapshots.push(fresh);
    }
  }
  return {
    kind: "rewrite",
    k,
    count: scenes.length,
    sceneIds: [...target.sceneIds],
    attemptsLeft: 2,
    begin: (current, jobId) => beginRewrite(current, { jobId, sceneIds: target.sceneIds, redraw: target.redraw, slots: draws, snapshots }),
  };
}

function planIdea(set: StoredSceneSet, target: Extract<ReviewTarget, { kind: "idea" }>): ReviewPlan {
  if (set.scenes.length + reservedIdeaScenes(set) + target.count > MAX_SCENES_PER_SET) {
    throw invalid(`a set holds at most ${MAX_SCENES_PER_SET} scenes: this one has ${set.scenes.length}${reservedIdeaScenes(set) > 0 ? ` and an interrupted idea write holds room for ${reservedIdeaScenes(set)} more` : ""}`);
  }
  const k = set.writes + 1;
  const first = nextSceneId(set);
  const drawn = drawOwnScenes({ seed: seedOfSet(set.sceneSetId), k, count: target.count, shot: target.shot, poses: set.request.poses });
  const scenes = drawn.map((d, i) => ({ sceneId: first + i, shot: d.shot, pose: d.pose }));
  return {
    kind: "idea",
    k,
    count: target.count,
    attemptsLeft: 2,
    begin: (current, jobId) => beginIdea(current, { jobId, idea: target.idea, count: target.count, shot: target.shot, scenes }),
  };
}

function planResume(set: StoredSceneSet, target: Extract<ReviewTarget, { kind: "resume" }>, ledger: LedgerView | null): ReviewPlan {
  const record = reviewWritesOf(set).find((r) => r.k === target.write && !r.closed);
  if (record === undefined) throw invalid(`scene set ${set.sceneSetId} has no unresolved write ${target.write}`);
  const { attemptsLeft } = reviewWriteState(record, ledger);
  if (attemptsLeft === 0) throw invalid(`write ${target.write} has no attempt left: dismiss it, or write the scenes again`);
  if (record.kind === "rewrite") {
    targetsOf(set, record.sceneIds);
    return { kind: "rewrite", k: record.k, count: record.sceneIds.length, sceneIds: [...record.sceneIds], attemptsLeft, begin: (current, jobId) => resumeReviewWrite(current, record.k, jobId) };
  }
  return { kind: "idea", k: record.k, count: record.count, attemptsLeft, begin: (current, jobId) => resumeReviewWrite(current, record.k, jobId) };
}

/** The pool a redraw draws from and the snapshot it refreshes: a built-in's own, or the custom category as the library holds it now. */
interface PoolsOf {
  of: (category: PlannerCategory) => Pool;
  snapshotOf: (category: PlannerCategory) => CategorySnapshot | null;
}

/**
 * Plans a review write from the set, or refuses it free: VALIDATION for a scene the set lacks or has removed, mixed kinds, an own scene redrawn, no room for
 * the scenes, no such unresolved write or none of its attempts left; NOT_FOUND for a redraw of a scene whose custom category was deleted.
 */
export async function planReviewWrite(input: {
  set: StoredSceneSet;
  target: ReviewTarget;
  ledger: LedgerView | null;
  /** The stored custom categories the refs name; throws NOT_FOUND for one the library lacks. */
  customCategories: (refs: readonly CategoryRef[]) => Promise<StoredCategory[]>;
}): Promise<ReviewPlan> {
  const { set, target } = input;
  if (target.kind === "resume") return planResume(set, target, input.ledger);
  if (reviewWritesOf(set).length >= MAX_REVIEW_WRITES) throw invalid(`a set records at most ${MAX_REVIEW_WRITES} writes of this kind`);
  if (target.kind === "idea") return planIdea(set, target);
  // The custom categories a redraw draws from are read once, now: a deleted one refuses the redraw before anything is priced.
  const stored = new Map<string, StoredCategory>();
  if (target.redraw) {
    const refs = new Set(
      targetsOf(set, target.sceneIds).flatMap((s) => (s.origin === "planned" && isCustomCategory(s.slot.category) ? [s.slot.category] : [])),
    );
    for (const category of await input.customCategories([...refs])) stored.set(category.categoryId, category);
  }
  return planRewrite(set, target, {
    of: (category) => {
      if (!isCustomCategory(category)) return POOLS[category];
      const found = stored.get(category);
      if (found === undefined) throw new EngineFailure({ code: "NOT_FOUND", detail: `no custom category ${category}` });
      return poolOf(found.pool);
    },
    snapshotOf: (category) => {
      const found = isCustomCategory(category) ? stored.get(category) : undefined;
      return found === undefined ? null : snapshotOf(found);
    },
  });
}
