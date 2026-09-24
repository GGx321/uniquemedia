import { afterEach, beforeEach, expect, test } from "bun:test";
import { fireEvent, render, screen } from "@testing-library/react";
import type { StudioApi } from "../shared/ipc";
import { App } from "./App";

const SECTION_LABELS = ["Аватары", "Фото", "Монтаж", "Автопилот", "Настройки"];

const fakeStudio: StudioApi = { version: async () => "9.9.9" };

beforeEach(() => {
  window.studio = fakeStudio;
});

afterEach(() => {
  Reflect.deleteProperty(window, "studio");
});

const heading = (): string | null => screen.getByRole("heading", { level: 1 }).textContent;

test("the sidebar lists all five sections and the version from the bridge", async () => {
  render(<App />);
  for (const label of SECTION_LABELS) {
    expect(screen.getByRole("button", { name: label })).toBeDefined();
  }
  expect(await screen.findByText("v9.9.9")).toBeDefined();
});

test("a failed version lookup shows a dash instead of a version", async () => {
  window.studio = { version: () => Promise.reject(new Error("no handler for studio:version")) };
  render(<App />);
  expect(await screen.findByText("—")).toBeDefined();
  expect(screen.queryByText(/^v/)).toBeNull();
});

test("clicking a section switches the heading and the active item", async () => {
  render(<App />);
  expect(heading()).toBe("Аватары");

  const montage = screen.getByRole("button", { name: "Монтаж" });
  fireEvent.click(montage);

  expect(heading()).toBe("Монтаж");
  expect(montage.getAttribute("aria-current")).toBe("page");
  expect(screen.getByRole("button", { name: "Аватары" }).getAttribute("aria-current")).toBeNull();
  await screen.findByText("v9.9.9");
});
