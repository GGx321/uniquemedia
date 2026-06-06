import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AdvancedPanel } from "./AdvancedPanel";

const base = { keepTrendAudio: false, allowMirror: false, targetDistance: 90 };

test("toggles keep-trend-audio", () => {
  let v = { ...base };
  render(<AdvancedPanel value={v} onChange={(x) => (v = x)} />);
  fireEvent.click(screen.getByLabelText("Сохранить оригинальный звук"));
  expect(v.keepTrendAudio).toBe(true);
});

test("toggles allow-mirror", () => {
  let v = { keepTrendAudio: false, allowMirror: false, targetDistance: 90 };
  render(<AdvancedPanel value={v} onChange={(x) => (v = x)} />);
  fireEvent.click(screen.getByLabelText("Зеркальное отражение"));
  expect(v.allowMirror).toBe(true);
});
