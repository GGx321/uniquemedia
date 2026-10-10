import { describe, expect, test } from "bun:test";
import { roomPlaceOf, type RoomSlotKey } from "./roomPlace";
import { assembleSlot } from "./assembler";
import { POOLS } from "./pools";
import { CATEGORIES } from "./types";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import type { PlanSlot } from "./schema";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.1c: the room wiring. The room draw (phoneLook.ts roomStateOf) is a pure function of an injected place; this looks the place up by name in today's POOLS,
// for a slot of a built-in category. A renamed or unknown place (an old plan), an own scene and a custom category get null: no room phrase.

const slot = (over: Partial<RoomSlotKey> = {}): RoomSlotKey => ({
  category: "home",
  location: "her small kitchen",
  activity: "waiting for the kettle",
  ...over,
});

describe("roomPlaceOf", () => {
  test("describes a room of a built-in category with its details", () => {
    const place = roomPlaceOf(slot());
    expect(place?.room).toBe(true);
    expect(place?.details).toEqual(["a kettle on the counter", "a fruit bowl"]);
  });

  test("carries messyOk of the slot's activity", () => {
    expect(roomPlaceOf(slot({ location: "her unmade bed", activity: "stretching after waking up" }))?.activity.messyOk).toBe(true);
    expect(roomPlaceOf(slot({ location: "her unmade bed", activity: "scrolling her phone" }))?.activity.messyOk).not.toBe(true);
  });

  test("is not messy for an activity the place no longer has (a renamed activity of an old plan)", () => {
    const place = roomPlaceOf(slot({ location: "her unmade bed", activity: "yawning" }));
    expect(place?.room).toBe(true);
    expect(place?.activity.messyOk).not.toBe(true);
  });

  test("is null for a place that is not a room", () => {
    expect(roomPlaceOf(slot({ location: "a small balcony with potted plants", activity: "watering plants" }))).toBeNull();
  });

  test("is null for a place renamed since the plan was made", () => {
    expect(roomPlaceOf(slot({ location: "a bright kitchen", activity: "slicing fruit on a cutting board" }))).toBeNull();
    expect(roomPlaceOf(slot({ category: "photoshoot", location: "a studio with a seamless beige backdrop", activity: "posing with one hand in her hair" }))).toBeNull();
  });

  test("is null for a room name asked under the wrong category", () => {
    expect(roomPlaceOf(slot({ category: "travel" }))).toBeNull();
  });

  test("is null for an own scene and for a custom category, even with a built-in room's name", () => {
    expect(roomPlaceOf(slot({ category: "own" }))).toBeNull();
    expect(roomPlaceOf(slot({ category: "cat-paris-cafes" }))).toBeNull();
  });

  test("is null for a category name that is not an own property of the pools (no prototype lookup)", () => {
    expect(roomPlaceOf(slot({ category: "constructor" }))).toBeNull();
    expect(roomPlaceOf(slot({ category: "__proto__" }))).toBeNull();
  });

  test("finds every room of every built-in pool by its own name", () => {
    for (const category of CATEGORIES) {
      for (const place of POOLS[category].locations) {
        const found = roomPlaceOf({ category, location: place.name, activity: place.activities[0]?.text ?? "" });
        expect(found === null).toBe(place.room !== true);
      }
    }
  });
});

describe("the room phrase reaches the assembled prompt through roomPlaceOf", () => {
  const DESCRIPTOR = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build." };
  const MASTER = asLibraryReference(JPEG);
  const full = (over: Partial<PlanSlot>): PlanSlot => ({
    slotIndex: 1,
    category: "home",
    location: "her small kitchen",
    timeOfDay: "morning",
    activity: "waiting for the kettle",
    outfit: "a cozy hoodie",
    shot: "friend",
    pose: "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    ...over,
  });
  const assemble = (s: PlanSlot, runId = "run-1") => assembleSlot(DESCRIPTOR, s, "She waits by the counter.", MASTER, { runId, roomPlaceOf }).prompt;

  test("a slot in a room gets a room sentence right after the writer's sentence", () => {
    expect(assemble(full({}))).toMatch(/She waits by the counter\. The room (is ordinary and fairly tidy|looks lived-in|is messy)/);
  });

  test("a slot in a renamed place gets none", () => {
    expect(assemble(full({ location: "a bright kitchen" }))).not.toContain("The room");
  });

  test("the same run and slot assemble the same prompt twice, a different run may differ", () => {
    expect(assemble(full({}))).toBe(assemble(full({})));
    const phrases = new Set(Array.from({ length: 40 }, (_, i) => assemble(full({}), `run-${i}`).match(/The room[^.]*\./)?.[0]));
    expect(phrases.size).toBeGreaterThan(1);
  });
});
