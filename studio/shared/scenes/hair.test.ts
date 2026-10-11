import { describe, expect, test } from "bun:test";
import { HAIRSTYLES } from "./banks";
import type { HairLength } from "./banks/types";
import { capCap, hairstyleSequence, sportyOf, tiedCap, type HairSlot } from "./hair";

// 5a.2 (S5.6a, plan s5a2 §5.3, I5.24, I5.25) with probe P-5a2 (2026-10-11): a messy bun lost likeness (cos 0.714 under the 0.718 bar), so a tied
// style goes only to a moment tagged `tied`, and to at most 1 in 4 photos of a run. A cap goes only to an outdoor moment, at most 1 in 8. A moment
// that names her hair, and a legs frame, get no hair line. Styles avoid the previous 3, then the previous 1, then take any (deterministic).

const LENGTHS: readonly HairLength[] = ["bob", "shoulder", "long"];
const style = (text: string | null) => HAIRSTYLES.find((s) => s.text === text);

/** A run's slots: a fixed mix of tied, loose, own-hair, outdoor and legs moments, varied by seed. */
function slotsOf(n: number, seed: number): HairSlot[] {
  return Array.from({ length: n }, (_, i) => {
    const kind = (i * 7 + seed * 3) % 6;
    if (kind === 0) return { hair: "tied" };
    if (kind === 1) return { hair: "tied", outdoor: true };
    if (kind === 2) return { outdoor: true };
    if (kind === 3) return { hair: "own" };
    if (kind === 4 && seed % 5 === 0) return { framing: "legs" };
    return {};
  });
}

describe("the run caps", () => {
  test.each<[number, number, number]>([
    [1, 0, 0],
    [3, 0, 0],
    [4, 1, 0],
    [7, 1, 0],
    [8, 2, 1],
    [25, 6, 3],
    [100, 25, 12],
  ])("%p photos: at most %p tied and %p caps", (n, tied, caps) => {
    expect(tiedCap(n)).toBe(tied);
    expect(capCap(n)).toBe(caps);
  });
});

describe("hairstyleSequence", () => {
  const RUNS = Array.from({ length: 60 }, (_, i) => ({ n: [1, 3, 4, 8, 10, 25, 50, 100][i % 8] ?? 10, seed: i }));

  test.each([...LENGTHS])("%s: a tied style only on a tied moment, at most 1 in 4 of the run", (length) => {
    for (const { n, seed } of RUNS) {
      const slots = slotsOf(n, seed);
      const styles = hairstyleSequence(slots, length, `run-${seed}`);
      styles.forEach((text, i) => {
        if (style(text)?.tied === true) expect(slots[i]?.hair).toBe("tied");
      });
      expect(styles.filter((text) => style(text)?.tied === true).length).toBeLessThanOrEqual(tiedCap(n));
    }
  });

  test.each([...LENGTHS])("%s: a cap only on an outdoor moment, at most 1 in 8 of the run", (length) => {
    for (const { n, seed } of RUNS) {
      const slots = slotsOf(n, seed);
      const styles = hairstyleSequence(slots, length, `run-${seed}`);
      styles.forEach((text, i) => {
        if (style(text)?.cap === true) expect(slots[i]?.outdoor).toBe(true);
      });
      expect(styles.filter((text) => style(text)?.cap === true).length).toBeLessThanOrEqual(capCap(n));
    }
  });

  test("a tied moment takes a tied style while the run has some left", () => {
    const styles = hairstyleSequence([{ hair: "tied" }, {}, {}, {}], "long", "run-1");
    expect(style(styles[0] ?? null)?.tied).toBe(true);
  });

  test("the run's tied styles are spread over its tied moments; a tied moment over the cap takes a loose style, never none", () => {
    const styles = hairstyleSequence(Array.from({ length: 8 }, () => ({ hair: "tied" as const })), "shoulder", "run-1");
    expect(styles.map((t) => style(t)?.tied)).toEqual([false, false, false, true, false, false, false, true]);
  });

  test("a run with few tied moments gives each of them a tied style, up to the cap", () => {
    const slots: HairSlot[] = Array.from({ length: 24 }, (_, i) => (i === 2 || i === 19 ? { hair: "tied" } : {}));
    const styles = hairstyleSequence(slots, "long", "run-2");
    expect(styles.flatMap((t, i) => (style(t)?.tied === true ? [i] : []))).toEqual([2, 19]);
  });

  test("a moment that names her hair, and a legs frame, get no hair line", () => {
    expect(hairstyleSequence([{ hair: "own" }, { framing: "legs" }, {}], "long", "run-1").slice(0, 2)).toEqual([null, null]);
  });

  test.each([...LENGTHS])("%s: every style fits the hair length", (length) => {
    for (const { n, seed } of RUNS) for (const text of hairstyleSequence(slotsOf(n, seed), length, `run-${seed}`)) if (text !== null) expect(style(text)?.lengths).toContain(length);
  });

  test.each([...LENGTHS])("%s: no style repeats one of the previous 3 when there are 4 to choose from, and never the previous one when there are 2", (length) => {
    for (const { n, seed } of RUNS) {
      const slots = slotsOf(n, seed);
      const styles = hairstyleSequence(slots, length, `run-${seed}`);
      const drawn: string[] = [];
      styles.forEach((text) => {
        if (text === null) return;
        const previous = drawn.slice(-3);
        const looseChoices = HAIRSTYLES.filter((s) => s.lengths.includes(length) && !s.tied && s.cap !== true).length;
        if (looseChoices >= 4 && style(text)?.tied === false && style(text)?.cap !== true) expect(previous.filter((p) => style(p)?.tied === false && style(p)?.cap !== true)).not.toContain(text);
        if (drawn.length > 0) expect(text).not.toBe(drawn[drawn.length - 1]);
        drawn.push(text);
      });
    }
  });

  test("a bob in a run of tied moments varies its loose styles over the cap, deterministically", () => {
    const slots: HairSlot[] = Array.from({ length: 12 }, () => ({ hair: "tied" }));
    const styles = hairstyleSequence(slots, "bob", "run-fitness");
    expect(styles.filter((t) => style(t)?.tied === true).length).toBe(3);
    expect(new Set(styles).size).toBeGreaterThanOrEqual(4);
    expect(hairstyleSequence(slots, "bob", "run-fitness")).toEqual(styles);
  });

  test("is a pure function of the slots, the length and the run id (a resume draws the same styles)", () => {
    const slots = slotsOf(25, 3);
    expect(hairstyleSequence(slots, "shoulder", "run-a")).toEqual(hairstyleSequence(slots, "shoulder", "run-a"));
    expect(hairstyleSequence(slots, "shoulder", "run-a")).not.toEqual(hairstyleSequence(slots, "shoulder", "run-b"));
  });

  test("varies: over a 25-photo run of ordinary moments, 4 styles at least", () => {
    for (const length of LENGTHS) expect(new Set(hairstyleSequence(Array.from({ length: 25 }, () => ({})), length, "run-v")).size).toBeGreaterThanOrEqual(3);
    expect(new Set(hairstyleSequence(Array.from({ length: 25 }, (_, i) => (i % 4 === 0 ? { hair: "tied" } : {})), "long", "run-v")).size).toBeGreaterThanOrEqual(4);
  });
});

// S5.6R (round C): «blow-dried smooth» on about 70 % of «Фитнес» frames. A workout moment is a `sport` moment: a sporty style (a ponytail, a sleek bun, a
// braid, tied or pinned back) on 3 in 4 of the run's sport moments, spread over them, the rest a loose style. The tied cap (1 in 4 of the run) stays for
// `tied` moments; a sporty style is not counted in it. The messy buns (probe P-5a2's likeness loss), the half-up styles and the twisted-up clip are not sporty.
describe("a sport moment's sporty styles", () => {
  const SPORTY = HAIRSTYLES.filter((s) => s.sport === true);

  test.each<[number, number]>([
    [0, 0],
    [1, 1],
    [3, 3],
    [4, 3],
    [5, 4],
    [12, 9],
    [20, 15],
  ])("%p sport moments: %p sporty", (moments, sporty) => {
    expect(sportyOf(moments)).toBe(sporty);
  });

  test("a sporty style is a ponytail, a sleek bun, a braid, or tied or pinned back, and is tied", () => {
    expect(SPORTY.map((s) => s.text).every((text) => /ponytail|sleek low bun|braid|tied back|pinned back/.test(text))).toBe(true);
    expect(SPORTY.every((s) => s.tied)).toBe(true);
    expect(SPORTY.map((s) => s.text).filter((text) => /messy|half up|twisted/.test(text))).toEqual([]);
  });

  test.each([...LENGTHS])("%s: two sporty styles at least", (length) => {
    expect(SPORTY.filter((s) => s.lengths.includes(length)).length).toBeGreaterThanOrEqual(2);
  });

  test.each([...LENGTHS])("%s: a run of 12 sport moments wears 9 sporty styles, spread over it, and 3 loose ones", (length) => {
    const styles = hairstyleSequence(Array.from({ length: 12 }, () => ({ hair: "sport" as const })), length, "run-fitness");
    // The tied styles' even spread (tiedTurn): one loose style in every 4 photos.
    expect(styles.map((t) => style(t)?.sport === true)).toEqual([false, true, true, true, false, true, true, true, false, true, true, true]);
    expect(styles.filter((t) => style(t)?.sport !== true).every((t) => style(t)?.tied === false)).toBe(true);
  });

  test("a sporty style is not counted in the tied cap: the run's tied moments still take theirs", () => {
    const slots: HairSlot[] = Array.from({ length: 8 }, (_, i) => (i < 4 ? { hair: "sport" } : { hair: "tied" }));
    const styles = hairstyleSequence(slots, "long", "run-3");
    expect(styles.slice(0, 4).filter((t) => style(t)?.sport === true)).toHaveLength(3);
    expect(styles.slice(4).filter((t) => style(t)?.tied === true)).toHaveLength(tiedCap(8));
  });

  test("an outdoor sport moment past its sporty share may take the cap, within the run's 1 in 8", () => {
    for (let seed = 0; seed < 40; seed++) {
      const slots: HairSlot[] = Array.from({ length: 16 }, () => ({ hair: "sport", outdoor: true }));
      const styles = hairstyleSequence(slots, "shoulder", `run-${seed}`);
      expect(styles.filter((t) => style(t)?.cap === true).length).toBeLessThanOrEqual(capCap(16));
      styles.forEach((t) => {
        if (style(t)?.cap === true) expect(style(t)?.sport).toBeUndefined();
      });
    }
  });
});
