import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { CAPTION_ISSUES_RU, type MontageDraft, type TextLayer } from "../../shared/engine";
import { clipCellRects, FRAME_H, FRAME_W, progressSegments, type Rect, reelsSafeZones, segmentFillWidth, stickerBox } from "../../shared/montage";
import type { MockEngine } from "../engine/mockEngine";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import { callsOf, flush } from "../testing";
import { AUTOSAVE_DEBOUNCE_MS } from "./montage/autosave";
import { type ManualFrames, manualFrames } from "./montage/frames.testkit";
import { dragLayerCentre, resizeFactor } from "./montage/previewDrag";
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
  test("an empty draft says it is empty, with no hints", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { clips: [] });
    expect(within(preview()).getByText("Ролик пока пуст")).toBeDefined();
    expect(within(preview()).queryByRole("group", { name: "Подсказки" }) === null).toBe(true);
  });

  test("the clip under the playhead, its cells where the render puts them; the end shows the last frame", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { clips: [photoClip(0, P1, 2_000), collageClip(1, [P2, null, P3], 3_000, false)] });
    expect(within(preview()).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual(["Кадр 1"]);
    fireEvent.keyDown(within(timeline()).getByRole("slider", { name: "Плейхед" }), { key: "End" });
    const cells = within(preview()).getAllByRole("button");
    expect(cells.map((b) => b.getAttribute("aria-label"))).toEqual(["Кадр 2, ячейка 1", "Кадр 2, ячейка 2: пустая", "Кадр 2, ячейка 3"]);
    expect(cells.map(drawnBox)).toEqual(clipCellRects({ kind: "collage", layout: "collage3" }).map(exact));
  });

  test("a photo shows the render's window of it: the motion moves it from one frame to the next", async () => {
    frames = manualFrames();
    const { client, engine } = await studio();
    await openDraft(engine, client);
    const photo = (): string => (preview().querySelector(".pv-photo") as HTMLElement | null)?.getAttribute("style") ?? "";
    const first = photo();
    fireEvent.click(within(timeline()).getByRole("button", { name: "Воспроизвести" }));
    frames.advance(500);
    expect(photo()).not.toBe(first);
    expect(first).toContain("width:");
  });

  test("«Полоски слайдов»: a bar per clip, filled up to the playhead; «Зоны Reels»: the bottom band and the right strip", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client);
    const bars = [...preview().querySelectorAll<HTMLElement>(".pv-bar")];
    expect(bars.map(drawnBox)).toEqual(progressSegments([P1, P2, P3, P4].map((p, i) => photoClip(i, p, 2_000))).map((s) => exact(s.rect)));
    fireEvent.keyDown(within(timeline()).getByRole("slider", { name: "Плейхед" }), { key: "ArrowRight", shiftKey: true });
    const fills = [...preview().querySelectorAll<HTMLElement>(".pv-bar-fill")].map((f) => f.style.width);
    // 1.0 s in: half of the first clip's bar (the shared fill rounds down to whole pixels), none of the others.
    const segments = progressSegments([P1, P2, P3, P4].map((p, i) => photoClip(i, p, 2_000)));
    expect(fills).toEqual(segments.map((s) => `${(segmentFillWidth(s, 30) / s.rect.w) * 100}%`));
    expect(fills[0]).not.toBe("0%");
    expect([...preview().querySelectorAll<HTMLElement>(".pv-zone")].map(drawnBox)).toEqual(reelsSafeZones().map((z) => exact(z.rect)));
    expect(within(preview()).getByText("подпись и аудио")).toBeDefined();
  });

  test("the hints switch off and back on; they say they are the preview's only", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client);
    const hints = within(preview()).getByRole("group", { name: "Подсказки" });
    expect(within(hints).getByText("только в превью, в видео их нет")).toBeDefined();
    fireEvent.click(within(hints).getByRole("switch", { name: "Зоны Reels" }));
    fireEvent.click(within(hints).getByRole("switch", { name: "Полоски слайдов" }));
    expect(preview().querySelector(".pv-zones") === null && preview().querySelector(".pv-bars") === null).toBe(true);
    expect(within(hints).getByRole("switch", { name: "Зоны Reels" }).getAttribute("aria-checked")).toBe("false");
    fireEvent.click(within(hints).getByRole("switch", { name: "Зоны Reels" }));
    expect(preview().querySelector(".pv-zones") !== null).toBe(true);
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
  test("every caption is asked for up front, before the playhead reaches it", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 0, 1_000), { ...textLayer(1, 6_000, 8_000), value: "later on" }] });
    await flush();
    const asked = callsOf(engine, "montages.textPreview").map((c) => c.payload.layer.layerId);
    expect([...asked].sort()).toEqual(["layer-001", "layer-002"]);
  });

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

  test("an ask another window supersedes is asked again: the panel gets its verdict, never left pending", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 0, 4_000)] });
    await flush();
    fireEvent.click(within(timeline()).getByRole("button", { name: /^Текст 1:/ }));
    await flush();
    const caption = within(props()).getByRole("textbox", { name: "Текст" });
    act(() => engine.holdTextDrawing(true));
    // Another layer's drawing holds the lane; this window's ask for the new caption waits behind it...
    const other = client.request("montages.textPreview", { avatarId: MIA.avatarId, layer: { ...textLayer(5, 0, 1_000), layerId: "layer-other" } });
    await flush();
    fireEvent.change(caption, { target: { value: "утро" } });
    await flush();
    // ...and another window asks for the same layer, which supersedes it.
    const elsewhere = client.request("montages.textPreview", { avatarId: MIA.avatarId, layer: { ...textLayer(0, 0, 4_000), value: "elsewhere" } });
    await flush();
    await act(async () => {
      engine.holdTextDrawing(false);
      engine.releaseTextDrawing();
      await other;
      await elsewhere;
    });
    await waitFor(() => expect(caption.getAttribute("aria-invalid")).toBe("true"));
    expect(within(props()).getByText(CAPTION_ISSUES_RU.charset)).toBeDefined();
    const ours = callsOf(engine, "montages.textPreview").filter((c) => c.payload.layer.layerId === "layer-001" && c.payload.layer.value === "утро");
    expect(ours.length).toBe(2);
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

describe("stickers", () => {
  test("a built-in sticker sits in the engine's box on the set's square picture", async () => {
    const { client, engine } = await studio();
    const layer = heart(0, 0, 4_000, { x: 0.7, y: 0.3, size: 0.25 });
    await openDraft(engine, client, { layers: [layer] });
    expect(layerBox("Стикер 1: Сердце")).toEqual(exact(stickerBox(layer)));
  });

  test("selected inside a Reels zone, its frame turns yellow (a warning only)", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [heart(0, 0, 4_000, { x: 0.92, y: 0.6, size: 0.2 })] });
    fireEvent.pointerDown(inPreview("Стикер 1: Сердце"), { pointerId: 1, button: 0, clientX: 0, clientY: 0 });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1 }));
    });
    expect(inPreview("Стикер 1: Сердце").parentElement?.className).toContain("pv-layer-zone");
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

  test("a cancelled drag (the system took the pointer) changes nothing", async () => {
    const { client, engine } = await studio();
    const layer = heart(0, 0, 4_000, { x: 0.5, y: 0.5, size: 0.2 });
    await openDraft(engine, client, { layers: [layer] });
    drag(inPreview("Стикер 1: Сердце"), 40, 40, 4, "cancel");
    expect(layerBox("Стикер 1: Сердце")).toEqual(exact(stickerBox(layer)));
    await flush();
    expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);
  });

  test("never past the frame: dragged far, the box stops at the edge", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [heart(0, 0, 4_000, { x: 0.5, y: 0.5, size: 0.2 })] });
    drag(inPreview("Стикер 1: Сердце"), -2_000, 0, 5);
    expect(layerBox("Стикер 1: Сердце").x).toBe(0);
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

  test("arrow keys move a focused layer by 10 frame pixels (Shift: 60); a held key is one undo step", async () => {
    const { client, engine } = await studio();
    const layer = heart(0, 0, 4_000, { x: 0.5, y: 0.5, size: 0.2 });
    await openDraft(engine, client, { layers: [layer] });
    const hit = inPreview("Стикер 1: Сердце");
    fireEvent.keyDown(hit, { key: "ArrowRight" });
    fireEvent.keyDown(hit, { key: "ArrowRight", repeat: true });
    fireEvent.keyDown(hit, { key: "ArrowDown", shiftKey: true });
    fireEvent.keyUp(hit, { key: "ArrowDown" });
    const box = stickerBox(layer);
    expect(layerBox("Стикер 1: Сердце")).toEqual(exact({ ...box, x: box.x + 20, y: box.y + 60 }));
    fireEvent.keyDown(hit, { key: "ArrowLeft" });
    fireEvent.keyUp(hit, { key: "ArrowLeft" });
    undo();
    expect(layerBox("Стикер 1: Сердце")).toEqual(exact({ ...box, x: box.x + 20, y: box.y + 60 }));
    undo();
    expect(layerBox("Стикер 1: Сердце")).toEqual(exact(box));
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
    expect(within(cell()).getByText(/тяните/)).toBeDefined();
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

  test("arrow keys move the selected cell's photo, a held key one undo step", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { clips: [collageClip(0, [P1, P2], 4_000, false)] });
    const cell = inPreview("Кадр 1, ячейка 1");
    fireEvent.pointerDown(cell, { pointerId: 12, button: 0, clientX: 0, clientY: 0 });
    fireEvent.keyDown(inPreview("Кадр 1, ячейка 1"), { key: "ArrowDown" });
    fireEvent.keyDown(inPreview("Кадр 1, ячейка 1"), { key: "ArrowDown", repeat: true });
    fireEvent.keyUp(inPreview("Кадр 1, ячейка 1"), { key: "ArrowDown" });
    const saved = await nextSave(engine);
    const first = saved.clips[0];
    expect(first?.kind === "collage" ? (first.cells[0]?.focus?.y ?? 1) : 1).toBeLessThan(0.38);
    undo();
    await flush();
    expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);
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

  test("the playback runs to the end of the montage and stops there", async () => {
    frames = manualFrames();
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openDrafts();
    await screen.findByRole("heading", { level: 3, name: /Mia/ });
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
    await screen.findByRole("region", { name: "Таймлайн" });
    await flush();
    fireEvent.click(within(timeline()).getByRole("button", { name: "Воспроизвести" }));
    frames.advance(5_000);
    expect(clockText()).toBe("00:05.0 / 00:08.0");
    frames.advance(5_000);
    expect(clockText()).toBe("00:08.0 / 00:08.0");
    expect(within(timeline()).getByRole("button", { name: "Воспроизвести" })).toBeDefined();
    expect(frames.pending()).toBe(0);
  });
});
