import { isCustomCategory, type SceneRoute } from "../engine";
import { bankPlaceOf } from "./bankLookup";
import { legwearAt } from "./level";
import { BANK_CATEGORIES, type BankCategory, type BankPlace, type CategoryBank, type Moment, type Outfit } from "./banks/types";
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

/**
 * The positive coverage sentence a slot appends (5a.4, S5.BA3, I5.74, H3). The item that carries one is the moment, else the outfit. An imported avatar, an avatar of unknown origin and
 * a caller that does not say (`impliedNudity` false or absent: the fail-closed default) always say that item's kept `coverage`. A Studio-created avatar says its `openCoverage`, which is
 * absent where P-BA drew the class without a sentence: then it says none. The open sentence of a class P-BA could not draw open is its kept one (the bank's data says so).
 */
export function coverageOf(moment: Pick<Moment, "coverage" | "openCoverage">, outfit: Pick<Outfit, "coverage" | "openCoverage">, impliedNudity = false): string | undefined {
  const item = moment.coverage !== undefined ? moment : outfit;
  return impliedNudity ? item.openCoverage : item.coverage;
}

/**
 * 5a.4 (S5.BA4 round 2, review M1, I5.74): what a «Смелая» outfit says when its bank's data has no kept sentence for it (a broken edit): restrictive, so a Seedream
 * outfit never goes out without one. The shipped banks never reach it (writer.bold.test.ts sweeps every Seedream outfit of every «Смелая» bank).
 */
export const KEPT_FALLBACK = "What she wears fully covers her breasts and her hips.";

/**
 * 5a.4 (S5.BA4 round 2, review M1, I5.74): the coverage sentence of `worn`, an outfit of `bank`, by origin. `moment` is the slot's moment, or undefined when the bank
 * no longer has it (a moment reworded after the slot was stored: nightwear's «lies holding the sheet to her chest», r2.2 P3).
 * - The moment found: `coverageOf`, the template's rule (the open sentence, or none, for a Studio-created avatar).
 * - The moment gone: the KEPT sentence, for every avatar (the controller's decision: such an old slot is rewritten as it is, never redrawn, and always says the
 *   kept one): the outfit's own, else that of the bank's moment that pins the outfit (the sheet, the towel and the foam carry theirs on their moments).
 * - Fail-closed: a Seedream outfit its bank says no kept sentence for says KEPT_FALLBACK, never none. An outfit off the route says none, as before.
 */
export function coverageOfWorn(bank: CategoryBank, moment: Moment | undefined, worn: Outfit, impliedNudity = false): string | undefined {
  const pinnedBy = bank.places.flatMap((place) => place.moments).find((m) => m.outfits?.includes(worn.text) === true && m.coverage !== undefined);
  const kept = moment === undefined ? (worn.coverage ?? pinnedBy?.coverage) : (moment.coverage ?? worn.coverage);
  if (kept === undefined) return worn.route === "seedream" ? KEPT_FALLBACK : undefined;
  return moment === undefined ? kept : coverageOf(moment, worn, impliedNudity);
}

/**
 * 5a.4 (S5.BA4 round 2, review M1): the coverage sentence a slot's sentence ends with, by origin: the one helper the writer's bold reader (appended after the read)
 * and the plain sentence share. Undefined for an outfit no bank of the slot holds (an old cotton outfit, an unrouted custom slot, an ordinary bank's outfit).
 */
export function slotCoverageOf(slot: BankSlot & { outfit: string }, impliedNudity = false): string | undefined {
  const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity });
  const worn = hit?.bank.outfits.find((outfit) => outfit.text === slot.outfit);
  return hit === undefined || worn === undefined ? undefined : coverageOfWorn(hit.bank, hit.moment, worn, impliedNudity);
}

function bankCategory(category: string): BankCategory | undefined {
  return BANK_CATEGORIES.find((c) => c === category);
}

/** What the bank lookup reads of a slot: its category, its place's name and its activity (a candidate the planner weighs may have neither yet: it finds nothing). */
export interface BankSlot {
  category: string;
  location?: string | undefined;
  activity?: string | undefined;
  /** 5a.4 (I5.73): the Seedream route; with it the five read their companion. Absent: the bank they always read. */
  route: SceneRoute | undefined;
}

/** The bank place of a built-in slot, by the one marker-aware lookup (`bankPlaceOf`). Undefined for a custom category, an own scene or a place the bank no longer has. */
export function placeOfSlot(slot: Pick<BankSlot, "category" | "location" | "route">): BankPlace | undefined {
  return bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location })?.place;
}

/**
 * The bank moment of a built-in slot: its place by name, then the moment by its text in that place. The one lookup (5b.1, S5.V5): the template, the plain sentence and a
 * clip's motion all find a slot's moment here, so a clip never animates a moment its photo's sentence did not name. Undefined for a custom category, an own scene, or a
 * place or moment the bank no longer has (a renamed one).
 */
export function momentOfSlot(slot: BankSlot): Moment | undefined {
  return bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity })?.moment;
}

/**
 * A built-in slot's sentence: its place by name in its category's bank, its moment by text in that place (taking the slot's capture and pose), its
 * outfit from the bank (one the moment pins, if it pins any), and its legwear from the bank on an outfit that may wear it.
 */
function builtInSentence(slot: TemplateSlot, ctx: TemplateContext): string | null {
  const capture = captureOfSlot(slot);
  const hit = bankPlaceOf({ category: slot.category, route: slot.route, location: slot.location, activity: slot.activity });
  if (hit === undefined) return null;
  const { bank, place, moment } = hit;
  const outfit = bank.outfits.find((o) => o.text === slot.outfit);
  if (capture === null || moment === undefined || outfit === undefined) return null;
  // A pinning moment wears only its outfits; a pin-only outfit goes only to a moment that pins it (re-review 1).
  if (moment.outfits !== undefined && !moment.outfits.includes(outfit.text)) return null;
  if (outfit.pinOnly === true && moment.outfits === undefined) return null;
  if (!momentAllowed(moment, capture, slot.pose, ctx.level ?? "ordinary", slot.framing)) return null;
  let wearing = outfit.text;
  if (slot.legwear !== undefined) {
    // 5a.3 (M3): the legwear lookup reads the slot's level list; a stocking on a slot that is not bold, or on an outfit the bold list does not name, renders nothing.
    const list = legwearAt(bank.legwear, ctx.level ?? "ordinary");
    if (list === undefined || !list.items.includes(slot.legwear) || !(list.outfits?.includes(outfit.text) ?? true) || !legwearFits(moment, outfit)) return null;
    wearing = `${outfit.text} with ${slot.legwear}`;
  }
  const coverage = coverageOf(moment, outfit, ctx.impliedNudity === true);
  const parts: SentenceParts = {
    at: place.at,
    doing: moment.text,
    wearing,
    gaze: moment.gaze,
    expression: moment.expression === true,
    handAtFace: moment.handAtFace === true,
    // S5.R4 round 3: a «Смелая» moment may say details of its own (what a look down at her feet sees); every other moment says its place's.
    details: place.room === true ? [] : (moment.details ?? place.details),
    ...(coverage === undefined ? {} : { coverage }),
  };
  return renderSentence(parts, { capture, pose: slot.pose, framing: slot.framing }, ctx);
}

/** The slot's sentence from the banks or the custom adapter, or null when neither can render it (it then goes to the LLM writer at its chunk's reserved ids). */
export function templateSentence(slot: TemplateSlot, context: TemplateContext): string | null {
  // S5.7b: the slot's own «Подача» wins; a run mixes flirty and ordinary slots, so the level is the slot's, not the list's.
  const ctx: TemplateContext = slot.level === undefined ? context : { ...context, level: slot.level };
  if (bankCategory(slot.category) !== undefined) return builtInSentence(slot, ctx);
  // 5a.4 (I5.77): a custom category's «Смелая» frame is the writer's, who sets it inside the category's world; the template renders only the frames stored before 5a.4.
  if (isCustomCategory(slot.category) && slot.route !== "seedream" && (ctx.snapshots ?? []).some((s) => s.ref === slot.category)) return customSentence(slot, ctx);
  return null;
}
