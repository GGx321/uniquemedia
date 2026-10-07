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

// The engine says which scene a refusal is about (`sceneId`); the text names it as the artboards number it, instead of «одной из сцен».
test("a refusal of the word rules names the scene by its number", () => {
  const text = errorText({ code: "VALIDATION", sceneReason: "scene-text-problem", sceneId: 4 });
  expect(text).toContain("Текст сцены 04");
  expect(text).not.toContain("одной из сцен");
});

test("a scene without a text is named by its number, two digits or three", () => {
  expect(errorText({ code: "VALIDATION", sceneReason: "scene-without-text", sceneId: 12 })).toContain("сцены 12");
  expect(errorText({ code: "VALIDATION", sceneReason: "scene-without-text", sceneId: 7 })).toContain("сцены 07");
  expect(errorText({ code: "VALIDATION", sceneReason: "scene-without-text", sceneId: 120 })).toContain("сцены 120");
});

test("a missing and a removed scene are named too", () => {
  expect(errorText({ code: "VALIDATION", sceneReason: "scene-missing", sceneId: 9 })).toContain("Сцены 09");
  expect(errorText({ code: "VALIDATION", sceneReason: "target-removed", sceneId: 3 })).toContain("Сцена 03");
});

test("a refusal that may name a scene but carries no number keeps the general text of its reason", () => {
  expect(errorText({ code: "VALIDATION", sceneReason: "scene-missing" })).toBe(SCENE_REASONS_RU["scene-missing"]);
  expect(errorText({ code: "VALIDATION", sceneReason: "target-removed" })).toBe(SCENE_REASONS_RU["target-removed"]);
});

test("every reason has a text of its own, and none is the general one", () => {
  const texts = SCENE_REASONS.map((sceneReason) =>
    errorText({ code: "VALIDATION", sceneReason, ...(sceneReason === "scene-text-problem" || sceneReason === "scene-without-text" ? { sceneId: 1 } : {}) }),
  );
  expect(new Set(texts).size).toBe(SCENE_REASONS.length);
  for (const text of texts) expect(text).not.toBe(ERROR_MESSAGES_RU.VALIDATION);
});
