import { posix, win32 } from "node:path";
import {
  AbsolutePath,
  errorResponseFor,
  PROTOCOL_VERSION,
  type CommandMessage,
  type EngineCommandMessage,
  type EngineError,
  type ResponseMessage,
} from "../shared/engine";
import type { HostControl } from "../engine/control";
import { reportedSettings, type ReportedSettingsDeps } from "./settingsFlow";
import type { SettingsStore } from "./settingsStore";

// The export folder «Готовые видео» in Settings (3e.3, K18). The window never names a folder: main opens its own dialog, at the
// current one. The engine then judges the pick (`export.choose`: it checks the folder, writes the root marker when there is none,
// and counts the video records that resolve in it), and only after an ok reply is the path saved and sent on as
// `settings.update`. Nothing is left half-done on a refusal.

/** The two commands main answers for the export folder: its dialog, and the path as a person reads it. */
export type ExportFolderCommand = Extract<CommandMessage, { type: "settings.setExportPath" | "settings.exportDisplay" }>;

export function isExportFolderCommand(command: CommandMessage): command is ExportFolderCommand {
  return command.type === "settings.setExportPath" || command.type === "settings.exportDisplay";
}

/** The engine's answer to `export.choose`: `error` is null on success, with `exportFolder` set. */
export interface ExportChoice {
  error: EngineError | null;
  exportFolder?: { rootId: string; resolved: number; elsewhere: number; incomplete: boolean } | undefined;
}

export interface ExportFolderFlowDeps extends ReportedSettingsDeps {
  settings: SettingsStore;
  engine: {
    send(control: HostControl): void;
    request(command: EngineCommandMessage): Promise<ResponseMessage>;
    /** Asks the engine about the picked folder; it adopts nothing. */
    chooseExport(path: string): Promise<ExportChoice>;
  };
  /** Main's folder dialog; null when cancelled. `defaultPath` only sets where it opens. */
  pickFolder(defaultPath: string): Promise<string | null>;
  /** The owner's home folder, for the display form of a path. */
  home(): string;
  platform: NodeJS.Platform;
}

const MAX_DETAIL = 500;

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= MAX_DETAIL ? text : `${text.slice(0, MAX_DETAIL - 1)}…`;
}

/**
 * A path as a person reads it: the home folder as «~», anything else as it is. For display only: it is never sent back as a path.
 * Windows folds the case of the drive and of folder names (and `\` stays the separator); elsewhere case matters, so another
 * spelling of home is another folder and is shown whole. A home that is empty or relative hides nothing.
 */
export function displayPath(path: string, options: { home: string; platform: NodeJS.Platform }): string {
  const api = options.platform === "win32" ? win32 : posix;
  if (options.home === "" || !api.isAbsolute(options.home) || !api.isAbsolute(path)) return path;
  const relative = api.relative(options.home, path);
  if (relative === "") return "~";
  const first = relative.split(/[\\/]/)[0];
  if (first === ".." || api.isAbsolute(relative)) return path;
  return `~${api.sep}${relative}`;
}

async function setExportPath(command: Extract<ExportFolderCommand, { type: "settings.setExportPath" }>, deps: ExportFolderFlowDeps): Promise<ResponseMessage> {
  // Never a path from the window: the owner picks in main's dialog, which only opens at the current folder.
  const picked = await deps.pickFolder(deps.settings.current.exportPath);
  if (picked === null) return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { picked: false } };
  const path = AbsolutePath.safeParse(picked);
  if (!path.success) return errorResponseFor(command, { code: "VALIDATION", detail: "the chosen folder is not an absolute path" });

  const choice = await deps.engine.chooseExport(path.data);
  if (choice.error !== null) return errorResponseFor(command, choice.error);
  if (choice.exportFolder === undefined) return errorResponseFor(command, { code: "INTERNAL", detail: "the engine did not say what the chosen folder is" });

  try {
    await deps.settings.save({ ...deps.settings.current, exportPath: path.data });
  } catch (error) {
    return errorResponseFor(command, { code: "INTERNAL", detail: `the settings could not be saved: ${describe(error)}` });
  }
  deps.engine.send({ kind: "control", type: "settings.update", settings: deps.settings.current });
  const settings = await reportedSettings(deps);
  return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { picked: true, settings, ...choice.exportFolder } };
}

/**
 * `settings.setExportPath` and `settings.exportDisplay`, answered by main. The pick runs in the settings queue, like every
 * settings command, so it never saves over a stale copy of the settings.
 */
export function handleExportFolderCommand(command: ExportFolderCommand, deps: ExportFolderFlowDeps): Promise<ResponseMessage> {
  if (command.type === "settings.exportDisplay") {
    const display = displayPath(deps.settings.current.exportPath, { home: deps.home(), platform: deps.platform });
    return Promise.resolve({ v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result: { display } });
  }
  return deps.settings.exclusive(() => setExportPath(command, deps));
}
