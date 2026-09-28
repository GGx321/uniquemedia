import { AGE_CHECK_MAX_SIDE, ageCheckMessages, ageJsonSchema, readAgeAnswer } from "../avatars/ageCheck";
import { AGE_CHECK_CALL } from "../money/estimate";
import { downscaleToJpeg } from "../../node/downscale";
import { MAX_ATTEMPT_MS } from "../openrouter/transport";
import { classifyFailure } from "./failures";
import { AGE_GATE_NAME, GateFailure, type QaGate, type QaInput, type QaVerdict } from "./qa";

// T7a: the paid image age gate — invariant 8's per-photo check for a run,
// wired only when the toggle is on (engine.ts's own filter on AGE_GATE_NAME,
// checked by #assertAgeGate before a run may even start). It reuses
// studio/engine/avatars/ageCheck.ts's question, JSON schema and
// `readAgeAnswer` verdict rules exactly as candidateJob.ts's own age check
// does — no second age-check implementation.
//
// T7a whole-slice review, architectural finding: this gate cannot hold an
// OpenRouter client of its own — it is wired into the engine once, before
// any run (and before the engine even has an API key) exists, and the key
// can rotate over the engine's whole life besides. `input.chat` is the RUN's
// own client instead (bound to the run's key, reporting to the run's
// network pool exactly like the run's own image attempts), and `beforeSend`
// is forwarded into its own paid call unchanged (T6 review L1): a request
// that would leave after the run has already stopped sending for some other
// reason must never go out.
//
// Verdicts: only doubt about THIS photo rejects — a refusal to judge it, an
// empty or unreadable answer, or a clear "no" from `readAgeAnswer`. Nothing
// here retries (invariant 8's own rule: any doubt rejects, never re-rolled).
// Everything else the request can fail with — a rate limit, a network
// error, a 5xx or a non-moderation 4xx, an invalid key, insufficient
// credits, its own reserve refused (the run's cap, the month, a halted
// ledger) — is classified exactly like an image attempt's own failure
// (runs/failures.ts's `classifyFailure`, reused as-is) and thrown as a
// `GateFailure`: every OTHER slot's paid image would face the exact same
// unresolved problem, so the run stops the way an image attempt's own
// failure already does (T6 H1) instead of quietly rejecting one paid photo
// at a time. `runJob.ts`'s own handling reads the classified code to decide
// whether this stops only the current slot (`BUDGET_EXCEEDED`,
// `RUN_CAP_EXCEEDED`) or the whole run — this gate does not need to know
// the difference, it only needs to preserve the real code (so `AUTH_INVALID`
// still marks the stored key rejected, and the UI still sees the real
// cause, never a bare INTERNAL).
//
// A bill above the reserved worst case keeps the verdict (the image is paid
// for and its answer stands, T6 M1) rather than throwing it away: the
// ledger itself is already halted (SETTLE_ABOVE_WORST) by the time this
// gate's own chat call returns, and `runJob.ts`'s `runGates` notices that
// through the Budget's own status right after this gate runs.
//
// Aborting is split by WHAT was in flight: an abort while preparing the
// image (a local ffmpeg downscale, no different from the pdq gate's own
// decode) propagates, so `runJob.ts`'s own wrapper decides whether that
// means dropped (the run's cancel) or broken (this gate's own outer
// timeout on what should be fast); an abort of the request itself — whether
// `input.signal` fired (a real cancel, or this gate's own timeout) or
// `beforeSend` refused because the run had already stopped sending for some
// other reason (T7a review, finding 3's own residual race, closed at
// `runJob.ts`'s `checkOne` level by re-checking `sending()` right after a
// network slot is granted) — also propagates rather than becoming a
// rejected verdict, so it is read the very same way.

export interface AgeGateDeps {
  /** Downscales the paid image to the JPEG the age check sends; defaults to studio/node/downscale.ts's real ffmpeg one. */
  downscale?: (bytes: Uint8Array, signal: AbortSignal) => Promise<Uint8Array>;
}

/**
 * A generous margin for the local ffmpeg downscale ahead of the request
 * itself — real downscales take tens of milliseconds; this only needs to
 * cover a slow but not hung machine.
 */
const DOWNSCALE_BUDGET_MS = 15_000;
/** A little slack past the client's own worst-case bound, so its own abort handling (above) gets the first word. */
const TIMEOUT_MARGIN_MS = 5_000;

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

export function createAgeGate(deps: AgeGateDeps = {}): QaGate {
  const downscale = deps.downscale ?? ((bytes, signal) => downscaleToJpeg(bytes, { maxSide: AGE_CHECK_MAX_SIDE, signal }));

  return {
    name: AGE_GATE_NAME,
    paid: true,
    // T7a review (finding 5): at least the client's own worst-case attempt bound (chat.ts's
    // transport retries included, MAX_ATTEMPT_MS ≈ 662 s) plus room for the downscale ahead of
    // it — the gate's own outer timeout (runJob.ts's checkOne) must never fire before a
    // legitimately slow but still-running request would have finished on its own. Only safe
    // together with finding 1's own fix: this timeout no longer starts until a network slot is
    // actually granted, so a long FIFO wait never eats into it.
    timeoutMs: MAX_ATTEMPT_MS + DOWNSCALE_BUDGET_MS + TIMEOUT_MARGIN_MS,
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

      const result = await input.chat({
        attemptId: ageGateAttemptId(input.attemptId),
        jobId: input.jobId,
        scope: input.scope,
        budget: input.budget,
        priceBook: input.priceBook,
        signal: input.signal,
        beforeSend: input.beforeSend,
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
          throw input.signal.aborted ? (input.signal.reason ?? new Error("the age check was aborted")) : new Error("the age check was not sent: the run had already stopped sending");
        case "refused":
          return { verdict: "reject", reason: `the age check refused to judge the image: ${result.message}` };
        case "blocked":
          throw new GateFailure(classifyFailure(result).error);
        case "error":
          if (result.kind === "EMPTY_CONTENT") return { verdict: "reject", reason: "the age check answered with no content" };
          throw new GateFailure(classifyFailure(result).error);
        case "ok": {
          const verdict = readAgeAnswer(result.content);
          return verdict.pass ? { verdict: "pass", qa: { age: { adult: true, confidence: verdict.confidence } } } : { verdict: "reject", reason: `the age check did not clearly pass (${verdict.why})` };
        }
      }
    },
  };
}
