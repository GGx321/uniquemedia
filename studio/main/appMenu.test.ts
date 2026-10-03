import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { appMenuTemplate, type MenuTemplateItem } from "./appMenu";
useNativeGlobals();

// 3d.2 re-review: Electron's default menu binds ⌘R / Ctrl+R to Reload. A page holding a close while it saves (the montage
// editor's pending edit) cannot tell a reload from a close, so a reload would close the window after the save. The built
// app has no Reload anywhere. On macOS it keeps the application menu (⌘Q, Hide), the File menu (⌘W: the keyboard way
// to a close the editor holds while it saves), the Edit menu (⌘C, ⌘V, ⌘Z in fields only work through it there) and a
// Window menu with full screen; elsewhere it has no menu at all.

function everyItem(items: readonly MenuTemplateItem[]): MenuTemplateItem[] {
  return items.flatMap((item) => [item, ...(Array.isArray(item.submenu) ? everyItem(item.submenu) : [])]);
}

const FORBIDDEN = ["reload", "forceReload", "toggleDevTools", "viewMenu"];

describe("the built app's menu", () => {
  test("macOS: the application, File, Edit and Window menus, and nothing that reloads the page or opens DevTools", () => {
    const template = appMenuTemplate("darwin");
    expect(template).not.toBeNull();
    expect(template?.map((item) => item.role)).toEqual(["appMenu", "fileMenu", "editMenu", "window"]);
    for (const item of everyItem(template ?? [])) expect(FORBIDDEN).not.toContain(item.role ?? "");
  });

  test("macOS: ⌘W stays (the File menu holds Close Window), and full screen stays in the Window menu", () => {
    const template = appMenuTemplate("darwin") ?? [];
    expect(template.some((item) => item.role === "fileMenu")).toBe(true);
    const roles = everyItem(template).map((item) => item.role);
    expect(roles).toContain("togglefullscreen");
    expect(roles).toContain("minimize");
    expect(roles).toContain("front");
  });

  test("Windows and Linux: no menu at all, so no Ctrl+R (and no Ctrl+W: the title bar and Alt+F4 close)", () => {
    expect(appMenuTemplate("win32")).toBeNull();
    expect(appMenuTemplate("linux")).toBeNull();
  });
});
