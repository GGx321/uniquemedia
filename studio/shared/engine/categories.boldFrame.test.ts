import { describe, expect, test } from "bun:test";
import { isBoldFrame, type SceneRoute } from "./categories";

// 5a.4 (S5.BA1, plan s5a4 §5.1, I5.73): «Смелая» is one marker, one predicate. A frame is a «Смелая» frame when its category is one of the two «Смелая» categories
// or when it is drawn on the Seedream route; `route` is a REQUIRED key (`SceneRoute | undefined`), so a caller that forgets it does not compile.

const ROUTED: SceneRoute = "seedream";

describe("isBoldFrame", () => {
  test.each(["nightwear", "beach"])("a %s frame is a «Смелая» frame without a route, as before", (category) => {
    expect(isBoldFrame({ category, route: undefined })).toBe(true);
  });

  test.each(["nightwear", "beach"])("a %s frame stays a «Смелая» frame with the route", (category) => {
    expect(isBoldFrame({ category, route: ROUTED })).toBe(true);
  });

  test.each(["home", "travel", "shoot", "glam", "fit", "photoshoot", "glamour", "fitness"])("a %s frame with the route is a «Смелая» frame", (category) => {
    expect(isBoldFrame({ category, route: ROUTED })).toBe(true);
  });

  test.each(["home", "travel", "shoot", "glam", "fit", "photoshoot", "glamour", "fitness"])("a %s frame without the route is not one (a frame stored before 5a.4 reads as before)", (category) => {
    expect(isBoldFrame({ category, route: undefined })).toBe(false);
  });

  test("a custom category's frame with the route is a «Смелая» frame, and without it is not", () => {
    expect(isBoldFrame({ category: "cat-paris-cafes", route: ROUTED })).toBe(true);
    expect(isBoldFrame({ category: "cat-paris-cafes", route: undefined })).toBe(false);
  });

  test("an own scene without the route is not a «Смелая» frame", () => {
    expect(isBoldFrame({ category: "own", route: undefined })).toBe(false);
  });

  test("a route key that is present but undefined reads as no route", () => {
    expect(isBoldFrame({ category: "home", route: undefined })).toBe(false);
  });

  test("a call without the route key does not compile", () => {
    // @ts-expect-error `route` is a required key: a caller that forgets it is listed by tsc
    expect(isBoldFrame({ category: "home" })).toBe(false);
  });
});
