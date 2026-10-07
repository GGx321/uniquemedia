import { expect, test } from "bun:test";
import { ERROR_MESSAGES_RU, SCENE_REASONS, SCENE_REASONS_RU } from "../../shared/engine";
import { errorText } from "./errors";

// A refused scene-set command says why (`sceneReason`): the window shows this text, so each reason names the cause and the way out.

test("a VALIDATION with no scene reason keeps the general text", () => {
  expect(errorText({ code: "VALIDATION" })).toBe(ERROR_MESSAGES_RU.VALIDATION);
});

test("a used set says it is read-only and a new one is needed", () => {
  expect(errorText({ code: "VALIDATION", sceneReason: "set-used" })).toBe(SCENE_REASONS_RU["set-used"]);
});

test("a refusal of the word rules says the rules, not the general text", () => {
  expect(errorText({ code: "VALIDATION", sceneReason: "scene-text-problem", sceneId: 4 })).toContain("правила слов");
});

test("the 500-writes refusal says the set has to be composed again", () => {
  expect(errorText({ code: "VALIDATION", sceneReason: "write-record-cap" })).toContain("пересоставьте");
});

test("the English detail never reaches the text of a refusal that has a reason", () => {
  expect(errorText({ code: "VALIDATION", sceneReason: "idea-room", detail: "a set holds at most 200 scenes: this one has 199" })).not.toMatch(/[a-z]{4}/);
});

test("every reason has a text of its own, and none is the general one", () => {
  const texts = SCENE_REASONS.map((sceneReason) =>
    errorText({ code: "VALIDATION", sceneReason, ...(sceneReason === "scene-text-problem" || sceneReason === "scene-without-text" ? { sceneId: 1 } : {}) }),
  );
  expect(new Set(texts).size).toBe(SCENE_REASONS.length);
  for (const text of texts) expect(text).not.toBe(ERROR_MESSAGES_RU.VALIDATION);
});
