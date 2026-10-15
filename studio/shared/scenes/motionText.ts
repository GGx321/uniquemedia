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
  "worn-verb",
  "body-verb",
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
  /\b(?:robes?|tops?(?!\s+(?:knee|leg|foot|arm|hand|of|step|stair|shelf|bunk)\b)|dress(?:es)?|shirts?|t-shirts?|tees?|blouses?|towels?|bras?|bralettes?|straps?|skirts?|jackets?|hoodies?|sweaters?|jumpers?|cardigans?|coats?|shorts|jeans|trousers|pants|leggings|bikinis?|swimsuits?|swimwear|lingerie|stockings|tights|pajamas|pyjamas|nightgowns?|nighties?|nightdress(?:es)?|camisoles?|cami|bodysuits?|kimonos?|sarongs?|shawls?|panties|briefs|underwear|thongs?|babydolls?)\b/i;

/**
 * Round 2: the same act said with a garment, in the words a model reaches for. Each needs a garment in what it moves (and none of `NOT_WORN`): a verb that moves it off,
 * down, away, open, aside or over her head («pulls her top over her head», «eases her dress off», «slides her straps down», «slips her robe from her shoulders»); a verb
 * that undoes it («drops», «sheds», «opens», «unties», «undoes», «unhooks», «unfastens», «unwraps», «lowers», «loosens» her robe); stepping, wriggling or getting out of
 * it; letting it open.
 */
const MOVE_VERBS = "pull|pulls|pulling|tug|tugs|tugging|lift|lifts|lifting|ease|eases|easing|push|pushes|pushing|draw|draws|drawing|lower|lowers|lowering|slide|slides|sliding|slip|slips|slipping|peel|peels|peeling|roll|rolls|rolling|work|works|working|shrug|shrugs|shrugging|inch|inches|inching|take|takes|taking";
const AWAY = String.raw`(?:off|down|away|open|apart|aside|over\s+her\s+head|from\s+her\s+(?:shoulders?|body|hips?|chest|arms?))`;
/** Round 3: lifting what she wears takes it off too («lifts her shirt», «hikes up her skirt», «pulls her skirt up», «lifts the hem of her dress», «her skirt rides up»). */
const UP_VERBS = "pull|pulls|pulling|roll|rolls|rolling|draw|draws|drawing|tug|tugs|tugging|hike|hikes|hiking|hitch|hitches|hitching";
const LIFT_VERBS = "lift|lifts|lifting|raise|raises|raising|hike|hikes|hiking|hitch|hitches|hitching";

/** One garment-anchored form. `up`: a form that moves the garment up, where a lower garment pulled up is put on, not taken off (the owner's «bent over, pulling her jeans up»). */
interface GarmentForm {
  readonly form: RegExp;
  readonly up?: true;
}
const GARMENT_FORMS: readonly GarmentForm[] = [
  { form: new RegExp(String.raw`\b(?:${MOVE_VERBS})\s+((?:[a-z'-]+\s+){1,4}?)${AWAY}\b`, "gi") },
  // Round 3: «parts» and «spreads» her robe, beside «opens» and «unties» it.
  {
    form: /\b(?:drop|drops|dropping|shed|sheds|shedding|open|opens|opening|part|parts|parting|spread|spreads|spreading|unti\w*|undo|undoes|undoing|unhook\w*|unfasten\w*|unwrap\w*|unlac\w*|unclasp\w*|lower|lowers|lowering|loosen\w*)\b((?:\s+[a-z'-]+){1,3})/gi,
  },
  { form: /\b(?:step|steps|stepping|wriggl\w*|wiggl\w*|get|gets|getting|climb\w*|shimm(?:y|ies|ying)|wrestl\w*)\s+out\s+of\b((?:\s+[a-z'-]+){1,3})/gi },
  { form: /\blet(?:s|ting)?\s+((?:[a-z'-]+\s+){1,3}?)(?:(?:fall|slip|swing)\s+)?(?:open|part|parts)\b/gi },
  // Round 3: «lifts», «raises» what she wears, its hem included («lifts the hem of her dress»); «hikes up», «hitches up» it.
  { form: new RegExp(String.raw`\b(?:${LIFT_VERBS})\b(?!\s+up\b)((?:\s+[a-z'-]+){1,5})`, "gi") },
  { form: new RegExp(String.raw`\b(?:${LIFT_VERBS})\s+up\b((?:\s+[a-z'-]+){1,5})`, "gi"), up: true },
  // «pulls up her top», «rolls up her top»; «pulls her skirt up».
  { form: new RegExp(String.raw`\b(?:${UP_VERBS})\s+up\b((?:\s+[a-z'-]+){1,3})`, "gi"), up: true },
  { form: new RegExp(String.raw`\b(?:${UP_VERBS})\s+((?:[a-z'-]+\s+){1,3}?)up\b`, "gi"), up: true },
  // «her skirt rides up».
  { form: /\b((?:[a-z'-]+\s+){1,3}?)(?:rides?|riding|creeps?|creeping)\s+up\b/gi, up: true },
];

/** What covers her legs: pulled up, it is put on. */
const LOWER_WEAR = new Set(["jeans", "trousers", "pants", "leggings", "shorts", "tights", "stockings", "sock", "socks"]);

const wordsOf = (match: RegExpMatchArray): string[] => (match[1] ?? "").toLowerCase().match(/[a-z'-]+/g) ?? [];

/** The index of the first garment among the words, read on the words together so «her top knee» stays no garment; -1 for none. */
function firstGarmentAt(words: readonly string[]): number {
  const joined = words.join(" ");
  const found = GARMENT.exec(joined);
  return found === null ? -1 : joined.slice(0, found.index).split(" ").filter((word) => word !== "").length;
}

/**
 * Whether a motion takes clothing off: one of `TAKES_OFF_PHRASES` (and the same act in a model's other words: «peels off», «shrugs off», «slips the robe off», «undresses»,
 * «strips»), unless what comes off is her hair, her body, something she holds or a seat; or, since round 2, a garment moved off, down, away or open, undone, or stepped out
 * of. No bank motion and no code motion says one (motionText.test.ts sweeps them).
 */
export function takesOff(text: string): boolean {
  const phrase = TAKES_OFF_FORMS.some((form) => Array.from(text.matchAll(form)).some((match) => !wordsOf(match).some((word) => NOT_WORN.has(word))));
  if (phrase) return true;
  // The veto reads up to and including the first garment: «lifts her hand to her top» is her hand, «lifts her skirt above her knees» is her skirt.
  return GARMENT_FORMS.some(({ form, up }) =>
    Array.from(text.matchAll(form)).some((match) => {
      const object = wordsOf(match);
      const at = firstGarmentAt(object);
      if (at < 0 || object.slice(0, at + 1).some((word) => NOT_WORN.has(word))) return false;
      return !(up === true && LOWER_WEAR.has(object[at] ?? ""));
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
  /\b(?:bare[- ](?:breasts?|chest(?:ed)?|bottom|butt)|breasts?|unclothed|undressed|in the nude|birthday suit|au naturel|wearing nothing|nothing on|without clothes|sans clothes|(?:flash|reveal|expos|bare)\w*\s+(?:(?:her|a|an|some|little|bit|of|more|bare)\s+){0,4}(?:skin|chest|cleavage|breasts?|stomach|belly|midriff|bottom|butt|thighs?|body))\b/gi;
/**
 * S5.WC2b: the exposure verbs a model reaches for beyond `EXPOSURE_MORE`, read on a vision or own text alone (a scene or code text keeps today's list): showing, displaying,
 * uncovering, peeking, flashing, revealing, exposing or baring her skin, chest, cleavage, stomach, midriff, thighs or body, up to three words apart («exposes her upper
 * thigh», «shows off her cleavage», «gives a peek of cleavage»), her bare back, and cleavage named at all («lets her cleavage show»); and showing, revealing or exposing
 * more, everything or herself, which names no body part but bares one («adjusts her top, revealing more»). Her shoulders, her face and her back as she turns stay a motion's.
 */
const EXPOSURE_MODEL =
  /\b(?:(?:uncover\w*|show\w*|display\w*|peek\w*|flash\w*|reveal\w*|expos\w*|bar(?:e|es|ed|ing))\s+(?:[a-z'-]+\s+){0,3}?(?:skin|chest|cleavage|breasts?|stomach|belly|midriff|navel|bottom|butt|buttocks|thighs?|body|bust|bare\s+back)|(?:uncover\w*|show\w*|display\w*|flash\w*|reveal\w*|expos\w*|bar(?:e|es|ed|ing))\s+(?:(?:a little|a bit|a lot|much|even|slightly|some|far)\s+)?(?:more|everything|it all|herself)|cleavage|underboob|sideboob)\b/gi;
/** Explicit acts and words a model says beyond the bank's list. */
const EXPLICIT_MORE =
  /\b(?:spread(?:s|ing)?\s+(?:her\s+)?(?:legs|thighs)|touch(?:es|ing)?\s+herself|strok(?:e|es|ing)\s+herself|masturbat\w*|porn\w*|xxx|hentai|erotic\w*|explicit|moan\w*|grop\w*|horny|aroused)\b/gi;
/** Someone or something new in the clip: another person, or something that appears, enters or joins («…, a man walks in», «…, a second woman appears»). */
const NEW_SUBJECT =
  /\b(?:man|men|woman|women|guy|guys|person|people|stranger|someone|somebody|anyone|anybody|boyfriend|girlfriend|husband|crowd|another|second|new|he|him|his|appears?|appearing|enters?|entering|arriv\w*|joins?|joining|emerg\w*|walks?\s+in|comes?\s+in|shows?\s+up)\b/i;
/** Speed a model may add beside a small word («slowly turns, very fast and abruptly»): the movement is not small then. */
const FAST = /\b(?:fast|faster|quick|quickly|rapid|rapidly|abrupt|abruptly|sudden|suddenly|wild|wildly|jerk\w*|frantic\w*|vigorous\w*|energetic\w*|swift\w*|hurried\w*|brisk\w*)\b/i;

// ---------- S5.WC2b: the clothing-verb whitelist (a vision or own text; the three review rounds' leaks) ----------
//
// The takes-off forms above are a blacklist, and each review round found paraphrases it missed («works her skirt up», «her robe falls open», «loosens the tie of her robe»).
// A model's text is held to a whitelist instead: where it names what she wears (a garment, a part of one, its fabric, a cover she lies under) or her body (cleavage, chest,
// midriff, stomach, belly, navel, thighs, bare skin, a bare back), the only verbs that may act on it are the ones that keep her dressed: adjusts, smooths (down), straightens,
// fixes; tucks (in) a top or a strap, never a skirt, a dress or a hem; brushes (off) what she wears but a strap, a waistband, a neckline, a collar or a towel, or the sand off
// any of it; tugs (at) … a little; pulls … down a little (a hem, a sleeve, a top); pulls up what covers her legs, a strap, a waistband, a neckline, a towel or a sheet; zips
// or buttons (up). Beside them, the covering forms the bank itself says («tugs the coat closer», «slides the strap up», «lets the strap settle on her shoulder», «pulls the
// sheet a little higher»), what she wears only swaying, rippling, rustling or settling («her dress sways a little in the breeze»), and her standing, sitting or turning in it.
// The controller's decisions before the review add what covers or dresses her more (closes, belts, wraps, ties, fastens it; drapes an outer layer or a cover over her; holds
// it closed or to her chest; picks up her jacket; rolls up or tugs at her sleeves; never where it ends less covered: around her waist, over a chair, a shirt tied up), her
// innocent posture with her chest, stomach or belly (it rises and falls; a hand rests on it; her arms cross over it; she hugs her knees to it; she lies or rolls onto it), and
// her outfit, clothes and clothing as what she wears. Anything else is refused: a garment moved, opened, lifted, lowered or removed is `takes-off`; her body shown is `content`.
// A text is read clause by clause (a comma, «and», «as», «while» … open the next, unless what follows only continues the last: «… up and off her shoulder»), the
// subject-first ones included («her robe falls open»); «it» and «them» are what she wears where the text names it, else her body where it names that; a clause with no subject
// of its own keeps the last one («her robe sways a little and opens»). Where the whitelist reads a clause as kept on, the takes-off forms' hit on it is lifted for a model's
// text («pulls her top down a little»). The bank, a scene text and the code's table keep the rules above (the sweeps hold all 271 and all 7).

/** The fabric of what she wears («her silk slips»); before another noun it names that noun's fabric («her silk scarf»), read as one with it. */
const FABRIC = new Set(["fabric", "fabrics", "material", "cloth", "silk", "satin", "lace", "chiffon"]);
/** What she wears beyond `GARMENT`: the garments a model may name that its list does not hold, and the folds or the fabric of one. */
const WORN_MORE = new Set([
  ...(
    "gown gowns sundress sundresses minidress minidresses shirtdress shirtdresses bathrobe bathrobes housecoat housecoats nightshirt nightshirts sweatshirt sweatshirts " +
    "undershirt undershirts miniskirt miniskirts sweatpants joggers chemise chemises negligee negligees corset corsets bustier bustiers vest vests romper rompers jumpsuit " +
    "jumpsuits playsuit playsuits overalls leotard leotards catsuit catsuits tunic tunics kaftan kaftans caftan caftans blazer blazers parka parkas poncho ponchos pullover " +
    "pullovers turtleneck turtlenecks knickers garter garters monokini monokinis sock socks folds outfit outfits clothes clothing"
  ).split(" "),
  ...FABRIC,
]);
/** The parts of what she wears («a button» and «a tie» are hers unless they are something else's: «the elevator button»). */
const WORN_PARTS = new Set(
  "hem hems hemline hemlines strap straps collar collars sleeve sleeves neckline necklines waistband waistbands zip zips zipper zippers sash sashes drawstring drawstrings bodice bodices clasp clasps buckle buckles belt belts button buttons tie ties".split(
    " ",
  ),
);
/** A part that is mostly a verb («lets her hand slip»): hers only after «her», after a garment, or «of» a garment («the slip of her dress»). */
const PARTS_IF_HERS = new Set(["slip", "slips"]);
/** What she lies under: pulled up it covers her, pushed down it uncovers her. */
const COVERS = new Set(["sheet", "sheets", "bedsheet", "bedsheets", "blanket", "blankets", "duvet", "duvets", "quilt", "quilts", "comforter", "comforters"]);
/** Her body the whitelist reads; «skin» and «back» only bare. */
const BODY_WORDS = new Set(["cleavage", "midriff", "navel", "thigh", "thighs", "bust", "underboob", "sideboob"]);
/** Her chest, stomach or belly: her body too, but also what she breathes with, lies on or crosses her arms over (the controller's decision 2, the prone frames). */
const TRUNK_WORDS = new Set(["chest", "stomach", "belly"]);
const BODY_IF_BARE = new Set(["skin", "back"]);
/** Whose part is not hers: a strap, a zip or a belt of something she holds, sits in or wears on her feet («the strap of her bag», «the seat belt»). */
const NOT_HERS = new Set([
  ...NOT_WORN,
  ..."seat watch camera guitar suitcase luggage shoe shoes sandal sandals boot boots heel heels sneaker sneakers helmet leash door window curtain curtains tent umbrella paper elevator lift remote doorbell keyboard".split(
    " ",
  ),
]);
/** «top» is no garment before these («her top lip»), beside the ones `GARMENT` itself skips. */
const TOP_NOT = new Set(["lip", "lips", "teeth", "tooth", "row", "corner", "half", "floor", "drawer", "lid"]);

/**
 * Which way a garment covers her: pulled up (what covers her legs, a strap, a waistband, a neckline, a towel, a sheet), pulled down (a hem, a sleeve, and a top, which alone
 * may also be tucked in), or neither (a skirt, a dress, a robe, a camisole: tucked, lifted or lowered, it bares her); or her body (`TRUNK`: her chest, stomach or belly).
 */
type WornClass = "UP" | "DOWN" | "TOP" | "WORN" | "BODY" | "TRUNK";
const isBody = (found: WornClass | null): boolean => found === "BODY" || found === "TRUNK";
const UP_WORN = new Set([...LOWER_WEAR, "waistband", "waistbands", "strap", "straps", "neckline", "necklines", "collar", "collars", "zip", "zips", "zipper", "zippers", "towel", "towels", ...COVERS]);
const DOWN_WORN = new Set(["hem", "hems", "hemline", "hemlines", "sleeve", "sleeves"]);
const TOP_WORN = new Set(
  "top tops shirt shirts t-shirt t-shirts tee tees blouse blouses sweater sweaters jumper jumpers sweatshirt sweatshirts undershirt undershirts turtleneck turtlenecks pullover pullovers".split(
    " ",
  ),
);

const DETERMINERS = new Set(["her", "the", "a", "an", "its", "one", "both", "some", "each"]);
const PRONOUNS = new Set(["it", "them", "they"]);
const ADVERBS = "slowly gently softly slightly carefully lightly neatly calmly absently idly casually smoothly lazily quietly tenderly delicately deliberately playfully shyly just still again";
const ADVERB_SET = new Set(ADVERBS.split(" "));
/** The words that open a new clause. */
const CLAUSE_OPENERS = new Set([",", "and", "as", "while", "when", "until", "till", "but", "so", "then", "or", "before"]);
/** A would-be clause that opens with one of these continues the last one («… up and off her shoulder»): it is read with it, its opener included. */
const CONTINUES = new Set(
  "up down off out away open apart aside back over higher lower closer tighter upward upwards downward downwards into onto from to toward towards across along past through under around above below in on with at by".split(
    " ",
  ),
);
/** Words that are never a modifier inside what she wears («her silk robe»): a walk back from a garment stops at them. */
const FUNCTION_WORDS = new Set([...DETERMINERS, ...PRONOUNS, ...ADVERB_SET, ...CLAUSE_OPENERS, ...CONTINUES, "she", "little", "bit", "of"]);

/**
 * Whether the word at `i` is a garment: `GARMENT` (read with the two words after it, so «her top knee» stays none) or `WORN_MORE`; never one that only names a pocket or what
 * is not hers («her jacket pockets», «her dress shoes»).
 */
function garmentAt(tokens: readonly string[], i: number): boolean {
  const word = tokens[i] ?? "";
  const next = tokens[i + 1] ?? "";
  if (next === "pocket" || next === "pockets" || NOT_HERS.has(next)) return false;
  if (WORN_MORE.has(word)) return true;
  if (/^tops?$/.test(word) && TOP_NOT.has(next)) return false;
  return GARMENT.exec(tokens.slice(i, i + 3).join(" "))?.index === 0;
}

/** The words of «of …» at `i` («of her small bag» → small, bag), past its determiners; none when `i` is not «of». */
const ofObject = (tokens: readonly string[], i: number): string[] => (tokens[i] === "of" ? tokens.slice(i + 1, i + 5).filter((word) => !DETERMINERS.has(word)).slice(0, 3) : []);

/**
 * The class of the word at `i` when it names what she wears or her body, else null. `vAt` is the clause's verb, never an anchor («she zips the bag», «she dresses»);
 * `pronoun` is what «it» and «them» name in this text, if anything.
 */
function anchorAt(tokens: readonly string[], i: number, vAt: number, pronoun: WornClass | null): WornClass | null {
  if (i === vAt) return null;
  const word = tokens[i] ?? "";
  const prev = tokens[i - 1] ?? "";
  const ofWhat = ofObject(tokens, i + 1);
  const classOf = (w: string): WornClass => (UP_WORN.has(w) ? "UP" : DOWN_WORN.has(w) ? "DOWN" : TOP_WORN.has(w) ? "TOP" : "WORN");
  if (TRUNK_WORDS.has(word)) return word === "chest" && tokens[i + 1] === "of" ? null : "TRUNK";
  if (BODY_WORDS.has(word)) return "BODY";
  if (BODY_IF_BARE.has(word)) return prev === "bare" ? "BODY" : null;
  if (COVERS.has(word)) return tokens[i + 1] === "of" ? null : "UP";
  if (word === "covers") return prev === "the" || prev === "her" ? "UP" : null;
  if (WORN_PARTS.has(word) || PARTS_IF_HERS.has(word)) {
    if (NOT_HERS.has(prev) || ofWhat.some((w) => NOT_HERS.has(w))) return null;
    if (PARTS_IF_HERS.has(word) && !(prev === "her" || tokens[i - 2] === "her" || (i > 0 && garmentAt(tokens, i - 1)) || ofWhat.some((_, k) => garmentAt(ofWhat, k)))) return null;
    return classOf(word);
  }
  if (garmentAt(tokens, i)) return classOf(word);
  return PRONOUNS.has(word) ? pronoun : null;
}

/** The first word past the adverbs from `from`. */
function pastAdverbs(tokens: readonly string[], from: number): number {
  let i = from;
  while (ADVERB_SET.has(tokens[i] ?? "")) i++;
  return i;
}

/** Where a clause's verb is: past «she» or a pronoun and the adverbs; past the adverbs in a clause with no subject of its own; after the subject when it opens with one (-1). */
const verbAt = (clause: readonly string[]): number => {
  const first = clause[0] ?? "";
  if (first === "she" || PRONOUNS.has(first)) return pastAdverbs(clause, 1);
  return DETERMINERS.has(first) ? -1 : pastAdverbs(clause, 0);
};

/** A clause with each run of words that names what she wears or her body folded into one tag («the hem of her skirt» → `#DOWN`, «her silk robe» → `#WORN`). */
function tagged(tokens: readonly string[], pronoun: WornClass | null): string[] {
  const vAt = verbAt(tokens);
  const classes = tokens.map((_, i) => anchorAt(tokens, i, vAt, pronoun));
  const out: string[] = [];
  let i = 0;
  while (i < tokens.length) {
    if (classes[i] === null) {
      out.push(tokens[i] ?? "");
      i++;
      continue;
    }
    // Back to a determiner over at most two modifiers («her silk robe»); a bare noun stays alone («a peek of cleavage»).
    let start = i;
    for (let j = i - 1, mods = 0; j >= 0 && mods <= 2; j--, mods++) {
      const word = tokens[j] ?? "";
      if (DETERMINERS.has(word)) {
        start = j;
        break;
      }
      if (FUNCTION_WORDS.has(word) || j === vAt || classes[j] !== null) break;
    }
    // On over the anchors that follow («her bra strap»), then over «of» what she wears («the hem of her skirt»): the class is the first run's last word's.
    let end = i;
    while (classes[end + 1] != null) end++;
    const head = classes[end] ?? "WORN";
    // A fabric before a noun names that noun's («her silk scarf», «her silk slips»): read as one, so a whitelisted verb still reaches it and any other verb is refused.
    const after = tokens[end + 1];
    if (FABRIC.has(tokens[end] ?? "") && after !== undefined && !FUNCTION_WORDS.has(after) && end + 1 !== vAt) end++;
    if (tokens[end + 1] === "of") {
      for (let k = end + 2; k <= end + 5 && k < tokens.length; k++) {
        if (classes[k] != null) {
          end = k;
          while (classes[end + 1] != null) end++;
          break;
        }
        const word = tokens[k] ?? "";
        if (FUNCTION_WORDS.has(word) && !DETERMINERS.has(word)) break;
      }
    }
    out.splice(out.length - (i - start), i - start, `#${head}`);
    i = end + 1;
  }
  return out;
}

const ADV = `(?:${ADVERBS.split(" ").join("|")})`;
const MANNER = String.raw`(?:${ADV}|a little|a bit|into place|in place|back into place|back in place|with (?:one|both) hands?|with her (?:fingers|fingertips|hand|hands|thumb|thumbs))`;
const SHOULDER = String.raw`(?:(?:back )?(?:on|onto|over) her shoulders?)`;
const WORN_TAG = "#(?:UP|DOWN|TOP|WORN)";
const BODY_TAG = "#(?:BODY|TRUNK)";
const SMALL_WORDS = /\b(?:a little|a bit|slightly)\b/;
const SLEEVES = /\bsleeves?\b/;
const HEM = /\bhem/;
const DEBRIS = "(?:sand|dust|lint|crumbs?|fluff|hairs?|petals?|leaves|leaf|snow|snowflakes?|water|drops?|droplets?|dirt|grass|specks?)";
const WEAR_VERBS = "(?:turns?|turning|sways?|swaying|stands?|standing|sits?|sitting|smiles?|smiling|laughs?|laughing|walks?|walking|poses?|posing|relax(?:es)?|relaxing|rests?|resting|waits?|waiting|breathes?|breathing)";
/** What she may pick up (she holds it, never lifts what she wears): an outer layer. */
const PICKED_UP = /\b(?:jackets?|coats?|cardigans?|hoodies?|sweaters?|jumpers?|sweatshirts?|pullovers?|blazers?|parkas?|ponchos?|shawls?)\b/;
/** What she may drape over her: an outer layer, a towel or a cover. */
const DRAPED = /\b(?:jackets?|coats?|cardigans?|hoodies?|sweaters?|jumpers?|blazers?|ponchos?|shawls?|towels?|sheets?|blankets?|duvets?|quilts?)\b/;
/** What may follow the object: the manner, and `more`. */
const tail = (more: string): string => String.raw`(?: (?:${MANNER}${more === "" ? "" : `|${more}`}))*`;
/** «she», the adverbs, one of `verbs`, its particle, the adverbs, the object, the tail. */
const verbClause = (verbs: string, particles: string, object: string, more: string): RegExp =>
  new RegExp(String.raw`^she (?:${ADV} )*(?:${verbs})${particles === "" ? "" : `(?: (?:${particles}))?`} (?:${ADV} )*${object}${tail(more)}$`);
/** «she», the adverbs, a verb, then the rest as written (`rest` holds its own tags and words). */
const sheClause = (verbs: string, rest: string, more: string): RegExp => new RegExp(String.raw`^she (?:${ADV} )*(?:${verbs})(?: ${ADV})* ${rest}${tail(more)}$`);

/**
 * One form the whitelist names: the tagged clause it matches (tags in capitals, so a tag never reads as a word), and what the clause's own words must say («tugs … a little»,
 * «sleeves») or must not name («brushes off» a strap takes it off).
 */
interface WornForm {
  readonly form: RegExp;
  readonly needs?: readonly RegExp[];
  readonly unless?: RegExp;
}
const WORN_FORMS: readonly WornForm[] = [
  // adjusts, straightens, fixes (a strap back on her shoulder too).
  { form: verbClause("adjusts?|adjusting|straightens?|straightening|fix(?:es)?|fixing", "", WORN_TAG, SHOULDER) },
  // smooths (down, out; over her hips or thighs).
  { form: verbClause("smooth(?:s|es)?|smoothing", "down|out", WORN_TAG, String.raw`down|out|(?:over|across|down|along) (?:${BODY_TAG}|her (?:hips|legs|knees|lap|waist))`) },
  // tucks (in; into her jeans) a top, or what is pulled up to cover her (a strap, a towel, a sheet); never a skirt, a dress or a hem, which tucked up bares her.
  { form: verbClause("tucks?|tucking", "in", "#(?:TOP|UP)", `in|(?:in|into|under) ${WORN_TAG}|around her`) },
  // brushes (off) what she wears, but a strap, a waistband, a neckline, a collar or a towel (which «brushes off» takes off); or the sand off any of it.
  { form: verbClause("brush(?:es)?|brushing", "off|down", WORN_TAG, "down"), unless: /\b(?:straps?|waistbands?|necklines?|collars?|towels?)\b/ },
  { form: verbClause("brush(?:es)?|brushing", "", String.raw`(?:(?:the|some|a) )?${DEBRIS}(?: ${ADV})* (?:off|from) (?:${WORN_TAG}|${BODY_TAG})`, "") },
  // tugs (at) … a little; tugs at her sleeve (the controller's decision 1: a sleeve alone needs no small word).
  { form: verbClause("tugs?|tugging", "at", WORN_TAG, ""), needs: [SMALL_WORDS] },
  { form: verbClause("tugs?|tugging", "at", "#DOWN", ""), needs: [SLEEVES], unless: HEM },
  // pulls … down a little: a hem, a sleeve, a top.
  { form: verbClause("pulls?|pulling|tugs?|tugging", "down", "#(?:DOWN|TOP)", "down"), needs: [/\bdown\b/, SMALL_WORDS] },
  // pulls up what covers her legs, a strap, a waistband, a towel, a sheet («pulls the sheet a little higher», «slides the strap up», «pulls the towel up to her chest»).
  {
    form: verbClause("pulls?|pulling|tugs?|tugging|slides?|sliding", "(?:back )?up", "#UP", String.raw`(?:back )?up|higher|${SHOULDER}|to (?:${BODY_TAG}|her (?:chin|neck|shoulders?|waist|hips|knees))`),
    needs: [/\b(?:up|higher|on|onto|over)\b/],
  },
  // rolls or pushes up her sleeves (decision 1: sleeves only, never a hem).
  { form: verbClause("rolls?|rolling|push(?:es)?|pushing|pulls?|pulling", "up", "#DOWN", "up|to her elbows?"), needs: [/\bup\b/, SLEEVES], unless: HEM },
  // pulls or tugs it closer, tighter, around her or over her shoulders («tugs the coat closer», «pulls her jacket over her shoulders»).
  {
    form: verbClause("pulls?|pulling|tugs?|tugging", "", WORN_TAG, String.raw`closer|tighter|around her(?: (?:shoulders|body))?|${SHOULDER}`),
    needs: [/\b(?:closer|tighter|around|over|on|onto)\b/],
  },
  // zips, buttons or fastens (up).
  { form: verbClause("zips?|zipping|buttons?|buttoning|fastens?|fastening", "up", WORN_TAG, "up") },
  // Decision 1: closes, belts or wraps it (tighter, around her); ties it (tighter) unless it is a top, which tied is knotted up. Never around her waist: a jacket or a towel
  // there has come off her shoulders or her chest.
  { form: verbClause("clos(?:es?|ing)|belts?|belting|wraps?|wrapping", "", WORN_TAG, "tighter|closer|closed|shut|around her(?: (?:shoulders?|body))?") },
  { form: verbClause("ti(?:es?|ing)|tying", "", "#(?:UP|DOWN|WORN)", "tighter|closed|shut") },
  { form: sheClause("wraps?|wrapping", `herself(?: (?:tighter|closer))? in ${WORN_TAG}`, "") },
  // drapes an outer layer or a cover over or around her (never over a chair: off her; never a dress or a robe she wears, which draped hangs open).
  { form: verbClause("drapes?|draping", "", WORN_TAG, "(?:over|around|across) her(?: (?:shoulders?|body|legs|lap|knees))?"), needs: [/\b(?:over|around|across) her\b/, DRAPED] },
  // holds or clutches it (closed, to her chest, around her).
  { form: verbClause("holds?|holding|clutch(?:es)?|clutching", "", WORN_TAG, String.raw`closed|tighter|closer|(?:to|against) (?:#TRUNK|her body)|around her`) },
  // picks up an outer layer (she holds it; never her skirt, which picked up is lifted).
  { form: verbClause("picks?|picking", "up", WORN_TAG, "up|from (?:the|her) [a-z'-]+"), needs: [/\bup\b/, PICKED_UP] },
  // lets the strap settle on her shoulder.
  { form: new RegExp(String.raw`^she (?:${ADV} )*(?:lets?|letting) (?:${ADV} )*${WORN_TAG} settles?${tail(`${SHOULDER}|back`)}$`) },
  // stands, sits (up) or turns in it.
  { form: new RegExp(String.raw`^she (?:${ADV} )*${WEAR_VERBS}(?: (?:up|down|back))?(?: ${ADV})* in ${WORN_TAG}${tail("")}$`) },
  // what she wears sways, ripples, rustles or settles.
  {
    form: new RegExp(
      String.raw`^${WORN_TAG} (?:${ADV} )*(?:sways?|swaying|ripples?|rippling|rustles?|rustling|settles?|settling)${tail(String.raw`${SHOULDER}|in the (?:breeze|wind)|around her (?:legs|knees|ankles)`)}$`,
    ),
  },
  // Decision 2, innocent posture and breathing: her chest, stomach or belly rises or falls; a hand rests on it; her arms cross over it; she hugs her knees to it; she lies or
  // rolls onto it (the prone frames).
  { form: new RegExp(String.raw`^#TRUNK (?:${ADV} )*(?:rises?|rising|falls?|falling)${tail("with (?:each|every) breath")}$`) },
  { form: sheClause("rests?|resting|places?|placing|lays?|laying|puts?|putting|keeps?|keeping", `(?:a|one|her|both) (?:hand|hands|palm|palms)(?: ${ADV})* (?:on|over) #TRUNK`, "") },
  { form: sheClause("cross(?:es)?|crossing|folds?|folding|wraps?|wrapping", `her arms(?: ${ADV})* (?:over|across|around) #TRUNK`, "") },
  { form: sheClause("hugs?|hugging|pulls?|pulling|draws?|drawing|tucks?|tucking", `her knees(?: up)?(?: ${ADV})* (?:to|against|into) #TRUNK`, "") },
  { form: sheClause("lies|lie|lying|lays|rests?|resting|stays?|staying", "(?:(?:down|flat|face down) )?on #TRUNK", "") },
  { form: sheClause("rolls?|rolling|turns?|turning|flips?|flipping", "(?:(?:over|back) )?(?:onto|on) #TRUNK", "") },
];

/**
 * The whitelist's reading of a model's text: the clauses that move what she wears beyond it (`takesOff`), those that show her body (`shows`), and the indices of the clauses it
 * reads as kept on (`keptAt`: each names what she wears or her body and matches one of its forms).
 */
export interface WornBreaks {
  readonly takesOff: readonly string[];
  readonly shows: readonly string[];
  readonly keptAt: readonly number[];
}

/** A text's clauses: a comma or a joining word opens the next, unless the next only continues this one («… up and off her shoulder»). */
function clausesOf(text: string): string[][] {
  const tokens = text.toLowerCase().match(/[a-z0-9'-]+|,/g) ?? [];
  const clauses: string[][] = [[]];
  tokens.forEach((word, i) => {
    const current = clauses[clauses.length - 1] ?? [];
    if (CLAUSE_OPENERS.has(word) && current.length > 0 && !CONTINUES.has(tokens[pastAdverbs(tokens, i + 1)] ?? "")) clauses.push([]);
    else current.push(word);
  });
  return clauses.filter((clause) => clause.length > 0);
}

/** The whitelist's reading of a text (the section's comment). Pure; kept per text. */
export const wornBreaks = keptBy((text: string): WornBreaks => {
  const clauses = clausesOf(text);
  // «it» and «them» are what she wears where the text names a garment, else her body where it names her body («crosses her arms over her chest, pushing it up»), else nothing.
  const named = clauses.flatMap((clause) => clause.map((_, i) => anchorAt(clause, i, verbAt(clause), null)));
  const pronoun: WornClass | null = named.some((found) => found !== null && !isBody(found)) ? "WORN" : named.some(isBody) ? "BODY" : null;
  const takesOff: string[] = [];
  const shows: string[] = [];
  const keptAt: number[] = [];
  /** Who acts in the last clause: «she», what she wears (its tag), or someone or something else. */
  let subject = "she";
  clauses.forEach((clause, at) => {
    const words = tagged(clause, pronoun);
    const first = clause[0] ?? "";
    const opener = words[0] ?? "";
    // A clause opens with «she», with a pronoun or a determiner (what she wears, or something else), or with its verb (then its subject is the last clause's).
    if (first === "she" || PRONOUNS.has(first) || DETERMINERS.has(first)) subject = opener === "she" || opener.startsWith("#") ? opener : "other";
    const read = opener === subject || subject === "other" ? words : [subject, ...words];
    const tags = read.filter((word) => word.startsWith("#"));
    if (tags.length === 0) return;
    const said = read.join(" ");
    const plain = clause.join(" ");
    // The form reads the tagged clause; what it needs or refuses besides reads the clause's own words («sleeves», «jacket», «a little»).
    if (WORN_FORMS.some(({ form, needs = [], unless }) => form.test(said) && needs.every((need) => need.test(plain)) && unless?.test(plain) !== true)) {
      keptAt.push(at);
      return;
    }
    // The clause's subject when it is what she wears or her body, else the first thing it acts on.
    const acted = read[0]?.startsWith("#") === true ? read[0] : tags[0];
    (acted === "#BODY" || acted === "#TRUNK" ? shows : takesOff).push(plain);
  });
  return { takesOff, shows, keptAt };
});

/**
 * Whether the takes-off forms (`takesOff`, a blacklist) still refuse a model's text once the whitelist has read it (the controller's decision 6): their hit is lifted where
 * it falls only in clauses the whitelist reads as kept on («pulls her top down a little», «pulls up her bra strap», «pulls the towel up to her chest»), and stands anywhere
 * else, a text with no clothing word in it included («she slowly undresses»).
 */
function takesOffFormsStand(text: string): boolean {
  if (!takesOff(text)) return false;
  const { keptAt } = wornBreaks(text);
  if (keptAt.length === 0) return true;
  const rest = clausesOf(text).filter((_, at) => !keptAt.includes(at));
  return takesOff(rest.map((clause) => clause.join(" ")).join(", "));
}

/** The exposure words a text names: the bank's list and `EXPOSURE_MORE` for every source, and `EXPOSURE_MODEL` for a model's text. */
function exposureIn(text: string, modelText: boolean): string[] {
  return [
    ...exposureWordsIn(text),
    ...Array.from(text.matchAll(new RegExp(EXPOSURE_MORE)), (m) => m[0]),
    ...(modelText ? Array.from(text.matchAll(new RegExp(EXPOSURE_MODEL)), (m) => m[0]) : []),
  ];
}

/**
 * Whether a motion undresses her as its source is read, for the prompt (S5.WC2b). For a scene or code text, `takesOff` (so its prompt never moves). For a vision or own text:
 * the takes-off forms where the whitelist does not lift them, what the whitelist reads as moving what she wears beyond it, and (the controller's decision 5) exposure, by
 * the exposure lists or her body shown. Only an own idea on «Смелая» reaches a prompt with one (Q-H = 2): it goes to Kling alone, with «Nothing new appears.» and no
 * clothing clause.
 */
export function undressesBy(text: string, source: ClipMotionSource): boolean {
  if (source !== "vision" && source !== "own") return takesOff(text);
  const breaks = wornBreaks(text);
  return takesOffFormsStand(text) || breaks.takesOff.length > 0 || breaks.shows.length > 0 || exposureIn(text, true).length > 0;
}

const ownOnBold = (scope: Scope): boolean => scope.source === "own" && scope.frame.bold;

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
    // every other source and on every other frame. The bank's sweeps hold its own texts to the same lists. S5.WC2b: a model's text also takes `EXPOSURE_MODEL`.
    rule: "exposure",
    problem: "content",
    check: (text, scope) => {
      if (scope.source === "bank" || (scope.source === "own" && scope.frame.bold)) return null;
      const exposure = exposureIn(text, isModelText(scope));
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
    // Q-H = 2: only an own idea on a frame of «Смелая» may take clothing off. The bank never reads this rule (the bank is unchanged); a vision text never passes it. S5.WC2b
    // (decision 6): on a model's text the forms' hit is lifted where the whitelist reads the clause as kept on.
    rule: "takes-off",
    problem: "takes-off",
    check: (text, scope) =>
      scope.source !== "bank" && !(scope.source === "own" && scope.frame.bold) && (isModelText(scope) ? takesOffFormsStand(text) : takesOff(text))
        ? "takes clothing off, which only an own idea on a frame of «Смелая» may"
        : null,
  },
  {
    // S5.WC2b: a model's text moves what she wears only in the whitelist's ways (`wornBreaks`); beyond them it takes clothing off. Q-H = 2 as above.
    rule: "worn-verb",
    problem: "takes-off",
    check: (text, scope) => {
      if (!isModelText(scope) || ownOnBold(scope)) return null;
      const breaks = wornBreaks(text).takesOff;
      return breaks.length > 0 ? `moves what she wears beyond adjusting, smoothing, tucking or pulling it back into place (${words(breaks)})` : null;
    },
  },
  {
    // S5.WC2b: her body named with a verb the whitelist does not name shows it: content, but for an own idea on «Смелая» (as exposure).
    rule: "body-verb",
    problem: "content",
    check: (text, scope) => {
      if (!isModelText(scope) || ownOnBold(scope)) return null;
      const breaks = wornBreaks(text).shows;
      return breaks.length > 0 ? `shows her body (${words(breaks)})` : null;
    },
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
