import { isCustomCategory, type CategoryRef, type SceneComposeTally, type SceneInterruptedIdea, type SceneLiveWrite, type SceneRewriteInterrupted, type SceneSetView, type SceneView } from "../../shared/engine";
import type { StoredSceneSet } from "../library/sceneSets";
import type { LedgerView } from "../runs/journal";
import { categoryRefOf } from "../scenes";
import { chunkState, pendingChunks, type ChunkState } from "./chunks";
import { interruptedWrites, reviewWritesOf } from "./reviewWrites";

// CS.4a: what a window is shown of a scene set, built from the set's file, the ledger and what the engine knows is running. Nothing here is stored:
// the status and why a write stopped are DERIVED (a dying process cannot write «closed»), and so is every chunk's attempts left.

export interface ViewContext {
  /** The ledger's record of the set's attempt ids; null when it cannot be read (the spend is then unknown). */
  ledger: LedgerView | null;
  /** The attempt ids of requests at the model right now: not part of the spend, the task line shows them. */
  inFlight: ReadonlySet<string>;
  /** The write a job of this set runs now, or null. */
  live: SceneLiveWrite | null;
  /** The number of the rewrite or idea write the live job runs (CS.4b), when it is one: that write is running, not interrupted. */
  liveK?: number | null;
  /** The set's pre-issued run's folder exists: the set is used. */
  used: boolean;
}

/**
 * What the set cost: its closed attempts at what they cost (a reconcile's estimated settle included), and its open reserves that are not in flight at
 * their worst case until the owner reconciles (that part is also answered apart: it decides «учтён по худшей цене»). Null, null when the ledger is unreadable.
 */
function spendOf(set: StoredSceneSet, ledger: LedgerView | null, inFlight: ReadonlySet<string>): { spent: number; open: number } | null {
  if (ledger === null) return null;
  let spent = 0;
  let open = 0;
  for (const attemptId of [...set.chunks.flatMap((c) => c.attemptIds), ...reviewWritesOf(set).flatMap((w) => w.attemptIds)]) {
    const reserve = ledger.reserveOf(attemptId);
    if (reserve === undefined) continue;
    const close = ledger.closeOf(attemptId);
    if (close === undefined) {
      if (inFlight.has(attemptId)) continue;
      spent += reserve.worstMicros;
      open += reserve.worstMicros;
    } else if (close.type === "settle") {
      spent += close.costMicros;
    }
  }
  return { spent, open };
}

function sceneViews(set: StoredSceneSet, states: ReadonlyMap<number, ChunkState>, interrupted: ReadonlyMap<number, SceneRewriteInterrupted> = new Map()): SceneView[] {
  const chunkOf = new Map<number, ChunkState>();
  for (const state of states.values()) for (const sceneId of state.sceneIds) chunkOf.set(sceneId, state);
  const names = new Map((set.categories ?? []).map((c) => [c.ref, c.name]));
  return set.scenes.map((scene): SceneView => {
    const marker = interrupted.get(scene.sceneId);
    const mark = marker === undefined ? {} : { rewriteInterrupted: marker };
    if (scene.origin === "own") {
      return {
        sceneId: scene.sceneId,
        origin: "own",
        category: "own",
        categoryName: null,
        shot: scene.shot,
        pose: scene.pose,
        place: null,
        idea: scene.idea,
        text: scene.text,
        edited: scene.edited,
        removed: scene.removed,
        unwritten: null,
        gaveUpBy: null,
        chunk: null,
        ...mark,
      };
    }
    const { slot } = scene;
    const chunk = chunkOf.get(scene.sceneId);
    const gaveUpBy = scene.text === null ? (chunk?.gaveUpBy ?? null) : null;
    return {
      sceneId: scene.sceneId,
      origin: "planned",
      category: categoryRefOf(slot.category),
      categoryName: isCustomCategory(slot.category) ? (names.get(slot.category) ?? null) : null,
      shot: slot.shot,
      pose: slot.pose,
      place: { location: slot.location, timeOfDay: slot.timeOfDay, activity: slot.activity, outfit: slot.outfit },
      idea: null,
      text: scene.text,
      edited: scene.edited,
      removed: scene.removed,
      unwritten: scene.text !== null ? null : gaveUpBy !== null ? "gave-up" : "pending",
      gaveUpBy,
      chunk: chunk?.chunk ?? null,
      ...mark,
    };
  });
}

/** The marker of each scene a write named that was interrupted: what the card flags «замена прервана». Absent for every other scene. */
function markersOf(set: StoredSceneSet, ctx: ViewContext): Map<number, SceneRewriteInterrupted> {
  const markers = new Map<number, SceneRewriteInterrupted>();
  for (const record of interruptedWrites(set, ctx.ledger, ctx.liveK ?? null)) {
    if (record.kind !== "rewrite") continue;
    for (const sceneId of record.sceneIds) markers.set(sceneId, { write: record.k, stoppedBy: record.stoppedBy ?? "closed" });
  }
  return markers;
}

/** The idea writes that were interrupted: they added no scene, so the set lists them. Absent when there are none. */
function interruptedIdeasOf(set: StoredSceneSet, ctx: ViewContext): SceneInterruptedIdea[] {
  return interruptedWrites(set, ctx.ledger, ctx.liveK ?? null).flatMap((record) => (record.kind === "idea" ? [{ write: record.k, idea: record.idea, count: record.count, shot: record.shot, stoppedBy: record.stoppedBy ?? "closed" }] : []));
}

/** The counters of the PLANNED scenes that are not removed, as they are now: own scenes are the owner's and are not part of what a compose wrote. */
function tallyOf(scenes: readonly SceneView[]): SceneComposeTally {
  const active = scenes.filter((s) => !s.removed && s.origin === "planned");
  return { total: active.length, written: active.filter((s) => s.text !== null).length, gaveUp: active.filter((s) => s.unwritten === "gave-up").length };
}

/** The counters of a set at rest, as they are now: what a job that ends records as its outcome. */
export function currentTally(set: StoredSceneSet, ledger: LedgerView | null): SceneComposeTally {
  const states = new Map(set.chunks.map((chunk) => [chunk.chunk, chunkState(set, chunk, ledger)] as const));
  return tallyOf(sceneViews(set, states));
}

export function buildSceneSetView(set: StoredSceneSet, ctx: ViewContext): SceneSetView {
  const states = new Map(set.chunks.map((chunk) => [chunk.chunk, chunkState(set, chunk, ctx.ledger)] as const));
  const scenes = sceneViews(set, states, markersOf(set, ctx));
  const ideas = interruptedIdeasOf(set, ctx);
  // Stopped only while something is left for «Дописать» to write: a recorded write with nothing waiting (every scene written, removed or out of attempts) is ready.
  const stopped = !ctx.used && ctx.live === null && set.write !== null && pendingChunks(set, ctx.ledger).length > 0;
  const status = ctx.used ? "used" : ctx.live !== null ? "writing" : stopped ? "stopped" : "ready";
  const stoppedBy = stopped ? (set.write?.stoppedBy ?? "closed") : null;
  const spend = spendOf(set, ctx.ledger, ctx.inFlight);
  // CS.8a: a custom category's own angles ride with it, from the set's snapshot, for the strip's «у «{имя}» — свои» line.
  const categories = set.request.categories.map((ref: CategoryRef) => {
    const snapshot = isCustomCategory(ref) ? (set.categories ?? []).find((c) => c.ref === ref) : undefined;
    return { ref, name: snapshot?.name ?? null, ...(snapshot?.poses === undefined ? {} : { poses: [...snapshot.poses] }) };
  });
  return {
    sceneSetId: set.sceneSetId,
    avatarId: set.avatarId,
    createdAt: set.createdAt,
    revision: set.revision,
    status,
    stoppedBy,
    stoppedError: stoppedBy === "failed" ? (set.write?.stoppedError ?? { code: "INTERNAL" as const }) : null,
    runId: ctx.used ? set.runId : null,
    poses: { ...set.request.poses },
    categories,
    textModel: set.models.text,
    spentMicros: spend === null ? null : spend.spent,
    openReserveMicros: spend === null ? null : spend.open,
    write: ctx.live,
    // What the last job ended with, as it was said; a set no job has ended on (a seeded or a crashed one) reads as it is now.
    lastCompose: set.lastOutcome !== undefined ? { ...set.lastOutcome } : scenes.length === 0 ? null : tallyOf(scenes),
    chunks: set.chunks.map((chunk) => {
      const state = states.get(chunk.chunk);
      return { chunk: chunk.chunk, sceneIds: [...chunk.sceneIds], attemptsLeft: state?.attemptsLeft ?? 0, gaveUpBy: state?.gaveUpBy ?? null };
    }),
    scenes,
    ...(ideas.length === 0 ? {} : { interruptedIdeas: ideas }),
  };
}
