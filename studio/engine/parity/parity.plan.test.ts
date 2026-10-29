import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { GOLDEN } from "./testing/golden";
import { familyOf, planParity, NIGHTLY_ONLY, type ParityEntry, type ParityPick } from "./testing/pushSet";
import { SCENARIOS } from "./testing/scenarios";
useNativeGlobals();

// Which parity stories a push plays and which only the nightly run does (parity.test.ts registers them from this plan). The golden file is untouched by the split: only WHERE a
// key runs moves, so the two checks that matter are that the nightly run plays every key of the golden file, and that a push plays at least one story of every family of commands.

const NAMES = SCENARIOS.map((s) => s.name);
const PLAN = planParity(NAMES);

/** The stories that run in the push run: a `sweep` registers a plain test and its `[heavy]` twin. */
const pushNames = (plan: readonly ParityEntry[]): string[] => plan.filter((e) => e.registration === "sweep").map((e) => e.name);
/** The stories the heavy run plays: every one, by a `sweep` twin or by a heavy-only test. */
const heavyRunNames = (plan: readonly ParityEntry[]): string[] => plan.map((e) => e.name);

function nameOf(pick: ParityPick): string {
  const found = NAMES.filter((name) => familyOf(name) === pick.family && name.slice(pick.family.length + 1).trimStart().startsWith(pick.startsWith));
  if (found.length !== 1) throw new Error(`${pick.family}: «${pick.startsWith}» names ${found.length} stories`);
  return found[0] ?? "";
}

/**
 * What a push must never lose, named on its own (not read from NIGHTLY_ONLY, so dropping a pick there is seen here): the money (the price and the exact settle of a clip, a batch and a
 * motion call, a month that cannot take a batch, the stop of a ledger), the recoveries (a reserve left open, a late file, an uncertain submit, a quit with a request in flight, a hold that
 * «Продолжить» clears, a damaged quota log), «Смелая» (the route, the price, the origin, Kling alone), the minor-age guard on the motion calls, and the main flows (a render, a launch, a clip, a batch).
 */
const MUST_STAY: readonly ParityPick[] = [
  { family: "clips", startsWith: "a clip is made" },
  { family: "clips", startsWith: "every refusal of a create is free" },
  { family: "clips", startsWith: "a refusal that is not proven free stops the clip" },
  { family: "clips", startsWith: "a submit with no answer ends the clip at once" },
  { family: "clips", startsWith: "a clip that never comes ends `late`" },
  { family: "clips", startsWith: "a frame of «Смелая» runs on Kling alone" },
  { family: "clip batch", startsWith: "the month holds a batch whole or not at all" },
  { family: "clip batch", startsWith: "a clean batch is made one clip at a time" },
  { family: "clip batch", startsWith: "an uncertain submit ends the queue" },
  { family: "clip batch", startsWith: "a «Смелая» member is Kling's alone" },
  { family: "clip motions", startsWith: "an attempt is reserved for the message it sends" },
  { family: "clip motions", startsWith: "a bill above the reserve stops the ledger" },
  { family: "clip motions", startsWith: "the age guard refuses a suggestion and an idea that name an age" },
  { family: "clip motions", startsWith: "on a frame of «Смелая» an idea that takes clothing off is accepted" },
  { family: "autopilot (running)", startsWith: "a launch with the review off composes, draws, montages and renders" },
  { family: "autopilot (running)", startsWith: "a start below the engine's worst case is PRICE_CHANGED and writes nothing" },
  { family: "autopilot (running)", startsWith: "OpenRouter's 402 holds the paid work" },
  { family: "autopilot (running)", startsWith: "the app is quit with a request in flight" },
  { family: "template launch (running)", startsWith: "OpenRouter's 402 and 401 meet the first PHOTO" },
  { family: "photo runs, «Смелая» (S5.9f)", startsWith: "a run from the composed set draws every scene" },
  { family: "photo runs, «Смелая» (S5.9f)", startsWith: "Seedream's refusal ends only the slot it met" },
  { family: "autopilot, «Смелая» (S5.9f)", startsWith: "a launch at the bold level prices every photo at the bold unit" },
  { family: "music", startsWith: "a damaged quota log refuses a refresh at no cost" },
  { family: "portraits", startsWith: "the batch is priced for any avatar" },
  { family: "scene sets", startsWith: "the open set a closed Studio left" },
  // review fix: money, the minor-age guard and a launch's price
  { family: "clip motions", startsWith: "an idea whose own words name an age is refused before the call" },
  { family: "clips", startsWith: "the month's fit follows the budget" },
  { family: "clip batch", startsWith: "a member that never comes goes late" },
  { family: "clip batch", startsWith: "one clip money unit at a time" },
  { family: "clip motions", startsWith: "a month without room for the worst case" },
  { family: "autopilot (pending the orchestrator)", startsWith: "a start below the engine's worst case is PRICE_CHANGED and free" },
];

describe("the parity split between a push and the nightly run", () => {
  test("the nightly run plays exactly the keys of the golden file", () => {
    expect([...heavyRunNames(PLAN)].sort()).toEqual(Object.keys(GOLDEN).sort());
  });

  test("a push plays at least one story of every family of commands", () => {
    const pushed = new Set(pushNames(PLAN).map(familyOf));
    const all = new Set(Object.keys(GOLDEN).map(familyOf));
    expect([...all].filter((family) => !pushed.has(family))).toEqual([]);
  });

  test("a push keeps the money, recovery, «Смелая», minor-age and main-flow stories", () => {
    const pushed = new Set(pushNames(PLAN));
    expect(MUST_STAY.map(nameOf).filter((name) => !pushed.has(name))).toEqual([]);
  });

  test("a push plays at most 60 % of the keys of the golden file, and the nightly-only stories are the rest", () => {
    const pushed = pushNames(PLAN);
    const total = Object.keys(GOLDEN).length;
    expect(pushed.length).toBeLessThanOrEqual(total * 0.6);
    expect(pushed.length + NIGHTLY_ONLY.length).toBe(total);
  });

  test("a story nobody named nightly-only is on a push, a new story of a big family included", () => {
    const grown = planParity([...NAMES, "clips: a story added after this list was written"]);
    expect(grown.find((e) => e.name.startsWith("clips: a story added"))?.registration).toBe("sweep");
    expect(planParity(NAMES, []).every((e) => e.registration === "sweep")).toBe(true);
  });

  test("a story registers once in the plan", () => {
    expect(new Set(PLAN.map((e) => e.name)).size).toBe(PLAN.length);
  });

  test("every nightly-only entry names exactly one story, and one that names none or several is refused loudly", () => {
    expect(() => planParity(NAMES, NIGHTLY_ONLY)).not.toThrow();
    expect(() => planParity(NAMES, [{ family: "clips", startsWith: "no such story" }])).toThrow();
    expect(() => planParity(NAMES, [{ family: "clips", startsWith: "a clip" }])).toThrow();
  });

  test("a family cannot be sent wholly to the nightly run", () => {
    const whole = NAMES.filter((name) => familyOf(name) === "price cache").map((name) => ({ family: "price cache", startsWith: name.slice("price cache: ".length) }));
    expect(() => planParity(NAMES, whole)).toThrow();
  });
});
