import { readFile, rename } from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";
import { z } from "zod";
import { EngineSettings } from "../engine/control";
import type { PathFlavour } from "../engine/pathFlavour";
import { AbsolutePath } from "../shared/engine";
import { writeJsonAtomic } from "../engine/library/durableFs";

export const SETTINGS_FILE = "settings.json";

/** Global budget per UTC month: $10 (plan, money model). */
export const DEFAULT_MONTHLY_BUDGET_MICROS = 10_000_000;
/** Plan, fixed decisions: default image model and scene text model. */
export const DEFAULT_IMAGE_MODEL = "x-ai/grok-imagine-image-2.0";
export const DEFAULT_TEXT_MODEL = "x-ai/grok-4.3";
export const DEFAULT_NETWORK_CONCURRENCY = 6;
/**
 * Owner's decision (2026-09-27): the paid image age check is off by default.
 * An older settings.json (written before this field existed) is missing the
 * key entirely, not carrying some other value — `loadSettings` backfills
 * exactly this default before validating, so an upgrade never turns the
 * check on by surprise.
 */
export const DEFAULT_IMAGE_AGE_CHECK = "off";
/** Render concurrency picks itself from the CPU and the memory ("Авто"); the engine never runs zero renders. */
export const DEFAULT_RENDER_CONCURRENCY = "auto";

/**
 * The «Готовые видео» folder of the default settings: `~/Studio/export`. The
 * engine creates it on first use (task 3a.8a); a folder the owner chose must
 * already exist.
 */
export function defaultExportPath(home: string, api: PathFlavour = nodePath): string {
  return api.join(home, "Studio", "export");
}


/** On disk: the non-secret settings plus a version, strict so a stray field (a key) is refused. */
const SettingsFile = EngineSettings.extend({ schemaVersion: z.literal(1) });

/** The library folder of the default settings; the engine creates it on first run. */
export function defaultLibraryPath(userData: string, api: PathFlavour = nodePath): string {
  return api.join(userData, "library");
}

export function defaultSettings(userData: string, home: string = homedir(), api: PathFlavour = nodePath): EngineSettings {
  return EngineSettings.parse({
    monthlyBudgetMicros: DEFAULT_MONTHLY_BUDGET_MICROS,
    libraryPath: defaultLibraryPath(userData, api),
    imageModel: DEFAULT_IMAGE_MODEL,
    textModel: DEFAULT_TEXT_MODEL,
    concurrency: { network: DEFAULT_NETWORK_CONCURRENCY },
    imageAgeCheck: DEFAULT_IMAGE_AGE_CHECK,
    // An empty HOME, a relative one, or (on Windows) a rooted path with no drive would break the contract's
    // absolute path and crash the startup. The platform's own rule AND the contract judge the path that is
    // actually built (the contract alone accepts `C:\x` on POSIX, where it is relative to the working directory),
    // and the export goes next to the rest of the app's data when either refuses.
    exportPath: [defaultExportPath(home, api), api.join(userData, "export")].find((path) => api.isAbsolute(path) && AbsolutePath.safeParse(path).success),
    renderConcurrency: DEFAULT_RENDER_CONCURRENCY,
  });
}

export type LoadedSettings =
  | { source: "file"; settings: EngineSettings }
  | { source: "missing"; settings: EngineSettings }
  /** The file is kept untouched for the user to inspect; defaults are used until the next save. */
  | { source: "invalid"; settings: EngineSettings; problem: string };

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/** Settings added after the first release: an older file lacks them, and `loadSettings` fills in the default. */
const BACKFILLED_KEYS = ["imageAgeCheck", "exportPath", "renderConcurrency"] as const;

function withMissingKeysBackfilled(raw: unknown, defaults: EngineSettings): unknown {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return raw;
  const filled: Record<string, unknown> = { ...raw };
  for (const key of BACKFILLED_KEYS) if (!(key in filled)) filled[key] = defaults[key];
  return filled;
}

/** Reads `userData/settings.json`, Zod-validated. Never throws for a missing or invalid file. */
export async function loadSettings(userData: string, home: string = homedir()): Promise<LoadedSettings> {
  const path = nodePath.join(userData, SETTINGS_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return { source: "missing", settings: defaultSettings(userData, home) };
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { source: "invalid", settings: defaultSettings(userData, home), problem: `${SETTINGS_FILE} is not valid JSON` };
  }
  // Backward compatibility for a file written before imageAgeCheck, exportPath
  // or renderConcurrency existed: backfill each default only when its key is
  // truly absent, never overriding an explicit (even if later invalid) value
  // the file already carries.
  const parsed = SettingsFile.safeParse(withMissingKeysBackfilled(raw, defaultSettings(userData, home)));
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.map(String).join(".") || "(root)").join(", ");
    return { source: "invalid", settings: defaultSettings(userData, home), problem: `${SETTINGS_FILE} breaks its schema at ${where}` };
  }
  const { schemaVersion: _version, ...settings } = parsed.data;
  return { source: "file", settings };
}

/** Validates and writes `userData/settings.json` atomically (temp + fsync + rename). */
export async function saveSettings(userData: string, settings: EngineSettings): Promise<void> {
  const file = SettingsFile.parse({ schemaVersion: 1, ...settings });
  await writeJsonAtomic(nodePath.join(userData, SETTINGS_FILE), file);
}

/** `2026-09-24T11:22:33.456Z` → `20260924T112233Z`, safe in a file name on every platform. */
function stamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, "Z").replace(/[-:]/g, "");
}

/**
 * Main's settings: the single owner of `userData/settings.json`. The file is
 * written (atomically) before a change becomes current, so what the engine
 * and the renderer are told has always been persisted.
 */
export class SettingsStore {
  readonly #userData: string;
  #current: EngineSettings;
  #tail: Promise<unknown> = Promise.resolve();

  private constructor(userData: string, current: EngineSettings) {
    this.#userData = userData;
    this.#current = current;
  }

  /**
   * Loads the settings. A missing file gets the defaults written. A corrupt
   * one is moved to `settings.json.corrupt-<time>` (kept for the user), the
   * defaults are written, and `notice` says what happened.
   */
  static async open(userData: string, now: () => Date = () => new Date()): Promise<{ store: SettingsStore; notice: string | null }> {
    const loaded = await loadSettings(userData);
    const store = new SettingsStore(userData, loaded.settings);
    if (loaded.source === "file") return { store, notice: null };
    let notice: string | null = null;
    if (loaded.source === "invalid") {
      const aside = `${SETTINGS_FILE}.corrupt-${stamp(now())}`;
      await rename(nodePath.join(userData, SETTINGS_FILE), nodePath.join(userData, aside));
      notice = `${loaded.problem}; it was moved to ${aside} and the defaults are in use`;
    }
    await saveSettings(userData, loaded.settings);
    return { store, notice };
  }

  get current(): EngineSettings {
    return this.#current;
  }

  async save(next: EngineSettings): Promise<void> {
    await saveSettings(this.#userData, next);
    this.#current = next;
  }

  /** Runs changes one at a time, so two cannot both start from the same old settings. */
  exclusive<T>(task: () => Promise<T>): Promise<T> {
    const result = this.#tail.then(task);
    this.#tail = result.catch(() => undefined);
    return result;
  }
}
