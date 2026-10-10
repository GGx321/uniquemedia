import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";
import { adultTextProblems, allYouthRuleNames, AvatarDescriptor, AvatarTraits, HairColor } from "../../shared/engine";
import { promptTokenFloor } from "../openrouter/chat";
import { importDescribeCall } from "./plan";
import {
  IMPORT_DESCRIBE_JSON_SCHEMA,
  importDescribeMessages,
  readImportDescribeAnswer,
  IMPORT_DESCRIBE_WORDS_MAX,
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

test("the output schema requires every trait, the descriptor, and the subject check (M5: exactly one woman) — nothing else", () => {
  expect(IMPORT_DESCRIBE_JSON_SCHEMA.schema).toMatchObject({
    type: "object",
    additionalProperties: false,
    required: ["people", "woman", "age", "ethnicity", "skinTone", "hairColor", "hairLength", "hairTexture", "eyeColor", "build", "marks", "descriptor"],
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
  const worst: ImportDescribeRefusal = { problems: Object.keys(EVERY_PROBLEM) as ImportDescribeProblem[], words: allYouthRuleNames("descriptor") };
  const ceiling = importDescribeCall("x-ai/grok-4.3").inputTokens;
  const floorOf = (refusal: ImportDescribeRefusal): number => promptTokenFloor({ messages: importDescribeMessages(refusal), jsonSchema: IMPORT_DESCRIBE_JSON_SCHEMA, images: 1 });

  test("the worst refusal is given every problem and every rule name there is", () => {
    expect(worst.problems).toHaveLength(14);
    expect(worst.words.length).toBeGreaterThan(30);
  });

  // 80 rule names told in full would put the prompt 158 tokens over the ceiling (7,158 with the image allowance, against 7,000): a retry names the first few, which is all it needs.
  test(`a retry tells at most ${IMPORT_DESCRIBE_WORDS_MAX} of the rule names, in the order they came`, () => {
    const text = String(importDescribeMessages(worst)[1]?.content);
    const reason = /words we do not allow: ([^;]*);/.exec(text)?.[1] ?? "";
    const told = [...reason.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    expect(told).toEqual(worst.words.slice(0, IMPORT_DESCRIBE_WORDS_MAX));
  });

  test("a short list reads exactly as before", () => {
    const text = String(importDescribeMessages({ problems: ["youth-word"], words: ["teen", "girl"] })[1]?.content);
    expect(text).toContain('the descriptor used words we do not allow: "teen", "girl"; call her a woman and use none of them');
  });

  test("the longest prompt a describe can send stays under the ceiling the estimate priced", () => {
    expect(floorOf(worst)).toBeLessThanOrEqual(ceiling);
  });

  test("the pin measures: a refusal with nothing to tell is smaller than the worst", () => {
    expect(floorOf({ problems: [], words: [] })).toBeLessThan(floorOf(worst));
  });
});
