import { afterEach, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { setup, describeElement, focusedLabel, inAct, flush, openWizard, tick, estimateText } from "./testing";

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

test("a failed version lookup shows a dash instead of a version", async () => {
  Reflect.set(window, "studio", { version: () => Promise.reject(new Error("no handler for studio:version")) });
  setup();
  expect(await screen.findByText("—")).toBeDefined();
  expect(screen.queryByText(/^v\d/) === null).toBe(true);
});

test("without a preload bridge the version is a dash too", async () => {
  setup();
  expect(await screen.findByText("—")).toBeDefined();
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

test("the mock client is labelled as a demo engine in the sidebar", async () => {
  setup();
  expect(screen.getByText("Демо-движок")).toBeDefined();
  await screen.findByText("—");
});

test("a new screen moves focus to its heading", async () => {
  setup();
  fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
  expect(focusedLabel()).toBe(describeElement(screen.getByRole("heading", { level: 1, name: "Настройки" })));
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

test("an engine-restarted notice with open reserves does not repeat AccountBanner's reconcile call to action", async () => {
  const { engine } = setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });

  inAct(() => engine.requireReconcile(["open-reserves"]));
  inAct(() => engine.emitNotice({ noticeId: "notice-0001", code: "engine-restarted", at: "2026-09-24T10:00:00.000Z", count: 1 }));
  await flush();

  // The action — the button, and why it is needed — lives only in AccountBanner.
  expect(screen.getByText("Нужна сверка расходов")).toBeDefined();
  expect(screen.getByRole("button", { name: "Перейти к сверке" })).toBeDefined();

  // The notice itself states only what happened, with no reconcile wording of its own.
  const notice = screen.getByText("Движок перезапускался").closest(".notice");
  expect(notice?.textContent ?? "").not.toMatch(/сверк/i);
});

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

test("the sidebar queue never shows 0 / 0 before the job's first progress event", async () => {
  setup();
  await openWizard();
  fireEvent.click(screen.getByRole("button", { name: "Оценить стоимость" }));
  await waitFor(() => expect(estimateText()).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: /Сгенерировать 4 варианта/ }));
  await screen.findByText(/Рисуем портреты/);

  // Right after avatars.generateCandidates answers, trackCandidatesJob adds
  // the job as "queued" with no total yet (store.ts's emptyJob) — before its
  // first job.progress event, which the scheduler has not fired yet.
  const queue = screen.getByRole("region", { name: "Очередь" });
  expect(within(queue).getByText("0 / 4")).toBeDefined();
  expect(within(queue).queryByText("0 / 0") === null).toBe(true);
});

test("a running candidates job shows in the sidebar queue with its progress", async () => {
  const { scheduler } = setup();
  await openWizard();
  fireEvent.click(screen.getByRole("button", { name: "Оценить стоимость" }));
  await waitFor(() => expect(estimateText()).not.toBeNull());
  fireEvent.click(screen.getByRole("button", { name: /Сгенерировать 4 варианта/ }));
  await screen.findByText(/Рисуем портреты/);
  tick(scheduler, 2);

  const queue = screen.getByRole("region", { name: "Очередь" });
  expect(within(queue).getByText(/^1\s*задача$/)).toBeDefined();
  expect(within(queue).getByText("2 / 4")).toBeDefined();
});
