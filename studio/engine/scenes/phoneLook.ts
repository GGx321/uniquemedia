import { fnv1a, makeRng, rngPick, shuffle } from "./rngUtil";
import type { Shot } from "./types";

// S5.1a: the phone look. Every phrase that makes a scene read as her own ordinary phone photo lives here and nowhere else (I5.1): the capture line
// of each author, the phone-hand line, the artefact lines, the light table, the imperfections, the room phrases and the constraints. The assembler
// only places them. Keyed by author (today's five shots) for the `photo` medium; 5b.1 adds `video`, 5a.2 adds `propped` and `pov`.
//
// What the text must never do (the owner's blind rating and spike A, `.omc/stage5/spike-a-results.md`):
// - show a phone outside the mirror (the «second phone» defect): the selfie line says the phone itself is not in the picture (I5.2);
// - stage a camera or a studio, or name golden light (I5.3);
// - negate a look term («no retouching», «no bokeh»): a negation puts the term into the prompt (I5.10). It says what the photo IS instead.
//
// The draws (the imperfection, the room state) are pure functions of a key, `${runId}:${attemptIdBase}`, never of the plan's seed (a run made from a
// scene set has seed 0) and never of a clock, so a resume assembles the same prompt (I5.4).

// A `photographer` slot is a friend's snap too: the stored shot stays readable (I5.5), the author is a friend.
const FRIEND_SNAP =
  "A quick phone snap a friend took of her from three or four steps away, on the rear camera at eye level, a little off-centre, the horizon slightly tilted, with a little too much space above her head; she is not taking the photo herself, and her whole body is in the picture.";

/** The first sentence of every prompt: how the photo was taken. */
export const CAPTURE_LINE: Readonly<Record<Shot, string>> = {
  selfie:
    "A casual selfie she took herself on her phone's front camera at arm's length, held a little above eye level, her arm running out of the frame at one edge, the frame slightly tilted; the phone itself is not in the picture.",
  mirror:
    "A mirror selfie she took herself: her phone in her hand at chest height, visible in the mirror and held low enough to leave her face clear, the room behind her in the reflection.",
  friend: FRIEND_SNAP,
  photographer: FRIEND_SNAP,
  candid: `${FRIEND_SNAP} She is busy with something and not looking toward the camera.`,
};

/** The constraint about her hands: only the mirror author holds a phone in view, and a selfie's phone arm is out of the frame. Null for the rest. */
export function phoneHandLine(shot: Shot): string | null {
  if (shot === "mirror") return "One hand holds the phone; only her other hand acts.";
  if (shot === "selfie") return "Her phone arm runs out of the frame; only her other hand acts.";
  return null;
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
  selfie: ["a slight front-camera wide-angle look", "a slight wide-angle stretch at the edges"],
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
export function imperfectionOf(shot: Shot, key: string): string {
  return rngPick(makeRng(fnv1a(`${key}:imperfection`)), IMPERFECTIONS[shot]);
}

/**
 * The artefact line. «Реализм камеры» on adds the camera-roll artefacts and the imperfection; off keeps the light and the sharp background, which
 * are the part of the look the owner rated. Both are positive: they say what the photo is, never what it lacks.
 */
export function artefactLine(input: { cameraRealism: boolean; light: string; imperfection: string }): string {
  if (!input.cameraRealism) return `Ordinary phone photo: ${input.light}, everything in focus, the background as sharp as she is.`;
  return `Ordinary phone photo straight from her camera roll: ${input.light}, flat auto-exposure, slight noise in the shadows, mild JPEG compression, ${input.imperfection}, everything in focus, the background as sharp as she is.`;
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
