import type { Estimate } from "../../shared/engine/estimate";
import type { ChatCall } from "./estimate";
import type { PricedBook, PriceModels } from "./priceCache";

// Stage 5, 5b.2, S5.WC3 (plan s5b2 §5.3 «Money per call», I5.68 «The estimates live in engine/money/motionEstimate.ts; money/estimate.ts is unchanged»): the two estimates of part C, on the settings' text
// model. Money code imports only siblings and the pure shared modules (money/runtime.test.ts), so the one attempt's worst case, which needs the chat client's message floor
// (`chatAttemptWorstMicros`), is handed in by `clips/motionPrice.ts`, the only caller: an attempt is priced exactly as the client reserves it, so a call's reserve can never exceed the price the owner
// accepted and the call's cap (its worst case) never refuses an attempt. The worst case is `attempts` of them.
//
// The ceilings began as the design figures of the plan (suggest ≈ $0.0034 expected and ≈ $0.0125 worst, translate ≈ $0.001 and ≈ $0.005 at grok-4.3's $1.25/M in and $2.50/M out): a prompt whose
// byte floor stays inside the input ceiling prices exactly at them; a bigger prompt raises the figure honestly.
//
// S5.WCX (the reasoning overrun, P-M and P-R): on grok-4.3 `max_tokens` bounds the visible answer only; the reasoning comes on top and is billed as completion. P-M's translations reasoned 392-1 417
// tokens on a 500-token answer ceiling and two of them billed above their reserve, which stops the ledger. Each attempt therefore reserves a reasoning allowance of 3 000 tokens, priced as completion
// on top of `max_tokens` (never sent): the widest of the 48 recorded attempts on an effort the engine sends reasoned 1 417 tokens. The halt on a bill above the reserve stays as it is.

export type AttemptCall = Omit<ChatCall, "model"> & {
  /** The reasoning allowance (openrouter/chat.ts `ChatPriceShape.reasoningTokens`): priced as completion on top of `maxTokens`, never sent. */
  readonly reasoningTokens: number;
};

/** One vision attempt: the photo (≤ 1024 px) and the frame's facts in; up to three motions, their labels and a frame reading out. */
export const SUGGEST_ATTEMPT: AttemptCall = { maxTokens: 1_000, reasoningTokens: 3_000, inputTokens: 3_000, images: 1, typical: { inputTokens: 1_400, outputTokens: 660 } };

/** One translation attempt: the owner's idea and the facts in (no image); one short English clause out. */
export const TRANSLATE_ATTEMPT: AttemptCall = { maxTokens: 500, reasoningTokens: 3_000, inputTokens: 1_000, images: 0, typical: { inputTokens: 400, outputTokens: 200 } };

/** The models a part C call prices: the settings' text model alone. */
export function motionPriceModels(textModel: string): PriceModels {
  return { imageModels: [], chatModels: [textModel] };
}

/** The estimate of a call of `attempts` attempts, each reserved at `attemptWorstMicros`; the expected figure is one attempt at its typical tokens. */
export function motionEstimate(priced: PricedBook, textModel: string, call: AttemptCall, attemptWorstMicros: number, attempts: number): Estimate {
  const { book } = priced;
  return {
    expectedMicros: book.chatCost({ model: textModel, images: call.images, ...call.typical }),
    worstMicros: attempts * attemptWorstMicros,
    prices: book.source,
    pricesAsOf: priced.asOf,
  };
}
