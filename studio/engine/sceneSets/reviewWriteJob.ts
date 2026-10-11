import type { CategorySnapshot, EngineError, SceneStoppedBy } from "../../shared/engine";
import type { ReviewWriteRecord, StoredSceneSet } from "../library/sceneSets";
import type { Budget } from "../money/budget";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import { runWriterConfig } from "../runs/plan";
import { localSentences } from "../scenes/localSentences";
import { runWriterPhase, type WriterPhase, type WriterPhaseDeps, type WriterPhaseResult } from "../runs/writerPhase";
import { plainSentence, type PlanSlot } from "../scenes";
import { ideaAsksOf, ideaJsonSchema, ideaMessages, readIdeaAnswer, toIdeaSlot, type IdeaAngle, type IdeaAsk } from "../scenes/ideaWriter";
import { writerMessages } from "../scenes/writer";
import { categoryLabelOf } from "../scenes/categories";
import { reviewWriteState, reviewWritesOf } from "./reviewWrites";
import { lastAttemptWasFree, stoppedByOf } from "./writeJob";

// CS.4b: the job of a rewrite or an idea write. ONE writer request, asked at most twice (answered attempts are counted from the ledger across every job and
// every restart, exactly as a compose chunk's are), about the scenes of the write ALONE:
//
//  - a rewrite of planned scenes sends the compose prompt (writer.ts, byte for byte) with each scene's slot, or with the redrawn slot the write drew before
//    its first call (a resume sends the same one) and the category's refreshed label;
//  - a rewrite of own scenes and an idea write send the idea prompt, with the scene's STORED idea (never the current text, which may be a hand edit);
//  - an accepted answer is stored (`accept`) before the job ends; a scene changes only then, and only the scenes of the write;
//  - 5a.2 (S5.6d): the second attempt asks only the scenes the first got wrong. A PLANNED scene still wrong takes the plain sentence of its (redrawn) place, so a
//    planned rewrite is always written; an idea write and a rewrite of own scenes have no place to build one from, so they keep the scenes they accepted
//    (stored as a partial answer, the rest unwritten) and fail only when they accepted none;
//  - a write that can never be answered (a provider's refusal, an idea write that accepted nothing in two attempts) is RESOLVED (`giveUp`): nothing changed,
//    nothing to resume, its ids burnt; one that got no answer stays open and resumable under its own ids.

export interface ReviewWriteDeps {
  /** The OpenRouter client's chat: reserve on disk, send, settle. */
  chat: WriterPhaseDeps["chat"];
  budget: Budget;
  /** The prices the job was accepted at; each attempt's reserve is its worst case at these prices. */
  priceBook: PriceBook;
  /** A network slot for one call; rejects when the signal aborts first. */
  acquire: WriterPhaseDeps["acquire"];
  /** The set as it is now. */
  load: () => Promise<StoredSceneSet>;
  /** Stores the accepted answer in the set (under its lock); awaited before the job ends. */
  accept: (k: number, sentences: ReadonlyMap<number, string>, angles?: ReadonlyMap<number, IdeaAngle>, partial?: boolean) => Promise<void>;
  /** Resolves a write nobody can answer any more. */
  giveUp: (k: number) => Promise<void>;
  /** The scenes this job has written so far. */
  progress: (done: number) => void;
}

export interface ReviewWriteRequest {
  /** The write's number in its set. */
  k: number;
  jobId: string;
  /** The job's cap scope; the Budget holds its cap (the accepted worst case). */
  scope: Scope;
  signal: AbortSignal;
  /** S4.5b, the soft stop: no attempt is started once it fires; the request already out finishes and an accepted answer is stored. The job ends `cancelled`, resumable. */
  stop?: AbortSignal;
}

/**
 * How the job ended. `done`: the answer is in the set. `failed`: stopped by a failure or given up on; `resolved` says nothing can be resumed (the write was
 * closed), and `stoppedBy` is why, for the write's record. `cancelled`: the owner's cancel (the reserve of a request in flight stays open) or the soft stop (nothing was aborted: the request in flight settled, or none was started).
 */
export type ReviewWriteEnd =
  | { status: "done"; written: number; unwritten: number }
  | { status: "failed"; error: EngineError; stoppedBy: Exclude<SceneStoppedBy, "closed">; resolved: boolean }
  | { status: "cancelled" };

/** The snapshots the prompt names categories by: the set's own, with the ones a redraw refreshed put in their place. */
function snapshotsFor(set: StoredSceneSet, record: ReviewWriteRecord): CategorySnapshot[] {
  // A snapshot a LATER write already refreshed in the set is the newer view: this write's own is not put over it.
  const fresh = record.kind === "rewrite" ? record.snapshots.filter((s) => (set.snapshotWrites?.[s.ref] ?? 0) < record.k) : [];
  return (set.categories ?? []).map((old) => fresh.find((s) => s.ref === old.ref) ?? old);
}

/** What the write asks the writer about. A write is of one kind: planned slots (the compose prompt) or ideas. */
type Asked = { kind: "slots"; slots: PlanSlot[]; labelOf: ReturnType<typeof categoryLabelOf> } | { kind: "ideas"; slots: IdeaAsk[]; mirrorAllowed: boolean };

function askedOf(set: StoredSceneSet, record: ReviewWriteRecord): Asked {
  // CS.8a: a new idea write leaves the pose to the model, and the shot too when the owner chose «Авто» (the record's shot is null); the stored draw is only what the slot holds meanwhile.
  if (record.kind === "idea") return { kind: "ideas", slots: record.scenes.map((s) => ({ slotIndex: s.sceneId, idea: record.idea, shot: s.shot, pose: s.pose, askShot: record.shot === null, askPose: true })), mirrorAllowed: record.mirrorAllowed === true };
  const scenes = record.sceneIds.map((sceneId) => {
    const scene = set.scenes.find((s) => s.sceneId === sceneId);
    if (scene === undefined) throw new Error(`rewrite ${record.k} names scene ${sceneId}, which the set does not have`);
    return scene;
  });
  const planned = scenes.flatMap((s) => (s.origin === "planned" ? [s] : []));
  if (planned.length === scenes.length) {
    const redrawn = new Map(record.slots.map((slot) => [slot.slotIndex, slot] as const));
    return { kind: "slots", slots: planned.map((s) => (record.redraw ? (redrawn.get(s.sceneId) ?? s.slot) : s.slot)), labelOf: categoryLabelOf(snapshotsFor(set, record)) };
  }
  // A rewrite of an own scene keeps its shot and its pose: the model is asked for neither.
  const own = scenes.flatMap((s) => (s.origin === "own" ? [{ slotIndex: s.sceneId, idea: s.idea, shot: s.shot, pose: s.pose, askShot: false, askPose: false }] : []));
  if (own.length !== scenes.length) throw new Error(`rewrite ${record.k} mixes planned and own scenes: one request is one kind`);
  return { kind: "ideas", slots: own, mirrorAllowed: false };
}

/** The sentences the write is drawn off: every other scene's text, and a target's own old one (a rewrite never hands back the sentence the scene already has). */
function heldOf(set: StoredSceneSet): string[] {
  return set.scenes.flatMap((scene) => (!scene.removed && scene.text !== null ? [scene.text] : []));
}

/** The template's side for a write's planned slots, on the write's own key: what the job hands the writer phase, and what the estimate counts. */
function localOf(set: StoredSceneSet, record: ReviewWriteRecord, slots: readonly PlanSlot[]): (slot: PlanSlot) => string | null {
  return localSentences({ slots, keyOf: (slot) => `${set.sceneSetId}:${slot.slotIndex}:${record.k}`, snapshots: snapshotsFor(set, record), seen: heldOf(set) });
}

/**
 * 5a.2 (S5.6c2, plan s5a2 §5.6): how many scenes of the write the model must write, decided exactly as the job decides it (`askedOf` and the very `local` it
 * hands the writer phase). 0 for a write whose every planned slot the code template renders ($0); every scene of an idea write or of a rewrite of own
 * scenes (the template has no sentence for an idea); the null slots of a planned rewrite, an old-pool slot of an interrupted one among them.
 */
export function modelScenesOf(set: StoredSceneSet, record: ReviewWriteRecord): number {
  const asked = askedOf(set, record);
  if (asked.kind === "ideas") return asked.slots.length;
  const local = localOf(set, record, asked.slots);
  return asked.slots.filter((slot) => local(slot) === null).length;
}

export async function runReviewWrite(deps: ReviewWriteDeps, request: ReviewWriteRequest): Promise<ReviewWriteEnd> {
  const { budget } = deps;
  const ledger = budget.ledger;
  const set = await deps.load();
  const record = reviewWritesOf(set).find((r) => r.k === request.k);
  if (record === undefined) throw new Error(`scene set ${set.sceneSetId} has no review write ${request.k}`);
  if (record.closed) throw new Error(`review write ${request.k} of scene set ${set.sceneSetId} is resolved and is not run again`);
  /** A cancel with no attempt left resolves the write like a stop does: nothing could be resumed, and an unresolved record would hold its idea room unseen. */
  const cancelled = async (): Promise<ReviewWriteEnd> => {
    if (reviewWriteState(record, ledger).attemptsLeft === 0) await deps.giveUp(record.k);
    return { status: "cancelled" };
  };
  if (request.signal.aborted || request.stop?.aborted === true) return cancelled();

  const asked = askedOf(set, record);
  const base = {
    jobId: request.jobId,
    scope: request.scope,
    textModel: set.models.text,
    signal: request.signal,
    ...(request.stop === undefined ? {} : { stop: request.stop }),
    sentences: new Map<number, string>(),
    writerDone: new Set<number>(),
    ledger,
    chunks: [{ chunk: record.k, slotIndexes: asked.slots.map((s) => s.slotIndex), attemptIds: record.attemptIds }],
  };
  const phaseDeps: WriterPhaseDeps = {
    chat: deps.chat,
    budget,
    priceBook: deps.priceBook,
    acquire: deps.acquire,
    // The answer is stored by the job below, once, with the sentences the reader accepted.
    onChunk: async () => {},
  };
  const { call } = runWriterConfig(undefined);
  let result: WriterPhaseResult;
  if (asked.kind === "slots") {
    // 5a.2: the code template writes every scene it can, at $0; the model is asked only about the rest. The draw key is the write's own (`…:k`), and a
    // sentence another scene of the set already holds is redrawn.
    // A target's own old text counts too: a rewrite never hands back the sentence the scene already has.
    const local = localOf(set, record, asked.slots);
    // S5.6d: a planned scene the model could not write in the write's two attempts takes the plain sentence of its (possibly redrawn) place.
    const phase: WriterPhase<PlanSlot> = { ...base, call, slots: asked.slots, local, plain: plainSentence, messages: (slots, feedback) => writerMessages(slots, feedback, asked.labelOf) };
    result = await runWriterPhase(phaseDeps, phase);
  } else {
    const phase: WriterPhase<IdeaAsk> = {
      ...base,
      call,
      slots: asked.slots,
      // S5.6d: an idea (and an own scene) has no place or moment to build a plain sentence from: what the last attempt refused stays unwritten, and the scenes
      // the write accepted are kept.
      keepAccepted: true,
      jsonSchema: ideaJsonSchema(asked.mirrorAllowed, ideaAsksOf(asked.slots)),
      read: (content, slots) => readIdeaAnswer(content, slots.map(toIdeaSlot), asked.mirrorAllowed),
      messages: (slots, feedback) => ideaMessages(slots.map(toIdeaSlot), feedback, asked.mirrorAllowed),
    };
    result = await runWriterPhase(phaseDeps, phase);
  }

  if (result.ok) {
    const unwritten = result.unwritten?.length ?? 0;
    await deps.accept(record.k, result.sentences, result.angles, unwritten > 0);
    const written = asked.slots.length - unwritten;
    deps.progress(written);
    return { status: "done", written, unwritten };
  }
  if (result.stop === "cancelled" || result.stop === "soft-stopped") return cancelled();
  if (result.stop === "stopped") {
    // An attempt that got no answer stops the job. When no attempt is left (the answers before it used them up), nothing could be resumed: resolve it.
    const resolved = reviewWriteState(record, ledger).attemptsLeft === 0;
    if (resolved) await deps.giveUp(record.k);
    return { status: "failed", error: result.error, stoppedBy: stoppedByOf(result.error, lastAttemptWasFree(budget, record.attemptIds)), resolved };
  }
  // exhausted: a provider's refusal, two rejected answers, or no id left: the write will never be answered.
  await deps.giveUp(record.k);
  return { status: "failed", error: result.error, stoppedBy: "failed", resolved: true };
}
