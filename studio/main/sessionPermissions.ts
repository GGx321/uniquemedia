import { isTrustedSender, type TrustedRenderer } from "./requests";

// Electron grants EVERY permission a page asks for (clipboard, notifications, the file system picker, geolocation, ...) unless the session has handlers. Studio's
// window needs none of them, so the session denies all, with one measured exception: the native controls of the Videos tab's `<video controls>` ask for
// `fullscreen` when the button is pressed, and with a deny-all handler that request never answers (Electron 43, measured). It is granted to the app's own page in
// its top frame and to nothing else. Media playback, drag and drop, and the dialogs main opens itself need no permission.

export interface PermissionDetails {
  readonly requestingUrl?: string;
  readonly isMainFrame?: boolean;
}

/** The two handlers of an Electron session (`session.defaultSession`), as far as they are used here. */
export interface PermissionTarget {
  setPermissionRequestHandler(handler: (webContents: unknown, permission: string, callback: (granted: boolean) => void, details: PermissionDetails) => void): void;
  setPermissionCheckHandler(handler: (webContents: unknown, permission: string) => boolean): void;
}

/** The only permission a page may be given, and only the app's own top frame. */
const GRANTED_TO_APP_PAGE = "fullscreen";

/** Installs the handlers. Call it before any window exists: a window created first would run under Electron's grant-everything default. */
export function installSessionPermissions(target: PermissionTarget, trusted: TrustedRenderer): void {
  target.setPermissionRequestHandler((_webContents, permission, callback, details) => {
    const fromAppPage = isTrustedSender({ url: details.requestingUrl ?? null, isTopFrame: details.isMainFrame === true, isAppWindow: true }, trusted);
    callback(permission === GRANTED_TO_APP_PAGE && fromAppPage);
  });
  // The synchronous check ("may this origin use it, without asking") answers no to everything: a granted request is a prompt-less one-off, never a standing right.
  target.setPermissionCheckHandler(() => false);
}
