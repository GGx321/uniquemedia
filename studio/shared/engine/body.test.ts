import { describe, expect, test } from "bun:test";
import { adultTextProblems, youthWords } from "./ageText";
import { AvatarBody, BODY_KEYS, BODY_MARKS_MAX, BODY_PHRASE_MAX, bodyFromRecord, bodyPhrase, BodyMark, type BodyKey } from "./body";

// The mockup's phrase table (`.omc/stage5/design/README.md`, «Поля «Тела»»), written out row by row: a wording change is a deliberate edit of this table.
const SINGLE: ReadonlyArray<readonly [string, AvatarBody, string]> = [
  ["height short", { height: "short" }, "below-average height"],
  ["height average", { height: "average" }, "average height"],
  ["height tall", { height: "tall" }, "tall"],
  ["bust small", { bust: "small" }, "a small bust"],
  ["bust medium", { bust: "medium" }, "a medium bust"],
  ["bust full", { bust: "full" }, "a full bust"],
  ["figure straight", { figure: "straight" }, "a straight figure"],
  ["figure hourglass", { figure: "hourglass" }, "an hourglass figure"],
  ["figure pear", { figure: "pear" }, "a pear-shaped figure"],
  ["figure inverted-triangle", { figure: "inverted-triangle" }, "an inverted-triangle figure with shoulders broader than her hips"],
  ["figure apple", { figure: "apple" }, "an apple-shaped figure with a softer waist"],
  ["legs average", { legLength: "average" }, "average-length legs"],
  ["legs long", { legLength: "long" }, "long legs"],
  ["legs slim", { legShape: "slim" }, "slim legs"],
  ["legs toned", { legShape: "toned" }, "toned legs"],
  ["legs average slim", { legLength: "average", legShape: "slim" }, "average-length slim legs"],
  ["legs average toned", { legLength: "average", legShape: "toned" }, "average-length toned legs"],
  ["legs long slim", { legLength: "long", legShape: "slim" }, "long slim legs"],
  ["legs long toned", { legLength: "long", legShape: "toned" }, "long toned legs"],
  ["bottom small", { bottomSize: "small" }, "a small bottom"],
  ["bottom medium", { bottomSize: "medium" }, "a medium-sized bottom"],
  ["bottom full", { bottomSize: "full" }, "a full bottom"],
  ["bottom round", { bottomShape: "round" }, "a round bottom"],
  ["bottom heart", { bottomShape: "heart" }, "a heart-shaped bottom"],
  ["bottom toned", { bottomShape: "toned" }, "a toned bottom"],
  ["bottom wide", { bottomShape: "wide" }, "wide hips"],
  ["mark tattoo-ankle", { bodyMarks: ["tattoo-ankle"] }, "a small tattoo on her left ankle"],
  ["mark tattoo-hip", { bodyMarks: ["tattoo-hip"] }, "a small tattoo on her right hip"],
  ["mark tattoo-blade", { bodyMarks: ["tattoo-blade"] }, "a small tattoo on her left shoulder blade"],
  ["mark tattoo-ribs", { bodyMarks: ["tattoo-ribs"] }, "a small tattoo on her ribs"],
  ["mark mole-collarbone", { bodyMarks: ["mole-collarbone"] }, "a small mole on her left collarbone"],
  ["mark mole-shoulder", { bodyMarks: ["mole-shoulder"] }, "a small mole on her right shoulder"],
  ["mark mole-back", { bodyMarks: ["mole-back"] }, "a small mole on her lower back"],
];

// Every bottom size × shape combination: 3 × 4 together, 3 sizes alone, 4 shapes alone (19 in all; the 7 alone are also in SINGLE).
const BOTTOM_COMBOS: ReadonlyArray<readonly [AvatarBody, string]> = [
  [{ bottomSize: "small", bottomShape: "round" }, "a small round bottom"],
  [{ bottomSize: "small", bottomShape: "heart" }, "a small heart-shaped bottom"],
  [{ bottomSize: "small", bottomShape: "toned" }, "a small toned bottom"],
  [{ bottomSize: "small", bottomShape: "wide" }, "wide hips with a small bottom"],
  [{ bottomSize: "medium", bottomShape: "round" }, "a medium-sized round bottom"],
  [{ bottomSize: "medium", bottomShape: "heart" }, "a medium-sized heart-shaped bottom"],
  [{ bottomSize: "medium", bottomShape: "toned" }, "a medium-sized toned bottom"],
  [{ bottomSize: "medium", bottomShape: "wide" }, "wide hips with a medium-sized bottom"],
  [{ bottomSize: "full", bottomShape: "round" }, "a full round bottom"],
  [{ bottomSize: "full", bottomShape: "heart" }, "a full heart-shaped bottom"],
  [{ bottomSize: "full", bottomShape: "toned" }, "a full toned bottom"],
  [{ bottomSize: "full", bottomShape: "wide" }, "wide hips with a full bottom"],
];

const VALUES: Record<Exclude<BodyKey, "bodyMarks">, readonly string[]> = {
  height: ["short", "average", "tall"],
  bust: ["small", "medium", "full"],
  figure: ["straight", "hourglass", "pear", "inverted-triangle", "apple"],
  legLength: ["average", "long"],
  legShape: ["slim", "toned"],
  bottomSize: ["small", "medium", "full"],
  bottomShape: ["round", "heart", "toned", "wide"],
};

describe("AvatarBody", () => {
  test("accepts an empty body: every key is optional", () => {
    expect(AvatarBody.safeParse({}).success).toBe(true);
  });

  test.each(Object.entries(VALUES).flatMap(([key, values]) => values.map((value) => [key, value] as const)))("accepts %s = %s", (key, value) => {
    expect(AvatarBody.safeParse({ [key]: value }).success).toBe(true);
  });

  test.each(Object.keys(VALUES))("refuses a value %s does not have", (key) => {
    expect(AvatarBody.safeParse({ [key]: "tiny" }).success).toBe(false);
  });

  test("refuses the value of a neighbouring key (a bottom shape is not a leg shape)", () => {
    expect(AvatarBody.safeParse({ legShape: "round" }).success).toBe(false);
  });

  test.each([[[]], [["tattoo-ankle"]], [["tattoo-ankle", "mole-back"]]])("accepts %j as bodyMarks", (marks) => {
    expect(AvatarBody.safeParse({ bodyMarks: marks }).success).toBe(true);
  });

  test("refuses three body marks: two is the limit", () => {
    expect(BODY_MARKS_MAX).toBe(2);
    expect(AvatarBody.safeParse({ bodyMarks: ["tattoo-ankle", "tattoo-hip", "mole-back"] }).success).toBe(false);
  });

  test("refuses a repeated body mark", () => {
    expect(AvatarBody.safeParse({ bodyMarks: ["mole-back", "mole-back"] }).success).toBe(false);
  });

  test("refuses a body mark outside the fixed list", () => {
    expect(AvatarBody.safeParse({ bodyMarks: ["tattoo-neck"] }).success).toBe(false);
  });

  test("refuses an unknown key (strict)", () => {
    expect(AvatarBody.safeParse({ weight: "light" }).success).toBe(false);
  });

  test("refuses the build word: «Телосложение» is a trait of its own, not part of the body", () => {
    expect(AvatarBody.safeParse({ build: "slim" }).success).toBe(false);
  });

  test("BODY_KEYS lists exactly the schema's keys", () => {
    expect<string[]>([...BODY_KEYS].sort()).toEqual(Object.keys(AvatarBody.shape).sort());
  });
});

describe("bodyPhrase", () => {
  test("is undefined for an empty body", () => {
    expect(bodyPhrase({})).toBeUndefined();
  });

  test("is undefined for an empty list of body marks", () => {
    expect(bodyPhrase({ bodyMarks: [] })).toBeUndefined();
  });

  test.each(SINGLE)("%s", (_name, body, phrase) => {
    expect(bodyPhrase(body)).toBe(phrase);
  });

  test.each(BOTTOM_COMBOS)("bottom %j", (body, phrase) => {
    expect(bodyPhrase(body)).toBe(phrase);
  });

  test("covers the mockup's 33 single phrases and all 19 bottom combinations", () => {
    // 3 + 3 + 5 figure values, 8 leg phrases, 7 bottom values, 7 body marks = 33; the bottom has 12 pairs + 7 single values = 19.
    expect(SINGLE.length).toBe(33);
    expect(BOTTOM_COMBOS.length + 7).toBe(19);
  });

  test("writes the slots in a fixed order: height, bust, figure, legs, bottom, marks", () => {
    const phrase = bodyPhrase({
      bodyMarks: ["tattoo-ankle"],
      bottomShape: "round",
      bottomSize: "small",
      legShape: "slim",
      legLength: "long",
      figure: "hourglass",
      bust: "medium",
      height: "tall",
    });
    expect(phrase).toBe("tall, a medium bust, an hourglass figure, long slim legs, a small round bottom and a small tattoo on her left ankle");
  });

  test("puts «and» before the last item only, with no comma before it", () => {
    expect(bodyPhrase({ height: "tall", bust: "full" })).toBe("tall and a full bust");
    expect(bodyPhrase({ height: "tall", bust: "full", figure: "pear" })).toBe("tall, a full bust and a pear-shaped figure");
  });

  test("renders a partial set without the unset slots", () => {
    expect(bodyPhrase({ bust: "small", bottomShape: "wide" })).toBe("a small bust and wide hips");
  });

  test("lists the body marks in the fixed order, whatever order they were picked in", () => {
    expect(bodyPhrase({ bodyMarks: ["mole-back", "tattoo-ankle"] })).toBe("a small tattoo on her left ankle and a small mole on her lower back");
  });

  test("renders the same body to the same phrase every time", () => {
    const body: AvatarBody = { height: "average", legLength: "long", bodyMarks: ["tattoo-ribs", "mole-shoulder"] };
    expect(bodyPhrase(body)).toBe(bodyPhrase({ ...body, bodyMarks: ["mole-shoulder", "tattoo-ribs"] }));
  });

  test("an item never holds an inner comma: the commas are the joins", () => {
    for (const [, body, phrase] of SINGLE) expect(phrase).toBe(bodyPhrase(body) ?? "");
    for (const [, , phrase] of SINGLE) expect(phrase.includes(",")).toBe(false);
    for (const [, phrase] of BOTTOM_COMBOS) expect(phrase.includes(",")).toBe(false);
  });

  test("«and» appears once at most: the join's, never inside an item", () => {
    for (const [, , phrase] of SINGLE) expect(/\band\b/.test(phrase)).toBe(false);
    for (const [, phrase] of BOTTOM_COMBOS) expect(/\band\b/.test(phrase)).toBe(false);
  });
});

describe("bodyPhrase passes the adult-text rules (I5.8)", () => {
  test("every single phrase and bottom combination passes youthWords and adultTextProblems", () => {
    const phrases = [...SINGLE.map(([, , phrase]) => phrase), ...BOTTOM_COMBOS.map(([, phrase]) => phrase)];
    for (const phrase of phrases) {
      expect(youthWords(phrase, "descriptor")).toEqual([]);
      expect(adultTextProblems(phrase, 25, "descriptor")).toEqual([]);
    }
  });

  test("a spread of whole phrases, every value of every slot at least once, passes both checks", () => {
    const values = Object.entries(VALUES);
    const picks = Math.max(...values.map(([, v]) => v.length));
    for (let i = 0; i < picks; i++) {
      const body: Record<string, unknown> = {};
      for (const [key, list] of values) body[key] = list[i % list.length];
      body.bodyMarks = [BodyMark.options[i % 7], BodyMark.options[(i + 3) % 7]];
      const parsed = AvatarBody.parse(body);
      const phrase = bodyPhrase(parsed) ?? "";
      expect(phrase.length).toBeGreaterThan(0);
      expect(youthWords(phrase, "descriptor")).toEqual([]);
      expect(adultTextProblems(phrase, 21, "descriptor")).toEqual([]);
      expect(adultTextProblems(phrase, 35, "descriptor")).toEqual([]);
    }
  });
});

describe("BODY_PHRASE_MAX", () => {
  // The longest phrase: each slot at its longest rendering, and the two longest body marks. Slot lengths add up, so no other combination is longer.
  const lengthOf = (body: AvatarBody): number => (bodyPhrase(body) ?? "").length;
  const longestOf = (candidates: AvatarBody[]): AvatarBody => [...candidates].sort((a, b) => lengthOf(b) - lengthOf(a))[0] as AvatarBody;
  const slot = (key: Exclude<BodyKey, "bodyMarks">): AvatarBody[] => VALUES[key].map((value) => ({ [key]: value }) as AvatarBody);
  const pairs = (first: Exclude<BodyKey, "bodyMarks">, second: Exclude<BodyKey, "bodyMarks">): AvatarBody[] =>
    VALUES[first].flatMap((a) => VALUES[second].map((b) => ({ [first]: a, [second]: b }) as AvatarBody));
  function longestBody(): AvatarBody {
    const marks = [...BodyMark.options].sort((a, b) => lengthOf({ bodyMarks: [b] }) - lengthOf({ bodyMarks: [a] }));
    return {
      ...longestOf(slot("height")),
      ...longestOf(slot("bust")),
      ...longestOf(slot("figure")),
      ...longestOf(pairs("legLength", "legShape")),
      ...longestOf(pairs("bottomSize", "bottomShape")),
      bodyMarks: [marks[0] as (typeof BodyMark.options)[number], marks[1] as (typeof BodyMark.options)[number]],
    };
  }

  test("is the length of the longest phrase any body renders to", () => {
    expect((bodyPhrase(longestBody()) ?? "").length).toBe(BODY_PHRASE_MAX);
  });

  test("no combination of the slots renders longer", () => {
    const unset = [undefined];
    const markSets: AvatarBody["bodyMarks"][] = [undefined, ...BodyMark.options.map((m) => [m]), ...BodyMark.options.flatMap((a, i) => BodyMark.options.slice(i + 1).map((b) => [a, b]))];
    let longest = 0;
    for (const height of [...unset, ...VALUES.height])
      for (const bust of [...unset, ...VALUES.bust])
        for (const figure of [...unset, ...VALUES.figure])
          for (const legLength of [...unset, ...VALUES.legLength])
            for (const legShape of [...unset, ...VALUES.legShape])
              for (const bottomSize of [...unset, ...VALUES.bottomSize])
                for (const bottomShape of [...unset, ...VALUES.bottomShape])
                  for (const bodyMarks of markSets) {
                    const body = AvatarBody.parse({ height, bust, figure, legLength, legShape, bottomSize, bottomShape, bodyMarks });
                    longest = Math.max(longest, (bodyPhrase(body) ?? "").length);
                  }
    expect(longest).toBe(BODY_PHRASE_MAX);
  });

  test("is well inside the descriptor's 600 characters (the mockup measured 258)", () => {
    expect(BODY_PHRASE_MAX).toBeLessThanOrEqual(260);
    expect(BODY_PHRASE_MAX).toBeGreaterThan(200);
  });

  test("the longest phrase passes the adult-text rules", () => {
    const phrase = bodyPhrase(longestBody()) ?? "";
    expect(adultTextProblems(phrase, 25, "descriptor")).toEqual([]);
  });
});

describe("bodyFromRecord", () => {
  test("reads the body keys out of a stored traits record and ignores the other traits", () => {
    expect(bodyFromRecord({ build: "slim", hairColor: "black", height: "tall", bodyMarks: ["mole-back"] })).toEqual({ height: "tall", bodyMarks: ["mole-back"] });
  });

  test("is undefined when the record has no body key", () => {
    expect(bodyFromRecord({ build: "slim", marks: ["freckles"] })).toBeUndefined();
  });

  test("is undefined when the only body key is an empty list", () => {
    expect(bodyFromRecord({ bodyMarks: [] })).toBeUndefined();
  });

  test("drops the WHOLE body when one key does not parse: a half body would be a different woman", () => {
    expect(bodyFromRecord({ height: "tall", bust: "gigantic" })).toBeUndefined();
  });

  test("drops the body for three marks and for a repeated mark", () => {
    expect(bodyFromRecord({ bodyMarks: ["tattoo-ankle", "tattoo-hip", "mole-back"] })).toBeUndefined();
    expect(bodyFromRecord({ bodyMarks: ["mole-back", "mole-back"] })).toBeUndefined();
  });

  test("drops the body when a text key holds a list", () => {
    expect(bodyFromRecord({ height: ["tall"] })).toBeUndefined();
  });
});
