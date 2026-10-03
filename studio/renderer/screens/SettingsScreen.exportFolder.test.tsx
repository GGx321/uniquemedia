import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { EXPORT_UNAVAILABLE_REASONS_RU, ERROR_MESSAGES_RU, type EngineError } from "../../shared/engine";
import { EngineProvider } from "../engine/react";
import { MockEngine, mockEngineClient } from "../engine/mockEngine";
import { freePhotos, MIA, PHOTO_IDS } from "../engine/mockEngine.testkit";
import { ManualScheduler } from "../engine/scheduler";
import { NBSP } from "../lib/format";
import { createNavigation, NavigationProvider } from "../navigation";
import { ErrorNotice } from "../ui/Notice";
import { callsOf, describeElement, flush, focusedLabel, openSection, runAll, setup } from "../testing";
import { SettingsScreen } from "./SettingsScreen";

// 3e.3: the «Готовые видео» row of the «Папки и экспорт» card. The folder is picked in main's own dialog (the mock's stand-in:
// `pickExportFolderNext`), the path is main's display string, and the row says what a pick did to the videos already made.

const FIRST = "/Users/studio/Studio/export";
const REELS = "/Users/studio/Reels";
const PICK = "Изменить папку «Готовые видео»";
const [P1, P2, P3, P4] = PHOTO_IDS as [string, string, string, string, string, string];

async function openFolders(options: Parameters<typeof setup>[0] = {}) {
  const ctx = setup(options);
  await flush();
  await openSection("Настройки");
  await screen.findByRole("heading", { level: 2, name: "Папки и экспорт" });
  await flush();
  return ctx;
}

/** Two finished videos, made in the folder the mock starts with, through the same commands the editor will use. */
async function withTwoVideos() {
  const photos = freePhotos(6);
  const ctx = await openFolders({ avatars: [{ ...MIA, photoCount: photos.length, eligibleUnusedCount: photos.length }], photos });
  for (const ids of [[P1, P2], [P3, P4]]) {
    const created = await ctx.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: ids });
    if (!created.ok) throw new Error("the draft was not made");
    await ctx.client.request("videos.render", { montageId: created.result.montage.montageId });
    runAll(ctx.scheduler);
  }
  await flush();
  return ctx;
}

async function pick(ctx: Awaited<ReturnType<typeof openFolders>>, dialog: Parameters<MockEngine["pickExportFolderNext"]>[0]) {
  act(() => ctx.engine.pickExportFolderNext(dialog));
  fireEvent.click(screen.getByRole("button", { name: PICK }));
  await flush();
}

/** The «Папки и экспорт» card: the notices of the page's other cards are not this row's. */
const card = (): HTMLElement => {
  const section = screen.getByRole("heading", { level: 2, name: "Папки и экспорт" }).closest("section");
  if (!(section instanceof HTMLElement)) throw new Error("the folders card is missing");
  return section;
};

const notice = (role: "alert" | "status"): HTMLElement => within(card()).getByRole(role);

const row = (): HTMLElement => {
  const label = screen.getByText("Готовые видео", { selector: "b" });
  const found = label.closest(".row");
  if (!(found instanceof HTMLElement)) throw new Error("the export folder's row is missing");
  return found;
};

describe("the export folder's row", () => {
  test("shows the folder as main displays it, with the design's hint, and a button to change it", async () => {
    await openFolders();

    expect(within(row()).getByText("~/Studio/export")).toBeDefined();
    expect(within(row()).getByText("здесь хранятся готовые видео · Studio держит у себя только запись о каждом")).toBeDefined();
    expect(screen.getByRole("button", { name: PICK }).textContent).toBe("Изменить");
  });

  test("the path is the display string main gave, not the absolute path the settings hold", async () => {
    const { engine } = await openFolders();

    expect(callsOf(engine, "settings.exportDisplay")).toHaveLength(1);
    expect(screen.queryByText(FIRST) === null).toBe(true);
  });

  test("the library's own «Изменить» is still the only one by that name", async () => {
    await openFolders();

    expect(screen.getAllByRole("button", { name: "Изменить" })).toHaveLength(1);
  });

  test("sends the pick with no payload: the window never names the folder", async () => {
    const ctx = await openFolders();
    await pick(ctx, null);

    expect(callsOf(ctx.engine, "settings.setExportPath").map((c) => c.payload)).toEqual([{}]);
  });
});

describe("a pick", () => {
  test("a cancelled dialog changes nothing: the same path, no notice", async () => {
    const ctx = await openFolders();

    await pick(ctx, null);

    expect(within(row()).getByText("~/Studio/export")).toBeDefined();
    expect(screen.queryByText(/Папка выбрана/) === null).toBe(true);
  });

  test("a new folder becomes the path at once, and is announced", async () => {
    const ctx = await openFolders();

    await pick(ctx, { path: REELS });

    expect(within(row()).getByText("~/Reels")).toBeDefined();
    expect(notice("status").textContent).toContain("Папка выбрана.");
  });

  test("another folder leaves the videos made so far behind, says how many, and says how to get them back", async () => {
    const ctx = await withTwoVideos();

    await pick(ctx, { path: REELS });

    const alert = notice("alert");
    expect(alert.textContent).toContain(`Папка выбрана: 0${NBSP}видео на месте, 2${NBSP}видео остались в прежней папке.`);
    expect(alert.textContent).toContain("Они снова откроются, когда вы выберете прежнюю папку ещё раз.");
  });

  test("the first folder chosen again brings every video back", async () => {
    const ctx = await withTwoVideos();
    await pick(ctx, { path: REELS });

    await pick(ctx, { path: FIRST });

    expect(notice("status").textContent).toContain(`Папка выбрана: все 2${NBSP}видео на месте.`);
    expect(screen.queryByRole("alert") === null).toBe(true);
    expect(within(row()).getByText("~/Studio/export")).toBeDefined();
  });

  test("a folder the owner moved (the same marker) resolves every video", async () => {
    const ctx = await withTwoVideos();

    await pick(ctx, { path: "/Users/studio/Archive/export", movedFrom: FIRST });

    expect(notice("status").textContent).toContain(`Папка выбрана: все 2${NBSP}видео на месте.`);
    expect(within(row()).getByText("~/Archive/export")).toBeDefined();
  });

  test("a folder outside home is shown whole", async () => {
    const ctx = await openFolders();

    await pick(ctx, { path: "/Volumes/Reels" });

    expect(within(row()).getByText("/Volumes/Reels")).toBeDefined();
  });

  test("a cancel after a pick leaves the notice and the path as they were", async () => {
    const ctx = await withTwoVideos();
    await pick(ctx, { path: REELS });

    await pick(ctx, null);

    expect(notice("alert").textContent).toContain("остались в прежней папке");
    expect(within(row()).getByText("~/Reels")).toBeDefined();
  });
});

describe("a pick that is refused", () => {
  test.each([
    ["missing", "Папка не найдена."],
    ["not-a-directory", "По этому пути лежит файл, а не папка."],
    ["not-writable", "В эту папку нельзя записывать."],
    ["overlaps-library", "Папка «Готовые видео» не может быть внутри папки библиотеки или содержать её."],
    ["newer-marker", "Эту папку «Готовые видео» создала более новая версия Studio. Обновите приложение или выберите другую папку."],
  ] as const)("%s says why, and the old folder stays", async (refuse, why) => {
    const ctx = await openFolders();

    await pick(ctx, { path: REELS, refuse });

    const alert = notice("alert");
    expect(alert.textContent).toContain("Эту папку выбрать нельзя.");
    expect(alert.textContent).toContain(why);
    expect(alert.textContent).toContain("Прежняя папка осталась.");
    expect(within(row()).getByText("~/Studio/export")).toBeDefined();
  });

  test("a damaged marker with no video on record may name the file to delete, as the engine's text does", async () => {
    const ctx = await openFolders();

    await pick(ctx, { path: REELS, refuse: "invalid-marker" });

    expect(notice("alert").textContent).toContain(EXPORT_UNAVAILABLE_REASONS_RU["invalid-marker"]);
  });

  test("a damaged marker once videos exist is told apart, and never advises deleting, moving or renaming it", async () => {
    const ctx = await withTwoVideos();

    await pick(ctx, { path: REELS, refuse: "invalid-marker" });

    const text = notice("alert").textContent ?? "";
    expect(text).toContain(EXPORT_UNAVAILABLE_REASONS_RU["invalid-marker-with-records"]);
    expect(text).not.toMatch(/(?<!не )(удал|убер|сотр|переим|перенес|перемест)/i);
  });

  test("while a render runs the folder cannot be changed, and the row says to wait or cancel", async () => {
    const photos = freePhotos(6);
    const ctx = await openFolders({ avatars: [{ ...MIA, photoCount: photos.length, eligibleUnusedCount: photos.length }], photos });
    const created = await ctx.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [P1, P2] });
    if (!created.ok) throw new Error("the draft was not made");
    await ctx.client.request("videos.render", { montageId: created.result.montage.montageId });

    await pick(ctx, { path: REELS });

    expect(notice("alert").textContent).toContain("Пока идут рендеры, папку менять нельзя: дождитесь их конца или отмените их.");
    expect(within(row()).getByText("~/Studio/export")).toBeDefined();
  });

  test("any other error is shown as the ordinary text for it", async () => {
    const ctx = await openFolders();
    ctx.engine.failNext("settings.setExportPath", { code: "INTERNAL" } satisfies EngineError);

    await pick(ctx, { path: REELS });

    expect(notice("alert").textContent).toContain(ERROR_MESSAGES_RU.INTERNAL);
  });

  test("a later pick that works clears the refusal", async () => {
    const ctx = await openFolders();
    await pick(ctx, { path: REELS, refuse: "missing" });

    await pick(ctx, { path: REELS });

    expect(screen.queryByText(/Эту папку выбрать нельзя/) === null).toBe(true);
    expect(notice("status").textContent).toContain("Папка выбрана.");
  });
});

describe("the folder in use cannot be used", () => {
  async function unplug(ctx: Awaited<ReturnType<typeof openFolders>>, reason: "missing" | "invalid-marker") {
    act(() => ctx.engine.setExportDisk({ status: "unavailable", reason }));
    // The window comes back to the front: the store asks for a check and the engine announces what it found.
    await act(async () => {
      window.dispatchEvent(new Event("focus"));
    });
    await flush();
  }

  test("says so under the row, with the reason in Russian", async () => {
    const ctx = await openFolders();

    await unplug(ctx, "missing");

    const alert = notice("alert");
    expect(within(alert).getByText("Папка «Готовые видео» недоступна")).toBeDefined();
    expect(alert.textContent).toContain("Папка не найдена.");
  });

  test("a damaged marker while videos exist shows the text that never advises deleting the file", async () => {
    const ctx = await withTwoVideos();

    await unplug(ctx, "invalid-marker");

    const text = notice("alert").textContent ?? "";
    expect(text).toContain(EXPORT_UNAVAILABLE_REASONS_RU["invalid-marker-with-records"]);
    expect(text).not.toMatch(/(?<!не )(удал|убер|сотр|переим|перенес|перемест)/i);
  });

  test("goes away by itself when the disk is back and the window is looked at again", async () => {
    const ctx = await openFolders();
    await unplug(ctx, "missing");
    act(() => ctx.engine.setExportDisk({ status: "ok" }));

    fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
    await flush();

    expect(screen.queryByText("Папка «Готовые видео» недоступна") === null).toBe(true);
  });

  test("«Проверить снова» asks at once, whatever the focus throttle says", async () => {
    const ctx = await openFolders();
    await unplug(ctx, "missing");
    const before = callsOf(ctx.engine, "export.check").length;

    fireEvent.click(screen.getByRole("button", { name: "Проверить снова" }));
    await flush();

    expect(callsOf(ctx.engine, "export.check")).toHaveLength(before + 1);
  });

  test("a usable folder shows no notice at all", async () => {
    await openFolders();

    expect(screen.queryByText("Папка «Готовые видео» недоступна") === null).toBe(true);
    expect(screen.queryByRole("alert") === null).toBe(true);
  });

  test("a pick of a good folder clears it: the new folder is what the status is about", async () => {
    const ctx = await openFolders();
    await unplug(ctx, "missing");
    act(() => ctx.engine.setExportDisk({ status: "ok" }));

    await pick(ctx, { path: REELS });

    expect(screen.queryByText("Папка «Готовые видео» недоступна") === null).toBe(true);
  });
});

describe("the library row refused while renders run", () => {
  function changeLibrary(path: string): void {
    fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
    const input = screen.getByLabelText("Библиотека");
    fireEvent.change(input, { target: { value: path } });
    const form = input.closest("form");
    if (!form) throw new Error("library form missing");
    fireEvent.submit(form);
  }

  test("says it is the renders that hold the folder, and what to do, instead of the text about paid requests", async () => {
    const photos = freePhotos(6);
    const ctx = await openFolders({ avatars: [{ ...MIA, photoCount: photos.length, eligibleUnusedCount: photos.length }], photos });
    const created = await ctx.client.request("montages.create", { avatarId: MIA.avatarId, photoIds: [P1, P2] });
    if (!created.ok) throw new Error("the draft was not made");
    await ctx.client.request("videos.render", { montageId: created.result.montage.montageId });
    await flush();

    changeLibrary("/Volumes/Data/Studio");
    await flush();

    const text = notice("alert").textContent ?? "";
    expect(text).toContain("Пока идут рендеры, папку библиотеки менять нельзя: дождитесь их конца или отмените их.");
    expect(text).not.toContain(ERROR_MESSAGES_RU.IN_FLIGHT);
  });

  test("when no render is the reason (a paid request is), the ordinary text stays", async () => {
    const ctx = await openFolders();
    ctx.engine.failNext("settings.setLibraryPath", { code: "IN_FLIGHT" });

    changeLibrary("/Volumes/Data/Studio");
    await flush();

    expect(notice("alert").textContent).toContain(ERROR_MESSAGES_RU.IN_FLIGHT);
  });
});

describe("a pick whose counts are not whole", () => {
  test("is warned about, and does not say that every video is there", async () => {
    const ctx = await withTwoVideos();

    await pick(ctx, { path: "/Users/studio/Archive/export", movedFrom: FIRST, incomplete: true });

    const text = notice("alert").textContent ?? "";
    expect(text).toContain(`Папка выбрана: 2${NBSP}видео на месте.`);
    expect(text).not.toContain("все");
    expect(text).toContain("Часть записей о видео прочитать не удалось");
  });
});

describe("the link from an EXPORT_UNAVAILABLE notice", () => {
  test("the notice offers «Открыть папку в Настройках», which goes to Settings with the export card as its focus", () => {
    const visited: unknown[] = [];
    render(
      <NavigationProvider value={createNavigation((route) => { visited.push(route); })}>
        <ErrorNotice error={{ code: "EXPORT_UNAVAILABLE", exportReason: "missing" }} />
      </NavigationProvider>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Открыть папку в Настройках" }));

    expect(visited).toEqual([{ name: "settings", focus: "export" }]);
  });

  test("Settings opened with that focus lands on the «Папки и экспорт» card", async () => {
    const engine = new MockEngine({ scheduler: new ManualScheduler() });
    render(
      <EngineProvider client={mockEngineClient(engine)}>
        <SettingsScreen focus="export" />
      </EngineProvider>,
    );
    await flush();

    expect(focusedLabel()).toBe(describeElement(await screen.findByRole("heading", { level: 2, name: "Папки и экспорт" })));
  });
});
