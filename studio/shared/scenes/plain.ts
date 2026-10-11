import type { PoolShot } from "../engine";
import { BANKS } from "./banks";
import { BANK_CATEGORIES } from "./banks/types";
import { captureOfShot, shotOf, type Capture } from "./captures";
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
}

/** An activity that opens with a preposition reads after «she is» («on the phone with her sister», «at the window, smiling»). */
const OPENS_WITH_PREPOSITION = /^(?:in|on|at|by|under|near|beside|behind|along|against|inside|outside|over|across|around|with)\s/i;
/** An activity that opens with a third-person verb of its own («takes a short break», «waters the plants») reads after «she». */
const OPENS_WITH_A_VERB = /^[a-z]{2,}[^s\W]s\b/i;
/** A determiner opens a noun phrase, never a verb («a slow walk by the water»). */
const OPENS_WITH_A_DETERMINER = /^(?:a|an|the|some|her|two|his|their)\s/i;

/**
 * What follows «she» for a custom activity (S5.6R): «is {activity}» for an «-ing» verb or a position (custom.ts `rendersActivity`) and for a preposition; the
 * activity itself for a verb of its own; and «is enjoying {activity}» for a noun phrase, which read «she morning stretches» before.
 */
function customDoing(activity: string): string {
  if (rendersActivity(activity) || OPENS_WITH_PREPOSITION.test(activity)) return `is ${activity}`;
  if (OPENS_WITH_A_VERB.test(activity) && !OPENS_WITH_A_DETERMINER.test(activity)) return activity;
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
  const sentence = clauses.join(", ");
  return `${clauses[0] === undefined || names(at) ? capitalised(sentence) : sentence}.`;
}
