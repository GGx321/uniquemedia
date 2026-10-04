import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MONTAGE_ISSUE_MESSAGES_RU, type MontageDraft } from "../../shared/engine";
import { FRAME_H, FRAME_W, videoClipCrop } from "../../shared/montage";
import type { MockEngine } from "../engine/mockEngine";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import { NBSP } from "../lib/format";
import { callsOf, flush } from "../testing";
import { AUTOSAVE_DEBOUNCE_MS } from "./montage/autosave";
import { dragFocus } from "./montage/previewDrag";
import { asAnotherWindow, makeDraft, MIA, openDrafts, paidMusicCalls, studio as openStudio } from "./montage/screenKit";
import { photoClip, stickerLayer, videoClip } from "./montage/testkit";

// 3f.3b: an own video clip in the editor (EditorMine.dc.html, `sel = c3`). The preview shows the clip's video cropped as the render crops it (in the
// dev mock, which has no picture, a stand-in of the same place); the properties show «Обрезка» (the window over the whole video: slide it, or move
// either edge, on the 100 ms grid, within the video and the 15 s), «Кадр», the source facts and «Звук видео не используется»; the timeline block says
// what the render refuses the clip for. Each gesture or held key is one undo step, and a cancelled drag changes nothing.

const [P1, P2] = [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? ""];
const SOURCE = { w: 1_080, h: 608 };

const opened: MockEngine[] = [];
async function studio(): ReturnType<typeof openStudio> {
  const harness = await openStudio();
  opened.push(harness.engine);
  return harness;
}
afterEach(() => {
  // 3d.5's money guard holds here too.
  for (const engine of opened.splice(0)) expect(paidMusicCalls(engine)).toEqual([]);
});

const timeline = (): HTMLElement => screen.getByRole("region", { name: "Таймлайн" });
const preview = (): HTMLElement => screen.getByRole("region", { name: "Превью" });
const props = (): HTMLElement => screen.getByRole("complementary", { name: "Свойства" });
const slider = (name: string): HTMLElement => within(props()).getByRole("slider", { name });
const undo = (): void => void fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
const redo = (): void => void fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
const s = (text: string): string => text.replace(/(\d) с/g, `$1${NBSP}с`);

/** The library holds a 14 s landscape video (1080 x 608, 29.97 fps); its media id. */
function storeVideo(engine: MockEngine): string {
  engine.seedOwnMedia([{ kind: "video", name: "street-walk.mp4", bytes: 4_000_000, facts: { width: SOURCE.w, height: SOURCE.h, durationMs: 14_000, sourceFps: 29.97 } }]);
  return "media-demo-0001";
}

/** 2 s of a photo, the video clip, 2 s of a photo. */
const clipsWith = (video: MontageDraft["clips"][number]): MontageDraft["clips"] => [photoClip(0, P1, 2_000), video, photoClip(2, P2, 2_000)];
const ownClip = (mediaId: string, durationMs = 2_000, trimStartMs = 1_800): MontageDraft["clips"][number] => ({ ...videoClip(1, durationMs, trimStartMs), mediaId });

async function openDraft(engine: MockEngine, client: Parameters<typeof makeDraft>[0], clips: MontageDraft["clips"]): Promise<void> {
  const made = await makeDraft(client, MIA.avatarId, []);
  const saved = await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec: { ...made.spec, clips }, name: null }));
  if (!saved.ok) throw new Error(`montages.save: ${saved.error.code}`);
  await openDrafts();
  await screen.findByRole("heading", { level: 3, name: /Mia/ });
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();
  for (let i = engine.calls.length - 1; i >= 0; i--) if (engine.calls[i]?.type === "montages.save") engine.calls.splice(i, 1);
}

/** The draft as the engine last saved it, after the next save lands. */
async function nextSave(engine: MockEngine, before = 0): Promise<MontageDraft> {
  await waitFor(() => expect(callsOf(engine, "montages.save").length).toBeGreaterThan(before), { timeout: AUTOSAVE_DEBOUNCE_MS * 4 });
  const last = callsOf(engine, "montages.save").at(-1);
  if (last === undefined) throw new Error("no save");
  return last.payload.spec;
}

const videoOf = (spec: MontageDraft) => {
  const clip = spec.clips[1];
  if (clip?.kind !== "video") throw new Error("clip 2 is not a video");
  return clip;
};

/** Selects the video clip from its block on the timeline (the playhead goes into it). */
async function selectVideo(): Promise<void> {
  fireEvent.click(within(timeline()).getByRole("button", { name: /^Кадр 2: / }));
  await flush();
}

/** A pointer drag of `node` by `dx` screen px; "cancel" ends it as the system taking the pointer. */
function drag(node: Element, dx: number, pointerId: number, end: "up" | "cancel" = "up", dy = 0): void {
  fireEvent.pointerDown(node, { pointerId, button: 0, clientX: 100, clientY: 100 });
  act(() => {
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId, clientX: 100 + dx / 2, clientY: 100 + dy / 2, buttons: 1 }));
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId, clientX: 100 + dx, clientY: 100 + dy, buttons: 1 }));
    window.dispatchEvent(new PointerEvent(end === "up" ? "pointerup" : "pointercancel", { pointerId, clientX: 100 + dx, clientY: 100 + dy }));
  });
}

/** Lays the trim strip out 280 px wide (the test DOM lays nothing out): 50 ms of the 14 s video per px. */
function layOutStrip(): void {
  const strip = props().querySelector(".ed-trim");
  if (strip === null) throw new Error("no trim strip");
  Object.defineProperty(strip, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, right: 280, bottom: 48, width: 280, height: 48, x: 0, y: 0, toJSON: () => ({}) }) });
}

describe("the preview", () => {
  test("the dev mock has no picture: the clip's stand-in, cut from the video where the render cuts it, names the file, its size and the frame on screen", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await selectVideo();
    // The playhead on the clip's first frame: 2.0 s.
    const head = within(timeline()).getByRole("slider", { name: "Плейхед" });
    fireEvent.keyDown(head, { key: "Home" });
    fireEvent.keyDown(head, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(head, { key: "ArrowRight", shiftKey: true });
    const cell = within(preview()).getByRole("button", { name: "Кадр 2: своё видео" });
    expect(cell.getAttribute("aria-pressed")).toBe("true");
    expect(preview().querySelector("video") === null).toBe(true);
    const ground = preview().querySelector<HTMLElement>(".pv-video-ground");
    const crop = videoClipCrop(SOURCE, null);
    expect(Number.parseFloat(ground?.style.width ?? "")).toBeCloseTo((SOURCE.w / crop.w) * 100, 6);
    expect(Number.parseFloat(ground?.style.left ?? "")).toBeCloseTo((-crop.x / crop.w) * 100, 6);
    expect(preview().textContent).toContain("street-walk.mp4");
    expect(preview().textContent).toContain("1080×608 · 0:01.8");
    expect(within(preview()).getByText("тяните, чтобы сдвинуть")).toBeDefined();
  });

  test("the selected clip's video drags by its focus: one edit when let go, undone in one step; a cancelled drag changes nothing", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await selectVideo();
    const cell = (): HTMLElement => within(preview()).getByRole("button", { name: "Кадр 2: своё видео" });
    drag(cell(), 30, 31, "cancel");
    await flush();
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
    drag(cell(), 30, 32);
    const saved = await nextSave(engine);
    // The test DOM lays nothing out: a pointer pixel is the artboard's (306 px for 1080). The video followed the pointer right.
    expect(videoOf(saved).focus).toEqual(dragFocus(null, { dx: (30 * FRAME_W) / 306, dy: 0 }, { w: FRAME_W, h: FRAME_H }, SOURCE));
    expect(videoOf(saved).focus?.x ?? 1).toBeLessThan(0.5);
    expect(callsOf(engine, "montages.save")).toHaveLength(1);
    undo();
    expect(videoOf(await nextSave(engine, 1)).focus).toBe(null);
  });

  test("the video follows the pointer while it is dragged, before anything is saved", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await selectVideo();
    const cell = within(preview()).getByRole("button", { name: "Кадр 2: своё видео" });
    const left = (): string => preview().querySelector<HTMLElement>(".pv-video-ground")?.style.left ?? "";
    const before = left();
    fireEvent.pointerDown(cell, { pointerId: 35, button: 0, clientX: 100, clientY: 100 });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 35, clientX: 140, clientY: 100, buttons: 1 }));
    });
    // Dragged right: the video moved right with it (its left edge further in).
    expect(Number.parseFloat(left())).toBeGreaterThan(Number.parseFloat(before));
    act(() => {
      window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 35, clientX: 140, clientY: 100 }));
    });
    expect(left()).toBe(before);
    await flush();
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
  });

  test("a video already 9:16 fills the frame whole: it says so, and neither a drag nor a key writes anything", async () => {
    const { client, engine } = await studio();
    engine.seedOwnMedia([{ kind: "video", name: "latte-pour.mov", bytes: 4_000_000, facts: { width: 1_080, height: 1_920, durationMs: 6_400, sourceFps: 60 } }]);
    await openDraft(engine, client, clipsWith(ownClip("media-demo-0001")));
    await selectVideo();
    const cell = (): HTMLElement => within(preview()).getByRole("button", { name: "Кадр 2: своё видео" });
    expect(within(preview()).getByText("видео 9:16 · весь кадр")).toBeDefined();
    // Nothing to move: no arrows are announced on it (fix round 1, L9).
    expect(cell().hasAttribute("aria-keyshortcuts")).toBe(false);
    expect(within(props()).getByText("Видео уже 9:16 и занимает весь кадр — сдвигать нечего.")).toBeDefined();
    drag(cell(), 30, 36);
    fireEvent.keyDown(cell(), { key: "ArrowLeft" });
    fireEvent.keyUp(cell(), { key: "ArrowLeft" });
    await flush();
    // No edit was made: nothing to undo (an edit enables «Отменить» at once, before any save).
    expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
  });

  test("arrow keys move the selected clip's video, a held key one undo step", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await selectVideo();
    const cell = (): HTMLElement => within(preview()).getByRole("button", { name: "Кадр 2: своё видео" });
    fireEvent.keyDown(cell(), { key: "ArrowLeft" });
    fireEvent.keyDown(cell(), { key: "ArrowLeft", repeat: true });
    fireEvent.keyUp(cell(), { key: "ArrowLeft" });
    expect(videoOf(await nextSave(engine)).focus?.x ?? 0).toBeGreaterThan(0.5);
    undo();
    await flush();
    expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("the properties", () => {
  test("«Обрезка», what is left of the 15 s, «Кадр», the source facts and the sound note; no «Длительность»", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await selectVideo();
    const panel = props();
    expect(within(panel).getByText("Кадр 2 из 3")).toBeDefined();
    expect(within(panel).getByText("видео · 2.0–4.0 с")).toBeDefined();
    expect(within(panel).getByText("Обрезка")).toBeDefined();
    expect(slider("Отрезок видео").getAttribute("aria-valuetext")).toBe(s("1.8 → 3.8 с"));
    expect(within(panel).getByText("1.8 → 3.8 с")).toBeDefined();
    expect(within(panel).getByText("2.0 с из 14.0")).toBeDefined();
    expect(within(panel).getByText("ролик 6.0 с из 15 · кадр можно удлинить ещё на 9.0 с")).toBeDefined();
    expect(within(panel).getByText(/Видео шире кадра/)).toBeDefined();
    expect(within(panel).getByText("street-walk.mp4")).toBeDefined();
    expect(within(panel).getByText("14.0 с · 1080×608 · 29.97 → 30 fps")).toBeDefined();
    expect(within(panel).getByText("свой файл")).toBeDefined();
    expect(within(panel).queryByText("HDR → SDR") === null).toBe(true);
    expect(within(panel).getByText("Звук видео не используется — в ролике только музыка")).toBeDefined();
    expect(within(panel).queryByLabelText("Длительность") === null).toBe(true);
    expect(within(timeline()).getByRole("button", { name: s("Кадр 2: видео street-walk.mp4, 2.0 с") })).toBeDefined();
  });

  test("the window slides by keys on the 100 ms grid; a held key is one undo step, and redo brings it back", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await selectVideo();
    fireEvent.keyDown(slider("Отрезок видео"), { key: "ArrowRight" });
    fireEvent.keyDown(slider("Отрезок видео"), { key: "ArrowRight", repeat: true });
    fireEvent.keyDown(slider("Отрезок видео"), { key: "ArrowRight", repeat: true });
    fireEvent.keyUp(slider("Отрезок видео"), { key: "ArrowRight" });
    expect(videoOf(await nextSave(engine))).toMatchObject({ trimStartMs: 2_100, durationMs: 2_000 });
    fireEvent.keyDown(slider("Отрезок видео"), { key: "ArrowRight", shiftKey: true });
    fireEvent.keyUp(slider("Отрезок видео"), { key: "ArrowRight" });
    expect(videoOf(await nextSave(engine, 1))).toMatchObject({ trimStartMs: 3_100 });
    fireEvent.keyDown(slider("Отрезок видео"), { key: "End" });
    fireEvent.keyUp(slider("Отрезок видео"), { key: "End" });
    // The window's end at the video's end.
    expect(videoOf(await nextSave(engine, 2))).toMatchObject({ trimStartMs: 12_000, durationMs: 2_000 });
    undo();
    undo();
    undo();
    expect(videoOf(await nextSave(engine, 3)).trimStartMs).toBe(1_800);
    redo();
    expect(videoOf(await nextSave(engine, 4)).trimStartMs).toBe(2_100);
  });

  test("the left edge moves the start with the end kept; the right edge moves the end with the start kept", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await selectVideo();
    fireEvent.keyDown(slider("Начало отрезка"), { key: "ArrowLeft" });
    fireEvent.keyUp(slider("Начало отрезка"), { key: "ArrowLeft" });
    expect(videoOf(await nextSave(engine))).toMatchObject({ trimStartMs: 1_700, durationMs: 2_100 });
    fireEvent.keyDown(slider("Конец отрезка"), { key: "Home" });
    fireEvent.keyUp(slider("Конец отрезка"), { key: "Home" });
    // The shortest clip: 0.5 s from the start.
    expect(videoOf(await nextSave(engine, 1))).toMatchObject({ trimStartMs: 1_700, durationMs: 500 });
    expect(within(props()).getByText("0.5 с из 14.0")).toBeDefined();
  });

  test("a drag of an edge is one edit when let go, on the 100 ms grid and within the 15 s; a cancelled drag changes nothing", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await selectVideo();
    layOutStrip();
    // 31 px is 1550 ms: the end goes from 3.8 s to 5.35 s, on the grid 5.4 s.
    drag(slider("Конец отрезка"), 31, 41, "cancel");
    await flush();
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
    expect(slider("Конец отрезка").getAttribute("aria-valuenow")).toBe("3800");
    drag(slider("Конец отрезка"), 31, 42);
    expect(videoOf(await nextSave(engine))).toMatchObject({ trimStartMs: 1_800, durationMs: 3_600 });
    expect(callsOf(engine, "montages.save")).toHaveLength(1);
    // Dragged far right: held to the 15 s (9 s of room were left, the clip now has 7.4 s more).
    drag(slider("Конец отрезка"), 400, 43);
    expect(videoOf(await nextSave(engine, 1))).toMatchObject({ trimStartMs: 1_800, durationMs: 11_000 });
    undo();
    expect(videoOf(await nextSave(engine, 2)).durationMs).toBe(3_600);
  });

  test("the window drags, its length kept; a click on the strip takes it there", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await selectVideo();
    layOutStrip();
    // 20 px is 1 s later.
    drag(slider("Отрезок видео"), 20, 51);
    expect(videoOf(await nextSave(engine))).toMatchObject({ trimStartMs: 2_800, durationMs: 2_000 });
    // A click at 200 px (10 s) centres the window there.
    const strip = props().querySelector(".ed-trim");
    if (strip === null) throw new Error("no trim strip");
    fireEvent.pointerDown(strip, { pointerId: 52, button: 0, clientX: 200, clientY: 10 });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 52, clientX: 200, clientY: 10 }));
    });
    expect(videoOf(await nextSave(engine, 1))).toMatchObject({ trimStartMs: 9_000, durationMs: 2_000 });
  });

  test("the timeline's edge of a video clip stops at the video's end, not at the 15 s", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId, 500, 13_000)));
    await selectVideo();
    const edge = within(timeline()).getByRole("slider", { name: "Длительность кадра 2: правый край" });
    expect(edge.getAttribute("aria-valuemax")).toBe("1000");
    fireEvent.keyDown(edge, { key: "End" });
    fireEvent.keyUp(edge, { key: "End" });
    expect(videoOf(await nextSave(engine)).durationMs).toBe(1_000);
  });
});

describe("fix round 1", () => {
  const undoOff = (): boolean => screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled");
  const standIn = (): string => preview().querySelector(".pv-video-facts")?.textContent ?? "";
  const head = (): HTMLElement => within(timeline()).getByRole("slider", { name: "Плейхед" });
  async function atClipStart(): Promise<void> {
    fireEvent.keyDown(head(), { key: "Home" });
    fireEvent.keyDown(head(), { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(head(), { key: "ArrowRight", shiftKey: true });
    await flush();
  }

  test("L8: while the right edge of «Обрезка» is dragged the preview shows the frame at it; nothing is saved until it is let go", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await selectVideo();
    await atClipStart();
    layOutStrip();
    expect(standIn()).toBe("1080×608 · 0:01.8");
    fireEvent.pointerDown(slider("Конец отрезка"), { pointerId: 61, button: 0, clientX: 100, clientY: 10 });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 61, clientX: 131, clientY: 10, buttons: 1 }));
    });
    // The end at 5.4 s: its last frame, 161, is 0:05.3.
    expect(standIn()).toBe("1080×608 · 0:05.3");
    expect(undoOff()).toBe(true);
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 61, clientX: 131, clientY: 10 }));
    });
    expect(standIn()).toBe("1080×608 · 0:01.8");
    expect(videoOf(await nextSave(engine)).durationMs).toBe(3_600);
  });

  test("L8: with the playhead on another clip, the preview shows the clip being trimmed while it is dragged, and goes back after a cancel", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await selectVideo();
    fireEvent.keyDown(head(), { key: "Home" });
    await flush();
    expect(within(preview()).getAllByRole("button")[0]?.getAttribute("aria-label")).toBe("Кадр 1");
    layOutStrip();
    fireEvent.pointerDown(slider("Отрезок видео"), { pointerId: 62, button: 0, clientX: 100, clientY: 10 });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 62, clientX: 120, clientY: 10, buttons: 1 }));
    });
    // Slid 1 s later: its first frame is 2.8 s into the video.
    expect(within(preview()).getAllByRole("button")[0]?.getAttribute("aria-label")).toBe("Кадр 2: своё видео");
    expect(standIn()).toBe("1080×608 · 0:02.8");
    act(() => {
      window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 62, clientX: 120, clientY: 10 }));
    });
    expect(within(preview()).getAllByRole("button")[0]?.getAttribute("aria-label")).toBe("Кадр 1");
    expect(undoOff()).toBe(true);
  });

  test("L6: the focus hint sits above the layers (a caption over the clip never covers it), for an own video and for a photo", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    const made = await makeDraft(client, MIA.avatarId, []);
    const caption = { layerId: "layer-001", startMs: 0, endMs: 6_000, kind: "text" as const, value: "coffee first", font: "oswald" as const, style: "outline" as const, color: "#ffffff", x: 0.5, y: 0.42, scale: 1 };
    const saved = await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec: { ...made.spec, clips: clipsWith(ownClip(mediaId)), layers: [caption] }, name: null }));
    if (!saved.ok) throw new Error(saved.error.code);
    await openDrafts();
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
    await screen.findByRole("region", { name: "Таймлайн" });
    await flush();
    const above = (): boolean => {
      const layer = preview().querySelector(".pv-layer");
      const pill = preview().querySelector(".pv-face-pill");
      if (layer === null || pill === null) throw new Error("no layer or no hint");
      return (layer.compareDocumentPosition(pill) & Node.DOCUMENT_POSITION_FOLLOWING) !== 0 && pill.closest(".pv-cell") === null;
    };
    await selectVideo();
    await waitFor(() => expect(preview().querySelector(".pv-layer") !== null).toBe(true));
    expect(above()).toBe(true);
    fireEvent.click(within(timeline()).getByRole("button", { name: /^Кадр 1: / }));
    await flush();
    expect(within(preview()).getByText(/тяните/)).toBeDefined();
    expect(above()).toBe(true);
  });

  test("L7: the timeline's left edge of a video clip moves its start in the video with its end kept, as «Обрезка»'s does", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await selectVideo();
    const edge = (): HTMLElement => within(timeline()).getByRole("slider", { name: "Длительность кадра 2: левый край" });
    fireEvent.keyDown(edge(), { key: "ArrowLeft" });
    fireEvent.keyUp(edge(), { key: "ArrowLeft" });
    expect(videoOf(await nextSave(engine))).toMatchObject({ trimStartMs: 1_700, durationMs: 2_100 });
    fireEvent.keyDown(edge(), { key: "Home" });
    fireEvent.keyUp(edge(), { key: "Home" });
    // The shortest: 0.5 s ending where it ended, 3.8 s into the video.
    expect(videoOf(await nextSave(engine, 1))).toMatchObject({ trimStartMs: 3_300, durationMs: 500 });
    // Dragged left 14 px of the 1048 px lanes (about 0.2 s): earlier in the video, the end still at 3.8 s.
    drag(edge(), -14, 71);
    const dragged = videoOf(await nextSave(engine, 2));
    expect(dragged.trimStartMs + dragged.durationMs).toBe(3_800);
    expect(dragged.durationMs).toBe(700);
  });

  test("L9: a window too narrow for both edges is judged on the strip as laid out, not on the artboard's width", async () => {
    // A 0.5 s clip of the 14 s video: 9.7 px of the artboard's 272 px strip, 71 px of a 2000 px one.
    const real = globalThis.ResizeObserver;
    const narrow = (): boolean => props().querySelector(".ed-trim")?.classList.contains("ed-trim-narrow") ?? false;
    try {
      const { client, engine } = await studio();
      const mediaId = storeVideo(engine);
      await openDraft(engine, client, clipsWith(ownClip(mediaId, 500, 1_800)));
      await selectVideo();
      expect(narrow()).toBe(true);
      fireEvent.click(within(timeline()).getByRole("button", { name: /^Кадр 1: / }));
      await flush();
      class Wide {
        constructor(private readonly report: ResizeObserverCallback) {}
        observe(target: Element): void {
          this.report([{ target, contentRect: { width: 2_000 } } as unknown as ResizeObserverEntry], this as unknown as ResizeObserver);
        }
        unobserve(): void {}
        disconnect(): void {}
      }
      globalThis.ResizeObserver = Wide as unknown as typeof ResizeObserver;
      await selectVideo();
      expect(narrow()).toBe(false);
    } finally {
      globalThis.ResizeObserver = real;
    }
  });

  test("L5: a click on the window with a little jitter under the drag threshold changes nothing", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await selectVideo();
    layOutStrip();
    drag(slider("Отрезок видео"), 2, 81);
    await flush();
    expect(undoOff()).toBe(true);
    expect(slider("Отрезок видео").getAttribute("aria-valuenow")).toBe("1800");
  });

  test("L5: letting go of another key (Shift) does not end the held arrow's undo step", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await selectVideo();
    fireEvent.keyDown(slider("Отрезок видео"), { key: "ArrowRight" });
    fireEvent.keyUp(slider("Отрезок видео"), { key: "Shift" });
    fireEvent.keyDown(slider("Отрезок видео"), { key: "ArrowRight", repeat: true });
    fireEvent.keyUp(slider("Отрезок видео"), { key: "ArrowRight" });
    expect(videoOf(await nextSave(engine)).trimStartMs).toBe(2_000);
    undo();
    expect(videoOf(await nextSave(engine, 1)).trimStartMs).toBe(1_800);
    expect(undoOff()).toBe(true);
  });

  test("L5: a crop drag whose clip went meanwhile (another window removed it) writes nothing into the clip that took its place, even of the same video", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    const second: MontageDraft["clips"][number] = { ...videoClip(2, 2_000, 6_000), mediaId };
    await openDraft(engine, client, [photoClip(0, P1, 2_000), ownClip(mediaId), second]);
    const montageId = callsOf(engine, "montages.get").at(-1)?.payload.montageId ?? "";
    await selectVideo();
    const crop = videoClipCrop(SOURCE, null);
    const centred = `${(-crop.x / crop.w) * 100}`;
    const left = (): string => String(Number.parseFloat(preview().querySelector<HTMLElement>(".pv-video-ground")?.style.left ?? ""));
    const cell = within(preview()).getByRole("button", { name: "Кадр 2: своё видео" });
    fireEvent.pointerDown(cell, { pointerId: 91, button: 0, clientX: 100, clientY: 100 });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 91, clientX: 140, clientY: 100, buttons: 1 }));
    });
    // Another window removes the clip being dragged: the second clip of the same video takes its place.
    const spec: MontageDraft = { schemaVersion: 1, avatarId: MIA.avatarId, clips: [photoClip(0, P1, 2_000), second], layers: [], music: null, seed: 1 };
    await asAnotherWindow(() => client.request("montages.save", { montageId, spec, name: null }));
    await waitFor(() => expect(within(timeline()).getAllByRole("button", { name: /^Кадр \d: / })).toHaveLength(2));
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 91, clientX: 140, clientY: 100 }));
    });
    await flush();
    // The clip on screen now is the second one: its crop is where it was, not where the drag would have put the first one's.
    expect(within(preview()).getByRole("button", { name: "Кадр 2: своё видео" })).toBeDefined();
    expect(left()).toBe(String(Number.parseFloat(centred)));
  });

  test("L3: a video shorter than 0.5 s says so, never the contract's «сдвиньте начало фрагмента» it cannot follow", async () => {
    const { client, engine } = await studio();
    engine.seedOwnMedia([{ kind: "video", name: "blink.mov", bytes: 200_000, facts: { width: 1_080, height: 1_920, durationMs: 400, sourceFps: 30 } }]);
    await openDraft(engine, client, clipsWith(ownClip("media-demo-0001", 500, 0)));
    const block = within(timeline()).getByRole("button", { name: s("Кадр 2: видео короче 0.5 с, 0.5 с") });
    expect(within(block).getByText("⚠ видео короче 0.5 с")).toBeDefined();
    await selectVideo();
    expect(within(props()).getByText("Видео короче 0.5 с — в ролик его не поставить")).toBeDefined();
    expect(within(props()).queryByText(MONTAGE_ISSUE_MESSAGES_RU["video-too-short"]) === null).toBe(true);
    expect(within(props()).getByText("ролик 4.5 с из 15 · видео короче 0.5 с")).toBeDefined();
  });
});

describe("an own file deleted while its draft is open (fix round 1, M1)", () => {
  const renderButton = (): HTMLElement => screen.getByRole("button", { name: "Рендер" });
  const isDisabled = (el: HTMLElement): boolean => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";
  const why = (): string => document.querySelector(".ed-render-why")?.textContent ?? "";
  const gets = (engine: MockEngine): number => callsOf(engine, "montages.get").length;

  test("a video clip whose video is deleted after a clean verdict is flagged, and «Рендер» is blocked", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await waitFor(() => expect(isDisabled(renderButton())).toBe(false));
    await asAnotherWindow(() => client.request("media.delete", { mediaId }));
    await waitFor(() => expect(within(timeline()).getByRole("button", { name: s("Кадр 2: файла больше нет, 2.0 с") })).toBeDefined());
    expect(isDisabled(renderButton())).toBe(true);
    expect(why()).toBe("Кадр 2: файла больше нет");
    await selectVideo();
    expect(within(props()).getByText(MONTAGE_ISSUE_MESSAGES_RU["media-unavailable"])).toBeDefined();
  });

  test("an own photo in a cell deleted after a clean verdict blocks «Рендер» with its frame", async () => {
    const { client, engine } = await studio();
    engine.seedOwnMedia([{ kind: "photo", name: "lake.jpg", bytes: 120_000 }]);
    const photo: MontageDraft["clips"][number] = { ...photoClip(1, P1, 2_000), cell: { photo: { source: "own", mediaId: "media-demo-0001" }, focus: { x: 0.5, y: 0.5 } } };
    await openDraft(engine, client, [photoClip(0, P2, 2_000), photo]);
    await waitFor(() => expect(isDisabled(renderButton())).toBe(false));
    await asAnotherWindow(() => client.request("media.delete", { mediaId: "media-demo-0001" }));
    await waitFor(() => expect(why()).toBe("Кадр 2: файла больше нет"));
    expect(isDisabled(renderButton())).toBe(true);
  });

  test("an own sticker deleted after a clean verdict marks its layer and blocks «Рендер»", async () => {
    const { client, engine } = await studio();
    engine.seedOwnMedia([{ kind: "sticker", name: "party.gif", bytes: 48_000 }]);
    const made = await makeDraft(client, MIA.avatarId, []);
    const layers: MontageDraft["layers"] = [{ ...stickerLayer(0, 0, 2_000), sticker: { source: "own", mediaId: "media-demo-0001" } }];
    const saved = await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec: { ...made.spec, clips: [photoClip(0, P1, 2_000), photoClip(1, P2, 2_000)], layers }, name: null }));
    if (!saved.ok) throw new Error(saved.error.code);
    await openDrafts();
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
    await screen.findByRole("region", { name: "Таймлайн" });
    await flush();
    await waitFor(() => expect(isDisabled(renderButton())).toBe(false));
    await asAnotherWindow(() => client.request("media.delete", { mediaId: "media-demo-0001" }));
    await waitFor(() => expect(why()).toBe("Стикер 1: файла больше нет"));
    expect(isDisabled(renderButton())).toBe(true);
    // The layer's block is marked (3d.3b's refusal of a layer, by its id).
    const block = within(timeline()).getByRole("button", { name: /^Стикер 1.*, файла больше нет$/ });
    expect(block.closest(".ed-blk-flagged") !== null).toBe(true);
  });

  test("fix round 2: a file the draft came to name after it was opened (another window placed it) is followed too", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    const made = await makeDraft(client, MIA.avatarId, []);
    const first = await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec: { ...made.spec, clips: [photoClip(0, P1, 2_000), photoClip(1, P2, 2_000)] }, name: null }));
    if (!first.ok) throw new Error(first.error.code);
    await openDrafts();
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
    await screen.findByRole("region", { name: "Таймлайн" });
    await flush();
    // Another window puts the video in.
    await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec: { ...made.spec, clips: clipsWith(ownClip(mediaId)) }, name: null }));
    await waitFor(() => expect(within(timeline()).getByRole("button", { name: s("Кадр 2: видео street-walk.mp4, 2.0 с") })).toBeDefined());
    await waitFor(() => expect(isDisabled(renderButton())).toBe(false));
    const before = gets(engine);
    await asAnotherWindow(() => client.request("media.delete", { mediaId }));
    await waitFor(() => expect(within(timeline()).getByRole("button", { name: s("Кадр 2: файла больше нет, 2.0 с") })).toBeDefined());
    expect(gets(engine)).toBe(before + 1);
  });

  test("fix round 2: a burst of changes to the draft's files reads the verdict once", async () => {
    const { client, engine } = await studio();
    engine.seedOwnMedia([1, 2, 3].map((n) => ({ kind: "video" as const, name: `clip-${n}.mov`, bytes: 4_000_000, facts: { width: 1_080, height: 1_920, durationMs: 6_000, sourceFps: 30 } })));
    const own = (n: number): MontageDraft["clips"][number] => ({ ...videoClip(n, 1_000, 0), mediaId: `media-demo-000${n + 1}` });
    await openDraft(engine, client, [own(0), own(1), own(2), photoClip(3, P1, 2_000)]);
    await waitFor(() => expect(isDisabled(renderButton())).toBe(false));
    const before = gets(engine);
    await asAnotherWindow(() => Promise.all([1, 2, 3].map((n) => client.request("media.delete", { mediaId: `media-demo-000${n}` }))));
    await waitFor(() => expect(why()).toBe("Кадр 1: файла больше нет"));
    await flush();
    expect(gets(engine)).toBe(before + 1);
  });

  test("a change to a file the draft does not name reads nothing again", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    engine.seedOwnMedia([{ kind: "photo", name: "other.jpg", bytes: 120_000 }]);
    await openDraft(engine, client, clipsWith(ownClip(mediaId)));
    await waitFor(() => expect(isDisabled(renderButton())).toBe(false));
    const before = gets(engine);
    await asAnotherWindow(() => client.request("media.delete", { mediaId: "media-demo-0002" }));
    await flush();
    expect(gets(engine)).toBe(before);
    // …and one the draft names does.
    await asAnotherWindow(() => client.request("media.delete", { mediaId }));
    await waitFor(() => expect(gets(engine)).toBe(before + 1));
  });
});

describe("what the render refuses a video clip for", () => {
  test("a clip asking past its video's end: the contract's words in the properties, the block flagged", async () => {
    const { client, engine } = await studio();
    const mediaId = storeVideo(engine);
    await openDraft(engine, client, clipsWith(ownClip(mediaId, 2_000, 13_000)));
    const block = within(timeline()).getByRole("button", { name: s("Кадр 2: видео короче кадра, 2.0 с") });
    expect(within(block).getByText("⚠ видео короче кадра")).toBeDefined();
    expect(block.closest(".ed-clip-flagged") !== null).toBe(true);
    await selectVideo();
    expect(within(props()).getByText(MONTAGE_ISSUE_MESSAGES_RU["video-too-short"])).toBeDefined();
    // Sliding the window back inside the video clears it at once (the window's own guess until the engine judges the edit).
    fireEvent.keyDown(slider("Отрезок видео"), { key: "Home" });
    fireEvent.keyUp(slider("Отрезок видео"), { key: "Home" });
    await flush();
    expect(within(props()).queryByText(MONTAGE_ISSUE_MESSAGES_RU["video-too-short"]) === null).toBe(true);
    expect(within(timeline()).getByRole("button", { name: s("Кадр 2: видео street-walk.mp4, 2.0 с") })).toBeDefined();
  });

  test("a video the library does not hold: the contract's words, the block flagged, the preview says so", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, clipsWith(ownClip("media-00000404")));
    const block = within(timeline()).getByRole("button", { name: s("Кадр 2: файла больше нет, 2.0 с") });
    expect(within(block).getByText("⚠ файла больше нет")).toBeDefined();
    await selectVideo();
    expect(within(props()).getByText(MONTAGE_ISSUE_MESSAGES_RU["media-unavailable"])).toBeDefined();
    expect(within(props()).getByText("Видео нет — обрезать нечего")).toBeDefined();
    expect(within(preview()).getByText("Файла больше нет")).toBeDefined();
    expect(within(props()).getByText("Звук видео не используется — в ролике только музыка")).toBeDefined();
  });
});
