import { describe, expect, test } from "bun:test";
import { POOL_TIMES, youthWords } from "../../shared/engine";
import { sentenceProblems } from "./assembler";
import { artefactLine, CAPTURE_LINE, CONSTRAINTS, IMPERFECTIONS, lightOf, phoneHandLine, roomStateOf } from "./phoneLook";
import { POOLS, type Place, type Pool } from "./pools";
import { firstHit, NEGATED_LOOK, PAPER_AND_SCREENS, SOFT_LIST, STAGING, SWEEP_CUSTOM_POOL } from "./testing/lookRules";
import { CATEGORIES, SHOTS } from "./types";
import { REVEALING_WORDS } from "./words";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// S5.1d: the pools sweep. Every built-in place, locative phrase, room detail, activity and outfit passes the hard lists (the engine's own youth-word and
// revealing-word checks, via sentenceProblems, the same two the writer's reader and the assembler's last gate run) and the soft list, and names no paper or
// screen: a pool phrase goes straight into the writer's slot and from there into the prompt (I5.3, plan §6.4 «the load-time sweep»). The look module's own
// phrases, which no pool feeds, take the same lists.

interface PoolText {
  where: string;
  text: string;
}

function textsOf(category: string, pool: Pool): PoolText[] {
  const out: PoolText[] = pool.outfits.map((text, i) => ({ where: `${category}.outfits[${i}]`, text }));
  for (const place of pool.locations) {
    out.push({ where: `${category}/${place.name}`, text: place.name });
    if (place.at !== undefined) out.push({ where: `${category}/${place.name}.at`, text: place.at });
    for (const detail of place.details ?? []) out.push({ where: `${category}/${place.name}.details`, text: detail });
    for (const activity of place.activities) out.push({ where: `${category}/${place.name}.activity`, text: activity.text });
  }
  return out;
}

const BUILT_IN = CATEGORIES.flatMap((c) => textsOf(c, POOLS[c]));
const CUSTOM = textsOf("custom", SWEEP_CUSTOM_POOL);

const failures = (texts: readonly PoolText[], check: (text: string) => string | null): Array<{ where: string; text: string; hit: string }> =>
  texts.flatMap(({ where, text }) => {
    const hit = check(text);
    return hit === null ? [] : [{ where, text, hit }];
  });

describe("the built-in pools: the hard lists", () => {
  test("the sweep reads every place, detail, activity and outfit (it is not vacuous)", () => {
    const places = CATEGORIES.reduce((n, c) => n + POOLS[c].locations.length, 0);
    expect(places).toBeGreaterThanOrEqual(20);
    expect(BUILT_IN.length).toBeGreaterThan(places * 3);
  });

  test("no text carries a youth word (the engine's own check, descriptor scope)", () => {
    expect(failures(BUILT_IN, (t) => youthWords(t, "descriptor")[0] ?? null)).toEqual([]);
  });

  test("no text carries a revealing word", () => {
    expect(failures(BUILT_IN, (t) => REVEALING_WORDS.exec(t)?.[0] ?? null)).toEqual([]);
  });

  test("every text passes the assembler's last gate (sentenceProblems), alone and as the writer's stand-in sentence", () => {
    expect(failures(BUILT_IN, (t) => sentenceProblems(t)[0]?.reason ?? null)).toEqual([]);
    for (const category of CATEGORIES) {
      for (const place of POOLS[category].locations) {
        for (const activity of place.activities) {
          for (const outfit of POOLS[category].outfits) expect(sentenceProblems(`She is ${activity.text} at ${place.name}, wearing ${outfit}`)).toEqual([]);
        }
      }
    }
  });

  test("the fixture custom pool passes them too (a stored custom category is swept the same way)", () => {
    expect(failures(CUSTOM, (t) => youthWords(t, "descriptor")[0] ?? REVEALING_WORDS.exec(t)?.[0] ?? null)).toEqual([]);
  });
});

describe("the built-in pools: the soft list, paper and screens", () => {
  test("no text uses a word of the soft list (studio, photographer, editorial, golden hour, luxury and mood words)", () => {
    expect(failures(BUILT_IN, (t) => SOFT_LIST.exec(t)?.[0] ?? null)).toEqual([]);
  });

  test("no text names paper, a book, a screen, a desk or studying: her phone is the only screen", () => {
    expect(failures(BUILT_IN, (t) => PAPER_AND_SCREENS.exec(t)?.[0] ?? null)).toEqual([]);
  });

  test("no text stages a camera or negates a look term", () => {
    expect(failures(BUILT_IN, (t) => firstHit(t, [...STAGING, ...NEGATED_LOOK]))).toEqual([]);
  });

  test("no place is lit by the stored «studio lighting» time (it stays readable for old plans, I5.5, but no new plan draws it)", () => {
    for (const category of CATEGORIES) for (const place of POOLS[category].locations as readonly Place[]) expect(place.times).not.toContain("studio lighting");
  });
});

describe("the look module's own phrases take the same lists", () => {
  const ROOM = { room: true, details: ["a kettle on the counter", "a fruit bowl", "a towel on the oven door"], activity: { messyOk: true } };
  const phrases = (): PoolText[] => {
    const out: PoolText[] = [];
    for (const shot of SHOTS) {
      out.push({ where: `CAPTURE_LINE.${shot}`, text: CAPTURE_LINE[shot] });
      out.push({ where: `phoneHandLine(${shot})`, text: phoneHandLine(shot) ?? "" });
      for (const text of IMPERFECTIONS[shot]) out.push({ where: `IMPERFECTIONS.${shot}`, text });
    }
    out.push({ where: "CONSTRAINTS", text: CONSTRAINTS });
    for (const time of [...POOL_TIMES, "twilight", undefined]) out.push({ where: `lightOf(${String(time)})`, text: lightOf(time) });
    for (const light of POOL_TIMES.map(lightOf)) for (const realism of [true, false]) for (const imperfection of Object.values(IMPERFECTIONS).flat()) out.push({ where: "artefactLine", text: artefactLine({ cameraRealism: realism, light, imperfection }) });
    for (let i = 0; i < 400; i++) {
      const text = roomStateOf(`run-${i}:slot-${(i % 9) + 1}`, ROOM);
      if (text !== null) out.push({ where: "roomStateOf", text });
    }
    return out;
  };

  test("the light table has a phrase for every stored time, none of them a staging word", () => {
    for (const time of POOL_TIMES) expect(lightOf(time)).not.toBe("");
    expect(failures(POOL_TIMES.map((t) => ({ where: t, text: lightOf(t) })), (t) => SOFT_LIST.exec(t)?.[0] ?? firstHit(t, STAGING))).toEqual([]);
  });

  test("no phrase carries a soft-list word, a staging phrase, a negated look term, a youth word or a revealing word", () => {
    expect(failures(phrases(), (t) => SOFT_LIST.exec(t)?.[0] ?? firstHit(t, [...STAGING, ...NEGATED_LOOK]) ?? youthWords(t, "descriptor")[0] ?? REVEALING_WORDS.exec(t)?.[0] ?? null)).toEqual([]);
  });

  test("every phrase passes sentenceProblems", () => {
    expect(failures(phrases(), (t) => sentenceProblems(t)[0]?.reason ?? null)).toEqual([]);
  });
});
