import { describe, expect, test } from "bun:test";
import { freshDrafts, sameText, sheetVisionTexts } from "./motionKnown";

describe("sameText", () => {
  test("ignores case anywhere in the text, not only at its start", () => {
    expect(sameText("she slowly tucks a strand of Hair behind her ear")).toBe(sameText("she slowly tucks a strand of hair behind her ear"));
  });

  test("ignores the amount of white space and the white space at the ends", () => {
    expect(sameText("  she  slowly\tsmiles ")).toBe(sameText("she slowly smiles"));
  });

  test("keeps two different texts apart", () => {
    expect(sameText("she slowly smiles")).not.toBe(sameText("she slowly nods"));
  });
});

describe("freshDrafts", () => {
  const draft = (text: string) => ({ label: "x", text });

  test("drops a draft whose text is known, compared with sameText", () => {
    const { fresh } = freshDrafts([draft("She slowly SMILES"), draft("she slowly nods")], [sameText("she slowly smiles")]);
    expect(fresh.map((d) => d.text)).toEqual(["she slowly nods"]);
  });

  test("drops the second of two drafts that differ only by case or spacing", () => {
    const { fresh } = freshDrafts([draft("she slowly nods"), draft("she  slowly  Nods")], []);
    expect(fresh.map((d) => d.text)).toEqual(["she slowly nods"]);
  });

  test("says `repeated` only when there were drafts and every one was known", () => {
    expect(freshDrafts([draft("a b c")], [sameText("A b c")]).repeated).toBe(true);
    expect(freshDrafts([draft("a b c"), draft("d e f")], [sameText("a b c")]).repeated).toBe(false);
    expect(freshDrafts([], [sameText("a b c")]).repeated).toBe(false);
  });

  test("does not change the known set it is given", () => {
    const known = new Set<string>();
    freshDrafts([draft("a b c")], known);
    expect(known.size).toBe(0);
  });
});

describe("sheetVisionTexts", () => {
  const item = (n: number, source: string = "vision") => ({ id: `${source[0]}-${n}`, source, text: `She Does ${n}` });
  const always = () => true;

  test("is the newest three suggestions, compared with sameText", () => {
    const items = [1, 2, 3, 4, 5].map((n) => item(n));
    expect(sheetVisionTexts(items, always)).toEqual(["she does 3", "she does 4", "she does 5"]);
  });

  test("leaves out an own idea and counts only suggestions toward the three", () => {
    const items = [item(1), item(2), item(3), item(1, "own"), item(2, "own")];
    expect(sheetVisionTexts(items, always)).toEqual(["she does 1", "she does 2", "she does 3"]);
  });

  test("takes an older suggestion in the place of one that no longer passes the check (the sheet's rule)", () => {
    const items = [1, 2, 3, 4].map((n) => item(n));
    expect(sheetVisionTexts(items, (i) => i.id !== "v-4")).toEqual(["she does 1", "she does 2", "she does 3"]);
    expect(sheetVisionTexts(items, (i) => i.id !== "v-3")).toEqual(["she does 1", "she does 2", "she does 4"]);
  });
});
