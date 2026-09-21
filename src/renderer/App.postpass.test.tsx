import { test, expect, beforeAll } from "bun:test";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { Api } from "../../electron/ipc";
import type { MediaInfo } from "../core/types";

/**
 * The renderer's side of the inter-copy check: the phase the main process
 * reports must reach the queue header while the batch runs, and leave with
 * the batch. Driven through the real `App` with the IPC bridge replaced,
 * because the wiring — event → state → `BatchProgress` — is what was missing.
 */

type PostPassCb = Parameters<Api["onPostPass"]>[0];
type BatchDoneCb = Parameters<Api["onBatchDone"]>[0];
type CopyDoneCb = Parameters<Api["onCopyDone"]>[0];
type ProgressCb = Parameters<Api["onBatchProgress"]>[0];

const bridge: {
  postPass?: PostPassCb;
  batchDone?: BatchDoneCb;
  copyDone?: CopyDoneCb;
  progress?: ProgressCb;
} = {};

const photoInfo: MediaInfo = { kind: "photo", durationSec: 0, width: 640, height: 480, hasAudio: false };

const fakeApi: Api = {
  pickFile: async () => "/in/still.jpg",
  getDroppedPath: () => "",
  probe: async () => photoInfo,
  chooseOutDir: async () => "/out",
  start: async () => {},
  cancel: async () => {},
  openFile: async () => {},
  revealInFolder: async () => {},
  onBatchProgress: (cb) => { bridge.progress = cb; },
  onCopyDone: (cb) => { bridge.copyDone = cb; },
  onPostPass: (cb) => { bridge.postPass = cb; },
  onBatchDone: (cb) => { bridge.batchDone = cb; },
  onError: () => {},
};

const LABEL = "Проверка уникальности между копиями";

let App: () => React.JSX.Element;

beforeAll(async () => {
  // `api.ts` reads `window.api` at import time, so the bridge has to be in
  // place before App is loaded.
  Object.assign(globalThis, { __APP_VERSION__: "test" });
  window.api = fakeApi;
  ({ App } = await import("./App"));
});

/** Loads a source and presses Run, so the batch is in its running state. */
async function startBatch(): Promise<void> {
  const dropzone = screen.getByText("Перетащите видео или фото").closest(".dropzone");
  if (!dropzone) throw new Error("dropzone not rendered");
  fireEvent.click(dropzone);
  // Run is disabled until the probe has answered.
  await waitFor(() => expect(screen.getByText("still.jpg")).toBeDefined());
  fireEvent.click(screen.getByText("Уникализировать"));
  await waitFor(() => expect(screen.getByText(/Стоп/)).toBeDefined());
}

test("shows the inter-copy check with its progress while the batch runs", async () => {
  render(<App />);
  await startBatch();
  expect(screen.queryByText(LABEL)).toBeNull();

  act(() => bridge.postPass?.({ done: 4, total: 10 }));

  expect(screen.getByText(LABEL)).toBeDefined();
  expect(screen.getByText(/4\/10/)).toBeDefined();
});

test("the inter-copy check leaves with the batch", async () => {
  render(<App />);
  await startBatch();
  act(() => bridge.postPass?.({ done: 4, total: 10 }));
  expect(screen.getByText(LABEL)).toBeDefined();

  act(() => bridge.batchDone?.({ passed: 10, total: 10 }));

  expect(screen.queryByText(LABEL)).toBeNull();
});

test("a copy being regenerated keeps its file name on the card", async () => {
  // The regeneration's progress ticks put the card back into "rendering";
  // they must not rename a card that already knows its file.
  render(<App />);
  await startBatch();
  act(() => bridge.copyDone?.({ index: 0, path: "/out/still_1.jpg", thumb: "", verify: { minDistance: 50, passed: true } }));
  expect(screen.getByText("still_1.jpg")).toBeDefined();

  act(() => bridge.progress?.({ index: 0, count: 10, fraction: 0.3 }));

  expect(screen.getByText("still_1.jpg")).toBeDefined();
  expect(screen.queryByText("Копия 1")).toBeNull();
});
