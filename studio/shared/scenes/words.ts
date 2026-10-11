// 5a.2 (S5.6a): the word lists the scene banks and the template are held to. Pure: the bank validation runs where the banks load, in the engine and
// in the renderer's mock alike.
//
// PHONE_WORDS and SELFIE_WORDS are the engine's own (engine/scenes/pools.ts, S5.4 and C1): the template needs them here, where it may not import the
// engine. engine/scenes/banks.sweep.test.ts pins the two copies equal until S5.6b points pools.ts at these.

/** Her phone named in a text: the phone is in her hand or in use. */
export const PHONE_WORDS = /\b(phones?|smartphones?|iphones?|cellphones?|texting|facetime)\b/i;

/** C1: «selfie» and «front camera» make the image model draw a phone, so no selfie text may say them. */
export const SELFIE_WORDS = /\bselfies?\b|\bfront[ -](?:facing[ -])?camera\b/i;

/** Her hair named by a moment: the moment then carries its own hair, and the slot gets no hair line. */
export const HAIR_WORDS = /\b(hair|ponytails?|buns?|braids?|plaits?|fringe|bangs)\b/i;

/** I5.25: no bank text names a hair colour or a dye: the colour is the reference photo's, always. */
export const HAIR_COLOUR_WORDS =
  /\b(blonde?s?|brunettes?|redheads?|ginger|auburn|platinum|balayage|ombre|highlights|bleach\w*|dye[ds]?|dyeing)\b|\bhair[- ]?colou?r\b|\b(black|brown|red|dark|light|fair|grey|gray|silver|golden|copper|chestnut|honey|caramel|ash|blue|pink|purple|green|white)[- ]hair(?:ed)?\b/i;

/** A hairstyle names no colour at all (a «black claw clip» would still pull the hair toward black). */
export const COLOUR_WORDS = /\b(black|brown|red|blonde?|dark|light|fair|grey|gray|silver|golden|copper|chestnut|honey|caramel|ash|blue|pink|purple|green|white|auburn)\b/i;

/**
 * The youth props none may enter a bank, at any level (I5.29). K-17 (the owner's references, plan r1.2): knee-high socks, thigh-high socks and pleated
 * mini skirts came back; striped thigh-highs, plush toys, gaming props, «swinging her legs», pigtails, two braids and space buns stay out.
 */
export const YOUTH_PROPS =
  /\b(striped thigh[- ]?highs?|plush\w*|stuffed (?:animals?|toys?)|teddy(?: bears?)?|game ?pads?|game controllers?|gaming\w*|(?:game|gaming|video[- ]game) consoles?|swing(?:s|ing)? her legs|pig-?tails?|two braids|space buns?)\b/i;

/** The owner: Glamour is an evening out, never on a bed. */
export const BED_WORDS = /\bbed\w*/i;

/** Cues stay ordinary or playful, never these. */
export const CUE_BANNED_WORDS = /\b(sexy|seductive\w*|sultry|sensual\w*)\b/i;

/** No bank text names a camera or a lens: her phone is the only camera, and only the capture line describes it. */
export const CAMERA_WORDS = /\b(cameras?|lens(?:es)?)\b/i;

/** I5.23: a look at the camera, the viewer, the lens or the phone (the custom activities' gaze test, plan s5a2 §4). */
export const VIEWER_GAZE = /\b(look|gaz|glanc|star|smil)\w*\s+(at|toward|into)\s+(the\s+)?(camera|viewer|lens|phone)\b/i;

/** An old custom activity whose eyes are already busy («watching a tablet», «reading a menu») carries its own gaze (review M2). */
export const OWN_GAZE_WORDS =
  /\b(?:look(?:s|ing|ed)?|gaz(?:e|es|ing|ed)|watch(?:es|ing|ed)?|star(?:e|es|ing|ed)|glanc(?:e|es|ing|ed)|peek(?:s|ing|ed)?|peer(?:s|ing|ed)?|read(?:s|ing)?)\b/i;

/** A moment that shows her expression itself (laughs, smiles) carries it: the template adds no cue (review M3). */
export const EXPRESSION_WORDS = /\b(?:laugh\w*|smil\w*|grin\w*|pout\w*|frown\w*|smirk\w*|giggl\w*)\b/i;

/** Her hips named high or above her head: the prone composition the owner rejected three times (a too-long torso). Checked with HIPS_WORDS. */
export const HIGH_WORDS = /\bhigh(?:er)?\b|\babove her head\b/i;
export const HIPS_WORDS = /\bhips?\b/i;

/** A moment that opens on a look carries its own gaze. */
export const GAZE_VERBS = /^(looks|glances|gazes|stares|peers|watches|smiles)\b/i;

/**
 * Plan r1.4: a moment that itself names legwear or bare skin takes no legwear slot (never «bare feet … with knee-high socks»). Legs alone do not
 * («legs crossed», «stretches her legs» take legwear: the legs slots need it).
 */
export const LEGWEAR_CLASH_WORDS = /\b(socks?|socked|tights|stockings?|bare|barefoot|soles?|heels?)\b/i;

/** A moment whose feet or legs are up carries the `noLegwear` tag (plan r1.4), so it takes no legwear either. */
export const FEET_UP_WORDS = /\b(?:feet|legs|foot)\s+(?:up|raised|in the air)\b|\b(?:feet|foot)\s+on\s+the\b|\blegs\s+bent\s+up\b/i;

/** S5.6R: a moment about her feet («slips on her heels», «rests one foot against the wall»): a friend's photo of it shows her whole body, never her knees up. */
export const FEET_MOMENT_WORDS = /\b(?:foot|feet|heels?|sneakers?|shoes?|toes|ankles?)\b/i;

/** A `timer` frame's line says «both of her hands are empty and nobody holds a phone» (I5.32): its moment holds nothing. */
export const HELD_OBJECT_WORDS =
  /^(holds|sips|drinks|eats|carries|grabs|picks|slips|laces|ties|stirs|lifts|pours|scrolls|sprays|twirls|fastens|packs|unpacks|wipes|dries|rolls|applies|puts|slices)\b|\b(cups?|coffee|mugs?|glass|bottles?|keys|clutch|bags?|gelato|croissant|towel|phone)\b/i;

/** An `above` frame's line says «as she lies there»: its moment lies down. */
export const LYING_START = /^(lies|rests her (?:cheek|head))\b/;

/**
 * The owner (2026-10-11): no denim shorts and no denim skirts, anywhere: a denim mini, midi or maxi, a skort, hot pants, cut-offs and jorts included. S5.6R: up
 * to three words may stand between the denim and the garment («a denim A-line skirt», «distressed denim short shorts»), and the garment may come first («a
 * skirt in light denim»). A word that joins or starts another garment («and», «with», «jacket», «shirt») ends the phrase: a denim jacket with a linen skirt is
 * not a denim skirt.
 */
const DENIM = String.raw`\b(?:denim|jeans?)(?:-[a-z]+)?`;
const BOTTOM_AFTER = String.raw`(?:shorts|skirts?|skorts?|mini(?:-?skirts?)?|minis|midis?|maxis?|hot\s+pants)\b`;
const BOTTOM_FIRST = String.raw`\b(?:shorts|skirts?|skorts?|mini(?:-?skirts?)?|minis|midis?|maxis?|hot\s+pants)`;
/** A word of an outfit: letters and digits, joined by a hyphen or an apostrophe («light-wash», «A-line»). */
const WORD = String.raw`[a-z0-9]+(?:[-'][a-z0-9]+)*`;
/** What ends the phrase: a word that joins two garments, or another garment's noun. */
const JOINS_OR_OTHER_GARMENT =
  "and|or|with|over|under|beneath|plus|into|tucked|paired|worn|layered|jackets?|shirts?|t-shirts?|tees?|tops?|blouses?|vests?|coats?|dress(?:es)?|hoodies?|sweaters?|cardigans?|jumpsuits?";
/** Up to three words that keep the phrase one garment; `articles` lets «a» and «the» stand among them (only after the garment: «a skirt in a light denim»). */
const between = (articles: boolean): string =>
  String.raw`(?:\s+(?!(?:${JOINS_OR_OTHER_GARMENT}${articles ? "" : "|a|an|the|her"})(?:\s|$))${WORD}){0,3}`;
const DENIM_BOTTOM_WORDS = new RegExp(
  String.raw`${DENIM}${between(false)}\s+${BOTTOM_AFTER}` +
    String.raw`|${BOTTOM_FIRST}\s+(?:made\s+)?(?:in|of|from)${between(true)}\s+(?:denim|jeans?)\b` +
    String.raw`|\bcut-?offs?\b|\bjorts\b`,
  "i",
);

/** I5.35: a motion is small or slow. */
export const MOTION_SMALL = /\b(slowly|a little|a bit|slightly|gently|small)\b/i;

/** I5.35: a motion is the body's, never the camera's or the edit's. */
export const MOTION_STAGING = /\b(zoom\w*|cuts?|pans?|frames?|shots?|close-?ups?|slow[- ]motion)\b/i;

/** K-22: phrases exempt from the luxury words (the writer's soft list, the pools' banned words): the owner's references wear «silk pajamas». «Satin» stays banned. */
const EXEMPT_LOOK_PHRASES = /\bsilk pajamas\b/gi;

/** The text with its exempt phrases taken out, for a check against the luxury words. */
export function withoutExemptLookPhrases(text: string): string {
  return text.replace(EXEMPT_LOOK_PHRASES, "");
}
/** Whether an outfit breaks the owner's «no denim shorts, no denim skirts» (the banks refuse it at load; S5.6b filters a custom pool's outfits with it). */
export function isOwnerBannedOutfit(text: string): boolean {
  return DENIM_BOTTOM_WORDS.test(text);
}

/**
 * The owner's banned garments a text puts her in, by OUR name for each («denim shorts», «denim skirt»), never the text's own wording: what a writer's refusal
 * tells the next attempt (S5.6R). Empty when the text wears none.
 */
export function ownerBannedOutfitWords(text: string): string[] {
  const told = new Set<string>();
  for (const match of text.matchAll(new RegExp(DENIM_BOTTOM_WORDS.source, "gi"))) told.add(/shorts|hot\s+pants|cut-?offs?|jorts/i.test(match[0]) ? "denim shorts" : "denim skirt");
  return [...told];
}
