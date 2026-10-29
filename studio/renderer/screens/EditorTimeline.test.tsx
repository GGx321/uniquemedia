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

});

describe("the clip's properties", () => {

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

});

describe("the bin's buttons", () => {
});
