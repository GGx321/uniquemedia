import { describe, expect, test } from "bun:test";
import { ideaNamesMirror, SceneSetCategory } from "./scenes";

// CS.8a: on «Авто» the model may pick the mirror shot only when the owner's idea names a mirror. The test is on the idea's text alone, made before the call,
// so the engine, the mock and the tests agree on it.

describe("ideaNamesMirror", () => {
  test.each([
    "селфи в зеркале лифта",
    "Зеркало в прихожей",
    "в ЗЕРКАЛЬНОМ зале",
    "зеркальное селфи",
    "mirror selfie in the elevator",
    "a Mirror on the wall",
    "bathroom mirrors",
  ])("«%s» names a mirror", (idea) => {
    expect(ideaNamesMirror(idea)).toBe(true);
  });

  test.each(["кофе на балконе утром", "Лежит на животе. Вид сзади", "lying on her stomach, back view", "прогулка по набережной", "a quiet morning"])("«%s» does not", (idea) => {
    expect(ideaNamesMirror(idea)).toBe(false);
  });
});

describe("SceneSetCategory.poses", () => {
  test("a category of a set may carry the angles of its snapshot, and need not", () => {
    expect(SceneSetCategory.safeParse({ ref: "cat-lying-down", name: "Лежит", poses: ["back"] }).success).toBe(true);
    expect(SceneSetCategory.safeParse({ ref: "cat-lying-down", name: "Лежит" }).success).toBe(true);
    expect(SceneSetCategory.safeParse({ ref: "home", name: null }).success).toBe(true);
  });

  test("under the category's own bounds", () => {
    for (const poses of [[], ["back", "back"], ["sideways"]]) expect(SceneSetCategory.safeParse({ ref: "cat-lying-down", name: "Лежит", poses }).success).toBe(false);
  });
});
