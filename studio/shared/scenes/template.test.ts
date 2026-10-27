import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { ScenePose } from "../engine";
import { BANKS, CUES, GAZE } from "./banks";
import type { BankCategory, BankPlace, GazeKind, Moment } from "./banks/types";
import { CAPTURES, posesFor, shotOf, type Capture } from "./captures";
import { GAZE_CUE_CAP, GAZE_CUE_WINDOW } from "./render";
import { gazeKindsFor, legwearFits, momentAllowed, templateSentence, type TemplateSlot } from "./template";
import { PHONE_WORDS, SELFIE_WORDS } from "./words";

// 5a.2 (S5.6a, plan s5a2 r1.2 §5.2): the code template. «{At}, she {moment}, wearing {outfit}[ with {legwear}], {gaze}, {cue}, with {detail}.» The
// capture decides which clauses appear: a gaze never names a camera or a lens and only a mirror gaze names her phone; a face-hidden or back frame
// gets no gaze and no cue; a room drops its detail. The tests find their places and moments by their tags, not their words.

const KEYS = Array.from({ length: 40 }, (_, i) => `run-${i}:slot-${(i % 7) + 1}`);

function find(category: BankCategory, placeTest: (p: BankPlace) => boolean, momentTest: (m: Moment) => boolean): { place: BankPlace; moment: Moment } {
  for (const place of BANKS[category].places.filter(placeTest)) {
    const moment = place.moments.find(momentTest);
    if (moment !== undefined) return { place, moment };
  }
  throw new Error(`no ${category} place and moment for this test`);
}

const plainFor =
  (capture: Capture) =>
  (m: Moment): boolean =>
    m.captures.includes(capture) && m.gaze === undefined && !m.twoHanded && m.phone !== true && m.angle === undefined && m.level === undefined && m.outfits === undefined;
const nonRoom = (p: BankPlace): boolean => p.room !== true;
const room = (p: BankPlace): boolean => p.room === true;
const firstOutfit = (category: BankCategory, moment: Moment): string => moment.outfits?.[0] ?? BANKS[category].outfits[0]?.text ?? "";

function slotOf(category: BankCategory, place: BankPlace, moment: Moment, capture: Capture, pose: ScenePose, extra: Partial<TemplateSlot> = {}): TemplateSlot {
  return { category, route: undefined, location: place.name, activity: moment.text, outfit: firstOutfit(category, moment), shot: shotOf(capture), capture, pose, ...extra };
}

const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const esc = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const anyOf = (texts: readonly string[]): string => `(${texts.map(esc).join("|")})`;
const GAZE_TEXTS = GAZE.map((g) => g.text);
const CUE_TEXTS = CUES.map((c) => c.text);

/** The gaze and the cue a sentence carries, read back from the banks. */
function clauses(sentence: string): { gaze: string | null; cue: string | null } {
  const has = (t: string) => sentence.includes(`, ${t},`) || sentence.includes(`, ${t}.`);
  return { gaze: GAZE_TEXTS.find(has) ?? null, cue: CUE_TEXTS.find(has) ?? null };
}

describe("the shape", () => {
  test("a place that is not a room: «{At}, she {moment}, wearing {outfit}, {gaze}, {cue}, with {detail}.»", () => {
    const { place, moment } = find("glamour", nonRoom, plainFor("friend"));
    for (const key of KEYS) {
      expect(templateSentence(slotOf("glamour", place, moment, "friend", "front"), { key })).toMatch(
        new RegExp(`^${esc(cap(place.at))}, she ${esc(moment.text)}, wearing ${esc(firstOutfit("glamour", moment))}, ${anyOf(GAZE_TEXTS)}, ${anyOf(CUE_TEXTS)}, with ${anyOf(place.details)}\\.$`),
      );
    }
  });

  test("a room drops «with {detail}»: its room phrase carries the details", () => {
    const { place, moment } = find("home", room, plainFor("mirror"));
    for (const key of KEYS) {
      const sentence = templateSentence(slotOf("home", place, moment, "mirror", "front"), { key });
      expect(sentence).toMatch(new RegExp(`^${esc(cap(place.at))}, she ${esc(moment.text)}, wearing ${esc(firstOutfit("home", moment))}, ${anyOf(GAZE_TEXTS)}, ${anyOf(CUE_TEXTS)}\\.$`));
    }
  });

  test("a back pose drops the gaze and the cue (a place that is not a room keeps its detail)", () => {
    const { place, moment } = find("glamour", nonRoom, plainFor("friend"));
    for (const key of KEYS) {
      expect(templateSentence(slotOf("glamour", place, moment, "friend", "back"), { key })).toMatch(
        new RegExp(`^${esc(cap(place.at))}, she ${esc(moment.text)}, wearing ${esc(firstOutfit("glamour", moment))}, with ${anyOf(place.details)}\\.$`),
      );
    }
  });

  test("a mirror frame with the phone over her face drops the gaze and the cue (faceVisibleOf: no)", () => {
    const { place, moment } = find("home", room, plainFor("mirror-hidden"));
    for (const key of KEYS) expect(templateSentence(slotOf("home", place, moment, "mirror-hidden", "front"), { key })).toBe(`${cap(place.at)}, she ${moment.text}, wearing ${firstOutfit("home", moment)}.`);
  });

  // S5.6R: the taxi's «looks out of the window» (the glamour moment this found) is a selfie now; «Виды» keeps a friend's own-gaze moment on any facing pose.
  test("a moment that carries its own gaze gets no gaze clause, and keeps its cue", () => {
    const { place, moment } = find("travel", () => true, (m) => m.captures.includes("friend") && m.gaze === "own" && m.angle === undefined && m.phone !== true && m.expression === undefined);
    for (const key of KEYS) {
      const sentence = templateSentence(slotOf("travel", place, moment, "friend", "front"), { key }) ?? "";
      expect(clauses(sentence).gaze).toBeNull();
      expect(clauses(sentence).cue).not.toBeNull();
    }
  });

  // Review M3: a moment that carries its own expression (laughs, smiles) takes no cue, so «a calm, neutral face» never contradicts it.
  test("a moment with its own expression gets no cue, and keeps its detail", () => {
    const { place, moment } = find("glamour", nonRoom, (m) => m.expression === true && m.captures.includes("friend") && m.angle === undefined);
    for (const key of KEYS) {
      const sentence = templateSentence(slotOf("glamour", place, moment, "friend", "front"), { key }) ?? "";
      expect(clauses(sentence).cue).toBeNull();
      expect(sentence).toMatch(new RegExp(`, with ${anyOf(place.details)}\\.$`));
    }
  });

  test("an old slot with no capture reads it from its shot", () => {
    const { place, moment } = find("glamour", nonRoom, plainFor("friend"));
    const { capture: _capture, ...old } = slotOf("glamour", place, moment, "friend", "front");
    expect(templateSentence(old, { key: "k" })).toBe(templateSentence(slotOf("glamour", place, moment, "friend", "front"), { key: "k" }));
    expect(templateSentence({ ...old, shot: "photographer" }, { key: "k" })).toBe(templateSentence(slotOf("glamour", place, moment, "friend", "front"), { key: "k" }));
  });

  test("is deterministic: the same slot and key give the same sentence, and other keys draw other clauses", () => {
    const { place, moment } = find("travel", nonRoom, plainFor("friend"));
    const slot = slotOf("travel", place, moment, "friend", "front");
    expect(templateSentence(slot, { key: "run-1:slot-1" })).toBe(templateSentence(slot, { key: "run-1:slot-1" }));
    expect(new Set(KEYS.map((key) => templateSentence(slot, { key }))).size).toBeGreaterThan(10);
  });
});

describe("the gaze a capture and a pose may take (the coherence table, I5.23)", () => {
  test.each<[Capture, ScenePose, Moment["gaze"], readonly GazeKind[]]>([
    ["mirror", "front", undefined, ["mirror", "down"]],
    ["mirror-hidden", "front", undefined, []],
    ["above", "front", undefined, ["viewer", "down"]],
    ["prone", "three-quarter", undefined, ["viewer", "down"]],
    ["selfie", "front", undefined, ["viewer", "down"]],
    ["selfie", "front", "focus", ["viewer", "down"]],
    ["timer", "front", undefined, ["viewer", "away", "down"]],
    ["friend", "three-quarter", undefined, ["viewer", "away", "down"]],
    ["friend", "front", "focus", ["viewer", "away", "down", "hands"]],
    ["friend", "profile", undefined, ["away", "down"]],
    ["timer", "profile", "focus", ["away", "down", "hands"]],
    ["candid", "front", undefined, ["away", "down"]],
    ["candid", "three-quarter", "focus", ["away", "down", "hands"]],
    ["friend", "back", undefined, []],
    ["timer", "back", undefined, []],
    ["friend", "front", "own", []],
    ["friend", "front", "viewer", []],
  ])("%s, %s, a moment with gaze %p: %p", (capture, pose, gaze, kinds) => {
    expect([...gazeKindsFor(capture, pose, gaze)].sort()).toEqual([...kinds].sort());
  });

  test("a selfie, a close selfie from above and a prone selfie never name her phone or say selfie; only a mirror gaze names the phone", () => {
    for (const category of ["home", "travel", "photoshoot", "glamour", "fitness"] as const) {
      for (const place of BANKS[category].places) {
        for (const moment of place.moments) {
          for (const capture of moment.captures) {
            for (const key of KEYS.slice(0, 8)) {
              const sentence = templateSentence(slotOf(category, place, moment, capture, "front"), { key });
              if (sentence === null) continue;
              if (shotOf(capture) === "selfie") expect(PHONE_WORDS.test(sentence) || SELFIE_WORDS.test(sentence)).toBe(false);
              if (moment.phone !== true && shotOf(capture) !== "mirror") expect(PHONE_WORDS.test(sentence)).toBe(false);
            }
          }
        }
      }
    }
  });

  test("«Дом»'s own cues (a slight pout, a finger near her lips, her hand at her cheek) go only to the close selfies from above and the prone selfie", () => {
    const own = CUES.filter((c) => c.captures !== undefined).map((c) => c.text);
    const above = find("home", () => true, plainFor("above"));
    const mirror = find("home", room, plainFor("mirror"));
    const aboveCues = new Set(KEYS.map((key) => clauses(templateSentence(slotOf("home", above.place, above.moment, "above", "front"), { key }) ?? "").cue));
    expect(own.some((c) => aboveCues.has(c))).toBe(true);
    for (const key of KEYS) expect(own).not.toContain(clauses(templateSentence(slotOf("home", mirror.place, mirror.moment, "mirror", "front"), { key }) ?? "").cue);
  });
});

describe("which moments a slot may take (I5.23, drawn before the text)", () => {
  const base: Moment = { text: "waits for the kettle", motion: "she waits a little", captures: ["friend", "selfie", "mirror", "timer", "candid", "above"], twoHanded: false };

  test.each<[string, Moment, Capture, ScenePose, boolean]>([
    ["a moment on a capture it lists", base, "friend", "back", true],
    ["a moment on a capture it does not list", base, "prone", "front", false],
    ["a moment on a selfie", base, "selfie", "front", true],
    ["a two-handed moment on a selfie", { ...base, twoHanded: true }, "selfie", "front", false],
    ["a two-handed moment on a mirror", { ...base, twoHanded: true }, "mirror", "three-quarter", false],
    ["a two-handed moment from above", { ...base, twoHanded: true }, "above", "front", false],
    ["a two-handed moment on a timer", { ...base, twoHanded: true }, "timer", "front", true],
    ["a phone moment on a mirror", { ...base, phone: true, gaze: "own" }, "mirror", "front", false],
    ["a phone moment on a candid", { ...base, phone: true, gaze: "own" }, "candid", "front", true],
    ["a three-quarter moment on a front pose", { ...base, angle: "three-quarter" }, "friend", "front", false],
    ["a three-quarter moment on a three-quarter pose", { ...base, angle: "three-quarter" }, "friend", "three-quarter", true],
    ["a back moment on a back pose", { ...base, angle: "back" }, "timer", "back", true],
    ["a viewer moment on a candid", { ...base, gaze: "viewer" }, "candid", "front", false],
    ["a viewer moment in profile", { ...base, gaze: "viewer" }, "friend", "profile", false],
    ["a viewer moment from behind", { ...base, gaze: "viewer" }, "timer", "back", false],
    ["a viewer moment with her face behind the phone", { ...base, gaze: "viewer", captures: ["mirror-hidden"] }, "mirror-hidden", "front", false],
    ["a viewer moment on a friend's front photo", { ...base, gaze: "viewer" }, "friend", "front", true],
    ["any moment on a selfie in profile (never planned)", base, "selfie", "profile", false],
    ["any moment from above, from behind (never planned)", base, "above", "back", false],
    ["a flirty moment on an ordinary slot", { ...base, level: "flirty" }, "friend", "front", false],
    ["a legs moment on an ordinary slot (5a.2c)", { ...base, legs: { framing: "legs" } }, "friend", "front", false],
  ])("%s: %p", (_name, moment, capture, pose, allowed) => {
    expect(momentAllowed(moment, capture, pose)).toBe(allowed);
  });

  test("a flirty moment is allowed on a flirty slot, and a legs moment on a legs slot", () => {
    expect(momentAllowed({ ...base, level: "flirty" }, "friend", "front", "flirty")).toBe(true);
    expect(momentAllowed({ ...base, legs: { framing: "legs" } }, "friend", "front", "ordinary", "legs")).toBe(true);
    expect(momentAllowed(base, "friend", "front", "ordinary", "legs")).toBe(false);
  });
});

describe("outfits: pinned ones and the legwear slot", () => {
  const prone = find("home", () => true, (m) => m.captures.includes("prone") && m.outfits !== undefined);
  const legsOutfit = BANKS.home.outfits.find((o) => o.showsLegs === true)?.text ?? "";
  const coveredOutfit = BANKS.home.outfits.find((o) => o.showsLegs !== true)?.text ?? "";
  const legwear = BANKS.home.legwear?.items[0] ?? "";
  const sitting = find("home", room, (m) => plainFor("mirror")(m) && m.noLegwear === undefined && !/\b(socks?|tights|bare|heels|soles?)\b/i.test(m.text));

  test("the prone selfie renders in its pinned outfit and not in another", () => {
    expect(templateSentence(slotOf("home", prone.place, prone.moment, "prone", "front"), { key: "k" })).not.toBeNull();
    expect(templateSentence(slotOf("home", prone.place, prone.moment, "prone", "front", { outfit: coveredOutfit }), { key: "k" })).toBeNull();
  });

  // Re-review 1: a pin-only outfit (the over-her-shoulder POV's platform sneakers) is worn only by a moment that pins it, never «lies curled under
  // the blanket, wearing … platform sneakers».
  test("no unpinned moment ever renders a pin-only outfit; a moment that pins one does", () => {
    const pinOnly = BANKS.home.outfits.filter((o) => o.pinOnly === true).map((o) => o.text);
    expect(pinOnly.length).toBeGreaterThan(0);
    let pinnedRenders = 0;
    for (const place of BANKS.home.places) {
      for (const moment of place.moments) {
        for (const capture of moment.captures) {
          for (const outfit of pinOnly) {
            const sentence = templateSentence(slotOf("home", place, moment, capture, capture === "over-shoulder" ? "three-quarter" : "front", { outfit }), { key: "k" });
            if (moment.outfits?.includes(outfit) === true) {
              if (sentence !== null) pinnedRenders++;
            } else expect(sentence).toBeNull();
          }
        }
      }
    }
    expect(pinnedRenders).toBeGreaterThan(0);
  });

  test("legwear reads «wearing {outfit} with {legwear}» on an outfit that shows her legs", () => {
    expect(templateSentence(slotOf("home", sitting.place, sitting.moment, "mirror", "front", { outfit: legsOutfit, legwear }), { key: "k" })).toContain(`, wearing ${legsOutfit} with ${legwear}, `);
  });

  test.each<[string, Partial<TemplateSlot>]>([
    ["legwear the bank does not have", { outfit: legsOutfit, legwear: "striped leg warmers" }],
    ["legwear on an outfit that covers her legs", { outfit: coveredOutfit, legwear }],
  ])("%s gives null", (_name, extra) => {
    expect(templateSentence(slotOf("home", sitting.place, sitting.moment, "mirror", "front", extra), { key: "k" })).toBeNull();
  });

  test.each<[string, Moment, boolean]>([
    ["legs crossed take legwear (plan r1.4)", { ...sitting.moment, text: "sits on the chair, one leg crossed" }, true],
    ["«stretches her legs» takes legwear", { ...sitting.moment, text: "stretches her legs" }, true],
    ["a moment that names her socks does not", { ...sitting.moment, text: "pulls up her socks" }, false],
    ["a moment that names bare feet does not", { ...sitting.moment, text: "sits with her bare feet up" }, false],
    ["a moment in heels does not", { ...sitting.moment, text: "slips on her heels" }, false],
    ["a moment tagged noLegwear does not (Grok refused legs up in tights)", { ...sitting.moment, text: "lies on her stomach, feet raised", noLegwear: true }, false],
  ])("%s", (_name, moment, fits) => {
    expect(legwearFits(moment, { text: legsOutfit, showsLegs: true })).toBe(fits);
  });

  test("a moment that clashes with legwear renders without it and is null with it", () => {
    const feetUp = find("home", () => true, (m) => m.noLegwear === true && m.captures.includes("prone"));
    expect(templateSentence(slotOf("home", feetUp.place, feetUp.moment, "prone", "front"), { key: "k" })).not.toBeNull();
    expect(templateSentence(slotOf("home", feetUp.place, feetUp.moment, "prone", "front", { legwear }), { key: "k" })).toBeNull();
  });
});

describe("«Подача» (I5.28, 5a.2b): an ordinary slot never draws a flirty item", () => {
  const { place, moment } = find("glamour", nonRoom, plainFor("friend"));
  const flirtyGaze = GAZE.filter((g) => g.level === "flirty").map((g) => g.text);
  const flirtyCues = CUES.filter((c) => c.level === "flirty").map((c) => c.text);

  test("ordinary (and absent) levels: no flirty gaze, no flirty cue", () => {
    for (const key of KEYS) {
      for (const level of ["ordinary", undefined] as const) {
        const sentence = templateSentence(slotOf("glamour", place, moment, "friend", "front"), level === undefined ? { key } : { key, level }) ?? "";
        expect(flirtyGaze.some((g) => sentence.includes(g))).toBe(false);
        expect(flirtyCues.some((c) => sentence.includes(c))).toBe(false);
      }
    }
  });

  test("a flirty slot draws a flirty cue, and a flirty gaze where the viewer may be looked at", () => {
    for (const key of KEYS) {
      const sentence = templateSentence(slotOf("glamour", place, moment, "friend", "front"), { key, level: "flirty" }) ?? "";
      expect(flirtyCues.some((c) => sentence.includes(c))).toBe(true);
      expect(flirtyGaze.some((g) => sentence.includes(g))).toBe(true);
      const candid = templateSentence(slotOf("glamour", place, moment, "candid", "front"), { key, level: "flirty" }) ?? "";
      expect(flirtyGaze.some((g) => candid.includes(g))).toBe(false);
    }
  });
});

describe("«Подача» rides on the slot (S5.7b): a mixed run has flirty and ordinary slots side by side", () => {
  const { place, moment } = find("glamour", nonRoom, plainFor("friend"));
  const flirtyCues = CUES.filter((c) => c.level === "flirty").map((c) => c.text);
  const flirtyGaze = GAZE.filter((g) => g.level === "flirty").map((g) => g.text);

  test("a slot with level flirty draws flirty items though the context names no level", () => {
    for (const key of KEYS) {
      const sentence = templateSentence({ ...slotOf("glamour", place, moment, "friend", "front"), level: "flirty" }, { key }) ?? "";
      expect(flirtyCues.some((c) => sentence.includes(c)) || flirtyGaze.some((g) => sentence.includes(g))).toBe(true);
    }
  });

  test("a slot that names no level follows the context's (a caller that sets one level for the whole list)", () => {
    for (const key of KEYS) {
      const sentence = templateSentence(slotOf("glamour", place, moment, "friend", "front"), { key, level: "flirty" }) ?? "";
      expect(flirtyCues.some((c) => sentence.includes(c))).toBe(true);
    }
  });

  test("an ordinary slot in a run whose context says flirty stays ordinary when the slot says ordinary", () => {
    for (const key of KEYS) {
      const sentence = templateSentence({ ...slotOf("glamour", place, moment, "friend", "front"), level: "ordinary" }, { key, level: "flirty" }) ?? "";
      expect(flirtyCues.some((c) => sentence.includes(c))).toBe(false);
      expect(flirtyGaze.some((g) => sentence.includes(g))).toBe(false);
    }
  });
});

describe("null, never a throw (I5.22)", () => {
  const { place, moment } = find("home", room, plainFor("mirror"));
  const ok = slotOf("home", place, moment, "mirror", "front");

  test("the fixture renders", () => {
    expect(templateSentence(ok, { key: "k" })).not.toBeNull();
  });

  test.each<[string, TemplateSlot]>([
    ["an unknown built-in category", { ...ok, category: "beach" }],
    ["an own scene", { ...ok, category: "own" }],
    ["a place the bank does not have (an old plan's place)", { ...ok, location: "her small kitchen" }],
    ["a moment the place does not have (an old plan's gerund activity)", { ...ok, activity: "waiting for the kettle" }],
    ["a moment of another place", { ...ok, activity: "jogs along the path" }],
    ["an outfit the bank does not have", { ...ok, outfit: "a ball gown" }],
    ["no place", { ...ok, location: undefined }],
    ["no moment", { ...ok, activity: undefined }],
    ["no outfit", { ...ok, outfit: undefined }],
    ["a capture the moment does not list", { ...ok, capture: "prone", shot: "selfie" }],
    ["a capture that does not ride on the stored shot", { ...ok, capture: "mirror", shot: "friend" }],
    ["a pose the moment cannot take (a three-quarter moment on a front pose)", (() => {
      const shoulder = find("photoshoot", () => true, (m) => m.angle === "three-quarter");
      return slotOf("photoshoot", shoulder.place, shoulder.moment, "friend", "front");
    })()],
    ["a two-handed moment on a timer slot drawn as a selfie", (() => {
      const two = find("home", () => true, (m) => m.twoHanded && m.captures.includes("timer"));
      return { ...slotOf("home", two.place, two.moment, "timer", "front"), capture: "selfie" as const, shot: "selfie" as const };
    })()],
    ["a custom category without its snapshot", { ...ok, category: "cat-abcdefgh" }],
  ])("%s gives null", (_name, slot) => {
    expect(templateSentence(slot, { key: "k" })).toBeNull();
  });
});

describe("no two equal sentences in a run (I5.24 dedup)", () => {
  const { place, moment } = find("glamour", nonRoom, plainFor("friend"));
  const slot = slotOf("glamour", place, moment, "friend", "front");

  test("an equal sentence is redrawn on the dedup streams", () => {
    const first = templateSentence(slot, { key: "run-1:slot-1" }) ?? "";
    const second = templateSentence(slot, { key: "run-1:slot-1", seen: new Set([first]) });
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(templateSentence(slot, { key: "run-1:slot-1", seen: new Set([first]) })).toBe(second);
  });

  test("a sentence with nothing left to redraw keeps its first text (the moment-repeat metric flags it)", () => {
    const bare = find("home", room, plainFor("mirror-hidden"));
    const hidden = slotOf("home", bare.place, bare.moment, "mirror-hidden", "front");
    const only = templateSentence(hidden, { key: "k" }) ?? "";
    expect(templateSentence(hidden, { key: "k", seen: new Set([only]) })).toBe(only);
  });

  test("when all 8 redraws are taken too, the slot keeps its first text", () => {
    const variants = new Set<string>();
    for (let i = 0; i <= 8; i++) {
      const sentence = templateSentence(slot, { key: i === 0 ? "run-9:slot-2" : `run-9:slot-2:dedup:${i}` });
      if (sentence !== null) variants.add(sentence);
    }
    expect(templateSentence(slot, { key: "run-9:slot-2", seen: variants })).toBe(templateSentence(slot, { key: "run-9:slot-2" }));
  });
});

// I5.35: a moment's motion and start pose are data for the video slice; the template never reads them, so no photo prompt carries them.
describe("the motion is never read (I5.35)", () => {
  test("no sentence carries a motion or a start pose", () => {
    for (const category of ["home", "glamour"] as const) {
      for (const place of BANKS[category].places) {
        for (const moment of place.moments) {
          for (const capture of moment.captures) {
            const sentence = templateSentence(slotOf(category, place, moment, capture, "front"), { key: "k" }) ?? "";
            expect(sentence.includes(moment.motion)).toBe(false);
            if (moment.startPose !== undefined) expect(sentence.includes(moment.startPose)).toBe(false);
          }
        }
      }
    }
  });
});

describe("the motion is never read: statically", () => {
  test.each(["render.ts", "template.ts", "custom.ts", "hair.ts", "captures.ts"])("%s never reads a moment's motion or start pose", (name) => {
    const source = readFileSync(join(import.meta.dir, name), "utf8");
    expect(source).not.toMatch(/\.motion\b|\bstartPose\b/);
  });
});

// 5a.2 (S5.6b review, LOW): a moment with a hand already at her face (cheek on her hand) takes no hand cue («her hand at her cheek», «a finger near her lips»).
describe("a hand at her face takes no hand cue", () => {
  const HAND_CUES = CUES.filter((c) => c.hand === true).map((c) => c.text);

  test("the hand cues exist", () => {
    expect(HAND_CUES.length).toBeGreaterThanOrEqual(2);
  });

  test("a prone moment tagged handAtFace never draws one, over 200 keys", () => {
    const { place, moment } = find("home", (p) => p.name === "her bed", (m) => m.handAtFace === true && m.captures.includes("prone"));
    const slot: TemplateSlot = { category: "home", route: undefined, location: place.name, activity: moment.text, outfit: "grey jersey lounge shorts and a tee", shot: "selfie", capture: "prone", pose: "front" };
    const sentences = Array.from({ length: 200 }, (_, i) => templateSentence(slot, { key: `run-${i}:slot-1` }) ?? "");
    expect(sentences.every((sentence) => sentence !== "")).toBe(true);
    for (const sentence of sentences) for (const cue of HAND_CUES) expect(sentence).not.toContain(cue);
  });

  test("an untagged prone moment does draw them (the exclusion is the tag's, not a blanket)", () => {
    const { place, moment } = find("home", (p) => p.name === "her bed", (m) => m.handAtFace !== true && m.captures.includes("prone"));
    const slot: TemplateSlot = { category: "home", route: undefined, location: place.name, activity: moment.text, outfit: "grey jersey lounge shorts and a tee", shot: "selfie", capture: "prone", pose: "front" };
    const all = Array.from({ length: 200 }, (_, i) => templateSentence(slot, { key: `run-${i}:slot-1` }) ?? "").join(" ");
    expect(HAND_CUES.some((cue) => all.includes(cue))).toBe(true);
  });
});

// S5.6R (round C): a gaze, and an expression, at most twice in any 20 sentences in a row (render.ts GazeCueTally). The cap always holds on an ordinary run
// when every frame that takes a gaze or a cue has at least 20 / 2 of them to draw from: the 19 sentences before it close at most 9.
describe("an ordinary frame has enough gazes and expressions for the cap of two in twenty", () => {
  const NEEDED = GAZE_CUE_WINDOW / GAZE_CUE_CAP;
  const FRAMES = CAPTURES.flatMap((capture) => posesFor(capture).map((pose) => ({ capture, pose })));

  test("every capture and pose that shows her face takes at least 10 ordinary gazes", () => {
    const short = FRAMES.flatMap(({ capture, pose }) => {
      const kinds = gazeKindsFor(capture, pose);
      const gazes = GAZE.filter((g) => g.level === undefined && kinds.includes(g.kind)).length;
      return kinds.length > 0 && gazes < NEEDED ? [`${capture} ${pose}: ${gazes}`] : [];
    });
    expect(short).toEqual([]);
  });

  test("every capture takes at least 10 ordinary expressions, with her hand at her face too", () => {
    const short = CAPTURES.flatMap((capture) => {
      const cues = CUES.filter((c) => c.level === undefined && c.hand !== true && (c.captures === undefined || c.captures.includes(capture))).length;
      return cues < NEEDED ? [`${capture}: ${cues}`] : [];
    });
    expect(short).toEqual([]);
  });
});
