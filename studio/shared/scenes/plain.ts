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

export function plainSentence(slot: PlainSlot): string {
  const bank = BANK_CATEGORIES.find((c) => c === slot.category);
  const place = bank === undefined ? undefined : BANKS[bank].places.find((p) => p.name === slot.location);
  const moment = place?.moments.find((m) => m.text === slot.activity);
  const at = place === undefined ? locativeOf(field(slot.location)) : field(place.at);
  const activity = field(slot.activity);
  const doing = moment !== undefined ? moment.text : rendersActivity(activity) ? `is ${activity}` : activity;
  const selfShot = slot.capture !== undefined ? shotOf(slot.capture) === "selfie" : slot.shot !== undefined && shotOf(captureOfShot(slot.shot)) === "selfie";
  const names = (text: string): boolean => selfShot && (PHONE_WORDS.test(text) || SELFIE_WORDS.test(text));
  const outfit = field(slot.outfit);
  const clauses = [names(at) ? null : capitalised(at), `she ${names(doing) ? "stands there" : doing}`, names(outfit) ? null : `wearing ${outfit}`].filter((c): c is string => c !== null);
  const sentence = clauses.join(", ");
  return `${clauses[0] === undefined || names(at) ? capitalised(sentence) : sentence}.`;
}
