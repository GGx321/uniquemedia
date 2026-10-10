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
  IMPORT_DESCRIBE_NO_BODY_JSON_SCHEMA,
  importDescribeAsksBody,
  importDescribeJsonSchema,
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

  test("a retry after a rule was broken does not change the pinned system prompt (only an unreadable answer drops the body section)", () => {
    const first = importDescribeMessages()[0]?.content;
    expect(importDescribeMessages({ problems: ["youth-word"], words: ["teen"] })[0]?.content).toBe(first);
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

  test("a proposed body's phrase passes the contract beside the descriptor it came with (the phrases are ours, so the adult rules cannot refuse them)", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer({ ...ALL_UNKNOWN, height: "short" })));
    if (!read.ok) throw new Error("unreachable");
    expect(AvatarDescriptor.safeParse({ age: 26, text: read.descriptor.text, body: bodyPhrase(read.body?.values ?? {}) }).success).toBe(true);
  });
});

describe("the body request in the prompt (S5.2b review)", () => {
  const system = String(importDescribeMessages()[0]?.content);

  test("height is asked only when something in the photo gives a clear scale", () => {
    expect(system).toContain('- height: only when something in the photo gives a clear scale; otherwise "unknown".');
  });

  test("a face or shoulders alone show none of the sizes and shapes, and the marks are asked apart", () => {
    expect(system).toContain("A face or shoulders alone show none of the sizes and shapes.");
    expect(system).toContain("- bodyMarks: the tattoos and moles that clearly show on her body");
  });

  test("the descriptor keeps every body word out, hips and waist included", () => {
    expect(system).toContain("Keep the body fields out of it: no height, bust, figure, hips, waist, legs or bottom.");
  });
});

// S5.2b review M1: a vision model may refuse a photo of a person once it is asked to estimate a body. When the first answer is unusable by nature (empty, or not the JSON asked for), the
// second attempt asks without the «Body» section and without the body keys in the schema, so the import still reads her face and traits (and finds no body to propose).
describe("the describe prompt without the body request (S5.2b review M1)", () => {
  const BODY_SECTION = "Body: answer each";

  test("the first attempt asks for the body", () => {
    expect(importDescribeAsksBody({ problems: [], words: [] })).toBe(true);
    expect(String(importDescribeMessages()[0]?.content)).toContain(BODY_SECTION);
    expect(importDescribeJsonSchema({ problems: [], words: [] })).toBe(IMPORT_DESCRIBE_JSON_SCHEMA);
  });

  for (const problem of ["not-json", "empty"] as const) {
    test(`an answer rejected as «${problem}» makes the next attempt ask without the body`, () => {
      const feedback: ImportDescribeRefusal = { problems: [problem], words: [] };
      expect(importDescribeAsksBody(feedback)).toBe(false);
      expect(String(importDescribeMessages(feedback)[0]?.content)).not.toContain(BODY_SECTION);
      expect(importDescribeJsonSchema(feedback)).toBe(IMPORT_DESCRIBE_NO_BODY_JSON_SCHEMA);
    });
  }

  test("one unreadable answer among other problems still drops the body", () => {
    expect(importDescribeAsksBody({ problems: ["youth-word", "not-json"], words: ["teen"] })).toBe(false);
  });

  for (const problem of ["too-long", "no-age-anchor", "invalid-traits", "invalid-descriptor", "script", "non-ascii-digits", "other-age", "under-21-bound", "youth-word", "number"] as const) {
    test(`an answer that was readable but broke a rule («${problem}») keeps the body request`, () => {
      expect(importDescribeAsksBody({ problems: [problem], words: [] })).toBe(true);
    });
  }

  test("the no-body prompt is pinned to its own fixture, word for word", () => {
    const fixture = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "fixtures", "import-describe-no-body-system-prompt.txt"), "utf8");
    expect(`${importDescribeMessages({ problems: ["not-json"], words: [] })[0]?.content}\n`).toBe(fixture);
  });

  test("the no-body prompt keeps every other rule: the traits, the hair rule and the descriptor rules", () => {
    const system = String(importDescribeMessages({ problems: ["empty"], words: [] })[0]?.content);
    expect(system).toContain("Describe her hair exactly as the photo shows it");
    expect(system).toContain("no height or weight");
    expect(system).toContain("No counts");
    expect(system).not.toContain("bodyMarks");
    expect(system).not.toContain("Keep the body fields out");
  });

  test("the no-body schema has no body key, and the full schema has all eight", () => {
    const noBody = IMPORT_DESCRIBE_NO_BODY_JSON_SCHEMA.schema as { required: string[]; properties: Record<string, unknown> };
    const full = IMPORT_DESCRIBE_JSON_SCHEMA.schema as { required: string[]; properties: Record<string, unknown> };
    for (const key of BODY_KEYS) {
      expect(noBody.required).not.toContain(key);
      expect(key in noBody.properties).toBe(false);
      expect(full.required).toContain(key);
    }
    expect(noBody.required).toEqual(["people", "woman", "age", "ethnicity", "skinTone", "hairColor", "hairLength", "hairTexture", "eyeColor", "build", "marks", "descriptor"]);
  });

  test("an answer to the no-body prompt (no body keys at all) is read whole, with no proposal", () => {
    const read = readImportDescribeAnswer(JSON.stringify(answer()));
    expect(read.ok).toBe(true);
    expect(read.ok && read.body).toBeUndefined();
  });

  test("the no-body prompt is smaller than the full one: the second attempt is within what the estimate priced", () => {
    const full = promptTokenFloor({ messages: importDescribeMessages(), jsonSchema: IMPORT_DESCRIBE_JSON_SCHEMA, images: 1 });
    const noBody = promptTokenFloor({ messages: importDescribeMessages({ problems: ["not-json"], words: [] }), jsonSchema: IMPORT_DESCRIBE_NO_BODY_JSON_SCHEMA, images: 1 });
    expect(noBody).toBeLessThan(full);
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
  // The words come from the model's own descriptor, in the order its text broke the rules. What a retry is told is the first names, in order, that fit IMPORT_DESCRIBE_WORDS_BYTES_MAX as
  // written, so the worst is the MAXIMAL subset of all the rule names that fits (a subset-sum over bytes plus the separator), longest first: not the greedy longest-first prefix, which can
  // leave a gap a shorter name would have filled (S5.2b review L1).
  const writtenBytes = (name: string): number => Buffer.byteLength(name, "utf8") + 4;
  const byBytesDescending = (names: readonly string[]): string[] => [...names].sort((a, b) => Buffer.byteLength(b, "utf8") - Buffer.byteLength(a, "utf8"));
  function maximalNames(names: readonly string[]): string[] {
    const best = new Map<number, string[]>([[0, []]]);
    for (const name of names) {
      for (const [sum, chosen] of [...best]) {
        const next = sum + writtenBytes(name);
        if (next <= IMPORT_DESCRIBE_WORDS_BYTES_MAX && !best.has(next)) best.set(next, [...chosen, name]);
      }
    }
    const top = Math.max(...best.keys());
    return [...(best.get(top) ?? [])].sort((a, b) => Buffer.byteLength(b, "utf8") - Buffer.byteLength(a, "utf8"));
  }
  const ALL_PROBLEMS = Object.keys(EVERY_PROBLEM) as ImportDescribeProblem[];
  const names = maximalNames(allYouthRuleNames("descriptor"));
  /** The full prompt's longest retry: every problem the next attempt can be told that keeps the body request (an empty or unreadable answer drops it), and the rule names. */
  const worst: ImportDescribeRefusal = { problems: ALL_PROBLEMS.filter((p) => p !== "not-json" && p !== "empty"), words: names };
  /** The no-body prompt's longest retry: every problem, the unreadable ones included, and the rule names. */
  const worstNoBody: ImportDescribeRefusal = { problems: ALL_PROBLEMS, words: names };
  const ceiling = importDescribeCall("x-ai/grok-4.3").inputTokens;
  /** What the pin keeps clear of the ceiling: room for a later rule (S5.2b spent the first 1,024 of 8K on the body request and raised the ceiling to 9K). */
  const MARGIN = 500;
  const floorOf = (refusal: ImportDescribeRefusal): number => promptTokenFloor({ messages: importDescribeMessages(refusal), jsonSchema: importDescribeJsonSchema(refusal), images: 1 });
  const toldOf = (refusal: ImportDescribeRefusal): string[] => {
    const text = String(importDescribeMessages(refusal)[1]?.content);
    const reason = /words we do not allow: ([^;]*);/.exec(text)?.[1] ?? "";
    return [...reason.matchAll(/"([^"]+)"/g)].map((m) => m[1] as string);
  };

  test("the worst refusal is given every problem that keeps the body request and the most rule names the bound lets through, the longest first", () => {
    expect(worst.problems).toHaveLength(12);
    expect(worstNoBody.problems).toHaveLength(14);
    expect(worst.words.length).toBeGreaterThan(3);
    expect(Buffer.byteLength(worst.words[0] as string, "utf8")).toBeGreaterThanOrEqual(Buffer.byteLength(worst.words.at(-1) as string, "utf8"));
    expect(worst.words.reduce((sum, name) => sum + writtenBytes(name), 0)).toBeLessThanOrEqual(IMPORT_DESCRIBE_WORDS_BYTES_MAX);
  });

  test("no name can be added to the worst list without passing the bound: it is maximal", () => {
    const written = worst.words.reduce((sum, name) => sum + writtenBytes(name), 0);
    for (const name of allYouthRuleNames("descriptor")) if (!worst.words.includes(name)) expect(written + writtenBytes(name)).toBeGreaterThan(IMPORT_DESCRIBE_WORDS_BYTES_MAX);
  });

  test("the worst list is told whole", () => {
    expect(toldOf(worst)).toEqual(worst.words);
  });

  // The names are bounded by their bytes, not by a count: six long Cyrillic names are ~135 bytes, six short English ones ~55 (the first pin took the short ones).
  test(`a retry tells names up to ${IMPORT_DESCRIBE_WORDS_BYTES_MAX} bytes as they are written («"name", »), in the order they came, and stops before the one that would pass it`, () => {
    const every = byBytesDescending(allYouthRuleNames("descriptor"));
    const told = toldOf({ problems: ["youth-word"], words: every });
    const written = told.reduce((sum, name) => sum + writtenBytes(name), 0);
    expect(told).toEqual(every.slice(0, told.length));
    expect(told.length).toBeGreaterThan(0);
    expect(written).toBeLessThanOrEqual(IMPORT_DESCRIBE_WORDS_BYTES_MAX);
    const next = every[told.length] as string;
    expect(written + writtenBytes(next)).toBeGreaterThan(IMPORT_DESCRIBE_WORDS_BYTES_MAX);
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

  test("the longest prompt a describe can send, with the body request or without it, stays at least 500 tokens under the ceiling the estimate priced", () => {
    expect(floorOf(worst)).toBeLessThanOrEqual(ceiling - MARGIN);
    expect(floorOf(worstNoBody)).toBeLessThanOrEqual(ceiling - MARGIN);
  });

  // EXACT, like the writer's pins: any extra byte in the prompt, the schema or a reason moves the margin and fails this, so the prompt cannot creep toward the ceiling unseen.
  // Re-measure when the describe prompt changes.
  test("the worst prompt with the body request keeps its measured margin under the ceiling", () => {
    expect(String(importDescribeMessages(worst)[0]?.content)).toContain("Body: answer each");
    expect(ceiling - floorOf(worst)).toBe(FULL_MARGIN);
  });

  test("the worst prompt without the body request keeps its measured margin under the ceiling", () => {
    expect(String(importDescribeMessages(worstNoBody)[0]?.content)).not.toContain("Body: answer each");
    expect(ceiling - floorOf(worstNoBody)).toBe(NO_BODY_MARGIN);
  });

  test("the pin measures: a refusal with nothing to tell is smaller than the worst", () => {
    expect(floorOf({ problems: [], words: [] })).toBeLessThan(floorOf(worst));
  });
});

const FULL_MARGIN = 757;
const NO_BODY_MARGIN = 2023;
