import { test, expect, beforeAll } from "bun:test";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { Api } from "../../electron/ipc";
import type { MediaInfo, StartOptions } from "../core/types";

/**
 * The renderer's side of the photo first frame: the choice is made in the
 * panel, the picture comes from the host's dialog, and the two have to meet
 * in the start payload. Driven through the real `App` with the IPC bridge
 * replaced, because the wiring — pick → state → Run → `start` — is the part
 * no component test can see.
 */

const videoInfo: MediaInfo = { kind: "video", durationSec: 5, width: 1080, height: 1920, hasAudio: true };

const started: Array<{ opts: StartOptions }> = [];
let nextPick: { path: string; thumb: string } | null = { path: "/pics/cover one.jpg", thumb: "data:image/jpeg;base64,AAAA" };

const fakeApi: Api = {
  pickFile: async () => "/in/clip.mp4",
  pickCover: async () => nextPick,
  getDroppedPath: () => "",
  probe: async () => videoInfo,
  chooseOutDir: async () => "/out",
  start: async (req) => { started.push({ opts: req.opts }); },
  cancel: async () => {},
  openFile: async () => {},
  revealInFolder: async () => {},
  onBatchProgress: () => {},
  onCopyDone: () => {},
  onPostPass: () => {},
  onBatchDone: () => {},
  onError: () => {},
};

let App: () => React.JSX.Element;

beforeAll(async () => {
  // `api.ts` reads `window.api` at import time, so the bridge has to be in
  // place before App is loaded — and, since test files share one module
  // cache, another file may have loaded it already with a bridge of its own.
  // Installing into whatever object it captured serves both orders.
  Object.assign(globalThis, { __APP_VERSION__: "test" });
  const captured: Api | undefined = window.api;
  if (captured) Object.assign(captured, fakeApi);
  else window.api = fakeApi;
  ({ App } = await import("./App"));
});

const FIRST_FRAME_LABEL = "Первый кадр";
const RUN_LABEL = "Уникализировать";

async function loadClip(): Promise<void> {
  const dropzone = screen.getByText("Перетащите видео или фото").closest(".dropzone");
  if (!dropzone) throw new Error("dropzone not rendered");
  fireEvent.click(dropzone);
  await waitFor(() => expect(screen.getByText("clip.mp4")).toBeDefined());
}

const choose = (label: string): void => {
  fireEvent.click(within(screen.getByRole("radiogroup", { name: FIRST_FRAME_LABEL })).getByRole("radio", { name: label }));
};

const runButton = (): HTMLButtonElement => {
  const b = screen.getByRole("button", { name: RUN_LABEL });
  if (!(b instanceof HTMLButtonElement)) throw new Error("run is not a button");
  return b;
};

test("the app starts with the first frame off and no cover row", () => {
  render(<App />);
  const off = within(screen.getByRole("radiogroup", { name: FIRST_FRAME_LABEL })).getByRole("radio", { name: "Выкл" });
  expect(off.getAttribute("aria-checked")).toBe("true");
  expect(screen.queryByText("Выбрать фото")).toBeNull();
});

test("choosing «Фото» holds Run until the host's dialog has returned a picture", async () => {
  render(<App />);
  await loadClip();
  expect(runButton().disabled).toBe(false);
  choose("Фото");
  expect(runButton().disabled).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Выбрать фото" }));

  await waitFor(() => expect(screen.getByText("cover one.jpg")).toBeDefined());
  expect(runButton().disabled).toBe(false);
});

test("a cancelled dialog leaves the state as it was", async () => {
  nextPick = null;
  try {
    render(<App />);
    await loadClip();
    choose("Фото");
    fireEvent.click(screen.getByRole("button", { name: "Выбрать фото" }));
    // Nothing to wait for; give the promise a turn.
    await new Promise((r) => setTimeout(r, 0));
    expect(screen.getByText(/не выбрано/i)).toBeDefined();
    expect(runButton().disabled).toBe(true);
  } finally {
    nextPick = { path: "/pics/cover one.jpg", thumb: "data:image/jpeg;base64,AAAA" };
  }
});

test("the start payload carries the mode and the picked path", async () => {
  started.length = 0;
  render(<App />);
  await loadClip();
  choose("Фото");
  fireEvent.click(screen.getByRole("button", { name: "Выбрать фото" }));
  await waitFor(() => expect(screen.getByText("cover one.jpg")).toBeDefined());

  fireEvent.click(runButton());

  await waitFor(() => expect(started.length).toBe(1));
  expect(started[0].opts.firstFrame).toBe("photo");
  expect(started[0].opts.coverPath).toBe("/pics/cover one.jpg");
});

test("with the first frame off, the start payload says so and sends no cover", async () => {
  started.length = 0;
  render(<App />);
  await loadClip();
  fireEvent.click(runButton());
  await waitFor(() => expect(started.length).toBe(1));
  expect(started[0].opts.firstFrame).toBe("off");
  expect(started[0].opts.coverPath).toBeNull();
});
