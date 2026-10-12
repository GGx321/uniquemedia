import { describe, expect, test } from "bun:test";
import { shapeCounts } from "../../engine/mockAutopilot";
import {
  DEFAULT_MIX,
  defaultForm,
  handleValueText,
  isDefaultMix,
  launchSettings,
  MIX_KEY,
  mixKey,
  moveHandle,
  readMix,
  selectAll,
  settingsKey,
  stepVideos,
  toggleAvatar,
  wantedShapes,
  writeMix,
} from "./launchForm";

// S4.9a: the launch form's own arithmetic — the two-handle mix (its shares always sum to 100), the shapes it asks per avatar, what is remembered, what is sent.

const memory = (initial: Record<string, string> = {}) => {
  const values = new Map(Object.entries(initial));
  return { getItem: (k: string) => values.get(k) ?? null, setItem: (k: string, v: string) => void values.set(k, v), values };
};

describe("the mix's two handles", () => {
  test("the first handle trades one photo against collages, the second collages against slides; the sum stays 100", () => {
    expect(moveHandle(DEFAULT_MIX, 1, 60)).toEqual({ single: 60, collage: 30, slides: 10 });
    expect(moveHandle(DEFAULT_MIX, 2, 80)).toEqual({ single: 70, collage: 10, slides: 20 });
  });

  test("a handle never passes its neighbour or the bar's edge", () => {
    expect(moveHandle(DEFAULT_MIX, 1, 95)).toEqual({ single: 90, collage: 0, slides: 10 });
    expect(moveHandle(DEFAULT_MIX, 1, -20)).toEqual({ single: 0, collage: 90, slides: 10 });
    expect(moveHandle(DEFAULT_MIX, 2, 40)).toEqual({ single: 70, collage: 0, slides: 30 });
    expect(moveHandle(DEFAULT_MIX, 2, 140)).toEqual({ single: 70, collage: 30, slides: 0 });
  });

  test("the extremes the design draws: 100 / 0 / 0 and 0 / 0 / 100", () => {
    expect(moveHandle(moveHandle(DEFAULT_MIX, 2, 100), 1, 100)).toEqual({ single: 100, collage: 0, slides: 0 });
    expect(moveHandle(moveHandle(DEFAULT_MIX, 1, 0), 2, 0)).toEqual({ single: 0, collage: 0, slides: 100 });
  });

  test("← → move by 5 %, Home and End go to the neighbouring handle or the edge, other keys do nothing", () => {
    expect(mixKey(DEFAULT_MIX, 1, "ArrowRight")).toEqual({ single: 75, collage: 15, slides: 10 });
    expect(mixKey(DEFAULT_MIX, 1, "ArrowLeft")).toEqual({ single: 65, collage: 25, slides: 10 });
    expect(mixKey(DEFAULT_MIX, 2, "ArrowRight")).toEqual({ single: 70, collage: 25, slides: 5 });
    expect(mixKey(DEFAULT_MIX, 1, "Home")).toEqual({ single: 0, collage: 90, slides: 10 });
    expect(mixKey(DEFAULT_MIX, 1, "End")).toEqual({ single: 90, collage: 0, slides: 10 });
    expect(mixKey(DEFAULT_MIX, 2, "Home")).toEqual({ single: 70, collage: 0, slides: 30 });
    expect(mixKey(DEFAULT_MIX, 2, "End")).toEqual({ single: 70, collage: 30, slides: 0 });
    expect(mixKey(DEFAULT_MIX, 1, "Enter")).toBeNull();
  });

  test("a handle says both shares it divides", () => {
    expect(handleValueText(DEFAULT_MIX, 1)).toBe("одно фото 70 %, коллаж 20 %");
    expect(handleValueText(DEFAULT_MIX, 2)).toBe("коллаж 20 %, слайды 10 %");
    expect(isDefaultMix(DEFAULT_MIX)).toBe(true);
    expect(isDefaultMix({ single: 60, collage: 25, slides: 15 })).toBe(false);
  });
});

describe("the shapes per avatar", () => {
  // The plan's table (§5.2) and the mock's own split: the note under the bar can never say other numbers than the plan.
  test.each([
    [10, DEFAULT_MIX, { single: 7, collage: 2, slides: 1 }],
    [50, DEFAULT_MIX, { single: 35, collage: 10, slides: 5 }],
    [3, DEFAULT_MIX, { single: 2, collage: 1, slides: 0 }],
    [1, DEFAULT_MIX, { single: 1, collage: 0, slides: 0 }],
    [7, { single: 100, collage: 0, slides: 0 }, { single: 7, collage: 0, slides: 0 }],
    [7, { single: 0, collage: 0, slides: 100 }, { single: 0, collage: 0, slides: 7 }],
    [10, { single: 60, collage: 25, slides: 15 }, { single: 6, collage: 3, slides: 1 }],
  ])("%i videos at %o → %o", (total, mix, expected) => {
    expect(wantedShapes(total, mix)).toEqual(expected);
    expect(wantedShapes(total, mix)).toEqual(shapeCounts(total, mix));
  });

  test("agrees with the mock's planner for every count and a range of mixes", () => {
    for (let total = 1; total <= 50; total++) {
      for (const mix of [DEFAULT_MIX, { single: 33, collage: 33, slides: 34 }, { single: 5, collage: 90, slides: 5 }, { single: 50, collage: 25, slides: 25 }]) {
        expect(wantedShapes(total, mix)).toEqual(shapeCounts(total, mix));
      }
    }
  });
});

describe("the remembered mix", () => {
  test("reads back what it wrote", () => {
    const storage = memory();
    writeMix(storage, { single: 60, collage: 25, slides: 15 });
    expect(storage.values.get(MIX_KEY)).toBe("60/25/15");
    expect(readMix(storage)).toEqual({ single: 60, collage: 25, slides: 15 });
  });

  test.each(["", "70/20", "70/20/20", "a/b/c", "-10/100/10", "70.5/19.5/10"])("«%s» is not a mix: the owner's 70 / 20 / 10 instead", (value) => {
    expect(readMix(memory({ [MIX_KEY]: value }))).toEqual(DEFAULT_MIX);
  });

  test("no storage, or one that throws, reads the default and keeps nothing", () => {
    expect(readMix(null)).toEqual(DEFAULT_MIX);
    const broken = {
      getItem: () => {
        throw new Error("blocked");
      },
      setItem: () => {
        throw new Error("full");
      },
    };
    expect(readMix(broken)).toEqual(DEFAULT_MIX);
    expect(() => writeMix(broken, DEFAULT_MIX)).not.toThrow();
  });
});

describe("the form", () => {
  const order = ["a", "b", "c"];

  // S5.7c (plan s5a2 §6.1): the form holds «Подача», «Обычная» by default, and no «Ракурсы». S5.8b: and «Ножки», «Нет» by default.
  test("a fresh form chooses nobody, ten videos, the everyday categories, «Подача» «Обычная», «Ножки» «Нет», the library and generation on, no stickers", () => {
    expect(defaultForm(false)).toEqual({
      avatarIds: [],
      videosPerAvatar: 10,
      mix: DEFAULT_MIX,
      categories: ["home", "travel", "shoot", "fit"],
      level: "ordinary",
      legs: 0,
      library: true,
      generate: true,
      sceneReview: false,
      stickers: false,
    });
  });

  test("the settings to plan carry no poses, and «Подача» only when it is «Кокетливая»", () => {
    const chosen = { ...defaultForm(true), avatarIds: ["a"] };
    const ordinary = launchSettings(chosen, []);
    expect(ordinary === null ? [] : Object.keys(ordinary).sort()).toEqual(["avatarIds", "categories", "generate", "library", "mix", "sceneReview", "stickers", "videosPerAvatar"]);
    const flirty = launchSettings({ ...chosen, level: "flirty" }, []);
    expect(flirty?.level).toBe("flirty");
    // A plan belongs to one «Подача»: the two are asked apart.
    expect(flirty !== null && ordinary !== null && settingsKey(flirty) !== settingsKey(ordinary)).toBe(true);
  });

  // S5.8b (plan s5a2 §7; mockup 34; the S5.8a review): the engine stores whatever share the draft names, a 0 included, so the window names one only when
  // it is 15 or 30 (I5.27, as `level` only when flirty), and only with a built-in category on: a launch of the owner's own categories that named one would be
  // refused (`legs-built-in-only`).
  test("the settings to plan carry «Ножки» as `legsShare` only at 15 or 30, never 0", () => {
    const chosen = { ...defaultForm(true), avatarIds: ["a"] };
    const none = launchSettings(chosen, []);
    expect(none !== null && "legsShare" in none).toBe(false);
    const some = launchSettings({ ...chosen, legs: 15 }, []);
    const many = launchSettings({ ...chosen, legs: 30 }, []);
    expect(some?.legsShare).toBe(15);
    expect(many?.legsShare).toBe(30);
    expect(some === null ? [] : Object.keys(some).sort()).toEqual(["avatarIds", "categories", "generate", "legsShare", "library", "mix", "sceneReview", "stickers", "videosPerAvatar"]);
    // A plan belongs to one share: the three are asked apart.
    expect(new Set([none, some, many].map((s) => (s === null ? "" : settingsKey(s)))).size).toBe(3);
  });

  test("the settings name no legs for the owner's own categories only, whatever the pick; a built-in beside them keeps it", () => {
    const chosen = { ...defaultForm(true), avatarIds: ["a"], legs: 30 as const };
    const custom = launchSettings({ ...chosen, categories: ["cat-paris-0000000"] }, ["cat-paris-0000000"]);
    expect(custom !== null && "legsShare" in custom).toBe(false);
    // A built-in beside a custom one the library dropped: the built-in decides.
    expect(launchSettings({ ...chosen, categories: ["cat-gone-00000000", "fit"] }, [])?.legsShare).toBe(30);
  });

  test("avatars keep the list's order however they were clicked; «Все» takes every one", () => {
    const form = toggleAvatar(toggleAvatar(defaultForm(true), "c", order), "a", order);
    expect(form.avatarIds).toEqual(["a", "c"]);
    expect(toggleAvatar(form, "a", order).avatarIds).toEqual(["c"]);
    expect(selectAll(form, order).avatarIds).toEqual(order);
  });

  test("videos per avatar stay within 1 and 50", () => {
    expect(stepVideos({ ...defaultForm(true), videosPerAvatar: 1 }, -1).videosPerAvatar).toBe(1);
    expect(stepVideos({ ...defaultForm(true), videosPerAvatar: 50 }, 1).videosPerAvatar).toBe(50);
    expect(stepVideos(defaultForm(true), 1).videosPerAvatar).toBe(11);
  });

  test("nothing is planned without an avatar or a category; a custom category the library no longer holds is not sent", () => {
    expect(launchSettings(defaultForm(true), [])).toBeNull();
    const chosen = { ...defaultForm(true), avatarIds: ["a"] };
    expect(launchSettings({ ...chosen, categories: [] }, [])).toBeNull();
    expect(launchSettings({ ...chosen, categories: ["cat-gone-00000000"] }, [])).toBeNull();
    const settings = launchSettings({ ...chosen, categories: ["cat-paris-0000000", "fit", "home"] }, ["cat-paris-0000000"]);
    expect(settings?.categories).toEqual(["home", "fit", "cat-paris-0000000"]);
  });
});
