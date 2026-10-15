import { MOTION_MAX_ATTEMPTS, type Estimate } from "../../shared/engine";
import { chatAttemptWorstMicros } from "../openrouter/chat";
import type { ChatMessage } from "../openrouter/types";
import type { PricedBook, PriceModels } from "./priceCache";
import type { ChatCall } from "./estimate";

// Stage 5, 5b.2, S5.WC3 (plan s5b2 §5.3 «Money per call», I5.68 «The estimates live in engine/money/motionEstimate.ts; money/estimate.ts is unchanged»): the two estimates of part C, on the settings' text
// model. One attempt is priced exactly as the chat client reserves it (`chatAttemptWorstMicros`: the caller's ceilings, the prompt never below its byte floor), so a call's reserve can never exceed the
// price the owner accepted and the call's cap (its worst case) never refuses an attempt. The worst case is MOTION_MAX_ATTEMPTS attempts.
//
// The ceilings are the design figures of the plan (suggest ≈ $0.0034 expected and ≈ $0.0125 worst, translate ≈ $0.001 and ≈ $0.005 at grok-4.3's $1.25/M in and $2.50/M out): a prompt whose byte
// floor stays inside the input ceiling prices exactly at them; a bigger prompt raises the figure honestly, and the window shows what the engine's estimate says.

export interface MotionAttemptShape {
  /** The messages of the LARGEST attempt the call can send: the second attempt, with the longest feedback (and, for an idea, the longest text). */
  readonly messages: readonly ChatMessage[];
  readonly jsonSchema: { name: string; schema: Record<string, unknown> };
}

type AttemptCall = Omit<ChatCall, "model">;

/** One vision attempt: the photo (≤ 1024 px) and the frame's facts in; up to three motions, their labels and a frame reading out. */
export const SUGGEST_ATTEMPT: AttemptCall = { maxTokens: 1_000, inputTokens: 3_000, images: 1, typical: { inputTokens: 1_400, outputTokens: 660 } };

/** One translation attempt: the owner's idea and the facts in (no image); one short English clause out. */
export const TRANSLATE_ATTEMPT: AttemptCall = { maxTokens: 500, inputTokens: 1_000, images: 0, typical: { inputTokens: 400, outputTokens: 200 } };

/** The models a part C call prices: the settings' text model alone. */
export function motionPriceModels(textModel: string): PriceModels {
  return { imageModels: [], chatModels: [textModel] };
}

function estimateOf(priced: PricedBook, textModel: string, call: AttemptCall, shape: MotionAttemptShape): Estimate {
  const { book } = priced;
  const attempt = chatAttemptWorstMicros(book, { model: textModel, messages: shape.messages, jsonSchema: shape.jsonSchema, maxTokens: call.maxTokens, inputTokens: call.inputTokens, images: call.images });
  return {
    expectedMicros: book.chatCost({ model: textModel, images: call.images, ...call.typical }),
    worstMicros: MOTION_MAX_ATTEMPTS * attempt,
    prices: book.source,
    pricesAsOf: priced.asOf,
  };
}

/** `clips.estimateSuggest`: the vision writer, up to two attempts. */
export function suggestEstimate(priced: PricedBook, textModel: string, shape: MotionAttemptShape): Estimate {
  return estimateOf(priced, textModel, SUGGEST_ATTEMPT, shape);
}

/** `clips.estimateIdea`: the translator, up to two attempts. */
export function translateEstimate(priced: PricedBook, textModel: string, shape: MotionAttemptShape): Estimate {
  return estimateOf(priced, textModel, TRANSLATE_ATTEMPT, shape);
}
