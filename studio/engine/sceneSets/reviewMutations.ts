import type { CategorySnapshot, EngineError, SceneStoppedBy } from "../../shared/engine";
import type { IdeaWriteRecord, ReviewWriteRecord, RewriteWriteRecord, SceneRecord, StoredSceneSet } from "../library/sceneSets";
import type { PlanSlot, Pose, Shot } from "../scenes";
import { reviewWritesOf, writeAttemptIds } from "./reviewWrites";

// CS.4b: the changes a rewrite or an idea write makes to its set's record, as pure functions of the record (the store rewrites the file under the set's lock;
// these say what changes in it). Three rules hold throughout:
//  - a write is RECORDED, with its number, its ids and its draw, before its first call, and nothing else in the set moves with it;
//  - a scene changes only when its sentence is ACCEPTED, and only the scenes the write named;
//  - the record outlives the write (closed): its ids are burnt and its attempts are money spent.

function replaceRecord(set: StoredSceneSet, k: number, change: (record: ReviewWriteRecord) => ReviewWriteRecord): StoredSceneSet {
  if (!reviewWritesOf(set).some((record) => record.k === k)) return set;
  return { ...set, reviewWrites: reviewWritesOf(set).map((record) => (record.k === k ? change(record) : record)) };
}

function recordOf(set: StoredSceneSet, k: number): ReviewWriteRecord {
  const record = reviewWritesOf(set).find((r) => r.k === k);
  if (record === undefined) throw new Error(`scene set ${set.sceneSetId} has no review write ${k}`);
  return record;
}

function openRecordOf(set: StoredSceneSet, k: number): ReviewWriteRecord {
  const record = recordOf(set, k);
  if (record.closed) throw new Error(`review write ${k} of scene set ${set.sceneSetId} is resolved`);
  return record;
}

/** The record without the stop reason a new run of the write makes stale. */
function withoutStop(record: ReviewWriteRecord): ReviewWriteRecord {
  const { stoppedBy: _by, stoppedError: _error, ...rest } = record;
  return rest as ReviewWriteRecord;
}

/**
 * A rewrite of scenes the set already has takes them over from any unresolved rewrite that still named them (the owner pressed ⟳ again: a fresh paid
 * write for that scene). The old record keeps its other scenes, or closes when it has none left; its burnt ids stay.
 */
export function withoutScenes(record: RewriteWriteRecord, taken: ReadonlySet<number>): RewriteWriteRecord {
  const remaining = record.sceneIds.filter((id) => !taken.has(id));
  if (remaining.length === record.sceneIds.length) return record;
  if (remaining.length === 0) return { ...record, closed: true };
  if (!record.redraw) return { ...record, sceneIds: remaining, slots: [] };
  const slots = record.slots.filter((slot) => !taken.has(slot.slotIndex));
  // A snapshot is kept only for a category a remaining scene's new place still uses.
  const used = new Set(slots.map((slot) => slot.category));
  return { ...record, sceneIds: remaining, slots, snapshots: record.snapshots.filter((snapshot) => used.has(snapshot.ref)) };
}

/** Records a rewrite as the next write BEFORE its first call, with the draw of its redraw and the snapshots an accepted redraw will refresh. No scene changes. */
export function beginRewrite(
  set: StoredSceneSet,
  write: { jobId: string; sceneIds: readonly number[]; redraw: boolean; slots: readonly PlanSlot[]; snapshots: readonly CategorySnapshot[] },
): StoredSceneSet {
  const k = set.writes + 1;
  const taken = new Set(write.sceneIds);
  const earlier = reviewWritesOf(set).map((record) => (record.kind === "rewrite" && !record.closed ? withoutScenes(record, taken) : record));
  const record: RewriteWriteRecord = {
    kind: "rewrite",
    k,
    jobId: write.jobId,
    attemptIds: writeAttemptIds(set.sceneSetId, k),
    closed: false,
    sceneIds: [...write.sceneIds],
    redraw: write.redraw,
    slots: [...write.slots],
    snapshots: [...write.snapshots],
  };
  return { ...set, reviewWrites: [...earlier, record], writes: k };
}

/** Records an idea write as the next write BEFORE its first call, with the scene ids it reserves and the shot and pose drawn for each. No scene is added yet. */
export function beginIdea(set: StoredSceneSet, write: { jobId: string; idea: string; count: number; shot: Shot | null; scenes: readonly { sceneId: number; shot: Shot; pose: Pose }[] }): StoredSceneSet {
  const k = set.writes + 1;
  const record: IdeaWriteRecord = {
    kind: "idea",
    k,
    jobId: write.jobId,
    attemptIds: writeAttemptIds(set.sceneSetId, k),
    closed: false,
    idea: write.idea.trim(),
    count: write.count,
    shot: write.shot,
    scenes: write.scenes.map((s) => ({ sceneId: s.sceneId, shot: s.shot, pose: s.pose })),
  };
  return { ...set, reviewWrites: [...reviewWritesOf(set), record], writes: k };
}

/**
 * The carrying on of an unresolved write by a new job: the same number, ids and draw, no stale stop reason. `dropped` are scenes of a rewrite the owner removed
 * meanwhile: the write goes on without them (their draw and snapshot go with them, like a take-over), and keeps its ids.
 */
export function resumeReviewWrite(set: StoredSceneSet, k: number, jobId: string, dropped: ReadonlySet<number> = new Set()): StoredSceneSet {
  openRecordOf(set, k);
  return replaceRecord(set, k, (record) => ({ ...withoutStop(record.kind === "rewrite" ? withoutScenes(record, dropped) : record), jobId }));
}

/**
 * The set's category snapshots with the refreshed ones put in their place (a redraw: the label and the style of the category as it is now), and the write
 * that refreshed each. A snapshot a LATER write already refreshed stays: write `k` took its snapshot before that one was taken, so it is the older view.
 */
function refreshed(set: StoredSceneSet, k: number, snapshots: readonly CategorySnapshot[]): Pick<StoredSceneSet, "categories" | "snapshotWrites"> {
  if (set.categories === undefined || snapshots.length === 0) return { categories: set.categories, snapshotWrites: set.snapshotWrites };
  const fresher = snapshots.filter((fresh) => (set.snapshotWrites?.[fresh.ref] ?? 0) < k);
  const categories = set.categories.map((old) => fresher.find((fresh) => fresh.ref === old.ref) ?? old);
  const refreshedBy = fresher.filter((fresh) => set.categories?.some((old) => old.ref === fresh.ref)).map((fresh) => [fresh.ref, k] as const);
  return { categories, snapshotWrites: refreshedBy.length === 0 ? set.snapshotWrites : { ...set.snapshotWrites, ...Object.fromEntries(refreshedBy) } };
}

function sentenceFor(sentences: ReadonlyMap<number, string>, sceneId: number, k: number): string {
  const sentence = sentences.get(sceneId);
  if (sentence === undefined) throw new Error(`review write ${k}: the accepted answer has no sentence for scene ${sceneId}`);
  return sentence;
}

/** Whether this closed write's scenes already carry exactly these sentences: its answer was accepted before. A record closed by a dismissal does not qualify. */
function isAccepted(set: StoredSceneSet, record: ReviewWriteRecord, sentences: ReadonlyMap<number, string>): boolean {
  if (!record.closed) return false;
  const ids = record.kind === "idea" ? record.scenes.map((s) => s.sceneId) : record.sceneIds;
  return ids.length > 0 && ids.every((id) => sentences.has(id) && set.scenes.find((scene) => scene.sceneId === id)?.text === sentences.get(id));
}

/**
 * The accepted answer of a write goes into the set, all of it or none: a rewrite gives each TARGET scene its sentence (and, with a redraw, its new place; the
 * category's snapshot is refreshed), an idea write adds its scenes under the ids it reserved. A sentence for a scene outside the write is ignored. The
 * record is resolved. Accepting the same answer again changes nothing. Throws when the write is not there, is resolved without this answer, or the answer lacks a sentence the write needs.
 */
export function withReviewWriteAccepted(set: StoredSceneSet, k: number, sentences: ReadonlyMap<number, string>): StoredSceneSet {
  // The same answer applied twice is one acceptance: a flush that failed AFTER the rename left the new texts and the closed record on disk while the writer saw
  // an error, and its retry arrives here. The set is returned as it is (the same object), which the service reads as «nothing to write».
  if (isAccepted(set, recordOf(set, k), sentences)) return set;
  const record = openRecordOf(set, k);
  if (record.kind === "idea") {
    const added: SceneRecord[] = record.scenes.map((s) => ({ sceneId: s.sceneId, origin: "own", idea: record.idea, shot: s.shot, pose: s.pose, text: sentenceFor(sentences, s.sceneId, k), edited: false, removed: false }));
    return replaceRecord({ ...set, scenes: [...set.scenes, ...added] }, k, (r) => ({ ...withoutStop(r), closed: true }));
  }
  const targets = new Set(record.sceneIds);
  const texts = new Map(record.sceneIds.map((id) => [id, sentenceFor(sentences, id, k)] as const));
  const slots = new Map(record.slots.map((slot) => [slot.slotIndex, slot] as const));
  const scenes = set.scenes.map((scene): SceneRecord => {
    if (!targets.has(scene.sceneId)) return scene;
    const text = texts.get(scene.sceneId) ?? "";
    if (scene.origin === "own") return { ...scene, text, edited: false };
    return { ...scene, slot: record.redraw ? (slots.get(scene.sceneId) ?? scene.slot) : scene.slot, text, edited: false };
  });
  const { categories, snapshotWrites } = refreshed(set, k, record.snapshots);
  const next: StoredSceneSet = { ...set, scenes, ...(categories === undefined ? {} : { categories }), ...(snapshotWrites === undefined ? {} : { snapshotWrites }) };
  return replaceRecord(next, k, (r) => ({ ...withoutStop(r), closed: true }));
}

/** Why the write stopped (never `closed`: a dying process cannot write it). A write the set does not have changes nothing. */
export function withReviewWriteStopped(set: StoredSceneSet, k: number, stop: { stoppedBy: Exclude<SceneStoppedBy, "closed">; error?: EngineError }): StoredSceneSet {
  return replaceRecord(set, k, (record) => ({
    ...withoutStop(record),
    stoppedBy: stop.stoppedBy,
    ...(stop.stoppedBy === "failed" && stop.error !== undefined ? { stoppedError: stop.error } : {}),
  }));
}

/** The write is resolved without a change to any scene (dismissed, or out of attempts): its record stays for the ids it burnt and the money it spent. */
export function withReviewWriteClosed(set: StoredSceneSet, k: number): StoredSceneSet {
  return replaceRecord(set, k, (record) => ({ ...withoutStop(record), closed: true }));
}
