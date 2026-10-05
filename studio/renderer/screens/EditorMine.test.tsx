import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ERROR_MESSAGES_RU, type MontageDraft, mediaReasonRu } from "../../shared/engine";
import type { MockEngine, MockMediaPick } from "../engine/mockEngine";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import { callsOf, describeElement, flush, focusedLabel } from "../testing";
import { AUTOSAVE_DEBOUNCE_MS } from "./montage/autosave";
import { asAnotherWindow, makeDraft, MIA, openDrafts, paidMusicCalls, studio as openStudio } from "./montage/screenKit";
import { collageClip, photoClip } from "./montage/testkit";

// 3f.6: the «Мои» tab in the editor (EditorMine.dc.html; M1–M12, M14, M15). The drop zone asks MAIN for its dialog (`media.pickImport
// {kind: "any"}`: a kind and nothing else); the owner's files are listed (`media.list`) and kept current by `media.changed`; a click places
// a photo or video by the «Фото» tab's rules, a track becomes the music from 0, a sticker a layer at the playhead: each one undo step. A
// pick's refusals and an import's failure are told in the kind's own words; an import on its way shows on its tile and in the status card,
// and can be cancelled; a file can be deleted after a confirmation, and one a render uses is refused honestly.

const opened: MockEngine[] = [];
async function studio(): ReturnType<typeof openStudio> {
  const harness = await openStudio();
  opened.push(harness.engine);
  return harness;
}
afterEach(() => {
  for (const engine of opened.splice(0)) expect(paidMusicCalls(engine)).toEqual([]);
});

const IDS = PHOTO_IDS.slice(0, 4);
const PHOTO = "media-demo-0001";
const VIDEO = "media-demo-0002";
const SONG = "media-demo-0003";
const NOTE = "media-demo-0004";
const STICKER = "media-demo-0005";

/** The library: a photo, a 6.4 s video, a 42 s track, a 5 s track (shorter than the 8 s montage) and a sticker; listed newest first. */
function seed(engine: MockEngine): void {
  engine.seedOwnMedia([
    { kind: "photo", name: "croissant.jpg", bytes: 900_000, createdAt: "2026-10-01T10:00:00.000Z" },
    { kind: "video", name: "latte-pour.mov", bytes: 40_000_000, facts: { width: 1080, height: 1920, durationMs: 6_400, sourceFps: 60, hdrToSdr: true }, createdAt: "2026-10-01T10:01:00.000Z" },
    { kind: "audio", name: "summer-edit.mp3", bytes: 1_000_000, facts: { durationMs: 42_000 }, createdAt: "2026-10-01T10:02:00.000Z" },
    { kind: "audio", name: "voice-note.m4a", bytes: 90_000, facts: { durationMs: 5_000 }, createdAt: "2026-10-01T10:03:00.000Z" },
    { kind: "sticker", name: "underline.gif", bytes: 40_000, createdAt: "2026-10-01T10:04:00.000Z" },
  ]);
}

const media = (): HTMLElement => screen.getByRole("complementary", { name: "Медиа" });
const timeline = (): HTMLElement => screen.getByRole("region", { name: "Таймлайн" });
const section = (name: string): HTMLElement => within(media()).getByRole("region", { name });
const plain = (text: string | null | undefined): string => (text ?? "").replace(/ /g, " ");
const undo = (): void => void fireEvent.click(screen.getByRole("button", { name: "Отменить" }));

/** A draft of four 2 s photo clips (8.0 s), with `patch`, saved as another window would; opened, on «Мои». */
async function openMine(engine: MockEngine, client: Parameters<typeof makeDraft>[0], patch: Partial<MontageDraft> = {}): Promise<void> {
  const made = await makeDraft(client, MIA.avatarId, []);
  const spec: MontageDraft = { ...made.spec, clips: IDS.map((photoId, i) => photoClip(i, photoId, 2_000)), ...patch };
  const saved = await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec, name: null }));
  if (!saved.ok) throw new Error(`montages.save: ${saved.error.code}`);
  await openDrafts();
  await screen.findByRole("heading", { level: 3, name: /Mia/ });
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();
  for (let i = engine.calls.length - 1; i >= 0; i--) if (engine.calls[i]?.type === "montages.save") engine.calls.splice(i, 1);
  fireEvent.click(within(media()).getByRole("tab", { name: "Мои" }));
  await flush();
}

async function nextSave(engine: MockEngine): Promise<MontageDraft> {
  await waitFor(() => expect(callsOf(engine, "montages.save").length).toBeGreaterThan(0), { timeout: AUTOSAVE_DEBOUNCE_MS * 4 });
  const last = callsOf(engine, "montages.save").at(-1);
  if (last === undefined) throw new Error("no save");
  return last.payload.spec;
}

const clipLabels = (): string[] => within(within(timeline()).getByRole("list", { name: "Кадры" })).getAllByRole("button").flatMap((b) => {
  const label = b.getAttribute("aria-label") ?? "";
  return label.startsWith("Кадр ") ? [plain(label)] : [];
});

describe("the tab: the drop zone and the owner's files in three sections", () => {
  test("«Мои» is open; the sections count their files; a video says its length and the clip holding it", async () => {
    const { client, engine } = await studio();
    seed(engine);
    await openMine(engine, client, { clips: [photoClip(0, IDS[0] ?? "", 2_000), { clipId: "clip-002", durationMs: 2_000, transitionIn: "cut", kind: "video", mediaId: VIDEO, trimStartMs: 0, focus: null }] });
    expect(within(media()).getByRole("button", { name: /Добавить файлы/ })).toBeDefined();
    expect(plain(within(media()).getByRole("button", { name: /Добавить файлы/ }).textContent)).toBe("Добавить файлыфото, видео, музыка, стикеры · перетащите или нажмите");
    expect(plain(section("Фото и видео").querySelector(".lbl")?.textContent)).toBe("Фото и видео · 2");
    expect(plain(section("Музыка").querySelector(".lbl")?.textContent)).toBe("Музыка · 2");
    expect(plain(section("Стикеры").querySelector(".lbl")?.textContent)).toBe("Стикеры · 1");
    const video = within(section("Фото и видео")).getByRole("button", { name: /^Видео latte-pour\.mov/ });
    expect(plain(video.getAttribute("aria-label"))).toBe("Видео latte-pour.mov, 0:06 · в кадре 2: выбрать кадр 2");
    const tile = video.closest("li");
    expect(plain(tile?.querySelector(".mine-dur")?.textContent)).toBe("0:06");
    expect(tile?.querySelector(".mine-slot")?.textContent).toBe("2");
    // The tab lists every own file (no kind, no ids); the editor asks by id for the files the draft names.
    expect(callsOf(engine, "media.list").some((c) => c.payload.kind === undefined && c.payload.mediaIds === undefined)).toBe(true);
  });

  test("an empty library says what goes here", async () => {
    const { client, engine } = await studio();
    await openMine(engine, client);
    expect(within(media()).getByText("Своих файлов пока нет")).toBeDefined();
  });

  test("a file stored meanwhile (another window's import) shows up first, one deleted elsewhere goes", async () => {
    const { client, engine } = await studio();
    seed(engine);
    await openMine(engine, client);
    await asAnotherWindow(() => client.request("media.delete", { mediaId: PHOTO }));
    expect(within(section("Фото и видео")).queryByRole("button", { name: /croissant/ }) === null).toBe(true);
    expect(plain(section("Фото и видео").querySelector(".lbl")?.textContent)).toBe("Фото и видео · 1");
  });
});

describe("placing own files (M7, M11, M12): each is one undo step", () => {
  test("a photo: a clip at the end with the own source; its face is asked of the engine; one undo takes it back", async () => {
    const { client, engine } = await studio();
    seed(engine);
    await openMine(engine, client);
    fireEvent.click(within(section("Фото и видео")).getByRole("button", { name: "Фото croissant.jpg: добавить кадр в конец ролика" }));
    await flush();
    const saved = await nextSave(engine);
    expect(saved.clips[4]).toMatchObject({ kind: "photo", durationMs: 2_000, cell: { photo: { source: "own", mediaId: PHOTO } } });
    expect(callsOf(engine, "montages.focus").map((c) => c.payload.photo)).toEqual([{ source: "own", mediaId: PHOTO }]);
    expect(clipLabels()).toHaveLength(5);
    undo();
    await flush();
    expect(clipLabels()).toHaveLength(4);
  });

  test("a video: a 2 s clip from its start, then its tile selects that clip instead of adding another", async () => {
    const { client, engine } = await studio();
    seed(engine);
    await openMine(engine, client);
    fireEvent.click(within(section("Фото и видео")).getByRole("button", { name: /^Видео latte-pour\.mov, 0:06: добавить кадр/ }));
    await flush();
    const saved = await nextSave(engine);
    expect(saved.clips[4]).toMatchObject({ kind: "video", mediaId: VIDEO, trimStartMs: 0, durationMs: 2_000, focus: null });
    const placed = within(section("Фото и видео")).getByRole("button", { name: /^Видео latte-pour\.mov, 0:06 · в кадре 5/ });
    fireEvent.click(placed);
    await flush();
    expect(clipLabels()).toHaveLength(5);
  });

  test("a photo fills the empty cell the selected clip waits with", async () => {
    const { client, engine } = await studio();
    seed(engine);
    await openMine(engine, client, { clips: [collageClip(0, [null, IDS[0] ?? ""], 4_000, false), photoClip(1, IDS[1] ?? "", 2_000)] });
    // Selecting the collage selects its first cell, the empty one.
    fireEvent.click(within(timeline()).getByRole("button", { name: /^Кадр 1: коллаж 2/ }));
    await flush();
    expect(plain(within(section("Фото и видео")).getByRole("button", { name: /^Видео latte-pour/ }).getAttribute("aria-label"))).toBe("Видео latte-pour.mov, 0:06: добавить кадр в конец ролика");
    fireEvent.click(within(section("Фото и видео")).getByRole("button", { name: "Фото croissant.jpg: в ячейку 1 кадра 1" }));
    await flush();
    const saved = await nextSave(engine);
    const first = saved.clips[0];
    expect(first?.kind === "collage" ? first.cells[0]?.photo : null).toEqual({ source: "own", mediaId: PHOTO });
    expect(saved.clips).toHaveLength(2);
  });

  test("3-H1: an own photo in a cell is judged for its face as a scene photo is («ищем лицо…» until the answer), and the cell shows the photo", async () => {
    const { client, engine, scheduler } = await studio();
    seed(engine);
    await openMine(engine, client, { clips: [collageClip(0, [null, IDS[0] ?? ""], 4_000, false), photoClip(1, IDS[1] ?? "", 2_000)] });
    fireEvent.click(within(timeline()).getByRole("button", { name: /^Кадр 1: коллаж 2/ }));
    await flush();
    engine.delayNext("montages.focus", 1_000);
    fireEvent.click(within(section("Фото и видео")).getByRole("button", { name: "Фото croissant.jpg: в ячейку 1 кадра 1" }));
    await flush();
    const props = (): HTMLElement => screen.getByRole("complementary", { name: "Свойства" });
    expect(within(props()).getByText("ищем лицо…")).toBeDefined();
    expect(within(props()).getByRole("img", { name: "Ячейка 1" })).toBeDefined();
    act(() => scheduler.runAll());
    await flush();
    expect(within(props()).queryByText("ищем лицо…") === null).toBe(true);
  });

  test("slice review 5-M5: with a filled cell the owner selected, a photo replaces that cell's photo; a video still goes to the end", async () => {
    const { client, engine } = await studio();
    seed(engine);
    await openMine(engine, client);
    fireEvent.click(within(timeline()).getByRole("button", { name: /^Кадр 2: / }));
    await flush();
    expect(plain(within(section("Фото и видео")).getByRole("button", { name: /^Видео latte-pour/ }).getAttribute("aria-label"))).toBe("Видео latte-pour.mov, 0:06: добавить кадр в конец ролика");
    fireEvent.click(within(section("Фото и видео")).getByRole("button", { name: "Фото croissant.jpg: заменить фото в ячейке 1 кадра 2" }));
    await flush();
    const saved = await nextSave(engine);
    expect(saved.clips).toHaveLength(4);
    expect(saved.clips[1]).toMatchObject({ kind: "photo", cell: { photo: { source: "own", mediaId: PHOTO }, focus: null } });
    undo();
    await flush();
    expect(clipLabels()).toHaveLength(4);
  });

  test("dragged onto «Кадры», a video becomes a clip at the boundary under the pointer", async () => {
    const { client, engine } = await studio();
    seed(engine);
    await openMine(engine, client);
    const lane = timeline().querySelector(".ed-lane-clips");
    if (lane === null) throw new Error("no clip lane");
    fireEvent.dragStart(within(section("Фото и видео")).getByRole("button", { name: /^Видео latte-pour\.mov/ }));
    fireEvent.dragOver(lane, { clientX: 0 });
    fireEvent.drop(lane, { clientX: 0 });
    await flush();
    const saved = await nextSave(engine);
    expect(saved.clips[0]).toMatchObject({ kind: "video", mediaId: VIDEO, durationMs: 2_000 });
    expect(saved.clips).toHaveLength(5);
  });

  test("a track becomes the music from 0; one shorter than the montage is dimmed and picks nothing (M10)", async () => {
    const { client, engine } = await studio();
    seed(engine);
    await openMine(engine, client);
    const short = within(section("Музыка")).getByRole("button", { name: /^voice-note\.m4a/ });
    expect(short.getAttribute("aria-disabled")).toBe("true");
    expect(plain(short.getAttribute("aria-label"))).toBe("voice-note.m4a, 0:05, свой трек, короче ролика (8.0 с), не выбрать");
    fireEvent.click(short);
    await flush();
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
    fireEvent.click(within(section("Музыка")).getByRole("button", { name: /^summer-edit\.mp3/ }));
    const saved = await nextSave(engine);
    expect(saved.music).toEqual({ source: "own", mediaId: SONG, startMs: 0 });
    expect(plain(within(section("Музыка")).getByRole("button", { name: /^summer-edit\.mp3/ }).textContent)).toBe("summer-edit.mp30:42 · ✓ в ролике");
  });

  test("listening: in the dev mock there is no audio, so the button says why and plays nothing", async () => {
    const { client, engine } = await studio();
    seed(engine);
    await openMine(engine, client);
    const listen = within(section("Музыка")).getByRole("button", { name: "Послушать summer-edit.mp3" });
    expect(listen.hasAttribute("disabled")).toBe(true);
    expect(listen.getAttribute("title")).toBe("Прослушать нельзя: звук этого файла недоступен");
  });

  test("a sticker: a layer at the playhead with the own source, selected", async () => {
    const { client, engine } = await studio();
    seed(engine);
    await openMine(engine, client);
    fireEvent.click(within(section("Стикеры")).getByRole("button", { name: "Стикер underline.gif: в плейхед" }));
    const saved = await nextSave(engine);
    expect(saved.layers).toEqual([expect.objectContaining({ kind: "sticker", startMs: 0, endMs: 3_000, sticker: { source: "own", mediaId: STICKER } })]);
    expect(within(section("Стикеры")).getByRole("button", { name: "Стикер underline.gif: в плейхед, в ролике 1, у выбранного слоя" })).toBeDefined();
  });
});

describe("adding files through main's dialog (M1, M6, M14, M15)", () => {
  const ACCEPTED: MockMediaPick[] = [
    { name: "street-walk.mp4", accept: { kind: "video", bytes: 120_000_000, facts: { durationMs: 12_000, sourceFps: 60, hdrToSdr: true } } },
    { name: "beach.jpg", accept: { kind: "photo", bytes: 2_000_000 } },
  ];
  const REFUSED: MockMediaPick = { name: "track.wma", reason: "format" };

  test("the drop zone sends a kind and nothing else; a refused file is said with its reason, the others are on their way, then added", async () => {
    const { client, engine, scheduler } = await studio();
    await openMine(engine, client);
    engine.pickMediaNext([ACCEPTED[0] ?? REFUSED, REFUSED, ACCEPTED[1] ?? REFUSED]);
    fireEvent.click(within(media()).getByRole("button", { name: /Добавить файлы/ }));
    await flush();
    expect(callsOf(engine, "media.pickImport").map((c) => c.payload)).toEqual([{ kind: "any" }]);
    const card = within(media()).getByRole("alert");
    expect(plain(card.textContent)).toContain("track.wma не подходит");
    expect(plain(card.textContent)).toContain(mediaReasonRu("format"));
    expect(plain(card.textContent)).toContain("Остальные 2 файла добавляем.");
    // The one that runs is in the status card and on its tile; the other waits.
    expect(plain(within(media()).getByRole("status").textContent)).toContain("Копируем street-walk.mp4");
    expect(within(section("Фото и видео")).getByRole("listitem", { name: /^Видео street-walk\.mp4: добавляется, 0 %$/ })).toBeDefined();
    expect(within(section("Фото и видео")).getByRole("listitem", { name: "Фото beach.jpg: в очереди" })).toBeDefined();
    act(() => scheduler.runAll());
    await flush();
    expect(plain(within(media()).getByRole("alert").textContent)).toContain("Остальные 2 файла добавлены.");
    expect(within(section("Фото и видео")).getByRole("button", { name: "Фото beach.jpg: добавить кадр в конец ролика" })).toBeDefined();
    fireEvent.click(within(media()).getByRole("button", { name: "Закрыть: track.wma не подходит" }));
    expect(within(media()).queryByRole("alert") === null).toBe(true);
  });

  test("an import on its way can be cancelled: nothing is stored, and the owner's own cancel tells nothing", async () => {
    const { client, engine, scheduler } = await studio();
    await openMine(engine, client);
    engine.pickMediaNext([ACCEPTED[0] ?? REFUSED]);
    fireEvent.click(within(media()).getByRole("button", { name: /Добавить файлы/ }));
    await flush();
    fireEvent.click(within(section("Фото и видео")).getByRole("button", { name: "Отменить добавление street-walk.mp4" }));
    await flush();
    expect(callsOf(engine, "media.cancelImport")).toHaveLength(1);
    expect(plain(within(media()).getByRole("status").textContent)).toContain("Отменяем street-walk.mp4");
    act(() => scheduler.runAll());
    await flush();
    expect(within(media()).queryByRole("alert") === null).toBe(true);
    expect(within(media()).getByText("Своих файлов пока нет")).toBeDefined();
  });

  test("a file the kind's importer refuses is told in the KIND's words (video), and the owner closes it", async () => {
    const { client, engine, scheduler } = await studio();
    await openMine(engine, client);
    engine.pickMediaNext([{ name: "clip.webm", accept: { kind: "video", bytes: 900, failWith: "codec" } }]);
    fireEvent.click(within(media()).getByRole("button", { name: /Добавить файлы/ }));
    await flush();
    act(() => scheduler.runAll());
    await flush();
    const card = within(media()).getByRole("alert");
    expect(plain(card.textContent)).toBe(`clip.webm не подходит${mediaReasonRu("codec", "video")}`);
    fireEvent.click(within(card).getByRole("button", { name: "Закрыть: clip.webm не подходит" }));
    expect(within(media()).queryByRole("alert") === null).toBe(true);
  });

  test("a dialog cancelled is nothing; a pick the engine refused is said", async () => {
    const { client, engine } = await studio();
    await openMine(engine, client);
    fireEvent.click(within(media()).getByRole("button", { name: /Добавить файлы/ }));
    await flush();
    expect(within(media()).queryByRole("alert") === null).toBe(true);
    engine.failNext("media.pickImport", { code: "LIBRARY_UNAVAILABLE" });
    fireEvent.click(within(media()).getByRole("button", { name: /Добавить файлы/ }));
    await flush();
    expect(plain(within(media()).getByRole("alert").textContent)).toContain(ERROR_MESSAGES_RU.LIBRARY_UNAVAILABLE);
  });
});

describe("deleting a file", () => {
  test("after a confirmation that says what this montage loses, the file goes; the draft's clip is then flagged by the engine", async () => {
    const { client, engine } = await studio();
    seed(engine);
    await openMine(engine, client, { clips: [...IDS.slice(0, 3).map((id, i) => photoClip(i, id, 2_000)), { clipId: "clip-004", durationMs: 2_000, transitionIn: "cut", kind: "video", mediaId: VIDEO, trimStartMs: 0, focus: null }] });
    const gets = callsOf(engine, "montages.get").length;
    fireEvent.click(within(section("Фото и видео")).getByRole("button", { name: "Удалить latte-pour.mov" }));
    const confirm = within(media()).getByRole("alert");
    expect(plain(confirm.textContent)).toContain("Удалить «latte-pour.mov»?");
    expect(plain(confirm.textContent)).toContain("В этом ролике он в кадре 4 — кадр будет помечен, пока его не замените.");
    fireEvent.click(within(confirm).getByRole("button", { name: "Удалить" }));
    await flush();
    expect(callsOf(engine, "media.delete").map((c) => c.payload)).toEqual([{ mediaId: VIDEO }]);
    expect(within(section("Фото и видео")).queryByRole("button", { name: /latte-pour/ }) === null).toBe(true);
    // 3f.3b: the editor reads the engine's verdict again on a media.changed about the draft's own file.
    await waitFor(() => expect(callsOf(engine, "montages.get").length).toBeGreaterThan(gets));
  });

  test("«Отмена» deletes nothing", async () => {
    const { client, engine } = await studio();
    seed(engine);
    await openMine(engine, client);
    fireEvent.click(within(section("Фото и видео")).getByRole("button", { name: "Удалить croissant.jpg" }));
    fireEvent.click(within(within(media()).getByRole("alert")).getByRole("button", { name: "Отмена" }));
    expect(callsOf(engine, "media.delete")).toHaveLength(0);
    expect(within(section("Фото и видео")).getByRole("button", { name: /^Фото croissant/ })).toBeDefined();
  });

  test("the keyboard (slice review 5-M4): asked, the focus is on «Отмена»; Escape, «Отмена» and a refusal's «Понятно» give it back to the tile's trash; deleted, it lands on «Добавить файлы»", async () => {
    const { client, engine } = await studio();
    seed(engine);
    await openMine(engine, client);
    const trash = (): HTMLElement => within(section("Фото и видео")).getByRole("button", { name: "Удалить croissant.jpg" });
    const confirm = (): HTMLElement => within(media()).getByRole("alert");
    const ask = async (): Promise<void> => {
      trash().focus();
      fireEvent.click(trash());
      await flush();
    };

    await ask();
    expect(focusedLabel()).toBe(describeElement(within(confirm()).getByRole("button", { name: "Отмена" })));
    fireEvent.keyDown(within(confirm()).getByRole("button", { name: "Отмена" }), { key: "Escape" });
    await flush();
    expect(within(media()).queryByRole("alert") === null).toBe(true);
    expect(focusedLabel()).toBe(describeElement(trash()));

    await ask();
    fireEvent.click(within(confirm()).getByRole("button", { name: "Отмена" }));
    await flush();
    expect(focusedLabel()).toBe(describeElement(trash()));

    engine.failNext("media.delete", { code: "IN_FLIGHT", detail: "a queued or running render uses this media" });
    await ask();
    fireEvent.click(within(confirm()).getByRole("button", { name: "Удалить" }));
    await flush();
    expect(focusedLabel()).toBe(describeElement(within(confirm()).getByRole("button", { name: "Понятно" })));
    fireEvent.click(within(confirm()).getByRole("button", { name: "Понятно" }));
    await flush();
    expect(focusedLabel()).toBe(describeElement(trash()));

    await ask();
    fireEvent.click(within(confirm()).getByRole("button", { name: "Удалить" }));
    await flush();
    expect(within(section("Фото и видео")).queryByRole("button", { name: "Удалить croissant.jpg" }) === null).toBe(true);
    expect(focusedLabel()).toBe(describeElement(within(media()).getByRole("button", { name: /^Добавить файлы/ })));
  });

  test("a file a render uses is refused honestly (IN_FLIGHT): nothing is deleted, and the tile stays", async () => {
    const { client, engine } = await studio();
    seed(engine);
    await openMine(engine, client);
    engine.failNext("media.delete", { code: "IN_FLIGHT", detail: "a queued or running render uses this media" });
    fireEvent.click(within(section("Музыка")).getByRole("button", { name: "Удалить summer-edit.mp3" }));
    fireEvent.click(within(within(media()).getByRole("alert")).getByRole("button", { name: "Удалить" }));
    await flush();
    expect(plain(within(media()).getByRole("alert").textContent)).toContain("«summer-edit.mp3» используется в рендере — его нельзя удалить, пока рендер не закончится. Ничего не удалено.");
    expect(within(section("Музыка")).getByRole("button", { name: /^summer-edit\.mp3/ })).toBeDefined();
  });
});

describe("the engine away", () => {
  test("a listing that fails says why and offers to try again", async () => {
    const { client, engine } = await studio();
    seed(engine);
    engine.failNext("media.list", { code: "LIBRARY_UNAVAILABLE" });
    await openMine(engine, client);
    expect(plain(within(media()).getByRole("alert").textContent)).toContain(ERROR_MESSAGES_RU.LIBRARY_UNAVAILABLE);
    fireEvent.click(within(media()).getByRole("button", { name: "Повторить" }));
    await flush();
    expect(within(section("Фото и видео")).getByRole("button", { name: /^Фото croissant/ })).toBeDefined();
  });
});
