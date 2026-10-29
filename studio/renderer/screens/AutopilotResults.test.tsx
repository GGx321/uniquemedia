import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MIA } from "../engine/mockEngine.testkit";
import { callsOf, describeElement, flush, focusedLabel, openSection, setup } from "../testing";
import { historyLibrary, LINA, seedHistory } from "./autopilot/historyTestkit";

// S4.9c: a launch's page against the mock (AutopilotS4.dc.html states launch and delete-published; LaunchStates «Результаты», «Удалить видео», «Журнал»;
// plan §8.4, §8.5, §17 Q4): the settings in a line, the videos as tiles with «Опубликовано» (`videos.setPublished`) and the two-way delete (`videos.delete`,
// «и отклонить фото» chosen for a published video), «Скрыть опубликованные», a filter by avatar, what did not come out, and the whole log. Since S4.6g the marks and the
// deleted videos are `autopilot.get`'s word on each video (`videos.list` only draws the finished ones); an unreadable log is said and healed by a mark; a delete that
// fails or times out reads the lists again.

const NBSP = " ";

afterEach(() => {
  const hd: unknown = Reflect.get(window, "happyDOM");
  const setViewport: unknown = hd !== null && typeof hd === "object" ? Reflect.get(hd, "setViewport") : null;
  if (typeof setViewport === "function") Reflect.apply(setViewport, hd, [{ width: 1024, height: 768 }]);
});


/** The history seeded, «Автопилот» → «История запусков» → the newest launch's page (8 окт., 14:02). `before` runs on the mock first. */
async function openLatest(before: (engine: ReturnType<typeof setup>["engine"]) => void = () => undefined) {
  const h = setup(historyLibrary());
  const history = seedHistory(h.engine);
  before(h.engine);
  await flush();
  await openSection("Автопилот");
  await screen.findByRole("heading", { level: 1, name: "Автопилот" });
  await flush();
  fireEvent.click(screen.getByRole("button", { name: /^История запусков/ }));
  await screen.findByRole("heading", { level: 1, name: "История запусков" });
  await flush();
  fireEvent.click(within(screen.getByRole("region", { name: "Запуски" })).getAllByRole("button", { name: /^Запуск / })[0] ?? document.body);
  await screen.findByRole("heading", { level: 1, name: "Запуск 8 окт., 14:02" });
  await flush();
  await flush();
  return { ...h, history };
}

const tile = (label: string): HTMLElement => screen.getByRole("article", { name: label });
const tiles = (): string[] => screen.queryAllByRole("article").map((el) => el.getAttribute("aria-label") ?? "");
const publishedSwitch = (label: string): HTMLElement => within(tile(label)).getByRole("switch", { name: `Опубликовано: ${label}` });
const checked = (el: HTMLElement): string | null => el.getAttribute("aria-checked");
const results = (): HTMLElement => screen.getByRole("region", { name: "Видео" });
/** Where Tab goes from `from` inside `root`: the next element in document order the keyboard can stop on (a radio left out of the order by its group is not one). */
function nextTabStop(root: HTMLElement, from: HTMLElement): HTMLElement | null {
  const stops = Array.from(root.querySelectorAll<HTMLElement>("button, [tabindex]")).filter((el) => el.tabIndex >= 0 && !el.hasAttribute("disabled") && el.dataset.focusEdge === undefined);
  return stops[stops.indexOf(from) + 1] ?? null;
}

describe("a launch's page", () => {
  test("its title and status, what it was and what it ran with; the tiles as the design draws them", async () => {
    await openLatest();
    expect(document.querySelector(".ap-launch-title .ap-st")?.textContent).toBe("завершён");
    expect(document.querySelector(".ap-launch-meta")?.textContent).toBe(`3${NBSP}аватара · 6 из 9${NBSP}видео · потрачено $1.69 из $4.14 · 14:02–14:31`);
    expect(Array.from(document.querySelectorAll(".ap-launch-bits > span")).map((s) => s.textContent)).toEqual([
      "3 на аватар",
      "одно фото / коллаж / слайды · 70 / 20 / 10",
      "Дом, Виды, Улица, Фитнес",
      "сначала библиотека, недостающее — новыми",
      "сцены на проверку",
      "музыка: тренды + мои",
      "без стикеров",
    ]);
    expect(results().querySelector(".ap-res-bar > .mono")?.textContent).toBe(`6 · 14${NBSP}МБ`);
    expect(within(results()).getAllByRole("button", { pressed: false }).concat(within(results()).getAllByRole("button", { pressed: true })).map((b) => b.textContent)).toEqual(
      expect.arrayContaining(["Все 6", "Mia 3", "Sofia 2", "Elena 1"]),
    );
    expect(results().querySelector(".ap-res-hide")?.textContent).toBe("Скрыть опубликованные 1");
    expect(results().querySelector(".ap-res-dropped")?.textContent).toBe(`1${NBSP}видео не собралось: у Sofia — не хватило фото.`);
    expect(tiles()).toEqual(["видео 1 · Mia", "видео 2 · Mia", "видео 3 · Mia", "видео 1 · Sofia", "видео 2 · Sofia", "видео 1 · Elena", "видео 3 · Sofia"]);

    const first = tile("видео 1 · Mia");
    expect([first.querySelector(".ap-res-name")?.textContent, first.querySelector(".ap-res-meta")?.textContent, first.querySelector(".ap-res-music-text")?.textContent, first.querySelector(".ap-res-len")?.textContent]).toEqual([
      "Mia · видео 1",
      `одно фото · 1.8${NBSP}МБ`,
      "Golden Hour Loop — Lumi",
      `7.5${NBSP}с`,
    ]);
    expect(checked(publishedSwitch("видео 1 · Mia"))).toBe("true");
    expect(first.querySelector(".ap-res-pub") !== null).toBe(true);
    expect(tile("видео 3 · Mia").querySelector(".ap-res-music-text")?.textContent).toBe("summer-loop.m4a · мой");
    expect(tile("видео 3 · Mia").querySelectorAll(".ap-res-bars > span")).toHaveLength(6);
    // What did not come out: its reason, no mark, no trash.
    const dropped = tile("видео 3 · Sofia");
    expect(dropped.querySelector(".ap-res-status")?.textContent).toBe("Не собралось: не хватило фото.");
    expect(within(dropped).queryByRole("switch") === null).toBe(true);
    expect(within(dropped).queryByRole("button", { name: /^Удалить/ }) === null).toBe(true);
  });

  test("an avatar deleted after the launch, when the engine cannot look at the records: its tiles stay, inert — «аватар удалён», no «Опубликовано», no trash, no error to retry (fix round 1)", async () => {
    const h = setup(historyLibrary());
    seedHistory(h.engine);
    h.engine.loseTrackOfRecords();
    await act(async () => {
      const deleted = await h.client.request("avatars.delete", { avatarId: LINA.avatarId });
      if (!deleted.ok) throw new Error(deleted.error.code);
    });
    await flush();
    await openSection("Автопилот");
    await screen.findByRole("heading", { level: 1, name: "Автопилот" });
    await flush();
    fireEvent.click(screen.getByRole("button", { name: /^История запусков/ }));
    await screen.findByRole("heading", { level: 1, name: "История запусков" });
    await flush();
    fireEvent.click(within(screen.getByRole("region", { name: "Запуски" })).getAllByRole("button", { name: /^Запуск 7 окт\./ })[0] ?? document.body);
    await screen.findByRole("heading", { level: 1, name: "Запуск 7 окт., 18:40" });
    await flush();
    await flush();
    expect(tiles()).toEqual(["видео 1 · Mia", "видео 1 · удалённый аватар"]);
    const gone = tile("видео 1 · удалённый аватар");
    expect(gone.querySelector(".ap-res-status")?.textContent).toBe("аватар удалён");
    expect(within(gone).queryByRole("switch") === null).toBe(true);
    expect(within(gone).queryByRole("button") === null).toBe(true);
    expect(within(results()).queryByRole("button", { name: "Повторить" }) === null).toBe(true);
    expect(within(results()).queryByRole("alert") === null).toBe(true);
    // Mia's tile is as live as ever.
    expect(within(tile("видео 1 · Mia")).getByRole("switch", { name: "Опубликовано: видео 1 · Mia" })).toBeDefined();
  });

});

describe("«Опубликовано» and «Скрыть опубликованные»", () => {
  test("the switch sends the mark by id, the tile shows it, the focus stays on the switch", async () => {
    const { engine, history } = await openLatest();
    const second = publishedSwitch("видео 2 · Mia");
    second.focus();
    fireEvent.click(second);
    await flush();
    expect(callsOf(engine, "videos.setPublished").map((c) => c.payload)).toEqual([{ videoId: history.latest.videoIds[1], published: true }]);
    await waitFor(() => expect(checked(publishedSwitch("видео 2 · Mia"))).toBe("true"));
    expect(focusedLabel()).toBe(describeElement(publishedSwitch("видео 2 · Mia")));
    expect(results().querySelector(".ap-res-hide")?.textContent).toBe("Скрыть опубликованные 2");
    fireEvent.click(publishedSwitch("видео 2 · Mia"));
    await flush();
    await waitFor(() => expect(checked(publishedSwitch("видео 2 · Mia"))).toBe("false"));
    expect(callsOf(engine, "videos.setPublished").at(-1)?.payload).toEqual({ videoId: history.latest.videoIds[1], published: false });
  });

});

describe("«Удалить видео»", () => {
  // Fix round 1: the Enter that opens the dialog from the trash lands on the chosen way, held (auto-repeat) or pressed again; it must never delete. The
  // delete is the button's, reached by Tab from the way.
  test("Enter, repeated Enter and Enter right after opening never delete; the way stays chosen and the dialog open", async () => {
    const { engine } = await openLatest();
    const trash = within(tile("видео 1 · Mia")).getByRole("button", { name: "Удалить видео 1 · Mia" });
    trash.focus();
    // Enter on the trash is its click; the very next Enter, and the auto-repeat of a held one, reach the way the focus lands on.
    fireEvent.click(trash);
    const dialog = await screen.findByRole("alertdialog", { name: "Удалить видео 1 · Mia?" });
    const reject = within(dialog).getByRole("radio", { name: /^Удалить видео и отклонить фото/ });
    expect(focusedLabel()).toBe(describeElement(reject));
    fireEvent.keyDown(reject, { key: "Enter" });
    fireEvent.keyDown(reject, { key: "Enter", repeat: true });
    fireEvent.keyDown(reject, { key: "Enter", repeat: true });
    fireEvent.keyUp(reject, { key: "Enter" });
    fireEvent.keyDown(reject, { key: "Enter" });
    await flush();
    expect(callsOf(engine, "videos.delete")).toHaveLength(0);
    expect(screen.queryByRole("alertdialog") === null).toBe(false);
    expect(checked(reject)).toBe("true");
    // Not on the other way either.
    fireEvent.keyDown(reject, { key: "ArrowDown" });
    const plain = within(dialog).getByRole("radio", { name: /^Только удалить видео/ });
    fireEvent.keyDown(plain, { key: "Enter" });
    fireEvent.keyDown(plain, { key: "Enter", repeat: true });
    await flush();
    expect(callsOf(engine, "videos.delete")).toHaveLength(0);
    expect(checked(plain)).toBe("true");
  });

  test("a published video: «Удалить видео и отклонить фото» is chosen and focused; ↑ ↓ change the way and the button follows; Tab reaches the button, whose Enter or Space deletes with the way chosen", async () => {
    const { engine, client, history } = await openLatest();
    const trash = within(tile("видео 1 · Mia")).getByRole("button", { name: "Удалить видео 1 · Mia" });
    trash.focus();
    fireEvent.click(trash);
    const dialog = await screen.findByRole("alertdialog", { name: "Удалить видео 1 · Mia?" });
    // The trash keeps its highlight behind the scrim (ApDeletePublished).
    expect(trash.classList.contains("ap-res-trash-on")).toBe(true);
    expect(dialog.querySelector(".ap-st")?.textContent).toBe("опубликовано");
    expect(dialog.querySelector(".ap-del-lead")?.textContent).toBe("Файл в «Готовых видео» тоже удалится. Видео уже опубликовано — поэтому выбрано «отклонить фото»: эти кадры не уйдут в новый ролик.");
    const reject = within(dialog).getByRole("radio", { name: /^Удалить видео и отклонить фото/ });
    const plain = within(dialog).getByRole("radio", { name: /^Только удалить видео/ });
    expect([checked(reject), checked(plain)]).toEqual(["true", "false"]);
    expect(reject.textContent).toBe(`Удалить видео и отклонить фото1${NBSP}фото уйдёт в «Отклонённые» — автопилот его больше не возьмёт.`);
    expect(focusedLabel()).toBe(describeElement(reject));

    fireEvent.keyDown(reject, { key: "ArrowDown" });
    expect([checked(reject), checked(plain)]).toEqual(["false", "true"]);
    expect(focusedLabel()).toBe(describeElement(plain));
    expect(within(dialog).getByRole("button", { name: "Удалить видео" })).toBeDefined();
    fireEvent.keyDown(plain, { key: "ArrowUp" });
    expect(focusedLabel()).toBe(describeElement(reject));
    expect(within(dialog).getByRole("button", { name: "Удалить и отклонить фото" })).toBeDefined();
    expect(callsOf(engine, "videos.delete")).toHaveLength(0);

    // Tab from the chosen way: the next stop is the delete button (the other way is out of the Tab order, a radiogroup's own).
    const button = within(dialog).getByRole("button", { name: "Удалить и отклонить фото" });
    expect(describeElement(nextTabStop(dialog, reject))).toBe(describeElement(button));
    button.focus();
    // The button's Enter is the browser's own click on it (happy-dom does not make it, so the click stands for it): nothing swallows the key first.
    expect(fireEvent.keyDown(button, { key: "Enter" })).toBe(true);
    fireEvent.click(button);
    await flush();
    expect(callsOf(engine, "videos.delete").map((c) => c.payload)).toEqual([{ videoId: history.latest.videoIds[0], mode: "video", rejectPhotos: true }]);
    await waitFor(() => expect(tiles().includes("видео 1 · Mia")).toBe(false));
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
    expect(within(results()).getByRole("status").textContent).toBe(`Видео 1 · Mia удалено, 1${NBSP}фото отклонено.Закрыть`);
    expect(focusedLabel()).toBe(describeElement(tile("видео 2 · Mia")));
    let rejected = -1;
    await act(async () => {
      const photos = await client.request("photos.list", { avatarId: MIA.avatarId });
      rejected = photos.ok ? photos.result.photos.filter((p) => p.rejected).length : -1;
    });
    expect(rejected).toBe(1);
  });

  test("a video not published: the plain delete is chosen; Escape cancels with the focus back on the trash; «Удалить видео» frees the photos", async () => {
    const { engine, history } = await openLatest();
    const trash = (): HTMLElement => within(tile("видео 2 · Mia")).getByRole("button", { name: "Удалить видео 2 · Mia" });
    trash().focus();
    fireEvent.click(trash());
    const dialog = await screen.findByRole("alertdialog", { name: "Удалить видео 2 · Mia?" });
    expect(dialog.querySelector(".ap-st") === null).toBe(true);
    expect(checked(within(dialog).getByRole("radio", { name: /^Только удалить видео/ }))).toBe("true");
    fireEvent.keyDown(within(dialog).getByRole("radio", { name: /^Только удалить видео/ }), { key: "Escape" });
    await flush();
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
    expect(focusedLabel()).toBe(describeElement(trash()));

    fireEvent.click(trash());
    const again = await screen.findByRole("alertdialog");
    const chosen = within(again).getByRole("radio", { name: /^Только удалить видео/ });
    const button = within(again).getByRole("button", { name: "Удалить видео" });
    expect(describeElement(nextTabStop(again, chosen))).toBe(describeElement(button));
    button.focus();
    // Space on the button is the browser's click on it, as Enter is (the click stands for it here).
    expect(fireEvent.keyDown(button, { key: " " })).toBe(true);
    fireEvent.click(button);
    await flush();
    expect(callsOf(engine, "videos.delete").map((c) => c.payload)).toEqual([{ videoId: history.latest.videoIds[1], mode: "video" }]);
    await waitFor(() => expect(tiles().includes("видео 2 · Mia")).toBe(false));
    expect(within(results()).getByRole("status").textContent).toBe(`Видео 2 · Mia удалено, 3${NBSP}фото снова свободны.Закрыть`);
  });

  test("a delete that fails (the folder does not answer, or a timeout that reads the same): nothing is promised, the records and the photos are read again", async () => {
    const { engine } = await openLatest();
    engine.failNext("videos.delete", { code: "EXPORT_UNAVAILABLE", exportReason: "missing" });
    const reads = callsOf(engine, "videos.list").filter((c) => c.payload.avatarId === MIA.avatarId).length;
    const avatarReads = callsOf(engine, "avatars.list").length;
    const trash = within(tile("видео 1 · Mia")).getByRole("button", { name: "Удалить видео 1 · Mia" });
    trash.focus();
    fireEvent.click(trash);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Удалить и отклонить фото" }));
    await flush();
    await flush();
    const alert = within(results()).getByRole("alert");
    // Never «не удалено»: a timeout reads the same while the delete may still go on (fix round 1).
    expect(alert.querySelector(".notice-title")?.textContent).toBe("Удаление не подтвердилось — списки прочитаны заново");
    expect(alert.textContent).toContain("Фото, что успели уйти в «Отклонённые», там и останутся. Если видео осталось в списке, удалите его ещё раз, когда папка вернётся.");
    expect(callsOf(engine, "videos.list").filter((c) => c.payload.avatarId === MIA.avatarId).length).toBeGreaterThan(reads);
    expect(callsOf(engine, "avatars.list").length).toBeGreaterThan(avatarReads);
    expect(tiles().includes("видео 1 · Mia")).toBe(true);
    expect(focusedLabel()).toBe(describeElement(within(tile("видео 1 · Mia")).getByRole("button", { name: "Удалить видео 1 · Mia" })));
  });
});

describe("S4.6g: a delete whose outcome is not known", () => {
  test("a timeout says the delete may have gone on, reads the launch again, and the tile that is gone leaves", async () => {
    const { engine } = await openLatest();
    engine.timeOutNextDelete();
    const trash = within(tile("видео 2 · Mia")).getByRole("button", { name: "Удалить видео 2 · Mia" });
    trash.focus();
    fireEvent.click(trash);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Удалить видео" }));
    await flush();
    await flush();
    const alert = within(results()).getByRole("alert");
    expect(alert.querySelector(".notice-title")?.textContent).toBe("Удаление не подтвердилось — списки прочитаны заново");
    expect(alert.textContent).toContain("Папка «Готовые видео» не ответила вовремя, а удаление могло дойти до конца: видео могло уже удалиться.");
    expect(alert.textContent).not.toContain("нельзя записывать");
    // The mock did the work after all: the engine's word on the launch, read again, drops the tile.
    await waitFor(() => expect(tiles().includes("видео 2 · Mia")).toBe(false));
  });
});

