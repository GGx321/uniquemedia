import { describe, expect, test } from "bun:test";
import { bankPlaceOf } from "./bankLookup";
import { BANKS } from "./banks";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS } from "./banks/companions";
import { ORDINARY_BANK_CATEGORIES } from "./banks/types";

// 5a.4 (S5.BA3, plan s5a4 I5.73, §5.1.3, H1): the ONE path from a slot to bank data. The five plus the route read their companion; a custom category plus the route reads the shared
// custom banks; a slot of the seven without the route reads the bank it always read; a slot stored before 5a.4 (no route on the five or a custom category) reads exactly as before.

const CUSTOM = "cat-paris-trip";

describe("bankPlaceOf (I5.73)", () => {
  test.each(ORDINARY_BANK_CATEGORIES)("a routed %s slot finds its place and moment in the companion bank", (category) => {
    const bank = BOLD_COMPANIONS[category];
    const place = bank.places[0];
    const moment = place?.moments[0];
    if (place === undefined || moment === undefined) throw new Error("the companion has no place");
    const hit = bankPlaceOf({ category, route: "seedream", location: place.name, activity: moment.text });
    expect(hit?.bank).toBe(bank);
    expect(hit?.place).toBe(place);
    expect(hit?.moment).toBe(moment);
  });

  test.each(ORDINARY_BANK_CATEGORIES)("an unrouted %s slot finds its place and moment in the ordinary bank", (category) => {
    const bank = BANKS[category];
    const place = bank.places[0];
    const moment = place?.moments[0];
    if (place === undefined || moment === undefined) throw new Error("the bank has no place");
    const hit = bankPlaceOf({ category, route: undefined, location: place.name, activity: moment.text });
    expect(hit?.bank).toBe(bank);
    expect(hit?.place).toBe(place);
    expect(hit?.moment).toBe(moment);
  });

  test("a routed slot never reads the ordinary bank: a companion place name the ordinary bank also has still finds the companion", () => {
    for (const category of ORDINARY_BANK_CATEGORIES) {
      for (const place of BOLD_COMPANIONS[category].places) {
        expect(bankPlaceOf({ category, route: "seedream", location: place.name })?.bank).toBe(BOLD_COMPANIONS[category]);
      }
    }
  });

  test("a routed slot at a place only the ordinary bank has finds nothing, not the ordinary bank", () => {
    const only = BANKS.home.places.find((p) => !BOLD_COMPANIONS.home.places.some((c) => c.name === p.name));
    if (only === undefined) throw new Error("every ordinary «Дом» place is also a companion place");
    expect(bankPlaceOf({ category: "home", route: "seedream", location: only.name })).toBeUndefined();
  });

  test.each(["nightwear", "beach"] as const)("%s reads its own bank with the route and without it", (category) => {
    const place = BANKS[category].places[0];
    if (place === undefined) throw new Error("no place");
    expect(bankPlaceOf({ category, route: "seedream", location: place.name })?.bank).toBe(BANKS[category]);
    expect(bankPlaceOf({ category, route: undefined, location: place.name })?.bank).toBe(BANKS[category]);
  });

  test("a routed custom slot finds its place in «rooms» or in «by the water», by the place's name", () => {
    for (const place of CUSTOM_BOLD_BANKS.rooms.places) expect(bankPlaceOf({ category: CUSTOM, route: "seedream", location: place.name })?.bank).toBe(CUSTOM_BOLD_BANKS.rooms);
    for (const place of CUSTOM_BOLD_BANKS.water.places) expect(bankPlaceOf({ category: CUSTOM, route: "seedream", location: place.name })?.bank).toBe(CUSTOM_BOLD_BANKS.water);
  });

  test("every moment of every new bank is found by its text at its place", () => {
    const banks = [...ORDINARY_BANK_CATEGORIES.map((c) => ({ category: c as string, bank: BOLD_COMPANIONS[c] })), ...Object.values(CUSTOM_BOLD_BANKS).map((bank) => ({ category: CUSTOM, bank }))];
    for (const { category, bank } of banks) {
      for (const place of bank.places) {
        for (const moment of place.moments) expect(bankPlaceOf({ category, route: "seedream", location: place.name, activity: moment.text })?.moment).toBe(moment);
      }
    }
  });

  test("an unrouted custom slot, a slot stored before 5a.4, finds no bank", () => {
    const place = CUSTOM_BOLD_BANKS.rooms.places[0];
    expect(bankPlaceOf({ category: CUSTOM, route: undefined, location: place?.name })).toBeUndefined();
  });

  test("a routed custom slot at a place neither shared bank has finds nothing", () => {
    expect(bankPlaceOf({ category: CUSTOM, route: "seedream", location: "a cafe in Paris" })).toBeUndefined();
  });

  test("an own scene, an unknown category and a slot with no place find nothing", () => {
    expect(bankPlaceOf({ category: "own", route: undefined })).toBeUndefined();
    expect(bankPlaceOf({ category: "nothing", route: "seedream", location: "her kitchen" })).toBeUndefined();
    expect(bankPlaceOf({ category: "home", route: "seedream" })).toBeUndefined();
  });

  test("a place found with a moment the bank no longer has is the place with no moment", () => {
    const place = BOLD_COMPANIONS.home.places[0];
    const hit = bankPlaceOf({ category: "home", route: "seedream", location: place?.name, activity: "a moment that was renamed" });
    expect(hit?.place).toBe(place);
    expect(hit?.moment).toBeUndefined();
  });

  test("the route is a required key", () => {
    // @ts-expect-error a caller that has no route to hand says `route: undefined`; leaving it out does not compile
    bankPlaceOf({ category: "home", location: "her kitchen" });
    expect(true).toBe(true);
  });
});
