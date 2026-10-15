import { ageMentions, ageUpperBounds, MOTION_ENGLISH, MOTION_PROBLEMS, MOTION_TEXT_MAX, type ClipMotionSource, type MotionProblem } from "../engine";
import { isHandCapture, type Capture, type FaceVisibility } from "./captures";
import { contentProblems, type ContentLevel, type ContentProblem } from "./contentLine";
import { explicitActsIn, exposureWordsIn } from "./explicitWords";
import { CAMERA_WORDS, HAIR_COLOUR_WORDS, MOTION_SMALL, MOTION_STAGING, PHONE_WORDS, SELFIE_WORDS, YOUTH_PROPS } from "./words";

// Stage 5, 5b.2, S5.WC2 (plan s5b2 I5.66, §8 WC2): the one motion check. A motion text is data, whoever wrote it: a bank's author (`bank`, at load), the code's table (`code`), a
// photo's own bank moment (`scene`), the vision writer (`vision`) or the owner's idea through the translator (`own`). Every one is held here, and nowhere else, to:
//
//  - the bank's GRAMMAR (banks/schema.ts held motions to it before; its loader now calls this module through a thin adapter that keeps its rule ids and words): plain printable
//    text of at most 60 characters, no youth word or prop, no hair colour, no selfie word, no camera, «she» or «her» first, small or slow, one movement, no staging word, and
//    a phone only where the moment uses one;
//  - the FRAME's rules (prompt.ts held motions to them before): the content line at the frame's level, the video's staging words, a phone where hers is in her hand or propped,
//    no movement of a face the photo does not show, and (Q-H = 2) nothing that takes clothing off unless it is an own idea on a frame of «Смелая»;
//  - a MODEL's text (vision, own) also passes what a bank's author never needed (the WC1 review: text that passes the charset can still be an instruction): the contract's
//    motion English, one plain clause with no final period, no second sentence, no word that talks to a model, no negation (I5.10), and at least three words.
//
// Which source takes what: the grammar runs on `bank`, `code`, `vision` and `own`. A `scene` text is a bank motion verbatim, held to the grammar when its bank loaded, so on a
// frame it takes the frame's rules alone (a test proves every one of the 271 passes the grammar, and a model's rules, as well). The frame's rules run on every source but `bank`,
// which has no frame and never reads the takes-off rule (the bank is unchanged by Q-H).
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
  "charset",
  "form",
  "length",
  "youth",
  "number",
  "revealing",
  "exposure",
  "explicit",
  "youth-prop",
  "hair-colour",
  "instruction",
  "negation",
  "new-subject",
  "takes-off",
  "selfie",
  "camera",
  "she-her",
  "words",
  "small",
  "fast",
  "one-movement",
  "sentence",
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

/**
 * I5.51: camera and edit words of a video, beyond the bank's own staging list. Round 2 (S5.WC2): slow-mo, a time-lapse, a fade in or out, handheld, a focus pull, a 4K
 * or 8K, an aspect ratio, a frame rate.
 */
const VIDEO_STAGING =
  /\b(?:dolly|crane|drone|gimbal|orbit\w*|push-?ins?|cinematic\w*|film\w*|colou?r grading|lens flares?|transitions?|slow-?mo|time-?lapse\w*|fade-?(?:in|out)|fades?\s+(?:in|out|to)|hand-?held|(?:rack|soft|shallow|deep)[- ]focus|out of focus|defocus\w*|focus (?:pull|shift)\w*|\d+k|aspect ratio|frame rate|fps|steadicam)\b/i;

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

// ---------- TAKES_OFF (Q-H = 2, the owner 2026-10-14; plan s5b2 §5.3) ----------

/** The plan's pinned list: what a motion that takes clothing off says. Each is read in its inflections and with its particle split («takes her robe off»). */
export const TAKES_OFF_PHRASES = ["takes off", "pulls off", "removes her", "unbuttons", "unzips her", "slips out of", "lets … fall"] as const;

/**
 * What a match is about when it is NOT clothing: her hair or her body («lets her hair fall», «removes her hand from her hip»), a breath, a sip or a step, something she holds
 * («unzips her bag»), or a seat or a place she leaves («slides off the bed»). A towel, a sheet or a blanket she wears or lies under stays clothing: pulling it off uncovers her.
 */
const NOT_WORN = new Set(
  (
    "hair ponytail ponytails braid braids bangs fringe curl curls strand strands head face eye eyes eyelid eyelids lid lids gaze chin neck lip lips arm arms hand hands finger fingers " +
    "wrist wrists elbow elbows shoulder shoulders hip hips leg legs knee knees foot feet toe toes body weight breath sip bite step steps look glance " +
    "bag bags handbag handbags backpack backpacks purse purses clutch clutches tote totes keys key phone cup mug glass bottle book fork " +
    "bed sofa couch chair stool bench ledge wall railing table counter floor curb swing"
  ).split(" "),
);

/** The forms, each with the words that say what comes off: after the phrase («takes off her robe») or between its verb and its particle («takes her robe off»). */
const OFF_VERBS = "take|takes|taking|took|pull|pulls|pulling|slip|slips|slipping|slide|slides|sliding|peel|peels|peeling|shrug|shrugs|shrugging|strip|strips|stripping";
const TAKES_OFF_FORMS: readonly RegExp[] = [
  // «takes off her robe», «pulls off her top», and the same act in other words: «peels off», «shrugs off», «slides off», «slips off», «strips off».
  new RegExp(`\\b(?:${OFF_VERBS})\\s+off\\b((?:\\s+[a-z'-]+){0,3})`, "gi"),
  // «takes her robe off», «pulls the sheet off», «slips the robe off her shoulders».
  new RegExp(`\\b(?:${OFF_VERBS})\\s+((?:[a-z'-]+\\s+){1,3}?)off\\b`, "gi"),
  // «removes her robe».
  /\bremov(?:e|es|ing|ed)\b((?:\s+[a-z'-]+){0,3})/gi,
  // «unbuttons her shirt»: always clothing.
  /\bunbutton\w*()/gi,
  // «unzips her dress» (not her bag).
  /\bunzip(?:s|ping|ped)?\b((?:\s+[a-z'-]+){0,3})/gi,
  // «slips out of her dress» (not out of bed).
  /\bslip(?:s|ping|ped)?\s+out\s+of\b((?:\s+[a-z'-]+){0,3})/gi,
  // «lets the strap fall», «lets her robe slip» (not her hair, her head or her arms).
  /\blet(?:s|ting)?\s+((?:[a-z'-]+\s+){1,3}?)(?:fall|falls|falling|drop|drops|dropping|slip|slips|slipping|slide|slides|sliding)\b/gi,
  // «undresses», «strips» (not «strips the bed»).
  /\bundress\w*()/gi,
  /\bstrip(?:s|ping|ped)?\b((?:\s+[a-z'-]+){0,3})/gi,
];

/**
 * Round 2 (S5.WC2, the content review): what she wears, by name. «top» is a garment unless it names the upper one of two («her top knee», «the top of her head»). The
 * one motion check's garment-anchored takes-off forms read it, and so does videoLook's `WORN_OR_HELD` (a garment only moved takes «comes off»).
 */
export const GARMENT =
  /\b(?:robes?|tops?(?!\s+(?:knee|leg|foot|arm|hand|of|step|stair|shelf|bunk)\b)|dress(?:es)?|shirts?|t-shirts?|tees?|blouses?|towels?|bras?|bralettes?|straps?|skirts?|jackets?|hoodies?|sweaters?|jumpers?|cardigans?|coats?|shorts|jeans|trousers|pants|leggings|bikinis?|swim(?:suits?|wear)|lingerie|stockings|tights|pajamas|pyjamas|nightgowns?|nighties?|nightdress(?:es)?|camisoles?|cami|bodysuits?|kimonos?|sarongs?|shawls?|panties|briefs|underwear|thongs?)\b/i;

/**
 * Round 2: the same act said with a garment, in the words a model reaches for. Each needs a garment in what it moves (and none of `NOT_WORN`): a verb that moves it off,
 * down, away, open, aside or over her head («pulls her top over her head», «eases her dress off», «slides her straps down», «slips her robe from her shoulders»); a verb
 * that undoes it («drops», «sheds», «opens», «unties», «undoes», «unhooks», «unfastens», «unwraps», «lowers», «loosens» her robe); stepping, wriggling or getting out of
 * it; letting it open.
 */
const MOVE_VERBS = "pull|pulls|pulling|tug|tugs|tugging|lift|lifts|lifting|ease|eases|easing|push|pushes|pushing|draw|draws|drawing|lower|lowers|lowering|slide|slides|sliding|slip|slips|slipping|peel|peels|peeling|roll|rolls|rolling|work|works|working|shrug|shrugs|shrugging|inch|inches|inching|take|takes|taking";
const AWAY = String.raw`(?:off|down|away|open|apart|aside|over\s+her\s+head|from\s+her\s+(?:shoulders?|body|hips?|chest|arms?))`;
const GARMENT_FORMS: readonly RegExp[] = [
  new RegExp(String.raw`\b(?:${MOVE_VERBS})\s+((?:[a-z'-]+\s+){1,4}?)${AWAY}\b`, "gi"),
  /\b(?:drop|drops|dropping|shed|sheds|shedding|open|opens|opening|unti\w*|undo|undoes|undoing|unhook\w*|unfasten\w*|unwrap\w*|unlac\w*|unclasp\w*|lower|lowers|lowering|loosen\w*)\b((?:\s+[a-z'-]+){1,3})/gi,
  /\b(?:step|steps|stepping|wriggl\w*|wiggl\w*|get|gets|getting|climb\w*|shimm(?:y|ies|ying)|wrestl\w*)\s+out\s+of\b((?:\s+[a-z'-]+){1,3})/gi,
  /\blet(?:s|ting)?\s+((?:[a-z'-]+\s+){1,3}?)(?:fall\s+|slip\s+|swing\s+)?open\b/gi,
];

const wordsOf = (match: RegExpMatchArray): string[] => (match[1] ?? "").toLowerCase().match(/[a-z'-]+/g) ?? [];

/**
 * Whether a motion takes clothing off: one of `TAKES_OFF_PHRASES` (and the same act in a model's other words: «peels off», «shrugs off», «slips the robe off», «undresses»,
 * «strips»), unless what comes off is her hair, her body, something she holds or a seat; or, since round 2, a garment moved off, down, away or open, undone, or stepped out
 * of. No bank motion and no code motion says one (motionText.test.ts sweeps them).
 */
export function takesOff(text: string): boolean {
  const phrase = TAKES_OFF_FORMS.some((form) => Array.from(text.matchAll(form)).some((match) => !wordsOf(match).some((word) => NOT_WORN.has(word))));
  if (phrase) return true;
  return GARMENT_FORMS.some((form) =>
    Array.from(text.matchAll(form)).some((match) => {
      const object = wordsOf(match);
      return GARMENT.test(object.join(" ")) && !object.some((word) => NOT_WORN.has(word));
    }),
  );
}

/**
 * The problems a repair attempt cannot help (S5.WC2, for WC3): an own idea that takes clothing off on a frame that is not «Смелая» is the owner's own choice, and a repair could
 * only make it into another motion than he asked for, so it is rejected at once with `takes-off` (its text says the idea is for frames of «Смелая»); a vision text that takes
 * clothing off is dropped.
 */
export const NO_REPAIR_PROBLEMS: readonly MotionProblem[] = ["takes-off"];

/** Whether a second attempt may help a text with these problems: never when one of them is `NO_REPAIR_PROBLEMS`. */
export function repairMayHelp(problems: readonly MotionProblem[]): boolean {
  return !problems.some((problem) => NO_REPAIR_PROBLEMS.includes(problem));
}

const PRINTABLE = /^[\x20-\x7e]+$/;
const MOTION_START = /^(?:she|her)\s/;

// ---------- a model's text (vision, own): the WC1 review's injection-ish shapes that pass the charset ----------

/** One plain clause: no double space, no hyphen or apostrophe outside a word, no stray comma, no final period (the motion sentence adds its own). */
const NOT_ONE_CLAUSE = /\s{2}|(?<![A-Za-z0-9])-|-(?![A-Za-z0-9])|(?<![A-Za-z])'|'(?![A-Za-z])|\s,|,(?!\s[A-Za-z0-9])|\.$/;
/** A second sentence after a period. */
const SECOND_SENTENCE = /\.\s*\S/;
/** Words that talk to a model, never about her movement. */
const INSTRUCTION_WORDS = /\b(?:ignor\w*|disregard\w*|instructions?|prompts?|system|assistant|overrid\w*|jailbreak\w*|uncensored|nsfw|negative|rules?)\b/i;
/** A negation names what it negates, and so puts it into the prompt (I5.10). */
const NEGATION = /\b(?:no|not|never|without|nothing|none|nobody|neither|nor)\b|n't\b/i;
/** A motion is at least «she» or «her», a verb and its manner. */
const MOTION_WORDS_MIN = 3;

// ---------- round 2 (S5.WC2, the content review) ----------

/**
 * The two costly reads of a check, kept per text: the content line's answer at a level (`contentProblems`) and the ages and age bounds a text states (`ageMentions`,
 * `ageUpperBounds`). A frame's prompt checks the same few motion texts again and again (every choice, both dialects, and the job's last build), so each answer is kept, at
 * most `KEPT_MAX` of them (then the memory starts over). Both are pure functions of their keys: what is kept never changes an answer.
 */
const KEPT_MAX = 1_024;
function keptBy<T>(compute: (key: string) => T): (key: string) => T {
  const kept = new Map<string, T>();
  return (key) => {
    const found = kept.get(key);
    if (found !== undefined) return found;
    if (kept.size >= KEPT_MAX) kept.clear();
    const value = compute(key);
    kept.set(key, value);
    return value;
  };
}
const agesIn = keptBy((text): readonly number[] => [...ageMentions(text), ...ageUpperBounds(text)]);
const contentAt = new Map<ContentLevel, (text: string) => readonly ContentProblem[]>();
/** `contentProblems(text, level)`, kept per level and text. */
function contentIn(text: string, level: ContentLevel): readonly ContentProblem[] {
  let read = contentAt.get(level);
  if (read === undefined) {
    read = keptBy((key) => contentProblems(key, level));
    contentAt.set(level, read);
  }
  return read(text);
}

/** Every number word but «one», which the bank's own motions say («she swings one foot a little») and which `ageText` too never reads alone as an age. */
const NUMBER_WORDS =
  /\b(?:two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|dozen)\b/i;
/** Exposure a model says beyond the bank's list (scenes/explicitWords.ts). */
const EXPOSURE_MORE =
  /\b(?:bare[- ](?:breasts?|chest(?:ed)?|bottom|butt)|breasts?|unclothed|undressed|in the nude|birthday suit|au naturel|wearing nothing|nothing on|without clothes|sans clothes)\b/gi;
/** Explicit acts and words a model says beyond the bank's list. */
const EXPLICIT_MORE =
  /\b(?:spread(?:s|ing)?\s+(?:her\s+)?(?:legs|thighs)|touch(?:es|ing)?\s+herself|strok(?:e|es|ing)\s+herself|masturbat\w*|porn\w*|xxx|hentai|erotic\w*|explicit|moan\w*|grop\w*|horny|aroused)\b/gi;
/** Someone or something new in the clip: another person, or something that appears, enters or joins («…, a man walks in», «…, a second woman appears»). */
const NEW_SUBJECT =
  /\b(?:man|men|woman|women|guy|guys|person|people|stranger|someone|somebody|anyone|anybody|boyfriend|girlfriend|husband|crowd|another|second|new|he|him|his|appears?|appearing|enters?|entering|arriv\w*|joins?|joining|emerg\w*|walks?\s+in|comes?\s+in|shows?\s+up)\b/i;
/** Speed a model may add beside a small word («slowly turns, very fast and abruptly»): the movement is not small then. */
const FAST = /\b(?:fast|faster|quick|quickly|rapid|rapidly|abrupt|abruptly|sudden|suddenly|wild|wildly|jerk\w*|frantic\w*|vigorous\w*|energetic\w*|swift\w*|hurried\w*|brisk\w*)\b/i;

const isModelText = (scope: Scope): boolean => scope.source === "vision" || scope.source === "own";

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
  {
    rule: "charset",
    problem: "content",
    check: (text, scope) => (isModelText(scope) && !MOTION_ENGLISH.test(text) ? "holds a character outside the motion English (letters, digits, spaces and , . ' -)" : null),
  },
  {
    rule: "form",
    problem: "content",
    check: (text, scope) =>
      isModelText(scope) && NOT_ONE_CLAUSE.test(text) ? "is not one plain clause (a double space, a hyphen or an apostrophe outside a word, a stray comma or a final period)" : null,
  },
  { rule: "length", problem: "too-long", check: (text, scope) => (takesGrammar(scope) && text.length > MOTION_TEXT_MAX ? `must be at most ${MOTION_TEXT_MAX} characters` : null) },
  {
    // Round 2 (HIGH): an age or an age bound is a hard line on every source and every frame, the bank's load included (`adultTextProblems`'s readers, ageText.ts).
    rule: "youth",
    problem: "content",
    check: (text, _scope, content) => {
      const youth = contentWordsOf(content, "youth-word");
      const ages = agesIn(text);
      const said = [youth.length > 0 ? `names a youth word (${words(youth)})` : null, ages.length > 0 ? `names an age or an age bound (${ages.join(", ")})` : null];
      const found = said.filter((what): what is string => what !== null);
      return found.length > 0 ? found.join("; ") : null;
    },
  },
  {
    // Round 2: a model's text holds no number at all, a digit or a number word but «one» (the bank says «she swings one foot a little»): a motion never needs one, and an age
    // hides in one («sixteen») where `ageMentions` reads no context.
    rule: "number",
    problem: "content",
    check: (text, scope) => (isModelText(scope) && (/\d/.test(text) || NUMBER_WORDS.test(text)) ? "names a number" : null),
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
  {
    // Round 2 (the controller's decision on explicit content): exposure is the owner's own idea's alone on a frame of «Смелая», as undressing is (Q-H = 2); refused for
    // every other source and on every other frame. The bank's sweeps hold its own texts to the same lists.
    rule: "exposure",
    problem: "content",
    check: (text, scope) => {
      if (scope.source === "bank" || (scope.source === "own" && scope.frame.bold)) return null;
      const exposure = [...exposureWordsIn(text), ...Array.from(text.matchAll(new RegExp(EXPOSURE_MORE)), (m) => m[0])];
      return exposure.length > 0 ? `names exposure (${words(exposure)})` : null;
    },
  },
  {
    // Round 2: an explicit act is refused on every frame, for every source.
    rule: "explicit",
    problem: "content",
    check: (text, scope) => {
      if (scope.source === "bank") return null;
      const acts = [...explicitActsIn(text), ...Array.from(text.matchAll(new RegExp(EXPLICIT_MORE)), (m) => m[0])];
      return acts.length > 0 ? `names an explicit act (${words(acts)})` : null;
    },
  },
  { rule: "youth-prop", problem: "content", check: (text, scope) => (takesGrammar(scope) && YOUTH_PROPS.test(text) ? "names a youth prop" : null) },
  { rule: "hair-colour", problem: "content", check: (text, scope) => (takesGrammar(scope) && HAIR_COLOUR_WORDS.test(text) ? "names a hair colour or a dye" : null) },
  { rule: "instruction", problem: "content", check: (text, scope) => (isModelText(scope) && INSTRUCTION_WORDS.test(text) ? "talks to a model, not about her movement" : null) },
  { rule: "negation", problem: "content", check: (text, scope) => (isModelText(scope) && NEGATION.test(text) ? "negates, which puts what it negates into the prompt" : null) },
  {
    rule: "new-subject",
    problem: "content",
    check: (text, scope) => (isModelText(scope) && NEW_SUBJECT.test(text) ? "brings someone or something new into the clip" : null),
  },
  {
    // Q-H = 2: only an own idea on a frame of «Смелая» may take clothing off. The bank never reads this rule (the bank is unchanged); a vision text never passes it.
    rule: "takes-off",
    problem: "takes-off",
    check: (text, scope) =>
      scope.source !== "bank" && !(scope.source === "own" && scope.frame.bold) && takesOff(text) ? "takes clothing off, which only an own idea on a frame of «Смелая» may" : null,
  },
  { rule: "selfie", problem: "phone", check: (text, scope) => (takesGrammar(scope) && SELFIE_WORDS.test(text) ? "says selfie or front camera, which draws a phone" : null) },
  { rule: "camera", problem: "staging", check: (text, scope) => (takesGrammar(scope) && CAMERA_WORDS.test(text) ? "names a camera or a lens" : null) },
  { rule: "she-her", problem: "not-motion", check: (text) => (MOTION_START.test(text) ? null : "opens with «she» or «her»") },
  {
    rule: "words",
    problem: "not-motion",
    check: (text, scope) => (isModelText(scope) && text.split(/\s+/).filter((word) => word !== "").length < MOTION_WORDS_MIN ? "is too short to say a movement" : null),
  },
  {
    rule: "small",
    problem: "not-small",
    check: (text, scope) => (takesGrammar(scope) && !MOTION_SMALL.test(text) ? "is small or slow: «slowly», «a little», «a bit», «slightly», «gently» or «small»" : null),
  },
  { rule: "fast", problem: "not-small", check: (text, scope) => (isModelText(scope) && FAST.test(text) ? "says it is fast, abrupt or sudden" : null) },
  {
    rule: "one-movement",
    problem: "two-movements",
    check: (text, scope) => (takesGrammar(scope) && (/\bthen\b|;/.test(text) || (text.match(/\band\b/g) ?? []).length > 1) ? "is one movement (at most a there-and-back with one «and»)" : null),
  },
  { rule: "sentence", problem: "two-movements", check: (text, scope) => (isModelText(scope) && SECOND_SENTENCE.test(text) ? "holds a second sentence" : null) },
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
  const content: ContentRead = () => (read ??= contentIn(text, levelOf(scope)));
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
