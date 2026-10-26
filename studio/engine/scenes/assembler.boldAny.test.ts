import { describe, expect, test } from "bun:test";
import type { AvatarDescriptor } from "../../shared/engine";
import { BANKS } from "../../shared/scenes/banks";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS } from "../../shared/scenes/banks/companions";
import type { BankPlace, CategoryBank, Moment } from "../../shared/scenes/banks/types";
import { shotOf, type Capture } from "../../shared/scenes/captures";
import { momentAllowed } from "../../shared/scenes/render";
import { plainSentence } from "../../shared/scenes/plain";
import { templateSentence } from "../../shared/scenes/template";
import { asLibraryReference, JPEG } from "../openrouter/testing/fakes";
import { assembleSlot, BOLD_MIRROR_LEGS_POSE_PHRASE, LEGS_POSE_PHRASE, wholeBodyOf } from "./assembler";
import { MIRROR_BACK_LINE, slotKeyOf } from "./phoneLook";
import { hairLinesOf } from "./hairLines";
import { roomPlaceOf, slotLookOf } from "./roomPlace";
import type { PlanSlot } from "./schema";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// 5a.4 (S5.BA3, plan s5a4 I5.73, §5.1.3, H1): the assembled prompt of EVERY moment of every new bank, on every capture it fits, as the run assembles it (the room draw, the look and the hair
// are the engine's own lookups, `roomPlaceOf`, `slotLookOf`, `hairLinesOf`). A room place gets its own room phrase with its own details, never another bank's; a lamp place the lamp mood at evening
// and night; a mirror-back moment the reflection line; an own-hair moment no hair line, a sport moment the sporty style; and the crouch and the mirror-hidden legs phrases follow the marker.

const DESCRIPTOR: AvatarDescriptor = { age: 25, text: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build." };
const MASTER = asLibraryReference(JPEG);
const RUN_ID = "run-bold-any";
const CUSTOM = "cat-paris-trip";
/** What the lamp mood says that a room's own detail «a bedside lamp» does not. */
const LAMP_MOOD = "dim evening light from a bedside lamp";

interface Draw {
  label: string;
  category: string;
  bank: CategoryBank;
  place: BankPlace;
  moment: Moment;
  capture: Capture;
  outfit: string;
}

/** Every (place, moment, capture) of a bank a slot can be dealt, with an outfit the moment may wear. */
function drawsOf(label: string, category: string, bank: CategoryBank): Draw[] {
  return bank.places.flatMap((place) =>
    place.moments.flatMap((moment) => {
      const outfit = moment.outfits?.[0] ?? bank.outfits.find((o) => o.pinOnly !== true && (moment.legs === undefined || o.showsLegs === true))?.text;
      if (outfit === undefined) return [];
      return moment.captures
        .filter((capture) => (shotOf(capture) !== "mirror" || place.mirror === true) && momentAllowed(moment, capture, moment.angle ?? "front", moment.level ?? "ordinary", moment.legs === undefined ? undefined : "legs"))
        .map((capture) => ({ label, category, bank, place, moment, capture, outfit }));
    }),
  );
}

const ALL: readonly Draw[] = [
  ...(["home", "travel", "photoshoot", "glamour", "fitness"] as const).flatMap((c) => drawsOf(`${c} companion`, c, BOLD_COMPANIONS[c])),
  ...drawsOf("custom rooms", CUSTOM, CUSTOM_BOLD_BANKS.rooms),
  ...drawsOf("custom water", CUSTOM, CUSTOM_BOLD_BANKS.water),
];

function slotOf(draw: Draw, timeOfDay: string): PlanSlot {
  return {
    slotIndex: 1,
    category: draw.category,
    location: draw.place.name,
    timeOfDay,
    activity: draw.moment.text,
    outfit: draw.outfit,
    shot: shotOf(draw.capture),
    pose: draw.moment.angle ?? "front",
    attemptIdBase: "slot-1",
    repeatedPair: false,
    route: "seedream",
    ...(draw.moment.level === undefined ? {} : { level: draw.moment.level }),
    ...(draw.moment.legs === undefined ? {} : { framing: "legs" as const }),
    ...(draw.capture === (shotOf(draw.capture) === "mirror" ? "mirror" : shotOf(draw.capture)) ? {} : { capture: draw.capture }),
  } as PlanSlot;
}

function promptOf(draw: Draw, timeOfDay = "morning"): string {
  const slot = slotOf(draw, timeOfDay);
  const key = slotKeyOf(RUN_ID, slot.attemptIdBase);
  const sentence = templateSentence(slot, { key, impliedNudity: true }) ?? plainSentence(slot, true);
  const hair = hairLinesOf([slot], "long", RUN_ID);
  return assembleSlot(DESCRIPTOR, slot, sentence, MASTER, { runId: RUN_ID, roomPlaceOf, lookOf: slotLookOf, hairStyleOf: (s) => hair.get(s.slotIndex) ?? null }).prompt;
}

/** The details every ordinary bank place says, minus the ones the place under test says itself. */
const foreignDetails = (own: readonly string[]): string[] => [...new Set(Object.values(BANKS).flatMap((bank) => bank.places.flatMap((p) => p.details)))].filter((d) => !own.some((mine) => mine.includes(d) || d.includes(mine)));

describe("the assembled prompt of every new moment (H1)", () => {
  test("the sweep covers every companion and both custom banks, with hundreds of frames", () => {
    expect(ALL.length).toBeGreaterThan(300);
    expect(new Set(ALL.map((d) => d.label)).size).toBe(7);
  });

  test("a room place gets its own room phrase with its own details; a place that is no room gets none; never another bank's place", () => {
    for (const draw of ALL) {
      const prompt = promptOf(draw);
      const where = `${draw.label} | ${draw.place.name} | ${draw.moment.text} | ${draw.capture}`;
      if (draw.place.room === true) {
        const own = draw.place.details.some((detail) => prompt.includes(detail)) || prompt.includes("The room is messy");
        expect({ where, room: /The room (?:is ordinary|looks lived-in|is messy)/.test(prompt), own }).toEqual({ where, room: true, own: true });
        expect({ where, foreign: foreignDetails(draw.place.details).filter((d) => prompt.includes(d)) }).toEqual({ where, foreign: [] });
      } else expect({ where, room: prompt.includes("The room ") }).toEqual({ where, room: false });
    }
  });

  test("a lamp place gets the lamp mood at evening and night, and not in the morning", () => {
    const lamp = ALL.filter((d) => d.place.lamp === true);
    expect(lamp.length).toBeGreaterThan(20);
    for (const draw of lamp) {
      expect({ draw: `${draw.label} | ${draw.moment.text}`, evening: promptOf(draw, "evening").includes(LAMP_MOOD) }).toEqual({ draw: `${draw.label} | ${draw.moment.text}`, evening: true });
      expect(promptOf(draw, "night")).toContain(LAMP_MOOD);
      expect(promptOf(draw, "morning")).not.toContain(LAMP_MOOD);
    }
    for (const draw of ALL.filter((d) => d.place.lamp !== true).slice(0, 80)) expect(promptOf(draw, "evening")).not.toContain(LAMP_MOOD);
  });

  test("a mirror-back moment gets the reflection line", () => {
    const back = ALL.filter((d) => d.moment.mirrorBack === true);
    expect(back.length).toBeGreaterThan(3);
    for (const draw of back) expect(promptOf(draw)).toContain(MIRROR_BACK_LINE);
    for (const draw of ALL.filter((d) => d.moment.mirrorBack !== true).slice(0, 100)) expect(promptOf(draw)).not.toContain(MIRROR_BACK_LINE);
  });

  test("an own-hair moment gets no hair line, a legs frame none, every other a style; a sport moment the sporty one", () => {
    for (const draw of ALL) {
      const prompt = promptOf(draw);
      const hairLine = prompt.includes("Today her hair is");
      expect({ draw: `${draw.label} | ${draw.moment.text}`, hairLine }).toEqual({ draw: `${draw.label} | ${draw.moment.text}`, hairLine: draw.moment.hair !== "own" && draw.moment.legs === undefined });
    }
    const sport = ALL.filter((d) => d.moment.hair === "sport" && d.moment.legs === undefined);
    expect(sport.length).toBeGreaterThan(5);
  });

  // No new moment crouches today, so the phrase is pinned on a slot of the marker: a routed frame of a crouching moment shows her whole body in a friend's photo, an unrouted one of the five does not.
  test("the crouch phrase follows the marker: a routed frame of a crouching moment shows her whole body, the unrouted one of the five does not", () => {
    const base = { slotIndex: 1, timeOfDay: "morning", activity: "crouches down to pick something up", outfit: "a tee and cotton panties", shot: "friend", pose: "front", attemptIdBase: "slot-1", repeatedPair: false } as const;
    for (const category of ["home", "travel", "photoshoot", "glamour", "fitness", CUSTOM] as const) {
      const location = category === CUSTOM ? "her room" : (BOLD_COMPANIONS[category].places[0]?.name ?? "");
      expect({ category, routed: wholeBodyOf({ ...base, category, location, route: "seedream" }) }).toEqual({ category, routed: true });
      if (category !== CUSTOM) expect({ category, unrouted: wholeBodyOf({ ...base, category, location }) }).toEqual({ category, unrouted: false });
    }
    expect(wholeBodyOf({ ...base, category: "beach", location: "the beach" })).toBe(true);
  });

  test("a mirror-hidden legs frame says the «Смелая» phrase on the route, and the five's own phrase when it is not routed", () => {
    const legs = ALL.filter((d) => d.moment.legs !== undefined && d.capture === "mirror-hidden");
    expect(legs.length).toBeGreaterThan(0);
    for (const draw of legs) {
      expect(promptOf(draw)).toContain(BOLD_MIRROR_LEGS_POSE_PHRASE);
      // The five stored before 5a.4 are held to the ordinary content line, so the unrouted control wears an ordinary outfit.
      const slot = { ...slotOf(draw, "morning"), route: undefined, outfit: "a white t-shirt and jeans" } as PlanSlot;
      const plain = assembleSlot(DESCRIPTOR, slot, plainSentence(slot, true), MASTER, { runId: RUN_ID }).prompt;
      expect(plain).toContain(LEGS_POSE_PHRASE);
    }
  });
});
