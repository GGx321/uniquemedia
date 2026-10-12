import { shotOf, type Capture } from "../../shared/scenes/captures";
import { pick } from "../../shared/scenes/hash";
import { fnv1a, makeRng, rngPick, shuffle } from "./rngUtil";
import type { Shot } from "./types";

// S5.1a: the phone look. Every phrase that makes a scene read as her own ordinary phone photo lives here and nowhere else (I5.1): the capture line
// of each author, the phone-hand line, the artefact lines, the light table, the imperfections, the room phrases and the constraints. The assembler
// only places them. Keyed by author (today's five shots) for the `photo` medium; 5b.1 adds `video`, 5a.2 adds `propped` and `pov`.
//
// What the text must never do (the owner's blind rating and spike A, `.omc/stage5/spike-a-results.md`):
// - show a phone outside the mirror (the «second phone» defect, I5.2): the selfie lines say her near arm leaves the frame so nothing in her hand can be
//   seen, and never say «selfie» or «front camera» at all (owner canary C1, 2026-10-11: the word itself made Grok draw a phone, even with a clean master
//   photo; a paid spike with this wording drew no phone in 4 of 4 frames). Only the mirror line says «selfie», because it must show the phone;
// - stage a camera or a studio, or name golden light (I5.3);
// - negate a look term («no retouching», «no bokeh»): a negation puts the term into the prompt (I5.10). It says what the photo IS instead.
//
// The draws (the imperfection, the room state) are pure functions of a key, `${runId}:${attemptIdBase}`, never of the plan's seed (a run made from a
// scene set has seed 0) and never of a clock, so a resume assembles the same prompt (I5.4).

// 5a.2 (S5.6b, plan s5a2 r1.5 §5.4): the capture line is keyed by WHO TOOK THE PHOTO (the slot's capture), not by its stored shot. At home she shoots
// herself (in the mirror, often with her phone over her face; at arm's length from above; lying on her stomach; over her own shoulder; on a timer); outside
// she mostly asks someone. A slot stored before captures reads its capture from its shot (shared/scenes/captures.ts captureOfShot): a photographer is a
// friend. Only the two mirror lines say «selfie», because they must show the phone (owner canary C1).

const MIRROR_LINE =
  "A mirror selfie she took herself: her phone in her hand at chest height, visible in the mirror and held low enough to leave her face clear, the room behind her in the reflection.";

const SELFIE_LINE =
  "A photo she took of herself at arm's length, seen from the camera's own point of view, held a little above eye level, the frame slightly tilted; her near arm stretches toward the viewer and leaves the frame at the bottom edge, so nothing in her near hand can be seen.";

/** The heights and distances a friend's photo is drawn from, on `${key}:friend`. */
export const FRIEND_VARIANTS: readonly string[] = [
  "from eye level a few steps away, her whole body in the picture",
  "from a little below, a few steps away, her whole body in the picture",
  "from eye level, from her knees up",
];

/** The variants that show her whole body: the only ones a moment about her feet takes (S5.6R: «from her knees up» cut off «slips on her heels»). */
const WHOLE_BODY_VARIANTS: readonly string[] = FRIEND_VARIANTS.filter((variant) => variant.includes("her whole body in the picture"));

/** What the capture line reads of the moment, beyond who took the photo. */
export interface CaptureFraming {
  /** The moment is about her feet: a friend's or a candid photo shows her whole body. Absent or false: the line the key draws. */
  wholeBody?: boolean;
}

const friendLine = (key: string, framing: CaptureFraming): string =>
  `A quick phone photo someone she asked took of her, ${pick(framing.wholeBody === true ? WHOLE_BODY_VARIANTS : FRIEND_VARIANTS, key, "friend")}; she is not taking the photo herself.`;

/** A candid is a friend's photo of her busy with something. */
const CANDID_CLAUSE = "She is busy with something and not looking toward the camera.";

/** The fixed capture lines; `friend` and `candid` take a variant from the slot's key (`captureLineOf`). */
// C3′ (the owner's verdict, 2026-10-12): «the phone hides most of her face» drew her face beside the phone in 5 of 5 frames; the wording probe's winner (c3fix 1a)
// covers it from her eyebrows to her chin, and the side-to-the-mirror sentence (MIRROR_BACK_LINE) says the same.
const FACE_COVER = "the phone covering her face from her eyebrows to her chin";

const FIXED_CAPTURE_LINE: Readonly<Record<Exclude<Capture, "friend" | "candid">, string>> = {
  "mirror-hidden": `A mirror selfie she took herself: she holds her phone right in front of her face, ${FACE_COVER}; only her hair and body show in the mirror.`,
  mirror: MIRROR_LINE,
  above: "A close photo she took of herself from slightly above as she lies there, at arm's length; her near arm leaves the frame, so nothing in her near hand can be seen.",
  prone:
    "A photo she took of herself at arm's length as she lies on her stomach on the bed, one arm stretched toward the viewer and out of the frame, her other hand free; behind her, the curve of her back and hips.",
  "over-shoulder":
    "A photo she took of herself from above her own shoulder while lying on her stomach on the bed, looking back along her own body: her hair in the foreground, her hips, and her feet raised up at the far end.",
  selfie: SELFIE_LINE,
  // C3′: the probe's timer frame (c3fix 4a) drew the propped phone itself in the foreground, so the line says it is out of the picture.
  timer:
    "A photo from her phone propped on a ledge a few metres away on a timer; the phone itself is out of the picture; both of her hands are empty and nobody holds a phone; her whole body is in the picture.",
  // C3′: «looking down along her own legs … held at her eye level» came out as a photo from far away (R5#09). The probe's variant (c3fix 2b) drew a clean first-person
  // view, verbatim but for its «socked feet»: the probe's moment wore socks, and the feet here are the moment's (barefoot, socked or in shoes).
  "pov-legs":
    "A first-person point-of-view photo: the camera is exactly where her eyes are, looking straight down her own body; her thighs and knees are close to the lens in the foreground and her feet are at the far end, only her own legs are in the picture, with no face, no mirror and no hand.",
  "low-feet": "A quick phone photo a friend took of her, crouching a couple of metres away, low down near her feet; both of her hands are empty; she is not taking the photo herself.",
};

/** The first sentence of every prompt: how the photo was taken. Pure in the capture, the slot's key and the framing (a resume assembles the same prompt, I5.4). */
export function captureLineOf(capture: Capture, key: string, framing: CaptureFraming = {}): string {
  if (capture === "friend") return friendLine(key, framing);
  if (capture === "candid") return `${friendLine(key, framing)} ${CANDID_CLAUSE}`;
  return FIXED_CAPTURE_LINE[capture];
}

/** Back or side to the mirror (owner note, r1.5): added after the capture line of a moment tagged `mirrorBack`, with the face-hidden line's own phone clause (C3′). */
export const MIRROR_BACK_LINE = "Only her reflection is in the picture; the phone covers her face from her eyebrows to her chin.";

/**
 * The constraint about her hands. A mirror shot holds the phone in view in one hand; a selfie's near arm is out of the frame; the close self-shots (above,
 * prone, over the shoulder, looking down at her legs) say her phone arm is out of the frame and her other hand holds nothing, which guards against the
 * second phone the prone probe showed (Seedream). Null for a photo someone else took.
 */
export function phoneHandLineOf(capture: Capture): string | null {
  switch (capture) {
    case "mirror":
    case "mirror-hidden":
      return "One hand holds the phone; only her other hand acts.";
    case "selfie":
      return "Her near arm is out of the frame; only her other hand acts.";
    case "above":
    case "prone":
    case "over-shoulder":
    case "pov-legs":
      return "Her phone arm is out of the frame; her other hand is free and holds nothing.";
    default:
      return null;
  }
}

/** The constraints that end every prompt, before the phone-hand line. */
export const CONSTRAINTS = "She is an adult woman. No other people in the photo; no text, logos, brand names or watermark.";

/** The light of a scene with no stored time (an own scene) or one the table does not know. */
export const NEUTRAL_LIGHT = "the light where she is";

// The light is named by its source, never by a mood or a grade (a «golden hour» or «studio lighting» in the prompt stages the photo). The keys are the
// stored `POOL_TIMES` values, which stay readable (I5.5); a totality test runs over them.
const LIGHT: ReadonlyMap<string, string> = new Map([
  ["morning", "morning daylight"],
  ["midday", "flat midday daylight"],
  ["golden hour", "low late-afternoon sun"],
  ["evening", "the evening lamps, the sky outside already dim"],
  ["night", "a ceiling light or street lamp, a dark background"],
  ["studio lighting", "the room's ceiling lights"],
]);

/** The light phrase for a stored time of day; the neutral light for none, or for a time the table does not know. */
export function lightOf(time?: string): string {
  return (time === undefined ? undefined : LIGHT.get(time)) ?? NEUTRAL_LIGHT;
}

const FRIEND_IMPERFECTIONS: readonly string[] = [
  "a little motion blur on her moving hand",
  "slightly washed-out colours",
  "a slightly warm white balance",
];

/** One imperfection is drawn per photo from its author's list: what that kind of phone photo really gets wrong. A list never repeats its capture line (the tilt is already there). */
export const IMPERFECTIONS: Readonly<Record<Shot, readonly string[]>> = {
  selfie: ["a slight close-up wide-angle look", "a slight wide-angle stretch at the edges"],
  mirror: ["a few smudges on the mirror", "a little glare from the ceiling light on the mirror"],
  friend: FRIEND_IMPERFECTIONS,
  candid: FRIEND_IMPERFECTIONS,
  photographer: FRIEND_IMPERFECTIONS,
};

/** The key every per-slot draw is seeded from. A run id is unique per run and the attempt id base is stable across a resume (schema.ts). */
export function slotKeyOf(runId: string, attemptIdBase: string): string {
  return `${runId}:${attemptIdBase}`;
}

/** The slot's imperfection: a pure function of the key, on a stream of its own. */
export function imperfectionOf(shot: Shot, key: string, legs = false): string {
  // «Ножки»: her hands are empty and out of the frame, so a legs frame draws no artefact of a moving hand (the list is the same length elsewhere, so no other draw moves).
  const list = legs ? IMPERFECTIONS[shot].filter((text) => !/\bhand\b/.test(text)) : IMPERFECTIONS[shot];
  return rngPick(makeRng(fnv1a(`${key}:imperfection`)), list);
}

/**
 * The artefact line. «Реализм камеры» on adds the camera-roll artefacts and the imperfection; off keeps the light and the sharp background, which
 * are the part of the look the owner rated. Both are positive: they say what the photo is, never what it lacks.
 */
export function artefactLine(input: { cameraRealism: boolean; light: string; imperfection: string; lampMood?: boolean }): string {
  // I5.34: «Дом»'s lamp places at evening and night keep the dim lamp light, the soft shadow and the grain the owner's references show, in place of «everything in focus».
  if (input.lampMood === true) {
    if (!input.cameraRealism) return "Ordinary phone photo: dim evening light from a bedside lamp, the room in soft shadow, muted colours.";
    return `Ordinary phone photo straight from her camera roll: dim evening light from a bedside lamp, the room in soft shadow, visible grain from the low light, muted colours, slightly soft focus, ${input.imperfection}.`;
  }
  if (!input.cameraRealism) return `Ordinary phone photo: ${input.light}, everything in focus, the background as sharp as she is.`;
  return `Ordinary phone photo straight from her camera roll: ${input.light}, flat auto-exposure, slight noise in the shadows, mild JPEG compression, ${input.imperfection}, everything in focus, the background as sharp as she is.`;
}

/** Whether a slot gets the lamp mood (I5.34): a place with a lamp (only «Дом»'s), at evening or night. */
export function isLampMood(place: { lamp?: boolean | undefined } | null, timeOfDay: string | undefined): boolean {
  return place?.lamp === true && (timeOfDay === "evening" || timeOfDay === "night");
}

/** The hair line (I5.25): hair varies from photo to photo, its colour never; the style is `hairstyleSequence`'s (shared/scenes/hair.ts). */
export function hairLine(style: string): string {
  return `Today her hair is ${style}: the same hair colour as in the reference photo, only styled differently.`;
}

/**
 * The part of a place the room draw reads: whether it is a room at all, the ordinary things in it, and whether the chosen activity may happen in a
 * messy room. Injected, so this module needs no pool: 5a.1c adds the pool fields and the lookup by place name.
 */
export interface RoomPlace {
  room: boolean;
  details: readonly string[];
  activity: { messyOk?: boolean | undefined };
}

// The shares of the three states: tidy below 0.70, lived-in below 0.95, messy above (≤ 5 %).
const TIDY_BELOW = 0.7;
const LIVED_IN_BELOW = 0.95;

/**
 * The room phrase for a slot, placed straight after the sentence, or null when the place is not a room or is unknown (a renamed place of an old plan,
 * an own scene, a custom category). About 70 % of rooms are tidy, 25 % lived-in, and at most 5 % messy, and a messy room only goes with a `messyOk`
 * activity; otherwise those draws are lived-in. A pure function of the key and the place.
 */
export function roomStateOf(key: string, place: RoomPlace | null): string | null {
  if (place === null || !place.room || place.details.length === 0) return null;
  const rng = makeRng(fnv1a(`${key}:room`));
  const draw = rng();
  if (draw >= LIVED_IN_BELOW && place.activity.messyOk === true) return "The room is messy, with clothes tried on and left on the bed.";
  if (draw >= TIDY_BELOW && place.details.length >= 2) {
    const [first, second] = shuffle(rng, place.details);
    return `The room looks lived-in, with ${first} and ${second}.`;
  }
  return `The room is ordinary and fairly tidy, with ${rngPick(rng, place.details)}.`;
}
