import type { EngineError } from "../../shared/engine";
import type { Budget } from "../money/budget";
import type { WriterCall } from "../money/estimate";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import { truncate } from "../openrouter/transport";
import type { ChatMessage, ChatResult, OpenRouterClient } from "../openrouter/types";
import { emptyAnswerRefusal, readWriterAnswer, writerRefusalText, WRITER_JSON_SCHEMA, type PlanSlot, type Pose, type ReadableSlot, type Shot, type SlotRepair, type WriterRefusal } from "../scenes";
import { classifyFailure } from "./failures";
import { attemptPaid, type LedgerView } from "./journal";
import type { Release } from "./pools";

// T6: the scene writer's one chunk loop. The scene writer's own prompt,
// answer rules and re-ask feedback (scenes/writer.ts) are used as they are,
// and this is their one loop (runs/writerPhase.rules.test.ts pins them
// through it). It starts each chunk at its first id the ledger
// does not already hold (a crash between a reserve and its answer must never
// send that id again, invariant 5) and hands every accepted chunk to the
// journal before the next chunk is asked, so a resume never pays for a chunk
// twice. The chunks and their ids come from the caller (a run: its plan's,
// runs/plan.ts: `${runId}:writer-${chunk}#N`).
//
// Review H1/L10: a chunk gets WRITER_CALL.maxAttempts *answered* attempts,
// counted across jobs from the ledger (attemptPaid) — what the estimate
// prices. An attempt that got no answer (a final 429, a 5xx after the
// transport retries, a network error) stops the phase, and the run, for a
// resume later, instead of taking the chunk's next id at once; the plan's
// spare ids (WRITER_SPARE_IDS) keep such stops from closing the chunk.

export interface WriterPhaseDeps {
  /** The OpenRouter client's chat (T3): reserve on disk, send, settle. */
  chat: OpenRouterClient["chat"];
  budget: Budget;
  /** Each attempt's reserve is its worst case at these prices. */
  priceBook: PriceBook;
  /** A network slot for one call (the run's NetworkPool); rejects when the signal aborts first. */
  acquire: (signal: AbortSignal) => Promise<Release>;
  /** Persists one chunk's accepted sentences (the run's journal); awaited before the next chunk is asked. */
  onChunk: (chunk: number, sentences: ReadonlyMap<number, string>) => Promise<void>;
  /**
   * S5.6d: a chunk that did not finish (an attempt that got no answer, a stop, a cancel) hands over the sentences earlier attempts of this job had accepted: they are paid for,
   * so the caller keeps them (a set's scenes, a run's journal marked partial), and a resume asks only about the slots still without one. Absent: they are not kept.
   */
  onPartial?: (chunk: number, sentences: ReadonlyMap<number, string>) => Promise<void>;
}

/**
 * The shape of every call of a writer phase: the ceilings its reserve is priced
 * at and how many answered attempts a chunk may use. A run passes exactly
 * money/estimate.ts's WRITER_CALL (runs/plan.ts's `runWriterConfig`), which is
 * what its estimate prices; a scene set passes its own.
 */
export interface WriterCallShape {
  readonly maxTokens: number;
  readonly inputTokens: number;
  /**
   * 5a.4 (S5.BA5, r2.1 N1): the call's reasoning allowance (money/estimate.ts `WriterCall.reasoningTokens`), handed to chat(), whose reserve prices it as
   * completion on top of `maxTokens` and never sends it. So an attempt reserves exactly what `writerAttemptWorstMicros` priced it at. Absent = 0.
   */
  readonly reasoningTokens?: number;
  readonly maxAttempts: number;
  /**
   * S5.BA5a round 2 (M2 b): only `writerCallShape` makes a shape, so none can be built by hand without the call's reasoning allowance (a bold shape
   * without it reserved 41 250 µ$ under a 48 750 estimate). A type alone: nothing is added at run time.
   */
  readonly [WRITER_CALL_SHAPE]: true;
}

declare const WRITER_CALL_SHAPE: unique symbol;

/**
 * 5a.4 (S5.BA5, plan s5a4 §5.3.4 «The reserve»): the phase's shape of a writer call (money/estimate.ts's `writerCallOf(mode)`), its reasoning allowance
 * included when it has one. The ordinary call has none, so its shape is today's three fields, byte for byte. The one maker of a `WriterCallShape`
 * (round 2, M2 b): the brand is a type with no value, so the plain object is asserted to it here and nowhere else (writerCall.static.test.ts).
 */
export function writerCallShape(call: WriterCall): WriterCallShape {
  const shape = Object.freeze({
    maxTokens: call.maxTokens,
    inputTokens: call.inputTokens,
    ...(call.reasoningTokens === undefined ? {} : { reasoningTokens: call.reasoningTokens }),
    maxAttempts: call.maxAttempts,
  });
  return shape as WriterCallShape;
}

/** A run's phase asks about its plan's slots; a scene set's review write (CS.4b) may ask about own scenes, which carry only what the answer reader needs. */
export interface WriterPhase<S extends ReadableSlot = PlanSlot> {
  /** The call's ceilings and the answered attempts a chunk may use. */
  call: WriterCallShape;
  /** The messages of one attempt; `feedback` is why the chunk's previous answer was rejected. */
  messages: (slots: readonly S[], feedback: WriterRefusal | undefined) => ChatMessage[];
  /** The ledger's jobId for these calls. */
  jobId: string;
  /** The run's cap scope. */
  scope: Scope;
  /** The settings' text model, as the run was planned. */
  textModel: string;
  /** CS.8a: the structured-output schema asked for; the compose schema (sentences only) when absent. An idea write asks for its own, with the angle the model picks. */
  jsonSchema?: { name: string; schema: Record<string, unknown> };
  /** CS.8a: how an answer is read; the writer's own reader (sentences only) when absent. An idea write's reader also settles the angle of each scene it was asked to pick. */
  read?: (content: string, slots: readonly S[]) => PhaseRead;
  /**
   * 5a.2 (S5.6c1, plan s5a2 §5.5): the code template's side of the seam. A slot's sentence from the template, or null when the template cannot write it
   * (the place or the moment is not found by name in today's banks): a null slot goes to the model at its chunk's reserved ids. It never throws. A chunk
   * whose slots are all local is journaled with no call and no reserve, before any chunk that needs the model (M4); a mixed chunk sends only its null
   * slots. Absent: every slot goes to the model, as before.
   */
  local?: (slot: S) => string | null;
  /**
   * 5a.2 (S5.6d, plan s5a2 §5.5 «After the last attempt»): the sentence a PLANNED slot takes when the model could not write it in the chunk's answered attempts
   * (each refused, or none left to ask). It is built from the slot's own texts, never throws and costs nothing, so a refused or exhausted chunk still ends with a
   * sentence for every slot. Absent (an own scene has no texts to build one from): the slot stays unwritten and the chunk is exhausted, as before. A moderation
   * refusal of the writer's prompt and a failure that is no answer (a 401, a 429) are not an exhausted chunk: they end or stop the phase as before.
   */
  plain?: (slot: S) => string;
  /**
   * 5a.2 (S5.6d): an idea write keeps the scenes it accepted. When the last attempt leaves some slots unwritten the phase still succeeds with the accepted ones,
   * naming the others in `unwritten`; with nothing accepted it is exhausted as before. Ignored for a slot that has a `plain` sentence.
   */
  keepAccepted?: boolean;
  /** The run job's cancel. */
  signal: AbortSignal;
  /**
   * S4.5b, the soft stop: once it fires no new attempt and no new chunk is asked; a request already out finishes and is settled and kept as usual.
   * Absent, the phase can only be stopped by the hard cancel.
   */
  stop?: AbortSignal;
  /** The plan's slots, in plan order. */
  slots: readonly S[];
  /** The plan's writer chunks, with their pre-allocated ids. */
  chunks: readonly { chunk: number; slotIndexes: readonly number[]; attemptIds: readonly string[] }[];
  /** Sentences already in the journal (a resume). */
  sentences: ReadonlyMap<number, string>;
  /** Chunks already in the journal: never asked again. */
  writerDone: ReadonlySet<number>;
  /** The ledger's record of the chunk's ids: a reserved id is never sent again; a paid one counts as answered. */
  ledger: LedgerView;
}

/**
 * - ok: every slot's sentence, the journal's earlier ones included.
 * - not ok, the phase stopped: `cancelled` by the user; `soft-stopped` by the soft stop (S4.5b: nothing was lost,
 *   the next chunk or attempt is simply not asked, and a later job asks it under its next unused id); `stopped` by a failure
 *   a later job may get past (a rate limit, an outage, the network, the key,
 *   the run's cap, a ledger halt) — the run stays resumable; `exhausted`: a
 *   chunk used every answer it may have, or every id it has, so no job will
 *   ever write it. Every attempt made so far is settled, released or left
 *   open by the client's own settle rule.
 */
export type WriterPhaseResult =
  | {
      ok: true;
      sentences: Map<number, string>;
      angles?: Map<number, PhaseAngle>;
      /** S5.6d: the slots a `keepAccepted` phase left without a sentence (the last attempt refused them). Absent when every slot has one. */
      unwritten?: number[];
    }
  | { ok: false; stop: "cancelled" | "soft-stopped" | "stopped" | "exhausted"; error: EngineError };

/** The shot and the pose a reader settled on for one scene (an idea write's, CS.8a). */
export interface PhaseAngle {
  shot: Shot;
  pose: Pose;
}

/** What a refusal that belongs to some slots leaves for the next attempt (writer.ts `SlotRepair`); an idea write's also carries the angle of each kept scene. */
export interface PhaseRepair extends SlotRepair {
  angles?: Map<number, PhaseAngle>;
}

/**
 * What a phase's reader answers: the writer's own answer, or (an idea write) that with the angle of each scene. A refusal that belongs to some slots carries a
 * `repair` (the next attempt asks only the marked slots and keeps the accepted ones); one without is a refusal of the whole answer.
 */
export type PhaseRead = { ok: true; sentences: Map<number, string>; angles?: Map<number, PhaseAngle> } | ({ ok: false } & WriterRefusal & { repair?: PhaseRepair });

function cancelled(): Extract<WriterPhaseResult, { ok: false }> {
  return { ok: false, stop: "cancelled", error: { code: "INTERNAL", detail: "the run was cancelled while its scenes were being written" } };
}

function softStopped(): Extract<WriterPhaseResult, { ok: false }> {
  return { ok: false, stop: "soft-stopped", error: { code: "INTERNAL", detail: "the scene writer was stopped before its next request" } };
}

/** One call under `attemptId`, inside a network slot; null when the cancel came first, "soft-stopped" when the soft stop did (before a reserve was made). */
async function ask<S extends ReadableSlot>(deps: WriterPhaseDeps, phase: WriterPhase<S>, attemptId: string, slots: readonly S[], feedback: WriterRefusal | undefined): Promise<ChatResult | null | "soft-stopped"> {
  let release: Release;
  try {
    // A call still queued for its slot gives way to the soft stop too: it has not started, nothing is reserved.
    release = await deps.acquire(phase.stop === undefined ? phase.signal : AbortSignal.any([phase.signal, phase.stop]));
  } catch {
    return phase.signal.aborted ? null : "soft-stopped";
  }
  // The soft stop may have come while this call waited for its slot: nothing is reserved yet, so nothing is left behind.
  if (phase.stop?.aborted === true) {
    release();
    return "soft-stopped";
  }
  try {
    return await deps.chat({
      attemptId,
      jobId: phase.jobId,
      scope: phase.scope,
      model: phase.textModel,
      budget: deps.budget,
      priceBook: deps.priceBook,
      signal: phase.signal,
      // A stop between the reserve reaching the disk and the send releases the reserve unsent (free), never leaves it open.
      ...(phase.stop === undefined ? {} : { beforeSend: () => phase.stop?.aborted !== true }),
      messages: phase.messages(slots, feedback),
      jsonSchema: phase.jsonSchema ?? WRITER_JSON_SCHEMA,
      maxTokens: phase.call.maxTokens,
      inputTokens: phase.call.inputTokens,
      ...(phase.call.reasoningTokens === undefined ? {} : { reasoningTokens: phase.call.reasoningTokens }),
      reasoningEffort: "low",
    });
  } finally {
    release();
  }
}

/**
 * One chunk, from its first unused id: an answer the writer's rules refuse
 * (or an empty one) is asked again under the next id, told why, until the
 * chunk has used its answered attempts; an attempt that got no answer, or
 * anything else that is not an answer, stops the phase. A chunk with no
 * unused id, or no answered attempt left, fails without sending anything.
 *
 * 5a.2 (S5.6d, plan s5a2 §5.5): the second attempt repairs, it does not start over. An answer refused for some slots (`repair`) keeps the sentences that
 * passed, and the next attempt asks only the marked slots, told today's reason; a refusal of the whole answer keeps nothing, and the next attempt asks every
 * slot still open. When the answered attempts are used up (or there is none left to ask) a planned slot takes the plain sentence (`phase.plain`); with no
 * `plain`, an idea write (`keepAccepted`) keeps what it accepted and names the rest `unwritten`, and anything else is exhausted as before.
 */
async function writeChunk<S extends ReadableSlot>(
  deps: WriterPhaseDeps,
  phase: WriterPhase<S>,
  chunk: WriterPhase<S>["chunks"][number],
  slots: readonly S[],
  kept: Map<number, string>,
): Promise<{ ok: true; sentences: Map<number, string>; angles?: Map<number, PhaseAngle>; unwritten?: number[] } | Extract<WriterPhaseResult, { ok: false }>> {
  let feedback: WriterRefusal | undefined;
  /** The slots still open (`kept` holds what earlier attempts of this job accepted). */
  const keptAngles = new Map<number, PhaseAngle>();
  let open: readonly S[] = slots;
  const done = (): { ok: true; sentences: Map<number, string>; angles?: Map<number, PhaseAngle> } => ({ ok: true, sentences: kept, ...(keptAngles.size === 0 ? {} : { angles: keptAngles }) });
  let answered = chunk.attemptIds.filter((id) => attemptPaid(phase.ledger, id)).length;
  for (const attemptId of chunk.attemptIds) {
    if (answered >= phase.call.maxAttempts) break;
    if (phase.ledger.reserveOf(attemptId) !== undefined) continue;
    if (phase.signal.aborted) return cancelled();
    if (phase.stop?.aborted === true) return softStopped();
    const result = await ask(deps, phase, attemptId, open, feedback);
    if (result === "soft-stopped") return softStopped();
    if (result === null) return cancelled();
    // An abort with no hard cancel behind it is the soft stop releasing a reserve before the send.
    if (result.status === "aborted") return phase.signal.aborted ? cancelled() : softStopped();
    if (result.status === "ok" && !result.aboveWorst) {
      answered++;
      const reader: (content: string, slots: readonly S[]) => PhaseRead = phase.read ?? readWriterAnswer;
      const read = reader(result.content, open);
      if (read.ok) {
        for (const [slotIndex, sentence] of read.sentences) kept.set(slotIndex, sentence);
        for (const [slotIndex, angle] of read.angles ?? []) keptAngles.set(slotIndex, angle);
        return done();
      }
      feedback = read;
      if (read.repair !== undefined) {
        for (const [slotIndex, sentence] of read.repair.accepted) kept.set(slotIndex, sentence);
        for (const [slotIndex, angle] of read.repair.angles ?? []) keptAngles.set(slotIndex, angle);
        const marked = new Set(read.repair.marked);
        open = open.filter((slot) => marked.has(slot.slotIndex));
      }
      continue;
    }
    if (result.status === "error" && result.kind === "EMPTY_CONTENT") {
      answered++;
      feedback = emptyAnswerRefusal();
      continue;
    }
    if (result.status === "ok") return { ok: false, stop: "stopped", error: { code: "SETTLE_ABOVE_WORST", detail: `the scene writer's attempt ${attemptId} was billed above its worst case` } };
    // A moderation refusal of the writer's own prompt is final: the same prompt would be refused again, so no job
    // will ever write this chunk, and a resume would only burn its spare ids (review round 3, L-b).
    const refused = result.status === "refused";
    // S5.6d (I5.31): the provider's refusal of the writer's prompt is final for the REQUEST (the same prompt would be refused again, so no second one), but it never ends a
    // planned slot: the chunk's open slots take the plain sentence at once. A phase with no `plain` (an idea write) ends as before.
    if (refused && phase.plain !== undefined) {
      for (const slot of open) kept.set(slot.slotIndex, phase.plain(slot));
      return done();
    }
    const { error } = refused ? { error: { code: "MODERATION_REFUSED" as const, detail: result.message } } : classifyFailure(result);
    const detail = feedback === undefined ? error.detail : `${error.detail ?? error.code} (after an answer rejected for: ${writerRefusalText(feedback)})`;
    return { ok: false, stop: refused ? "exhausted" : "stopped", error: { ...error, ...(detail === undefined ? {} : { detail: truncate(detail) }) } };
  }
  // No attempt is left for this chunk. A planned slot still open takes the plain sentence: a refusal of the writer never ends a planned run.
  if (phase.plain !== undefined) {
    for (const slot of open) kept.set(slot.slotIndex, phase.plain(slot));
    return done();
  }
  if (phase.keepAccepted === true && kept.size > 0) return { ...done(), unwritten: open.map((slot) => slot.slotIndex) };
  const why =
    answered >= phase.call.maxAttempts
      ? `the scene writer's answer for chunk ${chunk.chunk} was rejected on every one of its ${phase.call.maxAttempts} attempts; the last one for: ${feedback === undefined ? "an earlier job's answer" : writerRefusalText(feedback)}`
      : `every attempt id of the scene writer's chunk ${chunk.chunk} is already used`;
  return { ok: false, stop: "exhausted", error: { code: "INTERNAL", detail: truncate(why) } };
}

/**
 * Every chunk not yet in the journal. The chunks the template writes whole go first, in order, with no call and no reserve (M4: a cap stop during a
 * model chunk never strands template sentences); then the chunks that hold a slot for the model, in order, one at a time. The first chunk that cannot
 * be written ends the phase: a later chunk is never asked.
 */
export async function runWriterPhase<S extends ReadableSlot = PlanSlot>(deps: WriterPhaseDeps, phase: WriterPhase<S>): Promise<WriterPhaseResult> {
  const sentences = new Map(phase.sentences);
  const angles = new Map<number, PhaseAngle>();
  const unwritten: number[] = [];
  const bySlot = new Map(phase.slots.map((slot) => [slot.slotIndex, slot]));
  const todo = phase.chunks
    .filter((chunk) => !phase.writerDone.has(chunk.chunk))
    .map((chunk) => {
      const slots = chunk.slotIndexes.map((slotIndex) => {
        const slot = bySlot.get(slotIndex);
        if (slot === undefined) throw new Error(`the writer's chunk ${chunk.chunk} names slot ${slotIndex}, which the plan does not have`);
        return slot;
      });
      const local = new Map<number, string>();
      const open: S[] = [];
      for (const slot of slots) {
        // A sentence a stopped job kept for this slot (S5.6d `onPartial`) is not asked again.
        const text = phase.sentences.get(slot.slotIndex) ?? phase.local?.(slot) ?? null;
        if (text === null) open.push(slot);
        else local.set(slot.slotIndex, text);
      }
      return { chunk, local, open };
    });
  for (const { chunk, local, open } of [...todo.filter((t) => t.open.length === 0), ...todo.filter((t) => t.open.length > 0)]) {
    if (phase.signal.aborted) return cancelled();
    if (phase.stop?.aborted === true) return softStopped();
    let written: Map<number, string> = new Map();
    if (open.length > 0) {
      const kept = new Map<number, string>();
      const asked = await writeChunk(deps, phase, chunk, open, kept);
      if (!asked.ok) {
        if (kept.size > 0) await deps.onPartial?.(chunk.chunk, kept);
        return asked;
      }
      written = asked.sentences;
      for (const [slotIndex, angle] of asked.angles ?? []) angles.set(slotIndex, angle);
      unwritten.push(...(asked.unwritten ?? []));
    }
    // Journal order within a chunk is slot order, whoever wrote the sentence.
    const whole = new Map<number, string>();
    for (const slotIndex of chunk.slotIndexes) {
      const text = local.get(slotIndex) ?? written.get(slotIndex);
      if (text !== undefined) whole.set(slotIndex, text);
    }
    await deps.onChunk(chunk.chunk, whole);
    for (const [slotIndex, sentence] of whole) sentences.set(slotIndex, sentence);
  }
  return { ok: true, sentences, ...(angles.size === 0 ? {} : { angles }), ...(unwritten.length === 0 ? {} : { unwritten }) };
}
