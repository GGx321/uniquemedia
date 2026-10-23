import { MOTION_MAX_ATTEMPTS, type Estimate } from "../../shared/engine";
import { motionEstimate, SUGGEST_ATTEMPT, TRANSLATE_ATTEMPT, type AttemptCall } from "../money/motionEstimate";
import type { PricedBook } from "../money/priceCache";
import { chatAttemptWorstMicros } from "../openrouter/chat";
import { translatorPriceShape } from "./ideaTranslator";
import type { MotionAttemptShape } from "./motionCall";
import { writerPriceShape } from "./motionWriter";

// Stage 5, 5b.2, S5.WC3 (plan s5b2 I5.68): the price of the two part C calls. One attempt is what the chat client reserves for the LARGEST message the call can send (`writerPriceShape`,
// `translatorPriceShape`): the caller's ceilings, the prompt never below its byte floor. Two attempts at most (`MOTION_MAX_ATTEMPTS`).

function priceOf(priced: PricedBook, textModel: string, call: AttemptCall, shape: MotionAttemptShape): Estimate {
  const attempt = chatAttemptWorstMicros(priced.book, {
    model: textModel,
    messages: shape.messages,
    jsonSchema: shape.jsonSchema,
    maxTokens: call.maxTokens,
    reasoningTokens: call.reasoningTokens,
    inputTokens: call.inputTokens,
    images: call.images,
  });
  return motionEstimate(priced, textModel, call, attempt, MOTION_MAX_ATTEMPTS);
}

/** `clips.estimateSuggest` and the cap of `clips.suggestMotions`. */
export function suggestPrice(priced: PricedBook, textModel: string, shape: MotionAttemptShape = writerPriceShape()): Estimate {
  return priceOf(priced, textModel, SUGGEST_ATTEMPT, shape);
}

/** `clips.estimateIdea` and the cap of `clips.translateIdea`. */
export function translatePrice(priced: PricedBook, textModel: string, shape: MotionAttemptShape = translatorPriceShape()): Estimate {
  return priceOf(priced, textModel, TRANSLATE_ATTEMPT, shape);
}
