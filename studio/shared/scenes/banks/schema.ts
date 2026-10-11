import { z } from "zod";
import { HairLength, POOL_TEXT_MAX, PoolShot, PoolTime, youthWords } from "../../engine";
import {
  BARE_FEET_WORDS,
  BED_WORDS,
  CAMERA_WORDS,
  COLOUR_WORDS,
  CUE_BANNED_WORDS,
  FOOTWEAR_WORDS,
  GAZE_VERBS,
  HAIR_COLOUR_WORDS,
  HAIR_WORDS,
  PHONE_WORDS,
  SELFIE_WORDS,
  VIEWER_GAZE,
  YOUTH_PROPS,
} from "../words";
import { CAPTURES } from "./captures";
import { LIGHTS } from "./lights";
import { CAPTURE_KINDS, POSTURES, type BankCategory, type Moment } from "./types";

// 5a.2 (S5.6a, I5.21): the banks' zod schemas. The shape is zod; every rule the plan names runs in a superRefine and reports `[rule] where: what`, so a
// test can name the rule a bad item breaks (banks/schema.test.ts) and a malformed bank fails loudly at load (banks/index.ts). The engine-only lists
// (the revealing words, the paper, screen and staging lists) are swept by engine/scenes/banks.sweep.test.ts.

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
  backViewer: "back-viewer",
  legsFootwear: "legs-footwear",
  legsShots: "legs-shots",
  captures: "captures",
  mirrorWord: "mirror-word",
  details: "details",
  detailGrammar: "detail-grammar",
  at: "at",
  moments: "moments",
  anyShot: "any-shot",
  messyOk: "messy-ok",
  times: "times",
  mirrorPlace: "mirror-place",
  glamourBed: "glamour-bed",
  lightRef: "light-ref",
  gazeGrammar: "gaze-grammar",
  gazePhone: "gaze-phone",
  gazeViewer: "gaze-viewer",
  cueGrammar: "cue-grammar",
  cueWord: "cue-word",
  cueGaze: "cue-gaze",
  hairGrammar: "hair-grammar",
  hairCap: "hair-cap",
  hairLengths: "hair-lengths",
} as const;
type Rule = (typeof BANK_RULE)[keyof typeof BANK_RULE];

/**
 * The verbs a moment may open with: third-person present, so «she {moment}» reads as a sentence. A new verb is added here on purpose (the
 * grammar test is a pinned list, plan s5a2 §5.1).
 */
export const MOMENT_VERBS: readonly string[] = [
  "adjusts", "applies", "breaks", "brushes", "carries", "catches", "checks", "crosses", "curls", "dries", "drinks", "eats", "fastens", "fixes",
  "grabs", "holds", "jogs", "kneels", "laces", "laughs", "leans", "lets", "lies", "lifts", "looks", "packs", "pats", "picks", "pours", "pulls",
  "puts", "reaches", "rests", "rolls", "rubs", "scrolls", "settles", "shades", "sips", "sits", "slices", "slips", "smiles", "sprays", "stands", "steps",
  "stirs", "stops", "stretches", "takes", "ties", "tucks", "turns", "twirls", "unpacks", "waits", "walks", "waters", "wipes", "wraps",
];

const PRINTABLE = /^[\x20-\x7e]+$/;
const DETAIL_START = /^(a|an|the|her|some|two)\s/;
const AT_START = /^(in|on|at|by|against|inside|outside|under|near|beside|along|behind)\s/;
const GAZE_START = /^(looking|glancing|giving|her eyes|eyes|checking)\b/;
const CUE_START = /^(?:(?:a|an|one|her)\s|mid-)/;
const CUE_GAZE = /\b(look\w*|glanc\w*|gaz\w*|star(?:e|es|ing)|eyes?|viewer|camera|lens|phone)\b/i;
const HAIR_START = /^(in|half|tucked|pinned|blow-dried|a little|twisted|loose|worn|swept|down|braided|clipped)\b/;
const MIRROR = /mirror/i;
const VIEWER = /\bviewer\b/i;

type Add = (rule: Rule, where: string, what: string) => void;

function adder(ctx: z.RefinementCtx): Add {
  return (rule, where, what) => ctx.addIssue({ code: "custom", message: `[${rule}] ${where}: ${what}`, path: [] });
}

/** The checks every bank text takes: printable, no youth word, no youth prop, no hair colour, no selfie word, no camera or lens. */
function checkText(add: Add, where: string, text: string, max?: number): void {
  if (text.trim() !== text || text.length === 0 || !PRINTABLE.test(text)) add(BANK_RULE.text, where, "must be plain printable ASCII with no edge space");
  if (max !== undefined && text.length > max) add(BANK_RULE.text, where, `must be at most ${max} characters`);
  const youth = youthWords(text, "descriptor");
  if (youth.length > 0) add(BANK_RULE.youth, where, `names a youth word (${youth.join(", ")})`);
  if (YOUTH_PROPS.test(text)) add(BANK_RULE.youthProp, where, "names a youth prop");
  if (HAIR_COLOUR_WORDS.test(text)) add(BANK_RULE.hairColour, where, "names a hair colour or a dye");
  if (SELFIE_WORDS.test(text)) add(BANK_RULE.selfie, where, "says selfie or front camera, which draws a phone");
  if (CAMERA_WORDS.test(text)) add(BANK_RULE.camera, where, "names a camera or a lens");
}

/** A moment that fits every stored shot and every pose: one free hand, no phone, no angle, no look at the viewer, no capture limit, no level. */
export function fitsEveryShot(moment: Moment): boolean {
  return !moment.twoHanded && moment.phone !== true && moment.angle === undefined && moment.gaze !== "viewer" && moment.captures === undefined && moment.level === undefined && moment.legs === undefined;
}

function checkMoment(add: Add, where: string, moment: Moment, room: boolean): void {
  const text = moment.text;
  checkText(add, where, text, POOL_TEXT_MAX);
  const verb = /^[a-z]+/.exec(text)?.[0] ?? "";
  if (!MOMENT_VERBS.includes(verb)) add(BANK_RULE.momentVerb, where, `must open with a pinned third-person verb, not «${verb}»`);
  if (/\bshe\b/i.test(text)) add(BANK_RULE.momentShe, where, "must not name «she»: the template does");
  if ((moment.phone === true) !== PHONE_WORDS.test(text)) add(BANK_RULE.momentPhone, where, "carries the phone flag exactly when it names her phone");
  if (moment.phone === true && moment.gaze !== "own") add(BANK_RULE.phoneGaze, where, "a phone moment carries its own gaze (her eyes are on the phone)");
  if ((moment.hair === "own") !== HAIR_WORDS.test(text)) add(BANK_RULE.momentHair, where, "carries the own-hair tag exactly when it names her hair");
  if ((moment.gaze === "viewer") !== (VIEWER.test(text) || VIEWER_GAZE.test(text))) add(BANK_RULE.momentViewer, where, "carries the viewer gaze exactly when it looks at the viewer");
  if (GAZE_VERBS.test(text) && moment.gaze !== "own" && moment.gaze !== "viewer") add(BANK_RULE.momentGaze, where, "a moment that opens on a look carries its own gaze");
  if (moment.angle === "back" && moment.gaze === "viewer") add(BANK_RULE.backViewer, where, "a moment seen from behind cannot look at the viewer");
  if (moment.messyOk === true && !room) add(BANK_RULE.messyOk, where, "only a room's moment may be messy");
  if (moment.legs !== undefined) {
    if (moment.legs.shots.length === 0) add(BANK_RULE.legsShots, where, "a legs moment names the shots it fits");
    if (!FOOTWEAR_WORDS.test(text) || BARE_FEET_WORDS.test(text)) add(BANK_RULE.legsFootwear, where, "a legs moment names her footwear and never bare feet (probe P-5a2)");
  }
  const captures = moment.captures;
  if (captures !== undefined) {
    if (captures.length === 0 || new Set(captures).size !== captures.length) add(BANK_RULE.captures, where, "names one or more captures, each once");
    if ((moment.twoHanded || moment.phone === true) && captures.some((c) => CAPTURES[c].handHeld)) add(BANK_RULE.captures, where, "a two-handed or phone moment fits no hand-held capture");
  }
  if (MIRROR.test(text) && (captures === undefined || captures.length === 0 || captures.some((c) => CAPTURES[c].shot !== "mirror"))) {
    add(BANK_RULE.mirrorWord, where, "a moment that names a mirror fits mirror captures only");
  }
}

const MomentSchema = z.strictObject({
  text: z.string(),
  twoHanded: z.boolean(),
  phone: z.literal(true).optional(),
  messyOk: z.literal(true).optional(),
  level: z.literal("flirty").optional(),
  angle: z.enum(["three-quarter", "profile", "back"]).optional(),
  gaze: z.enum(["own", "viewer", "focus"]).optional(),
  hair: z.enum(["tied", "loose", "own"]).optional(),
  outdoor: z.literal(true).optional(),
  legs: z.strictObject({ framing: z.literal("legs").optional(), shots: z.array(PoolShot) }).optional(),
  captures: z.array(z.enum(CAPTURE_KINDS)).optional(),
  posture: z.enum(POSTURES).optional(),
});

const PlaceSchema = z.strictObject({
  name: z.string(),
  at: z.string(),
  times: z.array(PoolTime),
  mirror: z.literal(true).optional(),
  room: z.literal(true).optional(),
  details: z.array(z.string()),
  moments: z.array(MomentSchema),
  lights: z.array(z.string()).optional(),
});

const LIGHT_IDS = new Set(LIGHTS.map((l) => l.id));

function categoryBankSchema(category: BankCategory) {
  return z
    .strictObject({
      places: z.array(PlaceSchema).min(1),
      outfits: z.array(z.string()).min(1),
      shotDeck: z.array(PoolShot).min(1),
      legwear: z.array(z.strictObject({ text: z.string(), status: z.enum(["probe", "passed"]) })).optional(),
    })
    .superRefine((bank, ctx) => {
      const add = adder(ctx);
      const names = bank.places.map((p) => p.name);
      if (new Set(names).size !== names.length) add(BANK_RULE.duplicate, "places", "two places share a name");
      if (bank.shotDeck.includes("mirror") && !bank.places.some((p) => p.mirror === true)) add(BANK_RULE.mirrorPlace, "places", "a deck with a mirror shot needs a mirror place");
      bank.outfits.forEach((outfit, i) => checkText(add, `outfits[${i}]`, outfit, POOL_TEXT_MAX));
      (bank.legwear ?? []).forEach((item, i) => checkText(add, `legwear[${i}]`, item.text, POOL_TEXT_MAX));

      for (const place of bank.places) {
        const where = place.name;
        const room = place.room === true;
        checkText(add, `${where}.name`, place.name, POOL_TEXT_MAX);
        checkText(add, `${where}.at`, place.at);
        if (MIRROR.test(place.name) || MIRROR.test(place.at)) add(BANK_RULE.mirrorWord, where, "a place must not name a mirror: only the mirror shot's own line does");
        if (!AT_START.test(place.at)) add(BANK_RULE.at, `${where}.at`, "opens with a preposition");
        if (place.times.length === 0 || place.times.includes("studio lighting")) add(BANK_RULE.times, `${where}.times`, "one or more times of day, never the stored «studio lighting»");
        if (place.details.length < 2 || place.details.length > 3) add(BANK_RULE.details, `${where}.details`, "2 or 3 details");
        for (const detail of place.details) {
          checkText(add, `${where}.details`, detail, POOL_TEXT_MAX);
          if (!DETAIL_START.test(detail)) add(BANK_RULE.detailGrammar, `${where}.details`, `«${detail}» opens with a|an|the|her|some|two`);
          if (MIRROR.test(detail)) add(BANK_RULE.mirrorWord, `${where}.details`, "a detail must not name a mirror");
        }
        if (place.moments.length < 4) add(BANK_RULE.moments, `${where}.moments`, "at least 4 moments");
        if (!place.moments.some(fitsEveryShot)) add(BANK_RULE.anyShot, `${where}.moments`, "one moment fits every shot and pose: one free hand, no phone, no angle, no viewer, no capture limit");
        const texts = place.moments.map((m) => m.text);
        if (new Set(texts).size !== texts.length) add(BANK_RULE.duplicate, `${where}.moments`, "a moment is given twice");
        place.moments.forEach((moment) => checkMoment(add, `${where}: ${moment.text}`, moment, room));
        for (const id of place.lights ?? []) if (!LIGHT_IDS.has(id)) add(BANK_RULE.lightRef, `${where}.lights`, `no light «${id}» in the light bank`);
        if (category === "glamour") {
          const texts = [place.name, place.at, ...place.details, ...place.moments.map((m) => m.text)];
          if (texts.some((t) => BED_WORDS.test(t))) add(BANK_RULE.glamourBed, where, "Glamour is an evening out: never on a bed");
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
      const namesPhone = PHONE_WORDS.test(gaze.text);
      if ((gaze.phone === true) !== namesPhone) add(BANK_RULE.gazePhone, where, "carries the phone flag exactly when it names her phone");
      if (gaze.phone === true && (gaze.kind !== "mirror" || !/\bin the mirror\b/i.test(gaze.text))) add(BANK_RULE.gazePhone, where, "only a mirror gaze names her phone, and as her phone in the mirror");
      if ((gaze.kind === "viewer") !== VIEWER.test(gaze.text)) add(BANK_RULE.gazeViewer, where, "names the viewer exactly when it is a viewer gaze");
    }
  });

const CueBankSchema = z
  .array(z.strictObject({ text: z.string(), level: z.literal("flirty").optional() }))
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
    }
  });

const HairBankSchema = z
  .array(z.strictObject({ text: z.string(), lengths: z.array(HairLength), tied: z.boolean(), cap: z.literal(true).optional() }))
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
