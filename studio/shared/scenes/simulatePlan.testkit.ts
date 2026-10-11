import type { PoolShot, ScenePose } from "../engine";
import { BANKS } from "./banks";
import type { BankCategory, BankPlace, Level, Moment } from "./banks/types";
import { fnv1a } from "./hash";
import { momentAllowed, type TemplateSlot } from "./template";

// Test-only: a stand-in for the 5a.2 planner (S5.6b builds the real one), so the variety sweep can measure the banks before the planner is wired.
// It keeps the real planner's structure (engine/scenes/planner.ts): a bag of places and a bag of the deck's shots, mirror shots swapped onto mirror
// places (`placeMirrorShots`), the pose drawn before the moment (5 : 5 : 1 : 1, hand shots front or three-quarter only), and then a moment from a
// per-place bag of the moments the slot allows. The real planner must draw moments as evenly (a uniform pick breaks the per-moment bound, I5.24).

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
const POSES_FRONT: readonly ScenePose[] = ["front", "three-quarter"];

export interface SimulatedSlot extends TemplateSlot {
  key: string;
  place: BankPlace;
  moment: Moment;
}

/** One category's `n` slots of a run, as the 5a.2 planner would draw them (see above). `awayPoses` lets profile and back in at 1 : 1 : 5 : 5. */
export function simulatePlan(category: BankCategory, n: number, seed: number, level: Level = "ordinary", awayPoses = true): SimulatedSlot[] {
  const bank = BANKS[category];
  const next = generator(`${category}:${seed}:${level}`);
  const nextPlace = bag(next, bank.places);
  const nextShot = bag(next, bank.shotDeck);
  const nextOutfit = bag(next, bank.outfits);
  const places = Array.from({ length: n }, nextPlace);
  const shots: PoolShot[] = Array.from({ length: n }, nextShot);
  for (let i = 0; i < n; i++) {
    if (shots[i] !== "mirror" || places[i]?.mirror === true) continue;
    const j = shots.findIndex((shot, k) => places[k]?.mirror === true && shot !== "mirror");
    if (j >= 0) [shots[i], shots[j]] = [shots[j] as PoolShot, shots[i] as PoolShot];
    else shots[i] = "selfie";
  }
  // Per place: how often each moment was drawn, and a shuffled order that breaks ties (the least-used allowed moment is taken, so a hand shot's
  // narrower choice does not pile onto one moment).
  const used = new Map<Moment, number>();
  const order = new Map<string, Moment[]>(bank.places.map((place) => [place.name, shuffled(next, place.moments)]));
  return places.map((place, i) => {
    const shot = shots[i] as PoolShot;
    const hand = shot === "selfie" || shot === "mirror";
    const deck = hand || !awayPoses ? POSES_FRONT : POSES_ALL;
    const pose = deck[Math.floor(next() * deck.length)] as ScenePose;
    const candidates = (order.get(place.name) ?? []).filter((m) => momentAllowed(m, shot, pose, level));
    const fewest = Math.min(...candidates.map((m) => used.get(m) ?? 0));
    const moment = candidates.find((m) => (used.get(m) ?? 0) === fewest);
    if (moment === undefined) throw new Error(`${category}/${place.name}: no moment for ${shot} ${pose}`);
    used.set(moment, fewest + 1);
    order.set(place.name, [...(order.get(place.name) ?? []).filter((m) => m !== moment), moment]);
    return { category, location: place.name, activity: moment.text, outfit: nextOutfit(), shot, pose, key: `run-${seed}:slot-${i + 1}`, place, moment };
  });
}
