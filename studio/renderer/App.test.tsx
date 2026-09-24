import { afterEach, expect, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { setup, describeElement, focusedLabel } from "./testing";

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
