import { describe, expect, test } from "bun:test";
import { CAPTURES, isHandCapture, posesFor, type Capture } from "../captures";
import { momentAllowed } from "../render";
import { isOwnerBannedOutfit } from "../words";
import { BANKS, CUES, GAZE, HAIRSTYLES, validateBanks } from "./index";
import { BANK_CATEGORIES, type BankCategory } from "./types";

// 5a.2 (S5.6a, plan s5a2 r1.2): the built-in banks as data, validated when the module loads (I5.21). The CONTENT is the owner's references as the
// plan seeds them and will be refined; these tests pin the structure any content must keep.

describe("the banks load valid", () => {
  test("has a bank for each of the five built-in categories", () => {
    expect(Object.keys(BANKS).sort()).toEqual([...BANK_CATEGORIES].sort());
  });

  test("validateBanks passes the shipped banks", () => {
    expect(() => validateBanks()).not.toThrow();
  });

  test("validateBanks throws on a malformed bank, naming every problem with its category", () => {
    const broken = { ...BANKS, glamour: { ...BANKS.glamour, outfits: [{ text: "a schoolgirl skirt" }] }, home: { ...BANKS.home, places: [] } };
    expect(() => validateBanks({ banks: broken })).toThrow(/glamour: \[youth\][\s\S]*home: \[shape\]|home: \[shape\][\s\S]*glamour: \[youth\]/);
  });

  test("validateBanks throws on a malformed gaze, cue or hair bank", () => {
    expect(() => validateBanks({ gaze: [{ text: "she looks at the viewer", kind: "viewer" }] })).toThrow(/gaze: \[gaze-grammar\]/);
    expect(() => validateBanks({ cues: [{ text: "a sultry smile" }] })).toThrow(/cues: \[cue-word\]/);
    expect(() => validateBanks({ hair: [{ text: "in pigtails", lengths: ["long"], tied: true }] })).toThrow(/hair: \[youth-prop\]/);
  });
});

describe("who takes the photo (I5.32: the capture decks, exact cycles)", () => {
  const sorted = (deck: readonly Capture[]): Capture[] => [...deck].sort();

  // Plan r1.5 §5.1: prone selfies are a typical owner subject (2 of 12); the over-her-shoulder POV takes 1 of 12 beside them.
  test("«Дом» shoots herself: 4 phone-over-face mirror frames of 12, 2 mirrors, 2 close selfies from above, 2 prone selfies, an over-her-shoulder POV, 1 timer; never a friend", () => {
    expect(sorted(BANKS.home.captureDeck)).toEqual(
      sorted(["mirror-hidden", "mirror-hidden", "mirror-hidden", "mirror-hidden", "mirror", "mirror", "above", "above", "prone", "prone", "over-shoulder", "timer"]),
    );
  });

  // The prone and over-the-shoulder capture lines say «on the bed» (phoneLook.ts), so a moment of either lies at a place that is a bed, never on the rug.
  test("the bed line only lands on bed places: every prone and over-shoulder moment is at «her bed»", () => {
    for (const place of BANKS.home.places) {
      for (const moment of place.moments) {
        if (moment.captures.some((c) => c === "prone" || c === "over-shoulder")) expect(place.name, moment.text).toBe("her bed");
      }
    }
  });

  // Plan r1.5 #3: the look back along her body is turned, never straight on.
  test("every over-her-shoulder moment is three-quarter: she looks back along her body", () => {
    const pov = BANKS.home.places.flatMap((p) => p.moments).filter((m) => m.captures.includes("over-shoulder"));
    expect(pov.length).toBeGreaterThanOrEqual(2);
    for (const moment of pov) expect(moment.angle).toBe("three-quarter");
  });

  // S5.6R (MEDIUM 4, the owner: prone only on a bed): «lies on the rug facing the mirror» wore the prone selfie's outfits and lifted her hips, a prone frame
  // off the bed. Off the bed she never lies down facing the mirror; the rug's mirror moments sit.
  test("off her bed no moment lies down in a mirror frame: she lies on her stomach only on the bed", () => {
    const off = BANKS.home.places.filter((p) => p.name !== "her bed").flatMap((p) => p.moments);
    expect(off.filter((m) => m.text.startsWith("lies") && m.captures.some((c) => c === "mirror" || c === "mirror-hidden")).map((m) => m.text)).toEqual([]);
  });

  // Owner rule: side or back to the mirror shows only her reflection, so such a moment is a phone-over-face frame tagged mirrorBack.

  // S5.6R (MEDIUM 3): «sits sideways, knees together» named no mirror, so it slipped past this rule and landed on a plain mirror selfie that says her face is
  // clearly visible. Any moment that turns her side or back on, at a mirror place, is now held to it.
  test("a moment that stands or sits sideways (or side or back to the mirror) at a mirror place is a mirrorBack phone-over-face frame", () => {
    for (const category of BANK_CATEGORIES) {
      for (const place of BANKS[category].places.filter((p) => p.mirror === true)) {
        for (const moment of place.moments) {
          if (/\bsideways\b|side to the mirror|back to the mirror|counter by the mirror/.test(moment.text)) expect({ text: moment.text, back: moment.mirrorBack, captures: moment.captures }).toEqual({ text: moment.text, back: true, captures: ["mirror-hidden"] });
        }
      }
    }
  });

  // The prone selfie keeps one hand free, so its arm line says «one arm out»; a hand at her face (cheek on her hand) takes no hand cue.
  test("the prone selfie stretches one arm out, and a moment with a hand at her face is tagged so", () => {
    const moments = BANKS.home.places.flatMap((p) => p.moments);
    expect(moments.some((m) => m.text === "lies on her stomach, one arm out")).toBe(true);
    expect(moments.some((m) => /\barms out\b/.test(m.text))).toBe(false);
    for (const moment of moments.filter((m) => /cheek on her hand|head on her hand/.test(m.text))) expect(moment.handAtFace, moment.text).toBe(true);
  });

  test("the over-her-shoulder POV lies on the bed, feet up in platform sneakers, in leggings or lounge shorts", () => {
    const pov = BANKS.home.places.flatMap((p) => p.moments).filter((m) => m.captures.includes("over-shoulder"));
    expect(pov.length).toBeGreaterThanOrEqual(2);
    for (const moment of pov) {
      expect(BANKS.home.places.find((p) => p.moments.includes(moment))?.name).toBe("her bed");
      expect(moment.noLegwear).toBe(true);
      expect(moment.outfits?.length ?? 0).toBeGreaterThan(0);
      for (const outfit of moment.outfits ?? []) expect(outfit).toMatch(/(leggings|lounge shorts).*platform sneakers/);
    }
    for (const outfit of BANKS.home.outfits.filter((o) => /platform sneakers/.test(o.text))) expect(outfit.pinOnly).toBe(true);
  });

  test.each<BankCategory>(["photoshoot", "travel"])("%s («Улица», «Виды»): mostly she asked someone, 3 of 6, plus a selfie, a timer and a candid", (category) => {
    expect(sorted(BANKS[category].captureDeck)).toEqual(sorted(["friend", "friend", "friend", "selfie", "timer", "candid"]));
  });

  test("glamour: mixed, a friend twice, a selfie, a mirror, a phone-over-face mirror, a candid", () => {
    expect(sorted(BANKS.glamour.captureDeck)).toEqual(sorted(["friend", "friend", "selfie", "mirror", "mirror-hidden", "candid"]));
  });

  // S5.6R (HIGH 2): at home she shoots herself, so the home workout takes the timer the deck now deals beside the gym's and the park's friend and candid.
  test("fitness: mixed, a friend twice, a selfie, a mirror, a phone-over-face mirror, a candid, and a timer for the home workout", () => {
    expect(sorted(BANKS.fitness.captureDeck)).toEqual(sorted(["friend", "friend", "selfie", "mirror", "mirror-hidden", "candid", "timer"]));
  });

  // The plan critic (r1.3): the planner's capture fallback (timer → friend, prone → above → selfie, mirror-hidden → mirror → selfie) must never fire
  // for a built-in plan, or «Дом» would get a friend's photo. So every capture a category deals has, at every pose that capture can take, a moment at
  // a place it can land on (a mirror capture on a mirror place).
  test.each([...BANK_CATEGORIES])("%s: every deck capture has a moment at every pose it can take", (category) => {
    const missing: string[] = [];
    for (const capture of new Set(BANKS[category].captureDeck)) {
      for (const pose of posesFor(capture)) {
        const found = BANKS[category].places.some(
          (place) => (!capture.startsWith("mirror") || place.mirror === true) && place.moments.some((m) => momentAllowed(m, capture, pose)),
        );
        if (!found) missing.push(`${capture}/${pose}`);
      }
    }
    expect(missing).toEqual([]);
  });

  test("«Дом» has no moment a friend could take, so a friend's photo has nothing to render there", () => {
    expect(BANKS.home.places.flatMap((p) => p.moments).filter((m) => m.captures.includes("friend") || m.captures.includes("candid"))).toEqual([]);
  });

  test("every capture of the plan is dealt somewhere or is a legs capture (5a.2c)", () => {
    const dealt = new Set(BANK_CATEGORIES.flatMap((c) => BANKS[c].captureDeck));
    expect(CAPTURES.filter((c) => !dealt.has(c))).toEqual(["pov-legs", "low-feet"]);
    expect(dealt.has("over-shoulder")).toBe(true);
  });
});

describe("what any content must keep", () => {
  const places = (c: BankCategory) => BANKS[c].places;
  const moments = (c: BankCategory) => places(c).flatMap((p) => p.moments);

  test.each([...BANK_CATEGORIES])("%s: every place has 2-3 details and at least 4 moments", (category) => {
    for (const place of places(category)) {
      expect(place.details.length).toBeGreaterThanOrEqual(2);
      expect(place.details.length).toBeLessThanOrEqual(3);
      expect(place.moments.length).toBeGreaterThanOrEqual(4);
    }
  });

  test("Glamour is an evening out: no place or moment is on a bed", () => {
    for (const place of places("glamour")) expect(`${place.name} ${place.at} ${place.moments.map((m) => m.text).join(" ")}`).not.toMatch(/\bbed/i);
  });

  test("the lamp mood is «Дом»'s only (I5.34)", () => {
    for (const category of BANK_CATEGORIES) if (category !== "home") expect(places(category).filter((p) => p.lamp === true)).toEqual([]);
    expect(places("home").some((p) => p.lamp === true)).toBe(true);
  });

  test("«looks back over her shoulder» is a three-quarter moment that carries its own gaze", () => {
    const shoulders = BANK_CATEGORIES.flatMap(moments).filter((m) => /over her shoulder/.test(m.text));
    expect(shoulders.length).toBeGreaterThan(0);
    for (const moment of shoulders) expect({ angle: moment.angle, gaze: moment.gaze }).toEqual({ angle: "three-quarter", gaze: "own" });
  });

  test("the prone selfie is drawn only in the outfits its probes drew (grey lounge shorts, grey leggings; cotton shorts were refused)", () => {
    const prone = moments("home").filter((m) => m.captures.includes("prone"));
    expect(prone.length).toBeGreaterThan(0);
    for (const moment of prone) {
      expect(moment.outfits?.length ?? 0).toBeGreaterThan(0);
      for (const outfit of moment.outfits ?? []) expect(outfit).toMatch(/grey lounge shorts|grey leggings/);
    }
  });

  // The owner's approved «Дом» compositions (2026-10-11, prone probes P57-P62 and T42): a mirror selfie lying prone on the bed with the phone over
  // her face; the same propped on her elbows; an arm's-length prone selfie with her cheek on her hand; seated on the bathroom counter in the mirror
  // (three-quarter: a mirror capture faces the phone) in an open-back top and grey jeans; the prone selfies in leggings too.
  test("«Дом» carries the approved compositions", () => {
    const at = (name: string) => places("home").find((p) => p.name === name);
    const bed = at("her bed");
    expect(bed?.mirror).toBe(true);
    const hiddenProne = (bed?.moments ?? []).filter((m) => /lies on her stomach/.test(m.text) && m.captures.includes("mirror-hidden"));
    expect(hiddenProne.length).toBeGreaterThanOrEqual(2);
    expect(hiddenProne.some((m) => /elbows/.test(m.text))).toBe(true);
    expect((bed?.moments ?? []).some((m) => /cheek on her hand/.test(m.text) && m.captures.includes("prone"))).toBe(true);
    const counter = places("home").find((p) => p.name === "her bathroom")?.moments.find((m) => /counter/.test(m.text));
    expect(counter).toMatchObject({ captures: ["mirror-hidden"], angle: "three-quarter", outfits: ["an open-back top and grey jeans"] });
    // r1.5 (owner note): side to the mirror, only her reflection is in the picture, so S5.6b's capture line adds that sentence for this moment alone.
    expect(counter?.mirrorBack).toBe(true);
    expect(BANK_CATEGORIES.flatMap((c) => places(c).flatMap((p) => p.moments)).filter((m) => m.mirrorBack === true)).toHaveLength(2);
    for (const moment of moments("home").filter((m) => /lies on her stomach/.test(m.text))) expect(moment.outfits ?? []).toContain("grey leggings and a cropped tee");
    expect(CUES.find((c) => c.text === "her tongue out a little")?.captures).toEqual(["above", "prone"]);
  });

  test("«Дом» has none of the compositions the owner did not approve: kneeling at the mirror, hips high above her head", () => {
    for (const moment of moments("home")) {
      expect(moment.text).not.toMatch(/kneel/);
      for (const text of [moment.text, moment.motion, moment.startPose ?? ""]) expect(text).not.toMatch(/\bhigh(?:er)?\b|above her head/);
    }
  });

  // Review M4: the approved prone wording keeps her hips behind her, to one side, in natural proportions.
  test("«Дом» carries the approved «hips behind» prone wording", () => {
    expect(moments("home").some((m) => m.captures.includes("prone") && /hips behind/.test(m.text))).toBe(true);
  });

  test("no denim shorts and no denim skirts anywhere (the owner)", () => {
    for (const category of BANK_CATEGORIES) for (const outfit of BANKS[category].outfits) expect(isOwnerBannedOutfit(outfit.text)).toBe(false);
  });

  test("«Дом» carries legwear (K-17: knee-high socks, thigh-high socks, sheer tights) on about 40 % of the outfits that show her legs", () => {
    expect(BANKS.home.legwear?.share).toBe(0.4);
    expect([...(BANKS.home.legwear?.items ?? [])].sort()).toEqual(["black knee-high socks", "sheer black tights", "thigh-high socks", "white knee-high socks"]);
    expect(BANKS.home.outfits.some((o) => o.showsLegs === true)).toBe(true);
  });

  test("every gaze kind a slot can draw has an ordinary item, and the mirror kind names her phone in the mirror once at least", () => {
    for (const kind of ["viewer", "away", "down", "hands", "mirror"] as const) expect(GAZE.some((g) => g.kind === kind && g.level === undefined)).toBe(true);
    expect(GAZE.some((g) => g.kind === "mirror" && g.phone === true)).toBe(true);
  });

  test("the cues have an unsmiling one (C1), and «Дом»'s close selfies have their own: a slight pout, a finger near her lips, her hand at her cheek", () => {
    expect(CUES.some((c) => c.level === undefined && c.captures === undefined && !/smil|laugh|grin/i.test(c.text))).toBe(true);
    for (const text of ["a slight pout", "a finger near her lips", "her hand at her cheek"]) expect(CUES.find((c) => c.text === text)?.captures).toEqual(["above", "prone"]);
  });

  test("every hair length has three loose styles at least, and a tied one; the one cap style is loose", () => {
    for (const length of ["bob", "shoulder", "long"] as const) {
      const fits = HAIRSTYLES.filter((s) => s.lengths.includes(length));
      expect(fits.filter((s) => !s.tied && s.cap !== true).length).toBeGreaterThanOrEqual(3);
      expect(fits.some((s) => s.tied)).toBe(true);
    }
    expect(HAIRSTYLES.filter((s) => s.cap === true).every((s) => !s.tied)).toBe(true);
  });

  test("a hand-held capture is never listed on a two-handed or phone moment", () => {
    for (const category of BANK_CATEGORIES) {
      for (const moment of moments(category)) if (moment.twoHanded || moment.phone === true) expect(moment.captures.filter(isHandCapture)).toEqual([]);
    }
  });
});
