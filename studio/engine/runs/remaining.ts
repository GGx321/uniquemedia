import type { Estimate } from "../../shared/engine";
import { scopeKey } from "../money/budget";
import { AGE_CHECK_CALL, WRITER_CALL, type ImageChoice } from "../money/estimate";
import { MoneyError } from "../money/errors";
import type { Ledger, Scope } from "../money/ledger";
import type { PricedBook } from "../money/priceCache";
import type { PriceBook } from "../money/prices";
import { attemptPaid, isBoldSlot, paidAttempts, type LedgerView, type RunState } from "./journal";
import { localSentences } from "../scenes/localSentences";
import { slotKeyOf } from "../scenes/phoneLook";
import { BOLD_IMAGE_MODEL, boldRoute, plannedSlots, planRoute, RUN_ATTEMPTS_PER_SLOT, type RunPlan } from "./plan";

// T6 review M3: what a resume of a run could still spend, for the owner to
// accept before it, as before a start. Worst: every open slot's remaining
// attempts at the dearest model it may still use, and every unwritten writer
// chunk's remaining answered attempts at the writer's ceiling — at today's
// prices — never more than the run's cap leaves after what the run already
// committed (the cap is never raised). Expected: one attempt per open slot
// and the writer at its typical tokens, never above the worst.

/** The run's committed money: its scope's settled costs plus its open reserves at their worst case. */
export function scopeCommitted(ledger: Pick<Ledger, "lines" | "reserveOf" | "openReserves">, scope: Scope): number {
  const key = scopeKey(scope);
  let total = 0;
  for (const line of ledger.lines) {
    if (line.type !== "settle") continue;
    const reserve = ledger.reserveOf(line.attemptId);
    if (reserve !== undefined && scopeKey(reserve.scope) === key) total += line.costMicros;
  }
  for (const reserve of ledger.openReserves()) if (scopeKey(reserve.scope) === key) total += reserve.worstMicros;
  return total;
}

function imageWorst(book: PriceBook, choice: ImageChoice): number {
  return book.imageWorstCase({ model: choice.model, quality: choice.quality, refs: choice.refs, ...(choice.resolution === undefined ? {} : { resolution: choice.resolution }) });
}

/** What a resume could still spend, and the least it must still be able to reserve to send anything at all. */
export interface RemainingPlan {
  estimate: Estimate;
  /**
   * The smallest worst case a resume has to fit under the run's cap to make
   * progress: the writer's ceiling when a chunk that holds a slot for the model
   * is still unwritten and can still be asked (the writer runs first; a chunk
   * the code template writes whole needs no request) plus the cheapest next
   * attempt of an open slot (a slot next on the Seedream fallback costs that;
   * every attempt carries its age check when the run has them). Null when
   * nothing is left to send. 5a.2: a chunk out of attempts no longer blocks the
   * resume, so its slots' images still count. A run whose cap room is
   * below it can never spend again — only be refused (RUN_CAP_EXCEEDED) — so
   * `runs.list` reports it ended rather than resumable forever.
   */
  minToProgressMicros: number | null;
}

/** `remainingPlan`'s estimate: what a resume could still spend, never more than the cap leaves. */
export function remainingEstimate(priced: PricedBook, plan: RunPlan, state: RunState, committedMicros: number, ledger: LedgerView): Estimate {
  return remainingPlan(priced, plan, state, committedMicros, ledger).estimate;
}

/** Whether the run's cap leaves room for a resume to make progress: at least `minToProgressMicros`, or nothing to send at all. */
export function capFundsResume(plan: Pick<RunPlan, "capMicros">, committedMicros: number, minToProgressMicros: number | null): boolean {
  return minToProgressMicros === null || plan.capMicros - committedMicros >= minToProgressMicros;
}

/**
 * `remainingPlan`, or null when the run's models cannot be priced now (PRICE_UNAVAILABLE: no listed price for a reference image, a
 * model gone from the book). `runs.list` must not fail and hide the healthy runs over one such run; a resume of it is refused with
 * PRICE_UNAVAILABLE by the engine's `#remaining`. Any other error is a defect and propagates.
 */
export function remainingPlanOrNull(priced: PricedBook, plan: RunPlan, state: RunState, committedMicros: number, ledger: LedgerView): RemainingPlan | null {
  try {
    return remainingPlan(priced, plan, state, committedMicros, ledger);
  } catch (error) {
    if (error instanceof MoneyError && error.code === "PRICE_UNAVAILABLE") return null;
    throw error;
  }
}

export function remainingPlan(priced: PricedBook, plan: RunPlan, state: RunState, committedMicros: number, ledger: LedgerView): RemainingPlan {
  const { book } = priced;
  const [primary, fallback] = planRoute(plan);
  const ageOn = plan.imageAgeCheck === "on";
  const ageWorst = ageOn ? book.chatWorstCase({ model: AGE_CHECK_CALL.model, maxTokens: AGE_CHECK_CALL.maxTokens, inputTokens: AGE_CHECK_CALL.inputTokens, images: AGE_CHECK_CALL.images }) : 0;
  const ageTypical = ageOn ? book.chatCost({ model: AGE_CHECK_CALL.model, images: AGE_CHECK_CALL.images, ...AGE_CHECK_CALL.typical }) : 0;
  const dearest = Math.max(imageWorst(book, primary), fallback === undefined ? 0 : imageWorst(book, fallback));

  let worst = 0;
  let expected = 0;
  let cheapestSlotAttempt: number | null = null;
  /** 5a.3 (gap C): the 2K attempt, set while an open Seedream slot remains; it goes into the estimate for the card. */
  let boldAttemptMicros: number | null = null;

  // 5a.2 (S5.6c2, I5.30): the code template writes every slot it can, so only a not-yet-journaled chunk that holds a slot the template cannot write (a null
  // slot, found with the very `local` the run's writer phase uses) is a request for the model. A chunk of template slots costs nothing here. A chunk out of
  // attempts no longer blocks the resume: its slots take the plain code sentence (S5.6d), so their images stay counted.
  const writer = { ...WRITER_CALL, model: plan.models.text };
  const local = localSentences({
    slots: plannedSlots(plan),
    keyOf: (slot) => slotKeyOf(plan.runId, slot.attemptIdBase),
    snapshots: plan.categories,
  });
  const slotOf = new Map(plannedSlots(plan).map((slot) => [slot.slotIndex, slot] as const));
  const modelSlotsOf = (chunk: RunPlan["writerChunks"][number]): number =>
    chunk.slotIndexes.filter((slotIndex) => {
      const slot = slotOf.get(slotIndex);
      return slot === undefined || local(slot) === null;
    }).length;
  const asked = plan.writerChunks.filter((chunk) => !state.writerDone.has(chunk.chunk)).filter((chunk) => modelSlotsOf(chunk) > 0);
  // A run with no chunk for the model (made from a scene set, or all template) never asks the text model: it needs no price for it.
  const writerCeiling = asked.length === 0 ? 0 : book.chatWorstCase({ model: writer.model, maxTokens: writer.maxTokens, inputTokens: writer.inputTokens, images: writer.images });
  let unwrittenSlots = 0;
  let writerPending = false;
  for (const chunk of asked) {
    const answered = chunk.attemptIds.filter((id) => attemptPaid(ledger, id)).length;
    const unused = chunk.attemptIds.filter((id) => ledger.reserveOf(id) === undefined).length;
    const attempts = Math.min(Math.max(0, writer.maxAttempts - answered), unused);
    if (attempts <= 0) continue;
    worst += attempts * writerCeiling;
    writerPending = true;
    unwrittenSlots += modelSlotsOf(chunk);
  }

  for (const slot of state.slots) {
    if (slot.end !== null || slot.fallbackUsed) continue; // a used fallback: the slot closes on resume without an attempt
    // Its paid attempts left (invariant 7), never more than its unused ids.
    const unused = slot.attemptIds.filter((id) => !slot.consumed.has(id)).length;
    const left = Math.min(RUN_ATTEMPTS_PER_SLOT - paidAttempts(slot, ledger), unused);
    if (left <= 0) continue;
    if (isBoldSlot(slot.slot)) {
      // 5a.3 (S5.9d, H1, §10.2): a Seedream slot is never a fallback slot. A refused or empty slot ends on resume without an attempt (priced 0); an open one has its paid
      // attempts left at the 2K list price, never below the route's dearest model (the figure the estimate that capped the run used), and no fallback branch.
      if (slot.boldEnded !== null) continue;
      const boldAttempt = imageWorst(book, boldRoute(plan.models.bold ?? BOLD_IMAGE_MODEL));
      boldAttemptMicros = boldAttempt;
      worst += left * (Math.max(boldAttempt, dearest) + ageWorst);
      expected += boldAttempt + ageTypical;
      cheapestSlotAttempt = Math.min(cheapestSlotAttempt ?? Infinity, boldAttempt + ageWorst);
      continue;
    }
    if (slot.useFallbackNext && fallback !== undefined) {
      // The one fallback attempt, then the slot closes.
      worst += imageWorst(book, fallback) + ageWorst;
      expected += imageWorst(book, fallback) + ageTypical;
      cheapestSlotAttempt = Math.min(cheapestSlotAttempt ?? Infinity, imageWorst(book, fallback) + ageWorst);
      continue;
    }
    worst += left * (dearest + ageWorst);
    expected += imageWorst(book, primary) + ageTypical;
    cheapestSlotAttempt = Math.min(cheapestSlotAttempt ?? Infinity, imageWorst(book, primary) + ageWorst);
  }

  if (unwrittenSlots > 0) {
    expected += book.chatCost({
      model: writer.model,
      images: writer.images,
      inputTokens: writer.typicalPerScene.inputTokens * unwrittenSlots,
      outputTokens: writer.typicalPerScene.outputTokens * unwrittenSlots,
    });
  }

  const capRoom = Math.max(0, plan.capMicros - committedMicros);
  // A chunk out of writer attempts adds no writer term (nothing more can be asked of it) but does not block the resume (S5.6d, I5.30/I5.31): its slots take
  // the plain sentence and are DRAWN, so their images stay in `worst`, and a month with no room for them refuses the resume before anything is sent.
  const worstMicros = Math.min(capRoom, worst);
  const needed = (writerPending ? writerCeiling : 0) + (cheapestSlotAttempt ?? 0);
  return {
    estimate: { expectedMicros: Math.min(expected, worstMicros), worstMicros, prices: book.source, pricesAsOf: priced.asOf, ...(boldAttemptMicros === null ? {} : { boldAttemptMicros }) },
    // A chunk out of writer attempts needs no writer room: its slots take the plain sentence, so only the cheapest next image attempt must fit under the cap
    // (`needed` above). A run with nothing left to send is not «cap exhausted».
    minToProgressMicros: needed === 0 ? null : needed,
  };
}
