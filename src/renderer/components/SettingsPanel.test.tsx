import { test, expect } from "bun:test";
import { render, screen } from "@testing-library/react";
import {
  SettingsPanel,
  settingsToOptions,
  settingsToPhotoOptions,
  type SettingsState,
} from "./SettingsPanel";
import type { MediaInfo } from "../../core/types";

const state: SettingsState = {
  count: 12,
  format: "feed",
  advanced: {
    keepTrendAudio: true,
    allowMirror: true,
    targetDistance: 123,
    strength: 1.3,
    spoofMetadata: false,
    edgeMode: "fit",
  },
};

const photoInfo: MediaInfo = { kind: "photo", durationSec: 0, width: 4032, height: 3024, hasAudio: false };
const videoInfo: MediaInfo = { kind: "video", durationSec: 5, width: 1080, height: 1920, hasAudio: true };

test("settingsToOptions maps every CopyOptions field", () => {
  expect(settingsToOptions(state)).toEqual({
    strength: 1.3,
    exportFormat: "feed",
    keepTrendAudio: true,
    allowMirror: true,
    targetDistance: 123,
    spoofMetadata: false,
    edgeMode: "fit",
  });
});

test("settingsToPhotoOptions maps every PhotoCopyOptions field", () => {
  expect(settingsToPhotoOptions(state)).toEqual({
    strength: 1.3,
    exportFormat: "feed",
    allowMirror: true,
    targetDistance: 123,
    spoofMetadata: false,
    edgeMode: "fit",
  });
});

test("settingsToPhotoOptions drops the audio flag rather than carrying a dead one", () => {
  expect("keepTrendAudio" in settingsToPhotoOptions(state)).toBe(false);
});

test("the panel hides the audio row when the source is a photo", () => {
  render(
    <SettingsPanel
      source={{ name: "IMG_0042.jpg", info: photoInfo }}
      state={state}
      running={false}
      onPick={() => {}}
      onDropFile={() => {}}
      onChange={() => {}}
      onRun={() => {}}
      onStop={() => {}}
    />
  );
  expect(screen.queryByLabelText("Сохранить оригинальный звук")).toBeNull();
});

test("the panel keeps the audio row when the source is a video", () => {
  render(
    <SettingsPanel
      source={{ name: "clip.mp4", info: videoInfo }}
      state={state}
      running={false}
      onPick={() => {}}
      onDropFile={() => {}}
      onChange={() => {}}
      onRun={() => {}}
      onStop={() => {}}
    />
  );
  expect(screen.getByLabelText("Сохранить оригинальный звук")).toBeDefined();
});

test("the panel keeps the audio row before a source is chosen", () => {
  render(
    <SettingsPanel
      source={null}
      state={state}
      running={false}
      onPick={() => {}}
      onDropFile={() => {}}
      onChange={() => {}}
      onRun={() => {}}
      onStop={() => {}}
    />
  );
  expect(screen.getByLabelText("Сохранить оригинальный звук")).toBeDefined();
});

test("the panel hides the edge control when the source is a video", () => {
  render(
    <SettingsPanel
      source={{ name: "clip.mp4", info: videoInfo }}
      state={state}
      running={false}
      onPick={() => {}}
      onDropFile={() => {}}
      onChange={() => {}}
      onRun={() => {}}
      onStop={() => {}}
    />
  );
  expect(screen.queryByLabelText("Сохранять края кадра")).toBeNull();
});

test("the panel shows the edge control when the source is a photo", () => {
  render(
    <SettingsPanel
      source={{ name: "IMG_0042.jpg", info: photoInfo }}
      state={state}
      running={false}
      onPick={() => {}}
      onDropFile={() => {}}
      onChange={() => {}}
      onRun={() => {}}
      onStop={() => {}}
    />
  );
  expect(screen.getByLabelText("Сохранять края кадра")).toBeDefined();
});
