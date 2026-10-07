import { z } from "zod";
import { AttemptId, EngineError, Id, ModelId, type ErrorCode } from "../../shared/engine";
import type { PhotoSidecar } from "../library";
import type { ReleaseLine, ReserveLine, SettleLine } from "../money/ledger";
import type { RunSlot } from "../scenes";
import type { RunPlan } from "./plan";

// T6: a run's journal (runs/<runId>/journal.jsonl, one fsynced line per
// event, Library.appendJournal) and the fold that turns it, the plan, the
// ledger and the photos already committed into the state a job — a fresh
// start or a resume — continues from. The journal is append-only: nothing
// is ever rewritten, so a crash can only ever lose the last line, never
// corrupt an earlier one (a torn tail is healed by the library).
//
// Three records can disagree after a crash, and each has the last word on
// its own fact:
// - the ledger (userData/ledger.jsonl): an attempt id with a reserve was
//   (or may have been) sent, so it is used whatever the journal says
//   (invariant 5: never sent twice); its reserve names the model it went to.
// - the library: a photo whose sidecar names one of the slot's attempt ids
//   is committed (invariant 11), so the slot is done.
// - the journal: everything else — writer answers, prompts, why an attempt
//   ended, a slot that failed for good.

const At = z.iso.datetime();
const SlotIndex = z.int().positive();

export const AttemptOutcomeSchema = z.enum([
  /** Stored as the slot's photo. */
  "passed",
  /** A moderation refusal (free); the fallback's cue. */
  "refused",
  /** A QA gate's clear failure: the slot's next attempt. */
  "qa-retry",
  /** A QA gate's refusal: the slot ends without a photo. */
  "qa-reject",
  /** A paid image that cannot be stored (unreadable size, animated). */
  "unusable",
  /** Any other error; its reserve is settled, released or left open by the client's settle rule. */
  "failed",
  /** A cancel stopped it; its reserve stays open at its worst case until reconciled. */
  "aborted",
  /** A paid image that arrived after the run stopped (a cancel or a fatal error): no gate ran, nothing was stored. */
  "dropped",
]);
export type AttemptOutcome = z.infer<typeof AttemptOutcomeSchema>;

export const RunEventSchema = z.discriminatedUnion("type", [
  /** A job of this run started or ended (a resume is a new job of the same run). */
  z.strictObject({ type: z.literal("job"), jobId: Id, status: z.enum(["started", "done", "failed", "cancelled"]), error: EngineError.optional(), at: At }),
  /** One writer chunk's accepted sentences, so a resume never asks for that chunk again. */
  z.strictObject({
    type: z.literal("writer"),
    chunk: z.int().positive(),
    sentences: z.array(z.strictObject({ slotIndex: SlotIndex, sentence: z.string().min(1) })).min(1),
    at: At,
  }),
  /** Every slot's final image prompt: written once, before the first image request (invariant 6). */
  z.strictObject({
    type: z.literal("prompts"),
    prompts: z.array(z.strictObject({ slotIndex: SlotIndex, prompt: z.string().min(1) })).min(1),
    at: At,
  }),
  /** How one image attempt ended. */
  z
    .strictObject({
      type: z.literal("attempt"),
      slotIndex: SlotIndex,
      attemptId: AttemptId,
      model: ModelId,
      outcome: AttemptOutcomeSchema,
      photoId: Id.optional(),
      error: EngineError.optional(),
      at: At,
    })
    .refine((e) => (e.outcome === "passed") === (e.photoId !== undefined), { message: "a photo exactly when the attempt passed", path: ["photoId"] }),
  /** A slot's final end: its photo, or why it has none and never will. */
  z
    .strictObject({ type: z.literal("slot"), slotIndex: SlotIndex, status: z.enum(["done", "failed"]), photoId: Id.optional(), error: EngineError.optional(), at: At })
    .refine((e) => (e.status === "done" ? e.photoId !== undefined && e.error === undefined : e.error !== undefined && e.photoId === undefined), {
      message: "a done slot names its photo, a failed one its error",
    }),
]);
export type RunEvent = z.infer<typeof RunEventSchema>;

export type SlotEnd = { status: "done"; photoId: string } | { status: "failed"; error: EngineError };

/** One slot as a job continues it. */
export interface SlotState {
  slot: RunSlot;
  /** The plan's pre-allocated ids, in order. */
  attemptIds: readonly string[];
  /** Ids that were (or may have been) sent: never sent again. */
  consumed: Set<string>;
  /** The one-attempt fallback was already sent for this slot. */
  fallbackUsed: boolean;
  /** The slot's last attempt was refused on the primary and the fallback is still unused. */
  useFallbackNext: boolean;
  /** How the one fallback attempt ended: its journaled outcome, "unknown" when only the ledger saw it, null while unused. */
  fallbackEnd: AttemptOutcome | "unknown" | null;
  /** The fallback attempt's journaled error, if it had one. */
  fallbackError: EngineError | null;
  /** Null while the slot may still get a photo. */
  end: SlotEnd | null;
}

export interface RunState {
  /** The writer's accepted sentences, by slot. */
  sentences: Map<number, string>;
  /** Writer chunks whose sentences are in the journal. */
  writerDone: Set<number>;
  /** Every slot's image prompt; null until the prompts event was written. */
  prompts: Map<number, string> | null;
  /** In plan order. */
  slots: SlotState[];
}

/** What the ledger says about one attempt id: its reserve and how it was closed, if it was. */
export interface LedgerView {
  reserveOf: (attemptId: string) => ReserveLine | undefined;
  closeOf: (attemptId: string) => SettleLine | ReleaseLine | undefined;
}

/**
 * Whether an attempt counts as paid (review H1/L10), for a limit on paid
 * attempts: reserved, and neither released unsent nor closed by a final
 * non-2xx's free settle (zero, not an estimate). An open reserve counts — it
 * may have been billed (money model: it counts toward the attempt limit
 * until reconciled) — and so does a reconcile's estimated settle.
 */
export function attemptPaid(ledger: LedgerView, attemptId: string): boolean {
  if (ledger.reserveOf(attemptId) === undefined) return false;
  const close = ledger.closeOf(attemptId);
  if (close === undefined) return true;
  if (close.type === "release") return false;
  return close.costMicros > 0 || close.estimated;
}

export interface FoldSources extends LedgerView {
  /** The journal's committed events, in order. */
  events: readonly RunEvent[];
  /** The run's avatar's committed photos. */
  photos: readonly PhotoSidecar[];
}

/**
 * The run's state from its plan and the three records above. Throws on a
 * journal that names a slot or an attempt id the plan never allocated: that
 * is not something a crash can produce, so continuing would be a guess.
 */
export function foldRun(plan: RunPlan, sources: FoldSources): RunState {
  const fallbackModel = plan.models.fallback;
  const slots = plan.scenes.slots.map((slot, i): SlotState => {
    const attemptIds = plan.slotAttempts[i]?.attemptIds ?? [];
    const consumed = new Set(attemptIds.filter((id) => sources.reserveOf(id) !== undefined));
    return { slot, attemptIds, consumed, fallbackUsed: false, useFallbackNext: false, fallbackEnd: null, fallbackError: null, end: null };
  });
  /** How each attempt the journal saw ended. */
  const journaled = new Map<string, Extract<RunEvent, { type: "attempt" }>>();
  const bySlot = new Map(slots.map((s) => [s.slot.slotIndex, s]));
  const slotOf = (slotIndex: number): SlotState => {
    const found = bySlot.get(slotIndex);
    if (found === undefined) throw new Error(`run ${plan.runId}'s journal names slot ${slotIndex}, which its plan does not have`);
    return found;
  };

  // A run made from a scene set holds its sentences in the plan (the writer wrote them in the set); the journal only adds a chunk's, which such a plan has none of.
  const sentences = new Map<number, string>(plan.scenes.slots.flatMap((s) => (s.sentence === undefined ? [] : [[s.slotIndex, s.sentence] as const])));
  const writerDone = new Set<number>();
  let prompts: Map<number, string> | null = null;
  for (const event of sources.events) {
    switch (event.type) {
      case "job":
        break;
      case "writer":
        writerDone.add(event.chunk);
        for (const s of event.sentences) sentences.set(s.slotIndex, s.sentence);
        break;
      case "prompts":
        prompts = new Map(event.prompts.map((p) => [p.slotIndex, p.prompt]));
        break;
      case "attempt": {
        const state = slotOf(event.slotIndex);
        if (!state.attemptIds.includes(event.attemptId)) {
          throw new Error(`run ${plan.runId}'s journal names attempt ${event.attemptId}, which slot ${event.slotIndex} was never allocated`);
        }
        state.consumed.add(event.attemptId);
        journaled.set(event.attemptId, event);
        break;
      }
      case "slot": {
        const state = slotOf(event.slotIndex);
        // RunEventSchema's own refine guarantees one of these two shapes.
        if (event.status === "done" && event.photoId !== undefined) state.end = { status: "done", photoId: event.photoId };
        else if (event.status === "failed" && event.error !== undefined) state.end = { status: "failed", error: event.error };
        else throw new Error(`run ${plan.runId}'s journal has an unreadable end for slot ${event.slotIndex}`);
        break;
      }
    }
  }

  // A committed photo is the slot's end, whatever the journal managed to say.
  const committedBy = new Map<string, string>();
  for (const photo of sources.photos) if (photo.source.kind === "generated") committedBy.set(photo.source.attemptId, photo.id);
  for (const state of slots) {
    if (state.end?.status === "done") continue;
    const attemptId = state.attemptIds.find((id) => committedBy.has(id));
    const photoId = attemptId === undefined ? undefined : committedBy.get(attemptId);
    if (attemptId === undefined || photoId === undefined) continue;
    state.end = { status: "done", photoId };
    state.consumed.add(attemptId);
  }
  for (const state of slots) routeOf(state, fallbackModel, journaled, sources);
  return { sentences, writerDone, prompts, slots };
}

/** A failure that got no answer (review H1): it stops the run, and must not use up the slot's one fallback. */
const NO_ANSWER: ReadonlySet<ErrorCode> = new Set(["RATE_LIMITED", "NETWORK"]);

/**
 * Where the slot's next attempt goes, from its attempts so far in id order
 * (each slot's attempts are sequential): the model each went to (the
 * journal's, else its reserve's) and how it ended (the journal's, else what
 * the ledger alone can tell).
 * - The one fallback attempt is used up by any fallback attempt that got an
 *   answer, was cancelled in flight, or ended in a way nobody recorded — not
 *   by one the network or a rate limit cut off (review H1), one released
 *   unsent, or one stopped between transport retries (review round 3, N1):
 *   Seedream never answered those, so the fallback is tried again. A zero
 *   settle with no journal line stays "used": it may have been its refusal.
 * - Attempts released unsent never reached a model and never decide the route.
 * - The next attempt goes to the fallback after a refusal on the primary as
 *   the slot's last attempt, or after a fallback attempt that got no answer.
 *   A lost last attempt on the primary (a crash between its settle and its
 *   journal line) closed by a final non-2xx's free settle may have been the
 *   refusal: the prompt never goes to the primary again (review L15).
 */
function routeOf(state: SlotState, fallbackModel: string | null, journaled: ReadonlyMap<string, Extract<RunEvent, { type: "attempt" }>>, ledger: LedgerView): void {
  if (fallbackModel === null) return;
  // Only an attempt that left counts for the route (review round 3, N1): one released unsent never reached a model.
  const attempts = state.attemptIds.filter((id) => state.consumed.has(id) && ledger.closeOf(id)?.type !== "release");
  const modelOf = (id: string): string | undefined => journaled.get(id)?.model ?? ledger.reserveOf(id)?.model;
  const noAnswer = (id: string): boolean => {
    const event = journaled.get(id);
    if (event?.outcome === "failed" && event.error !== undefined && NO_ANSWER.has(event.error.code)) return true;
    // Stopped between transport retries (the run stopped sending, or a cancel at the backoff): its last response was a free non-2xx.
    const close = ledger.closeOf(id);
    return event?.outcome === "aborted" && close?.type === "settle" && close.costMicros === 0 && !close.estimated;
  };
  const usedUp = attempts.filter((id) => modelOf(id) === fallbackModel && !noAnswer(id));
  const lastUse = usedUp.at(-1);
  if (lastUse !== undefined) {
    state.fallbackUsed = true;
    state.fallbackEnd = journaled.get(lastUse)?.outcome ?? "unknown";
    state.fallbackError = journaled.get(lastUse)?.error ?? null;
    state.useFallbackNext = false;
    return;
  }
  const last = attempts.at(-1);
  if (last === undefined) return;
  if (modelOf(last) === fallbackModel) {
    state.useFallbackNext = true;
    return;
  }
  const event = journaled.get(last);
  if (event !== undefined) {
    state.useFallbackNext = event.outcome === "refused";
    return;
  }
  const close = ledger.closeOf(last);
  state.useFallbackNext = close?.type === "settle" && close.costMicros === 0 && !close.estimated;
}

/**
 * How many of the slot's attempts count toward its limit of three paid
 * attempts (invariant 7, review round 3): the ones `attemptPaid` says were,
 * or may have been, billed. A free failure — a final non-2xx settled at zero,
 * a release — uses a spare id, never one of the three.
 */
export function paidAttempts(slot: SlotState, ledger: LedgerView): number {
  return slot.attemptIds.filter((id) => attemptPaid(ledger, id)).length;
}

/** The slot's next pre-allocated id nothing has used, or null when all are used. */
export function nextAttemptId(slot: SlotState): string | null {
  return slot.attemptIds.find((id) => !slot.consumed.has(id)) ?? null;
}
