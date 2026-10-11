import type { ScenePose } from "../engine";
import { BANKS } from "./banks";
import type { BankCategory, BankPlace, Level, Moment, Outfit } from "./banks/types";
import { isHandCapture, posesFor, shotOf, type Capture } from "./captures";
import { fnv1a } from "./hash";
import { momentAllowed, type TemplateSlot } from "./render";
import { legwearFits } from "./template";

// Test-only: a stand-in for the 5a.2 planner (S5.6b builds the real one), so the variety and coverage sweeps can measure the banks before the planner
// is wired. It keeps plan s5a2 r1.2 §5.2's order: a place (a bag), a capture (the category's deck, a bag), mirror captures moved onto mirror places,
// the pose (a hand-held capture front or three-quarter; otherwise 5 : 5 : 1 : 1 when the run allows profile and back), then the moment, drawn as the
// least-used one the slot allows at that place, then the outfit (a pinned one first) and the legwear. When the place has no moment for the slot, the
// fallback chain runs and is counted: another place with one, then the capture's family (mirror-hidden → mirror → selfie, prone → above → selfie,
// timer → friend, but timer → selfie on «Дом»), then a three-quarter pose, then a friend for a candid. The real planner must draw moments as evenly (I5.24).

/** A small seeded generator (mulberry32 over fnv1a): test-only, never in a production module. */
function generator(seed: string): () => number {
  let a = fnv1a(seed);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(next: () => number, items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

function bag<T>(next: () => number, items: readonly T[]): () => T {
  let queue: T[] = [];
  return () => {
    if (queue.length === 0) queue = shuffled(next, items);
    return queue.shift() as T;
  };
}

const POSES_ALL: readonly ScenePose[] = ["front", "front", "front", "front", "front", "three-quarter", "three-quarter", "three-quarter", "three-quarter", "three-quarter", "profile", "back"];
const STEP_DOWN: Partial<Record<Capture, Capture>> = { "mirror-hidden": "mirror", mirror: "selfie", prone: "above", above: "selfie", timer: "friend" };
/** «Дом» stays self-shot: its timer steps down to a selfie, never to a friend (plan r1.3 M1). */
const stepDown = (category: BankCategory, capture: Capture): Capture | undefined => (category === "home" && capture === "timer" ? "selfie" : STEP_DOWN[capture]);

export interface SimulatedSlot extends TemplateSlot {
  key: string;
  place: BankPlace;
  moment: Moment;
  capture: Capture;
  wearing: string;
  /** The fallback steps this slot took (empty for a slot drawn straight). */
  fallbacks: readonly string[];
}

const canLand = (place: BankPlace, capture: Capture): boolean => shotOf(capture) !== "mirror" || place.mirror === true;

/** One category's `n` slots of a run, as the 5a.2 planner would draw them (see above). `awayPoses` lets profile and back in at 1 : 1 : 5 : 5. */
export function simulatePlan(category: BankCategory, n: number, seed: number, level: Level = "ordinary", awayPoses = true): SimulatedSlot[] {
  const bank = BANKS[category];
  const next = generator(`${category}:${seed}:${level}`);
  const nextPlace = bag(next, bank.places);
  const nextCapture = bag(next, bank.captureDeck);
  const nextOutfit = bag(next, bank.outfits);
  const places = Array.from({ length: n }, nextPlace);
  const captures: Capture[] = Array.from({ length: n }, nextCapture);
  // Mirror placement: a mirror capture swaps with a later slot on a mirror place that holds none; with none left it steps down to a selfie.
  for (let i = 0; i < n; i++) {
    const capture = captures[i] as Capture;
    if (shotOf(capture) !== "mirror" || places[i]?.mirror === true) continue;
    const j = captures.findIndex((c, k) => places[k]?.mirror === true && shotOf(c) !== "mirror");
    if (j >= 0) [captures[i], captures[j]] = [captures[j] as Capture, capture];
    else captures[i] = "selfie";
  }

  const used = new Map<Moment, number>();
  const order = new Map<string, Moment[]>(bank.places.map((place) => [place.name, shuffled(next, place.moments)]));
  const least = (place: BankPlace, capture: Capture, pose: ScenePose): Moment | undefined => {
    const candidates = (order.get(place.name) ?? []).filter((m) => momentAllowed(m, capture, pose, level));
    const fewest = Math.min(...candidates.map((m) => used.get(m) ?? 0));
    return candidates.find((m) => (used.get(m) ?? 0) === fewest);
  };

  return places.map((drawnPlace, i) => {
    let place = drawnPlace;
    let capture = captures[i] as Capture;
    const deck = isHandCapture(capture) || !awayPoses ? posesFor(capture) : POSES_ALL;
    let pose = deck[Math.floor(next() * deck.length)] as ScenePose;
    const fallbacks: string[] = [];
    // Balance (I5.24): keep the bag's place unless its least-used moment for this slot is used more than the least-used one the slot allows at another
    // place; then move to such a place. Only the place moves, never the capture or the pose.
    const here = least(place, capture, pose);
    const elsewhere = bank.places.filter((p) => canLand(p, capture) && least(p, capture, pose) !== undefined);
    const usesOf = (m: Moment | undefined): number => (m === undefined ? Number.POSITIVE_INFINITY : (used.get(m) ?? 0));
    const globalFewest = Math.min(...elsewhere.map((p) => usesOf(least(p, capture, pose))));
    if (here !== undefined && usesOf(here) > globalFewest) {
      const better = elsewhere.filter((p) => usesOf(least(p, capture, pose)) === globalFewest);
      const moved = better[Math.floor(next() * better.length)];
      if (moved !== undefined) {
        fallbacks.push(`place ${place.name} → ${moved.name} (balance)`);
        place = moved;
      }
    }
    let moment = least(place, capture, pose);
    while (moment === undefined) {
      // Redraw the place toward the least-used moment the slot allows anywhere (ties broken at random), so a capture that fits few places does not
      // pile onto one moment.
      const valid = bank.places.filter((p) => canLand(p, capture) && least(p, capture, pose) !== undefined);
      const usesAt = (p: BankPlace): number => used.get(least(p, capture, pose) as Moment) ?? 0;
      const fewest = Math.min(...valid.map(usesAt));
      const tied = valid.filter((p) => usesAt(p) === fewest);
      const other = tied[Math.floor(next() * tied.length)];
      if (other !== undefined) {
        fallbacks.push(`place ${place.name} → ${other.name}`);
        place = other;
      } else if (stepDown(category, capture) !== undefined) {
        const down = stepDown(category, capture) as Capture;
        fallbacks.push(`capture ${capture} → ${down}`);
        capture = down;
        if (!posesFor(capture).includes(pose)) pose = "three-quarter";
      } else if (pose !== "front" && pose !== "three-quarter") {
        fallbacks.push(`pose ${pose} → three-quarter`);
        pose = "three-quarter";
      } else if (capture === "candid") {
        fallbacks.push("capture candid → friend");
        capture = "friend";
      } else throw new Error(`${category}/${place.name}: no moment for ${capture} ${pose}`);
      moment = least(place, capture, pose);
    }
    used.set(moment, (used.get(moment) ?? 0) + 1);
    order.set(place.name, [...(order.get(place.name) ?? []).filter((m) => m !== moment), moment]);

    const pinned = moment.outfits;
    const pinnedText = pinned === undefined ? undefined : pinned[Math.floor(next() * pinned.length)];
    const pinnedOutfit = bank.outfits.find((o) => o.text === pinnedText);
    if (pinned !== undefined && pinnedOutfit === undefined) throw new Error(`${category}: «${moment.text}» pins an outfit the bank does not have`);
    const outfit: Outfit = pinnedOutfit ?? nextOutfit();
    const legwearItems = bank.legwear?.items ?? [];
    const legwear = legwearItems.length > 0 && legwearFits(moment, outfit) && next() < (bank.legwear?.share ?? 0) ? legwearItems[Math.floor(next() * legwearItems.length)] : undefined;
    return {
      category,
      location: place.name,
      activity: moment.text,
      outfit: outfit.text,
      ...(legwear === undefined ? {} : { legwear }),
      wearing: legwear === undefined ? outfit.text : `${outfit.text} with ${legwear}`,
      shot: shotOf(capture),
      capture,
      pose,
      key: `run-${seed}:slot-${i + 1}`,
      place,
      moment,
      fallbacks,
    };
  });
}
