import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { UnreadableLaunch } from "../../shared/engine";
import { callsOf, describeElement, flush, focusedLabel, openSection, setup } from "../testing";
import { historyLibrary, seedHistory } from "./autopilot/historyTestkit";

// S4.9c: «История запусков» against the mock (AutopilotS4.dc.html state history; LaunchStates «История»; the design's keyboard table, «История запусков»):
// the header's «История запусков N», every launch newest first with its day, span, avatars, videos, «Потрачено $S из $W′» and status; an entry that cannot
// be read with «Убрать запись» by its opaque id (never for a folder that did not read); a row opens its launch, «←» comes back to the same row.

const NBSP = " ";
const BAD: UnreadableLaunch[] = [
  { entryId: "0a1b2c3d4e5f6071", reason: "invalid" },
  { entryId: "1b2c3d4e5f607182", reason: "io-error" },
];

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

async function openAutopilot(unreadable: UnreadableLaunch[] = BAD, seeded = true) {
  const h = setup({ ...historyLibrary(), unreadableLaunches: unreadable });
  const history = seeded ? seedHistory(h.engine) : null;
  await flush();
  await openSection("Автопилот");
  await screen.findByRole("heading", { level: 1, name: "Автопилот" });
  await flush();
  return { ...h, history };
}

async function openHistory(unreadable: UnreadableLaunch[] = BAD, seeded = true) {
  const opened = await openAutopilot(unreadable, seeded);
  fireEvent.click(screen.getByRole("button", { name: /^История запусков/ }));
  await screen.findByRole("heading", { level: 1, name: "История запусков" });
  await flush();
  return opened;
}

const rowsCard = (): HTMLElement => screen.getByRole("region", { name: "Запуски" });
const launchRows = (): HTMLElement[] => within(rowsCard()).getAllByRole("button", { name: /^Запуск / });
const rowText = (row: HTMLElement): string[] => Array.from(row.children).map((cell) => (cell.textContent ?? "").replace(/\s+/g, " ").trim());

describe("«История запусков»", () => {
  test("the header's button counts the launches and opens the history; its sub counts them and the entries that cannot be read", async () => {
    await openAutopilot();
    expect(screen.getByRole("button", { name: /^История запусков/ }).textContent).toBe("История запусков4");
    fireEvent.click(screen.getByRole("button", { name: /^История запусков/ }));
    const title = await screen.findByRole("heading", { level: 1, name: "История запусков" });
    expect(focusedLabel()).toBe(describeElement(title));
    await flush();
    expect(document.querySelector(".ap-launch-meta")?.textContent).toBe(`4${NBSP}запуска · 2${NBSP}записи не читаются · новые сверху`);
  });

  test("the launches newest first: day and span, avatars, videos done of planned, spent of W′, the status", async () => {
    await openHistory();
    expect(launchRows().map(rowText)).toEqual([
      ["8 окт.14:02–14:31", "Mia, Sofia, Elena", "6 из 9", "$1.69 из $4.14", "завершён", ""],
      ["7 окт.18:40–19:07", "Mia, Lina", "2 из 2", "$1.12 из $3.20", "завершён", ""],
      ["6 окт.21:15–21:31", "Zoe", "1 из 3", "$0.84 из $2.42", "остановлен", ""],
      ["3 окт.16:05–16:09", "Lina", "1 из 1", "$0 бесплатно", "завершён", ""],
    ]);
    expect(launchRows()[0]?.getAttribute("aria-label")).toBe(`Запуск 8 окт., 14:02–14:31 · Mia, Sofia, Elena · 6 из 9${NBSP}видео · $1.69 из $4.14 · завершён`);
    // The faces stack before the names: one per avatar the library holds.
    expect(launchRows()[0]?.querySelectorAll(".ap-face")).toHaveLength(3);
  });

  test("an entry that cannot be read says so; «Убрать запись» sends its opaque id, the row goes and the focus moves on", async () => {
    const { engine } = await openHistory();
    const bad = within(rowsCard()).getAllByRole("group");
    expect(bad).toHaveLength(2);
    expect(bad[0]?.textContent).toContain("Запись запуска повреждена. Пока она здесь, новый запуск недоступен — она может описывать незаконченный.");
    expect(bad[0]?.textContent).toContain("Файл уйдёт в карантин библиотеки — ничего не удаляется.");
    const remove = within(bad[0] ?? document.body).getByRole("button", { name: "Убрать запись" });
    remove.focus();
    fireEvent.click(remove);
    await flush();
    await waitFor(() => expect(within(rowsCard()).getAllByRole("group")).toHaveLength(1));
    expect(callsOf(engine, "autopilot.removeUnreadable").map((c) => c.payload)).toEqual([{ entryId: "0a1b2c3d4e5f6071" }]);
    // The next row in the list takes the focus: here the folder that would not read.
    expect(focusedLabel()).toBe(describeElement(within(rowsCard()).getByRole("group")));
    expect(document.querySelector(".ap-launch-meta")?.textContent).toBe(`4${NBSP}запуска · 1${NBSP}запись не читается · новые сверху`);
  });

  test("an entry that did not read from the disk (io-error) offers no «Убрать запись»; its words fit a folder and a file alike; it reads the list again on request", async () => {
    const { engine } = await openHistory();
    const folder = within(rowsCard()).getAllByRole("group")[1] ?? document.body;
    expect(within(folder).queryByRole("button", { name: "Убрать запись" }) === null).toBe(true);
    expect(folder.textContent).toContain("Не читается");
    expect(folder.textContent).toContain("Studio не смог прочитать запись запуска с диска: диск не ответил или нет доступа.");
    expect(folder.textContent).toContain("Убрать её отсюда нельзя — сначала она должна прочитаться.");
    // Fix round 1: the engine says io-error for a folder and for one file, so the row names neither.
    expect(/папк|файл/i.test(folder.textContent ?? "")).toBe(false);
    const lists = callsOf(engine, "autopilot.list").length;
    fireEvent.click(within(folder).getByRole("button", { name: "Прочитать снова" }));
    await flush();
    expect(callsOf(engine, "autopilot.list").length).toBe(lists + 1);
    expect(callsOf(engine, "autopilot.removeUnreadable")).toHaveLength(0);
  });

  test("S4.6g: an io-error that says its scope is worded for it — a file names the file, the folder names the folder — and neither offers «Убрать запись»", async () => {
    await openHistory([
      { entryId: "1b2c3d4e5f607182", reason: "io-error", scope: "file" },
      { entryId: "2c3d4e5f60718293", reason: "io-error", scope: "folder" },
    ]);
    const [file, folder] = within(rowsCard()).getAllByRole("group");
    expect(file?.textContent).toContain("Studio не смог открыть файл записи запуска: диск не ответил или нет доступа.");
    expect(file?.textContent).not.toContain("папк");
    expect(folder?.textContent).toContain("Studio не смог прочитать папку запусков в библиотеке: диск не ответил или нет доступа.");
    expect(folder?.textContent).not.toContain("файл");
    for (const row of [file, folder]) {
      expect(row === undefined || within(row).queryByRole("button", { name: "Убрать запись" }) === null).toBe(true);
      expect(row === undefined || within(row).queryByRole("button", { name: "Прочитать снова" }) !== null).toBe(true);
    }
  });

  test("a refused «Убрать запись» (the file reads now) reads the list again instead of saying an error", async () => {
    const { engine } = await openHistory([{ entryId: "0a1b2c3d4e5f6071", reason: "invalid" }]);
    engine.failNext("autopilot.removeUnreadable", { code: "NOT_FOUND", detail: "no unreadable launch entry matches" });
    const lists = callsOf(engine, "autopilot.list").length;
    fireEvent.click(within(rowsCard()).getByRole("button", { name: "Убрать запись" }));
    await flush();
    expect(callsOf(engine, "autopilot.list").length).toBe(lists + 1);
    expect(within(rowsCard()).queryByRole("alert") === null).toBe(true);
  });

  test("a row opens its launch with the focus on its title; «← История запусков» comes back with the focus on that row", async () => {
    await openHistory();
    fireEvent.click(launchRows()[1] ?? document.body);
    const title = await screen.findByRole("heading", { level: 1, name: "Запуск 7 окт., 18:40" });
    expect(focusedLabel()).toBe(describeElement(title));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "История запусков" }));
    await screen.findByRole("heading", { level: 1, name: "История запусков" });
    await flush();
    await waitFor(() => expect(focusedLabel()).toBe(describeElement(launchRows()[1] ?? null)));
  });

  test("«← Автопилот» leads back to the screen", async () => {
    await openHistory();
    fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "Автопилот" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Автопилот" })).toBeDefined();
  });

  test("an empty history: «Запусков пока не было»", async () => {
    await openHistory([], false);
    expect(screen.getByRole("region", { name: "Запуски" }).textContent).toBe("Запусков пока не былоПервый запуск появится здесь сразу после «Запустить».");
    expect(document.querySelector(".ap-launch-meta")?.textContent).toBe(`0${NBSP}запусков`);
  });
});

describe("«Последний запуск» on «Автопилот»", () => {
  test("at 1440, with no launch on the card: the newest launch in a line, «Результаты» opens it; «← Автопилот» comes back", async () => {
    wideWindow();
    await openAutopilot([]);
    const card = screen.getByRole("region", { name: "Последний запуск" });
    expect(card.querySelector(".ap-last-line")?.textContent).toBe(`8 окт., 14:02 · Mia, Sofia, Elena · 6 из 9${NBSP}видео · $1.69 из $4.14`);
    expect(card.querySelector(".ap-st")?.textContent).toBe("завершён");
    fireEvent.click(within(card).getByRole("button", { name: "Результаты" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Запуск 8 окт., 14:02" })).toBeDefined();
    fireEvent.click(within(screen.getByRole("main")).getByRole("button", { name: "Автопилот" }));
    expect(await screen.findByRole("heading", { level: 1, name: "Автопилот" })).toBeDefined();
  });

  test("at 1200 it is not drawn (the plan keeps the column), nor while the history is empty", async () => {
    await openAutopilot([]);
    expect(screen.queryByRole("region", { name: "Последний запуск" }) === null).toBe(true);
  });

  test("nothing in the history: no card, and the button counts 0", async () => {
    wideWindow();
    await openAutopilot([], false);
    expect(screen.queryByRole("region", { name: "Последний запуск" }) === null).toBe(true);
    expect(screen.getByRole("button", { name: /^История запусков/ }).textContent).toBe("История запусков0");
  });

  // S4.10 fix C (UI LOW 1): the empty right column of the LaunchStates sheet («правая колонка без истории — вместо «Последний запуск»»).
  test("nothing in the history at 1440: «Запусков пока не было» and what to do, in the card's place", async () => {
    wideWindow();
    await openAutopilot([], false);
    const empty = screen.getByRole("region", { name: "Запусков пока не было" });
    expect(within(empty).getByText("Выберите аватаров слева и нажмите «Запустить» — здесь появится ход запуска.")).toBeDefined();
  });

  test("not drawn with a launch in the history, with entries that cannot be read, nor at 1200", async () => {
    wideWindow();
    await openAutopilot([]);
    expect(screen.queryByRole("region", { name: "Запусков пока не было" }) === null).toBe(true);
    cleanup();

    wideWindow();
    await openAutopilot(BAD, false);
    expect(screen.queryByRole("region", { name: "Запусков пока не было" }) === null).toBe(true);
    cleanup();

    const hd: unknown = Reflect.get(window, "happyDOM");
    const setViewport: unknown = hd !== null && typeof hd === "object" ? Reflect.get(hd, "setViewport") : null;
    if (typeof setViewport === "function") Reflect.apply(setViewport, hd, [{ width: 1200, height: 800 }]);
    await openAutopilot([], false);
    expect(screen.queryByRole("region", { name: "Запусков пока не было" }) === null).toBe(true);
  });
});
