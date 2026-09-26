import { afterEach, expect, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { setup, describeElement, focusedLabel, inAct, flush } from "./testing";

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
  expect(screen.queryByText(/^v\d/)).toBeNull();
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
  expect(screen.queryByText(/Повторилось/)).toBeNull();

  // Not tied to the Avatars screen: it follows the window, not one section.
  fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
  await screen.findByRole("heading", { level: 1, name: "Настройки" });
  expect(screen.getByText("Движок перезапускался")).toBeDefined();

  // A second notice of the same code replaces the first, count and all (store.ts's mergeNotice).
  inAct(() => engine.emitNotice({ noticeId: "notice-0002", code: "engine-restarted", at: "2026-09-24T10:05:00.000Z", count: 3 }));
  await screen.findByText(/Повторилось 3 раза за эту сессию/);
  expect(screen.getAllByText("Движок перезапускался")).toHaveLength(1);
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
