// The built app's menu (3d.2 re-review). Electron's default menu binds ⌘R / Ctrl+R to Reload and ⌥⌘I to DevTools. The
// montage editor holds a close while it saves an edit, and a page cannot tell a reload from a close, so a reload would
// end in the window closing itself after the save. So the built app has no View menu at all: on macOS only the
// application menu (About, Hide, ⌘Q) and the Edit and Window menus (on macOS ⌘C, ⌘V and ⌘Z in a field work only
// through the Edit menu); on Windows and Linux no menu (Chromium handles the field shortcuts itself, and Alt+F4 or
// the title bar closes). The dev build keeps Electron's default, reload included.

/** One item as the tests read it: its role and submenu. */
export interface MenuTemplateItem {
  readonly role?: string;
  readonly submenu?: readonly MenuTemplateItem[];
}

export type AppMenuRole = "appMenu" | "editMenu" | "windowMenu";

export function appMenuTemplate(platform: NodeJS.Platform): { role: AppMenuRole }[] | null {
  if (platform !== "darwin") return null;
  return [{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }];
}
