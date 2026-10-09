import { MAX_SCENES_PER_WRITE, type Estimate } from "../../shared/engine";
import type { StoredSceneSet } from "../library/sceneSets";
import { WRITER_CALL, writerWorstMicros, type WriterCall } from "../money/estimate";
import type { PricedBook, PriceModels } from "../money/priceCache";
import type { PriceBook } from "../money/prices";
import type { LedgerView } from "../runs/journal";
import { pendingChunks } from "./chunks";

// CS.4a: what a compose and a «Дописать» could cost, in one place: the estimate commands show it, the paid commands compare the owner's accepted
// worst case with it and cap the job at that, and the job sends exactly these calls (the scene writer's own call shape, money/estimate.ts's WRITER_CALL),
// so no reserve exceeds what the owner was shown.

/** The models a scene set's calls price: the settings' text model alone. */
export function sceneSetPriceModels(textModel: string): PriceModels {
  return { imageModels: [], chatModels: [textModel] };
}

/** The writer's call on the settings' text model, with the one source of truth's limits (money/estimate.ts). */
function writerCall(textModel: string): WriterCall {
  return { ...WRITER_CALL, model: textModel };
}

function ceilingOf(book: PriceBook, call: WriterCall): number {
  return book.chatWorstCase({ model: call.model, maxTokens: call.maxTokens, inputTokens: call.inputTokens, images: call.images });
}

/** One writer attempt at its ceiling on the settings' text model (the figure `composeEstimate` multiplies by the attempts per chunk and the chunks). */
export function writerCeilingMicros(priced: PricedBook, textModel: string): number {
  return ceilingOf(priced.book, writerCall(textModel));
}

function typicalOf(book: PriceBook, call: WriterCall, scenes: number): number {
  return book.chatCost({
    model: call.model,
    images: call.images,
    inputTokens: call.typicalPerScene.inputTokens * scenes,
    outputTokens: call.typicalPerScene.outputTokens * scenes,
  });
}

/**
 * Composing `count` scenes: the writer's worst case for them (`writerWorstMicros`: chunks of 25, each retried up to twice at the ceiling, the very
 * figure a run's estimate carries for its writer), expected at the writer's typical tokens. An empty set (0) costs nothing and prices nothing.
 */
export function composeEstimate(priced: PricedBook, textModel: string, count: number): Estimate {
  if (count === 0) return { expectedMicros: 0, worstMicros: 0, prices: priced.book.source, pricesAsOf: priced.asOf };
  const call = writerCall(textModel);
  const worstMicros = writerWorstMicros(priced.book, call, count);
  return { expectedMicros: Math.min(typicalOf(priced.book, call, count), worstMicros), worstMicros, prices: priced.book.source, pricesAsOf: priced.asOf };
}

/**
 * A rewrite or an idea write (CS.4b): ONE writer request for one to five scenes, asked at most `attemptsLeft` times (2 for a fresh write; after an open or
 * reconciled reserve one, after a free 429/5xx two again), each at the writer's ceiling, so the worst case is exactly what the job's cap is set to. Expected
 * at the writer's typical tokens for the scenes. A write with none left costs nothing.
 */
export function reviewWriteEstimate(priced: PricedBook, textModel: string, scenes: number, attemptsLeft: number): Estimate {
  if (!Number.isInteger(scenes) || scenes < 1 || scenes > MAX_SCENES_PER_WRITE) throw new RangeError(`a write covers 1..${MAX_SCENES_PER_WRITE} scenes, got ${scenes}`);
  if (!Number.isInteger(attemptsLeft) || attemptsLeft < 0 || attemptsLeft > WRITER_CALL.maxAttempts) throw new RangeError(`a write has 0..${WRITER_CALL.maxAttempts} attempts left, got ${attemptsLeft}`);
  if (attemptsLeft === 0) return { expectedMicros: 0, worstMicros: 0, prices: priced.book.source, pricesAsOf: priced.asOf };
  const call = writerCall(textModel);
  const worstMicros = attemptsLeft * ceilingOf(priced.book, call);
  return { expectedMicros: Math.min(typicalOf(priced.book, call, scenes), worstMicros), worstMicros, prices: priced.book.source, pricesAsOf: priced.asOf };
}

/**
 * «Дописать»: the chunks still to write, each at `min(2 − answered, unused ids) × the ceiling` (the same arithmetic as a run's `remainingPlan`):
 * an open or reconciled reserve is an answered attempt, so an interrupted chunk is priced at one attempt, never a fresh pair. Chunks out of attempts,
 * given up, or with nothing left to ask (every scene removed or typed) cost nothing.
 */
export function writeEstimate(priced: PricedBook, set: StoredSceneSet, ledger: LedgerView | null): Estimate {
  const call = writerCall(set.models.text);
  const ceiling = ceilingOf(priced.book, call);
  let worstMicros = 0;
  let scenes = 0;
  for (const pending of pendingChunks(set, ledger)) {
    worstMicros += pending.state.attemptsLeft * ceiling;
    scenes += pending.sceneIds.length;
  }
  const expectedMicros = scenes === 0 ? 0 : Math.min(typicalOf(priced.book, call, scenes), worstMicros);
  return { expectedMicros, worstMicros, prices: priced.book.source, pricesAsOf: priced.asOf };
}
