import { HairLength as HairLengthEnum } from "../../shared/engine";
import type { HairLength } from "../../shared/scenes/banks/types";
import { hairstyleSequence, type HairSlot } from "../../shared/scenes/hair";
import { POOLS } from "./pools";
import { isOwnSlot, type RunSlot } from "./schema";
import { CATEGORIES } from "./types";

// 5a.2 (S5.6b, plan s5a2 §5.3): the hair line of a run's prompts. Hair varies from photo to photo (a ponytail, a claw clip, a loose braid) while its colour never
// changes; the style is drawn once for the whole run, in slot order, by the shared `hairstyleSequence` (avoid the previous 3; tied styles on `tied` moments
// only and at most a quarter of the run; a sporty style on 3 in 4 of the run's `sport` moments, «Фитнес»'s workouts (S5.6R); a cap outdoors only and at most
// an eighth). Each slot's tags come from its moment in today's pools; an own scene, a
// custom category and a renamed place have none and simply take a style.

/** The avatar's hair length from its stored traits, or undefined when it holds none we can read (such an avatar's prompts carry no hair line). */
export function hairLengthOf(traits: Readonly<Record<string, unknown>>): HairLength | undefined {
  const parsed = HairLengthEnum.safeParse(traits["hairLength"]);
  return parsed.success ? parsed.data : undefined;
}

/** An outfit with a hat («a bikini and a straw hat», 5a.3): the slot takes no cap. */
const HAT = /\bhat\b/i;

function tagsOf(slot: RunSlot): HairSlot {
  if (isOwnSlot(slot)) return {};
  const category = CATEGORIES.find((c) => c === slot.category);
  const moment = category === undefined ? undefined : POOLS[category].locations.find((l) => l.name === slot.location)?.activities.find((a) => a.text === slot.activity);
  return { hair: moment?.hair, outdoor: moment?.outdoor === true, framing: slot.framing, hat: HAT.test(slot.outfit) };
}

/** Each slot's hairstyle (as it reads after «Today her hair is …»), by slot number; a slot with no line is absent. */
export function hairLinesOf(slots: readonly RunSlot[], length: HairLength, runId: string): ReadonlyMap<number, string> {
  const styles = hairstyleSequence(slots.map(tagsOf), length, runId);
  const out = new Map<number, string>();
  for (const [i, slot] of slots.entries()) {
    const style = styles[i];
    if (style !== undefined && style !== null) out.set(slot.slotIndex, style);
  }
  return out;
}
