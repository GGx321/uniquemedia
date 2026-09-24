import { readFile, rename } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { EngineSettings } from "../engine/control";
import { writeJsonAtomic } from "../engine/library/durableFs";

export const SETTINGS_FILE = "settings.json";

/** Global budget per UTC month: $10 (plan, money model). */
export const DEFAULT_MONTHLY_BUDGET_MICROS = 10_000_000;
/** Plan, fixed decisions: default image model and scene text model. */
export const DEFAULT_IMAGE_MODEL = "x-ai/grok-imagine-image-2.0";
export const DEFAULT_TEXT_MODEL = "x-ai/grok-4.3";
export const DEFAULT_NETWORK_CONCURRENCY = 6;

/** On disk: the non-secret settings plus a version, strict so a stray field (a key) is refused. */
const SettingsFile = EngineSettings.extend({ schemaVersion: z.literal(1) });

export function defaultSettings(userData: string): EngineSettings {
  return EngineSettings.parse({
    monthlyBudgetMicros: DEFAULT_MONTHLY_BUDGET_MICROS,
    libraryPath: join(userData, "library"),
    imageModel: DEFAULT_IMAGE_MODEL,
    textModel: DEFAULT_TEXT_MODEL,
    concurrency: { network: DEFAULT_NETWORK_CONCURRENCY },
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

/** Reads `userData/settings.json`, Zod-validated. Never throws for a missing or invalid file. */
export async function loadSettings(userData: string): Promise<LoadedSettings> {
  const path = join(userData, SETTINGS_FILE);
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if (isMissing(error)) return { source: "missing", settings: defaultSettings(userData) };
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { source: "invalid", settings: defaultSettings(userData), problem: `${SETTINGS_FILE} is not valid JSON` };
  }
  const parsed = SettingsFile.safeParse(raw);
  if (!parsed.success) {
    const where = parsed.error.issues.map((i) => i.path.map(String).join(".") || "(root)").join(", ");
    return { source: "invalid", settings: defaultSettings(userData), problem: `${SETTINGS_FILE} breaks its schema at ${where}` };
  }
  const { schemaVersion: _version, ...settings } = parsed.data;
  return { source: "file", settings };
}

/** Validates and writes `userData/settings.json` atomically (temp + fsync + rename). */
export async function saveSettings(userData: string, settings: EngineSettings): Promise<void> {
  const file = SettingsFile.parse({ schemaVersion: 1, ...settings });
  await writeJsonAtomic(join(userData, SETTINGS_FILE), file);
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
      await rename(join(userData, SETTINGS_FILE), join(userData, aside));
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
