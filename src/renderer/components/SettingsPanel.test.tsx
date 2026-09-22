import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
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
    identity: "engine",
    edgeMode: "fit",
    firstFrame: "black",
    cover: null,
  },
};

const cover = { path: "/p/cover.jpg", thumb: "data:image/jpeg;base64,AAAA" };

/** The panel with every callback stubbed, for the tests about what it shows. */
function renderPanel(
  source: Parameters<typeof SettingsPanel>[0]["source"],
  s: SettingsState = state,
  onPickCover: () => void = () => {}
) {
  return render(
    <SettingsPanel
      source={source}
      state={s}
      running={false}
      onPick={() => {}}
      onDropFile={() => {}}
      onChange={() => {}}
      onRun={() => {}}
      onStop={() => {}}
      onPickCover={onPickCover}
    />
  );
}

const photoInfo: MediaInfo = { kind: "photo", durationSec: 0, width: 4032, height: 3024, hasAudio: false };
const videoInfo: MediaInfo = { kind: "video", durationSec: 5, width: 1080, height: 1920, hasAudio: true };

test("settingsToOptions maps every CopyOptions field", () => {
  expect(settingsToOptions(state)).toEqual({
    strength: 1.3,
    exportFormat: "feed",
    keepTrendAudio: true,
    allowMirror: true,
    targetDistance: 123,
    identity: "engine",
    edgeMode: "fit",
    firstFrame: "black",
    coverPath: null,
  });
});

test("settingsToOptions sends the chosen cover's path, and only the path", () => {
  const opts = settingsToOptions({ ...state, advanced: { ...state.advanced, firstFrame: "photo", cover } });
  expect(opts.firstFrame).toBe("photo");
  expect(opts.coverPath).toBe("/p/cover.jpg");
  expect("cover" in opts).toBe(false);
  expect("thumb" in opts).toBe(false);
});

test("settingsToPhotoOptions maps every PhotoCopyOptions field", () => {
  expect(settingsToPhotoOptions(state)).toEqual({
    strength: 1.3,
    exportFormat: "feed",
    allowMirror: true,
    targetDistance: 123,
    identity: "engine",
    edgeMode: "fit",
  });
});

test("settingsToPhotoOptions drops the audio flag rather than carrying a dead one", () => {
  expect("keepTrendAudio" in settingsToPhotoOptions(state)).toBe(false);
});

test("settingsToPhotoOptions drops the first-frame fields rather than carrying dead ones", () => {
  const opts = settingsToPhotoOptions({ ...state, advanced: { ...state.advanced, firstFrame: "photo", cover } });
  expect("firstFrame" in opts).toBe(false);
  expect("coverPath" in opts).toBe(false);
  expect("cover" in opts).toBe(false);
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
      onPickCover={() => {}}
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
      onPickCover={() => {}}
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
      onPickCover={() => {}}
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
      onPickCover={() => {}}
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
      onPickCover={() => {}}
    />
  );
  expect(screen.getByLabelText("Сохранять края кадра")).toBeDefined();
});

const FIRST_FRAME_LABEL = "Первый кадр";
const RUN_LABEL = "Уникализировать";

test("the panel hides the first-frame row when the source is a photo", () => {
  renderPanel({ name: "IMG_0042.jpg", info: photoInfo });
  expect(screen.queryByRole("radiogroup", { name: FIRST_FRAME_LABEL })).toBeNull();
});

test("the panel keeps the first-frame row when the source is a video", () => {
  renderPanel({ name: "clip.mp4", info: videoInfo });
  expect(screen.getByRole("radiogroup", { name: FIRST_FRAME_LABEL })).toBeDefined();
});

test("the panel keeps the first-frame row before a source is chosen", () => {
  renderPanel(null);
  expect(screen.getByRole("radiogroup", { name: FIRST_FRAME_LABEL })).toBeDefined();
});

test("the pick button asks the host, not the panel, for the picture", () => {
  let picked = 0;
  renderPanel(
    { name: "clip.mp4", info: videoInfo },
    { ...state, advanced: { ...state.advanced, firstFrame: "photo" } },
    () => picked++
  );
  fireEvent.click(screen.getByRole("button", { name: "Выбрать фото" }));
  expect(picked).toBe(1);
});

const runButton = (): HTMLButtonElement => {
  const b = screen.getByRole("button", { name: RUN_LABEL });
  if (!(b instanceof HTMLButtonElement)) throw new Error("run is not a button");
  return b;
};

test("Run stays disabled while the first frame is a photo and none is chosen", () => {
  renderPanel(
    { name: "clip.mp4", info: videoInfo },
    { ...state, advanced: { ...state.advanced, firstFrame: "photo", cover: null } }
  );
  expect(runButton().disabled).toBe(true);
});

test("Run is enabled once a photo is chosen for the first frame", () => {
  renderPanel(
    { name: "clip.mp4", info: videoInfo },
    { ...state, advanced: { ...state.advanced, firstFrame: "photo", cover } }
  );
  expect(runButton().disabled).toBe(false);
});

test("Run is not held back by the photo mode when the other modes are chosen", () => {
  for (const firstFrame of ["off", "black"] as const) {
    const { unmount } = renderPanel(
      { name: "clip.mp4", info: videoInfo },
      { ...state, advanced: { ...state.advanced, firstFrame, cover: null } }
    );
    expect(runButton().disabled).toBe(false);
    unmount();
  }
});

test("Run is not held back by a missing cover when the source is a photo, which has no first frame to fill", () => {
  renderPanel(
    { name: "IMG_0042.jpg", info: photoInfo },
    { ...state, advanced: { ...state.advanced, firstFrame: "photo", cover: null } }
  );
  expect(runButton().disabled).toBe(false);
});

test("the pick button is disabled while the batch runs", () => {
  render(
    <SettingsPanel
      source={{ name: "clip.mp4", info: videoInfo }}
      state={{ ...state, advanced: { ...state.advanced, firstFrame: "photo" } }}
      running
      onPick={() => {}}
      onDropFile={() => {}}
      onChange={() => {}}
      onRun={() => {}}
      onStop={() => {}}
      onPickCover={() => {}}
    />
  );
  const button = screen.getByRole("button", { name: "Выбрать фото" });
  expect(button instanceof HTMLButtonElement ? button.disabled : null).toBe(true);
});

test("the pick button is enabled while the batch is not running", () => {
  renderPanel(
    { name: "clip.mp4", info: videoInfo },
    { ...state, advanced: { ...state.advanced, firstFrame: "photo" } }
  );
  const button = screen.getByRole("button", { name: "Выбрать фото" });
  expect(button instanceof HTMLButtonElement ? button.disabled : null).toBe(false);
});

test("Run stays disabled with no source, whatever the first frame", () => {
  renderPanel(null, { ...state, advanced: { ...state.advanced, firstFrame: "photo", cover } });
  expect(runButton().disabled).toBe(true);
});
