import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultSettings, loadSettings, saveSettings, SETTINGS_FILE, SettingsStore } from "./settingsStore";

let userData = "";
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "studio-settings-"));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

const path = () => join(userData, SETTINGS_FILE);

test("a missing file gives the defaults: $10 a month, the library in userData, the plan's models", async () => {
  const loaded = await loadSettings(userData);
  expect(loaded).toEqual({
    source: "missing",
    settings: {
      monthlyBudgetMicros: 10_000_000,
      libraryPath: join(userData, "library"),
      imageModel: "x-ai/grok-imagine-image-2.0",
      textModel: "x-ai/grok-4.3",
      concurrency: { network: 6 },
    },
  });
});

test("save then load round-trips, and the file carries its schema version", async () => {
  const settings = { ...defaultSettings(userData), monthlyBudgetMicros: 25_000_000, concurrency: { network: 3 } };
  await saveSettings(userData, settings);
  expect(await loadSettings(userData)).toEqual({ source: "file", settings });
  expect(JSON.parse(await readFile(path(), "utf8"))).toMatchObject({ schemaVersion: 1, monthlyBudgetMicros: 25_000_000 });
});

test("save leaves no temp file behind and overwrites in place", async () => {
  await saveSettings(userData, defaultSettings(userData));
  await saveSettings(userData, { ...defaultSettings(userData), textModel: "x-ai/grok-5" });
  expect(await readdir(userData)).toEqual([SETTINGS_FILE]);
  expect((await loadSettings(userData)).settings.textModel).toBe("x-ai/grok-5");
});

test("save refuses settings that break the schema and writes nothing", async () => {
  const bad = { ...defaultSettings(userData), monthlyBudgetMicros: 1.5 };
  await expect(saveSettings(userData, bad)).rejects.toThrow();
  expect(await readdir(userData)).toEqual([]);
});

test("invalid JSON falls back to defaults and keeps the file untouched", async () => {
  await writeFile(path(), "{ not json");
  const loaded = await loadSettings(userData);
  expect(loaded).toMatchObject({ source: "invalid", problem: "settings.json is not valid JSON" });
  expect(loaded.settings).toEqual(defaultSettings(userData));
  expect(await readFile(path(), "utf8")).toBe("{ not json");
});

const invalidFiles: [string, Record<string, unknown>][] = [
  ["a float budget", { monthlyBudgetMicros: 10.5 }],
  ["a negative budget", { monthlyBudgetMicros: -1 }],
  ["a relative library path", { libraryPath: "library" }],
  ["a library path with ..", { libraryPath: "/Users/me/../etc" }],
  ["a malformed model id", { imageModel: "grok" }],
  ["zero network concurrency", { concurrency: { network: 0 } }],
  ["concurrency above 16", { concurrency: { network: 17 } }],
  ["an unknown field such as a key", { apiKey: "sk-or-v1-0123456789" }],
  ["another schema version", { schemaVersion: 2 }],
];

for (const [name, patch] of invalidFiles) {
  test(`a file with ${name} is invalid and the defaults are used`, async () => {
    await writeFile(path(), JSON.stringify({ schemaVersion: 1, ...defaultSettings(userData), ...patch }));
    const loaded = await loadSettings(userData);
    expect(loaded.source).toBe("invalid");
    expect(loaded.settings).toEqual(defaultSettings(userData));
    expect(JSON.stringify(loaded)).not.toContain("sk-or-");
  });
}

test("a file without its schema version is invalid", async () => {
  await writeFile(path(), JSON.stringify(defaultSettings(userData)));
  expect((await loadSettings(userData)).source).toBe("invalid");
});

describe("SettingsStore", () => {
  const NOW = new Date("2026-09-24T11:22:33.456Z");

  test("first start: the defaults are written to settings.json", async () => {
    const { store, notice } = await SettingsStore.open(userData, () => NOW);
    expect(notice).toBeNull();
    expect(store.current).toEqual(defaultSettings(userData));
    expect(await loadSettings(userData)).toEqual({ source: "file", settings: defaultSettings(userData) });
  });

  test("a valid file is loaded as is", async () => {
    const saved = { ...defaultSettings(userData), monthlyBudgetMicros: 3_000_000 };
    await saveSettings(userData, saved);
    const { store, notice } = await SettingsStore.open(userData, () => NOW);
    expect(notice).toBeNull();
    expect(store.current).toEqual(saved);
  });

  test("a corrupt file is moved to settings.json.corrupt-<time>, defaults are written, and a notice says so", async () => {
    await writeFile(path(), "{ corrupt");
    const { store, notice } = await SettingsStore.open(userData, () => NOW);

    const aside = "settings.json.corrupt-20260924T112233Z";
    expect((await readdir(userData)).sort()).toEqual([SETTINGS_FILE, aside]);
    expect(await readFile(join(userData, aside), "utf8")).toBe("{ corrupt");
    expect(store.current).toEqual(defaultSettings(userData));
    expect(await loadSettings(userData)).toEqual({ source: "file", settings: defaultSettings(userData) });
    expect(notice).toBe(`settings.json is not valid JSON; it was moved to ${aside} and the defaults are in use`);
  });

  test("save persists first, then becomes the current settings", async () => {
    const { store } = await SettingsStore.open(userData, () => NOW);
    const next = { ...store.current, textModel: "x-ai/grok-5" };
    await store.save(next);
    expect(store.current).toEqual(next);
    expect((await loadSettings(userData)).settings).toEqual(next);
  });

  test("a save that fails leaves the current settings unchanged", async () => {
    const { store } = await SettingsStore.open(userData, () => NOW);
    const before = store.current;
    await expect(store.save({ ...before, monthlyBudgetMicros: -5 })).rejects.toThrow();
    expect(store.current).toEqual(before);
  });
});
