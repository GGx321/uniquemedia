import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { type MontageDraft, type TextLayer } from "../../shared/engine";
import { clipCellRects, clipMotionPlan, FRAME_H, FRAME_W, type Rect, stickerBox } from "../../shared/montage";
import type { MockEngine } from "../engine/mockEngine";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import { callsOf, flush } from "../testing";
import { AUTOSAVE_DEBOUNCE_MS } from "./montage/autosave";
import { type ManualFrames, manualFrames } from "./montage/frames.testkit";
import { installImageDecoder } from "./montage/imageDecoder.testkit";
import { dragLayerCentre, resizeFactor } from "./montage/previewDrag";
import { cellSourceWindow } from "./montage/previewFrame";
import * as renderBlockModule from "./montage/renderBlock";
import { asAnotherWindow, makeDraft, MIA, openDrafts, paidMusicCalls, studio as openStudio } from "./montage/screenKit";
import { collageClip, photoClip, stickerLayer, textLayer } from "./montage/testkit";
import * as scaleModule from "./montage/timelineScale";

// 3d.4: the editor's live preview (Editor.dc.html's centre). It draws the frame at the playhead from the shared geometry (the clip
// and its cells where the render puts them, the photo moving as the render's motion shows it), the captions as the engine's own
// pictures (asked through the window's one per-layer queue, shared with the panel), the stickers on their loops, «Зоны Reels» and
// «Полоски слайдов». A layer drags and scales, the selected cell's crop drags by its face point; each gesture is one undo step,
// and a cancelled one changes nothing. The playhead lives in a store of its own, so a playback re-renders only what follows it.

const [P1, P2, P3, P4] = [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? "", PHOTO_IDS[2] ?? "", PHOTO_IDS[3] ?? ""];

const opened: MockEngine[] = [];
async function studio(...options: Parameters<typeof openStudio>): ReturnType<typeof openStudio> {
  const harness = await openStudio(...options);
  opened.push(harness.engine);
  return harness;
}

let frames: ManualFrames | null = null;
const restores: (() => void)[] = [];
afterEach(() => {
  frames?.restore();
  frames = null;
  for (const restore of restores.splice(0)) restore();
  // 3d.5's money guard holds here too: nothing in the preview sends a paid music command.
  for (const engine of opened.splice(0)) expect(paidMusicCalls(engine)).toEqual([]);
});

const timeline = (): HTMLElement => screen.getByRole("region", { name: "Таймлайн" });
const preview = (): HTMLElement => screen.getByRole("region", { name: "Превью" });
const props = (): HTMLElement => screen.getByRole("complementary", { name: "Свойства" });
const clockText = (): string => (timeline().querySelector(".ed-tl-clock")?.textContent ?? "").replace(/\s+/g, " ");
const inPreview = (name: string | RegExp): HTMLElement => within(preview()).getByRole("button", { name });
/** The frame's cells (the preview's other buttons are its layers and its play control). */
const cellButtons = (): HTMLElement[] => within(preview()).getAllByRole("button", { name: /^Кадр / });
const undo = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
};

/** The box a preview element is drawn in, in frame pixels (its style is in percent of the 1080 x 1920 frame). */
function drawnBox(node: HTMLElement | null): Rect {
  const style = node?.style;
  const at = (value: string | undefined, of: number): number => Math.round((Number.parseFloat(value ?? "NaN") / 100) * of * 1000) / 1000;
  return { x: at(style?.left, FRAME_W), y: at(style?.top, FRAME_H), w: at(style?.width, FRAME_W), h: at(style?.height, FRAME_H) };
}
const layerBox = (name: string | RegExp): Rect => drawnBox(inPreview(name).parentElement);
const exact = (box: Rect): Rect => ({ x: Math.round(box.x * 1000) / 1000, y: Math.round(box.y * 1000) / 1000, w: Math.round(box.w * 1000) / 1000, h: Math.round(box.h * 1000) / 1000 });

/** The test DOM lays nothing out: the preview takes a pointer pixel as the artboard's (306 px for 1080). */
const FRAME_PX = FRAME_W / 306;

/** A draft of `clips` (four 2 s photo clips by default) with `patch` applied, saved as another window would, then opened. */
async function openDraft(engine: MockEngine, client: Parameters<typeof makeDraft>[0], patch: Partial<MontageDraft> = {}): Promise<void> {
  const made = await makeDraft(client, MIA.avatarId, []);
  const spec: MontageDraft = { ...made.spec, clips: [P1, P2, P3, P4].map((photoId, i) => photoClip(i, photoId, 2_000)), ...patch };
  const saved = await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec, name: null }));
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

/** A pointer drag of `node` by (`dx`, `dy`) screen px; "cancel" ends it as the system taking the pointer. */
function drag(node: Element, dx: number, dy: number, pointerId: number, end: "up" | "cancel" = "up"): void {
  fireEvent.pointerDown(node, { pointerId, button: 0, clientX: 100, clientY: 100 });
  act(() => {
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId, clientX: 100 + dx / 2, clientY: 100 + dy / 2, buttons: 1 }));
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId, clientX: 100 + dx, clientY: 100 + dy, buttons: 1 }));
    window.dispatchEvent(new PointerEvent(end === "up" ? "pointerup" : "pointercancel", { pointerId, clientX: 100 + dx, clientY: 100 + dy }));
  });
}

const heart = (index: number, startMs: number, endMs: number, over: Partial<ReturnType<typeof stickerLayer>> = {}) => ({ ...stickerLayer(index, startMs, endMs), sticker: { source: "builtin" as const, stickerId: "heart-pulse" }, ...over });

/** The engine's answer for `layer`'s look, asked as another window would (the same look draws the same box). */
async function engineBox(client: Parameters<typeof makeDraft>[0], layer: TextLayer): Promise<{ width: number; height: number }> {
  const reply = await asAnotherWindow(() => client.request("montages.textPreview", { avatarId: MIA.avatarId, layer: { ...layer, layerId: "layer-elsewhere" } }));
  if (!reply.ok) throw new Error(reply.error.code);
  return reply.result;
}

describe("the frame at the playhead", () => {

  test("the clip under the playhead, its cells where the render puts them; the end shows the last frame", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { clips: [photoClip(0, P1, 2_000), collageClip(1, [P2, null, P3], 3_000, false)] });
    expect(cellButtons().map((b) => b.getAttribute("aria-label"))).toEqual(["Кадр 1"]);
    fireEvent.keyDown(within(timeline()).getByRole("slider", { name: "Плейхед" }), { key: "End" });
    const cells = cellButtons();
    expect(cells.map((b) => b.getAttribute("aria-label"))).toEqual(["Кадр 2, ячейка 1", "Кадр 2, ячейка 2: пустая", "Кадр 2, ячейка 3"]);
    expect(cells.map(drawnBox)).toEqual(clipCellRects({ kind: "collage", layout: "collage3" }).map(exact));
  });

  test("layers on screen in z-order (the spec's order), only within their time", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [heart(0, 0, 4_000), textLayer(1, 0, 1_000), textLayer(2, 2_000, 3_000)] });
    await flush();
    const names = (): string[] => [...preview().querySelectorAll(".pv-layer-hit")].map((b) => b.getAttribute("aria-label") ?? "");
    expect(names()).toEqual(["Стикер 1: Сердце", "Текст 1: «sunday reset»"]);
    fireEvent.keyDown(within(timeline()).getByRole("slider", { name: "Плейхед" }), { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(within(timeline()).getByRole("slider", { name: "Плейхед" }), { key: "ArrowRight", shiftKey: true });
    await flush();
    expect(names()).toEqual(["Стикер 1: Сердце", "Текст 2: «sunday reset»"]);
  });
});

describe("captions as the engine draws them", () => {

  test("a caption is the engine's picture, in the engine's box: centred where the layer says, kept inside the frame", async () => {
    const { client, engine } = await studio();
    const near = { ...textLayer(0, 0, 4_000), x: 0.01, y: 0.99 };
    await openDraft(engine, client, { layers: [near] });
    await waitFor(() => expect(preview().querySelector(".pv-text") !== null).toBe(true));
    expect(preview().querySelector(".pv-text")?.getAttribute("src")?.startsWith("data:image/png;base64,")).toBe(true);
    const box = await engineBox(client, near);
    expect(layerBox(/^Текст 1/)).toEqual(exact({ x: 0, y: FRAME_H - box.height - ((FRAME_H - box.height) % 2), w: box.width, h: box.height }));
  });

  test("the preview and the panel share ONE ask per look: selecting the text asks nothing more, a new font asks once", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 0, 4_000)] });
    await flush();
    const asks = (): number => callsOf(engine, "montages.textPreview").filter((c) => c.payload.layer.layerId === "layer-001").length;
    expect(asks()).toBe(1);
    fireEvent.click(within(timeline()).getByRole("button", { name: /^Текст 1:/ }));
    await flush();
    expect(within(props()).getByText("Текст · слой 1 из 1")).toBeDefined();
    expect(asks()).toBe(1);
    fireEvent.click(within(props()).getByRole("button", { name: "Caveat" }));
    await flush();
    expect(asks()).toBe(2);
  });

  test("a caption the engine refuses keeps its last good picture, marked", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 0, 4_000)] });
    await flush();
    fireEvent.click(within(timeline()).getByRole("button", { name: /^Текст 1:/ }));
    fireEvent.change(within(props()).getByRole("textbox", { name: "Текст" }), { target: { value: "утро" } });
    await waitFor(() => expect(preview().querySelector(".pv-text-refused") !== null).toBe(true));
    expect(preview().querySelector(".pv-text") !== null).toBe(true);
  });
});

describe("a caption in the Reels zones (AM10: judged on the engine's box)", () => {
  test("the panel warns about a caption in the bottom band, and «Сдвинуть внутрь» moves it out once", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [{ ...textLayer(0, 0, 4_000), y: 0.96 }] });
    await flush();
    fireEvent.click(within(timeline()).getByRole("button", { name: /^Текст 1:/ }));
    await flush();
    expect(within(props()).getByText("Под подписью Reels")).toBeDefined();
    expect(within(props()).getByText("Текст заходит в зону снизу: в ленте его закроют подпись и аудио.")).toBeDefined();
    fireEvent.click(within(props()).getByRole("button", { name: "Сдвинуть внутрь" }));
    expect(within(props()).queryByText("Под подписью Reels") === null).toBe(true);
    const saved = (await nextSave(engine)).layers[0];
    expect(saved?.y ?? 1).toBeLessThan(0.96);
    expect(saved?.x).toBe(0.5);
    expect(callsOf(engine, "montages.save")).toHaveLength(1);
  });

});

// R49's «Послушать» on the music card is gone (the owner's feedback, 2026-10-05): it only played the montage from its start. The music is heard
// from the one playback the main ▶ (and Space) drive, from wherever the playhead rests.
describe("the music plays with the montage (no player of the card's own)", () => {
  test("with the music selected, the main ▶ plays from the playhead, not from the start; the card offers nothing to play", async () => {
    frames = manualFrames();
    const track = { trackId: "track-espresso-01", title: "Espresso", artist: "Sabrina Carpenter", durationMs: 60_000, explicit: false, highlightsMs: [30_000, 12_000], hasCover: false, peaks: Array.from({ length: 1_200 }, () => 500) };
    const { client, engine } = await studio({ music: { tracks: [track], list: { fetchedAt: "2026-10-02T11:02:00.000Z", trackCount: 1, bytesOnDisk: 1_000_000 } } });
    await openDraft(engine, client, { music: { source: "trending", trackId: track.trackId, startMs: 12_000 } });
    fireEvent.keyDown(within(timeline()).getByRole("slider", { name: "Плейхед" }), { key: "ArrowRight", shiftKey: true });
    fireEvent.click(within(timeline()).getByRole("button", { name: /^Музыка:/ }));
    await within(props()).findByRole("slider", { name: "Начало музыки в треке" });
    expect(within(props()).queryByRole("button", { name: /Послушать|Остановить/ }) === null).toBe(true);
    fireEvent.click(within(timeline()).getByRole("button", { name: "Воспроизвести" }));
    expect(clockText()).toBe("00:01.0 / 00:08.0");
    frames.advance(1_000);
    expect(clockText()).toBe("00:02.0 / 00:08.0");
    fireEvent.click(within(timeline()).getByRole("button", { name: "Пауза" }));
    expect(within(timeline()).getByRole("button", { name: "Воспроизвести" })).toBeDefined();
  });
});

describe("stickers", () => {

  test("drawn on a canvas at the frame the LAYER's start and the stored loop pick: from 1.0 s, at 2.5 s, heart-pulse's frame 21", async () => {
    const decoders = installImageDecoder();
    restores.push(() => decoders.restore());
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [heart(0, 1_000, 4_000)] });
    const head = within(timeline()).getByRole("slider", { name: "Плейхед" });
    fireEvent.keyDown(head, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(head, { key: "ArrowRight", shiftKey: true });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(head, { key: "ArrowRight" });
    await waitFor(() => expect(preview().querySelector("canvas") !== null).toBe(true));
    // (75 - 30) mod 24: 2.5 s is frame 75, the layer starts on frame 30, the loop stored with heart-pulse is 24 frames.
    expect(preview().querySelector("canvas")?.getAttribute("data-frame")).toBe("21");
    await waitFor(() => expect(decoders.decoded.at(-1)).toBe(21));
    expect(decoders.inits.map((i) => i.colorSpaceConversion)).toEqual(["none"]);
    // The bytes came from main (stickers.bytes), never from a read of the media scheme.
    expect(callsOf(engine, "stickers.bytes").map((c) => c.payload.stickerId)).toEqual(["heart-pulse"]);
  });

  test("leaving the editor closes every sticker decoder it opened", async () => {
    const decoders = installImageDecoder();
    restores.push(() => decoders.restore());
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [heart(0, 0, 4_000), heart(1, 0, 4_000, { x: 0.3 }), { ...heart(2, 0, 4_000, { x: 0.2 }), sticker: { source: "builtin", stickerId: "star-spin" } }] });
    await waitFor(() => expect(decoders.inits).toHaveLength(2));
    expect(decoders.closed).toBe(0);
    fireEvent.click(screen.getByRole("button", { name: "Черновики" }));
    await screen.findByRole("heading", { level: 1, name: "Монтаж" });
    await flush();
    expect(decoders.closed).toBe(2);
  });
});

describe("dragging and scaling a layer", () => {
  test("a drag moves it once, when let go: one save, one undo step back", async () => {
    const { client, engine } = await studio();
    const layer = heart(0, 0, 4_000, { x: 0.5, y: 0.5, size: 0.2 });
    await openDraft(engine, client, { layers: [layer] });
    const box = stickerBox(layer);
    drag(inPreview("Стикер 1: Сердце"), 30, -20, 3);
    const expected = dragLayerCentre(box, { dx: 30 * FRAME_PX, dy: -20 * FRAME_PX });
    expect(inPreview("Стикер 1: Сердце").getAttribute("aria-pressed")).toBe("true");
    const saved = await nextSave(engine);
    expect(saved.layers[0]).toMatchObject({ x: expected.x, y: expected.y, size: 0.2 });
    expect(callsOf(engine, "montages.save")).toHaveLength(1);
    undo();
    expect(layerBox("Стикер 1: Сердце")).toEqual(exact(box));
  });

  test("a corner scales a sticker about its centre: one undo step", async () => {
    const { client, engine } = await studio();
    const layer = heart(0, 0, 4_000, { x: 0.5, y: 0.5, size: 0.2 });
    await openDraft(engine, client, { layers: [layer] });
    fireEvent.pointerDown(inPreview("Стикер 1: Сердце"), { pointerId: 6, button: 0, clientX: 0, clientY: 0 });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 6 }));
    });
    const corner = preview().querySelector(".pv-corner-br");
    if (corner === null) throw new Error("no corner handle on the selected sticker");
    // The test DOM puts the frame at (0, 0): the centre is the box's middle in pointer pixels.
    const centre = { x: 540 / FRAME_PX, y: 960 / FRAME_PX };
    const from = { x: centre.x + 20, y: centre.y + 20 };
    const to = { x: centre.x + 30, y: centre.y + 30 };
    fireEvent.pointerDown(corner, { pointerId: 7, button: 0, clientX: from.x, clientY: from.y });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: to.x, clientY: to.y, buttons: 1 }));
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, clientX: to.x, clientY: to.y }));
    });
    const size = Math.round(0.2 * resizeFactor(centre, from, to) * 100) / 100;
    expect((await nextSave(engine)).layers[0]).toMatchObject({ size, x: 0.5, y: 0.5 });
    undo();
    expect(layerBox("Стикер 1: Сердце")).toEqual(exact(stickerBox(layer)));
  });

  test("a text's corner scales its picture while dragged; only the release asks the engine, once, for the new size", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [{ ...textLayer(0, 0, 4_000), y: 0.5 }] });
    await waitFor(() => expect(preview().querySelector(".pv-text") !== null).toBe(true));
    fireEvent.click(inPreview(/^Текст 1/));
    const corner = preview().querySelector(".pv-corner-br");
    if (corner === null) throw new Error("no corner handle");
    const asks = (): number => callsOf(engine, "montages.textPreview").filter((c) => c.payload.layer.layerId === "layer-001").length;
    const before = layerBox(/^Текст 1/);
    const centre = { x: 540 / FRAME_PX, y: 960 / FRAME_PX };
    fireEvent.pointerDown(corner, { pointerId: 8, button: 0, clientX: centre.x + 40, clientY: centre.y });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 8, clientX: centre.x + 60, clientY: centre.y, buttons: 1 }));
    });
    expect(layerBox(/^Текст 1/).w).toBeGreaterThan(before.w);
    expect(asks()).toBe(1);
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 8, clientX: centre.x + 60, clientY: centre.y }));
    });
    await flush();
    expect(asks()).toBe(2);
    expect(callsOf(engine, "montages.textPreview").at(-1)?.payload.layer.scale).toBe(1.5);
  });

  test("Escape clears the selection; Delete removes the selected layer", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [heart(0, 0, 4_000)] });
    const hit = (): HTMLElement => inPreview("Стикер 1: Сердце");
    fireEvent.click(hit());
    fireEvent.pointerDown(hit(), { pointerId: 9, button: 0, clientX: 0, clientY: 0 });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 9 }));
    });
    expect(hit().getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(hit(), { key: "Escape" });
    expect(hit().getAttribute("aria-pressed")).toBe("false");
    fireEvent.keyDown(hit(), { key: "Delete" });
    fireEvent.keyDown(hit(), { key: "Delete" });
    expect(within(preview()).queryByRole("button", { name: "Стикер 1: Сердце" }) === null).toBe(true);
  });
});

describe("a cell's crop by its face point", () => {
  test("the first press selects the cell; a drag of the selected cell moves its photo and saves the focus once", async () => {
    const { client, engine } = await studio();
    // A collage cell is far wider than a 9:16 photo, so its crop has room up and down.
    await openDraft(engine, client, { clips: [collageClip(0, [P1, P2], 4_000, false)] });
    const cell = (): HTMLElement => inPreview("Кадр 1, ячейка 1");
    drag(cell(), 0, 30, 10);
    expect(cell().getAttribute("aria-pressed")).toBe("true");
    expect(within(props()).getByText("Кадр 1 из 1")).toBeDefined();
    await flush();
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
    expect(within(preview()).getByText(/тяните/)).toBeDefined();
    drag(cell(), 0, 30, 11);
    const saved = await nextSave(engine);
    const first = saved.clips[0];
    const focus = first?.kind === "collage" ? first.cells[0]?.focus : null;
    // The photo followed the pointer down, so the face point moved up; the untouched axis kept the fallback's 0.5.
    expect(focus?.x).toBe(0.5);
    expect(focus?.y ?? 1).toBeLessThan(0.38);
    expect(callsOf(engine, "montages.save")).toHaveLength(1);
    undo();
    await flush();
    const back = (await nextSave(engine, 1)).clips[0];
    expect(back?.kind === "collage" ? back.cells[0]?.focus : "?").toBe(null);
  });

  test("a bin photo dropped on an empty cell fills it", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { clips: [collageClip(0, [P1, null], 4_000, false)] });
    const bin = screen.getByRole("list", { name: "Фото аватара" });
    const tile = within(bin).getAllByRole("listitem").find((item) => within(item).queryByText("1") === null && within(item).queryAllByRole("button").length > 0);
    const pick = tile === undefined ? null : within(tile).getAllByRole("button")[0];
    if (pick === undefined || pick === null) throw new Error("no free photo in the bin");
    fireEvent.dragStart(pick);
    const empty = inPreview("Кадр 1, ячейка 2: пустая");
    fireEvent.dragOver(empty);
    expect(empty.className).toContain("pv-cell-drop");
    fireEvent.drop(empty);
    await flush();
    expect(inPreview("Кадр 1, ячейка 2").getAttribute("aria-label")).toBe("Кадр 1, ячейка 2");
    const saved = await nextSave(engine);
    const clip = saved.clips[0];
    expect(clip?.kind === "collage" ? clip.cells[1]?.photo?.source : null).toBe("scene");
  });

});

describe("playback", () => {
  test("a playback re-renders neither the editor nor the timeline's tracks: the clock and the playhead follow it on their own", async () => {
    frames = manualFrames();
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1, P2]);
    await openDrafts();
    await screen.findByRole("heading", { level: 3, name: /Mia/ });
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
    await screen.findByRole("region", { name: "Таймлайн" });
    await flush();
    // `renderBlock` runs once per render of the editor, `rulerMarks` once per render of the timeline.
    const editorRenders = spyOn(renderBlockModule, "renderBlock");
    const timelineRenders = spyOn(scaleModule, "rulerMarks");
    restores.push(() => editorRenders.mockRestore(), () => timelineRenders.mockRestore());

    fireEvent.click(within(timeline()).getByRole("button", { name: "Воспроизвести" }));
    for (let i = 0; i < 30; i++) frames.advance(34);
    expect(clockText()).toBe("00:01.0 / 00:08.0");
    expect(within(timeline()).getByRole("slider", { name: "Плейхед" }).getAttribute("aria-valuenow")).toBe("1000");
    expect(editorRenders).toHaveBeenCalledTimes(0);
    expect(timelineRenders).toHaveBeenCalledTimes(0);

    // A pause rests the playhead: the toolbar and the panels now act at 1.0 s, still without the editor re-rendering.
    fireEvent.click(within(timeline()).getByRole("button", { name: "Пауза" }));
    expect(clockText()).toBe("00:01.0 / 00:08.0");
    expect(timelineRenders.mock.calls.length).toBeGreaterThan(0);
    expect(editorRenders).toHaveBeenCalledTimes(0);
  });

});

// The owner's feedback (2026-10-05): the preview had no play control of its own. A ▶ sits in the middle of the frame while the montage is
// paused; while it plays, a ❚❚ shows for a moment after the start and whenever the pointer moves over the frame, and is gone (taking no click)
// otherwise. It drives the one playback the timeline's button drives, and it lies UNDER the layers: a caption or a sticker over the middle of
// the frame keeps its press.
describe("the play control on the preview", () => {
  const control = (): HTMLElement => {
    const node = preview().querySelector(".pv-play");
    if (!(node instanceof HTMLElement)) throw new Error("no play control on the preview");
    return node;
  };
  const shown = (): string | null => control().getAttribute("data-shown");
  const stage = (): HTMLElement => {
    const node = preview().querySelector(".pv-stage");
    if (!(node instanceof HTMLElement)) throw new Error("no stage");
    return node;
  };

  test("paused, a ▶ in the frame plays the montage the timeline plays; then it is ❚❚, and stops it", async () => {
    frames = manualFrames();
    const { client, engine } = await studio();
    await openDraft(engine, client);
    fireEvent.pointerEnter(stage());
    expect([control().getAttribute("aria-label"), shown()]).toEqual(["Воспроизвести", "true"]);
    fireEvent.click(control());
    expect(within(timeline()).getByRole("button", { name: "Пауза" })).toBeDefined();
    frames.advance(1_000);
    expect(clockText()).toBe("00:01.0 / 00:08.0");
    expect(control().getAttribute("aria-label")).toBe("Пауза");
    fireEvent.click(control());
    expect(within(timeline()).getByRole("button", { name: "Воспроизвести" })).toBeDefined();
    expect([control().getAttribute("aria-label"), shown()]).toEqual(["Воспроизвести", "true"]);
    frames.advance(1_000);
    expect(clockText()).toBe("00:01.0 / 00:08.0");
  });

  test("one playback: started by the timeline's button, it is stopped by the preview's, and the other way round", async () => {
    frames = manualFrames();
    const { client, engine } = await studio();
    await openDraft(engine, client);
    fireEvent.click(within(timeline()).getByRole("button", { name: "Воспроизвести" }));
    expect(control().getAttribute("aria-label")).toBe("Пауза");
    frames.advance(500);
    fireEvent.click(control());
    expect(within(timeline()).getByRole("button", { name: "Воспроизвести" })).toBeDefined();
    expect(clockText()).toBe("00:00.5 / 00:08.0");
    fireEvent.click(control());
    fireEvent.click(within(timeline()).getByRole("button", { name: "Пауза" }));
    expect(control().getAttribute("aria-label")).toBe("Воспроизвести");
  });

});

// 3f.5: an OWN sticker in the preview. The layer's record (canvas, loop, delays) comes from `media.list`; its frames are decoded from the bytes main
// hands over by `media.stickerBytes` (never a read of the media scheme, never the built-in command), and the frame on screen is picked by the 30 fps
// tick through the record's own per-frame delays, as the render's loop does.
describe("3-H1: an own photo in a cell is the render's crop of the real photo", () => {
  /** The library's own photo, as the mock seeds one: 1080 x 1440 (landscape-ish against a 9:16 cell: the crop moves left and right). */
  const OWN = "media-demo-0001";
  const OWN_SIZE = { w: 1080, h: 1440 };
  const ownPhotoClip = (focus: { x: number; y: number } | null = null) => ({ ...photoClip(0, P1, 2_000), cell: { photo: { source: "own" as const, mediaId: OWN }, focus } });
  const seedOwnPhoto = (engine: MockEngine): void => engine.seedOwnMedia([{ kind: "photo", name: "croissant.jpg", bytes: 900_000, createdAt: "2026-10-01T10:00:00.000Z" }]);
  /** The picture's box as drawn (left, top, width, height in percent of the cell), and the same for a window of the photo. */
  const pictureBox = (node: Element | null): number[] => {
    const style = node instanceof HTMLElement ? node.style : null;
    return [style?.left, style?.top, style?.width, style?.height].map((v) => Number.parseFloat(v ?? "NaN"));
  };
  const windowBox = (window: Rect, source: { w: number; h: number }): number[] => [(-window.x / window.w) * 100, (-window.y / window.h) * 100, (source.w / window.w) * 100, (source.h / window.h) * 100];

  test("drawn at the window the render cuts on this frame, from the size its record gives (not a stand-in)", async () => {
    const { client, engine } = await studio();
    seedOwnPhoto(engine);
    const focus = { x: 0.7, y: 0.4 };
    await openDraft(engine, client, { clips: [ownPhotoClip(focus), photoClip(1, P2, 2_000)] });
    const cell = inPreview("Кадр 1: своё фото");
    await waitFor(() => expect(cell.querySelector(".pv-photo") !== null).toBe(true));
    const listed = await asAnotherWindow(() => client.request("montages.list", {}));
    const spec = listed.ok ? listed.result.items[0]?.montage.spec : undefined;
    const clip = spec?.clips[0];
    if (spec === undefined || clip === undefined || clip.kind === "video") throw new Error("setup");
    const window = cellSourceWindow({ w: FRAME_W, h: FRAME_H }, OWN_SIZE, focus, clipMotionPlan(spec.seed, clip), 0, 60);
    const drawn = pictureBox(cell.querySelector(".pv-photo"));
    const expected = windowBox(window, OWN_SIZE);
    for (const [i, value] of drawn.entries()) expect(value).toBeCloseTo(expected[i] ?? Number.NaN, 6);
    expect(cell.querySelector(".pv-own") === null).toBe(true);
  });

  test("the selected own photo's crop follows the arrows and a drag: the cell's focus (what the render reads) is saved, one undo step each", async () => {
    const { client, engine } = await studio();
    seedOwnPhoto(engine);
    await openDraft(engine, client, { clips: [ownPhotoClip(), photoClip(1, P2, 2_000)] });
    const cell = (): HTMLElement => inPreview("Кадр 1: своё фото");
    await waitFor(() => expect(cell().querySelector(".pv-photo") !== null).toBe(true));
    fireEvent.pointerDown(cell(), { pointerId: 31, button: 0, clientX: 0, clientY: 0 });
    expect(cell().getAttribute("aria-pressed")).toBe("true");
    expect(cell().getAttribute("aria-keyshortcuts")).toContain("ArrowLeft");
    expect(within(preview()).getByText(/тяните/)).toBeDefined();
    fireEvent.keyDown(cell(), { key: "ArrowRight" });
    fireEvent.keyUp(cell(), { key: "ArrowRight" });
    const saved = (await nextSave(engine)).clips[0];
    // The photo followed the arrow to the right, so the point it centres on moved left; the untouched axis kept the fallback's.
    const moved = saved?.kind === "photo" ? saved.cell : null;
    expect(moved?.photo).toEqual({ source: "own", mediaId: OWN });
    expect(moved?.focus?.x ?? 1).toBeLessThan(0.5);
    expect(moved?.focus?.y).toBe(0.38);

    drag(cell(), -30, 0, 32);
    const dragged = (await nextSave(engine, 1)).clips[0];
    expect(dragged?.kind === "photo" ? (dragged.cell.focus?.x ?? 0) : 0).toBeGreaterThan(moved?.focus?.x ?? 1);
    undo();
    undo();
    await flush();
    expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);
  });
});

describe("own stickers", () => {
  const ownLayer = (index: number, mediaId: string, over: Partial<ReturnType<typeof stickerLayer>> = {}) => ({ ...stickerLayer(index, 0, 4_000), sticker: { source: "own" as const, mediaId }, ...over });

  /** Stores an own sticker the mock's way (a scripted file picked in the dialog), to the end of its job; its media id. */
  async function storeSticker(harness: Awaited<ReturnType<typeof studio>>, facts: { width: number; height: number; loopFrames: number; delayFrames: number[] }): Promise<string> {
    const { engine, client, scheduler } = harness;
    engine.pickMediaNext([{ name: "party.gif", accept: { kind: "sticker", bytes: 100, facts } }]);
    await asAnotherWindow(() => client.request("media.pickImport", { kind: "sticker" }));
    act(() => scheduler.runAll());
    await flush();
    const listed = await client.request("media.list", { kind: "sticker" });
    const media = listed.ok ? listed.result.media[0] : undefined;
    if (media === undefined) throw new Error("the sticker was not stored");
    return media.mediaId;
  }

  test("is drawn on a canvas of its own size at the frame its DELAYS put at this tick; the bytes come from media.stickerBytes and never from stickers.bytes", async () => {
    const decoders = installImageDecoder();
    restores.push(() => decoders.restore());
    const harness = await studio();
    const mediaId = await storeSticker(harness, { width: 200, height: 100, loopFrames: 6, delayFrames: [2, 4] });
    await openDraft(harness.engine, harness.client, { layers: [ownLayer(0, mediaId)] });
    const head = within(timeline()).getByRole("slider", { name: "Плейхед" });
    // One arrow is 0.1 s: tick 3.
    fireEvent.keyDown(head, { key: "ArrowRight" });
    await waitFor(() => expect(preview().querySelector("canvas") !== null).toBe(true));
    const canvas = preview().querySelector("canvas");
    // Tick 3 on delays [2, 4]: the second picture (frame 1; the first lasts ticks 0 and 1), whatever the decoder says about its own durations.
    expect(canvas?.getAttribute("data-frame")).toBe("1");
    expect([canvas?.getAttribute("width"), canvas?.getAttribute("height")]).toEqual(["200", "100"]);
    await waitFor(() => expect(decoders.decoded.at(-1)).toBe(1));
    expect(callsOf(harness.engine, "media.stickerBytes").map((c) => c.payload.mediaId)).toEqual([mediaId]);
    expect(callsOf(harness.engine, "stickers.bytes")).toEqual([]);
    expect(decoders.inits.map((i) => i.colorSpaceConversion)).toEqual(["none"]);
  });

  test("a sticker deleted while the editor is open loses its picture (media.changed)", async () => {
    const decoders = installImageDecoder();
    restores.push(() => decoders.restore());
    const harness = await studio();
    const mediaId = await storeSticker(harness, { width: 200, height: 100, loopFrames: 6, delayFrames: [3, 3] });
    await openDraft(harness.engine, harness.client, { layers: [ownLayer(0, mediaId)] });
    await waitFor(() => expect(preview().querySelector("canvas") !== null).toBe(true));

    await asAnotherWindow(() => harness.client.request("media.delete", { mediaId }));

    await waitFor(() => expect(preview().querySelector("canvas") === null).toBe(true));
    expect(decoders.closed).toBe(1);
  });
});
