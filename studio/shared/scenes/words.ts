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

/**
 * «Ножки» (S5.8a review): a low angle under a mini reads as an upskirt shot, so a legs frame takes no mini or short dress or skirt, and no sweater or tee worn as a dress
 * ("bodycon" is short too). The legs moments pin outfits that are shorts, trousers, leggings, joggers or midi and long dresses; the banks refuse a legs moment that pins one of these.
 */
export const LEGS_UNSUITED_OUTFITS = /\b(?:mini(?:s|-?(?:dress(?:es)?|skirts?))?|bodycon)\b|\bshort[- ](?:dress(?:es)?|skirts?)\b|\bas a dress\b|\boversized\b/i;

/** A dress or a skirt of any make and number («dress», «dresses», «sundress», «slipdress», «skirt», «skirts», «miniskirt»): the garments a legs moment must give a length. */
export const DRESS_OR_SKIRT = /\b\w*(?:dress(?:es)?|skirts?)\b/i;

/** An outfit that covers her legs (trousers, jeans, joggers, leggings, pants): it is not `showsLegs`, so no legwear (socks, tights) is drawn over it (S5.R3, the joggers bug). */
export const LEG_COVERING_OUTFIT = /\b(?:trousers?|jeans|joggers|leggings|pants)\b/i;

/** The length a dress or a skirt of a legs moment must name: «midi», «maxi» or «long». «long-sleeve(d)» is a sleeve, not a length (S5.R3). */
export const DRESS_LENGTH = /\b(?:midi|maxi)\b|\blong\b(?![- ]sleeve)/i;

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

/**
 * C3′ (the owner: «просто стоит спиной без какой-либо позы», R2#01 «walks away down the pavement», R5#08 «sits facing the window»): a moment seen from behind or in
 * profile names what she is doing, so the frame reads: her hands, arms or hair, a strap or an earring, a stretch, the railing she leans on, her knees hugged or her
 * legs bent, or a turn to look.
 */
export const AWAY_ACTION_WORDS = /\b(?:hands?|arms?|hair|earrings?|straps?|railing|stretch\w*|hugging|bent|turns to look)\b/i;

/** Review (C3′ round 2): walking or jogging away from the camera is the R2#01 frame again, whatever her hand holds on the way: no away moment opens with it. */
export const WALKS_AWAY_WORDS = /^(?:walks|jogs|runs|strolls|wanders|heads)\s+(?:away|off)\b/i;

/** C3′: a moment that glances or looks back over her shoulder: her face turns back toward the camera, so it is never a frame seen from behind. */
export const GLANCE_BACK_WORDS = /\b(?:look(?:s|ing)?|glanc(?:e|es|ing)|peek(?:s|ing)?)\s+(?:back\b|over\s+her\s+shoulder\b)/i;

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
const BOTTOM_AFTER = String.raw`(?:shorts|skirts?|skorts?|mini(?:-?skirts?)?|minis|midis?|maxis?|hot\s+pants|bermudas?)\b`;
const BOTTOM_FIRST = String.raw`\b(?:shorts|skirts?|skorts?|mini(?:-?skirts?)?|minis|midis?|maxis?|hot\s+pants|bermudas?)`;
/** A word of an outfit: letters and digits, joined by a hyphen or an apostrophe («light-wash», «A-line»). */
const WORD = String.raw`[a-z0-9]+(?:[-'][a-z0-9]+)*`;
/** What ends the phrase: a word that joins two garments, or another garment's noun. */
const JOINS_OR_OTHER_GARMENT =
  "and|or|with|over|under|beneath|plus|into|tucked|paired|worn|layered|jackets?|shirts?|t-shirts?|tees?|tops?|blouses?|vests?|coats?|dress(?:es)?|hoodies?|sweaters?|cardigans?|jumpsuits?";
/** Up to three words that keep the phrase one garment; `articles` lets «a» and «the» stand among them (only after the garment: «a skirt in a light denim»). */
const between = (articles: boolean): string =>
  String.raw`(?:\s+(?!(?:${JOINS_OR_OTHER_GARMENT}${articles ? "" : "|a|an|the|her"})(?:\s|$))${WORD}){0,3}`;
const DENIM_BOTTOM_WORDS = new RegExp(
  String.raw`${DENIM}${between(false)}[\s-]+${BOTTOM_AFTER}` +
    String.raw`|${BOTTOM_FIRST}\s+(?:made\s+)?(?:in|of|from)${between(true)}\s+(?:denim|jeans?)\b` +
    String.raw`|\bcut-?offs?\b|\bjorts\b`,
  "i",
);

/** A skirt, shorts or a skort, by our name for it. */
export type Bottom = "skirt" | "shorts" | "skort";

// C3′ (the owner's verdict, 2026-10-12): Grok draws an unnamed «mini skirt» or «shorts» as DENIM (R3#03, R4#04). The wording probe (c3fix 3a/3b) drew none once the
// outfit named a fabric, or said «her skirt is not denim». So every bank skirt or shorts names its fabric (banks/schema.ts), and an outfit that does not (a custom
// pool's, the writer's, an idea's) gets the clause in the assembled prompt (engine/scenes/assembler.ts).

/** What a skirt or shorts may be made of: the fabric words. Never denim or jean (the owner's ban), nor twill or chambray, which draw as denim. */
const FABRIC_WORDS = new Set([
  "cotton", "linen", "jersey", "knit", "knitted", "wool", "woollen", "woolen", "leather", "suede", "corduroy", "tweed", "lycra", "spandex", "nylon", "fleece", "terry",
  "waffle", "sequin", "sequins", "sequined", "sequinned", "chiffon", "tulle", "lace", "mesh", "satin", "silk", "velvet", "crepe", "polyester", "modal", "seersucker",
  "poplin", "ribbed",
]);
const DENIM_WORDS = new Set(["denim", "jean", "jeans"]);
/** Where a garment's own words end, reading back from its noun: a word that joins two garments, an article, another garment, or the clause around it. */
const GARMENT_STOPS = new Set([
  "and", "or", "with", "over", "under", "beneath", "plus", "into", "tucked", "paired", "worn", "layered", "a", "an", "the", "her", "his", "some", "wearing", "in", "on",
  "at", "by", "while", "she", "is", "are", "jacket", "jackets", "shirt", "shirts", "t-shirt", "t-shirts", "tee", "tees", "top", "tops", "blouse", "blouses", "vest",
  "vests", "coat", "coats", "dress", "dresses", "hoodie", "hoodies", "sweater", "sweaters", "cardigan", "cardigans", "jumpsuit", "jumpsuits", "tank", "cami",
]);
/** «a skirt in light linen», «shorts made of soft cotton»: the fabric may follow the garment. */
const MADE_OF = new Set(["in", "of", "from", "made"]);
/** How far a garment's own words reach on either side of its noun. */
const GARMENT_WORDS_MAX = 4;

/** What may follow a «mini» that is itself the garment: the end, a mark, or a word that joins it to the next one («a pleated mini and a top»). */
const AFTER_A_GARMENT = new Set(["and", "or", "with", "over", "under", "plus", "in", "on", "at", "by", "for", "from", "while", "worn", "paired", "tucked", "layered"]);

/**
 * The bottom a token names, or null. «mini» alone is a skirt only when no noun of its own follows («a pleated mini and a top»): «mini skirt» counts once, at «skirt»,
 * and «mini dress», «mini golf», «mini bag» are none. Shorts are «shorts» (so «bermuda shorts», never «Bermuda» alone, the place).
 */
function bottomOf(token: string, next: string | undefined): Bottom | null {
  if (/^(?:(?:mini-?)?skirts?|miniskirts?)$/.test(token)) return "skirt";
  if (/^minis?$/.test(token)) return next === undefined || !/^[a-z0-9]/.test(next) || AFTER_A_GARMENT.has(next) ? "skirt" : null;
  if (/^skorts?$/.test(token)) return "skort";
  if (token === "shorts") return "shorts";
  return null;
}

/** «not denim» right after a bottom, or after a comma or a bracket: «shorts, not denim», «a mini skirt (not denim)», «her shorts are not denim». */
function saysNotDenim(tokens: readonly string[], after: number): boolean {
  let k = after;
  if (tokens[k] === "," || tokens[k] === "(" || tokens[k] === "is" || tokens[k] === "are") k++;
  return tokens[k] === "not" && tokens[k + 1] === "denim";
}

const isWord = (token: string | undefined): token is string => token !== undefined && /^[a-z0-9]/.test(token);
/** A word and its hyphenated parts («cotton-blend»). */
const partsOf = (token: string): string[] => [token, ...token.split("-")];

/**
 * C3′: the bottoms a text names without their fabric, by our name, each once and in the order first named; empty when every skirt, shorts or skort it names says
 * what it is made of. A denim one is the owner's ban (`isOwnerBannedOutfit`), not an unnamed one, and one the text already says is not denim is named.
 */
export function unfabricBottomsIn(text: string): Bottom[] {
  const tokens = text.toLowerCase().match(/[a-z0-9]+(?:[-'][a-z0-9]+)*|[^\sa-z0-9]/g) ?? [];
  const found: Bottom[] = [];
  const saidNotDenim = new Set<Bottom>();
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i] ?? "";
    let kind = bottomOf(token, tokens[i + 1]);
    let end = i;
    // «hot pants» are shorts.
    if (kind === null && token === "hot" && tokens[i + 1] === "pants") {
      kind = "shorts";
      end = i + 1;
    }
    if (kind === null) continue;
    const own: string[] = [];
    for (let j = i - 1; j >= 0 && own.length < GARMENT_WORDS_MAX; j--) {
      const word = tokens[j];
      if (!isWord(word) || GARMENT_STOPS.has(word)) break;
      own.push(word);
    }
    let k = end + 1;
    if (tokens[k] === "made") k++;
    if (MADE_OF.has(tokens[k] ?? "")) {
      for (let j = k + 1; j < tokens.length && j <= k + GARMENT_WORDS_MAX; j++) {
        const word = tokens[j];
        if (!isWord(word)) break;
        own.push(word);
      }
    }
    // «her shorts are not denim» (the clause itself), «shorts, not denim», «a mini skirt (not denim)»: every one of that kind is named.
    if (saysNotDenim(tokens, end + 1)) {
      saidNotDenim.add(kind);
      continue;
    }
    const parts = own.flatMap(partsOf);
    if (parts.some((w) => DENIM_WORDS.has(w) || FABRIC_WORDS.has(w))) continue;
    if (!found.includes(kind)) found.push(kind);
    i = end;
  }
  return found.filter((kind) => !saidNotDenim.has(kind));
}

/** C3′: what the assembled prompt says of the bottoms an outfit names without their fabric (the probe's wording, c3fix 3a): «her skirt is not denim». */
export function notDenimClause(bottoms: readonly Bottom[]): string {
  const plural = bottoms.length > 1 || bottoms[0] === "shorts";
  return `her ${bottoms.join(" and ")} ${plural ? "are" : "is"} not denim`;
}

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

/**
 * Spec words plus plural/adjective forms for the outfits Stage 2 disables: swimwear, sports bras, lingerie, stockings, slip dresses and robes. S5.9b1: moved
 * here from engine/scenes/words.ts, so the content-line module (contentLine.ts) and the renderer's mock read the one list.
 */
export const REVEALING_WORDS = /\b(bikini|swimsuit|swimwear|lingerie|sports bra|thong|stockings?|slip dress|robe over lingerie)\b/i;

/** Whether the text uses any revealing word (a plain boolean guard, e.g. the pools' outfit schema). */
export function hasRevealingWord(text: string): boolean {
  return REVEALING_WORDS.test(text);
}

/**
 * The revealing words a text uses, exactly as it wrote them. Builds its own global-flagged regex instance per call (never reuses one across calls):
 * `RegExp.prototype.test`/`exec` on a shared global regex carries a mutable `lastIndex`, which would silently skip matches on alternating calls —
 * `REVEALING_WORDS` above stays flag-`i`-only for exactly that reason.
 */
export function revealingWordsIn(text: string): string[] {
  return Array.from(text.matchAll(new RegExp(REVEALING_WORDS, "gi")), (m) => m[0]);
}
