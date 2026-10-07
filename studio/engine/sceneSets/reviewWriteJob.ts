import type { CategorySnapshot, EngineError, SceneStoppedBy } from "../../shared/engine";
import type { ReviewWriteRecord, StoredSceneSet } from "../library/sceneSets";
import type { Budget } from "../money/budget";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import { runWriterConfig } from "../runs/plan";
import { runWriterPhase, type WriterPhase, type WriterPhaseDeps, type WriterPhaseResult } from "../runs/writerPhase";
import type { PlanSlot } from "../scenes";
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
//  - an accepted answer is stored whole (`accept`) before the job ends; a scene changes only then, and only the scenes of the write;
//  - a write that can never be answered (two rejected answers, a provider's refusal, no attempt left) is RESOLVED (`giveUp`): nothing changed, nothing to
//    resume, its ids burnt; one that got no answer stays open and resumable under its own ids.

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
  accept: (k: number, sentences: ReadonlyMap<number, string>, angles?: ReadonlyMap<number, IdeaAngle>) => Promise<void>;
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
}

/**
 * How the job ended. `done`: the answer is in the set. `failed`: stopped by a failure or given up on; `resolved` says nothing can be resumed (the write was
 * closed), and `stoppedBy` is why, for the write's record. `cancelled`: the owner's cancel; the reserve of a request in flight stays open.
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
  if (request.signal.aborted) return cancelled();

  const asked = askedOf(set, record);
  const base = {
    jobId: request.jobId,
    scope: request.scope,
    textModel: set.models.text,
    signal: request.signal,
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
    const phase: WriterPhase<PlanSlot> = { ...base, call, slots: asked.slots, messages: (slots, feedback) => writerMessages(slots, feedback, asked.labelOf) };
    result = await runWriterPhase(phaseDeps, phase);
  } else {
    const phase: WriterPhase<IdeaAsk> = {
      ...base,
      call,
      slots: asked.slots,
      jsonSchema: ideaJsonSchema(asked.mirrorAllowed, ideaAsksOf(asked.slots)),
      read: (content, slots) => readIdeaAnswer(content, slots.map(toIdeaSlot), asked.mirrorAllowed),
      messages: (slots, feedback) => ideaMessages(slots.map(toIdeaSlot), feedback, asked.mirrorAllowed),
    };
    result = await runWriterPhase(phaseDeps, phase);
  }

  if (result.ok) {
    await deps.accept(record.k, result.sentences, result.angles);
    deps.progress(asked.slots.length);
    return { status: "done", written: asked.slots.length, unwritten: 0 };
  }
  if (result.stop === "cancelled") return cancelled();
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
