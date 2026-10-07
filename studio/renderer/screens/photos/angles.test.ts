import { describe, expect, test } from "bun:test";
import { CARD_POSES, nextPoses, POSE_CHIP, POSE_WORD, posesText, sortPoses } from "./angles";

// CS.8b: a custom category's angles as the UI shows and sends them (README «CS.8 — angles from descriptions», contract notes 1-2, «CS.8d round 1» M1).

describe("the angles' words and order", () => {
  test("the app's vocabulary: «Со спины», never «сзади»; chips capitalised, running text lower case", () => {
    expect(POSE_CHIP).toEqual({ front: "Анфас", "three-quarter": "Три четверти", profile: "Профиль", back: "Со спины" });
    expect(POSE_WORD).toEqual({ front: "анфас", "three-quarter": "три четверти", profile: "профиль", back: "со спины" });
  });

  test("a list is shown sorted front → back whatever order the engine stored it in", () => {
    expect(sortPoses(["back", "three-quarter"])).toEqual(["three-quarter", "back"]);
    expect(sortPoses(["back", "profile", "front", "three-quarter"])).toEqual(["front", "three-quarter", "profile", "back"]);
    expect(sortPoses([])).toEqual([]);
    expect(posesText(["back", "three-quarter"])).toBe("три четверти, со спины");
    expect(posesText(["profile"])).toBe("профиль");
  });
});

describe("what a press of a chip in «Мои категории» saves", () => {
  test("from «как в карточке» a press starts at front and three-quarter: «Со спины» adds to them, never «со спины» alone", () => {
    expect(CARD_POSES).toEqual(["front", "three-quarter"]);
    expect(nextPoses(undefined, "back")).toEqual(["front", "three-quarter", "back"]);
    expect(nextPoses(undefined, "profile")).toEqual(["front", "three-quarter", "profile"]);
  });

  test("from «как в карточке» a press of a dimmed-on chip drops it: own angles without it", () => {
    expect(nextPoses(undefined, "front")).toEqual(["three-quarter"]);
    expect(nextPoses(undefined, "three-quarter")).toEqual(["front"]);
  });

  test("with own angles a press toggles that one and keeps the list sorted", () => {
    expect(nextPoses(["back", "three-quarter"], "front")).toEqual(["front", "three-quarter", "back"]);
    expect(nextPoses(["three-quarter", "back"], "back")).toEqual(["three-quarter"]);
    expect(nextPoses(["back"], "profile")).toEqual(["profile", "back"]);
  });

  test("the last chip off is «как в карточке» again: null, never an empty list", () => {
    expect(nextPoses(["back"], "back")).toBe(null);
    expect(nextPoses(["front"], "front")).toBe(null);
  });

  test("all four on is a list of four", () => {
    expect(nextPoses(["front", "three-quarter", "profile"], "back")).toEqual(["front", "three-quarter", "profile", "back"]);
  });
});
