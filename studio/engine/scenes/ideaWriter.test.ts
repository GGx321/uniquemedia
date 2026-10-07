import { describe, expect, test } from "bun:test";
import { SceneWriteTarget } from "../../shared/engine";
import { WRITER_CALL } from "../money/estimate";
import { promptTokenFloor } from "../openrouter/chat";
import { IDEA_JSON_SCHEMA, ideaJsonSchema, ideaMessages, ideaSystemPrompt, readIdeaAnswer, type FixedIdeaSlot, type IdeaSlot } from "./ideaWriter";
import { readWriterAnswer, writerMessages, writerRefusalText, type WriterRefusal } from "./writer";
import { plan } from "./planner";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4b: the idea variant of the scene writer. «+ Своя сцена» sends the owner's idea (any script) and the writer composes English sentences; its system
// prompt is its own, so the compose prompt (scenes/writer.ts, byte-pinned by writer.custom.test.ts) is untouched. The answer is read by the writer's own
// `readWriterAnswer`, so every rule that holds for a planned sentence (adult words, revealing words, the phone hand, the pose) holds for an own one.

const slots: FixedIdeaSlot[] = [
  { slotIndex: 7, idea: "кофе на балконе утром", shot: "friend", pose: "three-quarter" },
  { slotIndex: 8, idea: "кофе на балконе утром", shot: "selfie", pose: "front" },
];

function userContent(messages: ReturnType<typeof ideaMessages>): string {
  return messages.find((m) => m.role === "user")?.content ?? "";
}

describe("ideaMessages", () => {
  test("is a system message and a user message", () => {
    expect(ideaMessages(slots).map((m) => m.role)).toEqual(["system", "user"]);
  });

  test("carries the owner's idea verbatim, in its own script, for every slot", () => {
    const user = userContent(ideaMessages(slots));
    expect(user).toContain("кофе на балконе утром");
    expect(user).not.toContain("\\u04");
  });

  test("names each slot's number, shot and pose the way the compose prompt does", () => {
    const user = userContent(ideaMessages(slots));
    const parsed = JSON.parse(user.slice(user.indexOf("["), user.lastIndexOf("]") + 1));
    expect(parsed).toEqual([
      { slotIndex: 7, idea: "кофе на балконе утром", shot: "photo taken by a friend", pose: "a three-quarter view, turned slightly from the camera" },
      { slotIndex: 8, idea: "кофе на балконе утром", shot: "front-camera selfie", pose: "facing the camera" },
    ]);
  });

  test("has its own system prompt, not the compose one", () => {
    const compose = writerMessages(plan({ seed: 1, count: 1, categories: ["home"] }).slots)[0]?.content;
    expect(ideaMessages(slots)[0]?.content).toBe(ideaSystemPrompt());
    expect(ideaSystemPrompt()).not.toBe(compose);
  });

  test("tells the writer the idea may be in any language and the sentence is English", () => {
    const prompt = ideaSystemPrompt();
    expect(prompt).toContain("any language");
    expect(prompt).toContain("English");
  });

  test("keeps the compose prompt's standing rules line for line: the woman, the phone hand, the pose, the adult rule, the clothing list, no text, no praise words", () => {
    const compose = (writerMessages(plan({ seed: 1, count: 1, categories: ["home"] }).slots)[0]?.content ?? "").split("\n");
    const idea = ideaSystemPrompt().split("\n");
    const standing = compose.filter((line) => /^You write|^Reference images|phone|Match each slot|grown adult|^- No revealing clothing|^- No text|Never use "stunning"/.test(line));
    expect(standing.length).toBe(8);
    for (const line of standing) {
      // The revealing-clothing line ends differently on purpose: the outfit is not "given" in an idea write.
      const wanted = line.startsWith("- No revealing clothing") ? line.slice(0, line.indexOf("whatever")) : line;
      expect(idea.some((l) => l.startsWith(wanted))).toBe(true);
    }
  });

  test("tells the writer to vary scenes that share an idea", () => {
    expect(ideaSystemPrompt()).toContain("different moment");
  });

  test("carries nothing of the avatar: the user message holds the slots and nothing else", () => {
    const user = userContent(ideaMessages(slots));
    expect(user.split("\n")[0]).toBe("Ideas:");
    expect(Object.keys(JSON.parse(user.slice(user.indexOf("["), user.lastIndexOf("]") + 1))[0]).sort()).toEqual(["idea", "pose", "shot", "slotIndex"]);
  });

  test("after a refusal it says why, in the compose prompt's own words", () => {
    const refusal: WriterRefusal = { problems: ["revealing-word"], missingSlots: [], twoHandedSlots: [], wordSlots: [8], words: ["bikini"], poseSlots: [] };
    const user = userContent(ideaMessages(slots, refusal));
    expect(user).toContain(`An earlier answer was rejected: ${writerRefusalText(refusal)}`);
  });
});

// ---------- CS.8a: the model picks the angle ----------

const AUTO: IdeaSlot = { slotIndex: 5, idea: "лежит на животе, вид сзади", shot: null, pose: null };
const SHOT_GIVEN: IdeaSlot = { slotIndex: 6, idea: "лежит на животе, вид сзади", shot: "friend", pose: null };
const MIRROR_GIVEN: IdeaSlot = { slotIndex: 7, idea: "лежит на животе, вид сзади", shot: "mirror", pose: null };
const FIXED: IdeaSlot = { slotIndex: 8, idea: "лежит на животе, вид сзади", shot: "candid", pose: "back" };
const SENTENCE = "She lies on her stomach on a sunlit bed, one ankle crossed over the other, a paperback open beside her pillow.";

function items(messages: ReturnType<typeof ideaMessages>): Record<string, unknown>[] {
  const user = userContent(messages);
  return JSON.parse(user.slice(user.indexOf("["), user.lastIndexOf("]") + 1));
}

describe("ideaMessages: a slot whose angle the model picks", () => {
  test("an Auto slot asks for both: the shot and the pose are «choose»", () => {
    expect(items(ideaMessages([AUTO]))).toEqual([{ slotIndex: 5, idea: "лежит на животе, вид сзади", shot: "choose", pose: "choose" }]);
  });

  test("a slot whose shot the owner chose names it and asks for the pose only", () => {
    expect(items(ideaMessages([SHOT_GIVEN]))).toEqual([{ slotIndex: 6, idea: "лежит на животе, вид сзади", shot: "photo taken by a friend", pose: "choose" }]);
  });

  test("a slot that gives both (an own scene written again) is told as before", () => {
    expect(items(ideaMessages([FIXED]))).toEqual([{ slotIndex: 8, idea: "лежит на животе, вид сзади", shot: "candid shot, not looking at the camera", pose: "from behind, her face not visible" }]);
  });

  test("the system prompt explains «choose»: from the idea, in the schema's words, back for a view from behind, null for what is given", () => {
    const prompt = ideaSystemPrompt();
    for (const needle of ['"choose"', "friend, selfie, candid or photographer", "front, three-quarter, profile or back", '"back"', "null"]) expect(prompt).toContain(needle);
  });

  test("the system prompt keeps the pairing rule and never offers the mirror", () => {
    const prompt = ideaSystemPrompt();
    expect(prompt).toContain("A selfie always faces the camera");
    expect(prompt).toContain("Never choose the mirror");
  });
});

describe("IDEA_JSON_SCHEMA", () => {
  type Node = { type?: string | string[]; additionalProperties?: boolean; required?: string[]; properties?: Record<string, Node>; items?: Node; enum?: (string | null)[] };
  const scene = ((IDEA_JSON_SCHEMA.schema as Node).properties?.scenes?.items ?? {}) as Node;

  test("is the strict schema named scene_ideas", () => {
    expect(IDEA_JSON_SCHEMA.name).toBe("scene_ideas");
    expect(scene.additionalProperties).toBe(false);
  });

  test("asks for the number, the sentence, and the shot and the pose (null when the slot gave them), all required", () => {
    expect([...(scene.required ?? [])].sort()).toEqual(["pose", "sentence", "shot", "slotIndex"]);
    expect(Object.keys(scene.properties ?? {}).sort()).toEqual(["pose", "sentence", "shot", "slotIndex"]);
  });

  test("the shot may be any but the mirror, the pose any of the four, and both may be null", () => {
    expect(scene.properties?.shot?.enum).toEqual(["friend", "selfie", "candid", "photographer", null]);
    expect(scene.properties?.pose?.enum).toEqual(["front", "three-quarter", "profile", "back", null]);
  });
});

describe("readIdeaAnswer", () => {
  const answer = (...scenes: Record<string, unknown>[]) => JSON.stringify({ scenes });

  test("an Auto slot's shot and pose are the model's", () => {
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence: SENTENCE, shot: "candid", pose: "back" }), [AUTO]);
    expect(read.ok && read.angles.get(5)).toEqual({ shot: "candid", pose: "back" });
    expect(read.ok && read.sentences.get(5)).toBe(SENTENCE);
  });

  test("a slot whose shot the owner chose keeps the shot and takes the model's pose", () => {
    const read = readIdeaAnswer(answer({ slotIndex: 6, sentence: SENTENCE, shot: null, pose: "back" }), [SHOT_GIVEN]);
    expect(read.ok && read.angles.get(6)).toEqual({ shot: "friend", pose: "back" });
  });

  test("a slot whose shot the owner chose ignores another shot in the answer", () => {
    const read = readIdeaAnswer(answer({ slotIndex: 6, sentence: SENTENCE, shot: "photographer", pose: "profile" }), [SHOT_GIVEN]);
    expect(read.ok && read.angles.get(6)).toEqual({ shot: "friend", pose: "profile" });
  });

  test("a slot that gave both keeps both, whatever the answer says", () => {
    const read = readIdeaAnswer(answer({ slotIndex: 8, sentence: SENTENCE, shot: "selfie", pose: "front" }), [FIXED]);
    expect(read.ok && read.angles.get(8)).toEqual({ shot: "candid", pose: "back" });
  });

  test("a slot that gave both needs no shot or pose key at all", () => {
    expect(readIdeaAnswer(answer({ slotIndex: 8, sentence: SENTENCE }), [FIXED]).ok).toBe(true);
  });

  test.each([
    ["a mirror the owner did not choose", { shot: "mirror", pose: "front" }],
    ["a selfie facing away", { shot: "selfie", pose: "back" }],
    ["a selfie in profile", { shot: "selfie", pose: "profile" }],
    ["a shot outside the vocabulary", { shot: "drone", pose: "front" }],
    ["a pose outside the vocabulary", { shot: "friend", pose: "upside-down" }],
    ["no pose", { shot: "friend", pose: null }],
    ["no shot", { shot: null, pose: "back" }],
    ["neither key", {}],
  ])("an Auto slot with %s is refused as a bad angle, naming the slot", (_name, angle) => {
    expect(readIdeaAnswer(answer({ slotIndex: 5, sentence: SENTENCE, ...angle }), [AUTO])).toMatchObject({ ok: false, problems: ["bad-angle"], angleSlots: [5] });
  });

  test.each([
    ["a mirror shot facing away", "back"],
    ["a mirror shot in profile", "profile"],
    ["no pose", null],
  ])("a slot whose shot is the mirror, with %s, is refused", (_name, pose) => {
    expect(readIdeaAnswer(answer({ slotIndex: 7, sentence: SENTENCE, shot: null, pose }), [MIRROR_GIVEN])).toMatchObject({ ok: false, problems: ["bad-angle"], angleSlots: [7] });
  });

  test("a mirror the owner chose is kept, with a pose that faces the camera", () => {
    const read = readIdeaAnswer(answer({ slotIndex: 7, sentence: "She admires her outfit in a tall mirror, one hand on the phone.", shot: null, pose: "three-quarter" }), [MIRROR_GIVEN]);
    expect(read.ok && read.angles.get(7)).toEqual({ shot: "mirror", pose: "three-quarter" });
  });

  test("the sentence is read against the angle the model chose: a back pose looking at the camera is refused", () => {
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence: "She lies on her stomach, looking at the camera.", shot: "candid", pose: "back" }), [AUTO]);
    expect(read).toMatchObject({ ok: false, problems: ["pose-contradiction"], poseSlots: [5] });
  });

  test("the sentence is read against the shot the model chose: a two-handed selfie is refused", () => {
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence: "She holds the cup with both hands.", shot: "selfie", pose: "front" }), [AUTO]);
    expect(read).toMatchObject({ ok: false, problems: ["two-handed"], twoHandedSlots: [5] });
  });

  test("a missing scene and a youth word are refused as in every writer answer", () => {
    expect(readIdeaAnswer(answer({ slotIndex: 5, sentence: SENTENCE, shot: "candid", pose: "back" }), [AUTO, SHOT_GIVEN])).toMatchObject({ ok: false, problems: ["missing-slots"], missingSlots: [6] });
    expect(readIdeaAnswer(answer({ slotIndex: 5, sentence: "A teenage girl lies on a bed.", shot: "candid", pose: "back" }), [AUTO])).toMatchObject({ ok: false, problems: ["youth-word"] });
  });

  test("not JSON and an unknown key are refused", () => {
    expect(readIdeaAnswer("nope", [AUTO])).toMatchObject({ ok: false, problems: ["not-json"] });
    expect(readIdeaAnswer(answer({ slotIndex: 5, sentence: SENTENCE, shot: "candid", pose: "back", mood: "x" }), [AUTO])).toMatchObject({ ok: false, problems: ["not-json"] });
  });

  test("a refusal for an angle is told in fixed words with the slot numbers", () => {
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence: SENTENCE, shot: "mirror", pose: "front" }), [AUTO]);
    if (read.ok) throw new Error("expected a refusal");
    const text = writerRefusalText(read);
    expect(text).toContain("slot(s) 5");
    expect(text).toContain("front or three-quarter");
  });
});

// ---------- CS.8a: the mirror, only when the idea names one ----------

describe("the mirror on «Авто»", () => {
  const MIRROR_IDEA: IdeaSlot = { slotIndex: 9, idea: "селфи в зеркале лифта", shot: null, pose: null };
  const reply = (shot: string, pose: string) => JSON.stringify({ scenes: [{ slotIndex: 9, sentence: "She takes a selfie in a tall elevator mirror, one hand on the phone.", shot, pose }] });

  test("the prompt never offers the mirror when the idea does not name one", () => {
    const prompt = ideaSystemPrompt(false);
    expect(prompt).toBe(ideaSystemPrompt());
    expect(prompt).toContain("friend, selfie, candid or photographer");
    expect(prompt).toContain("Never choose the mirror");
  });

  test("it offers the mirror when the idea names one, and says it faces the camera", () => {
    const prompt = ideaSystemPrompt(true);
    expect(prompt).toContain("friend, selfie, mirror, candid or photographer");
    expect(prompt).not.toContain("Never choose the mirror");
    expect(prompt).toContain("mirror shot");
  });

  test("the schema's shots include the mirror only then", () => {
    type Node = { properties?: Record<string, Node>; items?: Node; enum?: (string | null)[] };
    const shots = (schema: { schema: Record<string, unknown> }) => ((schema.schema as Node).properties?.scenes?.items?.properties?.shot?.enum ?? []);
    expect(shots(ideaJsonSchema(false))).toEqual(["friend", "selfie", "candid", "photographer", null]);
    expect(shots(ideaJsonSchema(true))).toEqual(["friend", "selfie", "mirror", "candid", "photographer", null]);
    expect(ideaJsonSchema(true).name).toBe("scene_ideas");
    expect(IDEA_JSON_SCHEMA).toEqual(ideaJsonSchema(false));
  });

  test("an answer that picks the mirror is refused when the idea named none, however sound the rest", () => {
    expect(readIdeaAnswer(reply("mirror", "front"), [MIRROR_IDEA])).toMatchObject({ ok: false, problems: ["bad-angle"], angleSlots: [9] });
    expect(readIdeaAnswer(reply("mirror", "front"), [MIRROR_IDEA], false)).toMatchObject({ ok: false, problems: ["bad-angle"] });
  });

  test("and taken when it did: the mirror with a pose that faces the camera", () => {
    const read = readIdeaAnswer(reply("mirror", "three-quarter"), [MIRROR_IDEA], true);
    expect(read.ok && read.angles.get(9)).toEqual({ shot: "mirror", pose: "three-quarter" });
  });

  test("the pairing rule holds with it: a mirror shot facing away is refused even when the mirror is allowed", () => {
    expect(readIdeaAnswer(reply("mirror", "back"), [MIRROR_IDEA], true)).toMatchObject({ ok: false, problems: ["bad-angle"] });
    expect(readIdeaAnswer(reply("mirror", "profile"), [MIRROR_IDEA], true)).toMatchObject({ ok: false, problems: ["bad-angle"] });
  });

  test("allowing it does not make the other picks easier: no pick, a selfie from behind", () => {
    expect(readIdeaAnswer(reply("selfie", "back"), [MIRROR_IDEA], true)).toMatchObject({ ok: false, problems: ["bad-angle"] });
  });

  test("the messages carry the prompt that matches", () => {
    expect(ideaMessages([MIRROR_IDEA], undefined, true)[0]?.content).toBe(ideaSystemPrompt(true));
    expect(ideaMessages([MIRROR_IDEA])[0]?.content).toBe(ideaSystemPrompt(false));
  });
});

describe("readWriterAnswer reads an idea's answer by the same rules", () => {
  const answer = (...scenes: { slotIndex: number; sentence: string }[]) => JSON.stringify({ scenes });
  const GOOD = "She sits on a small balcony in the morning light, her other hand resting on the railing as steam rises from the cup.";

  test("accepts one sentence per own scene", () => {
    const read = readWriterAnswer(answer({ slotIndex: 7, sentence: GOOD }, { slotIndex: 8, sentence: GOOD }), slots);
    expect(read.ok).toBe(true);
  });

  test("refuses a missing scene, an unknown scene and a repeated scene", () => {
    expect(readWriterAnswer(answer({ slotIndex: 7, sentence: GOOD }), slots)).toMatchObject({ ok: false, problems: ["missing-slots"], missingSlots: [8] });
    expect(readWriterAnswer(answer({ slotIndex: 7, sentence: GOOD }, { slotIndex: 8, sentence: GOOD }, { slotIndex: 9, sentence: GOOD }), slots)).toMatchObject({ ok: false, problems: ["unknown-slot"] });
    expect(readWriterAnswer(answer({ slotIndex: 7, sentence: GOOD }, { slotIndex: 7, sentence: GOOD }, { slotIndex: 8, sentence: GOOD }), slots)).toMatchObject({ ok: false, problems: ["duplicate-slot"] });
  });

  test("refuses a youth word, a revealing word, a two-handed selfie and a back pose looking at the camera", () => {
    expect(readWriterAnswer(answer({ slotIndex: 7, sentence: "A teenage girl smiles." }, { slotIndex: 8, sentence: GOOD }), slots)).toMatchObject({ ok: false, problems: ["youth-word"] });
    expect(readWriterAnswer(answer({ slotIndex: 7, sentence: GOOD }, { slotIndex: 8, sentence: "She wears a bikini." }), slots)).toMatchObject({ ok: false, problems: ["revealing-word"] });
    expect(readWriterAnswer(answer({ slotIndex: 7, sentence: GOOD }, { slotIndex: 8, sentence: "She holds the cup with both hands." }), slots)).toMatchObject({ ok: false, problems: ["two-handed"], twoHandedSlots: [8] });
    const back: FixedIdeaSlot[] = [{ slotIndex: 3, idea: "walk", shot: "friend", pose: "back" }];
    expect(readWriterAnswer(answer({ slotIndex: 3, sentence: "She walks away, looking at the camera." }), back)).toMatchObject({ ok: false, problems: ["pose-contradiction"] });
  });
});

describe("the idea prompt's floor", () => {
  const CEILING = WRITER_CALL.inputTokens;
  const MARGIN = 200;
  /** 160 distinct 16-byte words of the four widest kinds: more than the feedback will tell, which clips them. */
  const hostileWords = Array.from({ length: 40 }, (_, i) => {
    const n = String(i).padStart(4, "0");
    return [`${"W".repeat(12)}${n}`, `${"Я".repeat(6)}${n}`, `${"😀".repeat(3)}${n}`, `${"é".repeat(6)}${n}`];
  }).flat();
  const worstRefusal = (indices: readonly number[]): WriterRefusal => ({
    problems: ["not-json", "empty", "missing-slots", "unknown-slot", "duplicate-slot", "two-handed", "youth-word", "revealing-word", "pose-contradiction", "bad-angle"],
    missingSlots: indices.slice(-1),
    twoHandedSlots: indices.slice(0, -1),
    wordSlots: indices.slice(0, -1),
    poseSlots: indices.slice(0, -1),
    angleSlots: indices.slice(0, -1),
    words: hostileWords,
  });

  test("five own scenes with 500-char Cyrillic ideas, asked again after the worst refusal, stay at least 200 tokens under the 14K ceiling", () => {
    const worst: IdeaSlot[] = Array.from({ length: 5 }, (_, i) => ({ slotIndex: 10_000 - i, idea: "я".repeat(500), shot: "mirror", pose: "three-quarter" }));
    const messages = ideaMessages(worst, worstRefusal(worst.map((s) => s.slotIndex)));
    expect(promptTokenFloor({ messages, jsonSchema: IDEA_JSON_SCHEMA, images: 0 })).toBeLessThanOrEqual(CEILING - MARGIN);
  });

  test("the heaviest idea the contract lets through (500 three-byte characters, the bound of SCENE_IDEA_BYTES_PER_CHAR) is still under the ceiling with the worst refusal", () => {
    expect(SceneWriteTarget.safeParse({ kind: "idea", idea: "中".repeat(500), count: 5, shot: null }).success).toBe(true);
    const worst: IdeaSlot[] = Array.from({ length: 5 }, (_, i) => ({ slotIndex: 10_000 - i, idea: "中".repeat(500), shot: "mirror", pose: "three-quarter" }));
    const messages = ideaMessages(worst, worstRefusal(worst.map((s) => s.slotIndex)));
    expect(promptTokenFloor({ messages, jsonSchema: IDEA_JSON_SCHEMA, images: 0 })).toBeLessThanOrEqual(CEILING - MARGIN);
  });

  test("an idea of control characters, which would JSON-escape to six bytes each and break the pin, never reaches the prompt: the contract refuses it", () => {
    const heavy: IdeaSlot[] = Array.from({ length: 5 }, (_, i) => ({ slotIndex: 10_000 - i, idea: "\u0001".repeat(500), shot: "mirror", pose: "three-quarter" }));
    const floor = promptTokenFloor({ messages: ideaMessages(heavy, worstRefusal(heavy.map((s) => s.slotIndex))), jsonSchema: IDEA_JSON_SCHEMA, images: 0 });
    expect(floor).toBeGreaterThan(CEILING - MARGIN);
    expect(SceneWriteTarget.safeParse({ kind: "idea", idea: "\u0001".repeat(500), count: 5, shot: null }).success).toBe(false);
  });
});
