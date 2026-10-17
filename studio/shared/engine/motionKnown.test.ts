import { describe, expect, test } from "bun:test";
import { freshDrafts, sameText } from "./motionKnown";

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
