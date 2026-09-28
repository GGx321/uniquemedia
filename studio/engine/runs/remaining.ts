import type { Estimate } from "../../shared/engine";
import { scopeKey } from "../money/budget";
import { AGE_CHECK_CALL, WRITER_CALL, type ImageChoice } from "../money/estimate";
import type { Ledger, Scope } from "../money/ledger";
import type { PricedBook } from "../money/priceCache";
import type { PriceBook } from "../money/prices";
import { attemptPaid, paidAttempts, type LedgerView, type RunState } from "./journal";
import { RUN_ATTEMPTS_PER_SLOT, runRoute, type RunPlan } from "./plan";

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
   * age check when the run has them). Null when nothing is left to send: a
   * resume then only closes slots and costs nothing. A run whose cap room is
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
export function capFundsResume(plan: RunPlan, committedMicros: number, minToProgressMicros: number | null): boolean {
  return minToProgressMicros === null || plan.capMicros - committedMicros >= minToProgressMicros;
}

export function remainingPlan(priced: PricedBook, plan: RunPlan, state: RunState, committedMicros: number, ledger: LedgerView): RemainingPlan {
  const { book } = priced;
  const [primary, fallback] = runRoute(plan.models.image);
  const ageOn = plan.imageAgeCheck === "on";
  const ageWorst = ageOn ? book.chatWorstCase({ model: AGE_CHECK_CALL.model, maxTokens: AGE_CHECK_CALL.maxTokens, inputTokens: AGE_CHECK_CALL.inputTokens, images: AGE_CHECK_CALL.images }) : 0;
  const ageTypical = ageOn ? book.chatCost({ model: AGE_CHECK_CALL.model, images: AGE_CHECK_CALL.images, ...AGE_CHECK_CALL.typical }) : 0;
  const dearest = Math.max(imageWorst(book, primary), fallback === undefined ? 0 : imageWorst(book, fallback));

  let worst = 0;
  let expected = 0;
  let cheapestSlotAttempt: number | null = null;
  for (const slot of state.slots) {
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

  const writer = { ...WRITER_CALL, model: plan.models.text };
  const writerCeiling = book.chatWorstCase({ model: writer.model, maxTokens: writer.maxTokens, inputTokens: writer.inputTokens, images: writer.images });
  let unwrittenSlots = 0;
  let writerPending = false;
  for (const chunk of plan.writerChunks) {
    if (state.writerDone.has(chunk.chunk)) continue;
    const answered = chunk.attemptIds.filter((id) => attemptPaid(ledger, id)).length;
    const unused = chunk.attemptIds.filter((id) => ledger.reserveOf(id) === undefined).length;
    const attempts = Math.min(Math.max(0, writer.maxAttempts - answered), unused);
    worst += attempts * writerCeiling;
    if (attempts > 0) writerPending = true;
    unwrittenSlots += chunk.slotIndexes.length;
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
  const worstMicros = Math.min(capRoom, worst);
  const needed = (writerPending ? writerCeiling : 0) + (cheapestSlotAttempt ?? 0);
  return {
    estimate: { expectedMicros: Math.min(expected, worstMicros), worstMicros, prices: book.source, pricesAsOf: priced.asOf },
    minToProgressMicros: needed === 0 ? null : needed,
  };
}
