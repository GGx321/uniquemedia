import { test, expect, afterEach } from "bun:test";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";

afterEach(cleanup);
import { PresetButtons } from "./PresetButtons";

test("renders three presets and reports clicks", () => {
  let chosen = "medium";
  render(<PresetButtons value="medium" onChange={(v) => (chosen = v)} />);
  fireEvent.click(screen.getByText("Aggressive"));
  expect(chosen).toBe("aggressive");
});

test("marks the active preset", () => {
  render(<PresetButtons value="light" onChange={() => {}} />);
  expect(screen.getByText("Light").getAttribute("aria-pressed")).toBe("true");
});
