import { describe, expect, test } from "bun:test";
import { CATEGORY_LABEL_MAX, CategoryPool, POOL_SHOTS, POOL_TEXT_MAX, POOL_TIMES, ScenePose } from "../../shared/engine";
import { PriceBook } from "../money/prices";
import { chatAttemptWorstMicros, promptTokenFloor } from "../openrouter/chat";
import { PoolSchema } from "./pools";
import {
  POOL_EXAMPLE_ANSWER,
  POOL_JSON_SCHEMA,
  POOL_MAX_ATTEMPTS,
  POOL_TOLD_WORDS_MAX,
  POOL_TOLD_WORD_BYTES_MAX,
  poolCall,
  poolMessages,
  poolOf,
  readPoolAnswer,
  styleOfDeck,
  type PoolProblem,
  type PoolRefusal,
} from "./poolGen";
import { SHOTS } from "./types";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.2: the pool call's answer, read like the descriptor's: salvage what is sound, refuse with fixed reasons otherwise,
// and never keep an item the pool schema (as built, plus the contract's technical bounds) would refuse.

type Json = Record<string, unknown>;

function place(name: string, over: Json = {}): Json {
  return {
    name,
    times: ["morning", "midday"],
    activities: [
      { text: "reading a menu", twoHanded: false },
      { text: "stirring a cappuccino", twoHanded: true },
    ],
    mirror: false,
    ...over,
  };
}

const PLACES = ["a corner cafe", "a flower stall", "a bookshop", "a riverside bench", "a bakery counter"];
const OUTFITS = ["a beige trench coat and jeans", "a striped tee and a beret", "a black midi dress"];

function answer(over: Json = {}): Json {
  return {
    label: "Paris cafes",
    locations: PLACES.map((name, i) => place(name, { mirror: i === 2 })),
    outfits: [...OUTFITS],
    shotDeck: ["friend", "friend", "selfie", "mirror", "candid"],
    ...over,
  };
}

function read(value: unknown) {
  return readPoolAnswer(typeof value === "string" ? value : JSON.stringify(value));
}

function refusalOf(value: unknown): PoolRefusal {
  const result = read(value);
  if (result.ok) throw new Error("expected a refusal");
  return { problems: result.problems, words: result.words };
}

function okOf(value: unknown) {
  const result = read(value);
  if (!result.ok) throw new Error(`expected a pool, got ${result.problems.join(", ")}`);
  return result;
}

describe("readPoolAnswer: a sound answer", () => {
  test("becomes the label, the style and the pool, with nothing dropped", () => {
    const result = okOf(answer());
    expect(result.label).toBe("Paris cafes");
    expect(result.style).toBe("phone");
    expect(result.dropped).toBe(0);
    expect(result.pool.locations.map((l) => l.name)).toEqual(PLACES);
    expect(result.pool.outfits).toEqual(OUTFITS);
    expect(result.pool.shotDeck).toEqual(["friend", "friend", "selfie", "mirror", "candid"]);
  });

  test("is read through a markdown fence around the JSON", () => {
    expect(okOf(`\`\`\`json\n${JSON.stringify(answer())}\n\`\`\``).label).toBe("Paris cafes");
  });

  test("passes the contract's pool and the engine's own pool schema, as built", () => {
    const result = okOf(answer());
    expect(CategoryPool.safeParse(result.pool).success).toBe(true);
    expect(PoolSchema.safeParse(poolOf(result.pool)).success).toBe(true);
  });

  test("is always a phone photo, whatever the deck holds (S5.1b: a new pool is never editorial)", () => {
    const studio = okOf(answer({ shotDeck: ["photographer", "photographer", "photographer", "candid", "candid"] }));
    expect(studio.style).toBe("phone");
    const mostly = okOf(answer({ shotDeck: ["photographer", "photographer", "friend", "candid", "candid"] }));
    expect(mostly.style).toBe("phone");
  });

  test("the style rule is the deck's alone", () => {
    expect(styleOfDeck(["photographer", "photographer", "photographer", "friend", "friend"])).toBe("phone");
    expect(styleOfDeck(["photographer", "photographer", "friend", "friend", "friend"])).toBe("phone");
    expect(styleOfDeck(["friend", "friend", "friend", "friend", "friend"])).toBe("phone");
  });
});

describe("readPoolAnswer: an answer that is not a pool", () => {
  test("not JSON at all", () => {
    expect(refusalOf("here is your pool: cafes")).toEqual({ problems: ["not-json"], words: [] });
  });

  test("JSON of another shape", () => {
    expect(refusalOf({ pool: "cafes" })).toEqual({ problems: ["not-json"], words: [] });
    expect(refusalOf([1, 2, 3])).toEqual({ problems: ["not-json"], words: [] });
  });

  test("an empty or blank text", () => {
    expect(refusalOf("")).toEqual({ problems: ["empty"], words: [] });
    expect(refusalOf("  \n ")).toEqual({ problems: ["empty"], words: [] });
  });
});

describe("readPoolAnswer: salvage drops the items that break the pool rules and keeps the rest", () => {
  test("an outfit with a revealing word is dropped, and the refusal-free pool keeps the others", () => {
    const result = okOf(answer({ outfits: [...OUTFITS, "a red bikini"] }));
    expect(result.pool.outfits).toEqual(OUTFITS);
    expect(result.dropped).toBe(1);
  });

  test("a place whose name suggests a young person is dropped", () => {
    const result = okOf(answer({ locations: [...(answer().locations as Json[]), place("a school courtyard")] }));
    expect(result.pool.locations.map((l) => l.name)).toEqual(PLACES);
    expect(result.dropped).toBe(1);
  });

  test("an activity that suggests a young person is dropped from its place; the place stays", () => {
    const locations = (answer().locations as Json[]).map((l, i) =>
      i === 0 ? { ...l, activities: [...(l.activities as Json[]), { text: "playing like a girl", twoHanded: false }] } : l,
    );
    const result = okOf(answer({ locations }));
    expect(result.pool.locations[0]?.activities.map((a) => a.text)).toEqual(["reading a menu", "stirring a cappuccino"]);
    expect(result.dropped).toBe(1);
  });

  test.each([
    ["a text over 35 chars", "a".repeat(POOL_TEXT_MAX + 1)],
    ["a text with a quote", 'a "quiet" corner'],
    ["a text with a backslash", "a back\\slash corner"],
    ["a non-ASCII text", "a café corner"],
    ["a text with an edge space", " a corner"],
    ["a text of a Cyrillic place", "кофейня на углу"],
  ])("an outfit that is %s is dropped", (_name, text) => {
    const result = okOf(answer({ outfits: [...OUTFITS, text] }));
    expect(result.pool.outfits).toEqual(OUTFITS);
    expect(result.dropped).toBe(1);
  });

  test.each([
    ["a name over 35 chars", { name: "a".repeat(POOL_TEXT_MAX + 1) }],
    ["a name with a quote", { name: 'a "quiet" cafe' }],
    ["a name with a backslash", { name: "a back\\slash cafe" }],
    ["a non-ASCII name", { name: "a café" }],
    ["a time over 15 chars", { times: ["a very long time of day"] }],
    ["no usable time", { times: [] }],
    ["one activity", { activities: [{ text: "reading a menu", twoHanded: false }] }],
    ["only two-handed activities", { activities: [{ text: "kneading dough", twoHanded: true }, { text: "peeling apples", twoHanded: true }] }],
  ])("a place with %s is dropped", (_name, over) => {
    const result = okOf(answer({ locations: [...(answer().locations as Json[]), place("a sixth place", over)] }));
    expect(result.pool.locations.map((l) => l.name)).toEqual(PLACES);
    expect(result.dropped).toBe(1);
  });

  test("a time that is too long is dropped from its place; the place keeps its other time", () => {
    const locations = (answer().locations as Json[]).map((l, i) => (i === 0 ? { ...l, times: ["morning", "a very long time of day"] } : l));
    const result = okOf(answer({ locations }));
    expect(result.pool.locations[0]?.times).toEqual(["morning"]);
  });

  test.each(["dawn", "after school", "teen hangout"])("a time of day outside the vocabulary («%s») is dropped from its place; the place keeps its other time", (time) => {
    const locations = (answer().locations as Json[]).map((l, i) => (i === 0 ? { ...l, times: ["morning", time] } : l));
    const result = okOf(answer({ locations }));
    expect(result.pool.locations[0]?.times).toEqual(["morning"]);
    expect(result.dropped).toBe(1);
  });

  test("a place whose only time is outside the vocabulary follows the below-minimum rule: dropped, and the pool is refused when too few places are left", () => {
    const locations = (answer().locations as Json[]).map((l, i) => (i === 0 ? { ...l, times: ["after school"] } : l));
    expect(refusalOf(answer({ locations })).problems).toContain("too-few-places");
  });

  test("an activity marked one-handed that says «both hands» comes out two-handed", () => {
    const locations = (answer().locations as Json[]).map((l, i) =>
      i === 0 ? { ...l, activities: [{ text: "reading a menu", twoHanded: false }, { text: "whisking with both hands", twoHanded: false }] } : l,
    );
    const result = okOf(answer({ locations }));
    expect(result.pool.locations[0]?.activities).toEqual([
      { text: "reading a menu", twoHanded: false },
      { text: "whisking with both hands", twoHanded: true },
    ]);
  });

  test("a place whose only one-handed activity is really a two-handed one is dropped", () => {
    const bad = place("a sixth place", { activities: [{ text: "carrying a tray with both hands", twoHanded: false }, { text: "kneading dough", twoHanded: true }] });
    const result = okOf(answer({ locations: [...(answer().locations as Json[]), bad] }));
    expect(result.pool.locations.map((l) => l.name)).toEqual(PLACES);
  });

  // S5.R1 H1: a place is dropped at generation when its name says mirror, in any case (a stored pool of the owner's is never refused for it: the library reads what it holds).
  test.each(["a bedroom with a tall mirror", "her bathroom Mirror", "mirrors in the hallway"])("a place named «%s» is dropped, and the pool stands on the others", (name) => {
    const named = place(name, { mirror: true });
    const result = okOf(answer({ locations: [...(answer().locations as Json[]), named] }));
    expect(result.pool.locations.map((l) => l.name)).toEqual(PLACES);
    expect(result.dropped).toBe(1);
  });

  test("a mirror place that does not name a mirror is kept with its mark", () => {
    const result = okOf(answer({ locations: [...(answer().locations as Json[]), place("a bedroom", { mirror: true })] }));
    expect(result.pool.locations.find((l) => l.name === "a bedroom")?.mirror).toBe(true);
  });

  test("a pool whose only mirror place names a mirror is refused as mirror-without-place when the deck has a mirror shot", () => {
    const locations = PLACES.map((name, i) => place(i === 2 ? "a hallway mirror" : name, { mirror: i === 2 }));
    expect(refusalOf(answer({ locations: [...locations, place("a sixth place")] })).problems).toContain("mirror-without-place");
  });

  // S5.R1 M1: a selfie or mirror shot needs a free hand that does not hold her phone, so a place needs one such activity; the phone ones are found by their words.
  test("a place whose only free-hand activities use her phone is dropped", () => {
    const phoneOnly = place("a sixth place", { activities: [{ text: "scrolling her phone", twoHanded: false }, { text: "kneading dough", twoHanded: true }] });
    const result = okOf(answer({ locations: [...(answer().locations as Json[]), phoneOnly] }));
    expect(result.pool.locations.map((l) => l.name)).toEqual(PLACES);
  });

  test.each(["texting a friend", "taking a selfie with her smartphone", "FaceTime with her mother", "checking her iPhone"])("a free-hand activity that says «%s» does not count as free-hand", (text) => {
    const bad = place("a sixth place", { activities: [{ text, twoHanded: false }, { text: "kneading dough", twoHanded: true }] });
    expect(okOf(answer({ locations: [...(answer().locations as Json[]), bad] })).pool.locations.map((l) => l.name)).toEqual(PLACES);
  });

  // C1: the word «selfie» draws a phone, so an activity that says it (or «front camera») is no free-hand activity for a selfie slot either.
  test.each(["taking a selfie", "posing for selfies", "looking into the front-facing camera"])("a free-hand activity that says «%s» does not count as free-hand", (text) => {
    const bad = place("a sixth place", { activities: [{ text, twoHanded: false }, { text: "kneading dough", twoHanded: true }] });
    expect(okOf(answer({ locations: [...(answer().locations as Json[]), bad] })).pool.locations.map((l) => l.name)).toEqual(PLACES);
  });

  test("a place with a phone activity and a free-hand one that does not use it stays, both activities kept", () => {
    const mixed = place("a sixth place", { activities: [{ text: "scrolling her phone", twoHanded: false }, { text: "sipping a cup of tea", twoHanded: false }] });
    const result = okOf(answer({ locations: [...(answer().locations as Json[]), mixed] }));
    expect(result.pool.locations.find((l) => l.name === "a sixth place")?.activities).toHaveLength(2);
  });

  test("a pool whose five places are all phone-only is refused as too-few-places", () => {
    const phoneOnly = (name: string): Json => place(name, { activities: [{ text: "scrolling her phone", twoHanded: false }, { text: "kneading dough", twoHanded: true }] });
    expect(refusalOf(answer({ locations: PLACES.map((name, i) => ({ ...phoneOnly(name), mirror: i === 2 })) })).problems).toContain("too-few-places");
  });

  test("a repeated place, outfit, time or activity (in any letter case) is kept once", () => {
    const locations = [...(answer().locations as Json[]), place("A CORNER CAFE")];
    const result = okOf(answer({ locations, outfits: [...OUTFITS, "A BEIGE TRENCH COAT AND JEANS"] }));
    expect(result.pool.locations).toHaveLength(5);
    expect(result.pool.outfits).toEqual(OUTFITS);
    const twice = place("a sixth place", { times: ["morning", "Morning"], activities: [{ text: "reading", twoHanded: false }, { text: "Reading", twoHanded: false }, { text: "waving", twoHanded: false }] });
    const again = okOf(answer({ locations: [...(answer().locations as Json[]), twice] }));
    expect(again.pool.locations[5]?.times).toEqual(["morning"]);
    expect(again.pool.locations[5]?.activities.map((a) => a.text)).toEqual(["reading", "waving"]);
  });

  test("items past the pool's largest size are ignored", () => {
    const locations = Array.from({ length: 9 }, (_, i) => place(`place number ${i}`, { mirror: i === 0, times: ["morning", "midday", "evening", "night"], activities: Array.from({ length: 6 }, (_, k) => ({ text: `activity ${k}`, twoHanded: false })) }));
    const outfits = Array.from({ length: 9 }, (_, i) => `outfit number ${i}`);
    const result = okOf(answer({ locations, outfits }));
    expect(result.pool.locations).toHaveLength(7);
    expect(result.pool.outfits).toHaveLength(6);
    expect(result.pool.locations[0]?.times).toHaveLength(3);
    expect(result.pool.locations[0]?.activities).toHaveLength(4);
    expect(CategoryPool.safeParse(result.pool).success).toBe(true);
  });
});

describe("readPoolAnswer: what is left is too little", () => {
  test("too few places once the bad ones are dropped, naming our own words for the rule they broke", () => {
    const locations = (answer().locations as Json[]).map((l, i) => (i < 2 ? { ...l, name: "a school courtyard" } : l));
    const refusal = refusalOf(answer({ locations }));
    expect(refusal.problems).toEqual(["too-few-places"]);
    expect(refusal.words).toContain("school");
  });

  test("too few outfits, naming the revealing word that cost them", () => {
    const refusal = refusalOf(answer({ outfits: ["a red bikini", "black lingerie", "a Bikini top", "a beret"] }));
    expect(refusal.problems).toEqual(["too-few-outfits"]);
    expect(refusal.words).toEqual(["bikini", "lingerie"]);
  });

  test("a refusal's words are ours: the model's rejected text is never among them", () => {
    const hostile = "a corner SECRET-MARKER-123 with a quote \" and a very very very long tail past the bound";
    const refusal = refusalOf(answer({ outfits: [hostile, "b", hostile.toUpperCase()] }));
    expect(refusal.problems).toEqual(["too-few-outfits"]);
    expect(JSON.stringify(refusal).toLowerCase()).not.toContain("secret-marker");
    const messages = poolMessages("кофейни", refusal);
    expect(messages.map((m) => m.content).join("\n").toLowerCase()).not.toContain("secret-marker");
  });

  test("words told back are bounded: at most six, each within the byte bound", () => {
    const words = ["bikini", "swimsuit", "swimwear", "lingerie", "sports bra", "thong", "stockings", "slip dress", "robe over lingerie"];
    const refusal = refusalOf(answer({ outfits: words.map((w) => `a ${w}`) }));
    expect(refusal.problems).toEqual(["too-few-outfits"]);
    expect(refusal.words.length).toBeLessThanOrEqual(POOL_TOLD_WORDS_MAX);
    for (const word of refusal.words) expect(Buffer.byteLength(word, "utf8")).toBeLessThanOrEqual(POOL_TOLD_WORD_BYTES_MAX);
  });

  test("the bound itself is six words of 32 bytes", () => {
    expect(POOL_TOLD_WORDS_MAX).toBe(6);
    expect(POOL_TOLD_WORD_BYTES_MAX).toBe(32);
  });
});

describe("readPoolAnswer: the label and the deck cannot be salvaged", () => {
  test.each([
    ["no label", { label: undefined }],
    ["an empty label", { label: "" }],
    ["a label over 24 chars", { label: "l".repeat(CATEGORY_LABEL_MAX + 1) }],
    ["a label with a quote", { label: 'Paris "cafes"' }],
    ["a non-ASCII label", { label: "Кофейни" }],
  ])("%s is refused as bad-label", (_name, over) => {
    expect(refusalOf(answer(over))).toEqual({ problems: ["bad-label"], words: [] });
  });

  // S5.R1 M2: the label is sent to the writer with every slot, so it is held to the youth check the texts of the pool are.
  test.each(["Teen cafes", "Petite looks", "Young mornings", "School days", "Girl next door"])("a label that suggests a young person («%s») is refused as bad-label, naming our words for the rule", (label) => {
    const refusal = refusalOf(answer({ label }));
    expect(refusal.problems).toEqual(["bad-label"]);
    expect(refusal.words.length).toBeGreaterThan(0);
  });

  test("a bad label's refusal never carries the model's own text", () => {
    const refusal = refusalOf(answer({ label: "Teen cafes" }));
    for (const word of refusal.words) expect(word.toLowerCase()).not.toContain("cafes");
  });

  test("an ordinary label is still accepted", () => {
    expect(okOf(answer({ label: "Lazy Sundays" })).label).toBe("Lazy Sundays");
  });

  test("a youth label and a missing deck are both told", () => {
    expect(refusalOf(answer({ label: "Teen cafes", shotDeck: [] })).problems).toEqual(["bad-label", "bad-shot-deck"]);
  });

  test.each([
    ["a deck of four", ["friend", "friend", "selfie", "candid"]],
    ["a deck of six", ["friend", "friend", "selfie", "candid", "candid", "friend"]],
    ["a shot nobody takes", ["friend", "friend", "selfie", "drone", "candid"]],
    ["no deck", []],
  ])("%s is refused as bad-shot-deck", (_name, shotDeck) => {
    expect(refusalOf(answer({ shotDeck }))).toEqual({ problems: ["bad-shot-deck"], words: [] });
  });

  test("a deck with a mirror shot and no mirror place is refused, never given a mirror place it did not name", () => {
    const locations = (answer().locations as Json[]).map((l) => ({ ...l, mirror: false }));
    expect(refusalOf(answer({ locations }))).toEqual({ problems: ["mirror-without-place"], words: [] });
  });

  test("several problems are all told", () => {
    const refusal = refusalOf(answer({ label: "", shotDeck: [], outfits: ["a", "b"] }));
    expect(refusal.problems.sort()).toEqual<PoolProblem[]>(["bad-label", "bad-shot-deck", "too-few-outfits"].sort() as PoolProblem[]);
  });
});

describe("readPoolAnswer: nothing that breaks the pool schema is ever kept", () => {
  const HOSTILE = [
    "a bikini top",
    "a school uniform",
    'say "hi"',
    "back\\slash",
    "café au lait",
    "x".repeat(60),
    " padded ",
    "",
    "a young girl look",
    "lingerie",
    "a tiny dress",
    "robe over lingerie",
    "a teen look",
  ];

  test("whatever mix of hostile texts the answer carries, the pool that comes out passes both schemas", () => {
    for (const text of HOSTILE) {
      const locations = [...(answer().locations as Json[]), place(text), place("a sixth", { activities: [{ text, twoHanded: false }, { text: "waving", twoHanded: false }, { text: "smiling", twoHanded: false }] })];
      const result = read(answer({ locations, outfits: [...OUTFITS, text] }));
      expect(result.ok).toBe(true);
      if (!result.ok) continue;
      expect(CategoryPool.safeParse(result.pool).success).toBe(true);
      expect(PoolSchema.safeParse(poolOf(result.pool)).success).toBe(true);
    }
  });
});

describe("readPoolAnswer: the angles the description asks for (CS.8a)", () => {
  test("a listed angle becomes the pool's poses", () => {
    expect(okOf(answer({ poses: ["back"] })).pool.poses).toEqual(["back"]);
  });

  test("several angles keep the model's order", () => {
    expect(okOf(answer({ poses: ["back", "profile"] })).pool.poses).toEqual(["back", "profile"]);
  });

  test("a value outside the vocabulary is dropped and the valid ones stay", () => {
    expect(okOf(answer({ poses: ["from above", "back", "sideways"] })).pool.poses).toEqual(["back"]);
  });

  test("a repeated angle is kept once", () => {
    expect(okOf(answer({ poses: ["back", "back", "profile", "back"] })).pool.poses).toEqual(["back", "profile"]);
  });

  test.each([
    ["an empty list", { poses: [] }],
    ["only values outside the vocabulary", { poses: ["from above", 7, null] }],
    ["a text instead of a list", { poses: "back" }],
    ["null", { poses: null }],
    ["no key at all", {}],
  ])("%s leaves the pool without poses, and the answer stands", (_name, over) => {
    const result = okOf(answer(over));
    expect("poses" in result.pool).toBe(false);
  });

  test("an answer that carries poses is still held to every pool rule: a bad outfit is dropped as before", () => {
    const result = okOf(answer({ poses: ["back"], outfits: [...OUTFITS, "a red bikini"] }));
    expect(result.dropped).toBe(1);
    expect(result.pool.poses).toEqual(["back"]);
  });

  test("a pool with poses passes the contract's schema and the engine's pool schema", () => {
    const { pool } = okOf(answer({ poses: ["back", "profile"] }));
    expect(CategoryPool.safeParse(pool).success).toBe(true);
    expect(PoolSchema.safeParse(poolOf(pool)).success).toBe(true);
  });

  test("an activity that opens with a body position is kept when it fits the 35 characters", () => {
    const activities = [
      { text: "lying on her stomach, texting", twoHanded: false },
      { text: "on her stomach, scrolling her phone", twoHanded: false },
      { text: "on her stomach, kicking her feet", twoHanded: false },
    ];
    const result = okOf(answer({ poses: ["back"], locations: PLACES.map((name, i) => place(name, { mirror: i === 2, activities })) }));
    expect(result.dropped).toBe(0);
    expect(result.pool.locations[0]?.activities.map((a) => a.text)).toEqual(["lying on her stomach, texting", "on her stomach, scrolling her phone", "on her stomach, kicking her feet"]);
  });

  test("the body position leaves 13 characters of the 35: «lying on her stomach, » is 22, and a 40-character activity is dropped", () => {
    expect("lying on her stomach, ".length).toBe(22);
    expect(POOL_TEXT_MAX - "lying on her stomach, ".length).toBe(13);
    const long = "lying on her stomach, reading a magazine";
    expect(long.length).toBe(40);
    const activities = [
      { text: long, twoHanded: false },
      { text: "lying on her stomach, texting", twoHanded: false },
      { text: "lying on her stomach, writing", twoHanded: false },
    ];
    const result = okOf(answer({ poses: ["back"], locations: PLACES.map((name, i) => place(name, { mirror: i === 2, activities })) }));
    expect(result.pool.locations[0]?.activities.map((a) => a.text)).toEqual(["lying on her stomach, texting", "lying on her stomach, writing"]);
  });
});

describe("readPoolAnswer: a realistic answer for a body position, with the short prefix (CS.8a fix round 1)", () => {
  const P = "on her stomach, ";
  const act = (text: string) => ({ text: P + text, twoHanded: false });
  // Actions of 7..18 characters like the owner's real pool; one of them pushes the text past the 35.
  const FITS = ["texting", "reading a book", "scrolling a phone", "sipping a tea", "painting her nails"];
  const TOO_LONG = "reading a fashion magazine";
  const realPlaces = (): Json[] => [
    place("a bedroom bed", { activities: [act(FITS[0] as string), act(FITS[1] as string), act(TOO_LONG)] }),
    place("a living room rug", { activities: [act(FITS[2] as string), act(FITS[3] as string)] }),
    place("a sunny balcony", { activities: [act(FITS[4] as string), act(TOO_LONG)] }),
    place("a sofa corner", { mirror: true, activities: [act(FITS[0] as string), act(FITS[3] as string)] }),
    place("a window seat", { activities: [act(FITS[1] as string), act(FITS[2] as string)] }),
  ];
  const hallway = (): Json => place("a hallway floor", { activities: [act("texting"), act("sipping a tea")] });

  test("the arithmetic: the short prefix is 16 characters, so 19 are left for the action", () => {
    expect(P.length).toBe(16);
    expect(POOL_TEXT_MAX - P.length).toBe(19);
    expect((P + TOO_LONG).length).toBeGreaterThan(POOL_TEXT_MAX);
    for (const fit of FITS) expect((P + fit).length).toBeLessThanOrEqual(POOL_TEXT_MAX);
  });

  test("a place that keeps two activities survives with only the ones that fit", () => {
    const result = okOf(answer({ poses: ["back"], locations: [...realPlaces(), hallway()] }));
    const bed = result.pool.locations.find((l) => l.name === "a bedroom bed");
    expect(bed?.activities.map((a) => a.text)).toEqual([P + "texting", P + "reading a book"]);
  });

  test("a place left with one activity is dropped, and with six places the pool still stands on five", () => {
    const result = okOf(answer({ poses: ["back"], locations: [...realPlaces(), hallway()] }));
    expect(result.pool.locations.map((l) => l.name)).not.toContain("a sunny balcony");
    expect(result.pool.locations).toHaveLength(5);
    expect(result.pool.poses).toEqual(["back"]);
  });

  test("with exactly five places, the one that loses its second activity costs the answer: too-few-places", () => {
    expect(refusalOf(answer({ poses: ["back"], locations: realPlaces() })).problems).toEqual(["too-few-places"]);
  });
});

describe("poolOf", () => {
  test("carries the pool's poses to the engine's pool, and nothing when the pool has none", () => {
    expect(poolOf(okOf(answer({ poses: ["back"] })).pool).poses).toEqual(["back"]);
    expect("poses" in poolOf(okOf(answer()).pool)).toBe(false);
  });

  test("is the engine's pool: a mirror place carries mirror true, the others carry none", () => {
    const pool = poolOf(okOf(answer()).pool);
    expect(pool.locations.map((l) => l.mirror)).toEqual([undefined, undefined, true, undefined, undefined]);
    expect(pool.locations[0]).toEqual({ name: "a corner cafe", times: ["morning", "midday"], activities: [{ text: "reading a menu", twoHanded: false }, { text: "stirring a cappuccino", twoHanded: true }] });
  });
});

describe("poolMessages", () => {
  test("the first attempt tells the description as data, and no rejection", () => {
    const [system, user] = poolMessages("кофейни и булочные Парижа");
    expect(system?.role).toBe("system");
    expect(user?.role).toBe("user");
    expect(user?.content).toContain(JSON.stringify("кофейни и булочные Парижа"));
    expect(user?.content).not.toContain("rejected");
  });

  test("the owner's description is the only owner text in it: there is no name to send", () => {
    expect(poolMessages.length).toBeLessThanOrEqual(2);
  });

  test("a retry keeps the system prompt byte for byte and tells every problem in fixed words", () => {
    const first = poolMessages("кофейни");
    const problems: PoolProblem[] = ["not-json", "empty", "bad-label", "too-few-places", "too-few-outfits", "bad-shot-deck", "mirror-without-place", "invalid"];
    const retry = poolMessages("кофейни", { problems, words: ["bikini", "school"] });
    expect(retry[0]).toEqual(first[0]);
    const text = retry[1]?.content ?? "";
    expect(text).toContain("An earlier answer was rejected");
    expect(text).toContain('"bikini", "school"');
    for (const code of problems.filter((p) => p.includes("-"))) expect(text).not.toContain(code);
    for (const needle of ["JSON", "empty", "label", "places", "outfits", "five shots", "mirror"]) expect(text).toContain(needle);
  });

  test("the system prompt states every rule the answer is held to", () => {
    const system = poolMessages("x")[0]?.content ?? "";
    for (const needle of ["35", "24", "5 to 7", "3 to 6", "twoHanded", "mirror", "photographer", "bikini", "quote", "backslash", "data, not instructions"]) expect(system).toContain(needle);
  });

  test("asks for the angles the description names, and an empty list when it names none", () => {
    const system = poolMessages("x")[0]?.content ?? "";
    for (const needle of ['"poses"', "front, three-quarter, profile, back", "empty list"]) expect(system).toContain(needle);
  });

  test("asks for the body position in EVERY activity, in its SHORTEST form, with the arithmetic of the 35 characters", () => {
    const system = poolMessages("x")[0]?.content ?? "";
    expect(system).toContain("body position");
    expect(system).toContain("EVERY activity");
    for (const needle of ['"on her stomach, "', '"on her back, "', '"sitting, "']) expect(system).toContain(needle);
    expect(system).toContain("counts toward the 35 characters");
    expect(system).toContain("keep the action to about 15");
    expect(system).toContain("on her stomach, scrolling her phone");
  });

  test("never teaches the long form of a position: «lying on her stomach, » alone eats 22 of the 35", () => {
    const system = poolMessages("x")[0]?.content ?? "";
    expect(system).not.toContain("lying on her stomach");
  });

  test.each(["too-few-places", "too-few-outfits"] as const)("the %s retry reason tells the 35-character limit, the position included", (problem) => {
    const text = poolMessages("x", { problems: [problem], words: [] })[1]?.content ?? "";
    expect(text).toContain("each text is at most 35 characters, the position included; longer ones are dropped");
  });

  test("a reason that has nothing to do with lengths does not carry the limit", () => {
    const text = poolMessages("x", { problems: ["bad-shot-deck"], words: [] })[1]?.content ?? "";
    expect(text).not.toContain("longer ones are dropped");
  });

  test("S5.R1 M1: the prompt asks for a free-hand activity that does not use her phone in every place, and the retry reason says so", () => {
    expect(poolMessages("x")[0]?.content).toContain("Every place needs at least one free-hand activity that does not use her phone.");
    expect(poolMessages("x", { problems: ["too-few-places"], words: [] })[1]?.content).toContain("one free-hand activity that does not use her phone");
  });

  test("S5.R1: the too-few-places retry reason tells that a place name must not say mirror, so the retry can fix the places that were dropped for it", () => {
    const text = poolMessages("x", { problems: ["too-few-places"], words: [] })[1]?.content ?? "";
    expect(text).toContain("a plain name that does not say mirror");
  });

  test("S5.R1 M1: every place of the example has a free-hand activity that does not use her phone", () => {
    const example: { locations: { name: string; activities: { text: string; twoHanded: boolean }[] }[] } = JSON.parse(POOL_EXAMPLE_ANSWER);
    for (const place of example.locations) expect(place.activities.some((a) => !a.twoHanded && !/\bphones?\b/i.test(a.text))).toBe(true);
  });

  // S5.R1 H1 for custom pools: a shot that is not a mirror can land on any place, so a place named «…mirror…» contradicts «the phone itself is not in the picture».
  test("the prompt says never to name a mirror in a place's name, and to mark it instead", () => {
    expect(poolMessages("x")[0]?.content).toContain('Never name a mirror in a place\'s name; mark it with "mirror": true instead.');
  });

  test("the example teaches no mirror name: its mirror place is a bedroom marked mirror true", () => {
    const example: { locations: { name: string; mirror: boolean }[] } = JSON.parse(POOL_EXAMPLE_ANSWER);
    expect(example.locations.some((l) => /mirror/i.test(l.name))).toBe(false);
    expect(example.locations.find((l) => l.name === "a bedroom")?.mirror).toBe(true);
  });

  test("the example's body-position activity fits the 35 characters", () => {
    const example: { locations: { activities: { text: string }[] }[] } = JSON.parse(POOL_EXAMPLE_ANSWER);
    for (const place of example.locations) for (const activity of place.activities) expect(activity.text.length).toBeLessThanOrEqual(POOL_TEXT_MAX);
    expect(POOL_EXAMPLE_ANSWER).toContain("on her stomach, on one elbow");
  });

  test("the example it shows is itself a pool the reader accepts", () => {
    const system = poolMessages("x")[0]?.content ?? "";
    expect(system).toContain(POOL_EXAMPLE_ANSWER);
    const result = read(POOL_EXAMPLE_ANSWER);
    expect(result.ok && result.dropped).toBe(0);
  });
});

describe("POOL_JSON_SCHEMA", () => {
  type Node = { type?: string; additionalProperties?: boolean; required?: string[]; properties?: Record<string, Node>; items?: Node; enum?: string[] };
  const root = POOL_JSON_SCHEMA.schema as Node;

  function objects(node: Node, found: Node[] = []): Node[] {
    if (node.type === "object") found.push(node);
    for (const child of Object.values(node.properties ?? {})) objects(child, found);
    if (node.items !== undefined) objects(node.items, found);
    return found;
  }

  test("is the strict schema named scene_pool", () => {
    expect(POOL_JSON_SCHEMA.name).toBe("scene_pool");
  });

  test("every object forbids other keys and requires all of its own", () => {
    const all = objects(root);
    expect(all).toHaveLength(3);
    for (const node of all) {
      expect(node.additionalProperties).toBe(false);
      expect([...(node.required ?? [])].sort()).toEqual(Object.keys(node.properties ?? {}).sort());
    }
  });

  test("asks for the label, the places, the outfits and the deck", () => {
    expect(Object.keys(root.properties ?? {}).sort()).toEqual(["label", "locations", "outfits", "poses", "shotDeck"]);
  });

  test("the angles are a list of the four poses of the shared vocabulary, always present (an empty list means none)", () => {
    expect(root.properties?.poses?.type).toBe("array");
    expect(root.properties?.poses?.items?.enum).toEqual([...ScenePose.options]);
    expect(root.required).toContain("poses");
  });

  test("a place's times come from the built-in vocabulary and the deck's shots from the five", () => {
    expect([...POOL_TIMES]).toEqual(["morning", "midday", "golden hour", "evening", "night", "studio lighting"]);
    const times = root.properties?.locations?.items?.properties?.times?.items?.enum;
    expect(times).toEqual([...POOL_TIMES]);
    expect(root.properties?.shotDeck?.items?.enum).toEqual([...POOL_SHOTS]);
  });

  test("the contract's shots are the engine's own", () => {
    expect([...POOL_SHOTS]).toEqual([...SHOTS]);
  });
});

describe("POOL_CALL", () => {
  const book = PriceBook.fallback();
  const call = poolCall("x-ai/grok-4.3");

  test("is a text call of about 10K tokens in and 4K out on the settings' model, with no image", () => {
    expect(call).toMatchObject({ model: "x-ai/grok-4.3", maxTokens: 4_000, inputTokens: 10_000, images: 0 });
    expect(POOL_MAX_ATTEMPTS).toBe(2);
  });

  test("one attempt's ceiling is $0.0225 and a call's two attempts $0.045 at the fallback prices; typical is $0.005125", () => {
    const attempt = book.chatWorstCase({ model: call.model, maxTokens: call.maxTokens, inputTokens: call.inputTokens, images: call.images });
    expect(attempt).toBe(22_500);
    expect(POOL_MAX_ATTEMPTS * attempt).toBe(45_000);
    expect(book.chatCost({ model: call.model, images: 0, ...call.typical })).toBe(5_125);
  });
});

describe("S5.1b: the pool writer's text is about ordinary places and an ordinary phone photo", () => {
  const system = (): string => poolMessages("x")[0]?.content ?? "";

  test("the example answer is her bedroom and kitchen, with no paper, laptop or desk", () => {
    expect(POOL_EXAMPLE_ANSWER).toContain("a bright kitchen");
    expect(POOL_EXAMPLE_ANSWER).toContain("her bedroom by the window");
    expect(POOL_EXAMPLE_ANSWER).not.toMatch(/paperback|laptop|desk|office|reading|book|note/i);
  });

  test("the two-handed example and the body-position example are the new ones", () => {
    expect(system()).toContain("such as cooking, carrying a tray or tying her hair up");
    expect(system()).not.toContain("typing");
    expect(system()).toContain('e.g. "on her stomach, scrolling her phone" (35)');
    expect(system()).not.toContain("reading a book");
  });

  test("no photographer quota: the deck is mostly friend, selfie, mirror and candid", () => {
    expect(system()).not.toContain("at least 3");
    expect(system()).not.toContain("editorial theme");
    expect(system()).toContain("Mostly friend, selfie, mirror and candid.");
  });

  test("the outfit rule allows everyday cuts and names what is still refused", () => {
    expect(system()).toContain(
      "everyday outfits that suit the theme, each at most 35 characters: shorts, tank tops, crop tops, mini skirts and fitted dresses are fine; never swimwear, lingerie, sports bras, thongs, stockings, slip dresses or robes.",
    );
  });

  test("the places rule: ordinary places, no paper, books or screens but her phone, never a photographer or a studio", () => {
    expect(system()).toContain("Places are ordinary places she would really be in; no paper, books or screens other than her phone; never a photographer or a studio.");
  });
});
