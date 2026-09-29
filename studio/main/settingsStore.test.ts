import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, posix, win32 } from "node:path";
import { defaultSettings, loadSettings, saveSettings, SETTINGS_FILE, SettingsStore } from "./settingsStore";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

let userData = "";
beforeEach(async () => {
  userData = await mkdtemp(join(tmpdir(), "studio-settings-"));
});
afterEach(async () => {
  await rm(userData, { recursive: true, force: true });
});

const path = () => join(userData, SETTINGS_FILE);

test("a missing file gives the defaults: $10 a month, the library in userData, the plan's models, the image age check off, exports in ~/Studio/export, automatic render concurrency", async () => {
  const loaded = await loadSettings(userData);
  expect(loaded).toEqual({
    source: "missing",
    settings: {
      monthlyBudgetMicros: 10_000_000,
      libraryPath: join(userData, "library"),
      imageModel: "x-ai/grok-imagine-image-2.0",
      textModel: "x-ai/grok-4.3",
      concurrency: { network: 6 },
      imageAgeCheck: "off",
      exportPath: join(homedir(), "Studio", "export"),
      renderConcurrency: "auto",
    },
  });
});

test("the default export folder is named from the home folder it is given", () => {
  const home = join(userData, "home", "mia");
  expect(defaultSettings(userData, home).exportPath).toBe(join(home, "Studio", "export"));
});

describe("the default export folder in each platform's own path spelling", () => {
  test("a Windows drive home gives a backslash path under it", () => {
    const settings = defaultSettings("C:\\Users\\mia\\AppData\\Roaming\\Studio", "C:\\Users\\mia", win32);
    expect(settings.exportPath).toBe("C:\\Users\\mia\\Studio\\export");
  });

  test("a Windows UNC home is accepted", () => {
    const settings = defaultSettings("C:\\Users\\mia\\AppData\\Roaming\\Studio", "\\\\srv\\home\\mia", win32);
    expect(settings.exportPath).toBe("\\\\srv\\home\\mia\\Studio\\export");
  });

  test("a POSIX-style home on Windows (rooted, no drive) is not absolute there: the export folder falls back to userData", () => {
    const settings = defaultSettings("C:\\Users\\mia\\AppData\\Roaming\\Studio", "/home/mia", win32);
    expect(settings.exportPath).toBe("C:\\Users\\mia\\AppData\\Roaming\\Studio\\export");
  });

  test("a POSIX home gives a slash path under it", () => {
    expect(defaultSettings("/Users/mia/Library/Application Support/Studio", "/Users/mia", posix).exportPath).toBe("/Users/mia/Studio/export");
  });
});

test("an unusable home folder (empty HOME, a relative path) falls back to an export folder under userData instead of crashing the startup", () => {
  for (const home of ["", "relative/home"]) {
    expect(defaultSettings(userData, home).exportPath).toBe(join(userData, "export"));
  }
});

test("loading settings never throws when the home folder is unusable", async () => {
  const loaded = await loadSettings(userData, "");
  expect(loaded).toMatchObject({ source: "missing", settings: { exportPath: join(userData, "export") } });
});

test("an older file that predates the export folder and render concurrency loads them as the defaults, and the file is left untouched", async () => {
  const { exportPath: _e, renderConcurrency: _r, ...older } = defaultSettings(userData);
  await writeFile(path(), JSON.stringify({ schemaVersion: 1, ...older }));
  const loaded = await loadSettings(userData);
  expect(loaded).toEqual({ source: "file", settings: defaultSettings(userData) });
  const onDisk = JSON.parse(await readFile(path(), "utf8"));
  expect(onDisk).not.toHaveProperty("exportPath");
  expect(onDisk).not.toHaveProperty("renderConcurrency");
});

test("an older file keeps an export folder and a render concurrency it already carries", async () => {
  const chosen = { ...defaultSettings(userData), exportPath: "/Volumes/Posted/Reels", renderConcurrency: 3 };
  await writeFile(path(), JSON.stringify({ schemaVersion: 1, ...chosen }));
  expect(await loadSettings(userData)).toEqual({ source: "file", settings: chosen });
});

test("a file with an explicit export folder that breaks the schema is invalid, not silently backfilled", async () => {
  await writeFile(path(), JSON.stringify({ schemaVersion: 1, ...defaultSettings(userData), exportPath: "relative/export" }));
  expect(await loadSettings(userData)).toMatchObject({ source: "invalid" });
});

test("a file with an explicit render concurrency outside auto or 1 to 8 is invalid", async () => {
  await writeFile(path(), JSON.stringify({ schemaVersion: 1, ...defaultSettings(userData), renderConcurrency: 9 }));
  expect(await loadSettings(userData)).toMatchObject({ source: "invalid" });
});

test("an older file that predates the image age check loads it as off, and the file itself is left untouched (no rewrite on read)", async () => {
  const { imageAgeCheck: _drop, ...older } = defaultSettings(userData);
  await writeFile(path(), JSON.stringify({ schemaVersion: 1, ...older }));
  const loaded = await loadSettings(userData);
  expect(loaded).toEqual({ source: "file", settings: defaultSettings(userData) });
  expect(JSON.parse(await readFile(path(), "utf8"))).not.toHaveProperty("imageAgeCheck");
});

test("an older file that also carries an explicit imageAgeCheck keeps it, not the backfilled default", async () => {
  await writeFile(path(), JSON.stringify({ schemaVersion: 1, ...defaultSettings(userData), imageAgeCheck: "on" }));
  const loaded = await loadSettings(userData);
  expect(loaded).toEqual({ source: "file", settings: { ...defaultSettings(userData), imageAgeCheck: "on" } });
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
  ["an imageAgeCheck outside off/on", { imageAgeCheck: "maybe" }],
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
