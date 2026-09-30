import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { appMenuTemplate, type MenuTemplateItem } from "./appMenu";
useNativeGlobals();

// 3d.2 re-review: Electron's default menu binds ⌘R / Ctrl+R to Reload. A page holding a close while it saves (the montage
// editor's pending edit) cannot tell a reload from a close, so a reload would close the window after the save. The built
// app has no Reload anywhere; on macOS it keeps the application menu (⌘Q, Hide) and the Edit menu (⌘C, ⌘V, ⌘Z in
// fields only work through it there), elsewhere it has no menu at all (Chromium handles the field shortcuts itself).

function everyItem(items: readonly MenuTemplateItem[]): MenuTemplateItem[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? everyItem(item.submenu) : [])]);
}

const FORBIDDEN = ["reload", "forceReload", "toggleDevTools", "viewMenu"];

describe("the built app's menu", () => {
  test("macOS: the application, Edit and Window menus, and nothing that reloads the page or opens DevTools", () => {
    const template = appMenuTemplate("darwin");
    expect(template).not.toBeNull();
    const items = everyItem(template ?? []);
    expect(template?.map((item) => item.role)).toEqual(["appMenu", "editMenu", "windowMenu"]);
    for (const item of items) expect(FORBIDDEN).not.toContain(item.role ?? "");
  });

  test("Windows and Linux: no menu at all, so no Ctrl+R", () => {
    expect(appMenuTemplate("win32")).toBeNull();
    expect(appMenuTemplate("linux")).toBeNull();
  });
});
