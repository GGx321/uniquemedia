import { HAIRSTYLES } from "./banks";
import type { HairLength, Hairstyle, MomentHair } from "./banks/types";
import { pick } from "./hash";

// 5a.2 (S5.6a, plan s5a2 §5.3, I5.24, I5.25): the run's hairstyles. Hair varies from photo to photo while its colour never changes (the hair line,
// engine/scenes/phoneLook.ts in S5.6b, always says «the same hair colour as in the reference photo»).
//
// Probe P-5a2 (2026-10-11): a messy bun on the portrait reference lost likeness (cos 0.714, under the 0.718 bar), so a tied style goes only to a
// moment tagged `tied`, and to at most 1 in 4 photos of a run, spread over the run's tied moments; a tied moment past that takes a loose style. A cap
// goes only to an outdoor moment, at most 1 in 8. A moment that names her hair, and a legs frame, get no hair line. The draw is a hash pick on
// `${runId}:hair`, in slot order: a style avoids the previous 3, then only the previous 1, then takes any, so a resume draws the same styles.
//
// S5.6R (round C, the owner): «Фитнес» trained in blow-dried hair on 3 in 4 of its frames, because the tied cap is the run's. Its workout moments are
// `sport` moments now: 3 in 4 of a run's sport moments (spread over them) wear a sporty style (`Hairstyle.sport`: a ponytail, the sleek bun, the braid, tied
// or pinned back), which is not counted in the tied cap; the rest take a loose style, or a cap outdoors. The messy buns are not sporty (P-5a2), so the
// likeness risk the cap guards against stays out of the sport styles; the face gate still checks every photo.

/** What the hairstyle draw reads of a slot: its moment's hair and outdoor tags, and the legs framing (5a.2c). */
export interface HairSlot {
  hair?: MomentHair | undefined;
  outdoor?: boolean | undefined;
  framing?: "legs" | undefined;
}

/** At most 1 in 4 photos of a run wears a tied style (probe P-5a2). */
export function tiedCap(n: number): number {
  return Math.floor(n / 4);
}

/** At most 1 in 8 photos of a run wears a cap (plan s5a2 §5.3, C3′ rule 6). */
export function capCap(n: number): number {
  return Math.floor(n / 8);
}

/** How many of a run's sport moments wear a sporty style: 3 in 4, rounded up (S5.6R). */
export function sportyOf(moments: number): number {
  return moments - Math.floor(moments / 4);
}

/** Whether the k-th of the run's T tied moments gets a tied style, when C of them may: an even spread, exactly C of the T. */
function tiedTurn(k: number, tiedMoments: number, allowed: number): boolean {
  return Math.floor(((k + 1) * allowed) / tiedMoments) > Math.floor((k * allowed) / tiedMoments);
}

/** Each slot's hairstyle as it reads after «Today her hair is …», or null for no hair line. A pure function of its arguments. */
export function hairstyleSequence(slots: readonly HairSlot[], length: HairLength, runId: string): (string | null)[] {
  const fits = HAIRSTYLES.filter((s) => s.lengths.includes(length));
  const tiedMoments = slots.filter((s) => s.hair === "tied" && s.framing !== "legs").length;
  const tiedAllowed = Math.min(tiedCap(slots.length), tiedMoments);
  const sportMoments = slots.filter((s) => s.hair === "sport" && s.framing !== "legs").length;
  const capsAllowed = capCap(slots.length);
  const drawn: string[] = [];
  let tiedSeen = 0;
  let sportSeen = 0;
  let caps = 0;
  return slots.map((slot, i) => {
    if (slot.hair === "own" || slot.framing === "legs") return null;
    const sporty = slot.hair === "sport" && tiedTurn(sportSeen++, sportMoments, sportyOf(sportMoments));
    const tied = slot.hair === "tied" && tiedTurn(tiedSeen++, tiedMoments, tiedAllowed);
    const base = sporty ? fits.filter((s) => s.sport === true) : fits.filter((s) => s.cap !== true && s.tied === tied);
    const candidates: readonly Hairstyle[] = !sporty && slot.outdoor === true && caps < capsAllowed ? [...base, ...fits.filter((s) => s.cap === true)] : base;
    const previous = (count: number): readonly string[] => drawn.slice(-count);
    const fresh = candidates.filter((s) => !previous(3).includes(s.text));
    const notLast = candidates.filter((s) => !previous(1).includes(s.text));
    const style = pick(fresh.length > 0 ? fresh : notLast.length > 0 ? notLast : candidates, `${runId}:hair`, String(i));
    if (style.cap === true) caps++;
    drawn.push(style.text);
    return style.text;
  });
}
