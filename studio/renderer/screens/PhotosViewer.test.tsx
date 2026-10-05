import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { AvatarSummary, PhotoSummary, RunRequest } from "../../shared/engine";
import { App } from "../App";
import { MockEngine, mockEngineClient } from "../engine/mockEngine";
import { MIA, scenePhoto } from "../engine/mockEngine.testkit";
import { ManualScheduler } from "../engine/scheduler";
import { callsOf, describeElement, flush, focusedLabel, setup, tick } from "../testing";

// The photo viewer on the Photos screen's «Фото» tab: a click on a tile's photo opens it full size over the screen, with
// «Фото N из M», its category and the tile's badges; ← and → step through the gallery as its filter shows it (no wrap);
// the tile's pick and reject work from inside it; Escape, «Закрыть» and the dark around it close it, and the focus goes back
// to the grid. The photo on screen is held by its id while the gallery changes under it.

const photos = (n: number, patch: (i: number) => Partial<PhotoSummary> = () => ({})): PhotoSummary[] => Array.from({ length: n }, (_, i) => scenePhoto(i + 1, patch(i + 1)));
const summary = (list: readonly PhotoSummary[], patch: Partial<AvatarSummary> = {}): AvatarSummary => ({
  ...MIA,
  photoCount: list.length,
  eligibleUnusedCount: list.filter((p) => p.eligible && !p.used && !p.reserved).length,
  ...patch,
});

async function showMia(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Mia" }));
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  await flush();
}

async function openMia(options: Parameters<typeof setup>[0] = {}) {
  const list = options.photos ?? photos(6);
  const harness = setup({ avatars: [summary(list)], photos: list, ...options });
  await showMia();
  return harness;
}

/** A tile's photo, the button that opens it: named by the photo's place in the whole gallery (newest first) and its category. */
const openButton = (n: number, category = "Дом"): HTMLElement => screen.getByRole("button", { name: `Открыть фото ${n}: ${category}` });
const viewer = (): HTMLElement => screen.getByRole("dialog");
const viewerTitle = (): string => within(viewer()).getByRole("heading", { level: 2 }).textContent ?? "";
const closed = (): boolean => screen.queryByRole("dialog") === null;
const inViewer = (name: string): HTMLElement => within(viewer()).getByRole("button", { name });
const prev = (): HTMLElement => inViewer("Предыдущее фото");
const next = (): HTMLElement => inViewer("Следующее фото");
const montageCount = (): string => screen.getByRole("button", { name: /Монтаж из выбранных/ }).textContent ?? "";
const press = (key: string, init: Partial<KeyboardEventInit> = {}): boolean => fireEvent.keyDown(document.activeElement ?? window, { key, ...init });
function scrim(): Element {
  const found = document.querySelector(".viewer-scrim");
  if (found === null) throw new Error("no scrim");
  return found;
}
/** A press and its release on the same element, as a mouse click is. */
function pressOn(el: Element): void {
  fireEvent.pointerDown(el);
  fireEvent.pointerUp(el);
  fireEvent.click(el);
}
/** Where the browser's own Tab lands past the dialog's last control (`end`) or before its first (`start`). */
function focusEdge(edge: "start" | "end"): void {
  const found = viewer().querySelector<HTMLElement>(`[data-focus-edge="${edge}"]`);
  if (found === null) throw new Error(`no ${edge} edge`);
  found.focus();
}

describe("opening a photo", () => {
  test("a click on a tile's photo opens it in a modal viewer: «Фото N из M», its category and the tile's badges, the photo large", async () => {
    await openMia();
    fireEvent.click(openButton(2));
    const dialog = screen.getByRole("dialog", { name: "Фото 2 из 6" });
    expect(dialog.getAttribute("aria-modal")).toBe("true");
    expect(within(dialog).getByText("Дом")).toBeDefined();
    // Newest first: place 2 is the fifth photo made, the one with a face score.
    expect(within(dialog).getByText("лицо 0.86")).toBeDefined();
    // The dev mock has no pictures: the placeholder, in the viewer's own frame.
    const photo = within(dialog).getByRole("img", { name: "Фото 2 из 6: Дом" });
    expect(photo.classList.contains("portrait-placeholder")).toBe(true);
    expect(photo.closest(".viewer-frame") === null).toBe(false);
  });

  test("a photo in a video and a rejected one carry the tile's badges in the viewer too", async () => {
    // Newest first: place 1 is the photo in a video, place 2 the rejected one.
    await openMia({ photos: [scenePhoto(1, { rejected: true, eligible: false }), scenePhoto(2, { used: true, usedIn: ["video-00000001"] })] });
    fireEvent.click(openButton(1));
    expect(within(viewer()).getByText("в 1 видео")).toBeDefined();
    expect(within(viewer()).getByText("лицо не проверялось")).toBeDefined();
    press("ArrowRight");
    expect(viewerTitle()).toBe("Фото 2 из 2");
    expect(within(viewer()).getByText("отклонено")).toBeDefined();
    expect(within(viewer()).getByText("лицо 0.86")).toBeDefined();
  });

  test("the photo itself is a real button in the tab order: its click (what Enter and Space give a button) opens the viewer, the focus on «Закрыть»", async () => {
    await openMia();
    const open = openButton(1);
    expect(open.tagName).toBe("BUTTON");
    expect(open.getAttribute("type")).toBe("button");
    expect(open.tabIndex).toBe(0);
    expect(open.getAttribute("aria-haspopup")).toBe("dialog");
    expect(open.querySelector(".portrait-placeholder") === null).toBe(false);
    open.focus();
    fireEvent.click(open);
    expect(screen.getByRole("dialog", { name: "Фото 1 из 6" })).toBeDefined();
    expect(focusedLabel()).toBe(describeElement(inViewer("Закрыть")));
  });

  test("the tile's pick and reject buttons keep their own jobs and open nothing", async () => {
    const h = await openMia();
    fireEvent.click(screen.getByRole("button", { name: "Выбрать для монтажа: фото 1, Дом" }));
    expect(closed()).toBe(true);
    expect(montageCount()).toBe("Монтаж из выбранных · 1");
    fireEvent.click(screen.getByRole("button", { name: "Фото 2: отклонить — в видео не брать" }));
    await flush();
    expect(closed()).toBe(true);
    expect(callsOf(h.engine, "photos.setRejected").map((c) => c.payload.photoId)).toEqual([scenePhoto(5).photoId]);
  });
});

describe("closing", () => {
  test("Escape closes the viewer and gives the focus back to the photo it was opened from", async () => {
    await openMia();
    const open = openButton(3);
    open.focus();
    fireEvent.click(open);
    press("Escape");
    expect(closed()).toBe(true);
    expect(focusedLabel()).toBe(describeElement(openButton(3)));
  });

  test("«Закрыть» closes it, and so does a press on the dark around it; a press on the photo or the facts does not", async () => {
    await openMia();
    fireEvent.click(openButton(1));
    pressOn(within(viewer()).getByRole("img", { name: "Фото 1 из 6: Дом" }));
    pressOn(within(viewer()).getByRole("heading", { level: 2 }));
    expect(closed()).toBe(false);
    fireEvent.click(inViewer("Закрыть"));
    expect(closed()).toBe(true);
    expect(focusedLabel()).toBe(describeElement(openButton(1)));

    fireEvent.click(openButton(4));
    pressOn(scrim());
    expect(closed()).toBe(true);
    expect(focusedLabel()).toBe(describeElement(openButton(4)));
  });

  test("the dialog's own empty band round the arrows looks like the dark and closes like it", async () => {
    await openMia();
    fireEvent.click(openButton(2));
    pressOn(viewer());
    expect(closed()).toBe(true);
  });

  test("a drag that starts inside the viewer (selecting the title) and ends over the dark does not close it", async () => {
    await openMia();
    fireEvent.click(openButton(2));
    fireEvent.pointerDown(within(viewer()).getByRole("heading", { level: 2 }));
    fireEvent.pointerUp(scrim());
    fireEvent.click(scrim());
    expect(closed()).toBe(false);
    // Nor the other way round: pressed on the dark, let go on the photo (the click lands on what both share, the dark).
    fireEvent.pointerDown(scrim());
    fireEvent.pointerUp(within(viewer()).getByRole("img"));
    fireEvent.click(scrim());
    expect(closed()).toBe(false);
    // The next real press on the dark still closes.
    pressOn(scrim());
    expect(closed()).toBe(true);
  });

  test("after stepping, closing gives the focus to the tile of the photo on screen: the grid keeps the owner's place", async () => {
    await openMia();
    fireEvent.click(openButton(1));
    press("ArrowRight");
    press("ArrowRight");
    press("Escape");
    expect(focusedLabel()).toBe(describeElement(openButton(3)));
  });

  test("the focus stays inside: Tab moves as the browser moves it, and past either end it comes round", async () => {
    await openMia();
    fireEvent.click(openButton(2));
    const controls = Array.from(viewer().querySelectorAll<HTMLElement>("button:not([disabled])"));
    const [first, last] = [controls[0], controls.at(-1)];
    if (first === undefined || last === undefined || first === last) throw new Error("expected several controls in the viewer");

    // Tab is never held back: inside a control with parts of its own (a video's controls) the browser walks them.
    last.focus();
    expect(press("Tab")).toBe(true);
    // Past the last control the browser lands on the dialog's end edge: the focus comes round to the first control.
    focusEdge("end");
    expect(focusedLabel()).toBe(describeElement(first));
    // Before the first, on its start edge: round to the last.
    focusEdge("start");
    expect(focusedLabel()).toBe(describeElement(last));
  });

  test("a focus that strays out of the viewer comes back: to the first control going forward, to the last after Shift+Tab", async () => {
    await openMia();
    fireEvent.click(openButton(2));
    const controls = Array.from(viewer().querySelectorAll<HTMLElement>("button:not([disabled])"));
    const [first, last] = [controls[0], controls.at(-1)];
    if (first === undefined || last === undefined) throw new Error("no controls in the viewer");
    // The grid behind is inert and cannot take it; something put on the page after the viewer opened is not.
    openButton(5).focus();
    expect(focusedLabel()).toBe(describeElement(inViewer("Закрыть")));
    const stray = document.createElement("button");
    stray.textContent = "later";
    document.body.append(stray);
    try {
      stray.focus();
      expect(focusedLabel()).toBe(describeElement(first));
      press("Tab", { shiftKey: true });
      stray.focus();
      expect(focusedLabel()).toBe(describeElement(last));
    } finally {
      stray.remove();
    }
  });

  test("while it is open everything outside the viewer is inert; closing gives it back", async () => {
    await openMia();
    fireEvent.click(openButton(2));
    const dialog = viewer();
    const outside = Array.from(document.body.children).filter((el) => !el.contains(dialog));
    expect(outside.length).toBeGreaterThan(0);
    expect(outside.every((el) => el.hasAttribute("inert"))).toBe(true);
    expect(dialog.closest("[inert]") === null).toBe(true);
    press("Escape");
    expect(Array.from(document.body.children).some((el) => el.hasAttribute("inert"))).toBe(false);
  });
});

describe("stepping through the gallery", () => {
  // Newest first: place 1 is «Фитнес», place 2 «Путешествия», place 3 «Дом».
  const three = photos(3, (i) => ({ category: (["home", "travel", "fit"] as const)[i - 1] ?? "home" }));
  const shownCategory = (): string => within(viewer()).getByRole("img").getAttribute("aria-label") ?? "";

  test("→ and ← step in the gallery's order; at the first and the last photo the arrow is off and the key does nothing (no wrap)", async () => {
    await openMia({ photos: three });
    fireEvent.click(openButton(1, "Фитнес"));
    expect(viewerTitle()).toBe("Фото 1 из 3");
    expect(prev().hasAttribute("disabled")).toBe(true);
    expect(next().hasAttribute("disabled")).toBe(false);
    press("ArrowLeft");
    expect(viewerTitle()).toBe("Фото 1 из 3");

    press("ArrowRight");
    expect(viewerTitle()).toBe("Фото 2 из 3");
    expect(shownCategory()).toBe("Фото 2 из 3: Путешествия");
    fireEvent.click(next());
    expect(viewerTitle()).toBe("Фото 3 из 3");
    expect(shownCategory()).toBe("Фото 3 из 3: Дом");
    expect(next().hasAttribute("disabled")).toBe(true);
    press("ArrowRight");
    expect(viewerTitle()).toBe("Фото 3 из 3");

    fireEvent.click(prev());
    expect(viewerTitle()).toBe("Фото 2 из 3");
    // An arrow with a modifier belongs to someone else.
    press("ArrowRight", { altKey: true });
    press("ArrowLeft", { metaKey: true });
    expect(viewerTitle()).toBe("Фото 2 из 3");
  });

  test("an arrow that reaches the end hands the focus to the other one: the keyboard is never left on a dead button", async () => {
    await openMia({ photos: three });
    fireEvent.click(openButton(2, "Путешествия"));
    next().focus();
    fireEvent.click(next());
    expect(next().hasAttribute("disabled")).toBe(true);
    expect(focusedLabel()).toBe(describeElement(prev()));
  });

  test("the arrows follow the gallery's filter: under «Отклонённые» only the rejected photos, numbered among themselves", async () => {
    // Newest first: 4, 3 (rejected), 2, 1 (rejected).
    await openMia({ photos: photos(4, (i) => (i % 2 === 1 ? { rejected: true, eligible: false } : {})) });
    fireEvent.click(screen.getByRole("button", { name: "Отклонённые" }));
    fireEvent.click(openButton(2));
    expect(viewerTitle()).toBe("Фото 1 из 2");
    press("ArrowRight");
    expect(viewerTitle()).toBe("Фото 2 из 2");
    expect(next().hasAttribute("disabled")).toBe(true);
    press("Escape");
    expect(focusedLabel()).toBe(describeElement(openButton(4)));
  });
});

describe("the tile's actions, in the viewer", () => {
  test("«Выбрать для монтажа» is the tile's own pick: the same selection, the montage count, the tile's box", async () => {
    await openMia();
    fireEvent.click(openButton(2));
    const pick = inViewer("Выбрать для монтажа");
    expect(pick.getAttribute("aria-pressed")).toBe("false");
    fireEvent.click(pick);
    expect(pick.getAttribute("aria-pressed")).toBe("true");
    expect(montageCount()).toBe("Монтаж из выбранных · 1");
    expect(screen.getByRole("button", { name: "Выбрать для монтажа: фото 2, Дом" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(pick);
    expect(pick.getAttribute("aria-pressed")).toBe("false");
    expect(montageCount()).toBe("Монтаж из выбранных · 0");
  });

  test("a photo the montage cannot take keeps its pick off and says why, in the tile's words", async () => {
    await openMia({ photos: [scenePhoto(1, { used: true, usedIn: ["video-00000001"] })] });
    fireEvent.click(openButton(1));
    const pick = inViewer("Выбрать для монтажа");
    expect(pick.hasAttribute("disabled")).toBe(true);
    const why = within(viewer()).getByText("Фото уже в видео: одно фото — одно видео");
    expect(pick.getAttribute("aria-describedby")).toBe(why.id);
  });

  test("«Отклонить» sends the tile's photos.setRejected; the viewer and the tile show the mark at once, and «Вернуть из отклонённых» undoes it", async () => {
    const h = await openMia();
    fireEvent.click(openButton(2));
    fireEvent.click(inViewer("Выбрать для монтажа"));
    const reject = inViewer("Отклонить");
    reject.focus();
    fireEvent.click(reject);
    // While the engine answers, the button stays where the focus is, says it is busy and sends nothing more.
    expect(reject.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(reject);
    await flush();

    expect(callsOf(h.engine, "photos.setRejected").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId, photoId: scenePhoto(5).photoId, rejected: true }]);
    expect(within(viewer()).getByText("отклонено")).toBeDefined();
    expect(focusedLabel()).toBe(describeElement(inViewer("Вернуть из отклонённых")));
    // A rejected photo leaves the selection and cannot be picked, as on its tile.
    const pick = inViewer("Выбрать для монтажа");
    expect(pick.getAttribute("aria-pressed")).toBe("false");
    expect(pick.hasAttribute("disabled")).toBe(true);
    expect(within(viewer()).getByText("Фото отклонено — в монтаж не попадает")).toBeDefined();
    expect(montageCount()).toBe("Монтаж из выбранных · 0");
    expect(screen.getByRole("button", { name: "Фото 2: вернуть из отклонённых" })).toBeDefined();

    fireEvent.click(inViewer("Вернуть из отклонённых"));
    await flush();
    expect(callsOf(h.engine, "photos.setRejected").at(-1)?.payload).toEqual({ avatarId: MIA.avatarId, photoId: scenePhoto(5).photoId, rejected: false });
    expect(within(viewer()).queryByText("отклонено") === null).toBe(true);
    expect(inViewer("Отклонить")).toBeDefined();
    expect(screen.getByRole("button", { name: "Фото 2: отклонить — в видео не брать" })).toBeDefined();
  });

  test("while the marks cannot be read, the viewer's «Отклонить» is off with the tile's reason on screen", async () => {
    const list = photos(2);
    await openMia({ photos: list, avatars: [summary(list, { eligibleUnusedCount: 0, usage: { state: "unknown", reasons: ["rejects-unreadable"] } })] });
    fireEvent.click(openButton(1));
    const reject = inViewer("Отклонить");
    expect(reject.hasAttribute("disabled")).toBe(true);
    const why = within(viewer()).getByText("Журнал отметок повреждён: сначала восстановите отметки");
    expect(reject.getAttribute("aria-describedby")).toBe(why.id);
  });

  test("under «Неиспользованные» a photo rejected in the viewer stays on screen, marked, until the owner steps away", async () => {
    await openMia({ photos: photos(3) });
    fireEvent.click(screen.getByRole("button", { name: "Неиспользованные" }));
    fireEvent.click(openButton(2));
    fireEvent.click(inViewer("Отклонить"));
    await flush();
    expect(viewerTitle()).toBe("Фото 2 из 3");
    expect(within(viewer()).getByText("отклонено")).toBeDefined();
    press("ArrowRight");
    expect(viewerTitle()).toBe("Фото 2 из 2");
    press("ArrowLeft");
    expect(viewerTitle()).toBe("Фото 1 из 2");
  });
});

describe("a gallery that changes under the viewer", () => {
  /** Made before the mock's clock starts, so every photo a run makes now is newer. */
  const early = (n: number, patch: Partial<PhotoSummary> = {}): PhotoSummary => scenePhoto(n, { createdAt: new Date(Date.UTC(2026, 8, 20, 10, 0, n)).toISOString(), ...patch });
  const request: RunRequest = { avatarId: MIA.avatarId, count: 20, categories: ["home", "travel", "shoot", "glam", "fit"], poses: { profile: false, back: false } };

  test("a run's new photo lands in front: the same photo stays on screen, its number one further on", async () => {
    const h = await openMia({ photos: [early(1, { category: "travel" }), early(2)] });
    fireEvent.click(openButton(2, "Путешествия"));
    expect(viewerTitle()).toBe("Фото 2 из 2");

    const run = await act(async () => h.client.request("runs.start", { ...request, acceptedWorstMicros: 3_075_000 }));
    if (!run.ok) throw new Error(`runs.start: ${run.error.code}`);
    tick(h.scheduler, 1); // one slot lands: the gallery is listed again
    await flush();

    await waitFor(() => expect(viewerTitle()).toBe("Фото 3 из 3"));
    expect(within(viewer()).getByText("Путешествия")).toBeDefined();
  });

  test("a photo gone from the gallery while on screen closes the viewer; the focus goes to the photo now in its place", async () => {
    const h = await openMia({ photos: photos(3) });
    fireEvent.click(openButton(2));
    act(() => h.engine.setPhotoSidecarReadable(scenePhoto(2).photoId, false));
    // Another window rejects another photo: avatar.changed, and the gallery is listed again, without the lost one.
    await act(async () => {
      await h.client.request("photos.setRejected", { avatarId: MIA.avatarId, photoId: scenePhoto(3).photoId, rejected: true });
    });
    await flush();

    expect(closed()).toBe(true);
    // Newest first, the second photo gone: the first photo made now holds place 2.
    expect(focusedLabel()).toBe(describeElement(openButton(2)));
  });
});

describe("a photo that will not load", () => {
  test("the real client shows the file over studio-media://; when it fails, the large placeholder says so, and the next photo tries its own", async () => {
    const list = photos(2);
    const engine = new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0, avatars: [summary(list)], photos: list });
    render(<App client={{ ...mockEngineClient(engine), kind: "window" }} />);
    await showMia();
    fireEvent.click(openButton(1));

    const img = within(viewer()).getByRole("img", { name: "Фото 1 из 2: Дом" });
    expect(img.tagName).toBe("IMG");
    expect(img.getAttribute("src")).toBe(`studio-media://photo/${MIA.avatarId}/${scenePhoto(2).photoId}`);
    fireEvent.error(img);
    expect(within(viewer()).getByRole("img", { name: "Фото 1 из 2: Дом" }).classList.contains("portrait-placeholder")).toBe(true);
    expect(within(viewer()).getByText("Фото не открылось")).toBeDefined();

    press("ArrowRight");
    expect(within(viewer()).getByRole("img", { name: "Фото 2 из 2: Дом" }).tagName).toBe("IMG");
    expect(within(viewer()).queryByText("Фото не открылось") === null).toBe(true);
  });
});
