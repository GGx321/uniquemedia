import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { MontageDraft } from "../../shared/engine";
import { freePhotos, PHOTO_IDS, scenePhoto } from "../engine/mockEngine.testkit";
import { callsOf, flush, tick } from "../testing";
import { AUTOSAVE_DEBOUNCE_MS } from "./montage/autosave";
import { asAnotherWindow, makeDraft, MIA, openDrafts, studio } from "./montage/screenKit";

// 3d.3a: the timeline's clip track in the editor (Editor.dc.html, EditorNew.dc.html; the components sheet's timeline
// pieces): placing photos from the bin (focus asked at once, K6; used photos dimmed and refused, Q1), selecting,
// deleting, moving, trimming and copying clips, the playhead by keyboard, the caps, and every edit saved through the
// session (one undo step each).

// The bin lists the newest photo first: «Фото 1» is the sixth photo, «Фото 6» the first.
const [P1, P2, P3] = [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? "", PHOTO_IDS[2] ?? ""];

async function openEditor(): Promise<void> {
  await openDrafts();
  await screen.findByRole("heading", { level: 3, name: /Mia/ });
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();
  await screen.findByRole("list", { name: "Фото аватара" });
}

const timeline = (): HTMLElement => screen.getByRole("region", { name: "Таймлайн" });
const props = (): HTMLElement => screen.getByRole("complementary", { name: "Свойства" });
const clipButtons = (): HTMLElement[] => within(screen.getByRole("list", { name: "Кадры" })).getAllByRole("button");
const clockText = (): string => (timeline().querySelector(".ed-tl-clock")?.textContent ?? "").replace(/\s+/g, " ");
/** Labels as read, the no-break space before «с» read as a space. */
const plain = (text: string | null | undefined): string => (text ?? "").replace(/\u00a0/g, " ");
const clipLabels = (): string[] => clipButtons().map((b) => plain(b.getAttribute("aria-label")));

/** The bin tile holding `photoId` (the bin is newest first, ids are numbered oldest first). */
function tileOf(photoId: string): HTMLElement {
  const items = within(screen.getByRole("list", { name: "Фото аватара" })).getAllByRole("listitem");
  const index = 6 - Number(photoId.slice(-4));
  const item = items[index];
  if (item === undefined) throw new Error(`no tile for ${photoId}`);
  return item;
}

const pickButton = (photoId: string): HTMLElement => within(tileOf(photoId)).getByRole("button");

async function pick(photoId: string): Promise<void> {
  fireEvent.click(pickButton(photoId));
  await flush();
}

/** The draft as the engine last saved it, after the next save lands. */
async function nextSave(engine: Parameters<typeof callsOf>[0], before: number): Promise<MontageDraft> {
  await waitFor(() => expect(callsOf(engine, "montages.save").length).toBeGreaterThan(before), { timeout: AUTOSAVE_DEBOUNCE_MS * 4 });
  const last = callsOf(engine, "montages.save").at(-1);
  if (last === undefined) throw new Error("no save");
  return last.payload.spec;
}

const photoOf = (clip: MontageDraft["clips"][number] | undefined): string | null => (clip?.kind === "photo" && clip.cell.photo?.source === "scene" ? clip.cell.photo.photoId : null);

describe("placing photos from the bin", () => {
  test("a click appends a 2.0 s clip, asks montages.focus for it, and saves the focus it found", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    // P3 is odd-numbered: the mock judges a face on it.
    await pick(P3);

    expect(clipLabels()).toEqual(["Кадр 1: 1 фото, 8.0 с", "Кадр 2: 1 фото, 2.0 с"]);
    expect(callsOf(engine, "montages.focus").at(-1)?.payload).toEqual({ avatarId: MIA.avatarId, photo: { source: "scene", photoId: P3 } });
    const saved = await nextSave(engine, 0);
    expect(saved.clips[1]).toMatchObject({ kind: "photo", durationMs: 2_000, motion: "kenburns", cell: { photo: { source: "scene", photoId: P3 }, focus: { x: 0.5, y: 0.35 } } });
    // The new clip is selected, and its properties say it.
    expect(clipButtons()[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(within(props()).getByText("Кадр 2 из 2")).toBeDefined();
    expect(within(props()).getByText("кадр по лицу")).toBeDefined();
    expect(within(tileOf(P3)).getByText("2")).toBeDefined();
  });

  test("a photo the face judge cannot read is stored with focus null and says «лицо не найдено»", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await pick(P2);
    const saved = await nextSave(engine, 0);
    expect(saved.clips[1]).toMatchObject({ cell: { photo: { photoId: P2 }, focus: null } });
    expect(within(props()).getByText("лицо не найдено")).toBeDefined();
  });

  test("one undo takes the placed photo away again: the focus is not a step of its own", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await pick(P3);
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    expect(clipButtons()).toHaveLength(1);
  });

  test("a photo in a video or a render is dimmed, cannot be clicked, and cannot be dragged (Q1)", async () => {
    const photos = [...freePhotos(4), scenePhoto(5, { usedIn: ["video-mia-0001"] }), scenePhoto(6, { reserved: true })];
    const { client, engine } = await studio({ photos });
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    for (const photoId of [PHOTO_IDS[4] ?? "", PHOTO_IDS[5] ?? ""]) {
      const button = pickButton(photoId);
      expect(button.hasAttribute("disabled")).toBe(true);
      expect(button.getAttribute("draggable")).toBe("false");
      fireEvent.click(button);
    }
    await flush();
    expect(clipButtons()).toHaveLength(1);
    expect(callsOf(engine, "montages.focus")).toHaveLength(0);
    expect(within(tileOf(PHOTO_IDS[4] ?? "")).getByText("в 1 видео")).toBeDefined();
    expect(within(tileOf(PHOTO_IDS[5] ?? "")).getByText("в рендере")).toBeDefined();
  });

  test("a photo already in the draft selects its clip instead of adding it again", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    expect(pickButton(P1).getAttribute("aria-label")).toBe("Фото 6: выбрать кадр 1");
    await pick(P1);
    expect(clipButtons()).toHaveLength(1);
    expect(clipButtons()[0]?.getAttribute("aria-pressed")).toBe("true");
    expect(callsOf(engine, "montages.focus")).toHaveLength(0);
  });

  test("slice review 5-M5: a cell the owner selects is a click's target: a free photo replaces its photo, one undo step; the bin says so first", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await pick(P2);
    await nextSave(engine, 0);
    // The owner selects clip 2 (the one a click just added would not be a target: see the next test).
    fireEvent.click(clipButtons()[1] ?? document.body);
    await flush();
    expect(pickButton(P3).getAttribute("aria-label")).toBe("Фото 4: заменить фото в ячейке 1 кадра 2");
    expect(screen.getByText(/^Клик — заменить фото в ячейке 1 кадра 2\./)).toBeDefined();
    const before = callsOf(engine, "montages.save").length;
    await pick(P3);
    expect(clipButtons()).toHaveLength(2);
    const saved = await nextSave(engine, before);
    expect(saved.clips.map(photoOf)).toEqual([P1, P3]);
    // The new photo's face is asked for, as for any photo placed.
    expect(callsOf(engine, "montages.focus").at(-1)?.payload.photo).toEqual({ source: "scene", photoId: P3 });
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    const back = await nextSave(engine, callsOf(engine, "montages.save").length);
    expect(back.clips.map(photoOf)).toEqual([P1, P2]);
  });

  test("slice review 5-M5: right after a click placed a photo, the next click adds another clip (the photo just placed is not replaced)", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await pick(P2);
    // The clip just added is selected, but a click still adds: the bin says so.
    expect(pickButton(P3).getAttribute("aria-label")).toBe("Фото 4: добавить кадр в конец ролика");
    await pick(P3);
    expect(clipLabels()).toEqual(["Кадр 1: 1 фото, 8.0 с", "Кадр 2: 1 фото, 2.0 с", "Кадр 3: 1 фото, 2.0 с"]);
    // Selected again by the owner, it is the target.
    fireEvent.click(clipButtons()[2] ?? document.body);
    await flush();
    expect(pickButton(P3).getAttribute("aria-label")).toBe("Фото 4: выбрать кадр 3");
    expect(within(tileOf(PHOTO_IDS[3] ?? "")).getByRole("button").getAttribute("aria-label")).toBe("Фото 3: заменить фото в ячейке 1 кадра 3");
  });

  test("dropped on the track, a photo becomes a clip at the boundary under the pointer", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    const lane = timeline().querySelector(".ed-lane-clips");
    if (lane === null) throw new Error("no clip lane");
    fireEvent.dragStart(pickButton(P3));
    // Without layout (the test DOM measures nothing) every pointer is at 0 s: the start of the montage.
    fireEvent.dragOver(lane, { clientX: 0 });
    expect(lane.querySelector(".ed-insert")).not.toBeNull();
    fireEvent.drop(lane, { clientX: 0 });
    await flush();
    expect(clipLabels()).toEqual(["Кадр 1: 1 фото, 2.0 с", "Кадр 2: 1 фото, 8.0 с"]);
    const saved = await nextSave(engine, 0);
    expect(saved.clips.map(photoOf)).toEqual([P3, P1]);
  });

  test("the empty draft's dashed track takes a dropped photo too", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, []);
    await openEditor();
    const lane = timeline().querySelector(".ed-lane-clips");
    if (lane === null) throw new Error("no clip lane");
    fireEvent.dragStart(pickButton(P2));
    fireEvent.dragOver(lane, { clientX: 0 });
    fireEvent.drop(lane, { clientX: 0 });
    await flush();
    expect(clipButtons()).toHaveLength(1);
    // The render's reason moves on: the montage now has a clip, but only 2 s of it.
    expect(screen.queryByText("Добавьте хотя бы один кадр") === null).toBe(true);
    expect(screen.getByText("Ролик короче 4 с")).toBeDefined();
  });
});

describe("the caps", () => {
  test("20 clips: the count turns amber, «+» is off with the reason, and a click on a photo adds nothing", async () => {
    const photos = freePhotos(21);
    const { client, engine } = await studio({ photos });
    const ids = photos.map((p) => p.photoId);
    const made = await makeDraft(client, MIA.avatarId, ids.slice(0, 20));
    expect(made.spec.clips).toHaveLength(20);
    await openDrafts();
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await screen.findByRole("region", { name: "Таймлайн" });
    await flush();
    await screen.findByRole("list", { name: "Фото аватара" });

    const head = timeline().querySelector(".ed-th-clips");
    expect(head?.querySelector(".ed-th-full")?.textContent).toBe("20");
    // Both «+»: the track header's and the one after the last clip, as the components sheet labels them.
    const adds = within(timeline()).getAllByRole("button", { name: "Добавить кадр: не больше 20" });
    expect(adds.map((b) => b.hasAttribute("disabled"))).toEqual([true, true]);
    expect(screen.getByText("Не больше 20 кадров в одном видео. Клик по фото в панели ничего не добавит.")).toBeDefined();
    // The 21st photo is the newest: the first tile.
    const first = within(screen.getByRole("list", { name: "Фото аватара" })).getAllByRole("listitem")[0];
    const button = first === undefined ? null : within(first).getByRole("button");
    expect(button?.hasAttribute("disabled")).toBe(true);
    expect(callsOf(engine, "montages.focus")).toHaveLength(0);
  });

  test("a draft at 15 s has no room: no new clip, and its clips cannot grow", async () => {
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec: { ...made.spec, clips: made.spec.clips.map((c) => ({ ...c, durationMs: 15_000 })) }, name: null }));
    await openEditor();
    expect(screen.getByText(/на новый кадр нет места/)).toBeDefined();
    fireEvent.click(clipButtons()[0] ?? document.body);
    const handle = within(timeline()).getByRole("slider", { name: "Длительность кадра 1: правый край" });
    expect(handle.getAttribute("aria-valuemax")).toBe("15000");
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    await flush();
    expect(handle.getAttribute("aria-valuenow")).toBe("15000");
    expect(within(props()).getByText(/длиннее кадр уже не станет/)).toBeDefined();
    expect(callsOf(engine, "montages.save")).toHaveLength(1);
  });
});

describe("selecting and acting on a clip", () => {
  test("a click selects a clip: the accent edge, two labelled handles, its properties, the playhead brought inside", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, PHOTO_IDS.slice(0, 5));
    await openEditor();
    // Five photos: five clips of 1.3 s.
    fireEvent.click(clipButtons()[2] ?? document.body);
    expect(clipButtons()[2]?.getAttribute("aria-pressed")).toBe("true");
    expect(within(timeline()).getAllByRole("slider", { name: /^Длительность кадра 3/ })).toHaveLength(2);
    expect(within(props()).getByText("Кадр 3 из 5")).toBeDefined();
    expect(within(props()).getByText("1 фото · 2.6–3.9 с")).toBeDefined();
    // 2.6 s + min(1 s, 1.3 s / 2), on the clock's 100 ms.
    expect(clockText()).toBe("00:03.2 / 00:06.5");
  });

  test("Delete removes the selected clip and Escape clears the selection; each edit is one undo step", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1, P2, P3, PHOTO_IDS[3] ?? "", PHOTO_IDS[4] ?? ""]);
    await openEditor();
    const third = clipButtons()[2];
    if (third === undefined) throw new Error("no clip 3");
    fireEvent.click(third);
    fireEvent.keyDown(third, { key: "Delete" });
    expect(clipButtons()).toHaveLength(4);
    expect(within(timeline()).getByRole("button", { name: "Удалить выбранное" }).hasAttribute("disabled")).toBe(true);
    // Keyboard focus stays on the track: the clip that took the deleted one's place.
    expect(document.activeElement === (clipButtons()[2] ?? null)).toBe(true);
    const saved = await nextSave(engine, 0);
    expect(saved.clips.map(photoOf)).toEqual([P1, P2, PHOTO_IDS[3], PHOTO_IDS[4]]);

    fireEvent.click(clipButtons()[0] ?? document.body);
    fireEvent.keyDown(clipButtons()[0] ?? document.body, { key: "Escape" });
    expect(clipButtons()[0]?.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    expect(clipButtons()).toHaveLength(5);
  });

  test("⌥→ moves the focused clip one place right, and it keeps the focus", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1, P2, P3, PHOTO_IDS[3] ?? "", PHOTO_IDS[4] ?? ""]);
    await openEditor();
    const first = clipButtons()[0];
    if (first === undefined) throw new Error("no clip");
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowRight", altKey: true });
    await flush();
    const saved = await nextSave(engine, 0);
    expect(saved.clips.map(photoOf)).toEqual([P2, P1, P3, PHOTO_IDS[3], PHOTO_IDS[4]]);
    expect(document.activeElement?.getAttribute("data-clip-id")).toBe("clip-001");
  });

  test("dragging a clip lifts it and drops it at the boundary under the pointer", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1, P2, P3, PHOTO_IDS[3] ?? "", PHOTO_IDS[4] ?? ""]);
    await openEditor();
    const third = clipButtons()[2];
    if (third === undefined) throw new Error("no clip 3");
    fireEvent.pointerDown(third, { pointerId: 7, button: 0, clientX: 300 });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 7, clientX: 200, buttons: 1 }));
    });
    expect(timeline().querySelector(".ed-clip-lifted")).not.toBeNull();
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 7, clientX: 200 }));
    });
    await flush();
    // The test DOM has no layout: every pointer reads 0 s, the first boundary.
    const saved = await nextSave(engine, 0);
    expect(saved.clips.map(photoOf)).toEqual([P3, P1, P2, PHOTO_IDS[3], PHOTO_IDS[4]]);
    expect(timeline().querySelector(".ed-clip-lifted") === null).toBe(true);
  });

  test("the right handle trims by 0.1 s per arrow (⇧: 1 s), never under 0.1 s; a held key is one undo step", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.click(clipButtons()[0] ?? document.body);
    const handle = within(timeline()).getByRole("slider", { name: "Длительность кадра 1: правый край" });
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyUp(handle, { key: "ArrowRight" });
    expect(handle.getAttribute("aria-valuenow")).toBe("9100");
    expect(plain(clipButtons()[0]?.getAttribute("aria-label"))).toBe("Кадр 1: 1 фото, 9.1 с");
    fireEvent.keyDown(handle, { key: "Home" });
    fireEvent.keyUp(handle, { key: "Home" });
    expect(handle.getAttribute("aria-valuenow")).toBe("100");
    const saved = await nextSave(engine, 0);
    expect(saved.clips[0]?.durationMs).toBe(100);
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    expect(plain(clipButtons()[0]?.getAttribute("aria-label"))).toBe("Кадр 1: 1 фото, 9.1 с");
  });

  test("«Дублировать выбранное» copies a photo clip with an empty cell (CF4); a click on a photo then fills it", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.click(clipButtons()[0] ?? document.body);
    fireEvent.click(within(timeline()).getByRole("button", { name: "Дублировать выбранное" }));
    expect(clipButtons()).toHaveLength(2);
    expect(clipButtons()[1]?.getAttribute("aria-pressed")).toBe("true");
    expect(within(props()).getByRole("button", { name: "Ячейка 1: пусто" })).toBeDefined();
    expect(screen.getByText(/^Клик — фото в ячейку 1 кадра 2\./)).toBeDefined();
    expect(screen.getByText("Кадр 2: пустая ячейка")).toBeDefined();

    await pick(P3);
    expect(clipButtons()).toHaveLength(2);
    const saved = await nextSave(engine, 0);
    expect(saved.clips.map(photoOf)).toEqual([P1, P3]);
    expect(saved.clips[1]).toMatchObject({ durationMs: 7_000, cell: { focus: { x: 0.5, y: 0.35 } } });
  });

  test("«Разрезать по плейхеду» is off for a photo clip with the reason (CF4)", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    const split = within(timeline()).getByRole("button", { name: "Разрезать по плейхеду" });
    expect(split.getAttribute("title")).toBe("Сначала выберите кадр, текст или стикер на таймлайне");
    fireEvent.click(clipButtons()[0] ?? document.body);
    expect(split.hasAttribute("disabled")).toBe(true);
    expect(split.getAttribute("title")).toBe("Фото и коллаж не режутся: одно фото — один раз в ролике");
  });

  test("«Поровну» shares the length evenly over the clips", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await pick(P3);
    const even = within(timeline()).getByRole("button", { name: "Все кадры поровну" });
    expect(even.hasAttribute("disabled")).toBe(false);
    fireEvent.click(even);
    expect(clipLabels()).toEqual(["Кадр 1: 1 фото, 5.0 с", "Кадр 2: 1 фото, 5.0 с"]);
    expect(even.hasAttribute("disabled")).toBe(true);
    const saved = await nextSave(engine, 0);
    expect(saved.clips.map((c) => c.durationMs)).toEqual([5_000, 5_000]);
  });
});

describe("the clip's properties", () => {
  test("«Коллаж 3» pads two empty cells (Render then waits for them), and «1 фото» cuts them again", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.click(clipButtons()[0] ?? document.body);
    fireEvent.click(within(props()).getByRole("button", { name: "Коллаж 3" }));
    expect(within(props()).getAllByRole("button", { name: /^Ячейка \d: / }).map((b) => b.getAttribute("aria-label"))).toEqual(["Ячейка 1: фото", "Ячейка 2: пусто", "Ячейка 3: пусто"]);
    expect(within(props()).getByText("коллаж 3 · 0.0–8.0 с")).toBeDefined();
    expect(screen.getByText("Кадр 1: пустая ячейка")).toBeDefined();
    expect(within(props()).getByRole("switch", { name: "Ячейки по очереди" }).getAttribute("aria-checked")).toBe("true");
    expect(within(props()).getByText("Ячейки по очереди, шаг 0.3 с")).toBeDefined();
    const saved = await nextSave(engine, 0);
    expect(saved.clips[0]).toMatchObject({ kind: "collage", layout: "collage3", stagger: true });

    fireEvent.click(within(props()).getByRole("button", { name: "1 фото" }));
    expect(within(props()).getAllByRole("button", { name: /^Ячейка \d: / })).toHaveLength(1);
    expect(within(props()).getByRole("switch", { name: "Ячейки по очереди" }).hasAttribute("disabled")).toBe(true);
  });

  test("motion and length: «Статика» and the slider are saved; the room line follows the length", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.click(clipButtons()[0] ?? document.body);
    expect(within(props()).getByText("ролик 8.0 с из 15 · кадр можно удлинить ещё на 7.0 с")).toBeDefined();
    fireEvent.click(within(props()).getByRole("button", { name: "Статика" }));
    fireEvent.change(within(props()).getByRole("slider", { name: "Длительность" }), { target: { value: "32" } });
    fireEvent.pointerUp(within(props()).getByRole("slider", { name: "Длительность" }));
    expect(within(props()).getByText("ролик 3.2 с из 15 · кадр можно удлинить ещё на 11.8 с")).toBeDefined();
    const saved = await nextSave(engine, 0);
    expect(saved.clips[0]).toMatchObject({ motion: "static", durationMs: 3_200 });
  });

  test("a photo dropped on a cell fills it", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.click(clipButtons()[0] ?? document.body);
    fireEvent.click(within(props()).getByRole("button", { name: "Коллаж 2" }));
    fireEvent.dragStart(pickButton(P3));
    const cell = within(props()).getByRole("button", { name: "Ячейка 2: пусто" });
    fireEvent.dragOver(cell);
    fireEvent.drop(cell);
    await flush();
    expect(within(props()).getByRole("button", { name: "Ячейка 2: фото" })).toBeDefined();
    await waitFor(async () => {
      const last = callsOf(engine, "montages.save").at(-1)?.payload.spec.clips[0];
      expect(last?.kind === "collage" && last.cells[1]?.photo).toEqual({ source: "scene", photoId: P3 });
    });
  });
});

describe("the playhead and the clock", () => {
  test("arrows move it by 0.1 s (⇧: 1 s) within the montage; Home and End go to the ends", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    const head = within(timeline()).getByRole("slider", { name: "Плейхед" });
    expect(clockText()).toBe("00:00.0 / 00:08.0");
    fireEvent.keyDown(head, { key: "ArrowRight" });
    fireEvent.keyDown(head, { key: "ArrowRight", shiftKey: true });
    expect(clockText()).toBe("00:01.1 / 00:08.0");
    expect(plain(head.getAttribute("aria-valuetext"))).toBe("1.1 с");
    fireEvent.keyDown(head, { key: "End" });
    fireEvent.keyDown(head, { key: "ArrowRight" });
    expect(clockText()).toBe("00:08.0 / 00:08.0");
    fireEvent.keyDown(head, { key: "Home" });
    fireEvent.keyDown(head, { key: "ArrowLeft" });
    expect(clockText()).toBe("00:00.0 / 00:08.0");
  });

  test("the arrows work on a focused clip too, and the playhead never stays past a shortened end", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    const clip = clipButtons()[0];
    if (clip === undefined) throw new Error("no clip");
    fireEvent.click(clip);
    fireEvent.keyDown(clip, { key: "End" });
    expect(clockText()).toBe("00:08.0 / 00:08.0");
    const handle = within(timeline()).getByRole("slider", { name: "Длительность кадра 1: правый край" });
    fireEvent.keyDown(handle, { key: "ArrowLeft", shiftKey: true });
    await flush();
    expect(clockText()).toBe("00:07.0 / 00:07.0");
  });

  test("«Воспроизвести» turns into «Пауза» and back; an empty draft has nothing to play", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.click(within(timeline()).getByRole("button", { name: "Воспроизвести" }));
    fireEvent.click(within(timeline()).getByRole("button", { name: "Пауза" }));
    expect(within(timeline()).getByRole("button", { name: "Воспроизвести" })).toBeDefined();
  });

  test("the empty draft: the play button is off, the clock reads 0", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, []);
    await openEditor();
    expect(within(timeline()).getByRole("button", { name: "Воспроизвести" }).hasAttribute("disabled")).toBe(true);
    expect(clockText()).toBe("00:00.0 / 00:00.0");
  });

  test("the ruler spans 0–15 s; labels past the end are dim, and zooming in shows half-second labels", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    const labels = (): string[] => [...timeline().querySelectorAll(".ed-tick-label")].map((l) => l.textContent ?? "");
    expect(labels()).toHaveLength(16);
    expect([...timeline().querySelectorAll(".ed-tick-label-after")].map((l) => l.textContent)).toEqual(["9", "10", "11", "12", "13", "14", "15 с"]);
    expect(within(timeline()).getByRole("button", { name: "Уместить" }).hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(timeline()).getByRole("button", { name: "Увеличить масштаб" }));
    expect(labels()).toHaveLength(31);
    expect(timeline().querySelector<HTMLElement>(".ed-tl-lanes")?.style.width).toBe("200%");
    fireEvent.click(within(timeline()).getByRole("button", { name: "Уместить" }));
    expect(labels()).toHaveLength(16);
  });
});

describe("undo steps of a gesture (one gesture, one step)", () => {
  /** Opens a one-clip draft (8.0 s) with its clip selected; the right trim handle. */
  async function oneClipSelected() {
    const harness = await studio();
    await makeDraft(harness.client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.click(clipButtons()[0] ?? document.body);
    return { ...harness, handle: within(timeline()).getByRole("slider", { name: "Длительность кадра 1: правый край" }) };
  }
  const undo = (): void => {
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
  };
  const firstLength = (): string => plain(clipButtons()[0]?.getAttribute("aria-label"));

  test("a held arrow key on a handle is one step: five repeats, then one undo is back at 8.0 s", async () => {
    const { handle } = await oneClipSelected();
    for (let i = 0; i < 5; i++) fireEvent.keyDown(handle, { key: "ArrowRight", repeat: i > 0 });
    fireEvent.keyUp(handle, { key: "ArrowRight" });
    expect(firstLength()).toBe("Кадр 1: 1 фото, 8.5 с");
    undo();
    expect(firstLength()).toBe("Кадр 1: 1 фото, 8.0 с");
  });

  test("letting go of Shift mid-gesture does not end it: only the held key's release does", async () => {
    const { handle } = await oneClipSelected();
    fireEvent.keyDown(handle, { key: "ArrowRight" });
    fireEvent.keyUp(handle, { key: "Shift" });
    fireEvent.keyDown(handle, { key: "ArrowRight", repeat: true });
    fireEvent.keyUp(handle, { key: "ArrowRight" });
    expect(firstLength()).toBe("Кадр 1: 1 фото, 8.2 с");
    undo();
    expect(firstLength()).toBe("Кадр 1: 1 фото, 8.0 с");
  });

  test("two pointer drags of a handle are two undo steps, however many moves each has", async () => {
    const { handle } = await oneClipSelected();
    // Without layout the lanes measure 1048 px for 15 s: 70 px is about 1 s.
    const drag = (pointerId: number): void => {
      fireEvent.pointerDown(handle, { pointerId, button: 0, clientX: 500 });
      act(() => {
        window.dispatchEvent(new PointerEvent("pointermove", { pointerId, clientX: 535, buttons: 1 }));
        window.dispatchEvent(new PointerEvent("pointermove", { pointerId, clientX: 570, buttons: 1 }));
        window.dispatchEvent(new PointerEvent("pointerup", { pointerId, clientX: 570 }));
      });
    };
    drag(21);
    drag(22);
    expect(firstLength()).toBe("Кадр 1: 1 фото, 10.0 с");
    undo();
    expect(firstLength()).toBe("Кадр 1: 1 фото, 9.0 с");
    undo();
    expect(firstLength()).toBe("Кадр 1: 1 фото, 8.0 с");
  });

  test("a drag of «Длительность» is one step", async () => {
    await oneClipSelected();
    const slider = within(props()).getByRole("slider", { name: "Длительность" });
    for (const value of ["32", "33", "34"]) fireEvent.change(slider, { target: { value } });
    fireEvent.pointerUp(slider);
    expect(firstLength()).toBe("Кадр 1: 1 фото, 3.4 с");
    undo();
    expect(firstLength()).toBe("Кадр 1: 1 фото, 8.0 с");
  });
});

describe("keys that belong to a control", () => {
  test("⌘Z and ⇧⌘Z work while a slider has the focus («Длительность», the zoom): a slider keeps no undo of its own", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.click(clipButtons()[0] ?? document.body);
    const slider = within(props()).getByRole("slider", { name: "Длительность" });
    fireEvent.change(slider, { target: { value: "32" } });
    fireEvent.pointerUp(slider);
    slider.focus();
    fireEvent.keyDown(slider, { key: "z", metaKey: true });
    expect(plain(clipButtons()[0]?.getAttribute("aria-label"))).toBe("Кадр 1: 1 фото, 8.0 с");
    const zoom = within(timeline()).getByRole("slider", { name: "Масштаб таймлайна" });
    zoom.focus();
    fireEvent.keyDown(zoom, { key: "z", metaKey: true, shiftKey: true });
    expect(plain(clipButtons()[0]?.getAttribute("aria-label"))).toBe("Кадр 1: 1 фото, 3.2 с");
  });

  test("Delete on the «Длительность» or the zoom slider does not delete the clip", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.click(clipButtons()[0] ?? document.body);
    fireEvent.keyDown(within(props()).getByRole("slider", { name: "Длительность" }), { key: "Delete" });
    fireEvent.keyDown(within(timeline()).getByRole("slider", { name: "Масштаб таймлайна" }), { key: "Backspace" });
    expect(clipButtons()).toHaveLength(1);
    expect(clipButtons()[0]?.getAttribute("aria-pressed")).toBe("true");
  });

  test("Delete and Escape that end an input method's composition change nothing", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    const clip = clipButtons()[0];
    if (clip === undefined) throw new Error("no clip");
    fireEvent.click(clip);
    fireEvent.keyDown(clip, { key: "Delete", isComposing: true });
    fireEvent.keyDown(within(props()).getByRole("button", { name: "Удалить" }), { key: "Backspace", isComposing: true });
    fireEvent.keyDown(clip, { key: "Escape", isComposing: true });
    expect(clipButtons()).toHaveLength(1);
    expect(clipButtons()[0]?.getAttribute("aria-pressed")).toBe("true");
  });
});

describe("3d.3a's known limits, settled with 3d.3b", () => {
  test("the left clip handle follows the edge: ← makes the clip longer, as dragging it left does; ↑/↓ follow the value", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.click(clipButtons()[0] ?? document.body);
    const left = within(timeline()).getByRole("slider", { name: "Длительность кадра 1: левый край" });
    fireEvent.keyDown(left, { key: "ArrowLeft" });
    fireEvent.keyUp(left, { key: "ArrowLeft" });
    expect(left.getAttribute("aria-valuenow")).toBe("8100");
    fireEvent.keyDown(left, { key: "ArrowRight" });
    fireEvent.keyDown(left, { key: "ArrowRight" });
    fireEvent.keyUp(left, { key: "ArrowRight" });
    expect(left.getAttribute("aria-valuenow")).toBe("7900");
    fireEvent.keyDown(left, { key: "ArrowUp" });
    fireEvent.keyUp(left, { key: "ArrowUp" });
    expect(left.getAttribute("aria-valuenow")).toBe("8000");
  });

  test("Escape on the zoom slider clears the selection: a slider has no Escape of its own", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.click(clipButtons()[0] ?? document.body);
    fireEvent.keyDown(within(timeline()).getByRole("slider", { name: "Масштаб таймлайна" }), { key: "Escape" });
    expect(clipButtons()[0]?.getAttribute("aria-pressed")).toBe("false");
  });
});

describe("a cancelled pointer", () => {
  test("a reorder drag whose pointer is cancelled (the system took it) moves nothing", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1, P2, P3, PHOTO_IDS[3] ?? "", PHOTO_IDS[4] ?? ""]);
    await openEditor();
    const third = clipButtons()[2];
    if (third === undefined) throw new Error("no clip 3");
    fireEvent.pointerDown(third, { pointerId: 9, button: 0, clientX: 300 });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 9, clientX: 200, buttons: 1 }));
      window.dispatchEvent(new PointerEvent("pointercancel", { pointerId: 9 }));
    });
    await flush();
    expect(timeline().querySelector(".ed-clip-lifted") === null).toBe(true);
    expect(clipButtons().map((b) => b.getAttribute("data-clip-id"))).toEqual(["clip-001", "clip-002", "clip-003", "clip-004", "clip-005"]);
    expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
  });
});

describe("the face judge's answers", () => {
  test("«ищем лицо…» stays while a later request for the same photo is still out", async () => {
    const { client, engine, scheduler } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    // P2 has no face score: the mock answers null, so only «ищем лицо…» tells a question is still open.
    engine.delayNext("montages.focus", 100);
    await pick(P2);
    expect(within(props()).getByText("ищем лицо…")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
    engine.delayNext("montages.focus", 300);
    await pick(P2);
    // The first answer comes back; the second question is still out.
    tick(scheduler);
    await flush();
    expect(within(props()).getByText("ищем лицо…")).toBeDefined();
    tick(scheduler);
    await flush();
    expect(within(props()).getByText("лицо не найдено")).toBeDefined();
  });
});

describe("a photo taken by a render while it is being dragged", () => {
  /** Opens a one-clip draft, starts dragging P3, then queues a render of another draft holding P3. */
  async function dragThenReserve() {
    const harness = await studio();
    await makeDraft(harness.client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.dragStart(pickButton(P3));
    const other = await makeDraft(harness.client, MIA.avatarId, [P3]);
    const queued = await asAnotherWindow(() => harness.client.request("videos.render", { montageId: other.montageId }));
    expect(queued.ok).toBe(true);
    await waitFor(() => expect(within(tileOf(P3)).getByText("в рендере")).toBeDefined());
    return harness;
  }

  test("dropped on the track, it is not placed", async () => {
    const { engine } = await dragThenReserve();
    const lane = timeline().querySelector(".ed-lane-clips");
    if (lane === null) throw new Error("no clip lane");
    fireEvent.dragOver(lane, { clientX: 0 });
    fireEvent.drop(lane, { clientX: 0 });
    await flush();
    expect(clipButtons()).toHaveLength(1);
    expect(callsOf(engine, "montages.focus")).toHaveLength(0);
  });

  test("dropped on an empty cell, the cell stays empty", async () => {
    const { engine } = await dragThenReserve();
    fireEvent.click(clipButtons()[0] ?? document.body);
    fireEvent.click(within(props()).getByRole("button", { name: "Коллаж 2" }));
    const cell = within(props()).getByRole("button", { name: "Ячейка 2: пусто" });
    fireEvent.dragOver(cell);
    fireEvent.drop(cell);
    await flush();
    expect(within(props()).getByRole("button", { name: "Ячейка 2: пусто" })).toBeDefined();
    expect(callsOf(engine, "montages.focus")).toHaveLength(0);
  });
});

describe("the bin's buttons", () => {
  test("each photo's button has its own name: the photo, then what a click does", async () => {
    const photos = [...freePhotos(5), scenePhoto(6, { reserved: true })];
    const { client } = await studio({ photos });
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    const names = within(screen.getByRole("list", { name: "Фото аватара" }))
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label"));
    expect(names).toEqual([
      "Фото 1: уже занято",
      "Фото 2: добавить кадр в конец ролика",
      "Фото 3: добавить кадр в конец ролика",
      "Фото 4: добавить кадр в конец ролика",
      "Фото 5: добавить кадр в конец ролика",
      "Фото 6: выбрать кадр 1",
    ]);
    expect(new Set(names).size).toBe(names.length);
  });
});
