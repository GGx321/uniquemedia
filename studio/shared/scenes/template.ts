import { isCustomCategory } from "../engine";
import { BANKS } from "./banks";
import { BANK_CATEGORIES, type BankCategory, type Moment, type Outfit } from "./banks/types";
import { customSentence } from "./custom";
import { captureOfSlot, momentAllowed, renderSentence, type SentenceParts, type TemplateContext, type TemplateSlot } from "./render";
import { LEGWEAR_CLASH_WORDS } from "./words";

// 5a.2 (S5.6a, plan s5a2 r1.2 §5.2): the code template. Every new built-in and custom planned scene gets its sentence from here, not from the LLM
// writer:
//
//   «{At}, she {moment}, wearing {outfit}[ with {legwear}], {gaze}, {cue}, with {detail}.»
//
// The capture decides which clauses appear (render.ts): a gaze never names a camera or a lens, and only a mirror gaze names her phone (K-2); a
// face-hidden or back frame drops the gaze and the cue; a room drops `with {detail}`, because its room phrase carries the details (K-3). A custom
// category renders through the adapter (custom.ts). The draws are hash picks of the slot's key (I5.4: a resume renders the same text), on the streams
// `gaze`, `cue` and `detail`; an equal sentence in the same run is redrawn on `${key}:dedup:${i}` (I5.24). Never a throw: whatever the banks cannot
// render is null, and a null slot goes to the LLM writer (I5.22).

export { DEDUP_TRIES, GazeCueTally, gazeKindsFor, momentAllowed, type MomentTags, type TemplateContext, type TemplateSlot } from "./render";

/**
 * Whether a moment may wear the legwear slot with this outfit (I5.29, plan r1.4): the outfit shows her legs, and the moment neither names legwear or
 * bare skin itself (never «bare feet … with knee-high socks») nor is tagged `noLegwear` (her feet up: Grok refused legs up in tights). Legs alone
 * («legs crossed», «stretches her legs») do not stop it.
 */
export function legwearFits(moment: Pick<Moment, "text" | "noLegwear">, outfit: Outfit): boolean {
  return outfit.showsLegs === true && moment.noLegwear !== true && !LEGWEAR_CLASH_WORDS.test(moment.text);
}

function bankCategory(category: string): BankCategory | undefined {
  return BANK_CATEGORIES.find((c) => c === category);
}

/**
 * A built-in slot's sentence: its place by name in its category's bank, its moment by text in that place (taking the slot's capture and pose), its
 * outfit from the bank (one the moment pins, if it pins any), and its legwear from the bank on an outfit that may wear it.
 */
function builtInSentence(category: BankCategory, slot: TemplateSlot, ctx: TemplateContext): string | null {
  const bank = BANKS[category];
  const capture = captureOfSlot(slot);
  const place = bank.places.find((p) => p.name === slot.location);
  const moment = place?.moments.find((m) => m.text === slot.activity);
  const outfit = bank.outfits.find((o) => o.text === slot.outfit);
  if (capture === null || place === undefined || moment === undefined || outfit === undefined) return null;
  // A pinning moment wears only its outfits; a pin-only outfit goes only to a moment that pins it (re-review 1).
  if (moment.outfits !== undefined && !moment.outfits.includes(outfit.text)) return null;
  if (outfit.pinOnly === true && moment.outfits === undefined) return null;
  if (!momentAllowed(moment, capture, slot.pose, ctx.level ?? "ordinary", slot.framing)) return null;
  let wearing = outfit.text;
  if (slot.legwear !== undefined) {
    if (!(bank.legwear?.items.includes(slot.legwear) ?? false) || !legwearFits(moment, outfit)) return null;
    wearing = `${outfit.text} with ${slot.legwear}`;
  }
  const parts: SentenceParts = { at: place.at, doing: moment.text, wearing, gaze: moment.gaze, expression: moment.expression === true, handAtFace: moment.handAtFace === true, details: place.room === true ? [] : place.details };
  return renderSentence(parts, { capture, pose: slot.pose, framing: slot.framing }, ctx);
}

/** The slot's sentence from the banks or the custom adapter, or null when neither can render it (it then goes to the LLM writer at its chunk's reserved ids). */
export function templateSentence(slot: TemplateSlot, context: TemplateContext): string | null {
  // S5.7b: the slot's own «Подача» wins; a run mixes flirty and ordinary slots, so the level is the slot's, not the list's.
  const ctx: TemplateContext = slot.level === undefined ? context : { ...context, level: slot.level };
  const category = bankCategory(slot.category);
  if (category !== undefined) return builtInSentence(category, slot, ctx);
  if (isCustomCategory(slot.category) && (ctx.snapshots ?? []).some((s) => s.ref === slot.category)) return customSentence(slot, ctx);
  return null;
}
