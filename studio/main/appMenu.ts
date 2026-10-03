// The built app's menu (3d.2 re-review). Electron's default menu binds ⌘R / Ctrl+R to Reload and ⌥⌘I to DevTools. The
// montage editor holds a close while it saves an edit, and a page cannot tell a reload from a close, so a reload would
// end in the window closing itself after the save. So the built app has no View menu at all.
//
// - macOS: the application menu (About, Hide, ⌘Q), the File menu (in Electron 43 its only item on macOS is Close Window,
//   ⌘W: the keyboard way to the close the editor holds while it saves), the Edit menu (on macOS ⌘C, ⌘V and ⌘Z in a
//   field work only through it) and the Window menu, written out so full screen (⌃⌘F, which lived in the View menu)
//   stays next to minimize and zoom.
// - Windows and Linux: NO menu, on purpose. There a menu is a bar inside the window, which the artboards do not have;
//   Chromium handles the field shortcuts itself. Ctrl+W goes with it: the window closes from its title bar or with
//   Alt+F4, and the editor holds that close the same way while it saves.
//
// The dev build keeps Electron's default, reload included.

/** One item as the tests read it: its role and submenu. */
export interface MenuTemplateItem {
  readonly role?: string;
  readonly submenu?: readonly MenuTemplateItem[];
}

type Role = "appMenu" | "fileMenu" | "editMenu" | "window" | "minimize" | "zoom" | "togglefullscreen" | "front";

/** The subset of Electron's `MenuItemConstructorOptions` this template uses. */
export interface AppMenuItem {
  role?: Role;
  type?: "separator";
  submenu?: AppMenuItem[];
}

export function appMenuTemplate(platform: NodeJS.Platform): AppMenuItem[] | null {
  if (platform !== "darwin") return null;
  return [
    { role: "appMenu" },
    { role: "fileMenu" },
    { role: "editMenu" },
    // `role: "window"` with its own submenu stays macOS's Window menu (the list of open windows is added to it).
    { role: "window", submenu: [{ role: "minimize" }, { role: "zoom" }, { role: "togglefullscreen" }, { type: "separator" }, { role: "front" }] },
  ];
}
