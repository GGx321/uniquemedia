import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { USAGE_UNKNOWN_REASONS_RU, type AvatarSummary, type PhotoSummary } from "../../shared/engine";
import { MIA, scenePhoto } from "../engine/mockEngine.testkit";
import { callsOf, describeElement, flush, focusedLabel, runAll, setup, tick } from "../testing";

// 3e.2: the Photos screen as the owner uses it: the header's counts from the avatar's summary (refreshed by `avatar.changed`),
// the «использование неизвестно» state with its two recoveries, the gallery's filters with reject and restore, and the «Видео»
// tab: «Новый монтаж», each record in its file state with its actions, the render jobs as cards, the filter, the folder.

const NBSP = " ";
const photos = (n: number, patch: (i: number) => Partial<PhotoSummary> = () => ({})): PhotoSummary[] => Array.from({ length: n }, (_, i) => scenePhoto(i + 1, patch(i + 1)));
const summary = (list: readonly PhotoSummary[], patch: Partial<AvatarSummary> = {}): AvatarSummary => ({
  ...MIA,
  photoCount: list.length,
  eligibleUnusedCount: list.filter((p) => p.eligible && !p.used && !p.reserved).length,
  ...patch,
});

async function openMia(options: Parameters<typeof setup>[0] & { tab?: "videos" } = {}) {
  const list = options.photos ?? photos(6);
  const harness = setup({ avatars: [summary(list)], photos: list, ...options });
  fireEvent.click(await screen.findByRole("button", { name: "Mia" }));
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  await flush();
  if (options.tab === "videos") {
    fireEvent.click(screen.getByRole("tab", { name: "Видео" }));
    await flush();
  }
  return harness;
}

const headerText = (): string => document.querySelector(".photos-sub")?.textContent ?? "";

/** A rendered video of the given photos, made through the engine's own commands, run to its end. */
async function rendered(h: Awaited<ReturnType<typeof openMia>>, photoIds: string[], name: string | null = null): Promise<string> {
  const reply = await h.client.request("montages.create", { avatarId: MIA.avatarId, photoIds });
  if (!reply.ok) throw new Error(reply.error.code);
  const { montage } = reply.result;
  if (name !== null) await h.client.request("montages.save", { montageId: montage.montageId, spec: montage.spec, name });
  const render = await h.client.request("videos.render", { montageId: montage.montageId });
  if (!render.ok) throw new Error(render.error.code);
  runAll(h.scheduler);
  await flush();
  return render.result.videoId;
}

const card = (name: string): HTMLElement => screen.getByRole("article", { name });

describe("the header: «N фото · M не использовано · K видео»", () => {
  test("reads the avatar's summary, and follows avatar.changed (a reject moves the unused count)", async () => {
    const h = await openMia();
    expect(headerText()).toBe(`6${NBSP}фото · 6${NBSP}не использовано · 0${NBSP}видео`);

    await act(async () => {
      await h.client.request("photos.setRejected", { avatarId: MIA.avatarId, photoId: scenePhoto(1).photoId, rejected: true });
    });
    await flush();

    expect(headerText()).toBe(`6${NBSP}фото · 5${NBSP}не использовано · 0${NBSP}видео`);
  });

  test("a video made moves the video count and the unused one", async () => {
    const h = await openMia();
    await act(async () => {
      await rendered(h, [scenePhoto(1).photoId, scenePhoto(2).photoId]);
    });
    await waitFor(() => expect(headerText()).toBe(`6${NBSP}фото · 4${NBSP}не использовано · 1${NBSP}видео`));
  });
});

describe("usage unknown (K16)", () => {
  test("the header says «использование неизвестно» instead of a count, and the notice says why, for each reason", async () => {
    const list = photos(3);
    await openMia({ photos: list, avatars: [summary(list, { eligibleUnusedCount: 0, usage: { state: "unknown", reasons: ["library-too-new", "record-unreadable"] } })] });
    expect(headerText()).toBe(`3${NBSP}фото · использование неизвестно · 0${NBSP}видео`);
    const notice = screen.getByRole("alert", { name: "" });
    expect(within(notice).getByText("Использование фото неизвестно")).toBeDefined();
    expect(within(notice).getByText(USAGE_UNKNOWN_REASONS_RU["library-too-new"])).toBeDefined();
    expect(within(notice).getByText(USAGE_UNKNOWN_REASONS_RU["record-unreadable"])).toBeDefined();
    // A newer record offers nothing to press; a broken record offers its quarantine.
    expect(within(notice).getAllByRole("button").map((b) => b.textContent)).toEqual(["Убрать повреждённую запись"]);
  });

  test("«Убрать повреждённую запись» asks first, then sends the quarantine; the avatar trusted again, the notice goes and says what was done", async () => {
    const list = photos(3);
    const h = await openMia({ photos: list, avatars: [summary(list, { eligibleUnusedCount: 0, usage: { state: "unknown", reasons: ["record-unreadable"] } })] });
    fireEvent.click(screen.getByRole("button", { name: "Убрать повреждённую запись" }));
    expect(screen.getByText(/переедут в карантин библиотеки/)).toBeDefined();
    expect(callsOf(h.engine, "videos.quarantineRecords")).toHaveLength(0);

    const confirm = screen.getAllByRole("button", { name: "Убрать повреждённую запись" }).at(-1);
    fireEvent.click(confirm ?? document.body);
    await flush();

    expect(callsOf(h.engine, "videos.quarantineRecords").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId }]);
    await waitFor(() => expect(headerText()).toBe(`3${NBSP}фото · 3${NBSP}не использовано · 0${NBSP}видео`));
    expect(screen.queryByText("Использование фото неизвестно") === null).toBe(true);
    expect(screen.getByText(`В карантин библиотеки убрана 1 запись.`)).toBeDefined();
  });

  test("«Восстановить отметки» asks first, then rebuilds; «Отмена» sends nothing", async () => {
    const list = photos(3, (i) => (i === 1 ? { rejected: true, eligible: false } : {}));
    const h = await openMia({ photos: list, avatars: [summary(list, { eligibleUnusedCount: 0, usage: { state: "unknown", reasons: ["rejects-unreadable"] } })] });
    fireEvent.click(screen.getByRole("button", { name: "Восстановить отметки" }));
    expect(screen.getByText(/копию журнала отметок/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Отмена" }));
    expect(callsOf(h.engine, "photos.rebuildRejected")).toHaveLength(0);

    fireEvent.click(screen.getByRole("button", { name: "Восстановить отметки" }));
    fireEvent.click(screen.getAllByRole("button", { name: "Восстановить отметки" }).at(-1) ?? document.body);
    await flush();

    expect(callsOf(h.engine, "photos.rebuildRejected").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId }]);
    await waitFor(() => expect(screen.queryByText("Использование фото неизвестно") === null).toBe(true));
    // The answer counts lines of the log, not marks: the text says lines.
    expect(screen.getByText("Журнал отметок восстановлен. Строк журнала сохранено: 1, убрано нечитаемых: 1. Копия прежнего журнала — в карантине библиотеки.")).toBeDefined();
  });

  test("while the marks cannot be read, no tile can be rejected or restored: the button says why", async () => {
    const list = photos(2);
    await openMia({ photos: list, avatars: [summary(list, { eligibleUnusedCount: 0, usage: { state: "unknown", reasons: ["rejects-unreadable"] } })] });
    const mark = await screen.findByRole("button", { name: "Фото 1: отклонить — в видео не брать" });
    expect((mark as HTMLButtonElement).disabled).toBe(true);
    expect(mark.getAttribute("title")).toMatch(/сначала восстановите отметки/);
  });
});

describe("the gallery's filters and the reject mark", () => {
  const list = [scenePhoto(1), scenePhoto(2, { used: true, usedIn: ["video-00000001"] }), scenePhoto(3, { reserved: true }), scenePhoto(4, { rejected: true, eligible: false })];

  test("«Неиспользованные» shows what a montage may take; «Отклонённые» the owner's marks; «Все» everything", async () => {
    await openMia({ photos: list });
    const tiles = (): number => document.querySelectorAll(".photos-gallery .photo-tile").length;
    expect(tiles()).toBe(4);
    fireEvent.click(screen.getByRole("button", { name: "Неиспользованные" }));
    expect(tiles()).toBe(1);
    expect(screen.getByRole("button", { name: "Неиспользованные" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "Отклонённые" }));
    expect(tiles()).toBe(1);
    expect(screen.getByText("отклонено")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Все" }));
    expect(tiles()).toBe(4);
  });

  test("a tile's mark rejects the photo (it leaves the selection), and the same button restores it", async () => {
    const h = await openMia({ photos: [scenePhoto(1), scenePhoto(2)] });
    const pick = await screen.findByRole("button", { name: /Выбрать для монтажа: фото 2/ });
    fireEvent.click(pick);
    expect(screen.getByRole("button", { name: /Монтаж из выбранных/ }).textContent).toBe("Монтаж из выбранных · 1");

    fireEvent.click(screen.getByRole("button", { name: "Фото 2: отклонить — в видео не брать" }));
    await flush();

    expect(callsOf(h.engine, "photos.setRejected").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId, photoId: scenePhoto(1).photoId, rejected: true }]);
    expect(screen.getByRole("button", { name: /Монтаж из выбранных/ }).textContent).toBe("Монтаж из выбранных · 0");
    const restore = await screen.findByRole("button", { name: "Фото 2: вернуть из отклонённых" });
    fireEvent.click(restore);
    await flush();
    expect(callsOf(h.engine, "photos.setRejected").at(-1)?.payload).toEqual({ avatarId: MIA.avatarId, photoId: scenePhoto(1).photoId, rejected: false });
    expect(await screen.findByRole("button", { name: "Фото 2: отклонить — в видео не брать" })).toBeDefined();
  });

  test("«Неиспользованные» is empty, and says why, while the usage cannot be trusted", async () => {
    const list2 = photos(2);
    await openMia({ photos: list2, avatars: [summary(list2, { eligibleUnusedCount: 0, usage: { state: "unknown", reasons: ["index-stale"] } })] });
    fireEvent.click(screen.getByRole("button", { name: "Неиспользованные" }));
    expect(screen.getByText("Свободные фото не известны")).toBeDefined();
  });
});

describe("the «Видео» tab", () => {
  test("«Новый монтаж» makes an empty draft for this avatar and opens it in the editor (option Б)", async () => {
    const h = await openMia({ tab: "videos" });
    fireEvent.click(screen.getByRole("button", { name: "Новый монтаж" }));
    await flush();
    expect(callsOf(h.engine, "montages.create").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId, photoIds: [] }]);
    await waitFor(() => expect(document.querySelector(".editor") !== null).toBe(true));
  });

  test("an archived avatar has no «Новый монтаж»", async () => {
    const list = photos(1);
    await openMia({ tab: "videos", photos: list, avatars: [summary(list, { status: "archived" })] });
    expect(screen.queryByRole("button", { name: "Новый монтаж" }) === null).toBe(true);
    expect(screen.getByText("Видео пока нет")).toBeDefined();
  });

  test("a video in the export folder: its card, «Открыть в папке» by id, «Изменить» opens its draft", async () => {
    const h = await openMia({ tab: "videos" });
    await act(async () => {
      await rendered(h, [scenePhoto(1).photoId, scenePhoto(2).photoId], "утро дома");
    });
    const video = await screen.findByRole("article", { name: "утро дома" });
    expect(within(video).getByText("✓ в «Готовых видео»")).toBeDefined();
    expect(within(video).getByText(`8.0 с · 2 фото · 3.5 МБ`)).toBeDefined();
    expect(within(video).getByText("без музыки")).toBeDefined();

    fireEvent.click(within(video).getByRole("button", { name: "Открыть в папке" }));
    await flush();
    expect(h.engine.revealed).toHaveLength(1);

    fireEvent.click(within(video).getByRole("button", { name: "Изменить" }));
    await waitFor(() => expect(document.querySelector(".editor") !== null).toBe(true));
  });

  test("«Удалить» asks with the photos it frees, then deletes the file and the record; the card goes", async () => {
    const h = await openMia({ tab: "videos" });
    await act(async () => {
      await rendered(h, [scenePhoto(1).photoId, scenePhoto(2).photoId], "утро дома");
    });
    const video = await screen.findByRole("article", { name: "утро дома" });
    fireEvent.click(within(video).getByRole("button", { name: /^Удалить видео / }));
    expect(within(video).getByRole("alert").textContent).toBe(`Удалить видео? Файл в «Готовых видео» тоже удалится, 2${NBSP}фото снова станут свободными.`);

    fireEvent.click(within(video).getByRole("button", { name: "Удалить" }));
    await flush();

    expect(callsOf(h.engine, "videos.delete").map((c) => c.payload.mode)).toEqual(["video"]);
    await waitFor(() => expect(screen.queryByRole("article", { name: "утро дома" }) === null).toBe(true));
  });

  test("a file deleted outside Studio: «Файл удалён», and «Удалить запись» at once frees the photos", async () => {
    const h = await openMia({ tab: "videos" });
    let videoId = "";
    await act(async () => {
      videoId = await rendered(h, [scenePhoto(1).photoId], "пляж");
    });
    h.engine.setVideoFileState(videoId, "missing");
    fireEvent.click(screen.getByRole("button", { name: /^Все/ }));
    fireEvent.click(screen.getByRole("tab", { name: "Фото" }));
    fireEvent.click(screen.getByRole("tab", { name: "Видео" }));
    await flush();

    const video = await screen.findByRole("article", { name: "пляж" });
    expect(within(video).getByText("Файл удалён")).toBeDefined();
    expect(within(video).getByText(`Файл удалён из «Готовых видео». Пока есть запись, 1 фото считается занятым.`)).toBeDefined();
    expect(within(video).queryByRole("button", { name: "Открыть в папке" }) === null).toBe(true);

    fireEvent.click(within(video).getByRole("button", { name: "Удалить запись" }));
    await flush();
    expect(callsOf(h.engine, "videos.delete").map((c) => c.payload)).toEqual([{ videoId, mode: "record" }]);
    expect(await screen.findByText("Запись удалена, фото снова свободны.")).toBeDefined();
  });

  test("while the export folder cannot be looked in, «Удалить запись» and its outcome never say «в прежней папке»", async () => {
    const h = await openMia({ tab: "videos" });
    await act(async () => {
      await rendered(h, [scenePhoto(1).photoId], "пляж");
    });
    h.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    fireEvent.click(screen.getByRole("tab", { name: "Фото" }));
    fireEvent.click(screen.getByRole("tab", { name: "Видео" }));
    await flush();

    const video = await screen.findByRole("article", { name: "пляж" });
    expect(within(video).getByText("Не проверен")).toBeDefined();
    fireEvent.click(within(video).getByRole("button", { name: "Удалить запись" }));
    expect(within(video).getByRole("alert").textContent).toBe("Удалить запись? Файл останется там, где он есть, а фото снова станут свободными.");
    fireEvent.click(within(video).getAllByRole("button", { name: "Удалить запись" }).at(-1) ?? document.body);
    await flush();
    expect(await screen.findByText("Запись удалена, фото снова свободны. Файл, если он есть, остался на месте.")).toBeDefined();
    expect(screen.queryByText(/прежней папке/) === null).toBe(true);
  });

  test("a video in another export folder: «Удалить запись» only behind the owner's confirmation (Q6)", async () => {
    const h = await openMia({ tab: "videos" });
    let videoId = "";
    await act(async () => {
      videoId = await rendered(h, [scenePhoto(1).photoId], "пляж");
    });
    h.engine.moveExportFolder();
    fireEvent.click(screen.getByRole("tab", { name: "Фото" }));
    fireEvent.click(screen.getByRole("tab", { name: "Видео" }));
    await flush();

    const video = await screen.findByRole("article", { name: "пляж" });
    expect(within(video).getByText("Другая папка")).toBeDefined();
    fireEvent.click(within(video).getByRole("button", { name: "Удалить запись" }));
    expect(within(video).getByRole("alert").textContent).toBe("Удалить запись? Файл останется в прежней папке, а фото снова станут свободными.");
    expect(callsOf(h.engine, "videos.delete")).toHaveLength(0);
    fireEvent.click(within(video).getAllByRole("button", { name: "Удалить запись" }).at(-1) ?? document.body);
    await flush();
    expect(callsOf(h.engine, "videos.delete").map((c) => c.payload)).toEqual([{ videoId, mode: "record" }]);
  });

  test("while the export folder is unavailable, every record says «не удалось проверить» (never «another folder»), with the folder's notice", async () => {
    const h = await openMia({ tab: "videos" });
    await act(async () => {
      await rendered(h, [scenePhoto(1).photoId], "пляж");
    });
    h.engine.setExportDisk({ status: "unavailable", reason: "missing" });
    fireEvent.click(screen.getByRole("tab", { name: "Фото" }));
    fireEvent.click(screen.getByRole("tab", { name: "Видео" }));
    await flush();
    await flush();

    const video = await screen.findByRole("article", { name: "пляж" });
    expect(within(video).getByText(/^Не удалось проверить файл: папка «Готовые видео» сейчас недоступна/)).toBeDefined();
    expect(within(video).queryByText(/другой папке/) === null).toBe(true);
    expect(screen.getByText("Папка «Готовые видео» недоступна")).toBeDefined();
  });

  test("a file Studio could not look at (`unchecked`): «Не проверен», and «Проверить снова» reads the list again", async () => {
    const h = await openMia({ tab: "videos" });
    let videoId = "";
    await act(async () => {
      videoId = await rendered(h, [scenePhoto(1).photoId], "пляж");
    });
    h.engine.setVideoFileState(videoId, "unchecked");
    fireEvent.click(screen.getByRole("tab", { name: "Фото" }));
    fireEvent.click(screen.getByRole("tab", { name: "Видео" }));
    await flush();
    const video = await screen.findByRole("article", { name: "пляж" });
    expect(within(video).getByText("Не проверен")).toBeDefined();
    const lists = callsOf(h.engine, "videos.list").length;

    h.engine.setVideoFileState(videoId, null);
    fireEvent.click(within(video).getByRole("button", { name: "Проверить снова" }));
    await flush();

    expect(callsOf(h.engine, "videos.list").length).toBe(lists + 1);
    expect(await within(screen.getByRole("article", { name: "пляж" })).findByText("✓ в «Готовых видео»")).toBeDefined();
  });

  test("a file changed outside Studio: «Изменён», playable, no «Открыть в папке», «Удалить запись» confirms the file stays", async () => {
    const h = await openMia({ tab: "videos" });
    let videoId = "";
    await act(async () => {
      videoId = await rendered(h, [scenePhoto(1).photoId], "пляж");
    });
    h.engine.setVideoFileState(videoId, "changed");
    fireEvent.click(screen.getByRole("tab", { name: "Фото" }));
    fireEvent.click(screen.getByRole("tab", { name: "Видео" }));
    await flush();
    const video = await screen.findByRole("article", { name: "пляж" });
    expect(within(video).getByText("Изменён")).toBeDefined();
    expect(within(video).getByRole("button", { name: "Смотреть видео «пляж»" })).toBeDefined();
    expect(within(video).queryByRole("button", { name: "Открыть в папке" }) === null).toBe(true);
    fireEvent.click(within(video).getByRole("button", { name: "Удалить запись" }));
    expect(within(video).getByRole("alert").textContent).toMatch(/Файл останется в «Готовых видео»/);
  });

  test("«Смотреть» opens the player by id; Escape closes it", async () => {
    const h = await openMia({ tab: "videos" });
    await act(async () => {
      await rendered(h, [scenePhoto(1).photoId], "пляж");
    });
    const video = await screen.findByRole("article", { name: "пляж" });
    fireEvent.click(within(video).getByRole("button", { name: "Смотреть видео «пляж»" }));
    const dialog = screen.getByRole("dialog", { name: "пляж" });
    expect(dialog).toBeDefined();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(screen.queryByRole("dialog") === null).toBe(true);
  });

  test("the player holds the focus like the photo viewer: Tab stays inside it, and closing gives the focus back to «Смотреть»", async () => {
    const h = await openMia({ tab: "videos" });
    await act(async () => {
      await rendered(h, [scenePhoto(1).photoId], "пляж");
    });
    const watch = within(await screen.findByRole("article", { name: "пляж" })).getByRole("button", { name: "Смотреть видео «пляж»" });
    watch.focus();
    fireEvent.click(watch);
    const close = within(screen.getByRole("dialog", { name: "пляж" })).getByRole("button", { name: "Закрыть" });
    expect(focusedLabel()).toBe(describeElement(close));
    // «Закрыть» is the only control (the dev mock plays no video): Tab either way keeps the focus on it.
    expect(fireEvent.keyDown(close, { key: "Tab" })).toBe(false);
    expect(fireEvent.keyDown(close, { key: "Tab", shiftKey: true })).toBe(false);
    expect(focusedLabel()).toBe(describeElement(close));
    // A focus that strayed behind the dialog is brought back by the next Tab.
    watch.focus();
    expect(fireEvent.keyDown(watch, { key: "Tab" })).toBe(false);
    expect(focusedLabel()).toBe(describeElement(close));
    fireEvent.keyDown(window, { key: "Escape" });
    expect(focusedLabel()).toBe(describeElement(watch));
  });

  test("renders on their way are cards: running with its frames and «Отменить», queued «после 1 рендера» with «Убрать из очереди»", async () => {
    const h = await openMia({ tab: "videos" });
    const make = async (photoIds: string[], name: string): Promise<void> => {
      const reply = await h.client.request("montages.create", { avatarId: MIA.avatarId, photoIds });
      if (!reply.ok) throw new Error(reply.error.code);
      await h.client.request("montages.save", { montageId: reply.result.montage.montageId, spec: reply.result.montage.spec, name });
      await h.client.request("videos.render", { montageId: reply.result.montage.montageId });
    };
    await act(async () => {
      await make([scenePhoto(1).photoId, scenePhoto(2).photoId], "первый");
      await make([scenePhoto(3).photoId], "второй");
    });
    tick(h.scheduler, 1);
    await flush();

    const running = await screen.findByRole("article", { name: "первый" });
    expect(within(running).getByRole("progressbar", { name: "Рендер: первый" })).toBeDefined();
    const queued = screen.getByRole("article", { name: "второй" });
    expect(within(queued).getByText(`в очереди · после 1 рендера`)).toBeDefined();
    expect(screen.getByRole("button", { name: /^В работе/ }).textContent).toBe("В работе 2");

    fireEvent.click(within(queued).getByRole("button", { name: "Убрать из очереди" }));
    await flush();
    expect(callsOf(h.engine, "videos.cancel")).toHaveLength(1);
    await waitFor(() => expect(screen.queryByRole("article", { name: "второй" }) === null).toBe(true));
  });

  test("a failed render is a card «Не собралось» with «Повторить», which queues its draft again; the card can be dismissed", async () => {
    const h = await openMia({ tab: "videos" });
    h.engine.failNextRender({ code: "RENDER_FAILED" });
    await act(async () => {
      const reply = await h.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [scenePhoto(1).photoId] });
      if (!reply.ok) throw new Error(reply.error.code);
      await h.client.request("montages.save", { montageId: reply.result.montage.montageId, spec: reply.result.montage.spec, name: "сбой" });
      await h.client.request("videos.render", { montageId: reply.result.montage.montageId });
    });
    runAll(h.scheduler);
    await flush();

    const failed = await screen.findByRole("article", { name: "сбой" });
    expect(within(failed).getByText("Не собралось: сборка не удалась. Фото остались свободными.")).toBeDefined();
    expect(screen.getByRole("button", { name: /^С ошибкой/ }).textContent).toBe("С ошибкой 1");
    fireEvent.click(within(failed).getByRole("button", { name: "Повторить" }));
    await flush();
    expect(callsOf(h.engine, "videos.render")).toHaveLength(2);
  });

  test("a record that lands after its render's job.failed wins: the failed card turns into the video", async () => {
    const h = await openMia({ tab: "videos" });
    h.engine.failNextRender({ code: "EXPORT_UNAVAILABLE", exportReason: "not-writable" }, "late");
    await act(async () => {
      const reply = await h.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [scenePhoto(1).photoId] });
      if (!reply.ok) throw new Error(reply.error.code);
      await h.client.request("montages.save", { montageId: reply.result.montage.montageId, spec: reply.result.montage.spec, name: "поздний" });
      await h.client.request("videos.render", { montageId: reply.result.montage.montageId });
    });
    tick(h.scheduler, 6);
    await flush();
    expect(within(await screen.findByRole("article", { name: "поздний" })).getByText("Не собралось: папка «Готовые видео» недоступна. Фото остались свободными.")).toBeDefined();

    runAll(h.scheduler);
    await flush();

    const video = await screen.findByRole("article", { name: "поздний" });
    await waitFor(() => expect(within(video).getByText("✓ в «Готовых видео»")).toBeDefined());
    expect(screen.getAllByRole("article", { name: "поздний" })).toHaveLength(1);
  });

  test("«Папка «Готовые видео»» opens the avatar's folder by its id; the path is shown as a person reads it", async () => {
    const h = await openMia({ tab: "videos" });
    await act(async () => {
      await rendered(h, [scenePhoto(1).photoId], "пляж");
    });
    expect(await screen.findByText("~/Studio/export/Mia")).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Папка «Готовые видео»" }));
    await flush();
    expect(callsOf(h.engine, "videos.revealFolder").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId }]);
  });

  test("the tab's sum: «N · X МБ · сначала новые»", async () => {
    const h = await openMia({ tab: "videos" });
    await act(async () => {
      await rendered(h, [scenePhoto(1).photoId], "пляж");
    });
    expect(await screen.findByText(/^1 · \d+ МБ · сначала новые$/)).toBeDefined();
  });
});

describe("the avatar tile's «K видео»", () => {
  test("opens the avatar's «Видео» tab", async () => {
    const list = photos(2);
    setup({ avatars: [summary(list, { videoCount: 3 })], photos: list });
    fireEvent.click(await screen.findByRole("button", { name: "Видео аватара Mia: 3" }));
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    expect(screen.getByRole("tab", { name: "Видео" }).getAttribute("aria-selected")).toBe("true");
  });
});
