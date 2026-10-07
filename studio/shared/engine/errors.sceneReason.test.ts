import { describe, expect, test } from "bun:test";
import { EngineError, SCENE_REASONS } from "./errors";
import { ERROR_MESSAGES_RU, SCENE_REASONS_RU } from "./errorMessagesRu";

// Why a scene-set command was refused (`EngineError.sceneReason`, additive in v5): the window's text depends on it, so it travels as a closed code,
// never as a phrase of the engine's English `detail`.

describe("EngineError.sceneReason", () => {
  test.each(SCENE_REASONS.filter((r) => r !== "scene-text-problem" && r !== "scene-without-text"))("VALIDATION carries the reason %s", (sceneReason) => {
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason }).success).toBe(true);
  });

  test("VALIDATION without a reason is still valid: not every refusal is a scene set's", () => {
    expect(EngineError.safeParse({ code: "VALIDATION" }).success).toBe(true);
  });

  test("a reason outside the closed set is refused", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason: "looks-wrong" }).success).toBe(false);
  });

  test("a reason on any other code is refused", () => {
    expect(EngineError.safeParse({ code: "SCENES_CHANGED", sceneReason: "set-used" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "NOT_FOUND", sceneReason: "set-used" }).success).toBe(false);
  });

  test("a refusal on a scene's text names the scene", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason: "scene-text-problem", sceneId: 7 }).success).toBe(true);
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason: "scene-without-text", sceneId: 3 }).success).toBe(true);
  });

  test("a refusal on a scene's text without the scene is refused", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason: "scene-text-problem" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason: "scene-without-text" }).success).toBe(false);
  });

  test("a scene id with no reason, or beside a reason that names no scene, is refused", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", sceneId: 7 }).success).toBe(false);
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason: "set-used", sceneId: 7 }).success).toBe(false);
  });

  test("a scene id outside 1..10000 is refused", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason: "scene-text-problem", sceneId: 0 }).success).toBe(false);
  });

  test("a scene reason beside a category reason is refused: a refusal is one or the other", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason: "set-used", categoryReason: "limit" }).success).toBe(false);
  });
});

describe("SCENE_REASONS_RU", () => {
  test("every reason has a text of its own, and none is the general one", () => {
    const texts = SCENE_REASONS.map((reason) => SCENE_REASONS_RU[reason]);
    expect(new Set(texts).size).toBe(SCENE_REASONS.length);
    for (const text of texts) expect(text).not.toBe(ERROR_MESSAGES_RU.VALIDATION);
  });
});
