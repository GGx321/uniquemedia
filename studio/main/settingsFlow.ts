import {
  AbsolutePath,
  errorResponseFor,
  PROTOCOL_VERSION,
  type ApiKeyStatus,
  type CommandMessage,
  type EngineCommandMessage,
  type EngineError,
  type ResponseMessage,
  type Settings,
} from "../shared/engine";
import type { EngineSettings, HostControl } from "../engine/control";
import type { SettingsStore } from "./settingsStore";

/** The settings commands main answers itself: it owns settings.json. */
export type SettingsCommand = Extract<
  CommandMessage,
  { type: "settings.setBudget" | "settings.setModels" | "settings.setConcurrency" | "settings.setLibraryPath" }
>;

export function isSettingsCommand(command: CommandMessage): command is SettingsCommand {
  return (
    command.type === "settings.setBudget" ||
    command.type === "settings.setModels" ||
    command.type === "settings.setConcurrency" ||
    command.type === "settings.setLibraryPath"
  );
}

export interface SettingsFlowDeps {
  settings: SettingsStore;
  engine: {
    send(control: HostControl): void;
    request(command: EngineCommandMessage): Promise<ResponseMessage>;
    /** The engine opens (creating on first use) the library at `path`: null when it did, else why not. Main never touches the library. */
    openLibrary(path: string): Promise<EngineError | null>;
  };
  /** Main's folder dialog; null when cancelled. `defaultPath` only sets where it opens. */
  pickFolder(defaultPath: string): Promise<string | null>;
  /** Main's view of the key, for an answer when the engine cannot give its own. */
  keyStatus(): ApiKeyStatus;
  newId(): string;
}

const MAX_DETAIL = 500;

function describe(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.length <= MAX_DETAIL ? text : `${text.slice(0, MAX_DETAIL - 1)}…`;
}

type Next = { ok: true; settings: EngineSettings | null } | { ok: false; response: ResponseMessage };

async function nextSettings(command: SettingsCommand, deps: SettingsFlowDeps): Promise<Next> {
  const current = deps.settings.current;
  switch (command.type) {
    case "settings.setBudget":
      return { ok: true, settings: { ...current, monthlyBudgetMicros: command.payload.monthlyBudgetMicros } };
    case "settings.setModels":
      return { ok: true, settings: { ...current, imageModel: command.payload.imageModel, textModel: command.payload.textModel } };
    case "settings.setConcurrency":
      return { ok: true, settings: { ...current, concurrency: { network: command.payload.network } } };
    case "settings.setLibraryPath": {
      // Never a path string from the renderer: the user picks the folder in
      // main's own dialog, which merely opens at the suggested path.
      const picked = await deps.pickFolder(command.payload.path);
      if (picked === null) return { ok: true, settings: null };
      const path = AbsolutePath.safeParse(picked);
      if (!path.success) {
        return { ok: false, response: errorResponseFor(command, { code: "VALIDATION", detail: "the chosen folder is not an absolute path" }) };
      }
      // The engine opens the library (startup reconciliation included); the
      // path is persisted only after it accepted the folder.
      const refused = await deps.engine.openLibrary(path.data);
      if (refused !== null) return { ok: false, response: errorResponseFor(command, refused) };
      return { ok: true, settings: { ...current, libraryPath: path.data } };
    }
  }
}

/** The settings as the engine reports them (with its `rejected` flag), else main's own view. */
async function reportedSettings(deps: SettingsFlowDeps): Promise<Settings> {
  const response = await deps.engine.request({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "command", type: "settings.get", payload: {} });
  if (response.ok && response.type === "settings.get") return response.result;
  return { apiKey: deps.keyStatus(), ...deps.settings.current };
}

/**
 * `settings.setBudget`, `setModels`, `setConcurrency` and `setLibraryPath`,
 * answered by main, which owns settings.json: the change is validated (T0
 * already checked the payload), persisted atomically, made current (the
 * media protocol reads the library root from there, the engine's next init
 * too), and pushed to the engine as `settings.update`. The answer is T0
 * `Settings` as the engine now reports them.
 */
export function handleSettingsCommand(command: SettingsCommand, deps: SettingsFlowDeps): Promise<ResponseMessage> {
  return deps.settings.exclusive(async () => {
    const next = await nextSettings(command, deps);
    if (!next.ok) return next.response;
    if (next.settings !== null) {
      try {
        await deps.settings.save(next.settings);
      } catch (error) {
        return errorResponseFor(command, { code: "INTERNAL", detail: `the settings could not be saved: ${describe(error)}` });
      }
      deps.engine.send({ kind: "control", type: "settings.update", settings: deps.settings.current });
    }
    const result = await reportedSettings(deps);
    return { v: PROTOCOL_VERSION, id: command.id, kind: "response", type: command.type, ok: true, result };
  });
}
