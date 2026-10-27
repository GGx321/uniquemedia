import { describe, expect, test } from "bun:test";
import { BANKS, HAIRSTYLES } from "../../shared/scenes/banks";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS } from "../../shared/scenes/banks/companions";
import type { BankPlace, CategoryBank, Moment } from "../../shared/scenes/banks/types";
import { hairLinesOf } from "./hairLines";
import { POOLS } from "./pools";
import { roomPlaceOf, slotLookOf, type RoomSlotKey } from "./roomPlace";
import type { RunSlot } from "./schema";
import { ORDINARY_BUILT_INS } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA3, plan s5a4 I5.73, §5.1.3, H1): the room draw, the lamp and mirror-back marks and the hair tags find a slot's place and moment through the ONE marker-aware lookup. A «Смелая»
// slot of the five reads its companion's place (never «Дом»'s), a custom category's reads the shared bank's, and a slot stored before 5a.4 reads the ordinary pool as it always did.

const CUSTOM = "cat-paris-trip";

function find(bank: CategoryBank, wanted: (place: BankPlace, moment: Moment) => boolean): { place: BankPlace; moment: Moment } {
  for (const place of bank.places) {
    const moment = place.moments.find((m) => wanted(place, m));
    if (moment !== undefined) return { place, moment };
  }
  throw new Error("the bank has no such moment");
}

function runSlot(category: string, found: { place: BankPlace; moment: Moment }, extra: Record<string, unknown> = {}): RunSlot & RoomSlotKey {
  // 5a.4 (S5.BA7, BA3 review L-1): the route is a required key of the lookup's slot; this one says its own (the Seedream route unless `extra` says otherwise).
  const slot = { slotIndex: 1, category, location: found.place.name, timeOfDay: "morning", activity: found.moment.text, outfit: "a tee and cotton panties", shot: "friend", pose: "front", attemptIdBase: "slot-1", repeatedPair: false, route: "seedream", ...extra } as RunSlot;
  return { ...slot, route: "route" in slot ? slot.route : undefined };
}

describe("roomPlaceOf and slotLookOf follow the route (I5.73)", () => {
  test("a routed «Дом» slot in a companion room gets the companion room's own details, never «Дом»'s", () => {
    const found = find(BOLD_COMPANIONS.home, (p) => p.room === true);
    const room = roomPlaceOf(runSlot("home", found));
    expect(room?.details).toEqual(found.place.details);
    expect(BANKS.home.places.some((p) => p.details.join() === found.place.details.join())).toBe(false);
  });

  test("the messy mark is the companion moment's own", () => {
    const messy = find(BOLD_COMPANIONS.home, (p, m) => p.room === true && m.messyOk === true);
    const tidy = find(BOLD_COMPANIONS.home, (p, m) => p.room === true && m.messyOk !== true);
    expect(roomPlaceOf(runSlot("home", messy))?.activity.messyOk).toBe(true);
    expect(roomPlaceOf(runSlot("home", tidy))?.activity.messyOk).toBe(false);
  });

  test("a routed slot at a place that is no room gets no room phrase", () => {
    const found = find(BOLD_COMPANIONS.travel, (p) => p.room !== true);
    expect(roomPlaceOf(runSlot("travel", found))).toBeNull();
  });

  test("the same slot stored before 5a.4, with no route, finds no companion place: no room phrase, no look", () => {
    const found = find(BOLD_COMPANIONS.home, (p) => p.room === true);
    expect(roomPlaceOf(runSlot("home", found, { route: undefined }))).toBeNull();
    expect(slotLookOf(runSlot("home", found, { route: undefined }))).toBeNull();
  });

  test("the lamp mood is the companion place's, and the mirror-back mark the companion moment's", () => {
    const lamp = find(BOLD_COMPANIONS.home, (p) => p.lamp === true);
    const back = find(BOLD_COMPANIONS.home, (_p, m) => m.mirrorBack === true);
    expect(slotLookOf(runSlot("home", lamp))?.lamp).toBe(true);
    expect(slotLookOf(runSlot("home", back))?.mirrorBack).toBe(true);
    const noLamp = find(BOLD_COMPANIONS.travel, (p) => p.lamp !== true);
    expect(slotLookOf(runSlot("travel", noLamp))?.lamp).toBe(false);
  });

  test("a routed custom slot reads the shared bank's place: a room in «rooms», none at the water", () => {
    const room = find(CUSTOM_BOLD_BANKS.rooms, (p) => p.room === true);
    const water = find(CUSTOM_BOLD_BANKS.water, () => true);
    expect(roomPlaceOf(runSlot(CUSTOM, room))?.details).toEqual(room.place.details);
    expect(roomPlaceOf(runSlot(CUSTOM, water))).toBeNull();
    expect(slotLookOf(runSlot(CUSTOM, water))?.lamp).toBe(false);
  });

  test("an unrouted custom slot, an own scene and a renamed place have no room and no look", () => {
    const room = find(CUSTOM_BOLD_BANKS.rooms, (p) => p.room === true);
    expect(roomPlaceOf(runSlot(CUSTOM, room, { route: undefined }))).toBeNull();
    expect(slotLookOf(runSlot(CUSTOM, room, { route: undefined }))).toBeNull();
    expect(roomPlaceOf(runSlot("home", room, { location: "a place that was renamed" }))).toBeNull();
  });

  test("every slot of the seven stored before 5a.4 reads exactly what the ordinary pool says", () => {
    let seen = 0;
    for (const category of [...ORDINARY_BUILT_INS, "nightwear", "beach"] as const) {
      for (const place of POOLS[category].locations) {
        for (const activity of place.activities) {
          const slot = runSlot(category, { place: { name: place.name } as BankPlace, moment: { text: activity.text } as Moment }, { route: undefined });
          const room = place.room === true && place.details !== undefined ? { room: true, details: place.details, activity: { messyOk: activity.messyOk === true } } : null;
          expect(roomPlaceOf(slot)).toEqual(room);
          expect(slotLookOf(slot)).toEqual({ lamp: place.lamp === true, mirrorBack: activity.mirrorBack === true });
          seen++;
        }
      }
    }
    expect(seen).toBeGreaterThan(250);
  });
});

describe("the hair tags follow the route (I5.73)", () => {
  const sporty = (line: string | undefined): boolean => HAIRSTYLES.some((s) => s.text === line && s.sport === true);

  test("a routed companion moment that names her hair gets no hair line", () => {
    const own = find(BOLD_COMPANIONS.home, (_p, m) => m.hair === "own");
    expect(hairLinesOf([runSlot("home", own)], "long", "run-1").has(1)).toBe(false);
  });

  test("the same slot stored before 5a.4 finds no moment and takes a style", () => {
    const own = find(BOLD_COMPANIONS.home, (_p, m) => m.hair === "own");
    expect(hairLinesOf([runSlot("home", own, { route: undefined })], "long", "run-1").has(1)).toBe(true);
  });

  test("a routed «Фитнес» workout moment wears a sporty style", () => {
    const sport = find(BOLD_COMPANIONS.fitness, (_p, m) => m.hair === "sport" && m.legs === undefined);
    expect(sporty(hairLinesOf([runSlot("fitness", sport)], "long", "run-1").get(1))).toBe(true);
  });

  test("a routed custom moment is tagged by the shared bank", () => {
    const own = find(CUSTOM_BOLD_BANKS.rooms, (_p, m) => m.hair === "own");
    expect(hairLinesOf([runSlot(CUSTOM, own)], "long", "run-1").has(1)).toBe(false);
  });
});
