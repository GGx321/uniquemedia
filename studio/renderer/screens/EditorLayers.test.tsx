import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { MontageDraft } from "../../shared/engine";
import type { MockEngine } from "../engine/mockEngine";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import type { MockTrackSeed } from "../engine/mockMusicStore";
import { callsOf, flush } from "../testing";
import { AUTOSAVE_DEBOUNCE_MS } from "./montage/autosave";
import { asAnotherWindow, makeDraft, MIA, openDrafts, studio } from "./montage/screenKit";
import { photoClip, stickerLayer, textLayer } from "./montage/testkit";

// 3d.3b: the timeline's text and sticker tracks and the music track in the editor (Editor.dc.html, EditorText, EditorGif,
// EditorMusic; the components sheet's layer blocks, handles, caps and the music block): adding at the playhead, moving,
// trimming, the z-order, the caps with their reasons, and the music's waveform, highlights and start. Every edit goes
// through the session: one undo step per gesture, saved like any other edit.

const [P1, P2, P3, P4] = [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? "", PHOTO_IDS[2] ?? "", PHOTO_IDS[3] ?? ""];

/** A stored track of the mock's store: 60 s, highlights at 12 and 30 s (and the likely 1500 default). */
const TRACK: MockTrackSeed = {
  trackId: "track-espresso-01",
  title: "Espresso",
  artist: "Sabrina Carpenter",
  durationMs: 60_000,
  explicit: false,
  highlightsMs: [30_000, 12_000, 1_500],
  hasCover: true,
  peaks: Array.from({ length: 1_200 }, (_, step) => (step * 37) % 1_000),
};

const timeline = (): HTMLElement => screen.getByRole("region", { name: "Таймлайн" });
const props = (): HTMLElement => screen.getByRole("complementary", { name: "Свойства" });
const texts = (): HTMLElement => within(timeline()).getByRole("group", { name: "Тексты" });
const stickers = (): HTMLElement => within(timeline()).getByRole("group", { name: "Стикеры" });
/** Labels as read, the no-break space before «с» read as a space. */
const plain = (text: string | null | undefined): string => (text ?? "").replace(/ /g, " ");
const blockNames = (group: HTMLElement): string[] => within(group).queryAllByRole("button").map((b) => plain(b.getAttribute("aria-label")));
const block = (name: RegExp): HTMLElement => within(timeline()).getByRole("button", { name });
const undo = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
};
const clockText = (): string => plain(timeline().querySelector(".ed-tl-clock")?.textContent).replace(/\s+/g, " ");

/** A draft of four 2 s photo clips (8.0 s) with `patch` applied, saved as another window would, then opened. */
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
  // The draft's own save (made as another window) is not the test's.
  for (let i = engine.calls.length - 1; i >= 0; i--) if (engine.calls[i]?.type === "montages.save") engine.calls.splice(i, 1);
}

/** The draft as the engine last saved it, after the next save lands. */
async function nextSave(engine: MockEngine): Promise<MontageDraft> {
  await waitFor(() => expect(callsOf(engine, "montages.save").length).toBeGreaterThan(0), { timeout: AUTOSAVE_DEBOUNCE_MS * 4 });
  const last = callsOf(engine, "montages.save").at(-1);
  if (last === undefined) throw new Error("no save");
  return last.payload.spec;
}

/** A pointer drag of `node` by `dx` px; `end` "cancel" ends it as the system taking the pointer. */
function drag(node: HTMLElement, dx: number, pointerId: number, end: "up" | "cancel" = "up"): void {
  fireEvent.pointerDown(node, { pointerId, button: 0, clientX: 500 });
  act(() => {
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId, clientX: 500 + dx / 2 }));
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId, clientX: 500 + dx }));
    window.dispatchEvent(new PointerEvent(end === "up" ? "pointerup" : "pointercancel", { pointerId, clientX: 500 + dx }));
  });
}

// Without layout the lanes measure 1048 px for 15 s: 70 px is about 1 s.
const ONE_SECOND_PX = 70;

describe("adding a text or a sticker at the playhead (the track headers' «+», AM7)", () => {
  test("«Добавить текст» puts the first preset at the playhead for 3 s, selected; one undo takes it away", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client);
    fireEvent.keyDown(within(timeline()).getByRole("slider", { name: "Плейхед" }), { key: "ArrowRight", shiftKey: true });
    fireEvent.click(within(timeline()).getByRole("button", { name: "Добавить текст" }));
    expect(blockNames(texts())).toEqual(["Текст 1: «your text», 1.0–4.0 с"]);
    expect(block(/^Текст 1:/).getAttribute("aria-pressed")).toBe("true");
    expect(within(props()).getByText("Текст · слой 1 из 1")).toBeDefined();
    expect(timeline().querySelector(".ed-th-text .mono")?.textContent).toBe("1");
    const saved = await nextSave(engine);
    expect(saved.layers).toEqual([expect.objectContaining({ kind: "text", startMs: 1_000, endMs: 4_000, value: "your text", font: "manrope", style: "plaque" })]);
    undo();
    expect(blockNames(texts())).toEqual([]);
  });

  test("with the playhead at the end there is no room: «+» is off and says why", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client);
    fireEvent.keyDown(within(timeline()).getByRole("slider", { name: "Плейхед" }), { key: "End" });
    const add = within(timeline()).getByRole("button", { name: "Добавить текст: нет места" });
    expect(add.hasAttribute("disabled")).toBe(true);
    expect(plain(add.getAttribute("title"))).toBe("До конца ролика меньше 0.3 с — поставьте плейхед раньше");
    expect(within(timeline()).getByRole("button", { name: "Добавить стикер: нет места" }).hasAttribute("disabled")).toBe(true);
  });

  test("ten texts: the count turns amber, «+» is off with the reason; stickers are still free", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: Array.from({ length: 10 }, (_, i) => textLayer(i, 0, 1_000)) });
    expect(timeline().querySelector(".ed-th-text .ed-th-full")?.textContent).toBe("10");
    const add = within(timeline()).getByRole("button", { name: "Добавить текст: не больше 10" });
    expect(add.hasAttribute("disabled")).toBe(true);
    expect(add.getAttribute("title")).toBe("Не больше 10 текстов в одном видео");
    expect(within(timeline()).getByRole("button", { name: "Добавить стикер" }).hasAttribute("disabled")).toBe(false);
    // Ten texts of the same second need ten rows: packing only, the header grows with them (10 × 26 px and 9 gaps of 4).
    expect(texts().querySelectorAll(".trk").length).toBe(10);
    const head = timeline().querySelector(".ed-th-text");
    expect(head instanceof HTMLElement && head.style.height).toBe("296px");
  });

  test("«Добавить стикер» opens the built-in set; a pick puts it at the playhead, its picture and loop on the block", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client);
    fireEvent.click(within(timeline()).getByRole("button", { name: "Добавить стикер" }));
    const menu = within(timeline()).getByRole("menu", { name: "Стикер в плейхед" });
    expect(within(menu).getAllByRole("menuitem")).toHaveLength(10);
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Сердце" }));
    expect(within(timeline()).queryAllByRole("menu").length).toBe(0);
    expect(blockNames(stickers())).toEqual(["Стикер 1: Сердце, 0.0–3.0 с, петля 0.8 с"]);
    expect(block(/^Стикер 1:/).querySelector("img")?.getAttribute("src")?.startsWith("data:image/svg+xml,")).toBe(true);
    expect(within(props()).getByText("Стикер 1 из 1")).toBeDefined();
    const saved = await nextSave(engine);
    expect(saved.layers).toEqual([expect.objectContaining({ kind: "sticker", sticker: { source: "builtin", stickerId: "heart-pulse" }, startMs: 0, endMs: 3_000 })]);
  });

  test("Escape closes the sticker menu and gives the focus back to «+»; the selection stays", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 0, 1_000)] });
    fireEvent.click(block(/^Текст 1:/));
    const add = within(timeline()).getByRole("button", { name: "Добавить стикер" });
    fireEvent.click(add);
    const first = within(timeline()).getAllByRole("menuitem")[0];
    if (first === undefined) throw new Error("no sticker");
    expect(document.activeElement === first).toBe(true);
    fireEvent.keyDown(first, { key: "Escape" });
    expect(within(timeline()).queryAllByRole("menu").length).toBe(0);
    expect(document.activeElement === add).toBe(true);
    expect(block(/^Текст 1:/).getAttribute("aria-pressed")).toBe("true");
  });
});

describe("moving and trimming a layer (100 ms steps, one undo step per gesture)", () => {
  test("a drag moves the block, shows where it lands, and is one edit when let go", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 300, 4_400)] });
    const target = block(/^Текст 1:/);
    fireEvent.pointerDown(target, { pointerId: 3, button: 0, clientX: 500 });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 3, clientX: 500 + ONE_SECOND_PX }));
    });
    expect(plain(timeline().querySelector(".ed-blk-range")?.textContent)).toBe("1.3 → 5.4 с");
    // Nothing is saved or undoable before the block is let go.
    expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 3, clientX: 500 + ONE_SECOND_PX }));
    });
    expect(blockNames(texts())).toEqual(["Текст 1: «sunday reset», 1.3–5.4 с"]);
    expect(block(/^Текст 1:/).getAttribute("aria-pressed")).toBe("true");
    const saved = await nextSave(engine);
    expect(saved.layers[0]).toMatchObject({ startMs: 1_300, endMs: 5_400 });
    undo();
    expect(blockNames(texts())).toEqual(["Текст 1: «sunday reset», 0.3–4.4 с"]);
  });

  test("a drag's edges stick to a clip boundary; the block never goes past the montage's end", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 300, 4_400)] });
    // 123 px right: the start would be 2.06 s (2.1 s on the grid); 60 ms from the 2.0 s clip boundary, it sticks to it.
    drag(block(/^Текст 1:/), 123, 4);
    expect(blockNames(texts())).toEqual(["Текст 1: «sunday reset», 2.0–6.1 с"]);
    drag(block(/^Текст 1:/), 10 * ONE_SECOND_PX, 5);
    expect(blockNames(texts())).toEqual(["Текст 1: «sunday reset», 3.9–8.0 с"]);
  });

  test("a drag the system cancels moves nothing and leaves no undo step", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 300, 4_400)] });
    drag(block(/^Текст 1:/), ONE_SECOND_PX, 6, "cancel");
    await flush();
    expect(blockNames(texts())).toEqual(["Текст 1: «sunday reset», 0.3–4.4 с"]);
    expect(timeline().querySelectorAll(".ed-blk-range").length).toBe(0);
    expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
  });

  test("a selected layer has two labelled handles; the keys trim it within 0.3 s and the montage", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 300, 4_400)] });
    fireEvent.click(block(/^Текст 1:/));
    const start = within(timeline()).getByRole("slider", { name: "Текст 1: начало" });
    const end = within(timeline()).getByRole("slider", { name: "Текст 1: конец" });
    expect([start.getAttribute("aria-valuemin"), start.getAttribute("aria-valuemax"), start.getAttribute("aria-valuenow")]).toEqual(["0", "4100", "300"]);
    expect([end.getAttribute("aria-valuemin"), end.getAttribute("aria-valuemax"), end.getAttribute("aria-valuenow")]).toEqual(["600", "8000", "4400"]);
    fireEvent.keyDown(end, { key: "ArrowRight" });
    fireEvent.keyUp(end, { key: "ArrowRight" });
    expect(end.getAttribute("aria-valuenow")).toBe("4500");
    fireEvent.keyDown(start, { key: "End" });
    fireEvent.keyUp(start, { key: "End" });
    expect(blockNames(texts())).toEqual(["Текст 1: «sunday reset», 4.2–4.5 с"]);
    fireEvent.keyDown(within(timeline()).getByRole("slider", { name: "Текст 1: конец" }), { key: "End" });
    const saved = await nextSave(engine);
    expect(saved.layers[0]).toMatchObject({ startMs: 4_200, endMs: 8_000 });
  });

  test("a held key on a handle is one undo step", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 300, 4_400)] });
    fireEvent.click(block(/^Текст 1:/));
    const end = within(timeline()).getByRole("slider", { name: "Текст 1: конец" });
    for (let i = 0; i < 5; i++) fireEvent.keyDown(end, { key: "ArrowRight", repeat: i > 0 });
    fireEvent.keyUp(end, { key: "ArrowRight" });
    expect(blockNames(texts())).toEqual(["Текст 1: «sunday reset», 0.3–4.9 с"]);
    undo();
    expect(blockNames(texts())).toEqual(["Текст 1: «sunday reset», 0.3–4.4 с"]);
  });

  test("a pointer trim of a handle is drawn as it goes and is one edit when let go", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 300, 4_400)] });
    fireEvent.click(block(/^Текст 1:/));
    drag(within(timeline()).getByRole("slider", { name: "Текст 1: начало" }), -ONE_SECOND_PX, 7);
    expect(blockNames(texts())).toEqual(["Текст 1: «sunday reset», 0.0–4.4 с"]);
    undo();
    expect(blockNames(texts())).toEqual(["Текст 1: «sunday reset», 0.3–4.4 с"]);
  });

  test("a trim the system cancels changes nothing", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 300, 4_400)] });
    fireEvent.click(block(/^Текст 1:/));
    drag(within(timeline()).getByRole("slider", { name: "Текст 1: конец" }), ONE_SECOND_PX, 12, "cancel");
    await flush();
    expect(blockNames(texts())).toEqual(["Текст 1: «sunday reset», 0.3–4.4 с"]);
    expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);
  });

  test("⌥→ moves a focused block by 0.1 s (⇧: 1 s); a held key is one undo step; it stops at the montage's end", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [stickerLayer(0, 1_000, 2_000)] });
    const target = block(/^Стикер 1:/);
    target.focus();
    fireEvent.keyDown(target, { key: "ArrowRight", altKey: true });
    fireEvent.keyDown(target, { key: "ArrowRight", altKey: true, shiftKey: true, repeat: true });
    fireEvent.keyUp(target, { key: "ArrowRight" });
    expect(blockNames(stickers())[0]).toStartWith("Стикер 1: стикер недоступен, 2.1–3.1 с");
    // The playhead did not move: ⌥ keys are the block's.
    expect(clockText()).toBe("00:00.0 / 00:08.0");
    for (let i = 0; i < 12; i++) fireEvent.keyDown(target, { key: "ArrowRight", altKey: true, shiftKey: true, repeat: i > 0 });
    fireEvent.keyUp(target, { key: "ArrowRight" });
    expect(blockNames(stickers())[0]).toStartWith("Стикер 1: стикер недоступен, 7.0–8.0 с");
    undo();
    expect(blockNames(stickers())[0]).toStartWith("Стикер 1: стикер недоступен, 2.1–3.1 с");
  });
});

describe("the keyboard focus stays on a block that changes rows (review round 1)", () => {
  test("⌥← into a neighbour moves the block to another row and it keeps the focus; two separate bursts are two undo steps", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 0, 3_000), textLayer(1, 3_000, 6_000)] });
    const second = block(/^Текст 2:/);
    second.focus();
    fireEvent.keyDown(second, { key: "ArrowLeft", altKey: true });
    // 2.9–5.9 s covers the first text: a second row now, the same element.
    expect(texts().querySelectorAll(".ed-blk-slot").length).toBe(2);
    expect(document.activeElement === second && second.isConnected).toBe(true);
    fireEvent.keyUp(second, { key: "ArrowLeft" });
    fireEvent.keyDown(second, { key: "ArrowLeft", altKey: true });
    fireEvent.keyUp(second, { key: "ArrowLeft" });
    expect(blockNames(texts())[1]).toBe("Текст 2: «sunday reset», 2.8–5.8 с");
    undo();
    expect(blockNames(texts())[1]).toBe("Текст 2: «sunday reset», 2.9–5.9 с");
  });

  test("a trim handle stays on its block while it is dragged; Escape on a handle gives the focus to the block", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 300, 4_400)] });
    fireEvent.click(block(/^Текст 1:/));
    const end = within(timeline()).getByRole("slider", { name: "Текст 1: конец" });
    fireEvent.pointerDown(end, { pointerId: 14, button: 0, clientX: 500 });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 14, clientX: 500 + ONE_SECOND_PX }));
    });
    expect(within(timeline()).queryAllByRole("slider", { name: "Текст 1: конец" }).length).toBe(1);
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 14, clientX: 500 + ONE_SECOND_PX }));
    });
    const start = within(timeline()).getByRole("slider", { name: "Текст 1: начало" });
    start.focus();
    fireEvent.keyDown(start, { key: "Escape" });
    expect(document.activeElement?.getAttribute("data-layer-id")).toBe("layer-001");
    expect(block(/^Текст 1:/).getAttribute("aria-pressed")).toBe("false");
  });

  test("a sticker picked from the menu gives the focus back to «+»", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client);
    const add = within(timeline()).getByRole("button", { name: "Добавить стикер" });
    fireEvent.click(add);
    fireEvent.click(within(timeline()).getByRole("menuitem", { name: "Звезда" }));
    expect(document.activeElement === add).toBe(true);
  });
});

describe("the z-order («Слой выше» / «Слой ниже»)", () => {
  test("a text under a sticker of the same time goes up and back down; at the extremes the step is off with the reason", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 0, 2_000), { ...stickerLayer(1, 1_000, 3_000), sticker: { source: "builtin", stickerId: "star-spin" } }] });
    fireEvent.click(block(/^Текст 1:/));
    const up = within(timeline()).getByRole("button", { name: "Слой выше" });
    const down = within(timeline()).getByRole("button", { name: "Слой ниже" });
    expect(down.hasAttribute("disabled")).toBe(true);
    expect(down.getAttribute("title")).toBe("Ниже в это время ничего нет");
    fireEvent.click(up);
    const saved = await nextSave(engine);
    expect(saved.layers.map((l) => l.layerId)).toEqual(["layer-002", "layer-001"]);
    expect(block(/^Текст 1:/).getAttribute("aria-pressed")).toBe("true");
    expect(up.hasAttribute("disabled")).toBe(true);
    expect(up.getAttribute("title")).toBe("Выше в это время ничего нет");
    // ⌥↓ on the focused block steps it back down, and it keeps the focus.
    const focused = block(/^Текст 1:/);
    focused.focus();
    fireEvent.keyDown(focused, { key: "ArrowDown", altKey: true });
    await flush();
    expect(document.activeElement?.getAttribute("data-layer-id")).toBe("layer-001");
    expect(within(props()).getByRole("button", { name: /Ниже/ }).hasAttribute("disabled")).toBe(true);
  });

  test("⌥↑ on a text under another text of the same time swaps their rows, and the focus follows the block", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 0, 2_000), textLayer(1, 1_000, 3_000)] });
    const first = block(/^Текст 1:/);
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowUp", altKey: true });
    await flush();
    // Rows are packed in z-order: the raised text now sits on the second row, a new button there.
    expect(blockNames(texts())).toEqual(["Текст 1: «sunday reset», 1.0–3.0 с", "Текст 2: «sunday reset», 0.0–2.0 с"]);
    expect(document.activeElement?.getAttribute("data-layer-id")).toBe("layer-001");
    const saved = await nextSave(engine);
    expect(saved.layers.map((l) => l.layerId)).toEqual(["layer-002", "layer-001"]);
  });

  test("a clip or nothing selected: the z-order steps are off", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client);
    expect(within(timeline()).getByRole("button", { name: "Слой выше" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(screen.getByRole("list", { name: "Кадры" })).getAllByRole("button")[0] ?? document.body);
    expect(within(timeline()).getByRole("button", { name: "Слой ниже" }).getAttribute("title")).toBe("Выше и ниже двигаются только текст и стикеры");
  });
});

describe("a layer's other actions and states", () => {
  test("Delete removes the selected layer; split at the playhead selects the second part; Escape clears the selection", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 0, 3_000), textLayer(1, 4_000, 6_000)] });
    fireEvent.click(block(/^Текст 2:/));
    // Selecting brings the playhead 1 s into it.
    expect(clockText()).toBe("00:05.0 / 00:08.0");
    fireEvent.click(within(timeline()).getByRole("button", { name: "Разрезать по плейхеду" }));
    expect(blockNames(texts())).toEqual(["Текст 1: «sunday reset», 0.0–3.0 с", "Текст 2: «sunday reset», 4.0–5.0 с", "Текст 3: «sunday reset», 5.0–6.0 с"]);
    expect(block(/^Текст 3:/).getAttribute("aria-pressed")).toBe("true");
    fireEvent.keyDown(block(/^Текст 3:/), { key: "Delete" });
    expect(blockNames(texts())).toHaveLength(2);
    fireEvent.click(block(/^Текст 1:/));
    fireEvent.keyDown(within(timeline()).getByRole("slider", { name: "Масштаб таймлайна" }), { key: "Escape" });
    expect(block(/^Текст 1:/).getAttribute("aria-pressed")).toBe("false");
  });

  test("a layer past the montage's end says so on its block", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [textLayer(0, 6_000, 9_000)] });
    expect(blockNames(texts())).toEqual(["Текст 1: «sunday reset», 6.0–9.0 с, после конца ролика"]);
    expect(texts().querySelectorAll(".ed-blk-out").length).toBe(1);
  });

  test("a sticker the built-in set does not have is marked with the engine's reason", async () => {
    const { client, engine } = await studio();
    // The testkit's sticker id is not in the set: the engine (and the mock) answer `sticker-unavailable`.
    await openDraft(engine, client, { layers: [stickerLayer(0, 0, 1_000)] });
    await waitFor(() => expect(blockNames(stickers())).toEqual(["Стикер 1: стикер недоступен, 0.0–1.0 с, стикера больше нет"]));
    expect(stickers().querySelectorAll(".ed-blk-flagged").length).toBe(1);
  });
});

describe("the music track", () => {
  const music = (startMs: number) => ({ music: { source: "trending" as const, trackId: TRACK.trackId, startMs } });

  test("no music: «Добавить музыку» waits for the «Музыка» tab", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client);
    const add = within(timeline()).getByRole("button", { name: "Добавить музыку" });
    expect(add.hasAttribute("disabled")).toBe(true);
    expect(add.getAttribute("title")).toBe("Музыка — скоро: трек выбирается во вкладке «Музыка»");
  });

  test("the block: the track, its start with ★ on a highlight, the waveform of the montage's part from music.peaks", async () => {
    const { client, engine } = await studio({ music: { tracks: [TRACK] } });
    await openDraft(engine, client, music(12_000));
    const block = await within(timeline()).findByRole("button", { name: "Музыка: Espresso · Sabrina Carpenter, с 0:12" });
    await waitFor(() => expect(block.querySelectorAll(".ed-wave-bar").length).toBeGreaterThan(0));
    const asked = callsOf(engine, "music.peaks").at(-1)?.payload;
    expect(asked).toMatchObject({ track: { source: "trending", trackId: TRACK.trackId }, startMs: 12_000, durationMs: 8_000 });
    expect(block.querySelectorAll(".ed-wave-bar").length).toBe(asked?.bars ?? -1);
    expect(block.querySelector(".ed-music-start svg") !== null).toBe(true);
    expect(block.querySelector(".ed-music-start")?.textContent).toBe("0:12");
    // 30 s is not in 12–20 s: no highlight mark.
    expect(block.querySelectorAll(".ed-wave-mark").length).toBe(0);
  });

  test("a highlight inside the montage's part is marked; a start off the highlights has no ★", async () => {
    const { client, engine } = await studio({ music: { tracks: [TRACK] } });
    await openDraft(engine, client, music(25_000));
    const block = await within(timeline()).findByRole("button", { name: /^Музыка: Espresso/ });
    expect(block.querySelectorAll(".ed-wave-mark").length).toBe(1);
    expect(block.querySelector(".ed-music-start svg") === null).toBe(true);
  });

  test("a drag slides the music: dragged right, earlier music comes under the playhead; one edit, one undo step", async () => {
    const { client, engine } = await studio({ music: { tracks: [TRACK] } });
    await openDraft(engine, client, music(12_000));
    const target = await within(timeline()).findByRole("button", { name: /^Музыка: Espresso/ });
    drag(target, ONE_SECOND_PX, 8);
    expect(plain(target.getAttribute("aria-label"))).toBe("Музыка: Espresso · Sabrina Carpenter, с 0:11");
    expect(target.getAttribute("aria-pressed")).toBe("true");
    const saved = await nextSave(engine);
    expect(saved.music).toEqual({ source: "trending", trackId: TRACK.trackId, startMs: 11_000 });
    // The waveform is asked again for the new start.
    await waitFor(() => expect(callsOf(engine, "music.peaks").at(-1)?.payload.startMs).toBe(11_000));
    undo();
    expect(target.getAttribute("aria-label")).toBe("Музыка: Espresso · Sabrina Carpenter, с 0:12");
  });

  test("the start never leaves the track: not before 0, not so late that the montage runs past its end", async () => {
    const { client, engine } = await studio({ music: { tracks: [TRACK] } });
    await openDraft(engine, client, music(1_000));
    const target = await within(timeline()).findByRole("button", { name: /^Музыка: Espresso/ });
    drag(target, 5 * ONE_SECOND_PX, 9);
    expect(target.getAttribute("aria-label")).toBe("Музыка: Espresso · Sabrina Carpenter, с 0:00");
    // 60 s track, 8 s montage: 52 s is the last start.
    drag(target, -100 * ONE_SECOND_PX, 10);
    expect(target.getAttribute("aria-label")).toBe("Музыка: Espresso · Sabrina Carpenter, с 0:52");
  });

  test("⌥← and ⌥→ slide it by 0.1 s the way the arrow points (⇧: 1 s); a held key is one undo step", async () => {
    const { client, engine } = await studio({ music: { tracks: [TRACK] } });
    await openDraft(engine, client, music(12_000));
    const target = await within(timeline()).findByRole("button", { name: /^Музыка: Espresso/ });
    fireEvent.keyDown(target, { key: "ArrowLeft", altKey: true });
    fireEvent.keyDown(target, { key: "ArrowLeft", altKey: true, shiftKey: true, repeat: true });
    fireEvent.keyUp(target, { key: "ArrowLeft" });
    expect(plain(target.getAttribute("aria-label"))).toBe("Музыка: Espresso · Sabrina Carpenter, с 0:13.1");
    fireEvent.keyDown(target, { key: "ArrowRight", altKey: true });
    fireEvent.keyUp(target, { key: "ArrowRight" });
    expect(plain(target.getAttribute("aria-label"))).toBe("Музыка: Espresso · Sabrina Carpenter, с 0:13");
    undo();
    expect(plain(target.getAttribute("aria-label"))).toBe("Музыка: Espresso · Sabrina Carpenter, с 0:13.1");
    undo();
    expect(plain(target.getAttribute("aria-label"))).toBe("Музыка: Espresso · Sabrina Carpenter, с 0:12");
  });

  test("a drag the system cancels leaves the start where it was", async () => {
    const { client, engine } = await studio({ music: { tracks: [TRACK] } });
    await openDraft(engine, client, music(12_000));
    const target = await within(timeline()).findByRole("button", { name: /^Музыка: Espresso/ });
    drag(target, ONE_SECOND_PX, 13, "cancel");
    await flush();
    expect(target.getAttribute("aria-label")).toBe("Музыка: Espresso · Sabrina Carpenter, с 0:12");
    expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
  });

  test("a clip lengthened past what the track has left says so at once, before the engine judges the saved draft", async () => {
    const { client, engine } = await studio({ music: { tracks: [TRACK] } });
    // 50 s into a 60 s track: 10 s of music left for an 8 s montage.
    await openDraft(engine, client, music(50_000));
    fireEvent.click(within(screen.getByRole("list", { name: "Кадры" })).getAllByRole("button")[0] ?? document.body);
    const handle = within(timeline()).getByRole("slider", { name: "Длительность кадра 1: правый край" });
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true, repeat: true });
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true, repeat: true });
    expect(within(timeline()).getByRole("button", { name: /^Музыка: Espresso/ }).getAttribute("aria-label")).toBe("Музыка: Espresso · Sabrina Carpenter, с 0:50, трек короче ролика");
  });

  test("a track shorter than the montage from its start says so", async () => {
    const { client, engine } = await studio({ music: { tracks: [{ ...TRACK, durationMs: 15_000, peaks: TRACK.peaks.slice(0, 300) }] } });
    await openDraft(engine, client, music(10_000));
    const target = await within(timeline()).findByRole("button", { name: /трек короче ролика$/ });
    expect(target.querySelector(".ed-music-issue")?.textContent).toBe("⚠ трек короче ролика");
  });

  test("a track the store does not hold is unavailable and cannot be slid", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, music(12_000));
    const target = await within(timeline()).findByRole("button", { name: "Музыка: трек недоступен" });
    drag(target, ONE_SECOND_PX, 11);
    await flush();
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
  });

  test("selected: its properties head; Delete takes the music away (the video gets silence)", async () => {
    const { client, engine } = await studio({ music: { tracks: [TRACK] } });
    await openDraft(engine, client, music(12_000));
    const target = await within(timeline()).findByRole("button", { name: /^Музыка: Espresso/ });
    fireEvent.click(target);
    expect(within(props()).getByText("Музыка")).toBeDefined();
    expect(plain(within(props()).getByText(/весь ролик/).textContent)).toBe("0–8.0 с · весь ролик");
    fireEvent.keyDown(target, { key: "Delete" });
    expect(within(timeline()).getByRole("button", { name: "Добавить музыку" })).toBeDefined();
    const saved = await nextSave(engine);
    expect(saved.music).toBe(null);
  });
});
