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
export const HAIR_WORDS = /\b(hair|ponytails?|buns?|braids?|plaits?|curls|fringe|bangs)\b/i;

/** I5.25: no bank text names a hair colour or a dye: the colour is the reference photo's, always. */
export const HAIR_COLOUR_WORDS =
  /\b(blonde?s?|brunettes?|redheads?|ginger|auburn|platinum|balayage|ombre|highlights|bleach\w*|dye[ds]?|dyeing)\b|\bhair[- ]?colou?r\b|\b(black|brown|red|dark|light|fair|grey|gray|silver|golden|copper|chestnut|honey|caramel|ash|blue|pink|purple|green|white)[- ]hair(?:ed)?\b/i;

/** A hairstyle names no colour at all (a «black claw clip» would still pull the hair toward black). */
export const COLOUR_WORDS = /\b(black|brown|red|blonde?|dark|light|fair|grey|gray|silver|golden|copper|chestnut|honey|caramel|ash|blue|pink|purple|green|white|auburn)\b/i;

/** I5.29: the youth props (plan s5a2 §4). None may enter a bank, at any level. */
export const YOUTH_PROPS =
  /\b(knee[- ]?socks?|striped thigh[- ]?highs?|pleated mini[- ]?skirts?|plush\w*|stuffed (?:animals?|toys?)|teddy(?: bears?)?|game ?pads?|game controllers?|gaming\w*|(?:game|gaming|video[- ]game) consoles?|swing(?:s|ing)? her legs|pig-?tails?|two braids|space buns?)\b/i;

/** The owner: Glamour is an evening out, never on a bed. */
export const BED_WORDS = /\bbed\w*/i;

/** Cues stay ordinary or playful, never these. */
export const CUE_BANNED_WORDS = /\b(sexy|seductive\w*|sultry|sensual\w*)\b/i;

/** No bank text names a camera or a lens: her phone is the only camera, and only the capture line describes it. */
export const CAMERA_WORDS = /\b(cameras?|lens(?:es)?)\b/i;

/** I5.23: a look at the camera, the viewer, the lens or the phone (the custom activities' gaze test, plan s5a2 §4). */
export const VIEWER_GAZE = /\b(look|gaz|glanc|star|smil)\w*\s+(at|toward|into)\s+(the\s+)?(camera|viewer|lens|phone)\b/i;

/** A moment that opens on a look carries its own gaze. */
export const GAZE_VERBS = /^(looks|glances|gazes|stares|peers|watches|smiles)\b/i;

/** «Ножки» (probe P-5a2): a legs moment names its footwear. */
export const FOOTWEAR_WORDS = /\b(sneakers?|trainers?|heels|boots?|shoes?|loafers?|flats)\b/i;

/** Probe P-5a2 and the video spike: toes go wrong, so no legs moment shows bare feet or open shoes. */
export const BARE_FEET_WORDS = /\b(barefoot\w*|bare[- ]?feet|bare foot|toes?|sandals?|flip[- ]?flops?|slippers?)\b/i;
