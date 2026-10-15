import { z } from "zod";
import { CLIP_CHOICES_MAX, MOTION_LABEL_MAX, MOTION_MAX_ATTEMPTS, MOTION_PROBLEMS, ownIdeaLabel, type ClipFrameNote, type ClipFrameReading, type EngineError, type MotionProblem } from "../../shared/engine";
import { repairMayHelp } from "../../shared/scenes/motionText";
import { SUGGEST_ATTEMPT, type MotionAttemptShape } from "../money/motionEstimate";
import type { Budget } from "../money/budget";
import type { Scope } from "../money/ledger";
import type { PriceBook } from "../money/prices";
import type { ChatMessage, ChatParams, ChatResult } from "../openrouter/types";
import type { FrameFacts } from "./frameFacts";
import { ACTIVITY_MAX_CHARS, NEVER_ABORTED, checkModelText, framePayload, stepOf, type FramePayload } from "./motionCall";
import { MOTION_PROMPT_TEXTS } from "./motionPrompts";
import { CLIP_CAPTURES } from "./videoLook";

// Stage 5, 5b.2, S5.WC3 (plan s5b2 §5.3 «The vision writer», I5.66, I5.68): the vision motion writer. It looks at ONE photo (at most 1024 px, never the master) with the frame's facts as constraints and
// suggests up to three small motions. Every text goes through the one motion check and `clipPromptOf` in both dialects (`checkModelText`); a failing text is dropped and logged by its place and its closed
// problems, never its words. When every text failed, or the answer was unreadable, a second attempt is asked with the closed problem codes (never the texts). Two attempts at most
// (`MOTION_MAX_ATTEMPTS`), ids `<jobId>:motion#N`, each reserved before it is sent and settled by the chat client's settle rule.
//
// The wiring only: the system prompt is `MOTION_PROMPT_TEXTS.writerSystem` (S5.WCX writes it).

export interface MotionJobDeps {
  /** The OpenRouter client's chat: reserve on disk, send, settle. */
  chat: (params: ChatParams) => Promise<ChatResult>;
  budget: Budget;
  /** The prices the call was accepted at; each attempt's reserve is its worst case at these prices. */
  priceBook: PriceBook;
  log: (line: string) => void;
}

export interface WriterJob {
  jobId: string;
  /** The call's cap scope; the budget holds its cap. */
  scope: Scope;
  /** The settings' text model. */
  textModel: string;
  photoId: string;
  /** The photo as a JPEG of at most 1024 px on its long side, never the master's bytes. */
  image: Uint8Array;
  facts: FrameFacts;
}

export interface SuggestedDraft {
  readonly label: string;
  readonly text: string;
}

/**
 * - ok: one to three checked drafts (not yet in the store) and the frame reading.
 * - none: nothing usable. `costMicros` is what the attempts cost (0 = the model refused the frame, free).
 * - error: a failure that is not the model's (a key, a network, the ledger); `costMicros` is what was paid before it.
 */
export type WriterOutcome =
  | { kind: "ok"; drafts: SuggestedDraft[]; reading: ClipFrameReading; costMicros: number }
  | { kind: "none"; costMicros: number }
  | { kind: "error"; error: EngineError; costMicros: number };

/** What the next attempt is told: the closed codes of what was wrong with the last answer (`unreadable` for one that could not be read). Never a text. */
type WriterFeedback = readonly (MotionProblem | "unreadable")[];

const CAPTURE_NAMES: readonly string[] = CLIP_CAPTURES;

export const WRITER_JSON_SCHEMA: { name: string; schema: Record<string, unknown> } = {
  name: "motion_suggestions",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["motions", "frame"],
    properties: {
      motions: {
        type: "array",
        items: {
          type: "object",
          additionalProperties: false,
          required: ["label_ru", "text_en"],
          properties: { label_ru: { type: "string" }, text_en: { type: "string" } },
        },
      },
      frame: {
        type: "object",
        additionalProperties: false,
        required: ["capture", "phoneVisible", "faceVisible"],
        properties: { capture: { type: "string", enum: [...CAPTURE_NAMES] }, phoneVisible: { type: "boolean" }, faceVisible: { type: "boolean" } },
      },
    },
  },
};

const WriterAnswer = z.strictObject({
  motions: z.array(z.strictObject({ label_ru: z.string(), text_en: z.string() })).max(CLIP_CHOICES_MAX.vision),
  frame: z.strictObject({
    capture: z.string().refine((name) => CAPTURE_NAMES.includes(name), "must be a capture name"),
    phoneVisible: z.boolean(),
    faceVisible: z.boolean(),
  }),
});
type WriterAnswer = z.infer<typeof WriterAnswer>;

function readAnswer(content: string): WriterAnswer | null {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return null;
  }
  const parsed = WriterAnswer.safeParse(json);
  return parsed.success && parsed.data.motions.length > 0 ? parsed.data : null;
}

function messagesOf(frame: FramePayload, feedback: WriterFeedback): ChatMessage[] {
  const data = { frame, ...(feedback.length === 0 ? {} : { problems: feedback }) };
  return [
    { role: "system", content: MOTION_PROMPT_TEXTS.writerSystem },
    { role: "user", content: JSON.stringify(data) },
  ];
}

/** The largest attempt the writer can send, for the estimate: the longest facts and the longest feedback (every closed code), so the price the owner accepts never undercuts a reserve. */
export function writerPriceShape(): MotionAttemptShape {
  const widest: FramePayload = {
    capture: "mirror-hidden",
    plannedCapture: "mirror-hidden",
    faceVisible: "maybe",
    faceRole: "profile",
    legsFraming: false,
    level: "ordinary",
    bold: false,
    activity: "a".repeat(ACTIVITY_MAX_CHARS),
    phoneAllowed: false,
  };
  return { messages: messagesOf(widest, [...MOTION_PROBLEMS, "unreadable"]), jsonSchema: WRITER_JSON_SCHEMA };
}

/** The Russian label as it is stored: cleaned of control and format characters, cut by word to 40 characters; null when nothing is left. */
function cleanLabel(raw: string): string | null {
  const flat = raw.replace(/[\p{Cc}\p{Cf}\p{Cs}\p{Zl}\p{Zp}]/gu, "").replace(/\s+/g, " ").trim();
  if (flat === "") return null;
  const label = ownIdeaLabel(flat);
  return label.length <= MOTION_LABEL_MAX ? label : null;
}

/** The marks the frame reading may carry: marks only, never a refusal, a price or a camera line (I5.68). */
function readingOf(facts: FrameFacts, frame: WriterAnswer["frame"]): ClipFrameReading {
  const notes: ClipFrameNote[] = [];
  const planned = facts.plannedCapture;
  if (planned !== "unknown" && frame.capture !== "unknown" && frame.capture !== planned) notes.push("capture-differs");
  // A phone in view is hers in a mirror selfie; anywhere else it is a second one that may stay in the clip.
  if (frame.phoneVisible && planned !== "mirror" && planned !== "mirror-hidden") notes.push("second-phone");
  return { notes };
}

interface Evaluated {
  readonly drafts: SuggestedDraft[];
  /** The codes to feed back when no draft is left and a repair may help; empty when nothing can help. */
  readonly repair: WriterFeedback | null;
}

function evaluate(answer: WriterAnswer, job: WriterJob, log: (line: string) => void): Evaluated {
  const drafts: SuggestedDraft[] = [];
  const repairable = new Set<MotionProblem>();
  const seen = new Set<string>();
  let mayHelp = false;
  for (const [i, motion] of answer.motions.entries()) {
    const label = cleanLabel(motion.label_ru);
    const { text, problems } = checkModelText(job.facts, motion.text_en, "vision");
    if (problems.length > 0) {
      log(`[clip] photo ${job.photoId}: suggestion ${i + 1} of ${answer.motions.length} dropped (${problems.join(", ")})`);
      if (repairMayHelp(problems)) {
        mayHelp = true;
        for (const problem of problems) repairable.add(problem);
      }
      continue;
    }
    if (label === null) {
      log(`[clip] photo ${job.photoId}: suggestion ${i + 1} of ${answer.motions.length} dropped (no label)`);
      continue;
    }
    if (seen.has(text)) continue;
    seen.add(text);
    drafts.push({ label, text });
  }
  const codes: WriterFeedback = MOTION_PROBLEMS.filter((problem) => repairable.has(problem));
  return { drafts, repair: mayHelp ? codes : null };
}

/**
 * Asks the settings' text model to look at the photo and suggest motions. Never throws for a model's behaviour; a failure that is not the model's comes back as `error` with what was paid before it.
 * The photo is attached again on every attempt.
 */
export async function runMotionWriter(deps: MotionJobDeps, job: WriterJob): Promise<WriterOutcome> {
  const frame = framePayload(job.facts);
  let feedback: WriterFeedback = [];
  let cost = 0;
  for (let attempt = 1; attempt <= MOTION_MAX_ATTEMPTS; attempt++) {
    const step = stepOf(
      await deps.chat({
        attemptId: `${job.jobId}:motion#${attempt}`,
        jobId: job.jobId,
        scope: job.scope,
        model: job.textModel,
        budget: deps.budget,
        priceBook: deps.priceBook,
        signal: NEVER_ABORTED,
        messages: messagesOf(frame, feedback),
        jsonSchema: WRITER_JSON_SCHEMA,
        maxTokens: SUGGEST_ATTEMPT.maxTokens,
        inputTokens: SUGGEST_ATTEMPT.inputTokens,
        images: [job.image],
        reasoningEffort: "low",
      }),
    );
    cost += step.costMicros;
    if (step.kind === "refused") return { kind: "none", costMicros: cost };
    if (step.kind === "no-room") {
      return attempt === 1 ? { kind: "error", error: { code: "BUDGET_EXCEEDED", detail: "the month has no room for the motion writer's call" }, costMicros: cost } : { kind: "none", costMicros: cost };
    }
    if (step.kind === "error") return { kind: "error", error: step.error, costMicros: cost };
    if (step.kind === "unreadable") {
      if (step.final === true) return { kind: "none", costMicros: cost };
      feedback = ["unreadable"];
      continue;
    }
    const answer = readAnswer(step.content);
    if (answer === null) {
      feedback = ["unreadable"];
      continue;
    }
    const { drafts, repair } = evaluate(answer, job, deps.log);
    if (drafts.length > 0) return { kind: "ok", drafts, reading: readingOf(job.facts, answer.frame), costMicros: cost };
    if (repair === null) return { kind: "none", costMicros: cost };
    feedback = repair.length === 0 ? ["unreadable"] : repair;
  }
  return { kind: "none", costMicros: cost };
}
