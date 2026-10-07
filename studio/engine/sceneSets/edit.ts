import { SCENE_TEXT_MAX, type SceneEditOp, type SceneProblem } from "../../shared/engine";
import type { RewriteWriteRecord, StoredSceneSet } from "../library/sceneSets";
import { sentenceProblems } from "../scenes";
import { withReviewWriteClosed, withoutScenes } from "./reviewMutations";
import { reviewWritesOf } from "./reviewWrites";

// CS.4a: the owner's free edits of a set, as pure changes of its record. Nothing here reads the disk, the ledger or a job: the engine checks that the
// set may be edited at all (no job runs, it is not used, the revision is the one the window shows) and writes the result under the set's lock.

export type EditOutcome =
  /** The set as it should be written (the store stamps the revision). */
  | { kind: "changed"; set: StoredSceneSet }
  | { kind: "unchanged" }
  /** The text does not go through: a normal result, nothing changes. */
  | { kind: "problem"; problem: SceneProblem }
  /** The edit names what the set does not have, or what may not be edited: refused, nothing changes. */
  | { kind: "invalid"; detail: string };

const LINE_BREAK = new RegExp(`[\n\r${String.fromCharCode(0x2028)}${String.fromCharCode(0x2029)}]`);
const CONTROL = /\p{Cc}/u;

/**
 * Why a text does not go through, or null. The assembler's own last gate (`sentenceProblems`: a youth word, a revealing word) shown at once, for
 * free, plus technical bounds: 1..600 chars on one line without control characters. The first rule broken is the one named. Not a new rule, and not
 * a content gate of ours: a text in another script is the owner's call, and the providers apply their own policies.
 */
export function textProblem(text: string): SceneProblem | null {
  const trimmed = text.trim();
  if (trimmed.length === 0) return { reason: "empty", words: [] };
  if (trimmed.length > SCENE_TEXT_MAX) return { reason: "too-long", words: [] };
  if (LINE_BREAK.test(trimmed)) return { reason: "not-one-line", words: [] };
  if (CONTROL.test(trimmed)) return { reason: "control-char", words: [] };
  const [first] = sentenceProblems(trimmed);
  return first === undefined ? null : { reason: first.reason, words: first.words.slice(0, 12).map((word) => word.slice(0, 64)) };
}

function unknownScenes(set: StoredSceneSet, sceneIds: readonly number[]): number[] {
  const known = new Set(set.scenes.map((s) => s.sceneId));
  return sceneIds.filter((id) => !known.has(id));
}

/** Applies one free edit. A text is stored trimmed at its edges and otherwise verbatim; remove and restore take one scene or many, in ONE change. */
export function applyEdit(set: StoredSceneSet, op: SceneEditOp): EditOutcome {
  switch (op.op) {
    case "text": {
      const scene = set.scenes.find((s) => s.sceneId === op.sceneId);
      if (scene === undefined) return { kind: "invalid", detail: `the set has no scene ${op.sceneId}` };
      if (scene.removed) return { kind: "invalid", detail: `scene ${op.sceneId} is removed; restore it before editing its text` };
      const problem = textProblem(op.text);
      if (problem !== null) return { kind: "problem", problem };
      const text = op.text.trim();
      if (scene.text === text && scene.edited) return { kind: "unchanged" };
      return { kind: "changed", set: { ...set, scenes: set.scenes.map((s) => (s.sceneId === op.sceneId ? { ...s, text, edited: true } : s)) } };
    }
    case "remove":
    case "restore": {
      const missing = unknownScenes(set, op.sceneIds);
      if (missing.length > 0) return { kind: "invalid", detail: `the set has no scene ${missing.join(", ")}` };
      const removed = op.op === "remove";
      const targets = new Set(op.sceneIds);
      if (!set.scenes.some((s) => targets.has(s.sceneId) && s.removed !== removed)) return { kind: "unchanged" };
      return { kind: "changed", set: { ...set, scenes: set.scenes.map((s) => (targets.has(s.sceneId) ? { ...s, removed } : s)) } };
    }
    case "dismissInterrupted":
      return dismissInterrupted(set, op);
  }
}

/**
 * «Оставить как есть» / «Не нужно»: an unresolved write is let go. By write: its record is resolved (an idea write adds no scene). By scenes: those scenes
 * leave the unresolved rewrites that named them, and a rewrite left with none is resolved. Free; no scene changes; the ids of the write stay burnt.
 */
function dismissInterrupted(set: StoredSceneSet, op: Extract<SceneEditOp, { op: "dismissInterrupted" }>): EditOutcome {
  const records = reviewWritesOf(set);
  if (op.write !== undefined) {
    const record = records.find((r) => r.k === op.write && !r.closed);
    if (record === undefined) return { kind: "invalid", detail: `scene set ${set.sceneSetId} has no unresolved write ${op.write}` };
    return { kind: "changed", set: withReviewWriteClosed(set, record.k) };
  }
  const sceneIds = op.sceneIds ?? [];
  const missing = unknownScenes(set, sceneIds);
  if (missing.length > 0) return { kind: "invalid", detail: `the set has no scene ${missing.join(", ")}` };
  const open = records.filter((r): r is RewriteWriteRecord => r.kind === "rewrite" && !r.closed);
  const unmarked = sceneIds.filter((id) => !open.some((r) => r.sceneIds.includes(id)));
  if (unmarked.length > 0) return { kind: "invalid", detail: `scene ${unmarked.join(", ")} has no unresolved rewrite to dismiss` };
  const taken = new Set(sceneIds);
  return { kind: "changed", set: { ...set, reviewWrites: records.map((r) => (r.kind === "rewrite" && !r.closed ? withoutScenes(r, taken) : r)) } };
}
