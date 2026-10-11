import { describe, expect, test } from "bun:test";
import { BANKS, CUES, GAZE, HAIRSTYLES, validateBanks } from "./index";
import { CAPTURES, isDrawnCapture } from "./captures";
import { LIGHTS } from "./lights";
import { momentAllowed } from "../template";
import { fitsEveryShot } from "./schema";
import { BANK_CATEGORIES, CAPTURE_KINDS, type BankCategory } from "./types";

// 5a.2 (S5.6a): the built-in banks as data, validated when the module loads (I5.21). The bank CONTENT is provisional (the owner's style references
// of 2026-10-11 will replace it); these tests pin the structure any content must keep, not the words.

describe("the banks load valid", () => {
  test("has a bank for each of the five built-in categories", () => {
    expect(Object.keys(BANKS).sort()).toEqual([...BANK_CATEGORIES].sort());
  });

  test("validateBanks passes the shipped banks", () => {
    expect(() => validateBanks()).not.toThrow();
  });

  test("validateBanks throws on a malformed bank, naming every problem with its category", () => {
    const broken = { ...BANKS, glamour: { ...BANKS.glamour, outfits: ["a schoolgirl skirt"] }, home: { ...BANKS.home, places: [] } };
    expect(() => validateBanks({ banks: broken })).toThrow(/glamour: \[youth\][\s\S]*home: \[shape\]|home: \[shape\][\s\S]*glamour: \[youth\]/);
  });

  test("validateBanks throws on a malformed gaze, cue or hair bank", () => {
    expect(() => validateBanks({ gaze: [{ text: "she looks at the viewer", kind: "viewer" }] })).toThrow(/gaze: \[gaze-grammar\]/);
    expect(() => validateBanks({ cues: [{ text: "a sultry smile" }] })).toThrow(/cues: \[cue-word\]/);
    expect(() => validateBanks({ hair: [{ text: "in pigtails", lengths: ["long"], tied: true }] })).toThrow(/hair: \[youth-prop\]/);
  });
});

describe("what any content must keep", () => {
  const places = (c: BankCategory) => BANKS[c].places;

  test.each([...BANK_CATEGORIES])("%s: every place has 2-3 details, at least 4 moments, and a moment for every shot and pose", (category) => {
    for (const place of places(category)) {
      expect(place.details.length).toBeGreaterThanOrEqual(2);
      expect(place.details.length).toBeLessThanOrEqual(3);
      expect(place.moments.length).toBeGreaterThanOrEqual(4);
      expect(place.moments.some(fitsEveryShot)).toBe(true);
    }
  });

  // I5.24: a selfie or a mirror shot takes only a place's one-handed, phone-free moments, and the planner swaps every mirror shot onto a mirror place,
  // so a place with few of them repeats them (the variety sweep, templateVariety.test.ts, found 6 repeats in 100 slots with 3).
  test.each([...BANK_CATEGORIES])("%s: every place has 3 moments a hand-held shot may take, a mirror place 4", (category) => {
    for (const place of places(category)) {
      const forHand = place.moments.filter((m) => momentAllowed(m, "selfie", "front") || momentAllowed(m, "selfie", "three-quarter")).length;
      expect({ place: place.name, forHand: Math.min(forHand, place.mirror === true ? 4 : 3) }).toEqual({ place: place.name, forHand: place.mirror === true ? 4 : 3 });
    }
  });

  test("Glamour is an evening out: no place is on a bed", () => {
    for (const place of places("glamour")) expect(`${place.name} ${place.at} ${place.moments.map((m) => m.text).join(" ")}`).not.toMatch(/\bbed/i);
  });

  test("S5.5's «looking over her shoulder» is a three-quarter moment that carries its own gaze", () => {
    const shoulders = BANK_CATEGORIES.flatMap((c) => places(c).flatMap((p) => p.moments)).filter((m) => /over her shoulder/.test(m.text));
    expect(shoulders.length).toBeGreaterThan(0);
    for (const moment of shoulders) expect({ angle: moment.angle, gaze: moment.gaze }).toEqual({ angle: "three-quarter", gaze: "own" });
  });

  test("every gaze kind a slot can draw has an ordinary item, and the mirror kind names her phone in the mirror once at least", () => {
    for (const kind of ["viewer", "away", "down", "hands", "mirror"] as const) expect(GAZE.some((g) => g.kind === kind && g.level === undefined)).toBe(true);
    expect(GAZE.some((g) => g.kind === "mirror" && g.phone === true)).toBe(true);
  });

  test("the cues have an unsmiling one (C1: one unsmiling expression)", () => {
    expect(CUES.some((c) => c.level === undefined && !/smil|laugh|grin/i.test(c.text))).toBe(true);
  });

  test("every hair length has three loose styles at least, and a tied one; the one cap style is loose", () => {
    for (const length of ["bob", "shoulder", "long"] as const) {
      const fits = HAIRSTYLES.filter((s) => s.lengths.includes(length));
      expect(fits.filter((s) => !s.tied && s.cap !== true).length).toBeGreaterThanOrEqual(3);
      expect(fits.some((s) => s.tied)).toBe(true);
    }
    expect(HAIRSTYLES.filter((s) => s.cap === true).every((s) => !s.tied)).toBe(true);
  });

  test("a hook a moment names is never drawn (placeholders for the references stay out of every slot)", () => {
    const hooked = BANK_CATEGORIES.flatMap((c) => places(c).flatMap((p) => p.moments)).filter((m) => m.captures !== undefined);
    for (const moment of hooked) expect(moment.captures?.every((c) => c !== "friend" && c !== "selfie" && c !== "mirror" && c !== "candid" && c !== "photographer")).toBe(true);
  });

  test("only the five stored shots are drawn: every new capture kind is a hook until its capture line exists", () => {
    expect(CAPTURE_KINDS.filter(isDrawnCapture)).toEqual(["friend", "selfie", "mirror", "candid", "photographer"]);
    expect(CAPTURES["mirror-face-hidden"].faceVisible).toBe(false);
    expect(CAPTURES["pov-legs"].faceVisible).toBe(false);
  });

  test("a place's lights are in the light bank", () => {
    const ids = new Set(LIGHTS.map((l) => l.id));
    for (const category of BANK_CATEGORIES) for (const place of places(category)) for (const id of place.lights ?? []) expect(ids.has(id)).toBe(true);
  });
});
