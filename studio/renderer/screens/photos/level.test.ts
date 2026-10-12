import { describe, expect, test } from "bun:test";
import { ORDINARY_SCENE_CATEGORIES } from "../../../shared/engine";
import { flirtyCaption, flirtyFrames, launchFlirtyCaption, LEVEL_KEY_PREFIX, readLevel, writeLevel } from "./level";

// S5.7c (plan s5a2 §6.3, I5.28; mockups 25 and 30): «Подача» on the window's side — how many frames «Кокетливая» makes flirty, the caption that says so, and
// the choice remembered per avatar (owner: «Обычная» by default, remembered per avatar).

describe("flirtyFrames (I5.28): round-half-up(0.6 × n) of each built-in category's photos", () => {
  test("is 12 of 20 over «Дом», «Виды» and «Гламур», as mockup 25 says", () => {
    expect(flirtyFrames(20, ["home", "travel", "glam"])).toBe(12);
  });

  test("is 10 of 20 over the five built-ins (4 each, 2.4 → 2)", () => {
    // 2026-10-12, S5.9b2 (plan s5a3 §6.4 r3): the five ordinary built-ins by name (the «Смелая» two join SceneCategory); the assertion is kept.
    expect(flirtyFrames(20, ORDINARY_SCENE_CATEGORIES)).toBe(10);
  });

  test.each([
    [0, 0],
    [1, 1],
    [2, 1],
    [3, 2],
    [4, 2],
    [5, 3],
    [10, 6],
    [99, 59],
    [100, 60],
  ])("is %i → %i for one built-in category", (n, flirty) => {
    expect(flirtyFrames(n, ["home"])).toBe(flirty);
  });

  test("leaves a custom category ordinary: only the built-ins' photos count", () => {
    // 10 photos over «Дом» and one custom category: 5 + 5, only «Дом»'s five count.
    expect(flirtyFrames(10, ["home", "cat-paris-cafes"])).toBe(3);
    expect(flirtyFrames(10, ["cat-paris-cafes"])).toBe(0);
  });

  test("counts nothing with no category", () => {
    expect(flirtyFrames(20, [])).toBe(0);
  });
});

describe("the caption", () => {
  test("is mockup 25's words, the count bound to its word", () => {
    expect(flirtyCaption(12, 20)).toBe("12 из 20 кадров — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.");
  });

  test("says «из 21 кадра» after «из»", () => {
    expect(flirtyCaption(13, 21)).toBe("13 из 21 кадра — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.");
  });
});

// S5.7c (mockup 30): «Автопилот» composes per avatar, so the count is summed over the plan's avatars, of their new photos only — «≈», the plan's split by
// video being the engine's.
describe("the launch's caption", () => {
  const avatar = (toGenerate: number, blocked: "open-set" | null = null) => ({ toGenerate, blocked });

  test("sums each avatar's flirty frames over its new photos: ≈ 13 of 22 for 9, 6 and 7 over «Дом», «Улица», «Гламур»", () => {
    const preview = { avatars: [avatar(9), avatar(6), avatar(7)], totals: { toGenerate: 22 } };
    expect(launchFlirtyCaption(preview, ["home", "shoot", "glam"])).toBe("≈ 13 из 22 новых кадров — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.");
  });

  test("leaves out a blocked avatar, as the plan's totals do", () => {
    const preview = { avatars: [avatar(9), avatar(6, "open-set")], totals: { toGenerate: 9 } };
    expect(launchFlirtyCaption(preview, ["home", "shoot", "glam"])).toBe("≈ 6 из 9 новых кадров — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.");
  });

  test("says «из 21 нового кадра»", () => {
    const preview = { avatars: [avatar(21)], totals: { toGenerate: 21 } };
    expect(launchFlirtyCaption(preview, ["home"])).toBe("≈ 13 из 21 нового кадра — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.");
  });

  // S5.7R carry-over (LOW): with only custom categories on «Кокетливая» works for none of the frames, and «≈ 0 из N» read as a fault; it says where «Подача» works, as the card does.
  test("with only custom categories on, says where «Подача» works, with a plan, with none and with nothing new", () => {
    const only = "Подача — только во встроенных категориях";
    const preview = { avatars: [avatar(9)], totals: { toGenerate: 9 } };
    expect(launchFlirtyCaption(preview, ["cat-paris-cafes"])).toBe(only);
    expect(launchFlirtyCaption(null, ["cat-paris-cafes", "cat-bakeries"])).toBe(only);
    expect(launchFlirtyCaption({ avatars: [avatar(0)], totals: { toGenerate: 0 } }, ["cat-paris-cafes"])).toBe(only);
  });

  test("a built-in category beside a custom one still counts its own frames", () => {
    const preview = { avatars: [avatar(10)], totals: { toGenerate: 10 } };
    expect(launchFlirtyCaption(preview, ["home", "cat-paris-cafes"])).toMatch(/^≈ 3 из\s10\sновых кадров — кокетливые/);
  });

  test("with no plan yet, or nothing new to draw, says the share itself", () => {
    const share = "6 из 10 новых кадров — кокетливые: взгляд, улыбка, поза. Одежда — из категорий.";
    expect(launchFlirtyCaption(null, ["home"])).toBe(share);
    expect(launchFlirtyCaption({ avatars: [avatar(0)], totals: { toGenerate: 0 } }, ["home"])).toBe(share);
  });
});

/** A storage that keeps what is set, or one whose every call throws. */
function memory(): Pick<Storage, "getItem" | "setItem" | "removeItem"> & { items: Map<string, string> } {
  const items = new Map<string, string>();
  return { items, getItem: (k) => items.get(k) ?? null, setItem: (k, v) => void items.set(k, v), removeItem: (k) => void items.delete(k) };
}
const broken: Pick<Storage, "getItem" | "setItem" | "removeItem"> = {
  getItem: () => {
    throw new Error("blocked");
  },
  setItem: () => {
    throw new Error("blocked");
  },
  removeItem: () => {
    throw new Error("blocked");
  },
};

describe("«Подача» remembered per avatar", () => {
  test("is «Обычная» for an avatar it was never chosen for", () => {
    expect(readLevel(memory(), "avatar-mia-0001")).toBe("ordinary");
  });

  test("keeps «Кокетливая» for that avatar only", () => {
    const storage = memory();
    writeLevel(storage, "avatar-mia-0001", "flirty");
    expect(readLevel(storage, "avatar-mia-0001")).toBe("flirty");
    expect(readLevel(storage, "avatar-ava-0002")).toBe("ordinary");
    expect(storage.items.get(`${LEVEL_KEY_PREFIX}avatar-mia-0001`)).toBe("flirty");
  });

  test("forgets the key when it goes back to «Обычная»: the default is not stored", () => {
    const storage = memory();
    writeLevel(storage, "avatar-mia-0001", "flirty");
    writeLevel(storage, "avatar-mia-0001", "ordinary");
    expect(storage.items.size).toBe(0);
    expect(readLevel(storage, "avatar-mia-0001")).toBe("ordinary");
  });

  test("reads anything it does not know as «Обычная» («Смелая» is not a level yet)", () => {
    const storage = memory();
    storage.items.set(`${LEVEL_KEY_PREFIX}avatar-mia-0001`, "bold");
    expect(readLevel(storage, "avatar-mia-0001")).toBe("ordinary");
  });

  test("works on with a storage that cannot be read or written, or with none", () => {
    expect(readLevel(broken, "avatar-mia-0001")).toBe("ordinary");
    expect(() => writeLevel(broken, "avatar-mia-0001", "flirty")).not.toThrow();
    expect(readLevel(null, "avatar-mia-0001")).toBe("ordinary");
    expect(() => writeLevel(null, "avatar-mia-0001", "flirty")).not.toThrow();
  });
});
