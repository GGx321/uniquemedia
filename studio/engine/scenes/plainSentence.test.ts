import { describe, expect, test } from "bun:test";
import { BANKS } from "../../shared/scenes/banks";
import { sentenceProblems } from "./assembler";
import { plainSentence } from "../../shared/scenes/plain";
import { plan } from "./planner";

// 5a.2 (S5.6d, plan s5a2 §5.5 «After the last attempt»): a planned slot the model could not write in its two answered attempts takes the plain sentence
// «{at or "At " + location}, she is {activity}, wearing {outfit}.», built from the slot's own texts alone.

const SLOT = { category: "cat-paris-cafes", location: "the riverside cafe", activity: "walking along the river", outfit: "a denim jacket and a long skirt" };

describe("plainSentence", () => {
  test("a custom slot reads «At {location}, she is {activity}, wearing {outfit}.»", () => {
    expect(plainSentence(SLOT)).toBe("At the riverside cafe, she is walking along the river, wearing a denim jacket and a long skirt.");
  });

  test("a built-in slot whose place the bank knows by name opens with the bank's own locative phrase", () => {
    const place = BANKS.home.places[0];
    if (place === undefined) throw new Error("the home bank has no place");
    const sentence = plainSentence({ category: "home", location: place.name, activity: "folding a blanket", outfit: "an oversized tee" });
    expect(sentence).toBe(`${place.at.charAt(0).toUpperCase()}${place.at.slice(1)}, she is folding a blanket, wearing an oversized tee.`);
    expect(sentence).not.toMatch(/^At /);
  });

  test("a built-in slot whose place the bank does not know (a plan from before the banks) opens with «At» and the location", () => {
    expect(plainSentence({ category: "home", location: "a bright kitchen", activity: "holding a mug", outfit: "a white t-shirt" })).toBe(
      "At a bright kitchen, she is holding a mug, wearing a white t-shirt.",
    );
  });

  test("a trailing full stop or comma in a stored text does not double the sentence's punctuation", () => {
    expect(plainSentence({ ...SLOT, activity: "walking along the river.", outfit: "a denim jacket," })).toBe("At the riverside cafe, she is walking along the river, wearing a denim jacket.");
  });

  test("a slot's legwear is not part of the plain sentence", () => {
    expect(plainSentence({ ...SLOT, legwear: "white knee-high socks" } as typeof SLOT)).not.toContain("socks");
  });

  test("every slot of a planned run reads as one sentence that passes the youth and revealing word rules", () => {
    const slots = plan({ seed: 7, count: 60, categories: ["home", "travel", "photoshoot", "glamour", "fitness"], poses: { profile: true, back: true } }).slots;
    for (const slot of slots) {
      const sentence = plainSentence(slot);
      expect(sentence.endsWith(".")).toBe(true);
      expect(sentence.slice(0, -1)).not.toContain(".");
      expect(sentenceProblems(sentence)).toEqual([]);
    }
  });
});
