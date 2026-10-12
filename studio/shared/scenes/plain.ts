import type { PoolShot, ScenePose } from "../engine";
import { BANKS, CUES } from "./banks";
import { BANK_CATEGORIES, type Level } from "./banks/types";
import { captureOfShot, faceVisibleOf, shotOf, type Capture } from "./captures";
import { pick } from "./hash";
import { locativeOf, rendersActivity } from "./custom";
import { PHONE_WORDS, SELFIE_WORDS } from "./words";

// 5a.2 (S5.6d, plan s5a2 §5.5 «After the last attempt»): the sentence a planned slot takes when the model could not write it in the two answered attempts a chunk
// has: «{place}, she {is} {activity}, wearing {outfit}.» It is built from the slot's own stored texts and nothing else (no legwear, no gaze, no detail), so it can
// never be refused by a model and never costs a request. The assembler still holds it to the word rules before an image is paid for.
//
// It reads as English for the shapes the pools store: a place the bank knows by name opens with the bank's own phrase («in her small kitchen»), any other with its
// locative («in a cafe», «on the beach», «at a corner table»; a name that opens with a preposition is kept); a moment the bank knows is «she {moment}»; a custom
// activity that opens with an «-ing» verb is «she is {activity}», and any other is «she {activity}» (the shared rules of custom.ts). On a self-shot slot a clause that
// names a phone or says «selfie» is left out (rule C1: it would draw a second phone), so the sentence stays whole.

/** The slot's texts without the punctuation a stored text may end with, so the sentence's own separators are the only ones. */
const field = (text: string): string => text.trim().replace(/[\s.,;:!]+$/, "");

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

export interface PlainSlot {
  category: string;
  location: string;
  activity: string;
  outfit: string;
  /** The stored shot and the capture riding on it: a self-shot slot is held to rule C1. Absent: not a self-shot. */
  shot?: PoolShot | undefined;
  capture?: Capture | undefined;
  /** «Подача» (S5.7b): a flirty slot ends with one flirty cue, where her face shows. Absent: ordinary. */
  level?: Level | undefined;
  /** Whether her face shows reads the pose; absent: front. */
  pose?: ScenePose | undefined;
}

/** An activity that opens with a preposition reads after «she is» («on the phone with her sister», «at the window, smiling»). */
const OPENS_WITH_PREPOSITION = /^(?:in|on|at|by|under|near|beside|behind|along|against|inside|outside|over|across|around|with)\s/i;
/** An activity that opens with «is» («is reading») already carries its verb: it reads after «she» as it is. */
const OPENS_WITH_BE = /^is\s/i;
/** The leading words of the bank's moments («holds», «stretches»): a positive list of third-person verbs. */
const BANK_VERBS: ReadonlySet<string> = new Set(
  Object.values(BANKS).flatMap((bank) => bank.places.flatMap((place) => place.moments.map((moment) => /^[a-z]+/i.exec(moment.text)?.[0]?.toLowerCase() ?? ""))).filter((word) => word !== ""),
);
/** A word that looks like a third-person verb («waters»). «pilates», «tennis» and «aerobics» look like one too. */
const LOOKS_LIKE_A_THIRD_PERSON = /^[a-z]{2,}[^s\W]s$/i;
/** What follows a verb that has an object: a determiner or a pronoun («takes a short break», «sips her coffee»). Never a preposition: «pilates in the park» is a noun phrase. */
const OPENS_AN_OBJECT = /^(?:a|an|the|some|her|his|their|its|it|them|one|another|more)\b/i;
/** A determiner opens a noun phrase, never a verb («a slow walk by the water»). */
const OPENS_WITH_A_DETERMINER = /^(?:a|an|the|some|her|two|his|their)\s/i;

/**
 * Whether the activity opens with a verb of its own. A leading word of the bank's moments is one. Any other word that ends in «s» is taken for one only
 * when an object follows («waters the plants»): a noun that ends in «s» («pilates class», «tennis practice», «aerobics») and a noun phrase with a
 * preposition («pilates in the park») are not verbs.
 */
function opensWithAVerb(activity: string): boolean {
  const [first = "", ...rest] = activity.trim().split(/\s+/);
  const word = first.replace(/[^a-z]+$/i, "").toLowerCase();
  if (BANK_VERBS.has(word)) return true;
  return LOOKS_LIKE_A_THIRD_PERSON.test(word) && OPENS_AN_OBJECT.test(rest.join(" "));
}

/**
 * What follows «she» for a custom activity (S5.6R): «is {activity}» for an «-ing» verb or a position (custom.ts `rendersActivity`) and for a preposition; the
 * activity itself for a verb of its own; and «is enjoying {activity}» for a noun phrase, which read «she morning stretches» before.
 */
function customDoing(activity: string): string {
  if (rendersActivity(activity) || OPENS_WITH_PREPOSITION.test(activity)) return `is ${activity}`;
  if (OPENS_WITH_BE.test(activity) || (opensWithAVerb(activity) && !OPENS_WITH_A_DETERMINER.test(activity))) return activity;
  return `is enjoying ${activity}`;
}

export function plainSentence(slot: PlainSlot): string {
  const bank = BANK_CATEGORIES.find((c) => c === slot.category);
  const place = bank === undefined ? undefined : BANKS[bank].places.find((p) => p.name === slot.location);
  const moment = place?.moments.find((m) => m.text === slot.activity);
  const at = place === undefined ? locativeOf(field(slot.location)) : field(place.at);
  const activity = field(slot.activity);
  const doing = moment !== undefined ? moment.text : customDoing(activity);
  const selfShot = slot.capture !== undefined ? shotOf(slot.capture) === "selfie" : slot.shot !== undefined && shotOf(captureOfShot(slot.shot)) === "selfie";
  const names = (text: string): boolean => selfShot && (PHONE_WORDS.test(text) || SELFIE_WORDS.test(text));
  const outfit = field(slot.outfit);
  const clauses = [names(at) ? null : capitalised(at), `she ${names(doing) ? "stands there" : doing}`, names(outfit) ? null : `wearing ${outfit}`].filter((c): c is string => c !== null);
  // S5.7b: the flirty choice rides on the plain sentence too: one flirty cue, the same for the same slot, on a frame where her face shows and the moment does not
  // already show an expression of its own.
  const capture = slot.capture ?? captureOfShot(slot.shot ?? "friend");
  const faceShows = faceVisibleOf({ capture, pose: slot.pose ?? "front" }) !== "no";
  if (slot.level === "flirty" && faceShows && moment?.expression !== true) {
    const cues = CUES.filter((c) => c.level === "flirty" && (c.captures === undefined || c.captures.includes(capture)));
    if (cues.length > 0) clauses.push(pick(cues, `${field(slot.location)}|${activity}`, "plain-cue").text);
  }
  const sentence = clauses.join(", ");
  return `${clauses[0] === undefined || names(at) ? capitalised(sentence) : sentence}.`;
}
