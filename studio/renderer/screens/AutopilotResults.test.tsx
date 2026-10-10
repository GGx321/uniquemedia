import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { LaunchDraftInput, LogLine } from "../../shared/engine";
import { App } from "../App";
import type { EngineClient } from "../engine/client";
import { MockEngine, mockEngineClient } from "../engine/mockEngine";
import { MIA, SOFIA } from "../engine/mockEngine.testkit";
import { ManualScheduler } from "../engine/scheduler";
import { callsOf, describeElement, flush, focusedLabel, openSection, setup } from "../testing";
import { ELENA, historyLibrary, LINA, octAt, seedHistory } from "./autopilot/historyTestkit";
import { LOG_PAGE } from "./autopilot/LaunchScreen";

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

function wideWindow(): void {
  const hd: unknown = Reflect.get(window, "happyDOM");
  const setViewport: unknown = hd !== null && typeof hd === "object" ? Reflect.get(hd, "setViewport") : null;
  if (typeof setViewport === "function") Reflect.apply(setViewport, hd, [{ width: 1440, height: 900 }]);
}

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
      "Дом, Путешествия, Фотосессия на телефон, Фитнес",
      "анфас и три четверти",
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

  test("S4.6g (N7): an avatar deleted after the launch took its videos with it — the engine calls them removed, so no tile is left and «Все N» does not count them", async () => {
    const h = setup(historyLibrary());
    seedHistory(h.engine);
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
    // The history counts what stands: Mia's one video of the two the launch made.
    expect(within(screen.getByRole("region", { name: "Запуски" })).getAllByRole("button", { name: /^Запуск 7 окт\./ })[0]?.textContent).toContain("1 из 2");
    fireEvent.click(within(screen.getByRole("region", { name: "Запуски" })).getAllByRole("button", { name: /^Запуск 7 окт\./ })[0] ?? document.body);
    await screen.findByRole("heading", { level: 1, name: "Запуск 7 окт., 18:40" });
    await flush();
    await flush();
    expect(tiles()).toEqual(["видео 1 · Mia"]);
    expect(results().querySelector(".ap-res-bar > .mono")?.textContent).toMatch(/^1 · /);
    // S4.9d (S4.6g L8): no empty chip for an avatar the library no longer holds and whose videos are all gone; with one avatar left there is nothing to filter
    // (review L6): no group at all, and «Папка «Готовые видео»» is that avatar's.
    expect(within(results()).queryByRole("button", { name: /^удалённый аватар/ }) === null).toBe(true);
    expect(within(results()).queryByRole("group", { name: "Аватар" }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Папка «Готовые видео»" }));
    await flush();
    expect(callsOf(h.engine, "videos.revealFolder").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId }]);
    expect(within(results()).queryByRole("alert") === null).toBe(true);
  });

  test("the filter by avatar shows one avatar's videos", async () => {
    const { engine } = await openLatest();
    fireEvent.click(within(results()).getByRole("button", { name: "Sofia 2" }));
    expect(tiles()).toEqual(["видео 1 · Sofia", "видео 2 · Sofia", "видео 3 · Sofia"]);
    expect(within(results()).getByRole("button", { name: "Sofia 2" }).getAttribute("aria-pressed")).toBe("true");
    // One avatar on screen: its folder can be opened.
    fireEvent.click(screen.getByRole("button", { name: "Папка «Готовые видео»" }));
    await flush();
    expect(callsOf(engine, "videos.revealFolder").map((c) => c.payload)).toEqual([{ avatarId: SOFIA.avatarId }]);
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

  test("«Скрыть опубликованные» hides the published tiles and says so; a tile marked while they are hidden leaves, and the focus goes to the next one", async () => {
    await openLatest();
    // The live region clears itself a moment after it speaks: its words are recorded as they change, one observer for the one step (happy-dom holds an
    // observer's callback only weakly).
    const region = document.querySelector('[data-announcer="results"]');
    if (region === null) throw new Error("no live region on the results");
    const said: string[] = [];
    const watch = new MutationObserver(() => said.push(region.textContent ?? ""));
    watch.observe(region, { childList: true, characterData: true, subtree: true });
    try {
      fireEvent.click(within(results()).getByRole("switch", { name: /^Скрыть опубликованные/ }));
      await flush();
    } finally {
      watch.disconnect();
    }
    expect(said).toEqual(["Опубликованные видео скрыты: 1"]);
    expect(tiles().includes("видео 1 · Mia")).toBe(false);
    const second = publishedSwitch("видео 2 · Mia");
    second.focus();
    fireEvent.click(second);
    await flush();
    await waitFor(() => expect(tiles().includes("видео 2 · Mia")).toBe(false));
    expect(focusedLabel()).toBe(describeElement(tile("видео 3 · Mia")));
  });

  test("a tile marked while hidden that does not leave (the launch read again, and still shows it) hands the focus nowhere later (fix round 1)", async () => {
    const { engine } = await openLatest((mock) => mock.tearPublishedLog(MIA.avatarId));
    fireEvent.click(within(results()).getByRole("switch", { name: /^Скрыть опубликованные/ }));
    // The mark goes, but both reads of the launch after it fail: the tile stays as the last answer says (unmarked).
    engine.failNext("autopilot.get", { code: "INTERNAL", detail: "the launch could not be read" });
    engine.failNext("autopilot.get", { code: "INTERNAL", detail: "the launch could not be read" });
    const second = publishedSwitch("видео 2 · Mia");
    second.focus();
    fireEvent.click(second);
    await flush();
    await flush();
    expect(tiles().includes("видео 2 · Mia")).toBe(true);
    // Later the tile leaves for another reason (the filter): the focus is not pulled away from where the owner is.
    const sofia = within(results()).getByRole("button", { name: "Sofia 2" });
    sofia.focus();
    fireEvent.click(sofia);
    await flush();
    expect(tiles().includes("видео 2 · Mia")).toBe(false);
    expect(focusedLabel()).toBe(describeElement(sofia));
  });

  test("marks that cannot be read: a notice, every tile unmarked; a mark heals the log, the launch is read again and the marks are back", async () => {
    const { engine } = await openLatest((mock) => mock.tearPublishedLog(MIA.avatarId));
    const notice = within(results()).getByRole("status");
    expect(notice.textContent).toBe("Отметки «Опубликовано» у Mia не читаются — эти видео показаны без отметки. Studio по ним ничего не удаляет; новая отметка допишется.");
    expect(checked(publishedSwitch("видео 1 · Mia"))).toBe("false");
    const reads = callsOf(engine, "autopilot.get").length;
    fireEvent.click(publishedSwitch("видео 2 · Mia"));
    await flush();
    await flush();
    expect(callsOf(engine, "autopilot.get").length).toBeGreaterThan(reads);
    await waitFor(() => expect(checked(publishedSwitch("видео 1 · Mia"))).toBe("true"));
    expect(checked(publishedSwitch("видео 2 · Mia"))).toBe("true");
    expect(within(results()).queryByText(/не читаются/) === null).toBe(true);
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

  test("while the marks cannot be read the dialog cannot know a video is published: it starts on the plain delete and says why (Q4, fix round 1)", async () => {
    await openLatest((mock) => mock.tearPublishedLog(MIA.avatarId));
    fireEvent.click(within(tile("видео 1 · Mia")).getByRole("button", { name: "Удалить видео 1 · Mia" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Удалить видео 1 · Mia?" });
    expect(checked(within(dialog).getByRole("radio", { name: /^Только удалить видео/ }))).toBe("true");
    expect(dialog.querySelector(".ap-del-lead")?.textContent).toBe(
      "Файл в «Готовых видео» тоже удалится. Отметка «Опубликовано» не читается: если видео уже опубликовано, выберите «Удалить видео и отклонить фото».",
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
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

describe("«Журнал» of the launch", () => {
  test("«Потрачено $S из $W′», the lines newest first, «Показать раньше» past the first page", async () => {
    const h = setup(historyLibrary());
    const lines: LogLine[] = Array.from({ length: LOG_PAGE + 30 }, (_, i) => ({ at: new Date(Date.parse(octAt(9, 10, 0)) + i * 1000).toISOString(), avatarId: MIA.avatarId, kind: "photo", done: (i % 14) + 1, total: 14 }));
    h.engine.seedLaunch({
      createdAt: octAt(9, 10, 0),
      endedAt: octAt(9, 10, 30),
      draft: { avatarIds: [MIA.avatarId], videosPerAvatar: 1 },
      acceptedMicros: 1_050_000,
      plannedWorstMicros: 1_050_000,
      spentMicros: 330_000,
      videos: [{ avatarId: MIA.avatarId, shape: "single", size: 1, state: "done" }],
      log: [{ at: octAt(9, 10, 0), kind: "start", acceptedMicros: 1_050_000 }, ...lines, { at: octAt(9, 10, 30), kind: "done", videosDone: 1, videosPlanned: 1 }],
    });
    await flush();
    await openSection("Автопилот");
    await screen.findByRole("heading", { level: 1, name: "Автопилот" });
    fireEvent.click(screen.getByRole("button", { name: /^История запусков/ }));
    await screen.findByRole("heading", { level: 1, name: "История запусков" });
    await flush();
    fireEvent.click(within(screen.getByRole("region", { name: "Запуски" })).getAllByRole("button", { name: /^Запуск / })[0] ?? document.body);
    await screen.findByRole("heading", { level: 1, name: "Запуск 9 окт., 10:00" });
    await flush();
    const journal = screen.getByRole("complementary", { name: "Журнал" });
    expect(journal.querySelector(".ap-journal-head .mono")?.textContent).toBe(`${LOG_PAGE + 32}${NBSP}записи`);
    expect(journal.querySelector(".ap-spent-row")?.textContent).toBe("Потрачено$0.33 из $1.05");
    const log = within(journal).getByRole("list", { name: "Журнал запуска" });
    expect(within(log).getAllByRole("listitem")).toHaveLength(LOG_PAGE);
    expect(within(log).getAllByRole("listitem")[0]?.textContent).toContain(`запуск завершён · 1 из 1${NBSP}видео`);
    fireEvent.click(within(journal).getByRole("button", { name: "Показать раньше" }));
    expect(within(log).getAllByRole("listitem")).toHaveLength(LOG_PAGE + 32);
    expect(within(log).getAllByRole("listitem").at(-1)?.textContent).toContain("запуск принят · до $1.05");
    expect(within(journal).queryByRole("button", { name: "Показать раньше" }) === null).toBe(true);
  });
});

describe("from the launch card", () => {
  async function started(review = false) {
    // S4.8: written against the mock's CANNED launch (a mid-run state that moves only by clicks); the mock now runs one by default.
    const h = setup({ ...historyLibrary(), sceneReview: "off", launchRun: "canned" });
    h.engine.setRunImagePrice(70_000);
    await flush();
    const draft: LaunchDraftInput = {
      avatarIds: [MIA.avatarId, SOFIA.avatarId, ELENA.avatarId],
      videosPerAvatar: 3,
      mix: { single: 70, collage: 20, slides: 10 },
      categories: ["home"],
      poses: { profile: false, back: false },
      library: true,
      generate: true,
      sceneReview: review,
      stickers: false,
    };
    let launchId = "";
    await act(async () => {
      const estimate = await h.client.request("autopilot.estimate", { draft });
      if (!estimate.ok) throw new Error(estimate.error.code);
      const reply = await h.client.request("autopilot.start", { draft: { ...draft, planSeed: estimate.result.preview.planSeed }, acceptedWorstMicros: estimate.result.preview.estimate.worstMicros });
      if (!reply.ok) throw new Error(reply.error.code);
      launchId = reply.result.launch.launchId;
    });
    await openSection("Автопилот");
    await screen.findByRole("heading", { level: 1, name: "Автопилот" });
    await flush();
    return { ...h, launchId };
  }

  test("«Весь журнал» of a launch that runs opens its page: «идёт», and a word that the videos are still coming", async () => {
    const { engine, launchId } = await started();
    const card = document.getElementById("ap-live") ?? document.body;
    fireEvent.click(within(card).getByRole("button", { name: "Весь журнал" }));
    await screen.findByRole("heading", { level: 1, name: /^Запуск / });
    await flush();
    expect(document.querySelector(".ap-launch-title .ap-st")?.textContent).toBe("идёт");
    expect(screen.getByText("Запуск ещё не закончен: видео появляются здесь по мере готовности.")).toBeDefined();
    // The mock's canned launch: a video of each avatar renders (no mark, no trash yet); its finished ones have no record in the mock, so they are not drawn.
    const rendering = screen.getAllByRole("article");
    expect(rendering.map((el) => el.getAttribute("data-state"))).toEqual(["rendering", "rendering", "rendering"]);
    expect(rendering.map((el) => el.querySelector(".ap-res-status")?.textContent)).toEqual(["рендерится", "рендерится", "рендерится"]);
    expect(rendering.some((el) => within(el).queryByRole("switch") !== null)).toBe(false);
    expect(callsOf(engine, "autopilot.get").some((c) => c.payload.launchId === launchId)).toBe(true);
    fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "Автопилот" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Автопилот" })).toBeDefined();
  });

  test("S4.6g: the ended card's «Результаты · N» is the history's count — the videos whose records stand — not the launch view's own count of what it made", async () => {
    wideWindow();
    const { client, launchId } = await started();
    await act(async () => {
      await client.request("autopilot.stop", { launchId });
    });
    await flush();
    await flush();
    const card = document.getElementById("ap-live") ?? document.body;
    // The mock's canned launch made finished videos (the view counts them) that have no record in the mock, which the engine's count leaves out.
    const history = await client.request("autopilot.list", {});
    const counted = history.ok ? (history.result.launches.find((l) => l.launchId === launchId)?.videosDone ?? -1) : -1;
    expect(counted).toBe(0);
    expect(within(card).getByRole("button", { name: `Результаты · ${counted}` })).toBeDefined();
  });

  test("a launch that ended: «Результаты · N» and «Журнал» at 1440, «Результаты · N» in the folded line at 1200", async () => {
    wideWindow();
    const { client, launchId } = await started();
    await act(async () => {
      await client.request("autopilot.stop", { launchId });
    });
    await flush();
    const card = document.getElementById("ap-live") ?? document.body;
    const resultsButton = within(card).getByRole("button", { name: /^Результаты · \d+$/ });
    expect(within(card).getByRole("button", { name: "Журнал" })).toBeDefined();
    fireEvent.click(resultsButton);
    await screen.findByRole("heading", { level: 1, name: /^Запуск / });
    await flush();
    expect(document.querySelector(".ap-launch-title .ap-st")?.textContent).toBe("остановлен");
  });
});

describe("S4.9d: what the S4.6g review left on a launch's page", () => {
  /** «видео 2 · Mia», not published: its trash, then «Удалить видео» (the plain way, chosen for it). */
  async function deletePlain(label: string): Promise<void> {
    const trash = within(tile(label)).getByRole("button", { name: `Удалить ${label}` });
    trash.focus();
    fireEvent.click(trash);
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Удалить видео" }));
    await flush();
    await flush();
  }

  test("L9: after a delete the header counts what the results count — the videos whose records stand — not what the launch made", async () => {
    await openLatest();
    expect(document.querySelector(".ap-launch-meta")?.textContent).toContain(` · 6 из 9${NBSP}видео · `);
    await deletePlain("видео 2 · Mia");
    await waitFor(() => expect(tiles().includes("видео 2 · Mia")).toBe(false));
    expect(results().querySelector(".ap-res-bar > .mono")?.textContent).toMatch(/^5 · /);
    expect(document.querySelector(".ap-launch-meta")?.textContent).toBe(`3${NBSP}аватара · 5 из 9${NBSP}видео · потрачено $1.69 из $4.14 · 14:02–14:31`);
  });

  test("L3: after the reply «Опубликовано» stays busy until the launch is read again — a quick second click sends nothing, never the same value twice; then the engine's mark shows", async () => {
    const { engine, scheduler, history } = await openLatest();
    // No `video.changed` reaches the window, and the next read of the launch answers late: between the reply and that read the page knows only the reply.
    engine.setDelivery(false);
    engine.delayNext("autopilot.get", 1_000);
    fireEvent.click(publishedSwitch("видео 2 · Mia"));
    await flush();
    expect(callsOf(engine, "videos.setPublished")).toHaveLength(1);
    expect(publishedSwitch("видео 2 · Mia").getAttribute("aria-busy")).toBe("true");
    fireEvent.click(publishedSwitch("видео 2 · Mia"));
    await flush();
    expect(callsOf(engine, "videos.setPublished")).toHaveLength(1);
    // The read the mark asked for lands: the mark shows, and the switch is the owner's again.
    act(() => scheduler.runAll());
    await flush();
    await waitFor(() => expect(checked(publishedSwitch("видео 2 · Mia"))).toBe("true"));
    expect(publishedSwitch("видео 2 · Mia").getAttribute("aria-busy")).toBeNull();
    expect(results().querySelector(".ap-res-hide")?.textContent).toBe("Скрыть опубликованные 2");
    fireEvent.click(publishedSwitch("видео 2 · Mia"));
    await flush();
    expect(callsOf(engine, "videos.setPublished").map((c) => c.payload)).toEqual([
      { videoId: history.latest.videoIds[1], published: true },
      { videoId: history.latest.videoIds[1], published: false },
    ]);
  });

  test("the focus after a delete waits for an answer to a read asked after it: an answer to a read asked before the click cannot call the hand-over off", async () => {
    // The window's client, with the answers of `autopilot.get` held back while `holding`: each is the engine's answer at the moment it was asked, delivered late.
    const engine = new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0, ...historyLibrary() });
    const history = seedHistory(engine);
    const base = mockEngineClient(engine);
    const held: (() => void)[] = [];
    let holding = false;
    const client: EngineClient = {
      ...base,
      request(type, payload) {
        const reply = base.request(type, payload);
        if (type !== "autopilot.get" || !holding) return reply;
        return new Promise((resolve) => held.push(() => void reply.then(resolve)));
      },
    };
    render(<App client={client} />);
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
    // The records of the finished videos, in order: Elena's is the last.
    const elena = history.latest.videoIds.at(-1) ?? "";
    // A read of the launch is asked before the click (another window marked Elena's video), and its answer is late.
    holding = true;
    await act(async () => {
      await base.request("videos.setPublished", { videoId: elena, published: true });
    });
    await flush();
    holding = false;
    expect(held).toHaveLength(1);
    // The delete's own `video.changed` does not reach this window: the late answer lands first, from before the delete, still showing the tile.
    engine.setDelivery(false);
    await deletePlain("видео 2 · Mia");
    await act(async () => {
      for (const release of held.splice(0)) release();
    });
    await flush();
    expect(tiles().includes("видео 2 · Mia")).toBe(true);
    // Then a read asked after the delete: the tile has gone, and the focus goes to the one that took its place.
    engine.setDelivery(true);
    await act(async () => {
      await base.request("videos.setPublished", { videoId: elena, published: false });
    });
    await flush();
    await waitFor(() => expect(tiles().includes("видео 2 · Mia")).toBe(false));
    expect(focusedLabel()).toBe(describeElement(tile("видео 3 · Mia")));
  });
});
