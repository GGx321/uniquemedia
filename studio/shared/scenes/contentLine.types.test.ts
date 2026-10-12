import { describe, expect, test } from "bun:test";
import { boldContentLevel, contentProblems, type ContentLevel } from "./contentLine";

// S5.9b1 review: the bold level drops the revealing-word gate, so it must not be reachable by writing a string or by passing a mix level (`SceneLevel`
// is "ordinary" | "flirty" | "bold" from S5.9a). The only way to a bold `ContentLevel` is `boldContentLevel()`, which S5.9c's `contentLevelOf` calls for
// a «Смелая» category. These lines are checked by `typecheck:studio`: an `@ts-expect-error` over a line that compiles is itself an error.

type MixLevel = "ordinary" | "flirty" | "bold";

describe("a bold content level cannot be forged", () => {
  test("the string «bold» is not a ContentLevel", () => {
    // @ts-expect-error a literal is no bold level; only boldContentLevel() makes one
    const forged: ContentLevel = "bold";
    expect(typeof forged).toBe("string");
  });

  test("a mix level that may be «bold» is not a ContentLevel", () => {
    const mix: MixLevel = "ordinary" as MixLevel;
    // @ts-expect-error a mix level cannot silently stand for a content level
    expect(contentProblems("a bikini", mix)).toHaveLength(1);
  });

  test("the two mix levels that are not bold are ContentLevels", () => {
    const ordinary: ContentLevel = "ordinary";
    const flirty: ContentLevel = "flirty";
    expect(contentProblems("a bikini", ordinary)).toHaveLength(1);
    expect(contentProblems("a bikini", flirty)).toHaveLength(1);
  });

  test("boldContentLevel() is a ContentLevel that lifts the revealing-word gate", () => {
    const bold: ContentLevel = boldContentLevel();
    expect(contentProblems("a bikini", bold)).toEqual([]);
  });
});
