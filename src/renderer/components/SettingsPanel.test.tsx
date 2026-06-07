import { test, expect } from "bun:test";
import { settingsToOptions, type SettingsState } from "./SettingsPanel";

test("settingsToOptions maps every CopyOptions field", () => {
  const state: SettingsState = {
    count: 12,
    format: "feed",
    advanced: { keepResolution: true, keepTrendAudio: true, allowMirror: true, targetDistance: 123, strength: 1.3, spoofMetadata: false },
  };
  expect(settingsToOptions(state)).toEqual({
    strength: 1.3,
    exportFormat: "feed",
    keepTrendAudio: true,
    allowMirror: true,
    targetDistance: 123,
    spoofMetadata: false,
    keepResolution: true,
  });
});
