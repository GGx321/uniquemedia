import {
  errorResponseFor,
  MAIN_ONLY_COMMANDS,
  parseEngineCommand,
  parseMessage,
  type EngineCommandMessage,
  type ResponseMessage,
} from "../shared/engine";
import { posix, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import type { KeyCommand } from "./keyFlow";
import { isSettingsCommand, type SettingsCommand } from "./settingsFlow";

/** What main knows about the frame an IPC message came from (from `event.senderFrame`). */
export interface SenderFrame {
  /** The frame's URL; null when the frame is gone. */
  url: string | null;
  /** No parent frame: not an iframe. */
  isTopFrame: boolean;
  /** The main frame of one of the app's own BrowserWindows. */
  isAppWindow: boolean;
}

/** Where the app's renderer is loaded from. */
export interface TrustedRenderer {
  /** The dev server, in an unpackaged run only. */
  devServerUrl?: string;
  /** `file://…/out-studio/renderer/index.html`, used whenever there is no dev server. */
  fileUrl: string;
}

function parseUrl(url: string): URL | null {
  try {
    return new URL(url);
  } catch {
    return null;
  }
}

/** A file URL as a normalised path (Windows: case-folded); null for anything that is not a plain file path. */
function filePathOf(url: string, platform: NodeJS.Platform): string | null {
  try {
    const path = fileURLToPath(url);
    return platform === "win32" ? win32.normalize(path).toLowerCase() : posix.normalize(path);
  } catch {
    return null;
  }
}

/**
 * True only for the top frame of an app window showing the app's own page:
 * the dev server's origin in dev, else the renderer file itself, compared as
 * a normalised path (percent-encoding, dot segments, query and fragment do
 * not matter; letter case only off Windows).
 */
export function isTrustedSender(frame: SenderFrame, trusted: TrustedRenderer, platform: NodeJS.Platform = process.platform): boolean {
  if (!frame.isAppWindow || !frame.isTopFrame || frame.url === null) return false;
  const url = parseUrl(frame.url);
  if (url === null) return false;
  if (trusted.devServerUrl !== undefined) {
    const dev = parseUrl(trusted.devServerUrl);
    return dev !== null && url.origin === dev.origin;
  }
  if (url.protocol !== "file:" || url.host !== "") return false;
  url.search = "";
  url.hash = "";
  const actual = filePathOf(url.href, platform);
  return actual !== null && actual === filePathOf(trusted.fileUrl, platform);
}

export interface RequestRoutes {
  /** The key commands, answered by main itself and never forwarded. */
  mainOnly(command: KeyCommand): Promise<ResponseMessage>;
  /** Settings changes: main owns settings.json and tells the engine afterwards. */
  settings(command: SettingsCommand): Promise<ResponseMessage>;
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
