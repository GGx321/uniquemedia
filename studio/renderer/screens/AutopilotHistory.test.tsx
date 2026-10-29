import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
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

  test("an empty history: «Запусков пока не было»", async () => {
    await openHistory([], false);
    expect(screen.getByRole("region", { name: "Запуски" }).textContent).toBe("Запусков пока не былоПервый запуск появится здесь сразу после «Запустить».");
    expect(document.querySelector(".ap-launch-meta")?.textContent).toBe(`0${NBSP}запусков`);
  });
});

