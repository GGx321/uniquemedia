import { z } from "zod";
import { HairLength, POOL_TEXT_MAX, PoolTime, youthWords } from "../../engine";
import { CAPTURES, isHandCapture, LEGS_CAPTURES, posesFor, shotOf, type Capture } from "../captures";
import { boldContentLevel, contentProblems } from "../contentLine";
import { atOrBelow } from "../level";
import { bankMotionFindings, type BankMotionRule } from "../motionText";
import { momentAllowed } from "../render";
import {
  AWAY_ACTION_WORDS,
  BED_WORDS,
  CAMERA_WORDS,
  COLOUR_WORDS,
  CUE_BANNED_WORDS,
  DRESS_LENGTH,
  DRESS_OR_SKIRT,
  EXPRESSION_WORDS,
  FEET_UP_WORDS,
  GAZE_VERBS,
  GLANCE_BACK_WORDS,
  HAIR_COLOUR_WORDS,
  HAIR_WORDS,
  HELD_OBJECT_WORDS,
  HIGH_WORDS,
  HIPS_WORDS,
  isOwnerBannedOutfit,
  LEG_COVERING_OUTFIT,
  LEGS_UNSUITED_OUTFITS,
  LYING_START,
  PHONE_WORDS,
  SELFIE_WORDS,
  unfabricBottomsIn,
  VIEWER_GAZE,
  WALKS_AWAY_WORDS,
  YOUTH_PROPS,
} from "../words";
import { exposureWordsIn } from "../explicitWords";
import { BOLD_EXEMPT_LOOK, boldWordsIn, COVERS_HER, lingerieWordsIn, NO_STRAPS, openClassOf, OPENS_WITH_ARMS_UP, stockingWordsIn, swimwearWordsIn, tierOfGarment } from "./boldRules";
import { MOMENT_HAIRS, type BankCategory, type CategoryBank, type Level, type Moment, type Outfit } from "./types";

// 5a.2 (S5.6a, I5.21, I5.35; plan s5a2 r1.2): the banks' zod schemas. The shape is zod; every rule the plan names runs in a superRefine and reports
// `[rule] where: what`, so a test can name the rule a bad item breaks (banks/schema.test.ts) and a malformed bank fails loudly at load
// (banks/index.ts). The engine-only lists (the revealing words, the paper, screen and staging lists, the «silk pajamas» exemption) are swept by
// engine/scenes/banks.sweep.test.ts. Every bank text is at most POOL_TEXT_MAX characters; a motion and a start pose at most MOTION_TEXT_MAX (they
// never reach the writer or a photo prompt); the locative `at` is not bound (it is never sent to the writer).
//
// 5a.3 (S5.9b2, plan s5a3 §6.4): two schemas, chosen by category. The five built-ins keep `categoryBankSchema` as it was, which refuses every «Смелая»-only
// field; the two «Смелая» banks validate against `boldBankSchema`: the same rules (the youth rule spares the exempt garment name of banks/boldRules.ts there, answer (b)) plus
// the «Смелая» rules below. The «Смелая» vocabulary (banks/boldRules.ts) is held out of the five by `boldOnlyHereProblems`.

/** The rule ids a problem names. */
export const BANK_RULE = {
  shape: "shape",
  text: "text",
  youth: "youth",
  youthProp: "youth-prop",
  hairColour: "hair-colour",
  selfie: "selfie",
  camera: "camera",
  duplicate: "duplicate",
  momentVerb: "moment-verb",
  momentShe: "moment-she",
  momentPhone: "moment-phone",
  phoneGaze: "phone-gaze",
  momentHair: "moment-hair",
  momentViewer: "moment-viewer",
  momentGaze: "moment-gaze",
  momentExpression: "moment-expression",
  backViewer: "back-viewer",
  awayAction: "away-action",
  backGlance: "back-glance",
  noLegwear: "no-legwear",
  captures: "captures",
  legsCapture: "legs-capture",
  legsOutfit: "legs-outfit",
  timerHands: "timer-hands",
  aboveLying: "above-lying",
  hipsHigh: "hips-high",
  repeat: "repeat",
  pinnedOutfit: "pinned-outfit",
  pinOnly: "pin-only",
  motionGrammar: "motion-grammar",
  motionStaging: "motion-staging",
  motionPhone: "motion-phone",
  mirrorWord: "mirror-word",
  mirrorPlace: "mirror-place",
  mirrorBack: "mirror-back",
  details: "details",
  detailGrammar: "detail-grammar",
  detailRepeat: "detail-repeat",
  at: "at",
  moments: "moments",
  messyOk: "messy-ok",
  times: "times",
  deck: "deck",
  deckCoverage: "deck-coverage",
  legwear: "legwear",
  denim: "denim",
  bottomFabric: "bottom-fabric",
  glamourBed: "glamour-bed",
  gazeGrammar: "gaze-grammar",
  gazePhone: "gaze-phone",
  gazeViewer: "gaze-viewer",
  cueGrammar: "cue-grammar",
  cueWord: "cue-word",
  cueGaze: "cue-gaze",
  hairGrammar: "hair-grammar",
  hairCap: "hair-cap",
  hairLengths: "hair-lengths",
  hairSport: "hair-sport",
  // 5a.3 (S5.9b2): the «Смелая» rules.
  boldOnlyHere: "bold-only-here",
  boldRoute: "bold-route",
  boldCoverage: "bold-coverage",
  boldLevels: "bold-levels",
  boldLegs: "bold-legs",
  boldArmsUp: "bold-arms-up",
  boldCovered: "bold-covered",
  water: "water",
  strap: "strap",
  // 5a.4 (S5.BA2): «Смелая» on every category.
  boldFloor: "bold-floor",
  waterPlace: "water-place",
  boldAllSeedream: "bold-all-seedream",
  openCoverage: "open-coverage",
  boldPrivate: "bold-private",
  implied: "implied",
  momentUnique: "moment-unique",
  companionSize: "companion-size",
  tierTable: "tier-table",
} as const;
type Rule = (typeof BANK_RULE)[keyof typeof BANK_RULE];

/** The viewer, the camera or the lens: a look at one of them is the viewer gaze's own rule, never a look elsewhere. */
const AT_THE_VIEWER = /\b(?:viewer|camera|lens)\b/i;
/**
 * S5.R4 round 3: the mirror, in a mirror selfie, is where her phone is, the viewer's own place: looking into it or facing it is no look elsewhere. Her reflection is herself: a look
 * at it («smiles at her reflection», «checks her reflection in the mirror») is one.
 */
const AT_THE_MIRROR = /\bmirror\b/i;
const AT_HER_REFLECTION = /\b(?:at|on|to)\s+her\s+reflection\b|\bat\s+herself\b|\bcheck(?:s|ing)?\s+her\s+reflection\b/i;
/** Where she stands, not what she looks at: «in the mirror» after the verb («stares at the sea in the mirror»). */
const IN_THE_MIRROR = /\bin\s+(?:the|a)\s+mirror\b/gi;
const HER_PHONE = /\bphone\b/i;
/** A look in the mirror that names a target of its own: «stares at the sea in the mirror». A bare «stares in the mirror» names none. */
const LOOK_AT_A_TARGET = /\b(?:look(?:s|ing)?|watch(?:es|ing)?|gaz(?:e|es|ing)|star(?:e|es|ing)|peer(?:s|ing)?|glanc(?:e|es|ing))\s+(?:(?:up|back)\s+)?(?:at|toward|towards|across|over|out|past|through|along|down)\s+(?:the|a|an|her|his|some)\b/i;
/** Eyes on something by the verb alone: she watches, gazes, stares or peers at it, admires it, takes in the view, eyes it. */
const EYES_ON = /\b(?:watch(?:es|ing)?|gaz(?:e|es|ing)|star(?:e|es|ing)|peer(?:s|ing)?|admir(?:e|es|ing))\b|\btak(?:es|ing) in the view\b|\beyes\s+(?:the|a)\b/i;
/** A look or a glance with a direction or a target («looks out at», «looking down the street»); a bare «looks up», «glancing back» or «over her shoulder» names none. */
const LOOK_TOWARD = /\b(?:look(?:s|ing)?|glanc(?:e|es|ing))\s+(?:(?:up|back)\s+)?(?:out|at|across|over(?!\s+her\s+shoulder\b)|down|along|into|toward|towards|through|around|past)\b/i;
/** Facing something she looks at («faces the sunset», «sits facing the sea»); facing away names nothing, and facing the mirror is the viewer's place (AT_THE_MIRROR). */
const FACING = /\bfac(?:es|ing)\s+(?:the|a)\s+[a-z]+/i;

/**
 * S5.R4: a look at something other than the viewer, anywhere in a moment's text or motion («sits on a ledge, watching dusk fall», «she looks out at the street»): the moment
 * carries its own gaze, or the template adds one that contradicts it («…watching dusk fall, looking up at the viewer»). Read clause by clause (a comma, a «;» or an «and» ends one):
 * a clause that looks at the viewer or the camera is the viewer gaze's own rule, a bare «looks up» or «glances back» names no target, and a clip that ends looking away («she smiles
 * and looks away») starts from a photo that may look at the viewer, so none of these is one (round 2 of the re-review read them both ways).
 */
export function looksElsewhere(text: string): boolean {
  return text.split(/[,.;]|\band\b/i).some((clause) => {
    if (AT_HER_REFLECTION.test(clause)) return true;
    // Her phone in the mirror is the viewer's place; «in the mirror» after anything else only says where she is, so the rest of the clause is read without it.
    if (HER_PHONE.test(clause) && AT_THE_MIRROR.test(clause)) return false;
    const looked = clause.replace(IN_THE_MIRROR, " ");
    if (looked !== clause) return LOOK_AT_A_TARGET.test(looked) || FACING.test(looked);
    return !AT_THE_VIEWER.test(looked) && !AT_THE_MIRROR.test(looked) && (EYES_ON.test(looked) || LOOK_TOWARD.test(looked) || FACING.test(looked));
  });
}

/** Raised or stretched arms, in a moment's text or its motion (the open-shirt rule below). A stretch of her legs, feet or toes is not one: her arms stay down. */
export const ARMS_UP = /\barms?\b[^.]*\bup\b|\bstretch\w*\b(?![^.]*\b(?:legs?|feet|foot|toes?|ankles?)\b)/i;

/** A motion's and a start pose's bound (plan I5.21, 5b.1 QV-5): the approved Kling wording, «she slowly lifts her hips behind her and lowers them», fits. */
export const MOTION_TEXT_MAX = 60;

/**
 * The verbs a moment may open with: third-person present, so «she {moment}» reads as a sentence. A new verb is added here on purpose (the
 * grammar test is a pinned list, plan s5a2 §5.1).
 */
export const MOMENT_VERBS: readonly string[] = [
  "adjusts", "applies", "breaks", "brushes", "carries", "catches", "checks", "crosses", "crouches", "curls", "dangles", "dries", "drinks", "eats", "fastens",
  "fixes", "grabs", "holds", "jogs", "kneels", "laces", "laughs", "leans", "lets", "lies", "lifts", "looks", "lowers", "opens", "packs", "pats", "picks", "pours", "pulls",
  "puts", "reaches", "rests", "rolls", "rubs", "scrolls", "settles", "shades", "sips", "sits", "slices", "slips", "smiles", "sprays", "stands",
  "steps", "stirs", "stops", "stretches", "sweeps", "takes", "ties", "tucks", "turns", "twirls", "unpacks", "waits", "walks", "waters", "wipes", "wraps", "wrings",
];

const PRINTABLE = /^[\x20-\x7e]+$/;
const DETAIL_START = /^(a|an|the|her|some|two)\s/;
const AT_START = /^(in|on|at|by|against|inside|outside|under|near|beside|along|behind)\s/;
const GAZE_START = /^(looking|glancing|giving|her eyes|eyes|checking)\b/;
const CUE_START = /^(?:(?:a|an|one|her)\s|mid-)/;
const CUE_GAZE = /\b(look\w*|glanc\w*|gaz\w*|star(?:e|es|ing)|eyes?|viewer|camera|lens|phone)\b/i;
const HAIR_START = /^(in|half|tucked|pinned|blow-dried|a little|twisted|loose|worn|swept|down|braided|clipped|tied)\b/;
const MIRROR = /mirror/i;
const VIEWER = /\bviewer\b/i;

type Add = (rule: Rule, where: string, what: string) => void;

function adder(ctx: z.RefinementCtx): Add {
  return (rule, where, what) => ctx.addIssue({ code: "custom", message: `[${rule}] ${where}: ${what}`, path: [] });
}

/** The youth words of a bank text: the descriptor scope; in a «Смелая» bank the bold content line's, which spares the exempt garment name of banks/boldRules.ts (answer (b)). */
function youthOf(text: string, bold: boolean): string[] {
  if (!bold) return youthWords(text, "descriptor");
  return contentProblems(text, boldContentLevel()).find((problem) => problem.reason === "youth-word")?.words ?? [];
}

/** The checks every bank text takes: printable, at most `max` characters (POOL_TEXT_MAX unless said; null: unbound), no youth word or prop, no hair colour, no selfie word, no camera. */
function checkText(add: Add, where: string, text: string, max: number | null = POOL_TEXT_MAX, bold = false): void {
  if (text.trim() !== text || text.length === 0 || !PRINTABLE.test(text)) add(BANK_RULE.text, where, "must be plain printable ASCII with no edge space");
  if (max !== null && text.length > max) add(BANK_RULE.text, where, `must be at most ${max} characters`);
  const youth = youthOf(text, bold);
  if (youth.length > 0) add(BANK_RULE.youth, where, `names a youth word (${youth.join(", ")})`);
  if (YOUTH_PROPS.test(text)) add(BANK_RULE.youthProp, where, "names a youth prop");
  if (HAIR_COLOUR_WORDS.test(text)) add(BANK_RULE.hairColour, where, "names a hair colour or a dye");
  if (SELFIE_WORDS.test(text)) add(BANK_RULE.selfie, where, "says selfie or front camera, which draws a phone");
  if (CAMERA_WORDS.test(text)) add(BANK_RULE.camera, where, "names a camera or a lens");
}

const isMirrorCapture = (capture: Capture): boolean => shotOf(capture) === "mirror";

/** Words a moment may share with its place: function words and the plain adjectives («small», «low»), never the place's nouns. */
const SHARED_WORDS = new Set([
  "her", "his", "the", "and", "with", "from", "into", "onto", "over", "under", "back", "down", "out", "off", "one", "two", "some", "little", "bit", "for",
  "after", "before", "while", "way", "its", "side", "toward", "towards", "against", "along", "behind", "near", "nearby", "inside", "outside", "through",
  "around", "across", "past", "above", "below", "ready", "small", "big", "low", "high", "old", "new", "light", "dark", "wet", "warm", "open", "quiet",
  "cozy", "soft", "plain", "ordinary", "full", "long", "short", "wide", "front", "edge", "top", "end", "own", "other", "each", "just", "still", "again",
]);

/** A word's singular, roughly: enough to see «stairs» and «stair», «benches» and «bench» as one noun. */
function singular(word: string): string {
  if (word.endsWith("ies")) return `${word.slice(0, -3)}y`;
  if (/(?:ch|sh|ss|x)es$/.test(word)) return word.slice(0, -2);
  if (word.endsWith("s") && !word.endsWith("ss")) return word.slice(0, -1);
  return word;
}

/** The nouns (and other content words) of a text; a moment's opening verb is skipped. */
function contentWords(text: string, skipVerb: boolean): Set<string> {
  const words = text.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) ?? [];
  return new Set((skipVerb ? words.slice(1) : words).filter((w) => w.length >= 3 && !SHARED_WORDS.has(w)).map(singular));
}

/** The words of a text as it spells them (no singular): «lockers» beside «locker room» is a different word, «path» beside «path» is not. */
function plainWords(text: string): string[] {
  return (text.toLowerCase().match(/[a-z]+(?:-[a-z]+)*/g) ?? []).filter((w) => w.length >= 3 && !SHARED_WORDS.has(w));
}

/** The bank's rule id of each motion rule of the one check (shared/scenes/motionText.ts). */
const MOTION_RULE_IDS: Readonly<Record<BankMotionRule, Rule>> = {
  printable: BANK_RULE.text,
  length: BANK_RULE.text,
  youth: BANK_RULE.youth,
  "youth-prop": BANK_RULE.youthProp,
  "hair-colour": BANK_RULE.hairColour,
  selfie: BANK_RULE.selfie,
  camera: BANK_RULE.camera,
  "she-her": BANK_RULE.motionGrammar,
  small: BANK_RULE.motionGrammar,
  "one-movement": BANK_RULE.motionGrammar,
  staging: BANK_RULE.motionStaging,
  "phone-moment": BANK_RULE.motionPhone,
};

/**
 * S5.WC2 (plan s5b2 I5.66): a motion is held to the one motion check, the same that holds a code motion, a vision suggestion and the owner's idea; this adapter names each finding
 * with the bank's own rule id, in the check's words and order (banks/motionAdapter.test.ts pins them to the lines this loader wrote before). A start pose is a text, not a motion.
 */
function checkMotion(add: Add, where: string, moment: Moment, bold: boolean): void {
  for (const finding of bankMotionFindings(moment.motion, bold ? boldContentLevel() : "ordinary", moment.phone === true)) add(MOTION_RULE_IDS[finding.rule], `${where} (motion)`, finding.what);
  if (moment.startPose !== undefined) checkText(add, `${where} (start pose)`, moment.startPose, MOTION_TEXT_MAX, bold);
}

function checkMoment(add: Add, where: string, moment: Moment, place: { room?: true | undefined; mirror?: true | undefined }, outfits: ReadonlySet<string>, bold: boolean): void {
  const text = moment.text;
  checkText(add, where, text, POOL_TEXT_MAX, bold);
  const verb = /^[a-z]+/.exec(text)?.[0] ?? "";
  if (!MOMENT_VERBS.includes(verb)) add(BANK_RULE.momentVerb, where, `must open with a pinned third-person verb, not «${verb}»`);
  if (/\bshe\b/i.test(text)) add(BANK_RULE.momentShe, where, "must not name «she»: the template does");
  if ((moment.phone === true) !== PHONE_WORDS.test(text)) add(BANK_RULE.momentPhone, where, "carries the phone flag exactly when it names her phone");
  if (moment.phone === true && moment.gaze !== "own") add(BANK_RULE.phoneGaze, where, "a phone moment carries its own gaze (her eyes are on the phone)");
  if ((moment.hair === "own") !== HAIR_WORDS.test(text)) add(BANK_RULE.momentHair, where, "carries the own-hair tag exactly when it names her hair");
  if ((moment.gaze === "viewer") !== (VIEWER.test(text) || VIEWER_GAZE.test(text))) add(BANK_RULE.momentViewer, where, "carries the viewer gaze exactly when it looks at the viewer");
  if (GAZE_VERBS.test(text) && moment.gaze !== "own" && moment.gaze !== "viewer") add(BANK_RULE.momentGaze, where, "a moment that opens on a look carries its own gaze");
  else if ((looksElsewhere(text) || looksElsewhere(moment.motion)) && moment.gaze !== "own") {
    add(BANK_RULE.momentGaze, where, "a moment whose text or motion looks at something other than the viewer carries its own gaze (the template would add one that contradicts it)");
  }
  if ((moment.expression === true) !== EXPRESSION_WORDS.test(text)) add(BANK_RULE.momentExpression, where, "carries the expression tag exactly when it shows her expression (it then takes no cue)");
  if (moment.angle === "back" && moment.gaze === "viewer") add(BANK_RULE.backViewer, where, "a moment seen from behind cannot look at the viewer");
  // C3′ (the owner: «просто стоит спиной без какой-либо позы»): a frame from behind or in profile shows what she is doing.
  // Review (C3′ round 2): and never walks away from the camera, which is the R2#01 frame again whatever her hand holds on the way.
  if ((moment.angle === "back" || moment.angle === "profile") && (!AWAY_ACTION_WORDS.test(text) || WALKS_AWAY_WORDS.test(text))) {
    add(BANK_RULE.awayAction, where, "a moment seen from behind or in profile names what she is doing (her hands, arms or hair, a strap or an earring, a stretch, a railing, her knees or legs, a turn to look), never walking away");
  }
  if (GLANCE_BACK_WORDS.test(text) && moment.angle !== "three-quarter") add(BANK_RULE.backGlance, where, "a glance back over her shoulder turns her face to the camera: a three-quarter moment, never from behind or in profile");
  if (moment.messyOk === true && place.room !== true) add(BANK_RULE.messyOk, where, "only a room's moment may be messy");
  if (FEET_UP_WORDS.test(text) && moment.noLegwear !== true) add(BANK_RULE.noLegwear, where, "a moment with her feet or legs up is tagged noLegwear (Grok refused legs up in tights)");

  const captures = moment.captures;
  if (captures.length === 0 || new Set(captures).size !== captures.length) add(BANK_RULE.captures, where, "names one or more captures, each once");
  if ((moment.twoHanded || moment.phone === true) && captures.some(isHandCapture)) add(BANK_RULE.captures, where, "a two-handed or phone moment fits no hand-held capture");
  if (moment.legs === undefined && captures.some((c) => LEGS_CAPTURES.includes(c))) add(BANK_RULE.legsCapture, where, "only a legs moment fits a legs capture («Ножки», 5a.2c)");
  if (moment.legs !== undefined) {
    // S5.8a review: a low angle under a mini reads as an upskirt shot, so a legs moment pins its outfits (shorts, trousers, leggings, joggers, midi and long dresses) and none is a mini.
    if ((moment.outfits?.length ?? 0) === 0) add(BANK_RULE.legsOutfit, where, "a legs moment pins the outfits it wears: shorts, trousers, leggings, joggers or a midi or long dress");
    for (const outfit of moment.outfits ?? []) {
      if (LEGS_UNSUITED_OUTFITS.test(outfit)) add(BANK_RULE.legsOutfit, where, `«${outfit}» is a mini or short dress or skirt, or worn as a dress: a low angle under it reads as an upskirt shot`);
      // A whitelist as well: a dress or a skirt names its length, because a blacklist cannot see «a wrap dress» of no length.
      else if (DRESS_OR_SKIRT.test(outfit) && !DRESS_LENGTH.test(outfit)) add(BANK_RULE.legsOutfit, where, `«${outfit}» is a dress or skirt of no stated length: a legs moment names midi, long or maxi`);
    }
  }
  if (captures.includes("timer") && HELD_OBJECT_WORDS.test(text)) add(BANK_RULE.timerHands, where, "a timer frame shows both of her hands empty: its moment holds nothing");
  if (captures.includes("above") && !LYING_START.test(text)) add(BANK_RULE.aboveLying, where, "a close selfie from above is taken as she lies there: its moment lies down");
  for (const said of [text, moment.motion, moment.startPose ?? ""]) {
    if (HIPS_WORDS.test(said) && HIGH_WORDS.test(said)) add(BANK_RULE.hipsHigh, where, "her hips stay behind her in natural proportions, never high or above her head (the owner)");
  }
  if (MIRROR.test(text) && !captures.every(isMirrorCapture)) add(BANK_RULE.mirrorWord, where, "a moment that names a mirror fits mirror captures only");
  if (moment.mirrorBack === true && !captures.every((c) => c === "mirror-hidden")) add(BANK_RULE.mirrorBack, where, "back or side to the mirror fits the phone-over-face mirror frame only (only her reflection shows; a plain mirror selfie keeps her face clear)");
  if (captures.some(isMirrorCapture) && place.mirror !== true) add(BANK_RULE.mirrorPlace, where, "a mirror capture needs a mirror place");
  for (const outfit of moment.outfits ?? []) if (!outfits.has(outfit)) add(BANK_RULE.pinnedOutfit, where, `pins «${outfit}», which is not one of the category's outfits`);
  checkMotion(add, where, moment, bold);
}

const CaptureSchema = z.enum(CAPTURES);

const MOMENT_SHAPE = {
  text: z.string(),
  motion: z.string(),
  startPose: z.string().optional(),
  captures: z.array(CaptureSchema),
  twoHanded: z.boolean(),
  phone: z.literal(true).optional(),
  messyOk: z.literal(true).optional(),
  level: z.literal("flirty").optional(),
  angle: z.enum(["three-quarter", "profile", "back"]).optional(),
  gaze: z.enum(["own", "viewer", "focus"]).optional(),
  hair: z.enum(MOMENT_HAIRS).optional(),
  expression: z.literal(true).optional(),
  handAtFace: z.literal(true).optional(),
  outdoor: z.literal(true).optional(),
  object: z.literal(true).optional(),
  outfits: z.array(z.string()).optional(),
  legs: z.strictObject({ framing: z.literal("legs").optional() }).optional(),
  noLegwear: z.literal(true).optional(),
  mirrorBack: z.literal(true).optional(),
};
const MomentSchema = z.strictObject(MOMENT_SHAPE);

const PLACE_SHAPE = {
  name: z.string(),
  at: z.string(),
  times: z.array(PoolTime),
  mirror: z.literal(true).optional(),
  room: z.literal(true).optional(),
  lamp: z.literal(true).optional(),
  details: z.array(z.string()),
};
const PlaceSchema = z.strictObject({ ...PLACE_SHAPE, moments: z.array(MomentSchema) });

const OUTFIT_SHAPE = { text: z.string(), showsLegs: z.literal(true).optional(), pinOnly: z.literal(true).optional() };
const LEGWEAR_SHAPE = { items: z.array(z.string()), share: z.number() };

// 5a.3 (S5.9b2): what a «Смелая» bank may carry beyond the five's shapes: a level up to bold, the Seedream route, a coverage sentence, the water tag, the bold legwear.
const BOLD_LEVEL = z.enum(["flirty", "bold"]).optional();
const ROUTE = z.literal("seedream").optional();
// 5a.4 (S5.BA2, plan s5a4 §5.2, §5.5, r2.1 N3): the fields S5.BA1 put on the bank types, a place's `water` and an item's implied `tier` and `openCoverage`; their rules are below.
const TIER = z.literal("implied").optional();
const BoldMomentSchema = z.strictObject({
  ...MOMENT_SHAPE,
  level: BOLD_LEVEL,
  route: ROUTE,
  coverage: z.string().optional(),
  openCoverage: z.string().optional(),
  tier: TIER,
  water: z.literal(true).optional(),
  details: z.array(z.string()).optional(),
});
const BoldPlaceSchema = z.strictObject({ ...PLACE_SHAPE, water: z.literal(true).optional(), moments: z.array(BoldMomentSchema) });

/** The rules every bank is held to, the five's and the «Смелая» ones (`bold`: the exempt garment name is spared, and stockings belong on the bold legwear). */
function bankRules(bank: CategoryBank, add: Add, category: BankCategory | null, bold: boolean): void {
  const names = bank.places.map((p) => p.name);
  if (new Set(names).size !== names.length) add(BANK_RULE.duplicate, "places", "two places share a name");
  const outfitTexts = bank.outfits.map((o) => o.text);
  if (new Set(outfitTexts).size !== outfitTexts.length) add(BANK_RULE.duplicate, "outfits", "an outfit is given twice");
  bank.outfits.forEach((outfit, i) => {
    checkText(add, `outfits[${i}]`, outfit.text, POOL_TEXT_MAX, bold);
    if (isOwnerBannedOutfit(outfit.text)) add(BANK_RULE.denim, `outfits[${i}]`, "no denim shorts and no denim skirts (the owner)");
    // C3′: Grok draws a skirt or shorts named without its fabric as denim (R3#03, R4#04); the probe drew none once the outfit named one.
    if (unfabricBottomsIn(outfit.text).length > 0) add(BANK_RULE.bottomFabric, `outfits[${i}]`, `«${outfit.text}» names a skirt, shorts or skort without its fabric, which Grok draws as denim: name it («a knit mini», «cotton sleep shorts»)`);
    if (outfit.showsLegs === true && LEG_COVERING_OUTFIT.test(outfit.text)) add(BANK_RULE.legwear, `outfits[${i}]`, `«${outfit.text}» covers her legs, so it does not show them: no socks or tights go over trousers, jeans, joggers or leggings`);
  });
  if (bank.legwear !== undefined) {
    bank.legwear.items.forEach((item, i) => {
      checkText(add, `legwear[${i}]`, item, POOL_TEXT_MAX, bold);
      // I5.29: knee-high socks, thigh-high socks and sheer tights; stockings come with «Смелая» (5a.3), on the bold legwear only.
      if (/\bstockings?\b/i.test(item)) add(BANK_RULE.legwear, `legwear[${i}]`, bold ? "stockings ride on the bold legwear only (legwear.bold.items)" : "stockings wait for «Смелая» (5a.3): legwear is socks or sheer tights");
    });
    if (bank.legwear.items.length === 0) add(BANK_RULE.legwear, "legwear", "names one item at least");
    if (!(bank.legwear.share > 0 && bank.legwear.share <= 1)) add(BANK_RULE.legwear, "legwear", "goes on a share of the slots above 0 and at most 1");
    if (!bank.outfits.some((o) => o.showsLegs === true)) add(BANK_RULE.legwear, "legwear", "needs an outfit that shows her legs");
  }
  const pinned = new Set(bank.places.flatMap((p) => p.moments.flatMap((m) => m.outfits ?? [])));
  for (const outfit of bank.outfits) {
    if (outfit.pinOnly === true && !pinned.has(outfit.text)) add(BANK_RULE.pinOnly, "outfits", `«${outfit.text}» is pin-only, but no moment pins it`);
  }
  for (const capture of bank.captureDeck) if (LEGS_CAPTURES.includes(capture)) add(BANK_RULE.deck, "captureDeck", `«${capture}» is a legs capture: «Ножки» deals it apart (5a.2c)`);
  for (const capture of new Set(bank.captureDeck)) {
    const taken = bank.places.some((place) => (!isMirrorCapture(capture) || place.mirror === true) && place.moments.some((m) => m.captures.includes(capture) && m.legs === undefined && m.level === undefined));
    if (!taken) add(BANK_RULE.deckCoverage, "captureDeck", `no ordinary moment at a place it can land on takes «${capture}»`);
  }

  const outfits = new Set(outfitTexts);
  for (const place of bank.places) {
    const where = place.name;
    checkText(add, `${where}.name`, place.name, POOL_TEXT_MAX, bold);
    checkText(add, `${where}.at`, place.at, null, bold);
    if (MIRROR.test(place.name) || MIRROR.test(place.at)) add(BANK_RULE.mirrorWord, where, "a place must not name a mirror: only the mirror capture's own line does");
    if (!AT_START.test(place.at)) add(BANK_RULE.at, `${where}.at`, "opens with a preposition");
    if (place.times.length === 0 || place.times.includes("studio lighting")) add(BANK_RULE.times, `${where}.times`, "one or more times of day, never the stored «studio lighting»");
    if (place.details.length < 2 || place.details.length > 3) add(BANK_RULE.details, `${where}.details`, "2 or 3 details");
    // S5.6R: a place that is not a room says its detail in the same sentence as its own phrase, so a detail never names that phrase's words again. S5.R4 round 3: a moment's own
    // details (a «Смелая» bank's) are held to the same rules.
    const ownWords = new Set(plainWords(place.at));
    const checkDetails = (at: string, details: readonly string[]): void => {
      for (const detail of details) {
        checkText(add, at, detail, POOL_TEXT_MAX, bold);
        if (!DETAIL_START.test(detail)) add(BANK_RULE.detailGrammar, at, `«${detail}» opens with a|an|the|her|some|two`);
        if (MIRROR.test(detail)) add(BANK_RULE.mirrorWord, at, "a detail must not name a mirror");
        const again = plainWords(detail).filter((w) => ownWords.has(w));
        if (place.room !== true && again.length > 0) add(BANK_RULE.detailRepeat, at, `«${detail}» names «${again.join("», «")}» again: the place's own phrase says it in the same sentence`);
      }
    };
    checkDetails(`${where}.details`, place.details);
    for (const moment of place.moments) {
      if (moment.details === undefined) continue;
      if (place.room === true) add(BANK_RULE.details, `${where}: ${moment.text}`, "a room says its details in its room phrase: a moment of a room has none of its own");
      if (moment.details.length < 2 || moment.details.length > 3) add(BANK_RULE.details, `${where}: ${moment.text}`, "2 or 3 details of its own");
      checkDetails(`${where}: ${moment.text}.details`, moment.details);
    }
    if (place.moments.length < 4) add(BANK_RULE.moments, `${where}.moments`, "at least 4 moments");
    const texts = place.moments.map((m) => m.text);
    if (new Set(texts).size !== texts.length) add(BANK_RULE.duplicate, `${where}.moments`, "a moment is given twice");
    place.moments.forEach((moment) => checkMoment(add, `${where}: ${moment.text}`, moment, place, outfits, bold));
    // Review L1: a sentence says the place («On her bed») and draws a detail; a moment that names either again reads «On her bed, she sits on the bed».
    for (const moment of place.moments) {
      // The moment's sentence says the place and one of the details it says: its own (S5.R4 round 3) or its place's.
      const placeWords = new Set([...contentWords(place.at, false), ...(moment.details ?? place.details).flatMap((d) => [...contentWords(d, false)])]);
      const again = [...contentWords(moment.text, true)].filter((w) => placeWords.has(w));
      if (again.length > 0) add(BANK_RULE.repeat, `${where}: ${moment.text}`, `names «${again.join("», «")}» again: the place or its details already say it`);
    }
    if (category === "glamour") {
      const all = [place.name, place.at, ...place.details, ...place.moments.map((m) => m.text)];
      if (all.some((t) => BED_WORDS.test(t))) add(BANK_RULE.glamourBed, where, "Glamour is an evening out: never on a bed");
    }
  }
}

function categoryBankSchema(category: BankCategory) {
  return z
    .strictObject({
      places: z.array(PlaceSchema).min(1),
      outfits: z.array(z.strictObject(OUTFIT_SHAPE)).min(1),
      legwear: z.strictObject(LEGWEAR_SHAPE).optional(),
      captureDeck: z.array(CaptureSchema).min(1),
    })
    .superRefine((bank, ctx) => bankRules(bank, adder(ctx), category, false));
}

// ---------- 5a.3 (S5.9b2, plan s5a3 §6.4): the «Смелая» rules ----------

/** A coverage sentence's bound: one sentence, appended to the scene sentence within SCENE_TEXT_MAX (600). */
export const COVERAGE_MAX = 200;
const ONE_SENTENCE = /^[A-Z][^.!?]*\.$/;
/** I5.10 extended: a negation puts what it negates into the prompt, so a coverage sentence says what covers her, never what does not show. */
const NEGATION = /\b(?:not|no|never|without|nothing|none|nor)\b|n't\b/i;
/** A moment in the water or at its edge (M6): it carries the `water` tag and pins swimwear. */
const WATER_WORDS = /\b(?:in|into|out of) the (?:water|sea|pool)\b|\b(?:ankle|knee|thigh|waist|chest)-deep\b|\bwades?\b|\bwaves?\b|\bshore\b|\bshallows\b|\bwet\b|\bswim\w*|\balong the edge\b/i;
/** S5.9c round 3: a place at the edge of the sea is wet whatever its moment says: every moment there is a water moment (the prompt says «at the edge of the sea», so no sweatshirt). */
const WET_PLACE = /\bedge of the (?:sea|water)\b|\bwater's edge\b|\bshoreline\b/i;
/** An action on a strap, in a moment's text. */
const STRAP_ACTION = /\bstraps?\b/i;
/** Review round 2: what is worn over swimwear, never in the water (a hat is no garment over it). */
const OVER_SWIMWEAR = /\b(?:shirts?|sweatshirts?|sarongs?|cover-ups?|kaftans?|pareos?|skirts?|shorts|dress(?:es)?|robes?|tees?|t-shirts?|hoodies?)\b/i;
const LEVELS: readonly Level[] = ["ordinary", "flirty", "bold"];
/** The fewest bold outfits a «Смелая» bank's general draw holds (I5.24: a bold plan is not one outfit). */
const BOLD_OUTFITS_MIN = 4;

function checkCoverage(add: Add, where: string, coverage: string): void {
  const at = `${where} (coverage)`;
  if (coverage.trim() !== coverage || !PRINTABLE.test(coverage)) add(BANK_RULE.boldCoverage, at, "plain printable ASCII with no edge space");
  if (coverage.length > COVERAGE_MAX) add(BANK_RULE.boldCoverage, at, `at most ${COVERAGE_MAX} characters`);
  if (!ONE_SENTENCE.test(coverage)) add(BANK_RULE.boldCoverage, at, "one sentence that opens with a capital and ends with «.»");
  if (NEGATION.test(coverage)) add(BANK_RULE.boldCoverage, at, "says what covers her, never what does not show (no not, no, never, without)");
  const youth = youthOf(coverage, true);
  if (youth.length > 0) add(BANK_RULE.youth, at, `names a youth word (${youth.join(", ")})`);
  if (SELFIE_WORDS.test(coverage) || CAMERA_WORDS.test(coverage)) add(BANK_RULE.camera, at, "names no camera, lens or selfie");
}

/** An item that names the «Смелая» vocabulary or is bold is drawn on Seedream, and only such an item is (I5.38: a slot is Seedream exactly when it drew one). */
function checkRoute(add: Add, where: string, item: { text: string; level?: "flirty" | "bold" | undefined; route?: "seedream" | undefined }): void {
  const words = boldWordsIn(item.text);
  const needs = words.length > 0 || item.level === "bold";
  if (needs && item.route !== "seedream") add(BANK_RULE.boldRoute, where, words.length > 0 ? `names «${words.join("», «")}»: it is drawn on Seedream (route seedream)` : "a bold item is drawn on Seedream (route seedream)");
  if (!needs && item.route !== undefined) add(BANK_RULE.boldRoute, where, "only an item that names lingerie, swimwear, stockings or satin, or is bold, is drawn on Seedream");
}

/**
 * bold-levels: every deck capture, at every pose it can take and at every level, has a moment and an outfit a slot can draw (the 0-null rule's data side). `said` names the bank read
 * (5a.4: the bank without its implied items, which an imported avatar never draws).
 */
function boldLevelsRules(bank: CategoryBank, add: Add, said: string): void {
  const moments = bank.places.flatMap((place) => place.moments.map((moment) => ({ moment, where: `${place.name}: ${moment.text}` })));
  const general = bank.outfits.filter((o) => o.pinOnly !== true && !isOwnerBannedOutfit(o.text));
  const wearable = (moment: Moment, level: Level): boolean =>
    moment.outfits !== undefined ? bank.outfits.some((o) => moment.outfits?.includes(o.text) === true && atOrBelow(o.level, level)) : general.some((o) => atOrBelow(o.level, level));
  for (const capture of new Set(bank.captureDeck)) {
    for (const pose of posesFor(capture)) {
      for (const level of LEVELS) {
        // S5.R4 round 2: a bold slot takes no moment under a cover (engine/scenes/fit.ts momentFits), so such a moment is no answer for one.
        const takes = (m: Moment): boolean => momentAllowed(m, capture, pose, level) && !(level === "bold" && (COVERS_HER.test(m.text) || COVERS_HER.test(m.motion)));
        const found = bank.places.some((place) => (!isMirrorCapture(capture) || place.mirror === true) && place.moments.some((m) => m.legs === undefined && takes(m) && wearable(m, level)));
        if (!found) add(BANK_RULE.boldLevels, "captureDeck", `«${capture}» at ${pose} has no moment and outfit a ${level} slot can draw${said}`);
      }
    }
  }
  // Every moment, at every level that may draw it (its own and above), has an outfit that level may wear: a moment that pins only outfits above its own level would pass the capture
  // check above and then throw at compose (`pinnedAt` in engine/scenes/fit.ts), so it fails here, at load.
  for (const { moment, where } of moments) {
    for (const level of LEVELS.filter((l) => atOrBelow(moment.level, l))) {
      if (!wearable(moment, level)) add(BANK_RULE.boldLevels, where, `has no outfit a ${level} slot can wear: it pins only outfits above ${level}${said}`);
    }
  }
  if (general.filter((o) => o.level === "bold").length < BOLD_OUTFITS_MIN) add(BANK_RULE.boldLevels, "outfits", `at least ${BOLD_OUTFITS_MIN} bold outfits in the general draw${said}`);
}

function boldBankRules(bank: CategoryBank, add: Add): void {
  const moments = bank.places.flatMap((place) => place.moments.map((moment) => ({ moment, where: `${place.name}: ${moment.text}`, place })));

  // bold-route and bold-coverage, outfits.
  bank.outfits.forEach((outfit, i) => {
    const where = `outfits[${i}] «${outfit.text}»`;
    checkRoute(add, where, outfit);
    if (outfit.coverage !== undefined) {
      if (outfit.route === undefined) add(BANK_RULE.boldCoverage, where, "a coverage sentence goes only on an item drawn on Seedream");
      checkCoverage(add, where, outfit.coverage);
    } else if (outfit.route === "seedream") {
      const pins = moments.filter(({ moment }) => moment.outfits?.includes(outfit.text) === true);
      if (outfit.pinOnly !== true || pins.length === 0 || pins.some(({ moment }) => moment.coverage === undefined)) {
        add(BANK_RULE.boldCoverage, where, "a Seedream outfit carries its coverage sentence, or is pin-only and every moment that pins it carries one");
      }
    }
    if (stockingWordsIn(outfit.text).length > 0) add(BANK_RULE.legwear, where, "stockings ride on the bold legwear only (legwear.bold.items)");
  });

  for (const { moment, where, place } of moments) {
    // bold-route and bold-coverage, moments.
    checkRoute(add, where, moment);
    if (moment.coverage !== undefined) {
      if (moment.route === undefined) add(BANK_RULE.boldCoverage, where, "a coverage sentence goes only on an item drawn on Seedream");
      checkCoverage(add, where, moment.coverage);
    }
    for (const said of [moment.text, moment.motion, moment.startPose ?? ""]) if (stockingWordsIn(said).length > 0) add(BANK_RULE.legwear, where, "stockings ride on the bold legwear only (legwear.bold.items)");
    // water (M6): a moment in the water pins swimwear, and only swimwear.
    if (moment.water === true) {
      if ((moment.outfits?.length ?? 0) === 0) add(BANK_RULE.water, where, "a water moment pins its swimwear");
      for (const outfit of moment.outfits ?? []) {
        if (swimwearWordsIn(outfit).length === 0) add(BANK_RULE.water, where, `«${outfit}» is not swimwear: in the water she wears a swimsuit or a bikini`);
        else if (OVER_SWIMWEAR.test(outfit)) add(BANK_RULE.water, where, `«${outfit}» wears something over the swimwear: in the water she wears only the swimsuit or the bikini`);
      }
    } else if (WATER_WORDS.test(moment.text) || WATER_WORDS.test(moment.motion) || WATER_WORDS.test(place.at)) add(BANK_RULE.water, where, "a moment in the water carries the water tag, and pins swimwear");
    else if (WET_PLACE.test(`${place.name} ${place.at}`)) add(BANK_RULE.water, where, "a moment at the edge of the sea carries the water tag, and pins swimwear (the place says she is at the sea)");
    // strap (S5.9c round 3): an action on a strap meets only outfits that have shoulder straps, so it pins its outfits, none of them strapless or without a top.
    if (STRAP_ACTION.test(moment.text) || STRAP_ACTION.test(moment.motion)) {
      if (moment.outfits === undefined) add(BANK_RULE.strap, where, "an action on a strap pins its outfits: the general draw has outfits with no shoulder straps");
      for (const outfit of moment.outfits ?? []) if (NO_STRAPS.test(outfit)) add(BANK_RULE.strap, where, `«${outfit}» has no shoulder straps: a strap action never meets it`);
    }
    // bold-arms-up (review of S5.9b2): with her arms up an open shirt does not stay closed over her chest, and (S5.R4) a crop top or a cropped tee rides up, so an arms-up moment pins its
    // outfits and none of them is one of these. The text and the motion are read apart: a stretch in one is not cancelled by her toes in the other. A pin-only outfit is never drawn
    // by a moment that does not pin it, so only the general draw's count for a moment that pins nothing.
    if (ARMS_UP.test(moment.text) || ARMS_UP.test(moment.motion)) {
      const open = bank.outfits.filter((o) => o.pinOnly !== true && OPENS_WITH_ARMS_UP.test(o.text)).map((o) => o.text);
      if (open.length > 0 && moment.outfits === undefined) add(BANK_RULE.boldArmsUp, where, `an arms-up moment pins its outfits, so it never draws «${open.join("», «")}» (raised arms open a shirt and lift a crop top)`);
      for (const outfit of moment.outfits ?? []) {
        if (OPENS_WITH_ARMS_UP.test(outfit)) add(BANK_RULE.boldArmsUp, where, `«${outfit}» is an open shirt or a crop top: with her arms up it does not stay over her chest`);
      }
    }
    // bold-covered (S5.R4): under a duvet or a blanket the outfit does not show, so a bold one would be a 2K frame paid for nothing (review: «curls up with a blanket, wearing a white
    // lace bra and panties»). A covering moment pins its outfits, and none of them is bold.
    if (COVERS_HER.test(moment.text) || COVERS_HER.test(moment.motion)) {
      if (moment.outfits === undefined) add(BANK_RULE.boldCovered, where, "a moment under a duvet or a blanket pins its outfits: the general draw would put a bold one under the cover");
      for (const outfit of moment.outfits ?? []) {
        if (bank.outfits.find((o) => o.text === outfit)?.level === "bold") add(BANK_RULE.boldCovered, where, `«${outfit}» is bold: under the cover it does not show, and the 2K frame is paid for nothing`);
      }
    }
    // bold-legs (M5, P-5a3 #6).
    if (moment.captures.includes("low-feet")) add(BANK_RULE.boldLegs, where, "no low-feet frame in a «Смелая» bank: her feet are her own look down (pov-legs) or the mirror's");
    // S5.R4 round 3 (re-review, HIGH): a legs moment by the mirror hides her face behind the phone (mirror-hidden, plan s5a3 §6.2). The plain mirror selfie showed her face on a frame
    // the face gate only marks (a legs frame is a «maybe»), never judges; the phone-over-face legs frame's pose phrase says nothing of her face (engine/scenes/assembler.ts).
    if (moment.legs !== undefined && moment.captures.includes("mirror")) {
      add(BANK_RULE.boldLegs, where, "a legs moment by the mirror hides her face behind the phone (mirror-hidden), never the plain mirror selfie: the face gate only marks a legs frame, it never judges it");
    }
    if (moment.legs !== undefined) {
      const pins = moment.outfits ?? [];
      if (pins.length < 4) add(BANK_RULE.boldLegs, where, "a legs moment pins at least 4 outfits");
      if (!bank.outfits.some((o) => pins.includes(o.text) && o.level === undefined)) add(BANK_RULE.boldLegs, where, "a legs moment pins an ordinary outfit, so a legs slot of every level has one to wear");
      // 5a.4 (P-BA L1 drew the sports set on a legs frame): plain underwear, the sports set and plain cotton, may join; lace and every lingerie above plain stay out.
      for (const outfit of pins) {
        if (lingerieWordsIn(outfit).length > 0 && tierOfGarment({ text: outfit }) !== "ordinary") add(BANK_RULE.boldLegs, where, `«${outfit}» is lingerie: a bold legs frame wears satin nightwear with stockings (P-5a3 #6), or plain underwear (P-BA L1)`);
      }
    }
  }

  boldLevelsRules(bank, add, "");

  // legwear: the stockings, on the bold legwear only.
  const boldLegwear = bank.legwear?.bold;
  if (boldLegwear !== undefined) {
    boldLegwear.items.forEach((item, i) => {
      checkText(add, `legwear.bold[${i}]`, item, POOL_TEXT_MAX, true);
      if (stockingWordsIn(item).length === 0) add(BANK_RULE.legwear, `legwear.bold[${i}]`, "the bold legwear is stockings");
    });
    if (boldLegwear.items.length === 0) add(BANK_RULE.legwear, "legwear.bold", "names one item at least");
    if (!(boldLegwear.share > 0 && boldLegwear.share <= 1)) add(BANK_RULE.legwear, "legwear.bold", "goes on a share of the bold slots above 0 and at most 1");
    // Review round 2, MEDIUM 4: the stockings go with the outfits named here, Seedream outfits that show her legs, never the cotton nightwear on the owner's model.
    if (boldLegwear.outfits.length === 0) add(BANK_RULE.legwear, "legwear.bold.outfits", "names the outfits the stockings go with");
    for (const text of boldLegwear.outfits) {
      const outfit = bank.outfits.find((o) => o.text === text);
      if (outfit === undefined) add(BANK_RULE.legwear, "legwear.bold.outfits", `«${text}» is not one of the bank's outfits`);
      else if (outfit.route !== "seedream" || outfit.showsLegs !== true) add(BANK_RULE.legwear, "legwear.bold.outfits", `«${text}»: the stockings go only with a Seedream outfit that shows her legs, never with the nightwear on the owner's model`);
    }
    // A bold legs slot wears the stockings (P-5a3 #6: satin with stockings), so every legs moment pins an outfit they go with.
    for (const { moment, where } of moments) {
      if (moment.legs !== undefined && !(moment.outfits ?? []).some((o) => boldLegwear.outfits.includes(o))) {
        add(BANK_RULE.boldLegs, where, "a legs moment pins an outfit the bold stockings go with, so a bold legs slot wears them");
      }
    }
  }
}

const BoldBankShape = z.strictObject({
    bold: z.literal(true),
    places: z.array(BoldPlaceSchema).min(1),
    outfits: z.array(z.strictObject({ ...OUTFIT_SHAPE, level: BOLD_LEVEL, route: ROUTE, coverage: z.string().optional(), openCoverage: z.string().optional(), tier: TIER })).min(1),
    legwear: z
      .strictObject({ ...LEGWEAR_SHAPE, bold: z.strictObject({ items: z.array(z.string()), share: z.number(), route: z.literal("seedream"), outfits: z.array(z.string()) }).optional() })
      .optional(),
    captureDeck: z.array(CaptureSchema).min(1),
  });

const boldBankSchema = BoldBankShape.superRefine((bank, ctx) => {
  const add = adder(ctx);
  bankRules(bank, add, null, true);
  boldBankRules(bank, add);
});

const GazeBankSchema = z
  .array(z.strictObject({ text: z.string(), kind: z.enum(["viewer", "away", "down", "hands", "mirror"]), phone: z.literal(true).optional(), level: z.literal("flirty").optional() }))
  .min(1)
  .superRefine((gazes, ctx) => {
    const add = adder(ctx);
    const texts = gazes.map((g) => g.text);
    if (new Set(texts).size !== texts.length) add(BANK_RULE.duplicate, "gaze", "a gaze is given twice");
    for (const gaze of gazes) {
      const where = `gaze «${gaze.text}»`;
      checkText(add, where, gaze.text);
      if (!GAZE_START.test(gaze.text)) add(BANK_RULE.gazeGrammar, where, "opens with looking|glancing|giving|her eyes|eyes|checking");
      if ((gaze.phone === true) !== PHONE_WORDS.test(gaze.text)) add(BANK_RULE.gazePhone, where, "carries the phone flag exactly when it names her phone");
      if (gaze.phone === true && (gaze.kind !== "mirror" || !/\bin the mirror\b/i.test(gaze.text))) add(BANK_RULE.gazePhone, where, "only a mirror gaze names her phone, and as her phone in the mirror");
      if ((gaze.kind === "viewer") !== VIEWER.test(gaze.text)) add(BANK_RULE.gazeViewer, where, "names the viewer exactly when it is a viewer gaze");
    }
  });

const CueBankSchema = z
  .array(z.strictObject({ text: z.string(), level: z.literal("flirty").optional(), captures: z.array(CaptureSchema).optional(), hand: z.literal(true).optional() }))
  .min(1)
  .superRefine((cues, ctx) => {
    const add = adder(ctx);
    const texts = cues.map((c) => c.text);
    if (new Set(texts).size !== texts.length) add(BANK_RULE.duplicate, "cues", "a cue is given twice");
    for (const cue of cues) {
      const where = `cue «${cue.text}»`;
      checkText(add, where, cue.text);
      if (!CUE_START.test(cue.text)) add(BANK_RULE.cueGrammar, where, "a noun phrase (a|an|one|her …) or «mid-…»");
      if (CUE_BANNED_WORDS.test(cue.text)) add(BANK_RULE.cueWord, where, "never sexy, seductive, sultry or sensual");
      if (CUE_GAZE.test(cue.text)) add(BANK_RULE.cueGaze, where, "an expression only: the gaze is its own clause");
      if (cue.captures !== undefined && (cue.captures.length === 0 || new Set(cue.captures).size !== cue.captures.length)) add(BANK_RULE.captures, where, "names one or more captures, each once");
    }
  });

const HairBankSchema = z
  .array(z.strictObject({ text: z.string(), lengths: z.array(HairLength), tied: z.boolean(), cap: z.literal(true).optional(), sport: z.literal(true).optional() }))
  .min(1)
  .superRefine((styles, ctx) => {
    const add = adder(ctx);
    const texts = styles.map((s) => s.text);
    if (new Set(texts).size !== texts.length) add(BANK_RULE.duplicate, "hair", "a style is given twice");
    for (const style of styles) {
      const where = `hair «${style.text}»`;
      checkText(add, where, style.text);
      if (!HAIR_START.test(style.text)) add(BANK_RULE.hairGrammar, where, "reads after «Today her hair is …»");
      if (COLOUR_WORDS.test(style.text)) add(BANK_RULE.hairColour, where, "a style names no colour at all (I5.25)");
      if (style.cap === true && style.tied) add(BANK_RULE.hairCap, where, "a cap style is worn loose");
      if (style.sport === true && !style.tied) add(BANK_RULE.hairSport, where, "a sporty style is tied: a ponytail, a bun, a braid, tied or pinned back");
      if (style.lengths.length === 0 || new Set(style.lengths).size !== style.lengths.length) add(BANK_RULE.hairLengths, where, "fits one or more hair lengths, each once");
    }
  });

function problemsOf(result: { success: true } | { success: false; error: z.ZodError }): string[] {
  if (result.success) return [];
  return result.error.issues.map((issue) => (issue.code === "custom" ? issue.message : `[${BANK_RULE.shape}] ${issue.path.join(".")}: ${issue.message}`));
}

/** Every problem of a category's bank, as `[rule] where: what`; empty when it is valid. Never throws. */
export function categoryBankProblems(bank: unknown, category: BankCategory): string[] {
  return problemsOf(categoryBankSchema(category).safeParse(bank));
}

/** Every problem of a «Смелая» bank (`nightwear`, `beach`), as `[rule] where: what`; empty when it is valid. Never throws. */
export function boldBankProblems(bank: unknown): string[] {
  return problemsOf(boldBankSchema.safeParse(bank));
}

// ---------- 5a.4 (S5.BA2, plan s5a4 §5.1.1, §5.2, §5.3, §5.4, §5.5, I5.71, I5.72, I5.74, I5.76): «Смелая» on every category ----------

/**
 * Which «Смелая» bank the 5a.4 rules read: a companion of the five, the custom categories' «rooms» or «by the water», or one of the two shipped banks. The size, privacy and legs rules
 * differ by kind; the floor, water, route, coverage, implied and tier rules hold every kind.
 */
export type BoldAnyKind = "companion" | "rooms" | "water" | "nightwear" | "beach";

/**
 * Every problem of a «Смелая» bank under the 5a.4 rules, as `[rule] where: what`, the 5a.3 ones included; empty when it is valid. `others` are the banks its moment texts must be
 * absent from (moment-unique: every other bank, the seven and the other new ones). Never throws.
 */
export function boldAnyProblems(bank: unknown, kind: BoldAnyKind, others: readonly unknown[] = []): string[] {
  return problemsOf(
    BoldBankShape.superRefine((parsed, ctx) => {
      const add = adder(ctx);
      bankRules(parsed, add, null, true);
      boldBankRules(parsed, add);
      boldAnyRules(parsed, add, kind, others);
    }).safeParse(bank),
  );
}

/** A place by the water, by what its phrase names (r2.1 N3): the sea, a pool, the beach, a shore, a lake. Such a place carries `water: true`. */
const WATER_AT = /\b(?:sea|seaside|ocean|pools?|poolside|beach|shore|shoreline|lake|lagoon|water)\b/i;

/**
 * I5.72: the private places a «Смелая» frame may be at outside a room: her own, the hotel's or the villa's balcony, terrace or window (the balcony of her hotel room), and the villa's own
 * pool. Read on a place's `at`.
 */
const PRIVATE_AT: readonly RegExp[] = [
  /\b(?:her|the hotel's|her hotel's|the villa's|her villa's)\s+(?:own\s+)?(?:balcony|terrace|window)\b/i,
  /\b(?:balcony|terrace|window)\s+of\s+(?:her|the)\s+(?:own\s+)?(?:hotel room|hotel|villa|room|flat|home)\b/i,
  /\b(?:the|her)\s+villa's\s+(?:own\s+)?pool\b/i,
  /\bpool\s+of\s+(?:her|the)\s+villa\b/i,
];

/**
 * r2.2 P5: the implied covers P-BA drew with the kept sentence only, the sheet, the foam and the bare back (a towel over her hips). No open item was probed for them, so every avatar
 * says their kept sentence: their `openCoverage` is their `coverage`. (An absent `openCoverage` is a frame with no sentence, which the probe allowed for the classes it drew open.)
 */
const KEPT_COVERS = /\b(?:sheet|bedsheet|foam)\b|\bover her hips\b/i;

/** The fewest of each a bank of the kind holds (plan s5a4 §5.2, §5.3.1): places, non-legs moments (the implied ones counted apart), by level, general outfits a tier, legs moments. */
const SIZE: Readonly<Record<"companion" | "rooms" | "water", { places: number; moments: number; ordinary: number; flirty: number; bold: number; outfits: number; legs: number }>> = {
  companion: { places: 4, moments: 24, ordinary: 10, flirty: 6, bold: 6, outfits: 3, legs: 4 },
  rooms: { places: 4, moments: 20, ordinary: 8, flirty: 4, bold: 4, outfits: 3, legs: 0 },
  water: { places: 3, moments: 12, ordinary: 4, flirty: 3, bold: 3, outfits: 3, legs: 0 },
};

const isSatinNightwear = (text: string): boolean => BOLD_EXEMPT_LOOK.some((phrase) => new RegExp(`\\b${phrase.replace(/ /g, "\\s+")}\\b`, "i").test(text));
const isSwimwear = (text: string): boolean => swimwearWordsIn(text).length > 0;
const isLingerie = (text: string): boolean => lingerieWordsIn(text).length > 0;

/** An open coverage's grammar: the kept coverage's, under its own rule id, and no exposure word (I5.76: Seedream refuses them, so a frame that says one is a frame the owner does not get). */
function checkOpenCoverage(add: Add, where: string, open: string, kept: string | undefined): void {
  const at = `${where} (open coverage)`;
  if (kept === undefined) add(BANK_RULE.openCoverage, at, "an open coverage replaces a kept one: the item carries its kept coverage too");
  else if (open.length > kept.length) add(BANK_RULE.openCoverage, at, "is never longer than its kept coverage");
  if (open.trim() !== open || !PRINTABLE.test(open)) add(BANK_RULE.openCoverage, at, "plain printable ASCII with no edge space");
  if (open.length > COVERAGE_MAX) add(BANK_RULE.openCoverage, at, `at most ${COVERAGE_MAX} characters`);
  if (!ONE_SENTENCE.test(open)) add(BANK_RULE.openCoverage, at, "one sentence that opens with a capital and ends with «.»");
  if (NEGATION.test(open)) add(BANK_RULE.openCoverage, at, "says what covers her, never what does not show (no not, no, never, without)");
  const youth = youthOf(open, true);
  if (youth.length > 0) add(BANK_RULE.youth, at, `names a youth word (${youth.join(", ")})`);
  if (SELFIE_WORDS.test(open) || CAMERA_WORDS.test(open)) add(BANK_RULE.camera, at, "names no camera, lens or selfie");
  const exposed = exposureWordsIn(open);
  if (exposed.length > 0) add(BANK_RULE.openCoverage, at, `names an exposure word (${exposed.join(", ")}): Seedream refuses it (I5.76)`);
}

/** The 5a.4 rules (plan s5a4 §5.2's table), on top of the 5a.3 ones. */
function boldAnyRules(bank: CategoryBank, add: Add, kind: BoldAnyKind, others: readonly unknown[]): void {
  const moments = bank.places.flatMap((place) => place.moments.map((moment) => ({ moment, where: `${place.name}: ${moment.text}`, place })));
  const general = bank.outfits.filter((o) => o.pinOnly !== true && !isOwnerBannedOutfit(o.text));
  const outfitOf = (text: string): Outfit | undefined => bank.outfits.find((o) => o.text === text);
  const isImplied = (text: string): boolean => outfitOf(text)?.tier === "implied";

  // bold-floor (I5.71, r2.1 N3): every outfit is underwear or lingerie, satin nightwear, swimwear or an implied cover; at a water place she wears only swimwear; elsewhere none.
  bank.outfits.forEach((outfit, i) => {
    if (outfit.tier !== "implied" && !isLingerie(outfit.text) && !isSwimwear(outfit.text) && !isSatinNightwear(outfit.text)) {
      add(BANK_RULE.boldFloor, `outfits[${i}] «${outfit.text}»`, "every «Смелая» outfit is underwear or lingerie, satin nightwear, swimwear or an implied cover");
    }
  });
  const atTheWater = bank.places.every((place) => place.water === true);
  if (!atTheWater) {
    for (const outfit of general) {
      if (isSwimwear(outfit.text)) add(BANK_RULE.boldFloor, `outfits «${outfit.text}»`, "swimwear in the general draw of a bank with a place away from the water: only the water places' moments pin it");
    }
  }
  for (const { moment, where, place } of moments) {
    if (place.water === true) {
      const wears = moment.outfits ?? general.map((o) => o.text);
      const dry = wears.filter((text) => !isSwimwear(text) || isLingerie(text));
      if (dry.length > 0) {
        add(BANK_RULE.boldFloor, where, moment.outfits === undefined ? `at a water place a moment pins its swimwear: the general draw would put «${dry.join("», «")}» by the water` : `«${dry.join("», «")}» is not swimwear: at a water place she wears only swimwear, never lingerie`);
      }
    } else if (moment.water !== true) {
      for (const text of moment.outfits ?? []) if (isSwimwear(text)) add(BANK_RULE.boldFloor, where, `«${text}» is swimwear: away from the water she wears none`);
    }
  }

  // water-place: the tag is on every place by the water and on no room.
  for (const place of bank.places) {
    if (place.water === true && place.room === true) add(BANK_RULE.waterPlace, place.name, "a room is never a water place");
    if (place.water !== true && WATER_AT.test(place.at)) add(BANK_RULE.waterPlace, place.name, `its phrase names the water («${place.at}»): it carries water: true`);
  }

  // bold-all-seedream: every slot of a «Смелая» bank is on the route (Q-A2).
  bank.outfits.forEach((outfit, i) => {
    if (outfit.route !== "seedream") add(BANK_RULE.boldAllSeedream, `outfits[${i}] «${outfit.text}»`, "every «Смелая» outfit is drawn on Seedream (route seedream)");
  });

  // open-coverage (I5.74, §5.5): an open coverage replaces a kept one, in its grammar and never longer; an implied cover says one; the sheet, the foam and the bare back say their kept one.
  const carriers = [
    ...bank.outfits.map((outfit, i) => ({ where: `outfits[${i}] «${outfit.text}»`, item: outfit, covers: outfit.tier === "implied" ? [outfit.text] : [] })),
    ...moments.map(({ moment, where }) => ({ where, item: moment, covers: (moment.outfits ?? []).filter(isImplied) })),
  ];
  for (const { where, item, covers } of carriers) {
    if (item.openCoverage !== undefined) checkOpenCoverage(add, where, item.openCoverage, item.coverage);
    // Review M1, fail-closed: only a class P-BA drew open may go without its kept sentence or say another; every other outfit says its kept one to every avatar (openCoverage = coverage).
    if (covers.length === 0 && item.coverage !== undefined && item.openCoverage !== item.coverage) {
      const garments = "outfits" in item ? (item.outfits ?? []) : [item.text];
      const unproven = garments.length === 0 ? ["(no pinned outfit)"] : garments.filter((text) => openClassOf(text) === null);
      if (unproven.length > 0) {
        add(BANK_RULE.openCoverage, where, `P-BA drew no item of the class of «${unproven.join("», «")}» without its kept coverage: it says its kept sentence to every avatar (openCoverage = coverage)`);
      }
    }
    if (covers.length === 0 || item.coverage === undefined) continue;
    if (item.openCoverage === undefined) add(BANK_RULE.openCoverage, where, "an implied cover says what covers her to every avatar: it carries an open coverage (descriptive, or its kept one)");
    else if (covers.some((text) => KEPT_COVERS.test(text)) && item.openCoverage !== item.coverage) {
      add(BANK_RULE.openCoverage, where, "the sheet, the foam and the bare back were drawn with the kept sentence only (P-BA, r2.2 P5): every avatar says it, so its open coverage is its kept one");
    }
  }

  // implied (I5.74): an implied cover is bold and pin-only, worn only by an implied moment, which is bold and pins only implied covers; without them the bank still draws every level.
  bank.outfits.forEach((outfit, i) => {
    if (outfit.tier !== "implied") return;
    const where = `outfits[${i}] «${outfit.text}»`;
    if (outfit.level !== "bold") add(BANK_RULE.implied, where, "an implied cover is bold");
    if (outfit.pinOnly !== true) add(BANK_RULE.implied, where, "an implied cover is pin-only: only its own moments wear it");
    const pins = moments.filter(({ moment }) => moment.outfits?.includes(outfit.text) === true);
    if (pins.length === 0) add(BANK_RULE.implied, where, "an implied cover is pinned by a moment");
  });
  for (const { moment, where } of moments) {
    const pins = moment.outfits ?? [];
    if (moment.tier === "implied") {
      if (moment.level !== "bold") add(BANK_RULE.implied, where, "an implied moment is bold");
      if (pins.length === 0 || !pins.every(isImplied)) add(BANK_RULE.implied, where, "an implied moment pins its implied covers, and only them");
    } else if (pins.some(isImplied)) add(BANK_RULE.implied, where, "only an implied moment wears an implied cover");
  }
  const withoutImplied: CategoryBank = {
    ...bank,
    outfits: bank.outfits.filter((o) => o.tier !== "implied"),
    places: bank.places.map((place) => ({ ...place, moments: place.moments.filter((m) => m.tier !== "implied") })),
  };
  boldLevelsRules(withoutImplied, add, " (without the implied items, as an imported avatar draws it)");

  // bold-private (I5.72): a companion's, the custom rooms' and the nightwear's places are her rooms, or her own or the hotel's balcony, terrace or window, or the villa's pool.
  if (kind === "companion" || kind === "rooms" || kind === "nightwear") {
    for (const place of bank.places) {
      if (place.room !== true && !PRIVATE_AT.some((pattern) => pattern.test(place.at))) {
        add(BANK_RULE.boldPrivate, place.name, `«${place.at}» is no private place: a room of her home or her hotel, her balcony, terrace or window, or the villa's own pool`);
      }
    }
  }

  // moment-unique: a moment is its bank's once, and no other bank's, so the claimed set and the history pairs never shift another category's draw.
  const seen = new Map<string, number>();
  for (const { moment } of moments) seen.set(moment.text, (seen.get(moment.text) ?? 0) + 1);
  for (const [text, count] of seen) if (count > 1) add(BANK_RULE.momentUnique, text, `the moment is given ${count} times in the bank`);
  const elsewhere = new Set(others.flatMap(momentTextsOf));
  for (const { moment, where } of moments) if (elsewhere.has(moment.text)) add(BANK_RULE.momentUnique, where, "is another bank's moment");

  // companion-size: what the planner needs to fill a request at every level from the bank alone.
  if (kind === "companion" || kind === "rooms" || kind === "water") {
    const size = SIZE[kind];
    const nonLegs = moments.filter(({ moment }) => moment.legs === undefined && moment.tier !== "implied").map(({ moment }) => moment);
    const legs = moments.filter(({ moment }) => moment.legs !== undefined);
    const count = (level: Level): number => nonLegs.filter((m) => (m.level ?? "ordinary") === level).length;
    const outfitsAt = (level: Level): number => general.filter((o) => o.tier !== "implied" && (o.level ?? "ordinary") === level).length;
    if (bank.places.length < size.places) add(BANK_RULE.companionSize, "places", `at least ${size.places} places`);
    if (nonLegs.length < size.moments) add(BANK_RULE.companionSize, "moments", `at least ${size.moments} moments that are not legs or implied ones`);
    for (const level of LEVELS) {
      if (count(level) < size[level]) add(BANK_RULE.companionSize, "moments", `at least ${size[level]} ${level} moments`);
      if (outfitsAt(level) < size.outfits) add(BANK_RULE.companionSize, "outfits", `at least ${size.outfits} ${level} outfits in the general draw`);
    }
    if (size.legs === 0 && legs.length > 0) add(BANK_RULE.companionSize, "legs", "no legs moment: «Ножки» is the built-ins' (legs-built-in-only)");
    if (legs.length < size.legs) add(BANK_RULE.companionSize, "legs", `at least ${size.legs} legs moments`);
    if (kind === "water" && (bank.outfits.some((o) => o.tier === "implied") || moments.some(({ moment }) => moment.tier === "implied"))) {
      add(BANK_RULE.companionSize, "implied", "«by the water» holds no implied cover: swimwear only");
    }
  }

  // tier-table (r2.2 P6): an outfit's level is the tier its garment gives.
  bank.outfits.forEach((outfit, i) => {
    const where = `outfits[${i}] «${outfit.text}»`;
    const tier = tierOfGarment(outfit);
    if (tier === null) add(BANK_RULE.tierTable, where, "names no garment of the tier table");
    else if ((outfit.level ?? "ordinary") !== tier) add(BANK_RULE.tierTable, where, `is ${tier} by the tier table, not ${outfit.level ?? "ordinary"}`);
  });

  // bold-legs (the companions and nightwear): a legs frame wears satin, at least three, one of them ordinary (the satin cami and satin shorts); plain underwear may join (P-BA L1).
  if (kind === "companion" || kind === "nightwear") {
    for (const { moment, where } of moments) {
      if (moment.legs === undefined) continue;
      const satin = (moment.outfits ?? []).filter(isSatinNightwear);
      if (satin.length < 3) add(BANK_RULE.boldLegs, where, "a legs moment pins at least 3 satin outfits");
      if (!satin.some((text) => outfitOf(text) !== undefined && outfitOf(text)?.level === undefined)) add(BANK_RULE.boldLegs, where, "a legs moment pins an ordinary satin outfit (the satin cami and satin shorts)");
    }
  }
}

/** The texts of a bank as far as they can be read (a malformed bank is its schema's business). */
const BankTexts = z.object({
  outfits: z.array(z.object({ text: z.string() })).optional(),
  legwear: z.object({ items: z.array(z.string()) }).optional(),
  places: z.array(z.object({ name: z.string(), at: z.string(), details: z.array(z.string()), moments: z.array(z.object({ text: z.string(), motion: z.string(), startPose: z.string().optional() })) })).optional(),
});

/** The moment texts of a bank as far as they can be read (moment-unique reads the other banks; a malformed one is its own schema's business). */
function momentTextsOf(bank: unknown): string[] {
  const parsed = BankTexts.safeParse(bank);
  return parsed.success ? (parsed.data.places ?? []).flatMap((place) => place.moments.map((m) => m.text)) : [];
}

/** bold-only-here (I5.37): an ordinary bank names none of the «Смелая» vocabulary, in any text. Never throws. */
export function boldOnlyHereProblems(bank: unknown): string[] {
  const parsed = BankTexts.safeParse(bank);
  if (!parsed.success) return [];
  const { outfits = [], legwear, places = [] } = parsed.data;
  const texts = [
    ...outfits.map((o, i) => ({ where: `outfits[${i}]`, text: o.text })),
    ...(legwear?.items ?? []).map((item, i) => ({ where: `legwear[${i}]`, text: item })),
    ...places.flatMap((place) => [
      { where: `${place.name}.name`, text: place.name },
      { where: `${place.name}.at`, text: place.at },
      ...place.details.map((detail) => ({ where: `${place.name}.details`, text: detail })),
      ...place.moments.flatMap((m) => [m.text, m.motion, m.startPose ?? ""].map((text) => ({ where: `${place.name}: ${m.text}`, text }))),
    ]),
  ];
  return texts.flatMap(({ where, text }) => {
    const words = boldWordsIn(text);
    return words.length === 0 ? [] : [`[${BANK_RULE.boldOnlyHere}] ${where}: names «${words.join("», «")}», the «Смелая» vocabulary, which only the two «Смелая» banks hold`];
  });
}

export function gazeBankProblems(bank: unknown): string[] {
  return problemsOf(GazeBankSchema.safeParse(bank));
}

export function cueBankProblems(bank: unknown): string[] {
  return problemsOf(CueBankSchema.safeParse(bank));
}

export function hairBankProblems(bank: unknown): string[] {
  return problemsOf(HairBankSchema.safeParse(bank));
}
