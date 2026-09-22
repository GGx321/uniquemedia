import { test, expect } from "bun:test";
import { render, screen, fireEvent, within } from "@testing-library/react";
import { AdvancedPanel } from "./AdvancedPanel";

import type { AdvancedValue } from "./AdvancedPanel";

const base: AdvancedValue = {
  keepTrendAudio: false,
  allowMirror: false,
  targetDistance: 90,
  strength: 1.0,
  identity: "iphone",
  edgeMode: "auto",
  firstFrame: "off",
  cover: null,
};

/** The panel with the pick callback wired, for the tests that click it. */
function renderPanel(
  kind: "video" | "photo",
  value: AdvancedValue,
  onChange: (v: AdvancedValue) => void = () => {},
  onPickCover: () => void = () => {}
) {
  return render(<AdvancedPanel kind={kind} value={value} onChange={onChange} onPickCover={onPickCover} />);
}

test("toggles keep-trend-audio", () => {
  let v = { ...base };
  render(<AdvancedPanel kind="video" value={v} onChange={(x) => (v = x)} onPickCover={() => {}} />);
  fireEvent.click(screen.getByLabelText("Сохранить оригинальный звук"));
  expect(v.keepTrendAudio).toBe(true);
});

test("toggles allow-mirror", () => {
  let v: AdvancedValue = { ...base };
  render(<AdvancedPanel kind="video" value={v} onChange={(x) => (v = x)} onPickCover={() => {}} />);
  fireEvent.click(screen.getByLabelText("Зеркальное отражение"));
  expect(v.allowMirror).toBe(true);
});

test("adjusts strength", () => {
  let v: AdvancedValue = { ...base, targetDistance: 60 };
  render(<AdvancedPanel kind="video" value={v} onChange={(x) => (v = x)} onPickCover={() => {}} />);
  fireEvent.change(screen.getByLabelText("Сила изменений"), { target: { value: "1.3" } });
  expect(v.strength).toBeCloseTo(1.3, 5);
});


test("hides the audio toggle for a photo, which has no sound to keep", () => {
  render(<AdvancedPanel kind="photo" value={{ ...base }} onChange={() => {}} onPickCover={() => {}} />);
  expect(screen.queryByLabelText("Сохранить оригинальный звук")).toBeNull();
});

test("keeps the other toggles for a photo", () => {
  render(<AdvancedPanel kind="photo" value={{ ...base }} onChange={() => {}} onPickCover={() => {}} />);
  expect(screen.getByLabelText("Зеркальное отражение")).toBeDefined();
  expect(screen.getByRole("radiogroup", { name: IDENTITY_LABEL })).toBeDefined();
  expect(screen.getByLabelText("Сила изменений")).toBeDefined();
});

const EDGES_LABEL = "Сохранять края кадра";

test("the edge control is hidden for a video, which is re-framed by its format", () => {
  render(<AdvancedPanel kind="video" value={{ ...base }} onChange={() => {}} onPickCover={() => {}} />);
  expect(screen.queryByLabelText(EDGES_LABEL)).toBeNull();
});

test("the edge control is shown for a video once its first frame is a photo, because it applies to the cover", () => {
  // The route hands the cover the same `edgeMode` a still gets, so a setting
  // that reaches the render must be on screen — otherwise a «Всегда» left
  // over from a still would pad the cover with no visible reason.
  renderPanel("video", { ...base, firstFrame: "photo" });
  expect(screen.getByLabelText(EDGES_LABEL)).toBeDefined();
});

test("the edge control stays hidden for a video whose first frame is black", () => {
  renderPanel("video", { ...base, firstFrame: "black" });
  expect(screen.queryByLabelText(EDGES_LABEL)).toBeNull();
});

test("the edge control is shown for a photo", () => {
  render(<AdvancedPanel kind="photo" value={{ ...base }} onChange={() => {}} onPickCover={() => {}} />);
  expect(screen.getByLabelText(EDGES_LABEL)).toBeDefined();
});

test("the edge control shows the mode it was given", () => {
  render(<AdvancedPanel kind="photo" value={{ ...base, edgeMode: "fit" }} onChange={() => {}} onPickCover={() => {}} />);
  const select = screen.getByLabelText(EDGES_LABEL);
  expect(select instanceof HTMLSelectElement ? select.value : "").toBe("fit");
});

test("choosing to always keep the edges asks for fit", () => {
  let v: AdvancedValue = { ...base };
  render(<AdvancedPanel kind="photo" value={v} onChange={(x) => (v = x)} onPickCover={() => {}} />);
  fireEvent.change(screen.getByLabelText(EDGES_LABEL), { target: { value: "fit" } });
  expect(v.edgeMode).toBe("fit");
});

test("choosing never to keep the edges asks for crop", () => {
  let v: AdvancedValue = { ...base };
  render(<AdvancedPanel kind="photo" value={v} onChange={(x) => (v = x)} onPickCover={() => {}} />);
  fireEvent.change(screen.getByLabelText(EDGES_LABEL), { target: { value: "crop" } });
  expect(v.edgeMode).toBe("crop");
});

test("choosing auto hands the decision back to the picture", () => {
  let v: AdvancedValue = { ...base, edgeMode: "crop" };
  render(<AdvancedPanel kind="photo" value={v} onChange={(x) => (v = x)} onPickCover={() => {}} />);
  fireEvent.change(screen.getByLabelText(EDGES_LABEL), { target: { value: "auto" } });
  expect(v.edgeMode).toBe("auto");
});

test("the edge control offers exactly the three modes and nothing else", () => {
  // A fourth option would have no meaning anywhere below, and a missing one
  // would be a mode the user can never reach.
  render(<AdvancedPanel kind="photo" value={{ ...base }} onChange={() => {}} onPickCover={() => {}} />);
  const select = screen.getByLabelText(EDGES_LABEL);
  const values =
    select instanceof HTMLSelectElement ? [...select.options].map((o) => o.value) : [];
  expect(values.sort()).toEqual(["auto", "crop", "fit"]);
});

/**
 * The «Чёрный первый кадр» switch became a three-way choice: what a copy
 * opens on. Same segmented control as the identity row, so all three are
 * visible at once and the one that needs a file — «Фото» — has a row of its
 * own that appears only when it is chosen.
 */
const FIRST_FRAME_LABEL = "Первый кадр";
const FIRST_FRAME_OPTIONS = ["Выкл", "Чёрный", "Фото"];
const PICK_LABEL = "Выбрать фото";

const firstFrameRadios = (): HTMLElement[] =>
  within(screen.getByRole("radiogroup", { name: FIRST_FRAME_LABEL })).getAllByRole("radio");

test("the first-frame control offers exactly the three modes, in order, for a video", () => {
  renderPanel("video", { ...base });
  expect(firstFrameRadios().map((r) => r.textContent)).toEqual(FIRST_FRAME_OPTIONS);
});

test("the first-frame control is hidden for a photo, which has one frame to replace", () => {
  renderPanel("photo", { ...base });
  expect(screen.queryByRole("radiogroup", { name: FIRST_FRAME_LABEL })).toBeNull();
  expect(screen.queryByText(PICK_LABEL)).toBeNull();
});

test("the old black-first-frame switch is gone", () => {
  renderPanel("video", { ...base });
  expect(screen.queryByLabelText("Чёрный первый кадр")).toBeNull();
});

test.each([
  ["off", "Выкл"],
  ["black", "Чёрный"],
  ["photo", "Фото"],
] as const)("the selected first-frame mode %s carries aria-checked and the others do not", (firstFrame, label) => {
  renderPanel("video", { ...base, firstFrame });
  for (const r of firstFrameRadios()) {
    expect(r.getAttribute("aria-checked")).toBe(r.textContent === label ? "true" : "false");
  }
});

test.each([
  ["Чёрный", "black"],
  ["Фото", "photo"],
  ["Выкл", "off"],
] as const)("choosing %s asks for the %s first frame", (label, firstFrame) => {
  let v: AdvancedValue = { ...base, firstFrame: firstFrame === "off" ? "black" : "off" };
  renderPanel("video", v, (x) => (v = x));
  fireEvent.click(within(screen.getByRole("radiogroup", { name: FIRST_FRAME_LABEL })).getByRole("radio", { name: label }));
  expect(v.firstFrame).toBe(firstFrame);
});

test("choosing a first-frame mode changes nothing else", () => {
  let v: AdvancedValue = { ...base, allowMirror: true, strength: 1.3 };
  renderPanel("video", v, (x) => (v = x));
  fireEvent.click(within(screen.getByRole("radiogroup", { name: FIRST_FRAME_LABEL })).getByRole("radio", { name: "Фото" }));
  expect(v).toEqual({ ...base, allowMirror: true, strength: 1.3, firstFrame: "photo" });
});

test("the pick row is absent until «Фото» is chosen", () => {
  for (const firstFrame of ["off", "black"] as const) {
    const { unmount } = renderPanel("video", { ...base, firstFrame });
    expect(screen.queryByText(PICK_LABEL)).toBeNull();
    unmount();
  }
});

test("with «Фото» chosen, the pick row offers a button that asks the host for a picture", () => {
  let picked = 0;
  renderPanel("video", { ...base, firstFrame: "photo" }, () => {}, () => picked++);
  fireEvent.click(screen.getByRole("button", { name: PICK_LABEL }));
  expect(picked).toBe(1);
});

test("with «Фото» chosen and no picture yet, the row says so and shows no thumbnail", () => {
  renderPanel("video", { ...base, firstFrame: "photo", cover: null });
  expect(screen.queryByRole("img")).toBeNull();
  expect(screen.getByText(/не выбрано/i)).toBeDefined();
});

test("once a picture is chosen, the row shows its thumbnail and its file name", () => {
  const cover = { path: "/Users/alex/Pictures/cover one.jpg", thumb: "data:image/jpeg;base64,AAAA" };
  renderPanel("video", { ...base, firstFrame: "photo", cover });
  const img = screen.getByRole("img");
  expect(img.getAttribute("src")).toBe(cover.thumb);
  expect(screen.getByText("cover one.jpg")).toBeDefined();
  expect(screen.queryByText(/не выбрано/i)).toBeNull();
});

test("the pick button is disabled while a batch runs, so a refused pick cannot clobber the batch state", () => {
  let picked = 0;
  render(
    <AdvancedPanel
      kind="video"
      value={{ ...base, firstFrame: "photo" }}
      onChange={() => {}}
      onPickCover={() => picked++}
      pickCoverDisabled
    />
  );
  const button = screen.getByRole("button", { name: PICK_LABEL });
  expect(button instanceof HTMLButtonElement ? button.disabled : null).toBe(true);
  fireEvent.click(button);
  expect(picked).toBe(0);
});

test("a picture already chosen stays on the value when the mode is switched away and back", () => {
  // The panel does not clear the cover on a mode change: the value is the
  // caller's, and a user flicking to «Чёрный» to compare should not have to
  // pick the file again.
  const cover = { path: "/p/cover.jpg", thumb: "data:image/jpeg;base64,AAAA" };
  let v: AdvancedValue = { ...base, firstFrame: "photo", cover };
  renderPanel("video", v, (x) => (v = x));
  fireEvent.click(within(screen.getByRole("radiogroup", { name: FIRST_FRAME_LABEL })).getByRole("radio", { name: "Чёрный" }));
  expect(v.cover).toEqual(cover);
});

/**
 * The «Метаданные iPhone» switch became a three-way choice: what a copy says
 * about itself. A segmented control rather than a select, so all three are
 * visible at once and the odd one — «Чисто», which is neither on nor off —
 * has a place to be.
 */
const IDENTITY_LABEL = "Метаданные";
const IDENTITY_OPTIONS = ["Движок", "iPhone", "Чисто"];

const radios = (): HTMLElement[] =>
  within(screen.getByRole("radiogroup", { name: IDENTITY_LABEL })).getAllByRole("radio");

test("the identity control offers exactly the three modes, in order", () => {
  render(<AdvancedPanel kind="video" value={{ ...base }} onChange={() => {}} onPickCover={() => {}} />);
  expect(radios().map((r) => r.textContent)).toEqual(IDENTITY_OPTIONS);
});

test("the identity control is shown for a photo as well as a video", () => {
  render(<AdvancedPanel kind="photo" value={{ ...base }} onChange={() => {}} onPickCover={() => {}} />);
  expect(radios().map((r) => r.textContent)).toEqual(IDENTITY_OPTIONS);
});

test.each([
  ["engine", "Движок"],
  ["iphone", "iPhone"],
  ["clean", "Чисто"],
] as const)("the selected mode %s carries aria-checked and the others do not", (identity, label) => {
  render(<AdvancedPanel kind="video" value={{ ...base, identity }} onChange={() => {}} onPickCover={() => {}} />);
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
  render(<AdvancedPanel kind="video" value={v} onChange={(x) => (v = x)} onPickCover={() => {}} />);
  fireEvent.click(screen.getByRole("radio", { name: label }));
  expect(v.identity).toBe(identity);
});

test("choosing a mode changes nothing else", () => {
  let v: AdvancedValue = { ...base, allowMirror: true, strength: 1.3 };
  render(<AdvancedPanel kind="video" value={v} onChange={(x) => (v = x)} onPickCover={() => {}} />);
  fireEvent.click(screen.getByRole("radio", { name: "Чисто" }));
  expect(v).toEqual({ ...base, allowMirror: true, strength: 1.3, identity: "clean" });
});

test("the info glyph is a focusable control described by the tooltip", () => {
  // Hover is not the only way in: a keyboard user reaches the glyph by Tab
  // and a screen reader reads what `aria-describedby` points at.
  render(<AdvancedPanel kind="video" value={{ ...base }} onChange={() => {}} onPickCover={() => {}} />);
  const info = screen.getByRole("button", { name: /режим/i });
  expect(info.tabIndex).toBe(0);
  const id = info.getAttribute("aria-describedby") ?? "";
  expect(id).not.toBe("");
  const tip = document.getElementById(id);
  expect(tip).not.toBeNull();
  expect(tip?.getAttribute("role")).toBe("tooltip");
});

test("the tooltip explains all three modes", () => {
  render(<AdvancedPanel kind="video" value={{ ...base }} onChange={() => {}} onPickCover={() => {}} />);
  const tip = screen.getByRole("tooltip", { hidden: true });
  for (const option of IDENTITY_OPTIONS) expect(tip.textContent).toContain(option);
  expect(tip.textContent).toContain("ffmpeg");
});

test("the info glyph does not steal the choice: clicking it changes nothing", () => {
  let v: AdvancedValue = { ...base };
  const before = { ...v };
  render(<AdvancedPanel kind="video" value={v} onChange={(x) => (v = x)} onPickCover={() => {}} />);
  fireEvent.click(screen.getByRole("button", { name: /режим/i }));
  expect(v).toEqual(before);
});
