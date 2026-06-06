import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AdvancedPanel } from "./AdvancedPanel";

const base = { keepTrendAudio: false, allowMirror: false, targetDistance: 90 };

test("toggles keep-trend-audio", () => {
  let v = { ...base };
  render(<AdvancedPanel value={v} onChange={(x) => (v = x)} />);
  fireEvent.click(screen.getByLabelText("Keep trend audio"));
  expect(v.keepTrendAudio).toBe(true);
});

test("edits target distance", () => {
  let v = { ...base };
  render(<AdvancedPanel value={v} onChange={(x) => (v = x)} />);
  fireEvent.change(screen.getByLabelText("Target distance"), { target: { value: "120" } });
  expect(v.targetDistance).toBe(120);
});

test("toggles allow-mirror", () => {
  let v = { keepTrendAudio: false, allowMirror: false, targetDistance: 90 };
  render(<AdvancedPanel value={v} onChange={(x) => (v = x)} />);
  fireEvent.click(screen.getByLabelText("Allow mirror"));
  expect(v.allowMirror).toBe(true);
});
