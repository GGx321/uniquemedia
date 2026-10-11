import { describe, expect, test } from "bun:test";
import type { PoolShot, ScenePose } from "../engine";
import { BANKS, CUES, GAZE } from "./banks";
import type { BankCategory, BankPlace, GazeKind, Moment } from "./banks/types";
import { gazeKindsFor, momentAllowed, templateSentence, type TemplateSlot } from "./template";
import { PHONE_WORDS, SELFIE_WORDS } from "./words";

// 5a.2 (S5.6a, plan s5a2 §5.2): the code template. «{At}, she {moment}, wearing {outfit}, {gaze}, {cue}, with {detail}.», with r1.1's corrections:
// a gaze never names a camera or a lens and only a mirror gaze names her phone; a room drops `with {detail}` (its room phrase carries the details);
// a back pose drops the gaze and the cue. The bank content is provisional, so the tests find their places and moments by their tags, not their words.

const KEYS = Array.from({ length: 40 }, (_, i) => `run-${i}:slot-${(i % 7) + 1}`);

function find(category: BankCategory, placeTest: (p: BankPlace) => boolean, momentTest: (m: Moment) => boolean): { place: BankPlace; moment: Moment } {
  for (const place of BANKS[category].places.filter(placeTest)) {
    const moment = place.moments.find(momentTest);
    if (moment !== undefined) return { place, moment };
  }
  throw new Error(`no ${category} place and moment for this test`);
}

const plain = (m: Moment): boolean => m.gaze === undefined && !m.twoHanded && m.phone !== true && m.angle === undefined && m.captures === undefined && m.level === undefined;
const nonRoom = (p: BankPlace): boolean => p.room !== true;
const room = (p: BankPlace): boolean => p.room === true;

function slotOf(category: BankCategory, place: BankPlace, moment: Moment, shot: PoolShot, pose: ScenePose, extra: Partial<TemplateSlot> = {}): TemplateSlot {
  return { category, location: place.name, activity: moment.text, outfit: BANKS[category].outfits[0], shot, pose, ...extra };
}

const cap = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
const GAZE_TEXTS = GAZE.map((g) => g.text);
const CUE_TEXTS = CUES.map((c) => c.text);
const anyOf = (texts: readonly string[]): string => `(${texts.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|")})`;
const esc = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** The gaze and the cue a sentence carries, read back from the banks. */
function clauses(sentence: string): { gaze: string | null; cue: string | null } {
  return { gaze: GAZE_TEXTS.find((g) => sentence.includes(`, ${g},`) || sentence.includes(`, ${g}.`)) ?? null, cue: CUE_TEXTS.find((c) => sentence.includes(`, ${c},`) || sentence.includes(`, ${c}.`)) ?? null };
}

describe("the shape", () => {
  test("a place that is not a room: «{At}, she {moment}, wearing {outfit}, {gaze}, {cue}, with {detail}.»", () => {
    const { place, moment } = find("glamour", nonRoom, plain);
    const outfit = BANKS.glamour.outfits[0] ?? "";
    for (const key of KEYS) {
      const sentence = templateSentence(slotOf("glamour", place, moment, "friend", "front"), { key });
      expect(sentence).toMatch(new RegExp(`^${esc(cap(place.at))}, she ${esc(moment.text)}, wearing ${esc(outfit)}, ${anyOf(GAZE_TEXTS)}, ${anyOf(CUE_TEXTS)}, with ${anyOf(place.details)}\\.$`));
    }
  });

  test("a room drops «with {detail}»: its room phrase carries the details", () => {
    const { place, moment } = find("home", room, plain);
    const outfit = BANKS.home.outfits[0] ?? "";
    for (const key of KEYS) {
      const sentence = templateSentence(slotOf("home", place, moment, "friend", "front"), { key });
      expect(sentence).toMatch(new RegExp(`^${esc(cap(place.at))}, she ${esc(moment.text)}, wearing ${esc(outfit)}, ${anyOf(GAZE_TEXTS)}, ${anyOf(CUE_TEXTS)}\\.$`));
      expect(sentence).not.toContain(", with ");
    }
  });

  test("a back pose drops the gaze and the cue (a place that is not a room keeps its detail)", () => {
    const { place, moment } = find("glamour", nonRoom, plain);
    for (const key of KEYS) {
      const sentence = templateSentence(slotOf("glamour", place, moment, "friend", "back"), { key });
      expect(sentence).toMatch(new RegExp(`^${esc(cap(place.at))}, she ${esc(moment.text)}, wearing ${esc(BANKS.glamour.outfits[0] ?? "")}, with ${anyOf(place.details)}\\.$`));
    }
  });

  test("a back pose in a room is the bare sentence", () => {
    const { place, moment } = find("home", room, plain);
    expect(templateSentence(slotOf("home", place, moment, "candid", "back"), { key: "k" })).toBe(`${cap(place.at)}, she ${moment.text}, wearing ${BANKS.home.outfits[0]}.`);
  });

  test("a frame with her face hidden drops the gaze and the cue too (the references' face-hidden frames)", () => {
    const { place, moment } = find("glamour", nonRoom, plain);
    for (const key of KEYS) {
      const sentence = templateSentence(slotOf("glamour", place, moment, "friend", "front", { faceVisible: false }), { key });
      expect(clauses(sentence ?? "")).toEqual({ gaze: null, cue: null });
    }
  });

  test("a moment that carries its own gaze gets no gaze clause, and keeps its cue", () => {
    const { place, moment } = find("glamour", () => true, (m) => m.gaze === "own" && m.angle === undefined && m.phone !== true);
    for (const key of KEYS) {
      const sentence = templateSentence(slotOf("glamour", place, moment, "friend", "front"), { key }) ?? "";
      expect(clauses(sentence).gaze).toBeNull();
      expect(clauses(sentence).cue).not.toBeNull();
    }
  });

  test("is deterministic: the same slot and key give the same sentence, and other keys draw other clauses", () => {
    const { place, moment } = find("travel", nonRoom, plain);
    const slot = slotOf("travel", place, moment, "friend", "front");
    expect(templateSentence(slot, { key: "run-1:slot-1" })).toBe(templateSentence(slot, { key: "run-1:slot-1" }));
    expect(new Set(KEYS.map((key) => templateSentence(slot, { key }))).size).toBeGreaterThan(10);
  });
});

describe("the gaze a shot and a pose may take (the coherence table, I5.23)", () => {
  test.each<[PoolShot, ScenePose, Moment["gaze"], readonly GazeKind[]]>([
    ["selfie", "front", undefined, ["viewer", "down"]],
    ["selfie", "three-quarter", undefined, ["viewer", "down"]],
    ["mirror", "front", undefined, ["mirror", "down"]],
    ["friend", "front", undefined, ["viewer", "away", "down"]],
    ["photographer", "three-quarter", undefined, ["viewer", "away", "down"]],
    ["friend", "profile", undefined, ["away", "down"]],
    ["candid", "front", undefined, ["away", "down"]],
    ["candid", "profile", undefined, ["away", "down"]],
    ["friend", "front", "focus", ["viewer", "away", "down", "hands"]],
    ["candid", "three-quarter", "focus", ["away", "down", "hands"]],
    ["selfie", "front", "focus", ["viewer", "down"]],
    ["friend", "back", undefined, []],
    ["friend", "front", "own", []],
    ["friend", "front", "viewer", []],
  ])("%s, %s, a moment with gaze %p: %p", (shot, pose, gaze, kinds) => {
    expect([...gazeKindsFor(shot, pose, gaze)].sort()).toEqual([...kinds].sort());
  });

  test("a selfie sentence never names her phone or says selfie; a mirror gaze is the only one that names the phone", () => {
    for (const category of ["home", "travel", "glamour", "fitness"] as const) {
      for (const place of BANKS[category].places) {
        for (const moment of place.moments) {
          for (const key of KEYS.slice(0, 10)) {
            const selfie = templateSentence(slotOf(category, place, moment, "selfie", "front"), { key });
            if (selfie !== null) expect(PHONE_WORDS.test(selfie) || SELFIE_WORDS.test(selfie)).toBe(false);
            const friend = templateSentence(slotOf(category, place, moment, "friend", "front"), { key });
            if (friend !== null && moment.phone !== true) expect(PHONE_WORDS.test(friend)).toBe(false);
          }
        }
      }
    }
  });
});

describe("which moments a slot may take (I5.23, drawn before the text)", () => {
  const base: Moment = { text: "waits for the kettle", twoHanded: false };

  test.each<[string, Moment, PoolShot, ScenePose, boolean]>([
    ["a plain moment on any shot and pose", base, "friend", "back", true],
    ["a plain moment on a selfie", base, "selfie", "front", true],
    ["a two-handed moment on a selfie", { ...base, twoHanded: true }, "selfie", "front", false],
    ["a two-handed moment on a mirror shot", { ...base, twoHanded: true }, "mirror", "three-quarter", false],
    ["a two-handed moment on a friend's snap", { ...base, twoHanded: true }, "friend", "front", true],
    ["a phone moment on a selfie", { ...base, phone: true, gaze: "own" }, "selfie", "front", false],
    ["a phone moment on a mirror shot", { ...base, phone: true, gaze: "own" }, "mirror", "front", false],
    ["a phone moment on a candid", { ...base, phone: true, gaze: "own" }, "candid", "front", true],
    ["a three-quarter moment on a front pose", { ...base, angle: "three-quarter" }, "friend", "front", false],
    ["a three-quarter moment on a three-quarter pose", { ...base, angle: "three-quarter" }, "friend", "three-quarter", true],
    ["a three-quarter moment on a back pose", { ...base, angle: "three-quarter" }, "friend", "back", false],
    ["a back moment on a back pose", { ...base, angle: "back" }, "candid", "back", true],
    ["a viewer moment on a candid", { ...base, gaze: "viewer" }, "candid", "front", false],
    ["a viewer moment on a profile", { ...base, gaze: "viewer" }, "friend", "profile", false],
    ["a viewer moment on a back pose", { ...base, gaze: "viewer" }, "friend", "back", false],
    ["a viewer moment on a friend's front snap", { ...base, gaze: "viewer" }, "friend", "front", true],
    ["any moment on a selfie in profile (never planned)", base, "selfie", "profile", false],
    ["any moment on a mirror shot from behind (never planned)", base, "mirror", "back", false],
    ["a flirty moment on an ordinary slot", { ...base, level: "flirty" }, "friend", "front", false],
    ["a legs moment (5a.2c)", { ...base, legs: { framing: "legs", shots: ["friend"] } }, "friend", "front", false],
    ["a moment limited to a capture that is not drawn yet", { ...base, captures: ["selfie-above"] }, "selfie", "front", false],
    ["a moment limited to the mirror, on a mirror shot", { ...base, captures: ["mirror", "mirror-face-hidden"] }, "mirror", "front", true],
    ["a moment limited to the mirror, on a friend's snap", { ...base, captures: ["mirror", "mirror-face-hidden"] }, "friend", "front", false],
  ])("%s: %p", (_name, moment, shot, pose, allowed) => {
    expect(momentAllowed(moment, shot, pose)).toBe(allowed);
  });

  test("a flirty moment is allowed on a flirty slot", () => {
    expect(momentAllowed({ ...base, level: "flirty" }, "friend", "front", "flirty")).toBe(true);
  });
});

describe("«Подача» (I5.28, 5a.2b): an ordinary slot never draws a flirty item", () => {
  const { place, moment } = find("glamour", nonRoom, plain);
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

describe("null, never a throw (I5.22)", () => {
  const { place, moment } = find("home", room, plain);
  const ok = slotOf("home", place, moment, "friend", "front");

  test("the fixture renders", () => {
    expect(templateSentence(ok, { key: "k" })).not.toBeNull();
  });

  test.each<[string, TemplateSlot]>([
    ["an unknown built-in category", { ...ok, category: "beach" }],
    ["an own scene", { ...ok, category: "own" }],
    ["a place the bank does not have (an old plan's place)", { ...ok, location: "a bathroom with a large vanity mirror" }],
    ["a moment the place does not have (an old plan's gerund activity)", { ...ok, activity: "waiting for the kettle" }],
    ["a moment of another place", { ...ok, activity: "jogs along the path" }],
    ["an outfit the bank does not have", { ...ok, outfit: "a ball gown" }],
    ["no place", { ...ok, location: undefined }],
    ["no moment", { ...ok, activity: undefined }],
    ["no outfit", { ...ok, outfit: undefined }],
    ["a pose the moment cannot take (a three-quarter moment on a front pose)", (() => {
      const shoulder = find("photoshoot", () => true, (m) => m.angle === "three-quarter");
      return slotOf("photoshoot", shoulder.place, shoulder.moment, "photographer", "front");
    })()],
    ["a two-handed moment on a selfie", (() => {
      const two = find("home", () => true, (m) => m.twoHanded);
      return slotOf("home", two.place, two.moment, "selfie", "front");
    })()],
    ["a custom category without its snapshot", { ...ok, category: "cat-abcdefgh" }],
  ])("%s gives null", (_name, slot) => {
    expect(templateSentence(slot, { key: "k" })).toBeNull();
  });
});

describe("no two equal sentences in a run (I5.24 dedup)", () => {
  const { place, moment } = find("glamour", nonRoom, plain);
  const slot = slotOf("glamour", place, moment, "friend", "front");

  test("an equal sentence is redrawn on the dedup streams", () => {
    const first = templateSentence(slot, { key: "run-1:slot-1" }) ?? "";
    const second = templateSentence(slot, { key: "run-1:slot-1", seen: new Set([first]) });
    expect(second).not.toBeNull();
    expect(second).not.toBe(first);
    expect(templateSentence(slot, { key: "run-1:slot-1", seen: new Set([first]) })).toBe(second);
  });

  test("a sentence with nothing left to redraw keeps its first text (the moment-repeat metric flags it)", () => {
    const bare = find("home", room, plain);
    const backSlot = slotOf("home", bare.place, bare.moment, "candid", "back");
    const only = templateSentence(backSlot, { key: "k" }) ?? "";
    expect(templateSentence(backSlot, { key: "k", seen: new Set([only]) })).toBe(only);
  });

  test("when all 8 redraws are taken too, the slot keeps its first text", () => {
    const variants = new Set<string>();
    for (let i = 0; i <= 8; i++) {
      const sentence = templateSentence(slot, { key: i === 0 ? "run-9:slot-2" : `run-9:slot-2:dedup:${i}` });
      if (sentence !== null) variants.add(sentence);
    }
    const first = templateSentence(slot, { key: "run-9:slot-2" });
    expect(templateSentence(slot, { key: "run-9:slot-2", seen: variants })).toBe(first);
  });
});
