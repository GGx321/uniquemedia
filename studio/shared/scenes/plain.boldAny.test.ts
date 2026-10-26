import { describe, expect, test } from "bun:test";
import { BANKS } from "./banks";
import { BOLD_COMPANIONS, CUSTOM_BOLD_BANKS } from "./banks/companions";
import { COVER } from "./banks/companions/outfits";
import { plainSentence, type PlainSlot } from "./plain";

// 5a.4 (S5.BA3, plan s5a4 I5.73, I5.74, §5.3.3, §8 BA3): the plain fallback, the sentence a slot takes when the writer could not write it, reads its bank through the one lookup and
// appends the outfit's coverage by the avatar's origin, as the template does. It is built from the slot's own stored texts and nothing else.

const LACE = "The lace is lined and opaque: her bra fully covers her breasts and her panties fully cover her.";
const SATIN_SET = "Her cami and shorts are opaque satin.";

const kitchen = BOLD_COMPANIONS.home.places.find((p) => p.name === "her kitchen");
const plainMoment = kitchen?.moments[0];

function homeSlot(extra: Partial<PlainSlot> = {}): PlainSlot {
  if (kitchen === undefined || plainMoment === undefined) throw new Error("the «Дом» companion has no kitchen");
  return { category: "home", location: kitchen.name, activity: plainMoment.text, outfit: "a satin cami and satin shorts", shot: "friend", capture: "timer", route: "seedream", ...extra };
}

describe("the plain sentence of a companion slot", () => {
  test("opens with the companion place's own phrase and says the moment and the outfit, then the outfit's coverage", () => {
    expect(plainSentence(homeSlot())).toBe(`In her kitchen, she ${plainMoment?.text}, wearing a satin cami and satin shorts. ${SATIN_SET}`);
  });

  test("an imported avatar's lace frame ends with the kept coverage", () => {
    expect(plainSentence(homeSlot({ outfit: "a black lace bra and panties" }), false)).toEndWith(`. ${LACE}`);
    expect(plainSentence(homeSlot({ outfit: "a black lace bra and panties" }))).toEndWith(`. ${LACE}`);
  });

  test("a Studio-created avatar's lace frame ends with no coverage sentence", () => {
    expect(plainSentence(homeSlot({ outfit: "a black lace bra and panties" }), true)).toBe(`In her kitchen, she ${plainMoment?.text}, wearing a black lace bra and panties.`);
  });

  test("a satin frame ends with its sentence for either origin", () => {
    for (const impliedNudity of [false, true]) expect(plainSentence(homeSlot(), impliedNudity)).toEndWith(SATIN_SET);
  });

  test("the towel's moment carries its sentence: kept for an imported avatar, descriptive for a Studio-created one", () => {
    const place = BOLD_COMPANIONS.home.places.find((p) => p.moments.some((m) => m.outfits?.includes("only a white bath towel") === true));
    const moment = place?.moments.find((m) => m.outfits?.includes("only a white bath towel") === true);
    if (place === undefined || moment === undefined) throw new Error("the «Дом» companion has no towel moment");
    const slot = homeSlot({ location: place.name, activity: moment.text, outfit: "only a white bath towel", level: "bold" });
    expect(plainSentence(slot, false)).toEndWith(COVER.towel);
    expect(plainSentence(slot, true)).toEndWith(COVER.towelOpen);
  });

  test("the same slot stored before 5a.4, with no route, reads as it always did: no companion place, no coverage", () => {
    expect(plainSentence(homeSlot({ route: undefined }))).toBe(`In her kitchen, she ${plainMoment?.text}, wearing a satin cami and satin shorts.`);
  });
});

describe("the plain sentence of a custom category's «Смелая» slot", () => {
  const room = CUSTOM_BOLD_BANKS.rooms.places.find((p) => p.name === "her room");
  const moment = room?.moments[0];

  test("opens with the shared bank's place phrase, says the bank's moment and the outfit, and ends with the coverage by origin", () => {
    const outfit = CUSTOM_BOLD_BANKS.rooms.outfits.find((o) => o.pinOnly !== true && o.coverage !== undefined);
    if (room === undefined || moment === undefined || outfit === undefined) throw new Error("no shared «rooms» place");
    const slot: PlainSlot = { category: "cat-paris-trip", location: room.name, activity: moment.text, outfit: outfit.text, shot: "friend", capture: moment.captures[0], route: "seedream" };
    expect(plainSentence(slot)).toBe(`${room.at.charAt(0).toUpperCase()}${room.at.slice(1)}, she ${moment.text}, wearing ${outfit.text}. ${outfit.coverage}`);
  });

  test("the same custom slot with no route reads the locative of its stored text, as it always did", () => {
    expect(plainSentence({ category: "cat-paris-trip", location: "her room", activity: "walking along the river", outfit: "a denim jacket" })).toBe("In her room, she is walking along the river, wearing a denim jacket.");
  });
});

describe("the plain sentence of nightwear and beach", () => {
  test("a nightwear lace frame ends with the kept coverage for an imported avatar and none for a Studio-created one", () => {
    const place = BANKS.nightwear.places[0];
    const moment = place?.moments.find((m) => m.level === undefined && m.outfits === undefined && m.legs === undefined);
    if (place === undefined || moment === undefined) throw new Error("no nightwear moment");
    const slot: PlainSlot = { category: "nightwear", location: place.name, activity: moment.text, outfit: "a black lace bra and panties", shot: "friend", capture: moment.captures[0], route: "seedream" };
    expect(plainSentence(slot, false)).toEndWith(` ${LACE}`);
    expect(plainSentence(slot, true)).not.toContain("lined and opaque");
  });
});

// Round 2, L-1: a companion place name is also an ordinary-bank place name (the same room), so a caller that loses the route is not caught by the lookup: the plain sentence silently loses the kept
// coverage. This pins the behaviour. Making `route` a required key of the slot types was tried and not done: see the commit.
describe("the route changes what a shared place name reads (L-1)", () => {
  const found = BOLD_COMPANIONS.home.places.find((p) => BANKS.home.places.some((q) => q.name === p.name));
  const moment = found?.moments[0];

  test("a companion place name that the ordinary bank has too reads the kept coverage only with the route", () => {
    if (found === undefined || moment === undefined) throw new Error("«Дом» has no place shared by the companion and the ordinary bank");
    const base = { category: "home", location: found.name, activity: moment.text, outfit: "a black lace bra and panties", shot: "friend", capture: "timer" } as const;
    expect(plainSentence({ ...base, route: "seedream" })).toContain(LACE);
    expect(plainSentence({ ...base, route: undefined })).not.toContain(LACE);
  });
});
