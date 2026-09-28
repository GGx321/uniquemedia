import { AGE_CHECK_MAX_SIDE, ageCheckMessages, ageJsonSchema, readAgeAnswer } from "../avatars/ageCheck";
import { AGE_CHECK_CALL } from "../money/estimate";
import { REQUEST_TIMEOUT_MS } from "../money/budget";
import { downscaleToJpeg } from "../../node/downscale";
import type { OpenRouterClient } from "../openrouter/types";
import type { QaGate, QaInput, QaVerdict } from "./qa";

// T7a: the paid image age gate — invariant 8's per-photo check for a run,
// wired only when the toggle is on (runJob.ts's `runGates` is asked for by
// `#assertAgeGate`/engine.ts's own filter on AGE_GATE_NAME). It reuses
// studio/engine/avatars/ageCheck.ts's question, JSON schema and
// `readAgeAnswer` verdict rules exactly as candidateJob.ts's own age check
// does — no second age-check implementation.
//
// Money: `deps.chat` is the run's own OpenRouterClient.chat, already bound
// to the run's key; calling it with `attemptId: ${input.attemptId}:age`,
// `input.scope`, `input.budget` and `input.priceBook` reserves, sends and
// settles or releases exactly like any other paid call (chat.ts's own
// runPaidAttempt) — this gate never touches the ledger directly.
//
// Any doubt rejects, never retries (invariant 8's own rule, echoed by
// ageCheck.ts): a moderation refusal, an empty answer, a low-confidence or
// doubtful "yes", a not-adult, a rate limit, a network error, an above-cap
// reserve refusal — none of these says anything reassuring about the photo,
// so all of them reject rather than spend a second attempt on a fresh image
// that would face the very same uncertainty. Only a request that could not
// even be judged because the CHECK ITSELF cannot run at all — an invalid key,
// insufficient credits, a bill above the reserved worst case (the price table
// is wrong), or a reserve refused because the ledger itself is halted — is
// systemic: every later attempt would fail identically, so those throw
// instead (qa.ts's own contract: "a gate throws only when it cannot run at
// all"), stopping the run rather than quietly burning the rest of its image
// budget on photos that could never pass.
//
// Aborting is split by WHAT was in flight, matching the two different test
// scenarios this task asks for: an abort while preparing the image (a local
// ffmpeg downscale, no different from the pdq gate's own decode) propagates,
// so runJob.ts's own wrapper decides whether that means dropped (the run's
// cancel) or broken (this gate's own outer timeout on what should be fast);
// an abort mid-request (the task's own explicit instruction: "settle
// promptly on signal abort: abort its own request and reject") rejects
// outright instead — `deps.chat` already aborts its own HTTP call when
// `input.signal` fires, this gate just reads that `aborted` result as doubt.

export const AGE_GATE_NAME = "age";

export interface AgeGateDeps {
  /** The run's own OpenRouterClient.chat, bound to the run's key (engine.ts's own #runPhotos client). */
  chat: OpenRouterClient["chat"];
  /** Downscales the paid image to the JPEG the age check sends; defaults to studio/node/downscale.ts's real ffmpeg one. */
  downscale?: (bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
}

/** The age check's own attempt id, derived from the image attempt's — never sent on its own. */
export function ageGateAttemptId(attemptId: string): string {
  return `${attemptId}:age`;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A spawn failure (the ffmpeg binary itself missing or not executable): systemic, every later image's downscale would fail identically. */
function isSpawnFailure(error: unknown): boolean {
  return error instanceof Error && "code" in error && (error.code === "ENOENT" || error.code === "EACCES");
}

export function createAgeGate(deps: AgeGateDeps): QaGate {
  const downscale = deps.downscale ?? ((bytes, signal) => downscaleToJpeg(bytes, { maxSide: AGE_CHECK_MAX_SIDE, signal }));

  return {
    name: AGE_GATE_NAME,
    paid: true,
    // At least the client's own request bound (chat.ts's transport retries
    // included, MAX_ATTEMPT_MS): the gate's own outer timeout (runJob.ts's
    // checkOne) must never fire before a legitimately slow but still-running
    // request would have finished on its own. A little slack past that bound
    // so the client's own abort handling (above) gets the first word.
    timeoutMs: REQUEST_TIMEOUT_MS + 5_000,
    async check(input: QaInput): Promise<QaVerdict> {
      let jpeg: Uint8Array;
      try {
        jpeg = await downscale(input.image.bytes, input.signal);
      } catch (error) {
        if (input.signal.aborted) throw error;
        if (isSpawnFailure(error)) {
          throw new Error(`the age gate could not run: ffmpeg is missing or not executable (${messageOf(error)})`);
        }
        return { verdict: "reject", reason: `the image could not be prepared for the age check: ${messageOf(error)}` };
      }

      const result = await deps.chat({
        attemptId: ageGateAttemptId(input.attemptId),
        jobId: input.jobId,
        scope: input.scope,
        budget: input.budget,
        priceBook: input.priceBook,
        signal: input.signal,
        model: AGE_CHECK_CALL.model,
        messages: ageCheckMessages(),
        jsonSchema: ageJsonSchema(),
        maxTokens: AGE_CHECK_CALL.maxTokens,
        inputTokens: AGE_CHECK_CALL.inputTokens,
        images: [jpeg],
        reasoningEffort: "low",
      });

      switch (result.status) {
        case "aborted":
          return { verdict: "reject", reason: "the age check was aborted before it answered" };
        case "refused":
          return { verdict: "reject", reason: `the age check refused to judge the image: ${result.message}` };
        case "blocked":
          if (result.refusal.reason === "BUDGET_EXCEEDED" || result.refusal.reason === "RUN_CAP_EXCEEDED") {
            return { verdict: "reject", reason: `the age check could not be reserved: ${result.refusal.reason}` };
          }
          throw new Error(`the age gate could not run: its own reserve was refused (${result.refusal.reason})`);
        case "error":
          switch (result.kind) {
            case "EMPTY_CONTENT":
              return { verdict: "reject", reason: "the age check answered with no content" };
            case "AUTH_INVALID":
            case "INSUFFICIENT_CREDITS":
              throw new Error(`the age gate could not run: ${result.kind} (${result.message})`);
            default:
              return { verdict: "reject", reason: `the age check failed (${result.kind}): ${result.message}` };
          }
        case "ok":
          if (result.aboveWorst) {
            throw new Error(`the age gate could not run: billed ${result.costMicros} µ$, above its reserved worst case; the price table is wrong`);
          }
          {
            const verdict = readAgeAnswer(result.content);
            return verdict.pass ? { verdict: "pass", qa: { age: { adult: true, confidence: verdict.confidence } } } : { verdict: "reject", reason: `the age check did not clearly pass (${verdict.why})` };
          }
      }
    },
  };
}
