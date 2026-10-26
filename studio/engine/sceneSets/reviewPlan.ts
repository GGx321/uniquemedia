import { ideaNamesMirror, isCustomCategory, MAX_SCENES_PER_SET, type CategoryRef, type CategorySnapshot, type SceneWriteTarget } from "../../shared/engine";
import { EngineFailure } from "../engineFailure";
import { snapshotOf, type StoredCategory } from "../library/categories";
import { MAX_REVIEW_WRITES, type StoredSceneSet } from "../library/sceneSets";
import type { LedgerView } from "../runs/journal";
import type { PlanSlot, Pool } from "../scenes";
import { poolOfSlot } from "../scenes/poolAt";
import { poolOf } from "../scenes/poolGen";
import { drawOwnScenes, redrawSlot } from "../scenes/redraw";
import { templateSentence } from "../../shared/scenes/template";
import { seedOfSet } from "./compose";
import { beginIdea, beginRewrite, resumeReviewWrite } from "./reviewMutations";
import { sceneRefusal } from "./refusal";
import type { WriterMode } from "../money/estimate";
import { modelScenesOf, writeModeOf } from "./reviewWriteJob";
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
  /** 5a.2 (S5.6c2): how many of the write's scenes the model must write; the code template writes the rest at $0, so 0 prices the write at nothing. */
  modelScenes: number;
  /** 5a.4 (S5.BA5, r2.1 L3): the mode the write's job asks it in (`writeModeOf`, off the very record the write would leave), so the price is the reserve's. */
  mode: WriterMode;
  /** The set with this write recorded (or resumed under `jobId`): applied under the set's lock. */
  begin: (current: StoredSceneSet, jobId: string) => StoredSceneSet;
}

function targetsOf(set: StoredSceneSet, sceneIds: readonly number[]): StoredSceneSet["scenes"] {
  return sceneIds.map((sceneId) => {
    const scene = set.scenes.find((s) => s.sceneId === sceneId);
    if (scene === undefined) throw sceneRefusal(`the set has no scene ${sceneId}`, "scene-missing", sceneId);
    if (scene.removed) throw sceneRefusal(`scene ${sceneId} is removed; restore it before writing it again`, "target-removed", sceneId);
    return scene;
  });
}

/**
 * 5a.2 (m1): a rewrite WITHOUT a redraw of built-in planned scenes the code template writes is a redraw: the scene is drawn anew and the template writes it, at
 * $0, so the owner gets a new scene, not the same place in new words. A scene of a custom category keeps the plain rewrite (the template re-words it
 * at $0 on the write's own key), because a redraw needs the category's pool and a deleted category would refuse it.
 */
function redrawsOf(set: StoredSceneSet, target: Extract<ReviewTarget, { kind: "rewrite" }>): boolean {
  if (target.redraw) return true;
  const scenes = targetsOf(set, target.sceneIds);
  return scenes.every((scene) => scene.origin === "planned" && !isCustomCategory(scene.slot.category) && templateSentence(scene.slot, { key: `${set.sceneSetId}:${scene.sceneId}:probe` }) !== null);
}

/** A write as the planners below decide it, before its model scenes are counted from the record it would leave (`planReviewWrite`). */
type PlannedWrite = Omit<ReviewPlan, "modelScenes" | "mode">;

function planRewrite(set: StoredSceneSet, target: Extract<ReviewTarget, { kind: "rewrite" }>, pools: PoolsOf, impliedNudity: boolean): PlannedWrite {
  const scenes = targetsOf(set, target.sceneIds);
  const planned = scenes.flatMap((s) => (s.origin === "planned" ? [s] : []));
  if (planned.length !== 0 && planned.length !== scenes.length) throw sceneRefusal("a rewrite covers planned scenes or own scenes, not both: they are written from different prompts", "mixed-kinds");
  const k = set.writes + 1;
  const draws: PlanSlot[] = [];
  const snapshots: CategorySnapshot[] = [];
  const redraw = redrawsOf(set, target);
  if (redraw) {
    if (planned.length !== scenes.length) throw sceneRefusal("only a planned scene has a place to redraw; an own scene is written again from its idea", "own-redraw");
    const avoid = {
      locations: new Set(set.scenes.flatMap((s) => (s.origin === "planned" && !s.removed ? [s.slot.location] : []))),
      outfits: new Set(set.scenes.flatMap((s) => (s.origin === "planned" && !s.removed ? [s.slot.outfit] : []))),
    };
    for (const scene of planned) {
      const { pool, worldPool } = pools.of(scene.slot);
      const drawn = redrawSlot({ seed: seedOfSet(set.sceneSetId), k, slot: scene.slot, pool, avoid, impliedNudity, worldPool });
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
    begin: (current, jobId) => beginRewrite(current, { jobId, sceneIds: target.sceneIds, redraw, slots: draws, snapshots }),
  };
}

function planIdea(set: StoredSceneSet, target: Extract<ReviewTarget, { kind: "idea" }>, ledger: LedgerView | null): PlannedWrite {
  const reserved = reservedIdeaScenes(set, ledger);
  if (set.scenes.length + reserved + target.count > MAX_SCENES_PER_SET) {
    throw sceneRefusal(
      `a set holds at most ${MAX_SCENES_PER_SET} scenes: this one has ${set.scenes.length}${reserved > 0 ? ` and an interrupted idea write holds room for ${reserved} more` : ""}`,
      "idea-room",
    );
  }
  const k = set.writes + 1;
  const first = nextSceneId(set);
  const drawn = drawOwnScenes({ seed: seedOfSet(set.sceneSetId), k, count: target.count, shot: target.shot });
  const scenes = drawn.map((d, i) => ({ sceneId: first + i, shot: d.shot, pose: d.pose }));
  return {
    kind: "idea",
    k,
    count: target.count,
    attemptsLeft: 2,
    begin: (current, jobId) => beginIdea(current, { jobId, idea: target.idea, count: target.count, shot: target.shot, scenes, mirrorAllowed: target.shot === null && ideaNamesMirror(target.idea) }),
  };
}

function planResume(set: StoredSceneSet, target: Extract<ReviewTarget, { kind: "resume" }>, ledger: LedgerView | null): PlannedWrite {
  const record = reviewWritesOf(set).find((r) => r.k === target.write && !r.closed);
  if (record === undefined) throw sceneRefusal(`scene set ${set.sceneSetId} has no unresolved write ${target.write}`, "no-open-write");
  const { attemptsLeft } = reviewWriteState(record, ledger);
  if (attemptsLeft === 0) throw sceneRefusal(`write ${target.write} has no attempt left: dismiss it, or write the scenes again`, "no-attempts-left");
  if (record.kind === "rewrite") {
    // A scene the owner removed since the write was interrupted is not written (nor paid for): the write goes on with the scenes still in the set.
    const dropped = new Set(record.sceneIds.filter((id) => set.scenes.find((s) => s.sceneId === id)?.removed === true));
    const active = record.sceneIds.filter((id) => !dropped.has(id));
    if (active.length === 0) throw sceneRefusal(`every scene of write ${target.write} is removed: dismiss it, or restore a scene`, "target-removed");
    targetsOf(set, active);
    return { kind: "rewrite", k: record.k, count: active.length, sceneIds: active, attemptsLeft, begin: (current, jobId) => resumeReviewWrite(current, record.k, jobId, dropped) };
  }
  return { kind: "idea", k: record.k, count: record.count, attemptsLeft, begin: (current, jobId) => resumeReviewWrite(current, record.k, jobId) };
}

/**
 * The pool a redraw draws from and the snapshot it refreshes. 5a.4 (S5.BA3, §5.1.2): the pool is the slot's own by its marker (`poolOfSlot`): a routed scene of the five its companion, a routed
 * custom scene the shared «Смелая» pool of its branch (with the category as the library holds it now as the `worldPool` its world is redrawn from), anything stored before 5a.4 the pool it was drawn in.
 */
interface PoolsOf {
  of: (slot: PlanSlot) => { pool: Pool; worldPool?: Pool };
  snapshotOf: (category: PlanSlot["category"]) => CategorySnapshot | null;
}

/**
 * Plans a review write from the set, or refuses it free: VALIDATION for a scene the set lacks or has removed, mixed kinds, an own scene redrawn, no room for
 * the scenes, no such unresolved write or none of its attempts left; NOT_FOUND for a redraw of a scene whose custom category was deleted.
 */
export async function planReviewWrite(input: ReviewPlanInput): Promise<ReviewPlan> {
  const planned = await planWrite(input);
  // 5a.2 (S5.6c2): the model scenes are counted off the very record the write would leave, with the job's own `askedOf` and `local`, so the price and the
  // job agree on which scenes the template writes. (`begin` is pure: it returns the set with the write recorded; nothing is stored here.)
  const after = planned.begin(input.set, "estimate");
  const recorded = reviewWritesOf(after).find((r) => r.k === planned.k);
  return { ...planned, modelScenes: recorded === undefined ? planned.count : modelScenesOf(after, recorded), mode: recorded === undefined ? "ordinary" : writeModeOf(after, recorded) };
}

interface ReviewPlanInput {
  set: StoredSceneSet;
  target: ReviewTarget;
  ledger: LedgerView | null;
  /** The stored custom categories the refs name; throws NOT_FOUND for one the library lacks. */
  customCategories: (refs: readonly CategoryRef[]) => Promise<StoredCategory[]>;
  /** 5a.4 (S5.BA3, I5.74): whether the set's avatar was created in Studio. Default false (fail-closed): an imported avatar's redraw holds no implied cover. */
  impliedNudity?: boolean | undefined;
}

async function planWrite(input: ReviewPlanInput): Promise<PlannedWrite> {
  const { set, target } = input;
  if (target.kind === "resume") return planResume(set, target, input.ledger);
  if (reviewWritesOf(set).length >= MAX_REVIEW_WRITES) throw sceneRefusal(`a set records at most ${MAX_REVIEW_WRITES} writes of this kind`, "write-record-cap");
  if (target.kind === "idea") return planIdea(set, target, input.ledger);
  // The custom categories a redraw draws from are read once, now: a deleted one refuses the redraw before anything is priced.
  const stored = new Map<string, StoredCategory>();
  if (target.redraw) {
    const refs = new Set(
      targetsOf(set, target.sceneIds).flatMap((s) => (s.origin === "planned" && isCustomCategory(s.slot.category) ? [s.slot.category] : [])),
    );
    for (const category of await input.customCategories([...refs])) stored.set(category.categoryId, category);
  }
  const impliedNudity = input.impliedNudity === true;
  return planRewrite(set, target, {
    of: (slot) => {
      const routed = poolOfSlot(slot, impliedNudity);
      // A built-in slot always has a pool (`poolOfSlot` answers for every built-in category).
      if (!isCustomCategory(slot.category)) {
        if (routed === undefined) throw new RangeError(`no pool for category ${slot.category}`);
        return { pool: routed };
      }
      const found = stored.get(slot.category);
      if (found === undefined) throw new EngineFailure({ code: "NOT_FOUND", detail: `no custom category ${slot.category}` });
      return routed === undefined ? { pool: poolOf(found.pool) } : { pool: routed, worldPool: poolOf(found.pool) };
    },
    snapshotOf: (category) => {
      const found = isCustomCategory(category) ? stored.get(category) : undefined;
      return found === undefined ? null : snapshotOf(found);
    },
  }, impliedNudity);
}
