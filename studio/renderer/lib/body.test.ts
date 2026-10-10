import { describe, expect, test } from "bun:test";
import { AvatarBody, AvatarTraits, bodyPhrase, BODY_MARKS_MAX, type BodyProposal } from "../../shared/engine";
import {
  BODY_ENUMS,
  BODY_FIELDS,
  BODY_MARKS,
  BOTTOM_SHAPES,
  BOTTOM_SIZES,
  bodyOfTraits,
  bodyPhraseDiff,
  bodySetCount,
  buildInText,
  BUSTS,
  descriptorHead,
  FIELD_LABEL,
  fieldSet,
  fieldValue,
  FIGURES,
  HEIGHTS,
  LEG_LENGTHS,
  LEG_SHAPES,
  proposalHint,
  proposalSources,
  proposedBody,
  randomBody,
  sameBody,
  textLimit,
  tidyBody,
  withBody,
} from "./body";
import { DEFAULT_TRAITS, randomTraits } from "./traits";

// S5.2d: the body as the window shows it. The English phrase is `bodyPhrase`'s (shared/engine/body.test.ts); here, the labels, the «N / 6» count,
// «Случайно», the summary, the build read from the text, and an import's proposal.

/** A small deterministic generator (LCG), as traits.test.ts uses. */
function seeded(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
}

const FULL: AvatarBody = {
  height: "average",
  bust: "medium",
  figure: "hourglass",
  legLength: "long",
  legShape: "slim",
  bottomSize: "medium",
  bottomShape: "round",
  bodyMarks: ["tattoo-ankle"],
};

function proposal(values: AvatarBody, seen: BodyProposal["seen"]): BodyProposal {
  return { values, seen, at: "2026-10-10T10:00:00.000Z" };
}

const ALL_HIDDEN: BodyProposal["seen"] = {
  height: "not-visible",
  bust: "not-visible",
  figure: "not-visible",
  legLength: "not-visible",
  legShape: "not-visible",
  bottomSize: "not-visible",
  bottomShape: "not-visible",
  bodyMarks: "not-visible",
};

describe("the choices", () => {
  test("every list covers its contract enum exactly, in the mockup's order", () => {
    const values = (list: readonly { value: string }[]): string[] => list.map((c) => c.value);
    expect(values(HEIGHTS)).toEqual([...BODY_ENUMS.height]);
    expect(values(BUSTS)).toEqual([...BODY_ENUMS.bust]);
    expect(values(FIGURES)).toEqual([...BODY_ENUMS.figure]);
    expect(values(LEG_LENGTHS)).toEqual([...BODY_ENUMS.legLength]);
    expect(values(LEG_SHAPES)).toEqual([...BODY_ENUMS.legShape]);
    expect(values(BOTTOM_SIZES)).toEqual([...BODY_ENUMS.bottomSize]);
    expect(values(BOTTOM_SHAPES)).toEqual([...BODY_ENUMS.bottomShape]);
    expect(values(BODY_MARKS)).toEqual([...BODY_ENUMS.bodyMarks]);
  });

  test("the labels are the mockup's (README «Поля «Тела»»)", () => {
    const labels = (list: readonly { label: string }[]): string[] => list.map((c) => c.label);
    expect(labels(HEIGHTS)).toEqual(["Невысокий", "Средний", "Высокий"]);
    expect(labels(BUSTS)).toEqual(["Небольшая", "Средняя", "Большая"]);
    expect(labels(FIGURES)).toEqual(["Прямая", "Песочные часы", "Груша", "Перевёрнутый треугольник", "Яблоко"]);
    expect(labels(LEG_LENGTHS)).toEqual(["Средние", "Длинные"]);
    expect(labels(LEG_SHAPES)).toEqual(["Стройные", "Подтянутые"]);
    expect(labels(BOTTOM_SIZES)).toEqual(["Небольшая", "Средняя", "Большая"]);
    expect(labels(BOTTOM_SHAPES)).toEqual(["Округлая", "Сердечком", "Подтянутая", "Широкая"]);
    expect(BODY_MARKS.map((m) => `${m.row}:${m.place}`)).toEqual([
      "tattoo:щиколотка",
      "tattoo:бедро",
      "tattoo:лопатка",
      "tattoo:рёбра",
      "mole:ключица",
      "mole:плечо",
      "mole:поясница",
    ]);
    expect(BODY_MARKS.map((m) => m.label)).toEqual([
      "Тату на щиколотке",
      "Тату на бедре",
      "Тату на лопатке",
      "Тату на рёбрах",
      "Родинка на ключице",
      "Родинка на плече",
      "Родинка на пояснице",
    ]);
    expect(BODY_FIELDS.map((f) => FIELD_LABEL[f])).toEqual(["Рост", "Грудь", "Фигура", "Ноги", "Попа", "Тату и родинки на теле"]);
  });
});

describe("«Тело N / 6»", () => {
  test("nothing set is 0, everything set is 6", () => {
    expect(bodySetCount({})).toBe(0);
    expect(bodySetCount(FULL)).toBe(6);
  });

  test("«Ноги» and «Попа» count once each, set by either part", () => {
    expect(bodySetCount({ legLength: "long" })).toBe(1);
    expect(bodySetCount({ legShape: "toned" })).toBe(1);
    expect(bodySetCount({ legLength: "long", legShape: "toned" })).toBe(1);
    expect(bodySetCount({ bottomShape: "wide" })).toBe(1);
    expect(bodySetCount({ bottomSize: "small", bottomShape: "heart" })).toBe(1);
  });

  test("an empty list of marks is unset; one or two marks are one field", () => {
    expect(fieldSet({ bodyMarks: [] }, "marks")).toBe(false);
    expect(bodySetCount({ bodyMarks: [] })).toBe(0);
    expect(bodySetCount({ bodyMarks: ["mole-back"] })).toBe(1);
    expect(bodySetCount({ bodyMarks: ["mole-back", "tattoo-hip"] })).toBe(1);
  });
});

describe("the body inside the wizard's traits", () => {
  test("old traits have none", () => {
    expect(bodyOfTraits(DEFAULT_TRAITS)).toEqual({});
  });

  test("withBody replaces the whole body and drops unset keys and an empty mark list", () => {
    const set = withBody(DEFAULT_TRAITS, FULL);
    expect(bodyOfTraits(set)).toEqual(FULL);
    const next = withBody(set, { bust: "small", height: undefined, bodyMarks: [] });
    expect(bodyOfTraits(next)).toEqual({ bust: "small" });
    expect(Object.keys(next).sort()).toEqual([...Object.keys(DEFAULT_TRAITS), "bust"].sort());
    expect(AvatarTraits.safeParse(next).success).toBe(true);
  });

  test("tidyBody and sameBody: unset keys and an empty list say nothing; marks compare as a set", () => {
    expect(tidyBody({ height: undefined, bodyMarks: [], bust: "full" })).toEqual({ bust: "full" });
    expect(sameBody({ bodyMarks: [] }, {})).toBe(true);
    expect(sameBody({ bodyMarks: ["mole-back", "tattoo-hip"] }, { bodyMarks: ["tattoo-hip", "mole-back"] })).toBe(true);
    expect(sameBody({ bodyMarks: ["mole-back"] }, { bodyMarks: ["tattoo-hip"] })).toBe(false);
    expect(sameBody(FULL, { ...FULL, height: "tall" })).toBe(false);
    expect(sameBody(FULL, { ...FULL })).toBe(true);
  });
});

describe("«Случайно» (owner's decision: it fills the body too)", () => {
  test("every body passes the contract, with 0–1 marks and never an empty list", () => {
    const rng = seeded(7);
    for (let i = 0; i < 2000; i++) {
      const body = randomBody(rng);
      expect(AvatarBody.safeParse(body).success).toBe(true);
      expect((body.bodyMarks?.length ?? 0) <= 1).toBe(true);
      expect(body.bodyMarks === undefined || body.bodyMarks.length === 1).toBe(true);
    }
  });

  test("each field reaches «не задано» and every value; marks reach none and every mark", () => {
    const rng = seeded(11);
    const seen: Record<string, Set<string>> = {};
    for (let i = 0; i < 3000; i++) {
      const body: Record<string, unknown> = { ...randomBody(rng) };
      for (const key of Object.keys(BODY_ENUMS)) {
        const value = body[key];
        const tokens = Array.isArray(value) ? value.map(String) : [value === undefined ? "(unset)" : String(value)];
        for (const token of tokens) (seen[key] ??= new Set()).add(token);
      }
    }
    for (const [key, options] of Object.entries(BODY_ENUMS)) expect([...(seen[key] ?? [])].sort()).toEqual([...options, "(unset)"].sort());
  });

  test("the edge values of a generator still give a valid body", () => {
    expect(AvatarBody.safeParse(randomBody(() => 0)).success).toBe(true);
    expect(AvatarBody.safeParse(randomBody(() => 0.999_999_9)).success).toBe(true);
  });

  test("randomTraits carries a random body, almost always with something set", () => {
    const rng = seeded(42);
    let withSome = 0;
    for (let i = 0; i < 500; i++) {
      const traits = randomTraits(rng);
      expect(AvatarTraits.safeParse(traits).success).toBe(true);
      if (bodySetCount(bodyOfTraits(traits)) > 0) withSome += 1;
    }
    expect(withSome > 400).toBe(true);
  });
});

describe("the summary on «Внешность»", () => {
  test("each field as the mockup's 09–13 say it", () => {
    expect(BODY_FIELDS.map((f) => fieldValue(FULL, f))).toEqual(["Средний", "Средняя", "Песочные часы", "Длинные · стройные", "Средняя · округлая", "Тату на щиколотке"]);
    expect(fieldValue({ bottomSize: "small", bottomShape: "toned" }, "bottom")).toBe("Небольшая · подтянутая");
  });

  test("a pair with one part says that part; marks in the list's order", () => {
    expect(fieldValue({ legShape: "toned" }, "legs")).toBe("Подтянутые");
    expect(fieldValue({ legLength: "average" }, "legs")).toBe("Средние");
    expect(fieldValue({ bottomShape: "wide" }, "bottom")).toBe("Широкая");
    expect(fieldValue({ bodyMarks: ["mole-collarbone", "tattoo-hip"] }, "marks")).toBe("Тату на бедре · Родинка на ключице");
  });

  test("unset is null, an empty list of marks too", () => {
    expect(BODY_FIELDS.map((f) => fieldValue({ bodyMarks: [] }, f))).toEqual([null, null, null, null, null, null]);
  });
});

describe("a change of the body phrase, slot by slot (08)", () => {
  const kept = (parts: readonly { kind: string; text: string }[]): string => parts.filter((p) => p.kind !== "del").map((p) => p.text).join("");
  const struck = (parts: readonly { kind: string; text: string }[]): string[] => parts.filter((p) => p.kind === "del").map((p) => p.text);

  test("the mockup's 08: each changed slot struck out and its new words inserted, the new slots inserted", () => {
    const before: AvatarBody = { height: "tall", bust: "full", figure: "straight" };
    const after: AvatarBody = { height: "average", bust: "small", figure: "inverted-triangle", legLength: "long", legShape: "slim", bottomSize: "small", bottomShape: "toned", bodyMarks: ["mole-collarbone"] };
    expect(bodyPhraseDiff(before, after)).toEqual([
      { kind: "del", text: "tall" },
      { kind: "ins", text: "average height" },
      { kind: "same", text: ", " },
      { kind: "del", text: "a full bust" },
      { kind: "ins", text: "a small bust" },
      { kind: "same", text: ", " },
      { kind: "del", text: "a straight figure" },
      { kind: "ins", text: "an inverted-triangle figure with shoulders broader than her hips" },
      { kind: "same", text: ", " },
      { kind: "ins", text: "long slim legs" },
      { kind: "same", text: ", " },
      { kind: "ins", text: "a small toned bottom" },
      { kind: "same", text: " and " },
      { kind: "ins", text: "a small mole on her left collarbone" },
    ]);
  });

  test("a slot that went is struck out with its comma, where it stood", () => {
    expect(bodyPhraseDiff({ height: "tall", bust: "full", figure: "pear" }, { height: "tall", figure: "pear" })).toEqual([
      { kind: "same", text: "tall" },
      { kind: "del", text: ", a full bust" },
      { kind: "same", text: " and a pear-shaped figure" },
    ]);
    expect(bodyPhraseDiff({ height: "tall", bust: "full" }, { bust: "full" })).toEqual([
      { kind: "del", text: "tall, " },
      { kind: "same", text: "a full bust" },
    ]);
    expect(bodyPhraseDiff({ height: "tall", bust: "full" }, {})).toEqual([
      { kind: "del", text: "tall" },
      { kind: "del", text: ", a full bust" },
    ]);
    expect(bodyPhraseDiff({}, {})).toEqual([]);
  });

  test("over random pairs, what is kept and inserted reads exactly the new phrase, and every old slot is kept or struck", () => {
    const rng = seeded(5);
    /** «Случайно»'s body with 0–2 marks (it draws 0–1), so the longest phrases, two marks and all, are covered too (review L4). */
    const anyBody = (): AvatarBody => {
      const marks = BODY_MARKS.filter(() => rng() < 0.3)
        .slice(0, 2)
        .map((m) => m.value);
      return tidyBody({ ...randomBody(rng), bodyMarks: marks });
    };
    let twoMarks = 0;
    for (let i = 0; i < 1500; i++) {
      const before = anyBody();
      const after = anyBody();
      if (before.bodyMarks?.length === 2 || after.bodyMarks?.length === 2) twoMarks += 1;
      const parts = bodyPhraseDiff(before, after);
      expect(kept(parts)).toBe(bodyPhrase(after) ?? "");
      const old = bodyPhrase(before);
      if (old === undefined) expect(struck(parts)).toEqual([]);
      // Struck and kept runs, in order, hold the old items in the old order.
      const oldItems = (old ?? "").split(/, | and /).filter(Boolean);
      const seen = parts
        .filter((p) => p.kind !== "ins")
        .map((p) => p.text)
        .join("|");
      let from = 0;
      for (const item of oldItems) {
        const at = seen.indexOf(item, from);
        expect(at >= from).toBe(true);
        from = at + item.length;
      }
    }
    expect(twoMarks > 100).toBe(true);
  });
});

describe("the descriptor as a prompt carries it", () => {
  test("the head drops the closing period, as promptSubject does", () => {
    expect(descriptorHead("25-year-old woman, athletic build.")).toBe("25-year-old woman, athletic build");
    expect(descriptorHead("25-year-old woman, athletic build. ")).toBe("25-year-old woman, athletic build");
    expect(descriptorHead("25-year-old woman")).toBe("25-year-old woman");
  });

  test("the text's limit is 600 less «; » and the phrase (L10), 600 without one", () => {
    const phrase = bodyPhrase(FULL);
    expect(textLimit(undefined)).toBe(600);
    expect(phrase === undefined ? null : textLimit(phrase)).toBe(600 - 2 - (phrase?.length ?? 0));
    expect(textLimit("tall")).toBe(594);
  });
});

describe("«Телосложение» read from the text (D1: read-only on «Внешность»)", () => {
  test("the build word the descriptor model writes", () => {
    expect(buildInText("25-year-old European woman, light olive skin, athletic build, light freckles.")).toBe("athletic");
    expect(buildInText("A woman with a Curvy figure")).toBe("curvy");
    expect(buildInText("a slim frame")).toBe("slim");
    expect(buildInText("soft physique")).toBe("soft");
  });

  test("a «soft» that is not about the body, or no build word, is none", () => {
    expect(buildInText("26-year-old woman, a soft jawline, long hair")).toBeNull();
    expect(buildInText("26-year-old woman, slim")).toBeNull();
    expect(buildInText("")).toBeNull();
  });
});

describe("an import's proposal", () => {
  test("a face-only photo (05): every field «не видно на фото», the build guessed from the face", () => {
    const p = proposal({}, ALL_HIDDEN);
    const sources = proposalSources(p);
    expect(BODY_FIELDS.map((f) => sources.fields[f] ?? "-")).toEqual(["none", "none", "none", "none", "none", "none"]);
    expect(sources.build).toBe("guess");
    expect(proposalHint(p)).toBe("на фото только лицо — тело выберите сами или оставьте «не задано»");
  });

  test("a photo to the waist (06): bust and figure «с фото», the rest named in the hint", () => {
    const p = proposal({ bust: "medium", figure: "hourglass" }, { ...ALL_HIDDEN, bust: "photo", figure: "photo" });
    const sources = proposalSources(p);
    expect(BODY_FIELDS.map((f) => sources.fields[f] ?? "-")).toEqual(["none", "photo", "photo", "none", "none", "none"]);
    expect(sources.build).toBe("photo");
    expect(proposalHint(p)).toBe("рост, ноги, попу и тату или родинки на фото не видно — выберите сами или оставьте «не задано»");
  });

  test("a pair is «с фото» when either part was seen; a key the answer left out has no tag", () => {
    const p = proposal({ legShape: "toned" }, { legLength: "not-visible", legShape: "photo" });
    const sources = proposalSources(p);
    expect(sources.fields.legs).toBe("photo");
    expect(sources.fields.height).toBeUndefined();
    expect(proposalHint(p)).toBe("тело прочитано с фото — проверьте и сохраните");
  });

  test("one hidden field is named alone", () => {
    const p = proposal({ height: "tall" }, { height: "photo", bust: "not-visible" });
    expect(proposalHint(p)).toBe("грудь на фото не видно — выберите сами или оставьте «не задано»");
  });

  test("the edit starts from her body with the photo's values on top", () => {
    const p = proposal({ bust: "full", bodyMarks: [] }, { bust: "photo" });
    expect(proposedBody({ height: "tall", bust: "small" }, p)).toEqual({ height: "tall", bust: "full" });
    expect(proposedBody(undefined, p)).toEqual({ bust: "full" });
  });

  test("the marks limit the window enforces is the contract's", () => {
    expect(BODY_MARKS_MAX).toBe(2);
  });
});
