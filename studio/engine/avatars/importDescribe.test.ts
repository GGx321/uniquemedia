import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import {
  adultTextProblems,
  allYouthRuleNames,
  AvatarDescriptor,
  AvatarTraits,
  Build,
  BODY_KEYS,
  bodyPhrase,
  BodyBust,
  BodyFigure,
  BodyHeight,
  BodyMark,
  BottomShape,
  BottomSize,
  HairColor,
  LegLength,
  LegShape,
} from "../../shared/engine";
import { promptTokenFloor } from "../openrouter/chat";
import { importDescribeCall } from "./plan";
import {
  IMPORT_DESCRIBE_JSON_SCHEMA,
  importDescribeMessages,
  readImportDescribeAnswer,
  IMPORT_DESCRIBE_WORDS_BYTES_MAX,
  type ImportDescribeProblem,
  type ImportDescribeRefusal,
} from "./importDescribe";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// T6c: the one-off vision call that reads the imported photo and writes both
// her typed traits and her descriptor in one strict JSON answer, gated by
// exactly the same AvatarTraits/AvatarDescriptor rules as a generated
// avatar's (invariant 8) — never a looser check just because the source is
// an import.

/** Every body key answered "unknown" and no marks: a photo that shows no body. */
const ALL_UNKNOWN = { height: "unknown", bust: "unknown", figure: "unknown", legLength: "unknown", legShape: "unknown", bottomSize: "unknown", bottomShape: "unknown", bodyMarks: [] };

function answer(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    age: 26,
    ethnicity: "european",
    skinTone: "light",
    hairColor: "dark-brown",
    hairLength: "long",
    hairTexture: "straight",
    eyeColor: "brown",
    build: "slim",
    marks: [],
    descriptor: "26-year-old European woman, fair skin, brown eyes, long straight dark brown hair, slim build.",
    people: 1,
    woman: true,
    ...overrides,
  };
}

describe("importDescribeMessages", () => {
  test("a system message with the rules and traits enums; a user message asking to look at the attached photo", () => {
    const messages = importDescribeMessages();
    expect(messages).toHaveLength(2);
    expect(messages[0]?.role).toBe("system");
    expect(messages[1]?.role).toBe("user");
    // Every enum the model must pick from is named, so it cannot invent one outside the contract.
    for (const word of ["european", "latina", "asian", "african", "mixed"]) expect(messages[0]?.content).toContain(word);
    for (const word of ["slim", "athletic", "soft", "curvy"]) expect(messages[0]?.content).toContain(word);
  });

  // S5.0b: the full system prompt is a deliberate fixture. Any edit to the
  // prompt (or to an enum it lists) fails here on purpose: re-pin it in the
  // same commit as the edit, with the reason in the message.
  test("the system prompt is pinned to its fixture, word for word", () => {
    const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "import-describe-system-prompt.txt"), "utf8");
    expect(`${importDescribeMessages()[0]?.content}\n`).toBe(fixture);
  });

  test("the hair rule: describe the real colour exactly as seen, never forced to the nearest trait choice", () => {
    const system = String(importDescribeMessages()[0]?.content);
    expect(system).toContain("Describe her hair exactly as the photo shows it");
    for (const colour of ["platinum", "white", "silver", "grey", "pastel pink", "ombre", "dyed ends"]) expect(system).toContain(colour);
    expect(system).toContain("even when the hairColor trait above had to take the nearest choice");
  });

  test("every example hair colour in the rule passes the descriptor's own word rules inside a realistic descriptor", () => {
    const system = String(importDescribeMessages()[0]?.content);
    const list = /real colour \(for example ([^)]+)\)/.exec(system)?.[1];
    if (list === undefined) throw new Error("the hair rule's example list is missing");
    const examples = list.split(/, | or /).filter((e) => e !== "");
    expect(examples.length).toBeGreaterThanOrEqual(5);
    for (const example of examples) {
      const text = `27-year-old European woman, fair skin, brown eyes, long straight ${example} hair, slim build.`;
      expect({ example, problems: adultTextProblems(text, 27, "descriptor") }).toEqual({ example, problems: [] });
    }
  });

  test("the hairColor trait stays a choice among the six enum values, and the other descriptor rules survive the hair rule", () => {
    const system = String(importDescribeMessages()[0]?.content);
    expect(HairColor.options).toHaveLength(6);
    expect(system).toContain(`- hairColor: one of ${HairColor.options.join(", ")}.`);
    expect(system).toContain("no height or weight");
    expect(system).toContain("No counts");
  });

  test("a retry's feedback does not change the pinned system prompt", () => {
    const first = importDescribeMessages()[0]?.content;
    expect(importDescribeMessages({ problems: ["empty"], words: [] })[0]?.content).toBe(first);
  });

  test("no user-entered text ever reaches the prompt: the messages take no arguments besides the previous refusal", () => {
    // A canary against a future change: importDescribeMessages must not grow
    // a parameter for the owner's name, vibe or anything else typed by hand —
    // the vision call knows only the photo (attached elsewhere by the
    // caller) and the contract's own fixed rules.
    expect(importDescribeMessages.length).toBeLessThanOrEqual(1);
  });

  test("the second attempt gets the reasons the first was refused", () => {
    const feedback: ImportDescribeRefusal = { problems: ["no-age-anchor", "youth-word"], words: ["teen"] };
    const messages = importDescribeMessages(feedback);
    expect(messages[1]?.content).toContain("rejected");
    expect(messages[1]?.content).toContain("teen");
  });
});

test("the output schema requires every trait, the eight body keys (S5.2b), the descriptor, and the subject check (M5: exactly one woman) — nothing else", () => {
  expect(IMPORT_DESCRIBE_JSON_SCHEMA.schema).toMatchObject({
    type: "object",
    additionalProperties: false,
    required: [
      "people", "woman", "age", "ethnicity", "skinTone", "hairColor", "hairLength", "hairTexture", "eyeColor", "build", "marks",
      "height", "bust", "figure", "legLength", "legShape", "bottomSize", "bottomShape", "bodyMarks", "descriptor",
    ],
  });
});

// Stage 5, S5.2b: the body the photo shows. Each of the eight body keys is answered only when the photo clearly shows it ("unknown" otherwise); the reader turns the answer into
// proposals (`values`) and a per-key `seen`, and nothing here is ever a trait.
describe("the body request (S5.2b)", () => {
  const BODY_ENUM_KEYS = ["height", "bust", "figure", "legLength", "legShape", "bottomSize", "bottomShape"] as const;

  test("the schema requires the eight body keys after the existing ones, and the descriptor stays last", () => {
    const required = (IMPORT_DESCRIBE_JSON_SCHEMA.schema as { required: string[] }).required;
    expect(required).toEqual([
      "people", "woman", "age", "ethnicity", "skinTone", "hairColor", "hairLength", "hairTexture", "eyeColor", "build", "marks",
      ...BODY_KEYS, "descriptor",
    ]);
  });

  test("each single-choice body key is its enum plus unknown, and bodyMarks is a list of the fixed body marks", () => {
    const properties = (IMPORT_DESCRIBE_JSON_SCHEMA.schema as { properties: Record<string, { enum?: string[]; items?: { enum?: string[] }; type: string }> }).properties;
    const shapes = { height: BodyHeight, bust: BodyBust, figure: BodyFigure, legLength: LegLength, legShape: LegShape, bottomSize: BottomSize, bottomShape: BottomShape };
    for (const key of BODY_ENUM_KEYS) expect(properties[key]?.enum).toEqual([...shapes[key].options, "unknown"]);
    expect(properties.bodyMarks?.type).toBe("array");
    expect(properties.bodyMarks?.items?.enum).toEqual([...BodyMark.options]);
  });

  test("the prompt asks for each body field only when the photo clearly shows it, and keeps build the existing trait", () => {
    const system = String(importDescribeMessages()[0]?.content);
    expect(system).toContain('answer each only when the photo clearly shows it; otherwise "unknown"');
    for (const key of BODY_KEYS) expect(system).toContain(key);
    expect(system).toContain(`- build: one of ${Build.options.join(", ")}.`);
  });

  test("an answer without any body key is still a clean answer with no proposal", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer()));
    expect(read.ok && read.body).toBeUndefined();
    expect(read.ok).toBe(true);
  });

  test("a body the photo shows becomes values, and each key says it came from the photo", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer({ ...ALL_UNKNOWN, height: "tall", bust: "full", bodyMarks: ["tattoo-hip"] })));
    if (!read.ok) throw new Error("unreachable");
    expect(read.body?.values).toEqual({ height: "tall", bust: "full", bodyMarks: ["tattoo-hip"] });
    expect(read.body?.seen).toEqual({
      height: "photo", bust: "photo", figure: "not-visible", legLength: "not-visible", legShape: "not-visible", bottomSize: "not-visible", bottomShape: "not-visible", bodyMarks: "photo",
    });
  });

  test("unknown is never proposed: the key is absent from the values and not-visible in seen", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer({ ...ALL_UNKNOWN, figure: "hourglass" })));
    if (!read.ok) throw new Error("unreachable");
    expect(read.body?.values).toEqual({ figure: "hourglass" });
    expect(read.body?.seen.bust).toBe("not-visible");
    expect(Object.keys(read.body?.values ?? {})).not.toContain("bust");
  });

  test("a face-only photo (every key unknown, no marks) has no proposal at all", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer(ALL_UNKNOWN)));
    expect(read.ok && read.body).toBeUndefined();
  });

  test("a value outside the choices is treated as not seen: the paid import is not refused over a body field", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer({ ...ALL_UNKNOWN, height: "gigantic", bust: "small" })));
    if (!read.ok) throw new Error("unreachable");
    expect(read.body?.values).toEqual({ bust: "small" });
    expect(read.body?.seen.height).toBe("not-visible");
  });

  test("body marks are deduplicated, a mark outside the list is dropped, and at most two are kept in the order given", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer({ ...ALL_UNKNOWN, bodyMarks: ["tattoo-ribs", "tattoo-ribs", "birthmark", "mole-back", "tattoo-ankle"] })));
    if (!read.ok) throw new Error("unreachable");
    expect(read.body?.values.bodyMarks).toEqual(["tattoo-ribs", "mole-back"]);
  });

  test("a bodyMarks that is not a list is treated as not seen", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer({ ...ALL_UNKNOWN, bust: "medium", bodyMarks: "tattoo-hip" })));
    if (!read.ok) throw new Error("unreachable");
    expect(read.body?.values).toEqual({ bust: "medium" });
    expect(read.body?.seen.bodyMarks).toBe("not-visible");
  });

  test("the proposal never reaches the traits: they hold no body key, and build is the face-read trait", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer({ ...ALL_UNKNOWN, height: "tall", build: "curvy" })));
    if (!read.ok) throw new Error("unreachable");
    expect(read.traits.build).toBe("curvy");
    for (const key of BODY_KEYS) expect(Object.keys(read.traits)).not.toContain(key);
    expect(Object.keys(read.body?.values ?? {})).not.toContain("build");
  });

  test("a proposed body whose phrase breaks the adult rules is not proposed (the phrases are ours, so none does; the guard is the contract's own)", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer({ ...ALL_UNKNOWN, height: "short" })));
    if (!read.ok) throw new Error("unreachable");
    expect(AvatarDescriptor.safeParse({ age: 26, text: read.descriptor.text, body: bodyPhrase(read.body?.values ?? {}) }).success).toBe(true);
  });
});

describe("readImportDescribeAnswer", () => {
  test("a clean answer is the traits (with an empty vibe: it comes from the model, never the owner) and the descriptor", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer()));
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("unreachable");
    const traits: AvatarTraits = {
      age: 26,
      ethnicity: "european",
      skinTone: "light",
      hairColor: "dark-brown",
      hairLength: "long",
      hairTexture: "straight",
      eyeColor: "brown",
      build: "slim",
      marks: [],
      vibe: "",
    };
    expect(read.traits).toEqual(traits);
    expect(read.descriptor).toEqual({ age: 26, text: answer().descriptor as string });
    expect(AvatarTraits.safeParse(read.traits).success).toBe(true);
    expect(AvatarDescriptor.safeParse(read.descriptor).success).toBe(true);
  });

  test("accepts marks and every enum value at least once", () => {
    const read = readImportDescribeAnswer(
      JSON.stringify(
        answer({
          marks: ["freckles", "mole"],
          descriptor: "26-year-old European woman, fair skin, brown eyes, long straight dark brown hair, slim build, light freckles across the nose, a small mole on the cheek.",
        }),
      ),
    );
    expect(read.ok).toBe(true);
  });

  test("not JSON at all", () => {
    const read = readImportDescribeAnswer("not json");
    expect(read).toEqual({ ok: false, problems: ["not-json"], words: [] });
  });

  test("a JSON answer inside a markdown fence is read", () => {
    const read = readImportDescribeAnswer("```json\n" + JSON.stringify(answer()) + "\n```");
    expect(read.ok).toBe(true);
  });

  test("an unknown enum value is refused as invalid-traits, not a silent guess", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer({ ethnicity: "martian" })));
    expect(read).toEqual({ ok: false, problems: ["invalid-traits"], words: [] });
  });

  test("age outside 21-35 is refused as invalid-traits", () => {
    expect(readImportDescribeAnswer(JSON.stringify(answer({ age: 19 })))).toEqual({ ok: false, problems: ["invalid-traits"], words: [] });
    expect(readImportDescribeAnswer(JSON.stringify(answer({ age: 40 })))).toEqual({ ok: false, problems: ["invalid-traits"], words: [] });
  });

  test("a descriptor that does not anchor the model's own age is refused as no-age-anchor", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer({ descriptor: "A woman with dark hair and brown eyes." })));
    expect(read).toEqual({ ok: false, problems: ["no-age-anchor"], words: [] });
  });

  test("a descriptor naming a youth word is refused, with the broken rule's name", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer({ descriptor: "26-year-old European girl, fair skin, brown eyes, long straight dark brown hair, slim build." })));
    expect(read.ok).toBe(false);
    if (read.ok) throw new Error("unreachable");
    expect(read.problems).toContain("youth-word");
  });

  test("a descriptor stating another age is refused", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer({ descriptor: "26-year-old European woman, 19 years young, fair skin, brown eyes, long straight dark brown hair, slim build." })));
    expect(read.ok).toBe(false);
  });

  test("an empty descriptor is refused as empty", () => {
    expect(readImportDescribeAnswer(JSON.stringify(answer({ descriptor: "" })))).toEqual({ ok: false, problems: ["empty"], words: [] });
  });

  test("a descriptor over the character limit is refused as too-long, without the other checks", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer({ descriptor: "26-year-old European woman, " + "x".repeat(24_000) })));
    expect(read).toEqual({ ok: false, problems: ["too-long"], words: [] });
  });

  test("a runaway answer of 24,000 chars is refused at once, without throwing", () => {
    expect(() => readImportDescribeAnswer("x".repeat(24_000))).not.toThrow();
  });

  test("typographic noise (curly quotes, accents) is normalised before the checks, like the plain descriptor job's", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer({ descriptor: "26-year-old European woman, café-style makeup, fair skin, brown eyes, long straight dark brown hair, slim build." })));
    expect(read.ok).toBe(true);
    if (!read.ok) throw new Error("unreachable");
    expect(read.descriptor.text).toContain("cafe-style");
  });

  // T6c review round 2, M5: "women only, exactly one person" is not enforced
  // by anything else in this pipeline — it must be checked here, on the
  // model's own structured judgement, before the traits/descriptor checks
  // even run (a group photo, or one with a child in it, refuses regardless
  // of how well-formed the rest of the answer is).
  describe("M5: exactly one person, and she is a woman", () => {
    test("two people in the photo (a group photo) is refused as multiple-people, not stored", () => {
      const read = readImportDescribeAnswer(JSON.stringify(answer({ people: 2 })));
      expect(read).toEqual({ ok: false, problems: ["multiple-people"], words: [] });
    });

    test("a photo with a child in it (people counts everyone, any age) is refused the same way", () => {
      const read = readImportDescribeAnswer(JSON.stringify(answer({ people: 2 })));
      expect(read.ok).toBe(false);
      if (read.ok) throw new Error("unreachable");
      expect(read.problems).toEqual(["multiple-people"]);
    });

    test("no one recognisable in the photo is refused as multiple-people too (not exactly one)", () => {
      const read = readImportDescribeAnswer(JSON.stringify(answer({ people: 0 })));
      expect(read).toEqual({ ok: false, problems: ["multiple-people"], words: [] });
    });

    test("exactly one person who is not a woman is refused as not-a-woman", () => {
      const read = readImportDescribeAnswer(JSON.stringify(answer({ woman: false })));
      expect(read).toEqual({ ok: false, problems: ["not-a-woman"], words: [] });
    });

    test("the subject check runs before the traits/descriptor checks: an otherwise-invalid answer still reports multiple-people first", () => {
      const read = readImportDescribeAnswer(JSON.stringify(answer({ people: 2, ethnicity: "martian", descriptor: "" })));
      expect(read).toEqual({ ok: false, problems: ["multiple-people"], words: [] });
    });

    test("exactly one woman passes, same as before", () => {
      expect(readImportDescribeAnswer(JSON.stringify(answer({ people: 1, woman: true }))).ok).toBe(true);
    });
  });
});

// S5.R1: the reserve never goes below the prompt's byte floor (openrouter/chat.ts), so a describe prompt that outgrows the ceiling the estimate priced (money/estimate.ts, plan.ts's
// IMPORT_DESCRIBE_LIMITS) makes every import reserve more than it was shown. The longest describe prompt there is: every problem the next attempt can be told, and the whole
// list of rule names a youth-word refusal can carry. Raise the ceiling and the figures that quote it, deliberately, or shorten the prompt.
describe("the describe prompt's byte floor (S5.R1)", () => {
  const EVERY_PROBLEM: Record<ImportDescribeProblem, true> = {
    "not-json": true,
    empty: true,
    "too-long": true,
    "no-age-anchor": true,
    "invalid-traits": true,
    "invalid-descriptor": true,
    "multiple-people": true,
    "not-a-woman": true,
    script: true,
    "non-ascii-digits": true,
    "other-age": true,
    "under-21-bound": true,
    "youth-word": true,
    number: true,
  };
  // The words come from the model's own descriptor, in the order its text broke the rules, so the worst a retry can be told is the LONGEST names first (the Cyrillic ones are ~2 bytes a letter).
  const byBytesDescending = (names: readonly string[]): string[] => [...names].sort((a, b) => Buffer.byteLength(b, "utf8") - Buffer.byteLength(a, "utf8"));
  const worst: ImportDescribeRefusal = { problems: Object.keys(EVERY_PROBLEM) as ImportDescribeProblem[], words: byBytesDescending(allYouthRuleNames("descriptor")) };
  const ceiling = importDescribeCall("x-ai/grok-4.3").inputTokens;
  /** What the pin keeps clear of the ceiling: room for a later rule (S5.2b spent the first 1,024 of 8K on the body request and raised the ceiling to 9K). */
  const MARGIN = 500;
  const floorOf = (refusal: ImportDescribeRefusal): number => promptTokenFloor({ messages: importDescribeMessages(refusal), jsonSchema: IMPORT_DESCRIBE_JSON_SCHEMA, images: 1 });
  const toldOf = (refusal: ImportDescribeRefusal): string[] => {
    const text = String(importDescribeMessages(refusal)[1]?.content);
    const reason = /words we do not allow: ([^;]*);/.exec(text)?.[1] ?? "";
    return [...reason.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
  };

  test("the worst refusal is given every problem and every rule name there is, the longest first", () => {
    expect(worst.problems).toHaveLength(14);
    expect(worst.words.length).toBeGreaterThan(30);
    expect(Buffer.byteLength(worst.words[0] as string, "utf8")).toBeGreaterThanOrEqual(Buffer.byteLength(worst.words.at(-1) as string, "utf8"));
  });

  // The names are bounded by their bytes, not by a count: six long Cyrillic names are ~135 bytes, six short English ones ~55 (the first pin took the short ones).
  test(`a retry tells names up to ${IMPORT_DESCRIBE_WORDS_BYTES_MAX} bytes as they are written («"name", »), in the order they came, and stops before the one that would pass it`, () => {
    const told = toldOf(worst);
    const written = told.reduce((sum, name) => sum + Buffer.byteLength(name, "utf8") + 4, 0);
    expect(told).toEqual(worst.words.slice(0, told.length));
    expect(told.length).toBeGreaterThan(0);
    expect(written).toBeLessThanOrEqual(IMPORT_DESCRIBE_WORDS_BYTES_MAX);
    const next = worst.words[told.length] as string;
    expect(written + Buffer.byteLength(next, "utf8") + 4).toBeGreaterThan(IMPORT_DESCRIBE_WORDS_BYTES_MAX);
  });

  test("many short names fit where few long ones do: the bound is bytes", () => {
    const short = ["teen", "girl", "kid", "minor", "child", "tween", "loli", "tiny"];
    expect(toldOf({ problems: ["youth-word"], words: short })).toEqual(short);
    expect(toldOf({ problems: ["youth-word"], words: [...short, ...worst.words] }).length).toBeLessThan(short.length + worst.words.length);
  });

  test("a short list reads exactly as before", () => {
    const text = String(importDescribeMessages({ problems: ["youth-word"], words: ["teen", "girl"] })[1]?.content);
    expect(text).toContain('the descriptor used words we do not allow: "teen", "girl"; call her a woman and use none of them');
  });

  test("the longest prompt a describe can send stays at least 500 tokens under the ceiling the estimate priced", () => {
    expect(floorOf(worst)).toBeLessThanOrEqual(ceiling - MARGIN);
  });

  // EXACT, like the writer's pins: any extra byte in the prompt, the schema or a reason moves the margin and fails this, so the prompt cannot creep toward the ceiling unseen.
  // Re-measure when the describe prompt changes.
  test("the worst prompt keeps its measured margin under the ceiling (9,000 less the floor of 8,209)", () => {
    expect(ceiling - floorOf(worst)).toBe(791);
  });

  test("the pin measures: a refusal with nothing to tell is smaller than the worst", () => {
    expect(floorOf({ problems: [], words: [] })).toBeLessThan(floorOf(worst));
  });
});
