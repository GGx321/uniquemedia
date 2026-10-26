import { describe, expect, test } from "bun:test";
import type { ScenePose } from "../engine";
import { CUES, GAZE } from "./banks";
import type { Capture } from "./captures";
import { covers, customActivityAllowed, customMomentOf, isWaterPlaceName, locativeOf, rendersActivity, waterHeadNoun, type CustomPool } from "./custom";
import { templateSentence, type TemplateSlot } from "./template";

// 5a.2 (S5.6a, plan s5a2 §5.2 step 2, K-7): today's custom pools render through a small adapter: «{At}, she is {activity}, wearing {outfit}, {gaze},
// {cue}.» with no detail and no room phrase. The slot's own stored texts are rendered, and only for a custom category the plan or the set holds a
// snapshot of (a snapshot carries no pool, so the stored slot is the source). An activity that does not read after «she is» goes to the LLM.

describe("rendersActivity: what reads after «she is»", () => {
  test.each<[string, boolean]>([
    ["holding a mug", true],
    ["on her stomach, scrolling", true],
    ["On her balcony, watering plants", true],
    ["lying on the bed", true],
    ["sitting by the window", true],
    ["a quiet moment", false],
    ["morning stretches", false],
    ["evening walk by the river", false],
    ["something to eat", false],
    ["ceiling fan spinning", false],
    ["bring snacks", false],
    ["swing on the porch", false],
    ["coffee in bed", false],
    ["", false],
  ])("%p → %p", (activity, renders) => {
    expect(rendersActivity(activity)).toBe(renders);
  });
});

describe("locativeOf: the place as a locative phrase", () => {
  test.each<[string, string]>([
    ["in a quiet cafe", "in a quiet cafe"],
    ["at the bus stop", "at the bus stop"],
    ["by the lake", "by the lake"],
    ["a quiet bookshop", "in a quiet bookshop"],
    ["the beach", "on the beach"],
    ["a bench in the park", "on a bench in the park"],
    ["a cafe terrace", "on a cafe terrace"],
    ["a beach bar", "at a beach bar"],
    ["the gym", "at the gym"],
    ["a cozy living room", "in a cozy living room"],
    ["the city park", "in the city park"],
    ["a mountain trail", "on a mountain trail"],
    ["her balcony at sunset", "on her balcony at sunset"],
    ["Train station", "at Train station"],
  ])("%p → %p", (name, at) => {
    expect(locativeOf(name)).toBe(at);
  });
});

describe("customMomentOf: the tags an old activity is read with", () => {
  test("an activity that looks at the camera, the viewer, the lens or the phone is a viewer moment: no gaze clause, and never on a candid, a profile or a back", () => {
    expect(customMomentOf({ text: "smiling at the camera", twoHanded: false }).gaze).toBe("viewer");
    expect(customMomentOf({ text: "looking into the lens", twoHanded: false }).gaze).toBe("viewer");
  });

  // Review M2: an activity whose eyes are already busy (watching a tablet, looking out of the window) owns its gaze, so no gaze clause contradicts it.
  test.each(["watching a tablet", "looking out of the window", "gazing at the sea", "staring at the rain", "glancing at her watch", "peeking through the curtains", "reading a menu"])(
    "«%s» carries its own gaze",
    (text) => {
      expect(customMomentOf({ text, twoHanded: false }).gaze).toBe("own");
    },
  );

  test("an activity without a look keeps no gaze tag («starting a run» is not «staring»)", () => {
    expect(customMomentOf({ text: "starting a run", twoHanded: false }).gaze).toBeUndefined();
  });

  test("an activity that names her phone carries its own gaze and the phone flag", () => {
    expect(customMomentOf({ text: "scrolling her phone", twoHanded: false })).toMatchObject({ phone: true, gaze: "own" });
  });

  test("an activity that names her hair carries its own hair (no hair line)", () => {
    expect(customMomentOf({ text: "brushing her hair", twoHanded: false }).hair).toBe("own");
  });

  test("a plain activity carries no tags but its hands", () => {
    expect(customMomentOf({ text: "holding a mug", twoHanded: true })).toEqual({ text: "holding a mug", twoHanded: true });
  });
});

describe("customActivityAllowed (I5.23 for custom: by the regex)", () => {
  const plain = { text: "holding a mug", twoHanded: false };
  test.each<[string, { text: string; twoHanded: boolean }, Capture, ScenePose, boolean]>([
    ["a plain activity on a selfie", plain, "selfie", "front", true],
    ["a plain activity from behind", plain, "friend", "back", true],
    ["a two-handed activity on a selfie", { text: "holding a mug", twoHanded: true }, "selfie", "front", false],
    ["a phone activity on a mirror shot", { text: "texting on her phone", twoHanded: false }, "mirror", "front", false],
    ["a selfie activity on a selfie", { text: "taking a selfie", twoHanded: false }, "selfie", "three-quarter", false],
    ["«smiling at the camera» from behind", { text: "smiling at the camera", twoHanded: false }, "friend", "back", false],
    ["«smiling at the camera» in profile", { text: "smiling at the camera", twoHanded: false }, "friend", "profile", false],
    ["«looking at the viewer» on a candid", { text: "looking at the viewer", twoHanded: false }, "candid", "front", false],
    ["«smiling at the camera» on a friend's front snap", { text: "smiling at the camera", twoHanded: false }, "friend", "front", true],
  ])("%s: %p", (_name, activity, shot, pose, allowed) => {
    expect(customActivityAllowed(activity, shot, pose)).toBe(allowed);
  });
});

describe("a custom slot's sentence", () => {
  const REF = "cat-cozyhome1";
  const slot: TemplateSlot = { category: REF, location: "a quiet bookshop", activity: "browsing the shelves", outfit: "a cozy cardigan", shot: "friend", pose: "front" };
  const ctx = { key: "run-1:slot-3", snapshots: [{ ref: REF }] };
  const esc = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const anyOf = (texts: readonly string[]): string => `(${texts.map(esc).join("|")})`;

  test("is «{At}, she is {activity}, wearing {outfit}, {gaze}, {cue}.»: no detail, no room phrase", () => {
    for (let i = 0; i < 30; i++) {
      expect(templateSentence(slot, { ...ctx, key: `run-${i}:slot-1` })).toMatch(
        new RegExp(`^In a quiet bookshop, she is browsing the shelves, wearing a cozy cardigan, ${anyOf(GAZE.map((g) => g.text))}, ${anyOf(CUES.map((c) => c.text))}\\.$`),
      );
    }
  });

  test("from behind it is the bare sentence", () => {
    expect(templateSentence({ ...slot, pose: "back" }, ctx)).toBe("In a quiet bookshop, she is browsing the shelves, wearing a cozy cardigan.");
  });

  test("an activity that looks at the camera keeps its own gaze: no gaze clause", () => {
    const sentence = templateSentence({ ...slot, activity: "looking at the camera" }, ctx) ?? "";
    expect(sentence.startsWith("In a quiet bookshop, she is looking at the camera, wearing a cozy cardigan, ")).toBe(true);
    for (const gaze of GAZE) expect(sentence).not.toContain(gaze.text);
  });

  test("«watching a tablet» never gets «looking at the viewer» (no gaze clause at all)", () => {
    for (let i = 0; i < 40; i++) {
      const sentence = templateSentence({ ...slot, activity: "watching a tablet" }, { ...ctx, key: `run-${i}:slot-2` }) ?? "";
      expect(sentence.startsWith("In a quiet bookshop, she is watching a tablet, wearing a cozy cardigan, ")).toBe(true);
      for (const gaze of GAZE) expect(sentence).not.toContain(gaze.text);
    }
  });

  test("an activity with its own expression («smiling at the camera») gets no cue", () => {
    for (let i = 0; i < 20; i++) {
      const sentence = templateSentence({ ...slot, activity: "smiling at the camera" }, { ...ctx, key: `run-${i}:slot-4` }) ?? "";
      expect(sentence).toBe("In a quiet bookshop, she is smiling at the camera, wearing a cozy cardigan.");
    }
  });

  test("a stored text's trailing full stop is dropped, so the template's separators are the only ones", () => {
    expect(templateSentence({ ...slot, pose: "back", activity: "browsing the shelves.", outfit: "a cozy cardigan." }, ctx)).toBe("In a quiet bookshop, she is browsing the shelves, wearing a cozy cardigan.");
  });

  test.each<[string, TemplateSlot, typeof ctx | { key: string }]>([
    ["a category the plan holds no snapshot of", slot, { key: "k" }],
    ["another category's snapshot", slot, { key: "k", snapshots: [{ ref: "cat-otherone1" }] }],
    ["an activity that does not read after «she is»", { ...slot, activity: "a quiet moment" }, ctx],
    ["a viewer activity from behind", { ...slot, activity: "smiling at the camera", pose: "back" }, ctx],
    ["a selfie at a place that names a phone", { ...slot, location: "a phone repair shop", shot: "selfie" }, ctx],
    ["a selfie in an outfit that says selfie", { ...slot, outfit: "a selfie t-shirt", shot: "selfie" }, ctx],
    ["no activity", { ...slot, activity: undefined }, ctx],
    ["no place", { ...slot, location: undefined }, ctx],
    ["no outfit", { ...slot, outfit: undefined }, ctx],
  ])("%s gives null", (_name, s, c) => {
    expect(templateSentence(s, c)).toBeNull();
  });

  test("a flirty custom slot draws a flirty cue, an ordinary one never", () => {
    const flirtyCues = CUES.filter((c) => c.level === "flirty").map((c) => c.text);
    expect(flirtyCues.some((c) => (templateSentence(slot, { ...ctx, level: "flirty" }) ?? "").includes(c))).toBe(true);
    expect(flirtyCues.some((c) => (templateSentence(slot, ctx) ?? "").includes(c))).toBe(false);
  });
});

describe("covers: the template renders every slot the planner can draw from the pool", () => {
  const POOL: CustomPool = {
    locations: [
      { name: "a quiet bookshop", mirror: false, activities: [{ text: "browsing the shelves", twoHanded: false }, { text: "carrying a stack of novels", twoHanded: true }] },
      { name: "her bedroom", mirror: true, activities: [{ text: "sitting on the bed", twoHanded: false }, { text: "scrolling her phone", twoHanded: false }] },
    ],
    outfits: ["a cozy cardigan", "jeans and a tee"],
    shotDeck: ["friend", "selfie", "mirror", "candid", "friend"],
  };

  test("a pool whose every activity reads after «she is» is covered", () => {
    expect(covers(POOL)).toBe(true);
  });

  test("one activity that does not render uncovers the pool", () => {
    const pool: CustomPool = { ...POOL, locations: [...POOL.locations, { name: "the park", mirror: false, activities: [{ text: "picnic time", twoHanded: false }, { text: "walking", twoHanded: false }] }] };
    expect(covers(pool)).toBe(false);
  });

  test("a selfie at a place that names a phone uncovers the pool; without a selfie in the deck it does not", () => {
    const shop = { name: "a phone repair shop", mirror: false, activities: [{ text: "waiting at the counter", twoHanded: false }, { text: "holding a coffee", twoHanded: false }] };
    expect(covers({ ...POOL, locations: [...POOL.locations, shop] })).toBe(false);
    expect(covers({ ...POOL, shotDeck: ["friend", "friend", "candid", "candid", "photographer"], locations: [...POOL.locations, shop] })).toBe(true);
  });

  test("an activity the planner never draws does not uncover the pool (a two-handed one in a selfie-only deck)", () => {
    const pool: CustomPool = {
      locations: [{ name: "her bedroom", mirror: false, activities: [{ text: "sitting on the bed", twoHanded: false }, { text: "the big clean-up", twoHanded: true }] }],
      outfits: ["a cozy cardigan"],
      shotDeck: ["selfie", "selfie", "selfie", "selfie", "selfie"],
    };
    expect(covers(pool)).toBe(true);
    expect(covers({ ...pool, shotDeck: ["selfie", "selfie", "selfie", "selfie", "friend"] })).toBe(false);
  });

  // S5.6R: the real planner has no pose fallback. It draws the activity without asking the pose, so a viewer-gaze activity on a back slot is a null slot
  // (engine/runs/covers.planner.property.test.ts checks this against the planner itself); the pool is priced with a writer, not counted free.
  test("a pool limited to the back view, where a place's only activities look at the camera, is not covered: the planner draws them on a back slot", () => {
    const pool: CustomPool = {
      locations: [{ name: "a studio corner", mirror: false, activities: [{ text: "smiling at the camera", twoHanded: false }, { text: "looking at the viewer", twoHanded: false }] }],
      outfits: ["a cozy cardigan"],
      shotDeck: ["friend", "friend", "friend", "friend", "friend"],
      poses: ["back"],
    };
    expect(covers(pool)).toBe(false);
  });

  test("a pool limited to the back view is covered when every activity of every place reads from behind", () => {
    const pool: CustomPool = {
      locations: [{ name: "a studio corner", mirror: false, activities: [{ text: "holding a mug", twoHanded: false }, { text: "browsing the shelves", twoHanded: false }] }],
      outfits: ["a cozy cardigan"],
      shotDeck: ["friend", "friend", "friend", "friend", "friend"],
      poses: ["back"],
    };
    expect(covers(pool)).toBe(true);
  });

  test("one viewer-gaze activity among others uncovers a pool that can draw a profile slot", () => {
    const pool: CustomPool = {
      locations: [{ name: "the beach", mirror: false, activities: [{ text: "browsing the shelves", twoHanded: false }, { text: "smiling at the camera", twoHanded: false }] }],
      outfits: ["a cozy cardigan"],
      shotDeck: ["friend", "friend", "friend", "friend", "friend"],
      poses: ["profile"],
    };
    expect(covers(pool)).toBe(false);
  });

  test("a hand-held shot with no clean place becomes a friend's snap the deck does not hold, so that activity must read on a friend", () => {
    const pool: CustomPool = {
      locations: [{ name: "a studio corner", mirror: false, activities: [{ text: "scrolling her phone", twoHanded: false }, { text: "smiling at the camera", twoHanded: false }] }],
      outfits: ["a cozy cardigan"],
      shotDeck: ["selfie", "selfie", "selfie", "selfie", "selfie"],
      poses: ["profile"],
    };
    expect(covers(pool)).toBe(false);
  });
});

// S5.6R: «Другая сцена — бесплатно» hands the template the scene's own old text as `seen`. A custom slot whose frame shows no face (from behind) has no gaze or cue to
// redraw, so every dedup redraw used to equal the first text and the slot kept it: the «new» scene read exactly as the old one.
describe("a redraw of a slot with nothing to vary still reads differently from the text it replaces", () => {
  const REF = "cat-redraw-fixture";
  const BACK: TemplateSlot = { category: REF, location: "a quiet bookshop", activity: "browsing the shelves", outfit: "a cozy cardigan", shot: "friend", pose: "back" };
  const ctx = (key: string, seen?: ReadonlySet<string>, distinct = true) => ({ key, snapshots: [{ ref: REF }], distinct, ...(seen === undefined ? {} : { seen }) });

  test("the text of a slot seen from behind is the same on every draw key: nothing in it varies", () => {
    const texts = new Set(Array.from({ length: 12 }, (_, i) => templateSentence(BACK, ctx(`set-1:3:${i}`))));
    expect(texts.size).toBe(1);
  });

  test("with its own old text held, the slot is rewritten into another sentence, not into the same one", () => {
    const old = templateSentence(BACK, ctx("set-1:3:1"));
    expect(old).not.toBeNull();
    const again = templateSentence(BACK, ctx("set-1:3:2", new Set([old ?? ""])));
    expect(again).not.toBeNull();
    expect(again).not.toBe(old);
  });

  test("the other sentence still says the same place, activity and outfit", () => {
    const old = templateSentence(BACK, ctx("set-1:3:1")) ?? "";
    const again = templateSentence(BACK, ctx("set-1:3:2", new Set([old]))) ?? "";
    expect(again).toContain("quiet bookshop");
    expect(again).toContain("browsing the shelves");
    expect(again).toContain("a cozy cardigan");
  });

  test("a run's own dedup, which does not ask for a distinct text, still keeps the first text of a slot with nothing left to redraw", () => {
    const old = templateSentence(BACK, ctx("set-1:3:1", undefined, false));
    expect(templateSentence(BACK, ctx("set-1:3:1", new Set([old ?? ""]), false))).toBe(old);
  });

  test("a held text that is not this slot's leaves the first draw as it was", () => {
    const first = templateSentence(BACK, ctx("set-1:3:1"));
    expect(templateSentence(BACK, ctx("set-1:3:1", new Set(["Another scene entirely."])))).toBe(first);
  });

  test("the slot can be redrawn again and again: each rewrite differs from the text held before it", () => {
    const held = new Set<string>();
    let last = "";
    for (let k = 1; k <= 3; k++) {
      const text = templateSentence(BACK, ctx(`set-1:3:${k}`, held)) ?? "";
      expect(text).not.toBe(last);
      held.add(text);
      last = text;
    }
  });
});

// 5a.4 (S5.BA3, plan s5a4 §5.3.2, M8, r2.2 P7, P10): a custom place is a water place when its HEAD NOUN is in a pinned list, never when a water word merely appears in its name.
describe("waterHeadNoun and isWaterPlaceName (M8, P7, P10)", () => {
  test.each<[string, string]>([
    ["a hotel pool", "pool"],
    ["an infinity pool at the villa", "pool"],
    ["the shore of the lake", "shore"],
    ["the sundeck of a sailing yacht", "sundeck"],
    ["a yacht at anchor in a bay", "yacht"],
    ["a cabin below deck", "cabin"],
    ["a kitchen island", "island"],
    ["a pool table", "table"],
    ["a cafe with a sea view", "cafe"],
    ["a surf shop", "shop"],
    ["a beach bar", "bar"],
    ["a marina at sunset", "marina"],
    ["a terrace overlooking the sea", "terrace"],
    ["a room facing the ocean", "room"],
    ["a bench beneath the pier", "bench"],
    ["a villa above the lagoon", "villa"],
    ["a hut beyond the dunes", "hut"],
    ["Poolside.", "poolside"],
  ])("the head noun of «%s» is %s", (name, head) => {
    expect(waterHeadNoun(name)).toBe(head);
  });

  test.each(["a hotel pool", "an infinity pool at the villa", "the shore of the lake", "the sundeck of a sailing yacht", "a yacht at anchor in a bay", "a quiet beach", "poolside", "a lagoon at dawn", "the ocean"].map((n) => [n]))(
    "«%s» is a water place",
    (name) => {
      expect(isWaterPlaceName(name)).toBe(true);
    },
  );

  test.each(["a kitchen island", "a pool table", "a cafe with a sea view", "a surf shop", "a beach bar", "a cabin below deck", "a marina at sunset", "a river bank", "a pier", "the deck of a ship", "a bedroom", "a seaside walk", "a sea cave by the sea"].map((n) => [n]))(
    "«%s» is not a water place",
    (name) => {
      expect(isWaterPlaceName(name)).toBe(false);
    },
  );

  test("the words «below», «above», «beneath», «beyond», «overlooking» and «facing» end the head noun only for the water parse: locativeOf keeps today's output", () => {
    expect(locativeOf("a cabin below deck")).toBe("on a cabin below deck");
    expect(locativeOf("a terrace overlooking the sea")).toBe("in a terrace overlooking the sea");
    expect(locativeOf("a villa above the lagoon")).toBe("in a villa above the lagoon");
  });
});
