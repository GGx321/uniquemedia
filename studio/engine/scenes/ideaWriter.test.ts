import { describe, expect, test } from "bun:test";
import { SceneWriteTarget } from "../../shared/engine";
import { WRITER_CALL } from "../money/estimate";
import { promptTokenFloor } from "../openrouter/chat";
import { IDEA_JSON_SCHEMA, ideaJsonSchema, ideaMessages, ideaSystemPrompt, readIdeaAnswer, type FixedIdeaSlot, type IdeaSlot } from "./ideaWriter";
import { POSE_LABEL, readWriterAnswer, SHOT_LABEL, writerMessages, writerRefusalText, type WriterRefusal } from "./writer";
import type { Pose } from "./schema";
import type { Shot } from "./types";
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
      { slotIndex: 7, idea: "кофе на балконе утром", shot: "a phone snap a friend took", pose: "a three-quarter view, turned slightly from the viewer" },
      { slotIndex: 8, idea: "кофе на балконе утром", shot: "her own arm's-length photo", pose: "facing the viewer" },
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
    const standing = compose.filter((line) => /^You write|^Reference images|only one hand is free|Match each slot|grown adult|^- No text|^- Never write about|^- When she looks|^- No paper|^- Never describe mess|^- Never use these words/.test(line));
    expect(standing.length).toBe(11);
    for (const line of standing) expect(idea).toContain(line);
    // The clothing line differs on purpose: the outfit is not "given" in an idea write, so it keeps its covering sentence (C-8).
    expect(idea.some((l) => l.startsWith("- No revealing clothing (no bikini, swimsuit, swimwear, lingerie, sports bra, thong, stockings or a robe over lingerie): whatever the idea says"))).toBe(true);
  });

  test("S5.1b: the idea writer is told what the compose writer is: an ordinary phone photo, one ordinary detail, the light by its source, no camera talk", () => {
    const prompt = ideaSystemPrompt();
    expect(prompt).toContain("You write one plain sentence of what an ordinary phone photo of her shows, for each of the given slots, of one recurring adult woman who posts her own photos.");
    expect(prompt).toContain("and never describe her hair, eyes or body type");
    expect(prompt).toContain("her expression, and at most one ordinary detail of the place. Do not describe the light, the colours or the mood; if light comes up, name only its source.");
    expect(prompt).toContain("vary the place, her outfit and what she does.");
    expect(prompt).not.toContain("the time of day");
    expect(prompt).toContain("When she looks toward whoever takes the photo, write that she looks at the viewer; never name a phone, camera or lens for her gaze. Her own phone appears only when the slot's activity uses it.");
    expect(prompt).toContain("For any other pose she may face or glance toward the viewer as the shot allows.");
    expect(prompt).not.toContain('"the phone" in a gaze');
    expect(prompt).not.toContain("photorealistic");
    expect(prompt).not.toContain('Never use "stunning"');
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
    expect(items(ideaMessages([SHOT_GIVEN]))).toEqual([{ slotIndex: 6, idea: "лежит на животе, вид сзади", shot: "a phone snap a friend took", pose: "choose" }]);
  });

  test("a slot that gives both (an own scene written again) is told as before", () => {
    expect(items(ideaMessages([FIXED]))).toEqual([{ slotIndex: 8, idea: "лежит на животе, вид сзади", shot: "a friend's snap while she is busy", pose: "from behind, her face not visible" }]);
  });

  test("the system prompt explains «choose»: from the idea, in the schema's words, back for a view from behind, null for what is given", () => {
    const prompt = ideaSystemPrompt();
    for (const needle of ['"choose"', "friend, selfie or candid", "front, three-quarter, profile or back", '"back"', "kept as given"]) expect(prompt).toContain(needle);
  });

  test("«Авто» never offers the photographer: own scenes are finished as phone photos, and the prompt says so by not offering it", () => {
    for (const mirrorAllowed of [false, true]) {
      const choose = ideaSystemPrompt(mirrorAllowed).split("\n").find((line) => line.includes('"choose"')) ?? "";
      expect(choose).not.toContain("photographer");
    }
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

  test("asks for the number, the sentence, and the shot and the pose when both are the model's, all required", () => {
    expect([...(scene.required ?? [])].sort()).toEqual(["pose", "sentence", "shot", "slotIndex"]);
    expect(Object.keys(scene.properties ?? {}).sort()).toEqual(["pose", "sentence", "shot", "slotIndex"]);
  });

  test("the shot may be any but the mirror and the photographer, the pose any of the four, and neither is nullable", () => {
    expect(scene.properties?.shot?.enum).toEqual(["friend", "selfie", "candid"]);
    expect(scene.properties?.pose?.enum).toEqual(["front", "three-quarter", "profile", "back"]);
    expect(scene.properties?.shot?.type).toBe("string");
    expect(scene.properties?.pose?.type).toBe("string");
  });
});

describe("ideaJsonSchema: built per write from what the model is asked (no nulls anywhere)", () => {
  type Node = { type?: string | string[]; required?: string[]; properties?: Record<string, Node>; items?: Node; enum?: (string | null)[] };
  const sceneOf = (schema: { schema: Record<string, unknown> }) => ((schema.schema as Node).properties?.scenes?.items ?? {}) as Node;
  const keys = (schema: { schema: Record<string, unknown> }) => Object.keys(sceneOf(schema).properties ?? {}).sort();

  test.each([
    ["both asked", { shot: true, pose: true }, ["pose", "sentence", "shot", "slotIndex"]],
    ["only the pose asked (the owner chose the shot)", { shot: false, pose: true }, ["pose", "sentence", "slotIndex"]],
    ["only the shot asked", { shot: true, pose: false }, ["sentence", "shot", "slotIndex"]],
    ["neither asked (an own scene written again)", { shot: false, pose: false }, ["sentence", "slotIndex"]],
  ])("%s: the keys are exactly the asked ones, and all of them are required", (_name, asks, expected) => {
    const schema = ideaJsonSchema(false, asks);
    expect(keys(schema)).toEqual(expected);
    expect([...(sceneOf(schema).required ?? [])].sort()).toEqual(expected);
  });

  test.each([true, false])("no property of the schema is nullable and no enum holds null (mirror allowed: %s)", (mirrorAllowed) => {
    for (const asks of [{ shot: true, pose: true }, { shot: false, pose: true }, { shot: true, pose: false }, { shot: false, pose: false }]) {
      expect(JSON.stringify(ideaJsonSchema(mirrorAllowed, asks).schema)).not.toContain("null");
    }
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

  test("«Авто» never picks the photographer: an answer that does is a bad angle", () => {
    expect(readIdeaAnswer(answer({ slotIndex: 5, sentence: SENTENCE, shot: "photographer", pose: "back" }), [AUTO])).toMatchObject({ ok: false, problems: ["bad-angle"], angleSlots: [5] });
  });

  test("a photographer the owner chose stays, with the model's pose", () => {
    const chosen: IdeaSlot = { slotIndex: 6, idea: "лежит на животе, вид сзади", shot: "photographer", pose: null };
    const read = readIdeaAnswer(answer({ slotIndex: 6, sentence: SENTENCE, pose: "back" }), [chosen]);
    expect(read.ok && read.angles.get(6)).toEqual({ shot: "photographer", pose: "back" });
  });

  test("a slot whose shot the owner chose needs no shot key in the answer, as the per-write schema has none", () => {
    const read = readIdeaAnswer(answer({ slotIndex: 6, sentence: SENTENCE, pose: "profile" }), [SHOT_GIVEN]);
    expect(read.ok && read.angles.get(6)).toEqual({ shot: "friend", pose: "profile" });
  });

  test("an Auto slot whose answer leaves a key out is a bad angle, not a guess", () => {
    expect(readIdeaAnswer(answer({ slotIndex: 5, sentence: SENTENCE, pose: "back" }), [AUTO])).toMatchObject({ ok: false, problems: ["bad-angle"], angleSlots: [5] });
    expect(readIdeaAnswer(answer({ slotIndex: 5, sentence: SENTENCE, shot: "candid" }), [AUTO])).toMatchObject({ ok: false, problems: ["bad-angle"], angleSlots: [5] });
  });

  test("a refusal for an angle is told in fixed words with the slot numbers", () => {
    const read = readIdeaAnswer(answer({ slotIndex: 5, sentence: SENTENCE, shot: "mirror", pose: "front" }), [AUTO]);
    if (read.ok) throw new Error("expected a refusal");
    const text = writerRefusalText(read);
    expect(text).toContain("slot(s) 5");
    expect(text).toContain("front or three-quarter");
  });
});

// ---------- CS.8a fix round 1: the bad-angle reason fits every case ----------

describe("the bad-angle retry reason is neutral: it holds for «Авто», for an idea that names a mirror, and for an owner's mirror", () => {
  const refusal: WriterRefusal = { problems: ["bad-angle"], missingSlots: [], twoHandedSlots: [], wordSlots: [], words: [], poseSlots: [], angleSlots: [5] };
  const NEUTRAL = "gave a shot or a pose that is missing, outside the lists the rules give, or a selfie or mirror shot not facing the camera (front or three-quarter only)";

  test("names the slots and says the neutral reason", () => {
    const text = writerRefusalText(refusal);
    expect(text).toContain("slot(s) 5");
    expect(text).toContain(NEUTRAL);
  });

  test("never forbids the mirror and never lists the shots by hand: the rules in the system prompt do", () => {
    const text = writerRefusalText(refusal);
    expect(text).not.toContain("never the mirror");
    expect(text).not.toContain("friend, selfie, candid or photographer");
    expect(text).not.toContain("photographer");
  });

  test.each([
    ["an idea that names a mirror (mirror allowed)", [{ slotIndex: 5, idea: "селфи в зеркале", shot: null, pose: null }] as IdeaSlot[], true],
    ["the owner's mirror", [{ slotIndex: 5, idea: "селфи в зеркале", shot: "mirror", pose: null }] as IdeaSlot[], false],
    ["«Авто» with no mirror", [{ slotIndex: 5, idea: "кофе", shot: null, pose: null }] as IdeaSlot[], false],
  ])("the retry for %s carries the neutral reason and no contradiction of its rules", (_name, asked, mirrorAllowed) => {
    const user = userContent(ideaMessages(asked, refusal, mirrorAllowed));
    expect(user).toContain(NEUTRAL);
    expect(user).not.toContain("never the mirror");
  });
});

// ---------- CS.8a: the mirror, only when the idea names one ----------

describe("the mirror on «Авто»", () => {
  const MIRROR_IDEA: IdeaSlot = { slotIndex: 9, idea: "селфи в зеркале лифта", shot: null, pose: null };
  const reply = (shot: string, pose: string) => JSON.stringify({ scenes: [{ slotIndex: 9, sentence: "She takes a selfie in a tall elevator mirror, one hand on the phone.", shot, pose }] });

  test("the prompt never offers the mirror when the idea does not name one", () => {
    const prompt = ideaSystemPrompt(false);
    expect(prompt).toBe(ideaSystemPrompt());
    expect(prompt).toContain("friend, selfie or candid");
    expect(prompt).toContain("Never choose the mirror");
  });

  test("it offers the mirror when the idea names one, and says it faces the camera", () => {
    const prompt = ideaSystemPrompt(true);
    expect(prompt).toContain("friend, selfie, mirror or candid");
    expect(prompt).not.toContain("Never choose the mirror");
    expect(prompt).toContain("mirror shot");
  });

  test("the schema's shots include the mirror only then", () => {
    type Node = { properties?: Record<string, Node>; items?: Node; enum?: (string | null)[] };
    const shots = (schema: { schema: Record<string, unknown> }) => ((schema.schema as Node).properties?.scenes?.items?.properties?.shot?.enum ?? []);
    expect(shots(ideaJsonSchema(false))).toEqual(["friend", "selfie", "candid"]);
    expect(shots(ideaJsonSchema(true))).toEqual(["friend", "selfie", "mirror", "candid"]);
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

  // S5.R1 L1: the idea prompt has no room for the candid rule's sentence (its floor pin), so the reader is what holds it.
  test("refuses a candid scene that has her looking at the viewer, though the prompt does not carry the sentence", () => {
    const candid: FixedIdeaSlot[] = [{ slotIndex: 3, idea: "stirring a pot", shot: "candid", pose: "front" }];
    expect(readWriterAnswer(answer({ slotIndex: 3, sentence: "She stirs a pot, looking at the viewer with a smile." }), candid)).toMatchObject({ ok: false, problems: ["pose-contradiction"], poseSlots: [3] });
    expect(ideaSystemPrompt()).not.toContain("In a friend's snap while she is busy");
  });

  test("S5.R1 M3: refuses a selfie scene that names a phone, whatever the idea says", () => {
    const selfie: FixedIdeaSlot[] = [{ slotIndex: 3, idea: "reading on a bench", shot: "selfie", pose: "front" }];
    expect(readIdeaAnswer(answer({ slotIndex: 3, sentence: "She sits on a bench holding her phone at arm's length." }), selfie)).toMatchObject({ ok: false, problems: ["phone-in-selfie"], phoneSlots: [3] });
    const phoneIdea: FixedIdeaSlot[] = [{ slotIndex: 3, idea: "scrolling her phone on a bench", shot: "selfie", pose: "front" }];
    expect(readIdeaAnswer(answer({ slotIndex: 3, sentence: "She sits on a bench scrolling her phone." }), phoneIdea)).toMatchObject({ ok: false, problems: ["phone-in-selfie"] });
  });
});

describe("the idea prompt's floor", () => {
  const CEILING = WRITER_CALL.inputTokens;
  // As built (CS.8a fix round 1) the worst floor is 12,847 tokens (five 500-character CJK ideas, photographer + three-quarter, the worst refusal) against 14,000:
  // 1,153 of headroom, of which the pin requires 200. The same case with 500 Cyrillic characters is 10,347.
  const MARGIN = 200;
  /** 160 distinct 16-byte words of the four widest kinds: more than the feedback will tell, which clips them. */
  const hostileWords = Array.from({ length: 40 }, (_, i) => {
    const n = String(i).padStart(4, "0");
    return [`${"W".repeat(12)}${n}`, `${"Я".repeat(6)}${n}`, `${"😀".repeat(3)}${n}`, `${"é".repeat(6)}${n}`];
  }).flat();
  /**
   * Five scene numbers that are never next to each other, so no list is told as a range (writer.ts slotList) and all five are told in every list: the longest a refusal can
   * carry. Five digits is far wider than a write can need (a set holds at most 100 scenes), so the pin is stricter than the numbers a real write has.
   */
  const IDEA_IDS = [9_992, 9_994, 9_996, 9_998, 10_000];
  const worstRefusal = (indices: readonly number[]): WriterRefusal => ({
    problems: ["not-json", "empty", "missing-slots", "unknown-slot", "duplicate-slot", "two-handed", "youth-word", "revealing-word", "pose-contradiction", "phone-in-selfie", "bad-angle"],
    missingSlots: [...indices],
    twoHandedSlots: [...indices],
    wordSlots: [...indices],
    poseSlots: [...indices],
    angleSlots: [...indices],
    phoneSlots: [...indices],
    words: hostileWords,
  });

  /**
   * The floor of the dearest write there is for `idea` (five scenes, asked again after the worst refusal): every shot label against every pose label, with and
   * without the mirror, as an own scene written again (both given, a schema with the number and the sentence only) and as an idea on «Авто» (both asked, both keys).
   * The label lengths differ, so the worst is a measurement, not a guess at one pair (CS.8a fix round 1: it is the photographer with a three-quarter view, not the mirror).
   */
  function worstFloor(idea: string): { floor: number; where: string } {
    const indices = IDEA_IDS;
    const refusal = worstRefusal(indices);
    const cases: { where: string; floor: number }[] = [];
    for (const mirrorAllowed of [false, true]) {
      const asked: IdeaSlot[] = indices.map((slotIndex) => ({ slotIndex, idea, shot: null, pose: null }));
      cases.push({ where: `Auto, mirror ${mirrorAllowed}`, floor: promptTokenFloor({ messages: ideaMessages(asked, refusal, mirrorAllowed), jsonSchema: ideaJsonSchema(mirrorAllowed), images: 0 }) });
      for (const shot of Object.keys(SHOT_LABEL) as Shot[]) {
        for (const pose of Object.keys(POSE_LABEL) as Pose[]) {
          const given: IdeaSlot[] = indices.map((slotIndex) => ({ slotIndex, idea, shot, pose }));
          const schema = ideaJsonSchema(mirrorAllowed, { shot: false, pose: false });
          cases.push({ where: `${shot} + ${pose}, mirror ${mirrorAllowed}`, floor: promptTokenFloor({ messages: ideaMessages(given, refusal, mirrorAllowed), jsonSchema: schema, images: 0 }) });
        }
      }
    }
    return cases.reduce((worst, c) => (c.floor > worst.floor ? c : worst));
  }

  test("five own scenes with 500-char Cyrillic ideas, asked again after the worst refusal, stay at least 200 tokens under the 14K ceiling, whatever the shot and the pose", () => {
    const { floor } = worstFloor("я".repeat(500));
    expect(floor).toBeLessThanOrEqual(CEILING - MARGIN);
  });

  test("the heaviest idea the contract lets through (500 three-byte characters, the bound of SCENE_IDEA_BYTES_PER_CHAR) is still under the ceiling with the worst refusal", () => {
    expect(SceneWriteTarget.safeParse({ kind: "idea", idea: "中".repeat(500), count: 5, shot: null }).success).toBe(true);
    const { floor } = worstFloor("中".repeat(500));
    expect(floor).toBeLessThanOrEqual(CEILING - MARGIN);
    // The measured margin of the honest worst (five non-adjacent five-digit numbers in every list): re-measure it when the idea prompt or a refusal text changes.
    // 223 -> 208 at S5.4 (C1): the phone-in-selfie refusal reason grew by 15 bytes (" or said selfie"); still above MARGIN (200).
    expect(CEILING - floor).toBe(208);
  });

  test("an idea of control characters, which would JSON-escape to six bytes each and break the pin, never reaches the prompt: the contract refuses it", () => {
    const heavy: IdeaSlot[] = Array.from({ length: 5 }, (_, i) => ({ slotIndex: IDEA_IDS[i] as number, idea: "\u0001".repeat(500), shot: "mirror", pose: "three-quarter" }));
    const floor = promptTokenFloor({ messages: ideaMessages(heavy, worstRefusal(heavy.map((s) => s.slotIndex))), jsonSchema: IDEA_JSON_SCHEMA, images: 0 });
    expect(floor).toBeGreaterThan(CEILING - MARGIN);
    expect(SceneWriteTarget.safeParse({ kind: "idea", idea: "\u0001".repeat(500), count: 5, shot: null }).success).toBe(false);
  });
});
