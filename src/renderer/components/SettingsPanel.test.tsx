import { test, expect } from "bun:test";
import { settingsToOptions, type SettingsState } from "./SettingsPanel";

test("settingsToOptions maps every CopyOptions field", () => {
  const state: SettingsState = {
    count: 12,
    preset: "aggressive",
    format: "feed",
    advanced: { keepTrendAudio: true, allowMirror: true, targetDistance: 123 },
  };
  expect(settingsToOptions(state)).toEqual({
    preset: "aggressive",
    exportFormat: "feed",
    keepTrendAudio: true,
    allowMirror: true,
    targetDistance: 123,
  });
});
