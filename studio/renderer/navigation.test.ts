import { expect, test } from "bun:test";
import { sectionOf, type Route } from "./navigation";

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
