import {
  errorResponseFor,
  MAIN_ONLY_COMMANDS,
  parseEngineCommand,
  parseMessage,
  type EngineCommandMessage,
  type ResponseMessage,
} from "../shared/engine";
import { isAppPage } from "./appProtocol";
import { isExportFolderCommand, type ExportFolderCommand } from "./exportFolderFlow";
import type { ImportPhotoCommand } from "./importFlow";
import type { KeyCommand } from "./keyFlow";
import type { MediaPickCommand } from "./mediaImportFlow";
import type { MusicKeyCommand } from "./musicKeyFlow";
import { isRevealCommand, isRevealFolderCommand, type RevealCommand, type RevealFolderCommand } from "./revealFlow";
import { isSettingsCommand, type SettingsCommand } from "./settingsFlow";
import { isOwnStickerBytesCommand, type OwnStickerBytesCommand } from "./ownStickerBytesFlow";
import { isStickerBytesCommand, type StickerBytesCommand } from "./stickerBytesFlow";

/** What main knows about the frame an IPC message came from (from `event.senderFrame`). */
export interface SenderFrame {
  /** The frame's URL; null when the frame is gone. */
  url: string | null;
  /** No parent frame: not an iframe. */
  isTopFrame: boolean;
  /** The main frame of one of the app's own BrowserWindows. */
  isAppWindow: boolean;
}

/** Where the app's renderer is loaded from: the dev server in dev, else the app's own page (appProtocol.ts's `APP_PAGE_URL`). */
export interface TrustedRenderer {
  /** The dev server, in an unpackaged run only. */
  devServerUrl?: string;
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/**
 * True only for the top frame of an app window showing the app's own page: the dev server's origin in dev, else
 * `studio-app://renderer/index.html` itself (a fragment does not matter; anything else, a `file:` URL above all, is
 * refused: appProtocol.ts's `isAppPage`). A URL whose origin is opaque (a parser reads it as "null", as it reads every
 * scheme it does not know) is never the dev server's.
 */
export function isTrustedSender(frame: SenderFrame, trusted: TrustedRenderer): boolean {
  if (!frame.isAppWindow || !frame.isTopFrame || frame.url === null) return false;
  if (trusted.devServerUrl === undefined) return isAppPage(frame.url);
  const url = parseUrl(frame.url);
  const dev = parseUrl(trusted.devServerUrl);
  return url !== null && dev !== null && dev.origin !== "null" && url.origin === dev.origin;
}

export interface RequestRoutes {
  /** The key commands, answered by main itself and never forwarded. */
  mainOnly(command: KeyCommand): Promise<ResponseMessage>;
  /** The RapidAPI (music) key commands (K27), answered by main itself and never forwarded. */
  musicKey(command: MusicKeyCommand): Promise<ResponseMessage>;
  /** Settings changes: main owns settings.json and tells the engine afterwards. */
  settings(command: SettingsCommand): Promise<ResponseMessage>;
  /**
   * T6c: the import photo dialog. Answered by main itself and never
   * forwarded — the renderer never sends a path or raw bytes (design
   * constraint 1); main opens its own dialog, reads the picked file, and
   * hands its bytes to the engine over the control channel, never through
   * this command's own payload.
   */
  importPhoto(command: ImportPhotoCommand): Promise<ResponseMessage>;
  /**
   * 3e.3: the export folder's dialog and its display form. Main opens its own folder dialog, asks the engine about the pick
   * and saves the path itself; the window never names a folder.
   */
  exportFolder(command: ExportFolderCommand): Promise<ResponseMessage>;
  /** 3d.6: «Открыть в папке». Main finds the video's file itself from its id and asks the system file manager to show it. */
  reveal(command: RevealCommand): Promise<ResponseMessage>;
  /** 3e.2 (K17): «Папка «Готовые видео»». Main finds the avatar's folder in the export folder itself and opens it. */
  revealFolder(command: RevealFolderCommand): Promise<ResponseMessage>;
  /**
   * 3f.1 (invariant 34, K29): `media.pickImport {kind}`. Main opens its own dialog, looks at each picked file and hands the engine the path
   * over the control channel; the window sends a kind and is never told a path.
   */
  mediaImport(command: MediaPickCommand): Promise<ResponseMessage>;
  /**
   * 3d.4 (review round 1): `stickers.bytes {stickerId}`. A built-in sticker's verified bytes for the preview's decoder, from main's
   * own catalogue, so the media scheme never has to open to script reads; the window names an id and is never told a path.
   */
  stickerBytes(command: StickerBytesCommand): Promise<ResponseMessage>;
  /**
   * 3f.5: `media.stickerBytes {mediaId}`. An OWN sticker's bytes for the same decoder, a door of its own beside the built-in one: main resolves the
   * media id through its record (the kind must be sticker, the sha256 is checked on the exact bytes, the size is capped before it reads) and answers the
   * file, never a path. The window names a media id and is never told which check failed.
   */
  ownStickerBytes(command: OwnStickerBytesCommand): Promise<ResponseMessage>;
  /** Everything else, forwarded to the engine. */
  engine(command: EngineCommandMessage): Promise<ResponseMessage>;
}

async function route(raw: unknown, routes: RequestRoutes): Promise<ResponseMessage> {
  const parsed = parseMessage(raw);
  if (!parsed.ok) return errorResponseFor(raw, { code: "VALIDATION", detail: parsed.reason });
  const message = parsed.message;
  if (message.kind !== "command") return errorResponseFor(raw, { code: "VALIDATION", detail: "only commands may be sent" });

  if (MAIN_ONLY_COMMANDS.includes(message.type)) {
    if (message.type === "settings.setApiKey" || message.type === "settings.clearApiKey") return routes.mainOnly(message);
    if (message.type === "settings.setMusicKey" || message.type === "settings.clearMusicKey") return routes.musicKey(message);
    if (message.type === "avatars.pickImportPhoto") return routes.importPhoto(message);
    if (message.type === "media.pickImport") return routes.mediaImport(message);
    if (isExportFolderCommand(message)) return routes.exportFolder(message);
    if (isRevealCommand(message)) return routes.reveal(message);
    if (isRevealFolderCommand(message)) return routes.revealFolder(message);
    if (isStickerBytesCommand(message)) return routes.stickerBytes(message);
    if (isOwnStickerBytesCommand(message)) return routes.ownStickerBytes(message);
    return errorResponseFor(message, { code: "INTERNAL", detail: `${message.type} has no handler in main` });
  }
  if (isSettingsCommand(message)) return routes.settings(message);
  // Parsed again as an engine command: the engine's schema has no key command
  // in it, so nothing main-only can be forwarded even by mistake.
  const forward = parseEngineCommand(message);
  if (!forward.ok) return errorResponseFor(raw, { code: "VALIDATION", detail: forward.reason });
  return routes.engine(forward.command);
}

/**
 * The single entry for `studio:request`. Rejects a sender that is not the
 * app's own top frame, validates the message against T0, answers the key
 * and settings-change commands in main and forwards the rest to the engine.
 * Never throws.
 */
export async function handleRendererRequest(
  raw: unknown,
  frame: SenderFrame,
  trusted: TrustedRenderer,
  routes: RequestRoutes,
): Promise<ResponseMessage> {
  if (!isTrustedSender(frame, trusted)) {
    return errorResponseFor(raw, { code: "VALIDATION", detail: "the request did not come from the app's own window" });
  }
  try {
    return await route(raw, routes);
  } catch (error) {
    // Only the error's kind is logged: a key command's payload must never reach a log.
    console.error(`studio: a request failed in main (${error instanceof Error ? error.name : "unknown error"})`);
    return errorResponseFor(raw, { code: "INTERNAL", detail: "main failed to handle the command" });
  }
}
