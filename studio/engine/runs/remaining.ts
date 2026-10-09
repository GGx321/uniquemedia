import type { Estimate } from "../../shared/engine";
import { scopeKey } from "../money/budget";
import { AGE_CHECK_CALL, WRITER_CALL, type ImageChoice } from "../money/estimate";
import { MoneyError } from "../money/errors";
import type { Ledger, Scope } from "../money/ledger";
import type { PricedBook } from "../money/priceCache";
import type { PriceBook } from "../money/prices";
import { attemptPaid, paidAttempts, type LedgerView, type RunState } from "./journal";
import { planRoute, RUN_ATTEMPTS_PER_SLOT, type RunPlan } from "./plan";

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
  return book.imageWorstCase({ model: choice.model, quality: choice.quality, refs: choice.refs });
}

/** What a resume could still spend, and the least it must still be able to reserve to send anything at all. */
export interface RemainingPlan {
  estimate: Estimate;
  /**
   * The smallest worst case a resume has to fit under the run's cap to make
   * progress: the writer's ceiling when a chunk is still unwritten (the
   * writer runs first) plus the cheapest next attempt of an open slot (a
   * slot next on the Seedream fallback costs that; every attempt carries its
   * age check when the run has them). Null when nothing is left to send, or
   * when the first unwritten writer chunk has no attempts left (it cannot be
   * answered, whatever the cap): a resume then only closes slots and costs
   * nothing. (A blocked chunk after a writable one leaves the writable ones to
   * be paid for, and no image.) A run whose cap room is
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

  // The writer phase runs first, chunk by chunk in order, and the first chunk out of attempts ends it: no later chunk is
  // asked, no image is requested. So the chunks BEFORE the blocked one are still paid for (a crash left them writable).
  const writer = { ...WRITER_CALL, model: plan.models.text };
  // A run with no writer chunks (made from a scene set) never asks the text model: it needs no price for it.
  const writerCeiling = plan.writerChunks.length === 0 ? 0 : book.chatWorstCase({ model: writer.model, maxTokens: writer.maxTokens, inputTokens: writer.inputTokens, images: writer.images });
  let unwrittenSlots = 0;
  let writerPending = false;
  let writerBlocked = false;
  for (const chunk of plan.writerChunks) {
    if (state.writerDone.has(chunk.chunk)) continue;
    const answered = chunk.attemptIds.filter((id) => attemptPaid(ledger, id)).length;
    const unused = chunk.attemptIds.filter((id) => ledger.reserveOf(id) === undefined).length;
    const attempts = Math.min(Math.max(0, writer.maxAttempts - answered), unused);
    if (attempts <= 0) {
      writerBlocked = true;
      break;
    }
    worst += attempts * writerCeiling;
    writerPending = true;
    unwrittenSlots += chunk.slotIndexes.length;
  }

  for (const slot of writerBlocked ? [] : state.slots) {
    if (slot.end !== null || slot.fallbackUsed) continue; // a used fallback: the slot closes on resume without an attempt
    // Its paid attempts left (invariant 7), never more than its unused ids.
    const unused = slot.attemptIds.filter((id) => !slot.consumed.has(id)).length;
    const left = Math.min(RUN_ATTEMPTS_PER_SLOT - paidAttempts(slot, ledger), unused);
    if (left <= 0) continue;
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
  // When the FIRST unwritten chunk is out of writer attempts nothing is asked at all: a resume only closes the slots,
  // for free, so `worst` is 0 (the owner is not asked to accept the open slots' worst case, and no month budget can
  // refuse it). A blocked chunk further on leaves the chunks before it to be paid for, and no image after them.
  const worstMicros = Math.min(capRoom, worst);
  const needed = (writerPending ? writerCeiling : 0) + (cheapestSlotAttempt ?? 0);
  return {
    estimate: { expectedMicros: Math.min(expected, worstMicros), worstMicros, prices: book.source, pricesAsOf: priced.asOf },
    // A first chunk out of writer attempts can never be answered, so its slots are not held back by the cap: nothing the
    // cap could fund gets them going, and a resume can only close them (after a crash, say). Not «cap exhausted».
    minToProgressMicros: needed === 0 ? null : needed,
  };
}
