import { describe, expect, test } from "bun:test";
import { createNavigation, sectionOf, type Route } from "./navigation";

// 3d.2 review, HIGH 1: a screen with unsaved work (the editor) guards every way out, the sidebar included.

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

function rig() {
  const went: Route[] = [];
  const nav = createNavigation((route) => void went.push(route));
  return { went, nav };
}

describe("the leave guard", () => {
  test("with no guard a navigation goes at once", () => {
    const { went, nav } = rig();
    nav.navigate({ name: "settings" });
    expect(went).toEqual([{ name: "settings" }]);
  });

  test("a guard that agrees lets it go, after it answers", async () => {
    const { went, nav } = rig();
    let answer: (ok: boolean) => void = () => undefined;
    nav.guard(() => new Promise((resolve) => (answer = resolve)));
    nav.navigate({ name: "montages" });
    expect(went).toEqual([]);
    answer(true);
    await settle();
    expect(went).toEqual([{ name: "montages" }]);
  });

  test("a guard that refuses keeps the window where it is", async () => {
    const { went, nav } = rig();
    nav.guard(async () => false);
    nav.navigate({ name: "avatars" });
    await settle();
    expect(went).toEqual([]);
  });

  test("force skips the guard (leaving without saving is the owner's own choice)", () => {
    const { went, nav } = rig();
    nav.guard(async () => false);
    nav.navigate({ name: "montages" }, { force: true });
    expect(went).toEqual([{ name: "montages" }]);
  });

  test("clicks while the guard is still deciding change the destination, not the question: it is asked once", async () => {
    const { went, nav } = rig();
    let asked = 0;
    let answer: (ok: boolean) => void = () => undefined;
    nav.guard(() => {
      asked += 1;
      return new Promise((resolve) => (answer = resolve));
    });
    nav.navigate({ name: "montages" });
    nav.navigate({ name: "settings" });
    answer(true);
    await settle();
    expect(asked).toBe(1);
    expect(went).toEqual([{ name: "settings" }]);
  });

  test("removing a guard removes only that guard", async () => {
    const { went, nav } = rig();
    const removeFirst = nav.guard(async () => false);
    nav.guard(async () => false);
    removeFirst();
    nav.navigate({ name: "avatars" });
    await settle();
    expect(went).toEqual([]);
  });

  test("once its screen is gone, a guard no longer stands in the way", () => {
    const { went, nav } = rig();
    const remove = nav.guard(async () => false);
    remove();
    nav.navigate({ name: "avatars" });
    expect(went).toEqual([{ name: "avatars" }]);
  });
});

// 3d.2: the drafts screen and the editor both belong to the sidebar's «Монтаж».

test("the drafts screen and an open draft light up «Монтаж» in the sidebar", () => {
  const routes: Route[] = [{ name: "montages" }, { name: "editor", montageId: "montage-0000001" }, { name: "editor", montageId: "montage-0000001", created: true }];
  for (const route of routes) expect(sectionOf(route)).toBe("montage");
});

test("the other sections keep their own", () => {
  expect(sectionOf({ name: "photos", avatarId: null })).toBe("photo");
  expect(sectionOf({ name: "section", id: "autopilot" })).toBe("autopilot");
  expect(sectionOf({ name: "avatarNew", draftId: null })).toBe("avatars");
  expect(sectionOf({ name: "settings" })).toBe("settings");
});
