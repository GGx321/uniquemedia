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
    /**
     * Commits the switch to the folder staged by `openLibrary`: null when it
     * did, else why not (e.g. IN_FLIGHT while paid work or a pick/archive
     * holds the live library). Main persists the new path only after this
     * answers null.
     */
    confirmLibrary(path: string): Promise<EngineError | null>;
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
      // The engine opens (stages) the library, then is asked to commit the
      // switch; the path is persisted only after both accepted it. The
      // commit step can still be refused with IN_FLIGHT (a job, or a pick or
      // archive, started while the folder was being surveyed) — nothing is
      // saved then, and the live library stays whatever it already was.
      const refused = await deps.engine.openLibrary(path.data);
      if (refused !== null) return { ok: false, response: errorResponseFor(command, refused) };
      const confirmRefused = await deps.engine.confirmLibrary(path.data);
      if (confirmRefused !== null) return { ok: false, response: errorResponseFor(command, confirmRefused) };
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

/** What `reconcileLibraryPath` needs: a subset of `SettingsFlowDeps`, since it never picks a folder or reports a key status of its own. */
export interface LibraryReconcileDeps {
  settings: SettingsStore;
  engine: { request(command: EngineCommandMessage): Promise<ResponseMessage> };
  newId(): string;
}

/**
 * Reconciles settings.json (and so settings.current, and the studio-media://
 * root, which both read from it) to the engine's actual live library after a
 * `settings.changed` event whose `libraryPath` disagrees with it. This closes
 * the gap a confirm main gave up on (its 30 s deadline, engineHost.ts) can
 * leave: the engine is the source of truth about which folder is live, not
 * whatever main last persisted.
 *
 * Queued through `settings.exclusive`, exactly like `handleSettingsCommand`,
 * so this never runs concurrently with a settings command that is itself
 * about to persist its own outcome — by construction, no settings command
 * holds the lock while this runs. The "does this even disagree" check is
 * made only once inside that queue, against `settings.current` read fresh
 * at that moment: read any earlier, a settings command or an earlier queued
 * reconcile that is still mid-save (its write not applied to `current` yet)
 * would leave `current` stale, and a second reconcile could wrongly compare
 * itself against that stale value and skip a real disagreement. Once it is
 * this call's turn, it also re-reads the engine's own settings (not the
 * event's payload, which may itself be stale by then: a later switch, or
 * main's own command, may have already resolved the disagreement) and
 * persists only if it still disagrees with settings.current. A save failure
 * is logged, never thrown: this runs unprompted, off an event, with no
 * command to answer.
 */
export function reconcileLibraryPath(eventSettings: Pick<Settings, "libraryPath">, deps: LibraryReconcileDeps): Promise<void> {
  return deps.settings.exclusive(async () => {
    if (eventSettings.libraryPath === deps.settings.current.libraryPath) return;
    const response = await deps.engine.request({ v: PROTOCOL_VERSION, id: deps.newId(), kind: "command", type: "settings.get", payload: {} });
    if (!response.ok || response.type !== "settings.get") return;
    const enginePath = response.result.libraryPath;
    if (enginePath === deps.settings.current.libraryPath) return;
    try {
      await deps.settings.save({ ...deps.settings.current, libraryPath: enginePath });
    } catch (error) {
      console.error(`studio: settings.json could not be reconciled to the engine's library folder (${describe(error)})`);
    }
  });
}
