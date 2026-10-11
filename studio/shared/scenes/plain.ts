import { BANKS } from "./banks";
import { BANK_CATEGORIES } from "./banks/types";

// 5a.2 (S5.6d, plan s5a2 §5.5 «After the last attempt»): the sentence a planned slot takes when the model could not write it in the two answered attempts a chunk
// has: «{at or "At " + location}, she is {activity}, wearing {outfit}.» It is built from the slot's own stored texts and nothing else (no legwear, no gaze, no
// detail), so it can never be refused by a model and never costs a request. The assembler still holds it to the word rules before an image is paid for.

/** The slot's texts without the punctuation a stored text may end with, so the sentence's own separators are the only ones. */
const field = (text: string): string => text.trim().replace(/[\s.,;:!]+$/, "");

const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The place as a locative phrase: the bank's own «in her small kitchen» when a built-in bank knows the place by name, «At {location}» otherwise. */
function locativeOf(category: string, location: string): string {
  const bank = BANK_CATEGORIES.find((c) => c === category);
  const place = bank === undefined ? undefined : BANKS[bank].places.find((p) => p.name === location);
  return place === undefined ? `At ${field(location)}` : capitalised(field(place.at));
}

export function plainSentence(slot: { category: string; location: string; activity: string; outfit: string }): string {
  return `${locativeOf(slot.category, slot.location)}, she is ${field(slot.activity)}, wearing ${field(slot.outfit)}.`;
}
