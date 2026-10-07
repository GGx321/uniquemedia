import { describe, expect, test } from "bun:test";
import { SceneWriteTarget } from "../../shared/engine";
import { WRITER_CALL } from "../money/estimate";
import { promptTokenFloor } from "../openrouter/chat";
import { ideaMessages, ideaSystemPrompt, type IdeaSlot } from "./ideaWriter";
import { readWriterAnswer, writerMessages, writerRefusalText, WRITER_JSON_SCHEMA, type WriterRefusal } from "./writer";
import { plan } from "./planner";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4b: the idea variant of the scene writer. «+ Своя сцена» sends the owner's idea (any script) and the writer composes English sentences; its system
// prompt is its own, so the compose prompt (scenes/writer.ts, byte-pinned by writer.custom.test.ts) is untouched. The answer is read by the writer's own
// `readWriterAnswer`, so every rule that holds for a planned sentence (adult words, revealing words, the phone hand, the pose) holds for an own one.

const slots: IdeaSlot[] = [
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
    const back: IdeaSlot[] = [{ slotIndex: 3, idea: "walk", shot: "friend", pose: "back" }];
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
    problems: ["not-json", "empty", "missing-slots", "unknown-slot", "duplicate-slot", "two-handed", "youth-word", "revealing-word", "pose-contradiction"],
    missingSlots: indices.slice(-1),
    twoHandedSlots: indices.slice(0, -1),
    wordSlots: indices.slice(0, -1),
    poseSlots: indices.slice(0, -1),
    words: hostileWords,
  });

  test("five own scenes with 500-char Cyrillic ideas, asked again after the worst refusal, stay at least 200 tokens under the 14K ceiling", () => {
    const worst: IdeaSlot[] = Array.from({ length: 5 }, (_, i) => ({ slotIndex: 10_000 - i, idea: "я".repeat(500), shot: "mirror", pose: "three-quarter" }));
    const messages = ideaMessages(worst, worstRefusal(worst.map((s) => s.slotIndex)));
    expect(promptTokenFloor({ messages, jsonSchema: WRITER_JSON_SCHEMA, images: 0 })).toBeLessThanOrEqual(CEILING - MARGIN);
  });

  test("the heaviest idea the contract lets through (500 three-byte characters, the bound of SCENE_IDEA_BYTES_PER_CHAR) is still under the ceiling with the worst refusal", () => {
    expect(SceneWriteTarget.safeParse({ kind: "idea", idea: "中".repeat(500), count: 5, shot: null }).success).toBe(true);
    const worst: IdeaSlot[] = Array.from({ length: 5 }, (_, i) => ({ slotIndex: 10_000 - i, idea: "中".repeat(500), shot: "mirror", pose: "three-quarter" }));
    const messages = ideaMessages(worst, worstRefusal(worst.map((s) => s.slotIndex)));
    expect(promptTokenFloor({ messages, jsonSchema: WRITER_JSON_SCHEMA, images: 0 })).toBeLessThanOrEqual(CEILING - MARGIN);
  });

  test("an idea of control characters, which would JSON-escape to six bytes each and break the pin, never reaches the prompt: the contract refuses it", () => {
    const heavy: IdeaSlot[] = Array.from({ length: 5 }, (_, i) => ({ slotIndex: 10_000 - i, idea: "\u0001".repeat(500), shot: "mirror", pose: "three-quarter" }));
    const floor = promptTokenFloor({ messages: ideaMessages(heavy, worstRefusal(heavy.map((s) => s.slotIndex))), jsonSchema: WRITER_JSON_SCHEMA, images: 0 });
    expect(floor).toBeGreaterThan(CEILING - MARGIN);
    expect(SceneWriteTarget.safeParse({ kind: "idea", idea: "\u0001".repeat(500), count: 5, shot: null }).success).toBe(false);
  });
});
