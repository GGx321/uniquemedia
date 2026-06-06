import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { PresetButtons } from "./PresetButtons";

test("renders three presets and reports clicks", () => {
  let chosen = "medium";
  render(<PresetButtons value="medium" onChange={(v) => (chosen = v)} />);
  fireEvent.click(screen.getByText("Агрессивная"));
  expect(chosen).toBe("aggressive");
});

test("marks the active preset", () => {
  render(<PresetButtons value="light" onChange={() => {}} />);
  expect(screen.getByText("Лёгкая").getAttribute("aria-pressed")).toBe("true");
});
