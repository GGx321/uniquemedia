import { MOTION_ENGLISH, MOTION_TEXT_MAX, type ClipMotionSource, type EngineError, type MotionProblem } from "../../shared/engine";
import { phoneInHandOrPropped } from "../../shared/scenes/motionText";
import { toEngineError } from "../openrouter/engineError";
import type { ChatResult } from "../openrouter/types";
import type { FrameFacts } from "./frameFacts";
import { clipMotionProblems } from "./prompt";

// Stage 5, 5b.2, S5.WC3 (plan s5b2 §5.3, I5.66, I5.68): what the vision writer and the idea translator share: the frame's facts as the model sees them, the normalisation of a model's text before the
// one motion check, and how one chat result reads.

/** The longest bank activity the facts carry: the writer needs the gist, and a bounded message keeps the reserve (and so the price the owner accepts) bounded. */
export const ACTIVITY_MAX_CHARS = 160;

/** The facts of the frame as constraints for the model (data in the user message, never instructions). Nothing of the photo's prompt but the bank activity. */
export interface FramePayload {
  readonly capture: string;
  readonly plannedCapture: string;
  readonly faceVisible: "yes" | "no" | "maybe";
  readonly faceRole: string;
  readonly legsFraming: boolean;
  readonly level: string;
  readonly bold: boolean;
  readonly activity: string | null;
  readonly phoneAllowed: boolean;
}

export function framePayload(facts: FrameFacts): FramePayload {
  return {
    capture: facts.capture,
    plannedCapture: facts.plannedCapture,
    faceVisible: facts.face,
    faceRole: facts.faceRole,
    legsFraming: facts.legs,
    level: typeof facts.level === "string" ? facts.level : "bold",
    bold: facts.bold,
    activity: facts.activity === null ? null : facts.activity.slice(0, ACTIVITY_MAX_CHARS),
    // A phone only where the bank moment uses one and hers is not in her hand or propped (the one phone rule).
    phoneAllowed: facts.moment?.phone === true && !phoneInHandOrPropped(facts),
  };
}

/**
 * A model's text as the check reads it. Models write «she’s…» with a typographic apostrophe, begin with a capital and end with a period; those are fixed here, in the code path, and the check
 * itself is not weakened (the controller's decision, round 2).
 */
export function normalizeModelText(raw: string): string {
  return raw
    .replace(/[‘’]/g, "'")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\.+$/, "")
    .trim()
    .replace(/^(She|Her)(?=\s)/, (word) => word.toLowerCase());
}

/**
 * A model's text through the one check (`clipMotionProblems`: the motion check, then the prompt within 130 words in both dialects). `text` is the normalised text. A text the check accepts is also
 * the contract's English of at most 60 characters, so a stored item can never break the strict store: anything else is `not-motion`.
 */
export function checkModelText(facts: FrameFacts, raw: string, source: Extract<ClipMotionSource, "vision" | "own">): { text: string; problems: MotionProblem[] } {
  const text = normalizeModelText(raw);
  const problems = clipMotionProblems(facts, text, source);
  if (problems.length > 0) return { text, problems };
  if (text.length > MOTION_TEXT_MAX || !MOTION_ENGLISH.test(text)) return { text, problems: ["not-motion"] };
  return { text, problems };
}

/** One chat result as the part C jobs read it, with what the attempt cost (integer micro-dollars, 0 for a free one). */
export type ChatStep =
  | { kind: "answer"; content: string; costMicros: number }
  /** A paid answer that cannot be read. `final`: the body was not a chat answer at all, so a second try would not help. */
  | { kind: "unreadable"; costMicros: number; final?: true }
  /** A moderation refusal: free. */
  | { kind: "refused"; costMicros: number }
  /** The month or the call's cap had no room for the attempt: nothing was sent. */
  | { kind: "no-room"; costMicros: number }
  | { kind: "error"; error: EngineError; costMicros: number };

function settledCost(ledger: { action: string; costMicros?: number }): number {
  return ledger.action === "settled" ? (ledger.costMicros ?? 0) : 0;
}

export function stepOf(result: ChatResult): ChatStep {
  switch (result.status) {
    case "ok":
      return { kind: "answer", content: result.content, costMicros: result.costMicros };
    case "refused":
      return { kind: "refused", costMicros: settledCost(result.ledger) };
    case "blocked":
      if (result.refusal.reason === "BUDGET_EXCEEDED" || result.refusal.reason === "RUN_CAP_EXCEEDED") return { kind: "no-room", costMicros: 0 };
      return { kind: "error", error: toEngineError(result)?.error ?? { code: "INTERNAL", detail: "the request was not sent" }, costMicros: 0 };
    case "error":
      if (result.kind === "EMPTY_CONTENT") return { kind: "unreadable", costMicros: settledCost(result.ledger) };
      if (result.kind === "UNUSABLE_PAID_RESPONSE") return { kind: "unreadable", costMicros: settledCost(result.ledger), final: true };
      return { kind: "error", error: toEngineError(result)?.error ?? { code: "INTERNAL", detail: result.message }, costMicros: settledCost(result.ledger) };
    case "aborted":
      return { kind: "error", error: { code: "INTERNAL", detail: "the request was cancelled" }, costMicros: 0 };
  }
}

/** The call is one short request inside a user's command: it cannot be cancelled (as the descriptor check). */
export const NEVER_ABORTED: AbortSignal = new AbortController().signal;
