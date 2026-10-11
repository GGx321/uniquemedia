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

describe("library-unreadable (CS.7 fix round 2)", () => {
  test("is a scene reason that names no scene", () => {
    expect(SCENE_REASONS).toContain("library-unreadable");
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason: "library-unreadable" }).success).toBe(true);
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason: "library-unreadable", sceneId: 3 }).success).toBe(false);
  });

  test("its text says nothing was written or spent, and to retry", () => {
    expect(SCENE_REASONS_RU["library-unreadable"]).toContain("Ничего не записано");
    expect(SCENE_REASONS_RU["library-unreadable"]).toContain("повторите");
  });
});

// 5a.2 (S5.6d, plan s5a2 I5.31): the per-slot end of a run whose sentence broke today's word rules at the assembler. Additive: it names no scene (the slot is a
// slot of a run, not a scene of a set), and a reader that does not know the code reads the error as any VALIDATION.
describe("slot-text-problem (S5.6d)", () => {
  test("is a scene reason that names no scene", () => {
    expect(SCENE_REASONS).toContain("slot-text-problem");
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason: "slot-text-problem" }).success).toBe(true);
    expect(EngineError.safeParse({ code: "VALIDATION", sceneReason: "slot-text-problem", sceneId: 3 }).success).toBe(false);
  });

  test("its text says the frame was skipped and that it cost nothing", () => {
    expect(SCENE_REASONS_RU["slot-text-problem"]).toBe("Текст сцены не прошёл проверку слов — кадр пропущен, бесплатно.");
  });

  test("the reasons that existed before it are all still there, in order", () => {
    expect(SCENE_REASONS.slice(0, 20)).toEqual([
      "set-used", "open-set", "nothing-waiting", "scene-missing", "target-removed", "scene-without-text", "no-active-scenes", "too-many-active", "scene-text-problem",
      "write-record-cap", "idea-room", "mixed-kinds", "own-redraw", "no-open-write", "no-attempts-left", "nothing-to-dismiss", "library-unreadable", "launch-set", "over-plan", "not-awaiting",
    ]);
  });
});

describe("SCENE_REASONS_RU", () => {
  test("every reason has a text of its own, and none is the general one", () => {
    const texts = SCENE_REASONS.map((reason) => SCENE_REASONS_RU[reason]);
    expect(new Set(texts).size).toBe(SCENE_REASONS.length);
    for (const text of texts) expect(text).not.toBe(ERROR_MESSAGES_RU.VALIDATION);
  });
});
