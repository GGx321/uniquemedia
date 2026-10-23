import { z } from "zod";
import { MOTION_ENGLISH, MOTION_MAX_ATTEMPTS, MOTION_PROBLEMS, OWN_IDEA_MAX, type EngineError, type MotionProblem } from "../../shared/engine";
import { repairMayHelp } from "../../shared/scenes/motionText";
import { TRANSLATE_ATTEMPT } from "../money/motionEstimate";
import type { Scope } from "../money/ledger";
import type { ChatMessage } from "../openrouter/types";
import type { FrameFacts } from "./frameFacts";
import { ACTIVITY_MAX_CHARS, NEVER_ABORTED, type MotionAttemptShape, checkModelText, endsAsResult, framePayload, stepOf, type FramePayload } from "./motionCall";
import { MOTION_PROMPT_TEXTS } from "./motionPrompts";
import type { MotionJobDeps } from "./motionWriter";

// Stage 5, 5b.2, S5.WC3 (plan s5b2 §5.3 «The translator», I5.67, I5.68): «Своя идея». The owner's idea (1-300 characters) becomes one English motion of at most 60 characters, or is refused with closed
// `MotionProblem`s. The idea is JSON DATA in the user message and exists nowhere else: not in the system prompt, not in a log line, not in the saved raw body of an unusable answer (the call's own
// `scrubRaw`), not in the store (the engine keeps its label and the English text only). The translator sees no image. One repair at most: a second attempt with the closed codes and the previous English
// text (never a free-text reason); a refusal of the age guard gets none (`repairMayHelp`, S5.WC2c). Two attempts at most (`MOTION_MAX_ATTEMPTS`), ids `<jobId>:idea#N`.
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
 * - rejected: the answer failed the checks after at most one repair (or at once when a repair cannot help), or the translator refused the idea with its code (S5.WCX, at once); `problems` is
 *   non-empty, unique and in display order.
 * - none: no usable answer (unreadable twice, or refused by the model). `costMicros` 0 = free.
 * - error: a failure that is not the model's; `costMicros` is what was paid before it.
 */
export type TranslatorOutcome =
  | { kind: "ok"; text: string; costMicros: number }
  | { kind: "rejected"; problems: MotionProblem[]; costMicros: number }
  | { kind: "none"; costMicros: number }
  | { kind: "error"; error: EngineError; costMicros: number };

/**
 * S5.WCX: what the translator answers INSTEAD of a text when the idea cannot be said as one small motion of hers, each a closed `MotionProblem` the sheet explains. P-R found the translator replacing what
 * it would not say (a camera move, a phone, a take-off) with an action from the frame («raises the mug»): a silent change of meaning. Now it refuses with a code, and the code ends the call (no repair:
 * a repair could only ask it to say something else). What the motion check decides on a faithful text (a phone, her face, an age) is not the translator's to refuse.
 */
export const TRANSLATOR_REFUSALS = ["two-movements", "not-small", "staging", "not-motion"] as const satisfies readonly MotionProblem[];
type TranslatorRefusal = (typeof TRANSLATOR_REFUSALS)[number];

export const TRANSLATOR_JSON_SCHEMA: { name: string; schema: Record<string, unknown> } = {
  name: "motion_idea",
  schema: {
    type: "object",
    additionalProperties: false,
    required: ["text_en", "refusal"],
    properties: { text_en: { type: "string" }, refusal: { type: "string", enum: ["none", ...TRANSLATOR_REFUSALS] } },
  },
};

const TranslatorAnswer = z.strictObject({ text_en: z.string(), refusal: z.enum(["none", ...TRANSLATOR_REFUSALS]) });

/** An answer as read: the English text, or the translator's own refusal (which wins over any text it also wrote). */
type ReadAnswer = { kind: "text"; text: string } | { kind: "refusal"; code: TranslatorRefusal };

/** How much of the model's own last English text is fed back to it: enough to see what to fix, never a long text. */
const PREVIOUS_MAX_CHARS = 80;

type TranslatorFeedback = readonly (MotionProblem | "unreadable")[];

function readAnswer(content: string): ReadAnswer | null {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return null;
  }
  const parsed = TranslatorAnswer.safeParse(json);
  if (!parsed.success) return null;
  const { refusal } = parsed.data;
  return refusal === "none" ? { kind: "text", text: parsed.data.text_en } : { kind: "refusal", code: refusal };
}

function messagesOf(idea: string, frame: FramePayload, feedback: TranslatorFeedback, previous: string | null): ChatMessage[] {
  // The idea is a value inside JSON: whatever it holds (quotes, braces, newlines, a command) stays one string of data.
  const data = { idea, frame, ...(feedback.length === 0 ? {} : { problems: feedback }), ...(previous === null ? {} : { previous }) };
  return [
    // S5.WC2c round 2 (M2): on every frame the translator says the owner's idea as it is, an idea that takes clothing off included; the check below stays the gate.
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

/** A JSON key the scrub keeps whole (review LOW-a). */
const IDENTIFIER_KEY = /^[A-Za-z0-9_.$@-]{1,64}$/;

const STRING_OR_RUN = /"(?:[^"\\]|\\.)*(?:"|$)|-?\d[\d.eE+-]*|true|false|null|[{}\[\]:,\s]+|[^"{}\[\]:,\s]+/gy;

/**
 * The scrub of a saved raw body (I5.67, r2.1 N4, review L1): the JSON STRUCTURE stays (braces, keys, numbers, true/false/null) and every JSON string value becomes `[string: N chars]`, so a partial,
 * a cut or an escaped echo of the idea cannot survive. A string that holds the whole idea in any form `ideaScrub` knows says `[owner idea omitted: N chars]` instead. A body that is not JSON at all
 * (or is cut) is read the same way: any text outside a string that is not structure is `[text: N chars]`. The chat client runs the image-data scrub before it.
 */
export function rawScrub(idea: string): (text: string) => string {
  const forms = ideaScrub(idea);
  const marker = `[owner idea omitted: ${idea.length} chars]`;
  return (text) => {
    let out = "";
    for (const match of text.matchAll(STRING_OR_RUN)) {
      const token = match[0];
      if (token.startsWith('"')) {
        const closed = token.length > 1 && token.endsWith('"') && !/(?:^|[^\\])(?:\\\\)*\\"$/.test(token);
        const body = token.slice(1, closed ? -1 : undefined);
        const isKey = closed && /^\s*:/.test(text.slice((match.index ?? 0) + token.length));
        const echoes = forms(body) !== body;
        // A key stays only if it is identifier-like (LOW-a); any other key is the model's text and goes like a value does.
        if (isKey && !echoes && IDENTIFIER_KEY.test(body)) out += token;
        else out += `"${echoes ? marker : `[${isKey ? "key" : "string"}: ${body.length} chars]`}"`;
      } else if (/^[{}\[\]:,\s]+$/.test(token) || /^(?:-?\d[\d.eE+-]*|true|false|null)$/.test(token)) out += token;
      else out += `[text: ${token.length} chars]`;
    }
    return out;
  };
}

/** Asks the settings' text model to say the owner's idea as one small English motion. */
export async function runIdeaTranslator(deps: MotionJobDeps, job: TranslatorJob): Promise<TranslatorOutcome> {
  const frame = framePayload(job.facts);
  const scrubRaw = rawScrub(job.idea);
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
        reasoningTokens: TRANSLATE_ATTEMPT.reasoningTokens,
        inputTokens: TRANSLATE_ATTEMPT.inputTokens,
        // S5.WCX (P-R): no reasoning. On «none» grok-4.3 reasoned 0 tokens in 6 of 6 calls, about 4× cheaper and 7× faster than «low», and its translations were no worse. The reasoning
        // allowance of the reserve stays (TRANSLATE_ATTEMPT): it is a reserve, not a bill.
        reasoningEffort: "none",
        scrubRaw,
      }),
    );
    cost += step.costMicros;
    if (step.kind === "refused") return settled();
    if (step.kind === "no-room") {
      return attempt === 1 ? { kind: "error", error: { code: "BUDGET_EXCEEDED", detail: "the month has no room for the translator's call" }, costMicros: cost } : settled();
    }
    // L2: a first attempt that was paid, then a second that fails (a timeout, a 5xx, a 402): the owner is told what the first cost, not left with a bare error. A key that is refused is still an error.
    if (step.kind === "error") return endsAsResult(step, cost - step.costMicros) ? settled() : { kind: "error", error: step.error, costMicros: cost };
    if (step.kind === "unreadable") {
      if (step.final === true) return settled();
      feedback = ["unreadable"];
      previous = null;
      continue;
    }
    const answer = readAnswer(step.content);
    if (answer === null) {
      feedback = ["unreadable"];
      previous = null;
      continue;
    }
    // S5.WCX: the translator's own refusal is final: the idea is not one small motion, and a repair could only ask it to say another one.
    if (answer.kind === "refusal") return { kind: "rejected", problems: [answer.code], costMicros: cost };
    const { text, problems } = checkModelText(job.facts, answer.text, "own");
    if (problems.length === 0) return { kind: "ok", text, costMicros: cost };
    lastProblems = problems;
    // The age guard's refusal gets no repair (S5.WC2c, a hard line): a repair could only take out the age the idea said.
    if (!repairMayHelp(text, job.facts, "own")) return settled();
    feedback = problems;
    // L3, LOW-b: only text in the contract's motion English goes back to the model (letters, digits, spaces and , . ' -): no quote, bracket or semicolon that could carry an instruction.
    previous = MOTION_ENGLISH.test(text) ? text.slice(0, PREVIOUS_MAX_CHARS) : null;
  }
  return settled();
}
