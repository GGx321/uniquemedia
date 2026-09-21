import { test, expect } from "bun:test";
import { render, screen, fireEvent } from "@testing-library/react";
import { AdvancedPanel } from "./AdvancedPanel";

import type { AdvancedValue } from "./AdvancedPanel";

const base: AdvancedValue = {
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 90,
  strength: 1.0,
  identity: "iphone",
  edgeMode: "auto",
  blackFirstFrame: false,
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


test("hides the audio toggle for a photo, which has no sound to keep", () => {
  render(<AdvancedPanel kind="photo" value={{ ...base }} onChange={() => {}} />);
  expect(screen.queryByLabelText("Сохранить оригинальный звук")).toBeNull();
});

test("keeps the other toggles for a photo", () => {
  render(<AdvancedPanel kind="photo" value={{ ...base }} onChange={() => {}} />);
  expect(screen.getByLabelText("Зеркальное отражение")).toBeDefined();
  expect(screen.getByRole("radiogroup", { name: IDENTITY_LABEL })).toBeDefined();
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

const BLACK_LABEL = "Чёрный первый кадр";

test("toggles black-first-frame for a video", () => {
  let v: AdvancedValue = { ...base };
  render(<AdvancedPanel kind="video" value={v} onChange={(x) => (v = x)} />);
  fireEvent.click(screen.getByLabelText(BLACK_LABEL));
  expect(v.blackFirstFrame).toBe(true);
});

test("the black-first-frame switch shows the state it was given", () => {
  render(<AdvancedPanel kind="video" value={{ ...base, blackFirstFrame: true }} onChange={() => {}} />);
  const input = screen.getByLabelText(BLACK_LABEL);
  expect(input instanceof HTMLInputElement ? input.checked : null).toBe(true);
});

test("hides the black-first-frame switch for a photo, which has one frame to black out", () => {
  render(<AdvancedPanel kind="photo" value={{ ...base }} onChange={() => {}} />);
  expect(screen.queryByLabelText(BLACK_LABEL)).toBeNull();
});

/**
 * The «Метаданные iPhone» switch became a three-way choice: what a copy says
 * about itself. A segmented control rather than a select, so all three are
 * visible at once and the odd one — «Чисто», which is neither on nor off —
 * has a place to be.
 */
const IDENTITY_LABEL = "Метаданные";
const IDENTITY_OPTIONS = ["Движок", "iPhone", "Чисто"];

const radios = (): HTMLElement[] => screen.getAllByRole("radio");

test("the identity control offers exactly the three modes, in order", () => {
  render(<AdvancedPanel kind="video" value={{ ...base }} onChange={() => {}} />);
  expect(radios().map((r) => r.textContent)).toEqual(IDENTITY_OPTIONS);
});

test("the identity control is shown for a photo as well as a video", () => {
  render(<AdvancedPanel kind="photo" value={{ ...base }} onChange={() => {}} />);
  expect(radios().map((r) => r.textContent)).toEqual(IDENTITY_OPTIONS);
});

test.each([
  ["engine", "Движок"],
  ["iphone", "iPhone"],
  ["clean", "Чисто"],
] as const)("the selected mode %s carries aria-checked and the others do not", (identity, label) => {
  render(<AdvancedPanel kind="video" value={{ ...base, identity }} onChange={() => {}} />);
  for (const r of radios()) {
    expect(r.getAttribute("aria-checked")).toBe(r.textContent === label ? "true" : "false");
  }
});

test.each([
  ["Чисто", "clean"],
  ["Движок", "engine"],
  ["iPhone", "iphone"],
] as const)("choosing %s asks for %s", (label, identity) => {
  let v: AdvancedValue = { ...base, identity: identity === "iphone" ? "engine" : "iphone" };
  render(<AdvancedPanel kind="video" value={v} onChange={(x) => (v = x)} />);
  fireEvent.click(screen.getByRole("radio", { name: label }));
  expect(v.identity).toBe(identity);
});

test("choosing a mode changes nothing else", () => {
  let v: AdvancedValue = { ...base, allowMirror: true, strength: 1.3 };
  render(<AdvancedPanel kind="video" value={v} onChange={(x) => (v = x)} />);
  fireEvent.click(screen.getByRole("radio", { name: "Чисто" }));
  expect(v).toEqual({ ...base, allowMirror: true, strength: 1.3, identity: "clean" });
});

test("the info glyph is a focusable control described by the tooltip", () => {
  // Hover is not the only way in: a keyboard user reaches the glyph by Tab
  // and a screen reader reads what `aria-describedby` points at.
  render(<AdvancedPanel kind="video" value={{ ...base }} onChange={() => {}} />);
  const info = screen.getByRole("button", { name: /режим/i });
  expect(info.tabIndex).toBe(0);
  const id = info.getAttribute("aria-describedby") ?? "";
  expect(id).not.toBe("");
  const tip = document.getElementById(id);
  expect(tip).not.toBeNull();
  expect(tip?.getAttribute("role")).toBe("tooltip");
});

test("the tooltip explains all three modes", () => {
  render(<AdvancedPanel kind="video" value={{ ...base }} onChange={() => {}} />);
  const tip = screen.getByRole("tooltip", { hidden: true });
  for (const option of IDENTITY_OPTIONS) expect(tip.textContent).toContain(option);
  expect(tip.textContent).toContain("ffmpeg");
});

test("the info glyph does not steal the choice: clicking it changes nothing", () => {
  let v: AdvancedValue = { ...base };
  const before = { ...v };
  render(<AdvancedPanel kind="video" value={v} onChange={(x) => (v = x)} />);
  fireEvent.click(screen.getByRole("button", { name: /режим/i }));
  expect(v).toEqual(before);
});
