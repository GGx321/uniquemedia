import { afterEach, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { setup, inAct, flush } from "./testing";

const SECTION_LABELS = ["Аватары", "Фото", "Монтаж", "Автопилот", "Настройки"];

afterEach(() => {
  Reflect.deleteProperty(window, "studio");
});

const heading = (): string | null => screen.getByRole("heading", { level: 1 }).textContent;

test("the sidebar lists all five sections and the version from the bridge", async () => {
  Reflect.set(window, "studio", { version: async () => "9.9.9" });
  setup();
  for (const label of SECTION_LABELS) {
    expect(screen.getByRole("button", { name: label })).toBeDefined();
  }
  expect(await screen.findByText("v9.9.9")).toBeDefined();
});

test("clicking a section switches the heading and the active item", async () => {
  setup();
  expect(heading()).toBe("Аватары");

  const montage = screen.getByRole("button", { name: "Монтаж" });
  fireEvent.click(montage);

  expect(heading()).toBe("Монтаж");
  expect(montage.getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: "Аватары" }).getAttribute("aria-current")).toBeNull();
  await screen.findByText("—");
});

test("an engine notice shows on whatever screen is open, deduped by code, with repeats counted", async () => {
  const { engine } = setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });

  inAct(() => engine.emitNotice({ noticeId: "notice-0001", code: "engine-restarted", at: "2026-09-24T10:00:00.000Z", count: 1 }));
  await screen.findByText("Движок перезапускался");
  expect(screen.queryByText(/Повторилось/) === null).toBe(true);

  // Not tied to the Avatars screen: it follows the window, not one section.
  fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
  await screen.findByRole("heading", { level: 1, name: "Настройки" });
  expect(screen.getByText("Движок перезапускался")).toBeDefined();

  // A second notice of the same code replaces the first, count and all (store.ts's mergeNotice).
  inAct(() => engine.emitNotice({ noticeId: "notice-0002", code: "engine-restarted", at: "2026-09-24T10:05:00.000Z", count: 3 }));
  await screen.findByText(/Повторилось 3 раза за эту сессию/);
  expect(screen.getAllByText("Движок перезапускался")).toHaveLength(1);
});

// Slice review 5, L1: the contract has no command to dismiss an engine notice, so it stayed for the whole session. «Понятно» closes it in this
// window, on every screen; the same notice again (a repeat: its count moves) is news and shows again.
test("an engine notice closes with «Понятно» for the window, and comes back only when it happens again", async () => {
  const { engine } = setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  inAct(() => engine.emitNotice({ noticeId: "notice-0001", code: "engine-restarted", at: "2026-09-24T10:00:00.000Z", count: 1 }));
  const notice = (await screen.findByText("Движок перезапускался")).closest(".notice") as HTMLElement;
  fireEvent.click(within(notice).getByRole("button", { name: "Понятно" }));
  await flush();
  expect(screen.queryByText("Движок перезапускался") === null).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
  await screen.findByRole("heading", { level: 1, name: "Настройки" });
  expect(screen.queryByText("Движок перезапускался") === null).toBe(true);

  inAct(() => engine.emitNotice({ noticeId: "notice-0002", code: "engine-restarted", at: "2026-09-24T10:05:00.000Z", count: 2 }));
  await screen.findByText(/Повторилось 2 раза за эту сессию/);
  expect(screen.getByText("Движок перезапускался")).toBeDefined();
});

// Review r1 LOW-3: the button that closed a notice goes with it; the focus must not fall to the body (the next Tab would start at the top).

// The sidebar's foot draws only what the engine reports: the jobs still
// running and this month's spend. The mockup's render queue and OpenRouter
// balance have no data in the contract, so they must not appear at all.
test("the sidebar foot shows the running queue and this month's spend, and no made-up balance", async () => {
  setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });

  const queue = screen.getByRole("region", { name: "Очередь" });
  expect(within(queue).getByText("пусто")).toBeDefined();
  const spend = screen.getByRole("region", { name: "Расходы за месяц" });
  expect(within(spend).getByText("$1.42")).toBeDefined();
  expect(within(spend).getByText("из $10.00")).toBeDefined();
  expect(screen.queryByText(/Баланс|Рендер|Уникализатор/) === null).toBe(true);
});

test("the sidebar spending block is hidden when the ledger is not open", async () => {
  setup({ money: { unavailable: { cause: "LEDGER_CORRUPT", detail: "ledger.jsonl:3 is not valid JSON" } } });
  const queue = await screen.findByRole("region", { name: "Очередь" });
  expect(within(queue).getByText("пусто")).toBeDefined();
  expect(screen.queryByRole("region", { name: "Расходы за месяц" }) === null).toBe(true);
});

