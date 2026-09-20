import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AdvancedPanel } from "./AdvancedPanel";

import type { AdvancedValue } from "./AdvancedPanel";

const base: AdvancedValue = {
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 90,
  strength: 1.0,
  spoofMetadata: true,
  edgeMode: "auto",
};

test("toggles keep-trend-audio", () => {
  let v = { ...base };
  render(<AdvancedPanel kind="video" value={v} onChange={(x) => (v = x)} />);
  fireEvent.click(screen.getByLabelText("Сохранить оригинальный звук"));
  expect(v.keepTrendAudio).toBe(true);
});

test("toggles allow-mirror", () => {
  let v: AdvancedValue = { ...base };
  render(<AdvancedPanel kind="video" value={v} onChange={(x) => (v = x)} />);
  fireEvent.click(screen.getByLabelText("Зеркальное отражение"));
  expect(v.allowMirror).toBe(true);
});

test("adjusts strength", () => {
  let v: AdvancedValue = { ...base, targetDistance: 60 };
  render(<AdvancedPanel kind="video" value={v} onChange={(x) => (v = x)} />);
  fireEvent.change(screen.getByLabelText("Сила изменений"), { target: { value: "1.3" } });
  expect(v.strength).toBeCloseTo(1.3, 5);
});

test("toggles spoof-metadata", () => {
  let v: AdvancedValue = { ...base, targetDistance: 60 };
  render(<AdvancedPanel kind="video" value={v} onChange={(x) => (v = x)} />);
  fireEvent.click(screen.getByLabelText("Метаданные iPhone"));
  expect(v.spoofMetadata).toBe(false);
});

test("hides the audio toggle for a photo, which has no sound to keep", () => {
  render(<AdvancedPanel kind="photo" value={{ ...base }} onChange={() => {}} />);
  expect(screen.queryByLabelText("Сохранить оригинальный звук")).toBeNull();
});

test("keeps the other toggles for a photo", () => {
  render(<AdvancedPanel kind="photo" value={{ ...base }} onChange={() => {}} />);
  expect(screen.getByLabelText("Зеркальное отражение")).toBeDefined();
  expect(screen.getByLabelText("Метаданные iPhone")).toBeDefined();
  expect(screen.getByLabelText("Сила изменений")).toBeDefined();
});

const EDGES_LABEL = "Сохранять края кадра";

test("the edge control is hidden for a video, which is re-framed by its format", () => {
  render(<AdvancedPanel kind="video" value={{ ...base }} onChange={() => {}} />);
  expect(screen.queryByLabelText(EDGES_LABEL)).toBeNull();
});

test("the edge control is shown for a photo", () => {
  render(<AdvancedPanel kind="photo" value={{ ...base }} onChange={() => {}} />);
  expect(screen.getByLabelText(EDGES_LABEL)).toBeDefined();
});

test("the edge control shows the mode it was given", () => {
  render(<AdvancedPanel kind="photo" value={{ ...base, edgeMode: "fit" }} onChange={() => {}} />);
  const select = screen.getByLabelText(EDGES_LABEL);
  expect(select instanceof HTMLSelectElement ? select.value : "").toBe("fit");
});

test("choosing to always keep the edges asks for fit", () => {
  let v: AdvancedValue = { ...base };
  render(<AdvancedPanel kind="photo" value={v} onChange={(x) => (v = x)} />);
  fireEvent.change(screen.getByLabelText(EDGES_LABEL), { target: { value: "fit" } });
  expect(v.edgeMode).toBe("fit");
});

test("choosing never to keep the edges asks for crop", () => {
  let v: AdvancedValue = { ...base };
  render(<AdvancedPanel kind="photo" value={v} onChange={(x) => (v = x)} />);
  fireEvent.change(screen.getByLabelText(EDGES_LABEL), { target: { value: "crop" } });
  expect(v.edgeMode).toBe("crop");
});

test("choosing auto hands the decision back to the picture", () => {
  let v: AdvancedValue = { ...base, edgeMode: "crop" };
  render(<AdvancedPanel kind="photo" value={v} onChange={(x) => (v = x)} />);
  fireEvent.change(screen.getByLabelText(EDGES_LABEL), { target: { value: "auto" } });
  expect(v.edgeMode).toBe("auto");
});

test("the edge control offers exactly the three modes and nothing else", () => {
  // A fourth option would have no meaning anywhere below, and a missing one
  // would be a mode the user can never reach.
  render(<AdvancedPanel kind="photo" value={{ ...base }} onChange={() => {}} />);
  const select = screen.getByLabelText(EDGES_LABEL);
  const values =
    select instanceof HTMLSelectElement ? [...select.options].map((o) => o.value) : [];
  expect(values.sort()).toEqual(["auto", "crop", "fit"]);
});
