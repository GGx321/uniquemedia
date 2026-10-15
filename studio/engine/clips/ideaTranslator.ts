import { z } from "zod";
import { MOTION_MAX_ATTEMPTS, MOTION_PROBLEMS, OWN_IDEA_MAX, type EngineError, type MotionProblem } from "../../shared/engine";
import { repairMayHelp } from "../../shared/scenes/motionText";
import { TRANSLATE_ATTEMPT } from "../money/motionEstimate";
import type { Scope } from "../money/ledger";
import type { ChatMessage } from "../openrouter/types";
import type { FrameFacts } from "./frameFacts";
import { ACTIVITY_MAX_CHARS, NEVER_ABORTED, type MotionAttemptShape, checkModelText, framePayload, stepOf, type FramePayload } from "./motionCall";
import { MOTION_PROMPT_TEXTS } from "./motionPrompts";
import type { MotionJobDeps } from "./motionWriter";

// Stage 5, 5b.2, S5.WC3 (plan s5b2 §5.3 «The translator», I5.67, I5.68): «Своя идея». The owner's idea (1-300 characters) becomes one English motion of at most 60 characters, or is refused with closed
// `MotionProblem`s. The idea is JSON DATA in the user message and exists nowhere else: not in the system prompt, not in a log line, not in the saved raw body of an unusable answer (the call's own
// `scrubRaw`), not in the store (the engine keeps its label and the English text only). The translator sees no image. One repair at most: a second attempt with the closed codes and the previous English
// text (never a free-text reason); `takes-off` gets none (`repairMayHelp`). Two attempts at most (`MOTION_MAX_ATTEMPTS`), ids `<jobId>:idea#N`.
//
// The wiring only: the system prompt is `MOTION_PROMPT_TEXTS.translatorSystem` (S5.WCX writes it).

export interface TranslatorJob {
  jobId: string;
  /** The call's cap scope; the budget holds its cap. */
  scope: Scope;
  /** The settings' text model. */
  textModel: string;
  photoId: string;
  /** The owner's idea, validated by the contract (`OwnIdeaText`). It lives only in this call's memory and its chat request. */
  idea: string;
  facts: FrameFacts;
}

/**
 * - ok: the checked English text (accepted on this frame).
 * - rejected: the answer failed the checks after at most one repair (or at once when a repair cannot help); `problems` is non-empty, unique and in display order.
 * - none: no usable answer (unreadable twice, or refused by the model). `costMicros` 0 = free.
 * - error: a failure that is not the model's; `costMicros` is what was paid before it.
 */
export type TranslatorOutcome =
  | { kind: "ok"; text: string; costMicros: number }
  | { kind: "rejected"; problems: MotionProblem[]; costMicros: number }
  | { kind: "none"; costMicros: number }
  | { kind: "error"; error: EngineError; costMicros: number };

export const TRANSLATOR_JSON_SCHEMA: { name: string; schema: Record<string, unknown> } = {
  name: "motion_idea",
  schema: { type: "object", additionalProperties: false, required: ["text_en"], properties: { text_en: { type: "string" } } },
};

const TranslatorAnswer = z.strictObject({ text_en: z.string() });

/** How much of the model's own last English text is fed back to it: enough to see what to fix, never a long text. */
const PREVIOUS_MAX_CHARS = 80;

type TranslatorFeedback = readonly (MotionProblem | "unreadable")[];

function readAnswer(content: string): string | null {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return null;
  }
  const parsed = TranslatorAnswer.safeParse(json);
  return parsed.success ? parsed.data.text_en : null;
}

function messagesOf(idea: string, frame: FramePayload, feedback: TranslatorFeedback, previous: string | null): ChatMessage[] {
  // The idea is a value inside JSON: whatever it holds (quotes, braces, newlines, a command) stays one string of data.
  const data = { idea, frame, ...(feedback.length === 0 ? {} : { problems: feedback }), ...(previous === null ? {} : { previous }) };
  return [
    { role: "system", content: MOTION_PROMPT_TEXTS.translatorSystem },
    { role: "user", content: JSON.stringify(data) },
  ];
}

/** The widest attempt the translator can send, for the estimate: an idea of 300 three-byte characters (the contract's maximum, at the most bytes), every closed code, the longest previous text. */
export function translatorPriceShape(): MotionAttemptShape {
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
  return { messages: messagesOf("一".repeat(OWN_IDEA_MAX), widest, [...MOTION_PROBLEMS, "unreadable"], "a".repeat(PREVIOUS_MAX_CHARS)), jsonSchema: TRANSLATOR_JSON_SCHEMA };
}

/** `\uXXXX` for every non-ASCII code unit. */
function asciiEscaped(text: string, upper: boolean): string {
  return text.replace(/[^\x20-\x7e]/g, (c) => {
    const hex = c.charCodeAt(0).toString(16).padStart(4, "0");
    return `\\u${upper ? hex.toUpperCase() : hex}`;
  });
}

/**
 * The scrub of a saved raw body (I5.67, r2.1 N4): every form in which a model's answer may echo the idea (plain, JSON-escaped, `\u`-escaped in either case, and each of them escaped once more, as a
 * JSON answer sits inside a JSON body) is replaced by `[owner idea omitted: N chars]`, longest form first. The chat client runs the image-data scrub before it.
 */
export function ideaScrub(idea: string): (text: string) => string {
  const jsonOf = (text: string): string => JSON.stringify(text).slice(1, -1);
  const once = jsonOf(idea);
  const forms = new Set<string>();
  for (const base of [idea, once, asciiEscaped(once, false), asciiEscaped(once, true)]) {
    forms.add(base);
    forms.add(jsonOf(base));
  }
  const ordered = [...forms].filter((form) => form !== "").sort((a, b) => b.length - a.length);
  const marker = `[owner idea omitted: ${idea.length} chars]`;
  return (text) => ordered.reduce((scrubbed, form) => scrubbed.split(form).join(marker), text);
}

/** Asks the settings' text model to say the owner's idea as one small English motion. */
export async function runIdeaTranslator(deps: MotionJobDeps, job: TranslatorJob): Promise<TranslatorOutcome> {
  const frame = framePayload(job.facts);
  const scrubRaw = ideaScrub(job.idea);
  let feedback: TranslatorFeedback = [];
  let previous: string | null = null;
  /** The closed problems of the last answer that could be read and checked. */
  let lastProblems: MotionProblem[] | null = null;
  let cost = 0;
  /** What the call ends with when it cannot go on: the last answer's problems if there were any, else nothing usable. */
  const settled = (): TranslatorOutcome => (lastProblems === null ? { kind: "none", costMicros: cost } : { kind: "rejected", problems: lastProblems, costMicros: cost });
  for (let attempt = 1; attempt <= MOTION_MAX_ATTEMPTS; attempt++) {
    const step = stepOf(
      await deps.chat({
        attemptId: `${job.jobId}:idea#${attempt}`,
        jobId: job.jobId,
        scope: job.scope,
        model: job.textModel,
        budget: deps.budget,
        priceBook: deps.priceBook,
        signal: NEVER_ABORTED,
        messages: messagesOf(job.idea, frame, feedback, previous),
        jsonSchema: TRANSLATOR_JSON_SCHEMA,
        maxTokens: TRANSLATE_ATTEMPT.maxTokens,
        inputTokens: TRANSLATE_ATTEMPT.inputTokens,
        reasoningEffort: "low",
        scrubRaw,
      }),
    );
    cost += step.costMicros;
    if (step.kind === "refused") return settled();
    if (step.kind === "no-room") {
      return attempt === 1 ? { kind: "error", error: { code: "BUDGET_EXCEEDED", detail: "the month has no room for the translator's call" }, costMicros: cost } : settled();
    }
    if (step.kind === "error") return { kind: "error", error: step.error, costMicros: cost };
    if (step.kind === "unreadable") {
      if (step.final === true) return settled();
      feedback = ["unreadable"];
      previous = null;
      continue;
    }
    const english = readAnswer(step.content);
    if (english === null) {
      feedback = ["unreadable"];
      previous = null;
      continue;
    }
    const { text, problems } = checkModelText(job.facts, english, "own");
    if (problems.length === 0) return { kind: "ok", text, costMicros: cost };
    lastProblems = problems;
    // `takes-off` gets no repair: the idea is the owner's own choice, and a repair could only make it another motion than he asked for.
    if (!repairMayHelp(problems)) return settled();
    feedback = problems;
    previous = text.slice(0, PREVIOUS_MAX_CHARS);
  }
  return settled();
}
