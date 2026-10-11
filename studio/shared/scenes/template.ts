import { isCustomCategory } from "../engine";
import { BANKS } from "./banks";
import { BANK_CATEGORIES, type BankCategory } from "./banks/types";
import { customSentence } from "./custom";
import { momentAllowed, renderSentence, type SentenceParts, type TemplateContext, type TemplateSlot } from "./render";

// 5a.2 (S5.6a, plan s5a2 §5.2): the code template. Every new built-in and custom planned scene gets its sentence from here, not from the LLM writer:
//
//   «{At}, she {moment}, wearing {outfit}, {gaze}, {cue}, with {detail}.»
//
// with r1.1's corrections: a gaze never names a camera or a lens, and only a mirror gaze names her phone (K-2); a room drops `with {detail}`, because
// its room phrase already carries the details (K-3); a back pose drops both the gaze and the cue. A frame with her face hidden (the owner's references,
// 2026-10-11) drops them too. A custom category renders through the adapter (custom.ts). The draws are hash picks of the slot's key (I5.4: a resume
// renders the same text), on the streams `gaze`, `cue` and `detail`; an equal sentence in the same run is redrawn on `${key}:dedup:${i}` (I5.24).
// Never a throw: whatever the banks cannot render is null, and a null slot goes to the LLM writer (I5.22).

export { DEDUP_TRIES, gazeKindsFor, momentAllowed, type TemplateContext, type TemplateSlot } from "./render";

function bankCategory(category: string): BankCategory | undefined {
  return BANK_CATEGORIES.find((c) => c === category);
}

/** A built-in slot's sentence: its place by name in its category's bank, its moment by text in that place, its outfit in the bank's list. */
function builtInSentence(category: BankCategory, slot: TemplateSlot, ctx: TemplateContext): string | null {
  const bank = BANKS[category];
  const place = bank.places.find((p) => p.name === slot.location);
  const moment = place?.moments.find((m) => m.text === slot.activity);
  if (place === undefined || moment === undefined || slot.outfit === undefined || !bank.outfits.includes(slot.outfit)) return null;
  if (!momentAllowed(moment, slot.shot, slot.pose, ctx.level ?? "ordinary")) return null;
  const parts: SentenceParts = { at: place.at, doing: moment.text, outfit: slot.outfit, gaze: moment.gaze, details: place.room === true ? [] : place.details };
  return renderSentence(parts, slot, ctx);
}

/** The slot's sentence from the banks or the custom adapter, or null when neither can render it (it then goes to the LLM writer at its chunk's reserved ids). */
export function templateSentence(slot: TemplateSlot, ctx: TemplateContext): string | null {
  const category = bankCategory(slot.category);
  if (category !== undefined) return builtInSentence(category, slot, ctx);
  if (isCustomCategory(slot.category) && (ctx.snapshots ?? []).some((s) => s.ref === slot.category)) return customSentence(slot, ctx);
  return null;
}
