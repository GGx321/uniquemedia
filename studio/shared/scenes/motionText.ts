import { MOTION_PROBLEMS, MOTION_TEXT_MAX, type ClipMotionSource, type MotionProblem } from "../engine";
import { isHandCapture, type Capture, type FaceVisibility } from "./captures";
import { contentProblems, type ContentLevel, type ContentProblem } from "./contentLine";
import { CAMERA_WORDS, HAIR_COLOUR_WORDS, MOTION_SMALL, MOTION_STAGING, PHONE_WORDS, SELFIE_WORDS, YOUTH_PROPS } from "./words";

// Stage 5, 5b.2, S5.WC2 (plan s5b2 I5.66, §8 WC2): the one motion check. A motion text is data, whoever wrote it: a bank's author (`bank`, at load), the code's table (`code`), a
// photo's own bank moment (`scene`), the vision writer (`vision`) or the owner's idea through the translator (`own`). Every one is held here, and nowhere else, to:
//
//  - the bank's GRAMMAR (banks/schema.ts held motions to it before; its loader now calls this module through a thin adapter that keeps its rule ids and words): plain printable
//    text of at most 60 characters, no youth word or prop, no hair colour, no selfie word, no camera, «she» or «her» first, small or slow, one movement, no staging word, and
//    a phone only where the moment uses one;
//  - the FRAME's rules (prompt.ts held motions to them before): the content line at the frame's level, the video's staging words, a phone where hers is in her hand or propped,
//    and no movement of a face the photo does not show.
//
// Which source takes what: the grammar runs on `bank`, `code`, `vision` and `own`. A `scene` text is a bank motion verbatim, held to the grammar when its bank loaded, so on a
// frame it takes the frame's rules alone (a test proves every one of the 271 passes the grammar as well). The frame's rules run on every source but `bank`, which has no frame.
//
// The answer is the contract's closed `MotionProblem`s (shared/engine/clipMotions.ts), each once, in its fixed display order; `motionTextFindings` keeps each finding's rule and
// words for the bank's adapter and the engine's log. Pure: no clock, no I/O, nothing imported but modules of studio/shared (scenes/purity.test.ts).

/** What the check reads of a frame; the engine's `FrameFacts` carries every field. */
export interface MotionFrame {
  /** Who took the photo, as its own prompt proves it (the camera line's capture). */
  readonly capture: Capture | "unknown";
  /** Who the plan says took it: an old pov-legs photo that reads as unknown was still taken with the phone in her hand (S5.WP1, C3 K1). */
  readonly plannedCapture: Capture | "unknown";
  readonly face: FaceVisibility;
  /** The level the text is held to: bold on a frame of «Смелая», ordinary elsewhere. */
  readonly level: ContentLevel;
  /** A frame of «Смелая». */
  readonly bold: boolean;
  /** The slot's bank moment, if any: its `phone` says the moment uses her phone, so its motion may name it. */
  readonly moment: { readonly phone?: true | undefined } | null;
}

/** The rules, in the order they are read (the bank's own order for the ones it takes). */
export const MOTION_RULES = [
  "printable",
  "length",
  "youth",
  "revealing",
  "youth-prop",
  "hair-colour",
  "selfie",
  "camera",
  "she-her",
  "small",
  "one-movement",
  "staging",
  "phone-moment",
  "phone-in-hand",
  "face",
] as const;
export type MotionRule = (typeof MOTION_RULES)[number];

/** The rules the bank's loader takes (its adapter names each with its own rule id). */
export const BANK_MOTION_RULES = ["printable", "length", "youth", "youth-prop", "hair-colour", "selfie", "camera", "she-her", "small", "one-movement", "staging", "phone-moment"] as const satisfies readonly MotionRule[];
export type BankMotionRule = (typeof BANK_MOTION_RULES)[number];

/** One rule a text breaks: the rule, the closed problem the window shows, and what it breaks in the bank's own words. */
export interface MotionFinding<Rule extends MotionRule = MotionRule> {
  readonly rule: Rule;
  readonly problem: MotionProblem;
  readonly what: string;
}

/** I5.51: camera and edit words of a video, beyond the bank's own staging list. */
const VIDEO_STAGING = /\b(?:dolly|crane|drone|gimbal|orbit\w*|push-?ins?|cinematic\w*|film\w*|colou?r grading|lens flares?|transitions?)\b/i;

/** Whether a motion or an activity stages the camera or the edit: the bank's MOTION_STAGING, or a video word (I5.51). */
export function hasVideoStagingWord(text: string): boolean {
  return MOTION_STAGING.test(text) || VIDEO_STAGING.test(text);
}

/**
 * A motion of her mouth, her eyes or her expression. On a frame whose face does not show (the phone over it from her eyebrows to her chin, her legs filling the frame) it
 * would contradict the photo: the clip would have to uncover her face to play it.
 */
export const FACE_ACTION = /\b(?:smil\w*|blink\w*|laugh\w*|grin\w*|wink\w*|pout\w*|kiss\w*|lips?|eyes?|sips?|sipping)\b/i;

/** A text that names her phone or a selfie: either draws a phone. */
export function namesPhone(text: string): boolean {
  return PHONE_WORDS.test(text) || SELFIE_WORDS.test(text);
}

const inHandOrPropped = (capture: Capture | "unknown"): boolean => capture !== "unknown" && (isHandCapture(capture) || capture === "timer");

/**
 * The runtime's half of the phone rule: her phone is in her hand (a selfie, a mirror) or propped (a timer) on the capture the photo proves OR on the one its plan names (the WP1
 * review, 2026-10-14): a text that names a phone there draws a second one.
 */
export function phoneInHandOrPropped(frame: Pick<MotionFrame, "capture" | "plannedCapture">): boolean {
  return inHandOrPropped(frame.capture) || inHandOrPropped(frame.plannedCapture);
}

const PRINTABLE = /^[\x20-\x7e]+$/;
const MOTION_START = /^(?:she|her)\s/;

/** Where a rule reads: the bank at load (no frame), or a frame with the text's source. */
type Scope = { readonly source: "bank"; readonly level: ContentLevel; readonly momentUsesPhone: boolean } | { readonly source: ClipMotionSource; readonly frame: MotionFrame };

/** The sources the grammar runs on: everything but a scene text, whose grammar ran when its bank loaded. */
const takesGrammar = (scope: Scope): boolean => scope.source !== "scene";

const levelOf = (scope: Scope): ContentLevel => (scope.source === "bank" ? scope.level : scope.frame.level);

/** The content line's answer for the text at the scope's level, read once per text (the youth and the revealing rules share it). */
type ContentRead = () => readonly ContentProblem[];

interface RuleCheck {
  readonly rule: MotionRule;
  readonly problem: MotionProblem;
  /** What the text breaks, or null when it keeps the rule (or the rule does not read this scope). */
  readonly check: (text: string, scope: Scope, content: ContentRead) => string | null;
}

const words = (found: readonly string[]): string => found.join(", ");
const contentWordsOf = (content: ContentRead, reason: ContentProblem["reason"]): string[] => content().find((problem) => problem.reason === reason)?.words ?? [];

const RULES: readonly RuleCheck[] = [
  {
    rule: "printable",
    problem: "content",
    check: (text, scope) => (takesGrammar(scope) && (text.trim() !== text || text.length === 0 || !PRINTABLE.test(text)) ? "must be plain printable ASCII with no edge space" : null),
  },
  { rule: "length", problem: "too-long", check: (text, scope) => (takesGrammar(scope) && text.length > MOTION_TEXT_MAX ? `must be at most ${MOTION_TEXT_MAX} characters` : null) },
  {
    rule: "youth",
    problem: "content",
    check: (_text, _scope, content) => {
      const youth = contentWordsOf(content, "youth-word");
      return youth.length > 0 ? `names a youth word (${words(youth)})` : null;
    },
  },
  {
    rule: "revealing",
    problem: "content",
    check: (_text, scope, content) => {
      if (scope.source === "bank") return null;
      const revealing = contentWordsOf(content, "revealing-word");
      return revealing.length > 0 ? `names a revealing word at this frame's level (${words(revealing)})` : null;
    },
  },
  { rule: "youth-prop", problem: "content", check: (text, scope) => (takesGrammar(scope) && YOUTH_PROPS.test(text) ? "names a youth prop" : null) },
  { rule: "hair-colour", problem: "content", check: (text, scope) => (takesGrammar(scope) && HAIR_COLOUR_WORDS.test(text) ? "names a hair colour or a dye" : null) },
  { rule: "selfie", problem: "phone", check: (text, scope) => (takesGrammar(scope) && SELFIE_WORDS.test(text) ? "says selfie or front camera, which draws a phone" : null) },
  { rule: "camera", problem: "staging", check: (text, scope) => (takesGrammar(scope) && CAMERA_WORDS.test(text) ? "names a camera or a lens" : null) },
  { rule: "she-her", problem: "not-motion", check: (text) => (MOTION_START.test(text) ? null : "opens with «she» or «her»") },
  {
    rule: "small",
    problem: "not-small",
    check: (text, scope) => (takesGrammar(scope) && !MOTION_SMALL.test(text) ? "is small or slow: «slowly», «a little», «a bit», «slightly», «gently» or «small»" : null),
  },
  {
    rule: "one-movement",
    problem: "two-movements",
    check: (text, scope) => (takesGrammar(scope) && (/\bthen\b|;/.test(text) || (text.match(/\band\b/g) ?? []).length > 1) ? "is one movement (at most a there-and-back with one «and»)" : null),
  },
  {
    rule: "staging",
    problem: "staging",
    check: (text, scope) => ((scope.source === "bank" ? MOTION_STAGING.test(text) : hasVideoStagingWord(text)) ? "moves her, never the camera or the edit" : null),
  },
  {
    rule: "phone-moment",
    problem: "phone",
    check: (text, scope) => {
      const usesPhone = scope.source === "bank" ? scope.momentUsesPhone : scope.frame.moment?.phone === true;
      return PHONE_WORDS.test(text) && !usesPhone ? "brings in a phone the moment does not use (a second phone)" : null;
    },
  },
  {
    rule: "phone-in-hand",
    problem: "phone",
    check: (text, scope) => (scope.source !== "bank" && namesPhone(text) && phoneInHandOrPropped(scope.frame) ? "names a phone where hers is in her hand or propped (a second phone)" : null),
  },
  {
    rule: "face",
    problem: "face-hidden",
    check: (text, scope) => (scope.source !== "bank" && scope.frame.face !== "yes" && FACE_ACTION.test(text) ? "moves her face, which the photo does not show" : null),
  },
];

function findingsIn(text: string, scope: Scope): MotionFinding[] {
  let read: readonly ContentProblem[] | undefined;
  const content: ContentRead = () => (read ??= contentProblems(text, levelOf(scope)));
  return RULES.flatMap(({ rule, problem, check }) => {
    const what = check(text, scope, content);
    return what === null ? [] : [{ rule, problem, what }];
  });
}

/** Every rule a motion text breaks on a frame, with its words, in rule order. */
export function motionTextFindings(text: string, frame: MotionFrame, source: ClipMotionSource): MotionFinding[] {
  return findingsIn(text, { source, frame });
}

/** The closed problems of findings: each once, in the contract's display order (`MOTION_PROBLEMS`). */
export function problemsOf(findings: readonly MotionFinding[]): MotionProblem[] {
  const found = new Set(findings.map((finding) => finding.problem));
  return MOTION_PROBLEMS.filter((problem) => found.has(problem));
}

/** The closed problems of a motion text on a frame, each once, in the contract's display order. Empty: the text may be offered on this frame (the prompt's cap aside). */
export function motionTextProblems(text: string, frame: MotionFrame, source: ClipMotionSource): MotionProblem[] {
  return problemsOf(motionTextFindings(text, frame, source));
}

const isBankRule = (finding: MotionFinding): finding is MotionFinding<BankMotionRule> => (BANK_MOTION_RULES as readonly MotionRule[]).includes(finding.rule);

/**
 * The bank loader's view (banks/schema.ts, its adapter): the grammar alone, at the bank's level (`ordinary`, or bold for a «Смелая» bank, which spares its exempt garment name),
 * with the bank's half of the phone rule. In the bank's own order and words.
 */
export function bankMotionFindings(motion: string, level: ContentLevel, momentUsesPhone: boolean): MotionFinding<BankMotionRule>[] {
  return findingsIn(motion, { source: "bank", level, momentUsesPhone }).filter(isBankRule);
}
