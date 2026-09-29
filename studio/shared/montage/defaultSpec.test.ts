import { describe, expect, test } from "bun:test";
import { MAX_TOTAL_MS, MIN_TOTAL_MS, MontageDraft, MontageSpec } from "../engine/montage";
import { defaultSpec } from "./defaultSpec";
import { mulberry32, randId } from "./random.testkit";
import { splitEvenly } from "./split";

const AVATAR = "avatar-default-0001";
const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `photo-default-${String(i + 1).padStart(3, "0")}`);
const totalMs = (spec: MontageDraft): number => spec.clips.reduce((s, c) => s + c.durationMs, 0);

describe("defaultSpec: 0 photos is «Новый монтаж»", () => {
  test("gives an empty draft: no clips, no layers, no music", () => {
    expect(defaultSpec(AVATAR, [], 5)).toEqual({ schemaVersion: 1, avatarId: AVATAR, clips: [], layers: [], music: null, seed: 5 });
  });

  test("is a valid draft but not yet a renderable spec", () => {
    const spec = defaultSpec(AVATAR, [], 5);
    expect(MontageDraft.safeParse(spec).success).toBe(true);
    expect(MontageSpec.safeParse(spec).success).toBe(false);
  });
});

describe("defaultSpec: one photo", () => {
  test("is one photo clip of 8.0 s with Ken Burns and no focus yet", () => {
    expect(defaultSpec(AVATAR, ids(1), 9).clips).toEqual([
      { clipId: "clip-001", durationMs: 8000, transitionIn: "cut", kind: "photo", cell: { photo: { source: "scene", photoId: "photo-default-001" }, focus: null }, motion: "kenburns" },
    ]);
  });
});

describe.each([2, 3, 4])("defaultSpec: %i photos", (n) => {
  test(`is one collage${n} clip of 8.0 s, Ken Burns, stagger on, cells in the photos' order`, () => {
    const spec = defaultSpec(AVATAR, ids(n), 9);
    expect(spec.clips).toHaveLength(1);
    expect(spec.clips[0]).toEqual({
      clipId: "clip-001",
      durationMs: 8000,
      transitionIn: "cut",
      kind: "collage",
      layout: `collage${n}`,
      cells: ids(n).map((photoId) => ({ photo: { source: "scene", photoId }, focus: null })),
      motion: "kenburns",
      stagger: true,
    });
  });
});

describe("defaultSpec: 5 to 20 photos are slides", () => {
  test("5 photos: 6.5 s (5 x 1.3 s) in five 1300 ms photo clips", () => {
    const spec = defaultSpec(AVATAR, ids(5), 1);
    expect(spec.clips.map((c) => c.durationMs)).toEqual([1300, 1300, 1300, 1300, 1300]);
  });

  test("the total is clamp(N x 1.3 s, 4 s, 15 s): 11 photos are 14.3 s, 12 and more are 15.0 s", () => {
    expect(totalMs(defaultSpec(AVATAR, ids(11), 1))).toBe(14_300);
    expect(totalMs(defaultSpec(AVATAR, ids(12), 1))).toBe(15_000);
    expect(totalMs(defaultSpec(AVATAR, ids(20), 1))).toBe(15_000);
  });

  test("20 photos are ten 800 ms and ten 700 ms clips (0.75 s each is not on the 100 ms grid)", () => {
    expect(defaultSpec(AVATAR, ids(20), 1).clips.map((c) => c.durationMs)).toEqual(splitEvenly(15_000, 20));
  });

  test("every slide is a Ken Burns photo clip of one scene photo, in the given order", () => {
    const spec = defaultSpec(AVATAR, ids(7), 1);
    spec.clips.forEach((clip, i) => {
      expect(clip.kind).toBe("photo");
      if (clip.kind !== "photo") return;
      expect(clip.motion).toBe("kenburns");
      expect(clip.cell).toEqual({ photo: { source: "scene", photoId: ids(7)[i] }, focus: null });
    });
  });
});

describe("defaultSpec: refusals and purity", () => {
  test("refuses more than 20 photos", () => {
    expect(() => defaultSpec(AVATAR, ids(21), 1)).toThrow(RangeError);
  });

  test("refuses the same photo twice (a scene photo appears at most once per montage)", () => {
    expect(() => defaultSpec(AVATAR, ["photo-dup-0001", "photo-dup-0001"], 1)).toThrow(RangeError);
  });

  test.each([-1, 1.5, 4_294_967_296, Number.NaN])("refuses the seed %p", (seed) => {
    expect(() => defaultSpec(AVATAR, ids(1), seed)).toThrow(RangeError);
  });

  test("takes the seed from the caller, at its boundaries too, and is deterministic", () => {
    expect(defaultSpec(AVATAR, ids(3), 0).seed).toBe(0);
    expect(defaultSpec(AVATAR, ids(3), 4_294_967_295).seed).toBe(4_294_967_295);
    expect(defaultSpec(AVATAR, ids(6), 77)).toEqual(defaultSpec(AVATAR, ids(6), 77));
  });

  test("does not keep a reference to the caller's array", () => {
    const photoIds = ids(2);
    const spec = defaultSpec(AVATAR, photoIds, 1);
    photoIds.push("photo-late-0001");
    expect(spec.clips).toHaveLength(1);
    expect(JSON.stringify(spec)).not.toContain("photo-late-0001");
  });
});

describe("defaultSpec: every count 0 to 20 passes the contract's validation", () => {
  test("0 gives a valid draft, 1 to 20 give a valid, renderable spec of 4.0 to 15.0 s with unique clip ids", () => {
    const rand = mulberry32(91);
    for (let n = 0; n <= 20; n++) {
      const photoIds = Array.from({ length: n }, () => randId(rand));
      const spec = defaultSpec(AVATAR, photoIds, n * 1000);
      expect(MontageDraft.safeParse(spec).success).toBe(true);
      if (n === 0) continue;
      const parsed = MontageSpec.safeParse(spec);
      expect(parsed.success).toBe(true);
      expect(totalMs(spec)).toBeGreaterThanOrEqual(MIN_TOTAL_MS);
      expect(totalMs(spec)).toBeLessThanOrEqual(MAX_TOTAL_MS);
      expect(new Set(spec.clips.map((c) => c.clipId)).size).toBe(spec.clips.length);
    }
  });
});
