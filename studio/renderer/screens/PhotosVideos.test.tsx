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
});

describe("usage unknown (K16)", () => {
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

});

describe("the «Видео» tab", () => {
  test("«Новый монтаж» makes an empty draft for this avatar and opens it in the editor (option Б)", async () => {
    const h = await openMia({ tab: "videos" });
    fireEvent.click(screen.getByRole("button", { name: "Новый монтаж" }));
    await flush();
    expect(callsOf(h.engine, "montages.create").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId, photoIds: [] }]);
    await waitFor(() => expect(document.querySelector(".editor") !== null).toBe(true));
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

  // S4.9c (README decision 11): the trash asks in a dialog with two ways instead of on the card; a video that is not published starts on the plain delete,
  // as the card's confirmation did, with the photos it frees.
  test("«Удалить» asks with the photos it frees, then deletes the file and the record; the card goes", async () => {
    const h = await openMia({ tab: "videos" });
    let videoId = "";
    await act(async () => {
      videoId = await rendered(h, [scenePhoto(1).photoId, scenePhoto(2).photoId], "утро дома");
    });
    const video = await screen.findByRole("article", { name: "утро дома" });
    fireEvent.click(within(video).getByRole("button", { name: /^Удалить видео / }));
    const dialog = await screen.findByRole("alertdialog", { name: "Удалить видео «утро дома»?" });
    expect(dialog.querySelector(".ap-del-lead")?.textContent).toBe("Файл в «Готовых видео» тоже удалится.");
    const plain = within(dialog).getByRole("radio", { name: /^Только удалить видео/ });
    expect(plain.getAttribute("aria-checked")).toBe("true");
    expect(plain.textContent).toBe(`Только удалить видео2${NBSP}фото снова станут свободными — из них может собраться новое видео.`);
    expect(within(dialog).getByRole("radio", { name: /^Удалить видео и отклонить фото/ }).getAttribute("aria-checked")).toBe("false");
    expect(callsOf(h.engine, "videos.delete")).toHaveLength(0);

    fireEvent.click(within(dialog).getByRole("button", { name: "Удалить видео" }));
    await flush();

    expect(callsOf(h.engine, "videos.delete").map((c) => c.payload)).toEqual([{ videoId, mode: "video" }]);
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

});

describe("the avatar tile's «K видео»", () => {
});
