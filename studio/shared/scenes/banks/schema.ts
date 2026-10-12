import { z } from "zod";
import { HairLength, POOL_TEXT_MAX, PoolTime, youthWords } from "../../engine";
import { CAPTURES, isHandCapture, LEGS_CAPTURES, shotOf, type Capture } from "../captures";
import {
  BED_WORDS,
  CAMERA_WORDS,
  COLOUR_WORDS,
  CUE_BANNED_WORDS,
  EXPRESSION_WORDS,
  FEET_UP_WORDS,
  GAZE_VERBS,
  HAIR_COLOUR_WORDS,
  HAIR_WORDS,
  HELD_OBJECT_WORDS,
  HIGH_WORDS,
  HIPS_WORDS,
  isOwnerBannedOutfit,
  LEGS_UNSUITED_OUTFITS,
  LYING_START,
  MOTION_SMALL,
  MOTION_STAGING,
  PHONE_WORDS,
  SELFIE_WORDS,
  VIEWER_GAZE,
  YOUTH_PROPS,
} from "../words";
import { MOMENT_HAIRS, type BankCategory, type Moment } from "./types";

// 5a.2 (S5.6a, I5.21, I5.35; plan s5a2 r1.2): the banks' zod schemas. The shape is zod; every rule the plan names runs in a superRefine and reports
// `[rule] where: what`, so a test can name the rule a bad item breaks (banks/schema.test.ts) and a malformed bank fails loudly at load
// (banks/index.ts). The engine-only lists (the revealing words, the paper, screen and staging lists, the «silk pajamas» exemption) are swept by
// engine/scenes/banks.sweep.test.ts. Every bank text is at most POOL_TEXT_MAX characters; a motion and a start pose at most MOTION_TEXT_MAX (they
// never reach the writer or a photo prompt); the locative `at` is not bound (it is never sent to the writer).

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
} as const;
type Rule = (typeof BANK_RULE)[keyof typeof BANK_RULE];

/** A motion's and a start pose's bound (plan I5.21, 5b.1 QV-5): the approved Kling wording, «she slowly lifts her hips behind her and lowers them», fits. */
export const MOTION_TEXT_MAX = 60;

/**
 * The verbs a moment may open with: third-person present, so «she {moment}» reads as a sentence. A new verb is added here on purpose (the
 * grammar test is a pinned list, plan s5a2 §5.1).
 */
export const MOMENT_VERBS: readonly string[] = [
  "adjusts", "applies", "breaks", "brushes", "carries", "catches", "checks", "crosses", "crouches", "curls", "dries", "drinks", "eats", "fastens",
  "fixes", "grabs", "holds", "jogs", "kneels", "laces", "laughs", "leans", "lets", "lies", "lifts", "looks", "packs", "pats", "picks", "pours", "pulls",
  "puts", "reaches", "rests", "rolls", "rubs", "scrolls", "settles", "shades", "sips", "sits", "slices", "slips", "smiles", "sprays", "stands",
  "steps", "stirs", "stops", "stretches", "takes", "ties", "tucks", "turns", "twirls", "unpacks", "waits", "walks", "waters", "wipes", "wraps",
];

const PRINTABLE = /^[\x20-\x7e]+$/;
const DETAIL_START = /^(a|an|the|her|some|two)\s/;
const AT_START = /^(in|on|at|by|against|inside|outside|under|near|beside|along|behind)\s/;
const GAZE_START = /^(looking|glancing|giving|her eyes|eyes|checking)\b/;
const CUE_START = /^(?:(?:a|an|one|her)\s|mid-)/;
const CUE_GAZE = /\b(look\w*|glanc\w*|gaz\w*|star(?:e|es|ing)|eyes?|viewer|camera|lens|phone)\b/i;
const HAIR_START = /^(in|half|tucked|pinned|blow-dried|a little|twisted|loose|worn|swept|down|braided|clipped|tied)\b/;
const MOTION_START = /^(she|her)\s/;
const MIRROR = /mirror/i;
const VIEWER = /\bviewer\b/i;

type Add = (rule: Rule, where: string, what: string) => void;

function adder(ctx: z.RefinementCtx): Add {
  return (rule, where, what) => ctx.addIssue({ code: "custom", message: `[${rule}] ${where}: ${what}`, path: [] });
}

/** The checks every bank text takes: printable, at most `max` characters (POOL_TEXT_MAX unless said; null: unbound), no youth word or prop, no hair colour, no selfie word, no camera. */
function checkText(add: Add, where: string, text: string, max: number | null = POOL_TEXT_MAX): void {
  if (text.trim() !== text || text.length === 0 || !PRINTABLE.test(text)) add(BANK_RULE.text, where, "must be plain printable ASCII with no edge space");
  if (max !== null && text.length > max) add(BANK_RULE.text, where, `must be at most ${max} characters`);
  const youth = youthWords(text, "descriptor");
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

function checkMotion(add: Add, where: string, moment: Moment): void {
  const motion = moment.motion;
  checkText(add, `${where} (motion)`, motion, MOTION_TEXT_MAX);
  if (!MOTION_START.test(motion)) add(BANK_RULE.motionGrammar, `${where} (motion)`, "opens with «she» or «her»");
  if (!MOTION_SMALL.test(motion)) add(BANK_RULE.motionGrammar, `${where} (motion)`, "is small or slow: «slowly», «a little», «a bit», «slightly», «gently» or «small»");
  if (/\bthen\b|;/.test(motion) || (motion.match(/\band\b/g) ?? []).length > 1) add(BANK_RULE.motionGrammar, `${where} (motion)`, "is one movement (at most a there-and-back with one «and»)");
  if (MOTION_STAGING.test(motion)) add(BANK_RULE.motionStaging, `${where} (motion)`, "moves her, never the camera or the edit");
  if (PHONE_WORDS.test(motion) && moment.phone !== true) add(BANK_RULE.motionPhone, `${where} (motion)`, "brings in a phone the moment does not use (a second phone)");
  if (moment.startPose !== undefined) checkText(add, `${where} (start pose)`, moment.startPose, MOTION_TEXT_MAX);
}

function checkMoment(add: Add, where: string, moment: Moment, place: { room?: true | undefined; mirror?: true | undefined }, outfits: ReadonlySet<string>): void {
  const text = moment.text;
  checkText(add, where, text);
  const verb = /^[a-z]+/.exec(text)?.[0] ?? "";
  if (!MOMENT_VERBS.includes(verb)) add(BANK_RULE.momentVerb, where, `must open with a pinned third-person verb, not «${verb}»`);
  if (/\bshe\b/i.test(text)) add(BANK_RULE.momentShe, where, "must not name «she»: the template does");
  if ((moment.phone === true) !== PHONE_WORDS.test(text)) add(BANK_RULE.momentPhone, where, "carries the phone flag exactly when it names her phone");
  if (moment.phone === true && moment.gaze !== "own") add(BANK_RULE.phoneGaze, where, "a phone moment carries its own gaze (her eyes are on the phone)");
  if ((moment.hair === "own") !== HAIR_WORDS.test(text)) add(BANK_RULE.momentHair, where, "carries the own-hair tag exactly when it names her hair");
  if ((moment.gaze === "viewer") !== (VIEWER.test(text) || VIEWER_GAZE.test(text))) add(BANK_RULE.momentViewer, where, "carries the viewer gaze exactly when it looks at the viewer");
  if (GAZE_VERBS.test(text) && moment.gaze !== "own" && moment.gaze !== "viewer") add(BANK_RULE.momentGaze, where, "a moment that opens on a look carries its own gaze");
  if ((moment.expression === true) !== EXPRESSION_WORDS.test(text)) add(BANK_RULE.momentExpression, where, "carries the expression tag exactly when it shows her expression (it then takes no cue)");
  if (moment.angle === "back" && moment.gaze === "viewer") add(BANK_RULE.backViewer, where, "a moment seen from behind cannot look at the viewer");
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
      else if (/\b(dress|skirt)\b/i.test(outfit) && !/\b(midi|long|maxi)\b/i.test(outfit)) add(BANK_RULE.legsOutfit, where, `«${outfit}» is a dress or skirt of no stated length: a legs moment names midi, long or maxi`);
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
  checkMotion(add, where, moment);
}

const CaptureSchema = z.enum(CAPTURES);

const MomentSchema = z.strictObject({
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
});

const PlaceSchema = z.strictObject({
  name: z.string(),
  at: z.string(),
  times: z.array(PoolTime),
  mirror: z.literal(true).optional(),
  room: z.literal(true).optional(),
  lamp: z.literal(true).optional(),
  details: z.array(z.string()),
  moments: z.array(MomentSchema),
});

function categoryBankSchema(category: BankCategory) {
  return z
    .strictObject({
      places: z.array(PlaceSchema).min(1),
      outfits: z.array(z.strictObject({ text: z.string(), showsLegs: z.literal(true).optional(), pinOnly: z.literal(true).optional() })).min(1),
      legwear: z.strictObject({ items: z.array(z.string()), share: z.number() }).optional(),
      captureDeck: z.array(CaptureSchema).min(1),
    })
    .superRefine((bank, ctx) => {
      const add = adder(ctx);
      const names = bank.places.map((p) => p.name);
      if (new Set(names).size !== names.length) add(BANK_RULE.duplicate, "places", "two places share a name");
      const outfitTexts = bank.outfits.map((o) => o.text);
      if (new Set(outfitTexts).size !== outfitTexts.length) add(BANK_RULE.duplicate, "outfits", "an outfit is given twice");
      bank.outfits.forEach((outfit, i) => {
        checkText(add, `outfits[${i}]`, outfit.text);
        if (isOwnerBannedOutfit(outfit.text)) add(BANK_RULE.denim, `outfits[${i}]`, "no denim shorts and no denim skirts (the owner)");
      });
      if (bank.legwear !== undefined) {
        bank.legwear.items.forEach((item, i) => {
          checkText(add, `legwear[${i}]`, item);
          // I5.29: knee-high socks, thigh-high socks and sheer tights; stockings wait for «Смелая» (5a.3).
          if (/\bstockings?\b/i.test(item)) add(BANK_RULE.legwear, `legwear[${i}]`, "stockings wait for «Смелая» (5a.3): legwear is socks or sheer tights");
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
        checkText(add, `${where}.name`, place.name);
        checkText(add, `${where}.at`, place.at, null);
        if (MIRROR.test(place.name) || MIRROR.test(place.at)) add(BANK_RULE.mirrorWord, where, "a place must not name a mirror: only the mirror capture's own line does");
        if (!AT_START.test(place.at)) add(BANK_RULE.at, `${where}.at`, "opens with a preposition");
        if (place.times.length === 0 || place.times.includes("studio lighting")) add(BANK_RULE.times, `${where}.times`, "one or more times of day, never the stored «studio lighting»");
        if (place.details.length < 2 || place.details.length > 3) add(BANK_RULE.details, `${where}.details`, "2 or 3 details");
        // S5.6R: a place that is not a room says its detail in the same sentence as its own phrase, so a detail never names that phrase's words again.
        const ownWords = new Set(plainWords(place.at));
        for (const detail of place.details) {
          checkText(add, `${where}.details`, detail);
          if (!DETAIL_START.test(detail)) add(BANK_RULE.detailGrammar, `${where}.details`, `«${detail}» opens with a|an|the|her|some|two`);
          if (MIRROR.test(detail)) add(BANK_RULE.mirrorWord, `${where}.details`, "a detail must not name a mirror");
          const again = plainWords(detail).filter((w) => ownWords.has(w));
          if (place.room !== true && again.length > 0) add(BANK_RULE.detailRepeat, `${where}.details`, `«${detail}» names «${again.join("», «")}» again: the place's own phrase says it in the same sentence`);
        }
        if (place.moments.length < 4) add(BANK_RULE.moments, `${where}.moments`, "at least 4 moments");
        const texts = place.moments.map((m) => m.text);
        if (new Set(texts).size !== texts.length) add(BANK_RULE.duplicate, `${where}.moments`, "a moment is given twice");
        place.moments.forEach((moment) => checkMoment(add, `${where}: ${moment.text}`, moment, place, outfits));
        // Review L1: a sentence says the place («On her bed») and draws a detail; a moment that names either again reads «On her bed, she sits on the bed».
        const placeWords = new Set([...contentWords(place.at, false), ...place.details.flatMap((d) => [...contentWords(d, false)])]);
        for (const moment of place.moments) {
          const again = [...contentWords(moment.text, true)].filter((w) => placeWords.has(w));
          if (again.length > 0) add(BANK_RULE.repeat, `${where}: ${moment.text}`, `names «${again.join("», «")}» again: the place or its details already say it`);
        }
        if (category === "glamour") {
          const all = [place.name, place.at, ...place.details, ...place.moments.map((m) => m.text)];
          if (all.some((t) => BED_WORDS.test(t))) add(BANK_RULE.glamourBed, where, "Glamour is an evening out: never on a bed");
        }
      }
    });
}

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

export function gazeBankProblems(bank: unknown): string[] {
  return problemsOf(GazeBankSchema.safeParse(bank));
}

export function cueBankProblems(bank: unknown): string[] {
  return problemsOf(CueBankSchema.safeParse(bank));
}

export function hairBankProblems(bank: unknown): string[] {
  return problemsOf(HairBankSchema.safeParse(bank));
}
