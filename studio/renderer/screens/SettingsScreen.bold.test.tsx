import { describe, expect, test } from "bun:test";
import { fireEvent, screen } from "@testing-library/react";
import { flush, openSection, setup } from "../testing";

// S5.9g (plan s5a3 §13.1 «Settings»; mockup 56 of .omc/stage5/design): the «Фото» model row says, on a line of its own under the row, that the owner's choice
// does not reach the «Смелая» frames — they are always drawn by Seedream 5 Pro at 2K. The select is described by that line too, and gets the room its
// longest option needs (mockup 56: `.row-select` cut «Grok Imagine Image 2.0 · от $0.050»).

const LINE = "Смелые кадры всегда рисует Seedream 5 Pro · 2K — эта настройка их не меняет.";
const SEEDREAM = "bytedance-seed/seedream-5-0-pro";

async function openSettings() {
  const ctx = setup();
  await flush();
  await openSection("Настройки");
  await screen.findByRole("heading", { level: 2, name: "Модели" });
  await flush();
  return ctx;
}
const modelSelect = (): HTMLSelectElement => screen.getByRole<HTMLSelectElement>("combobox", { name: "Фото" });

describe("the «Смелая» line of the «Фото» model row (mockup 56)", () => {
  test("stands under the row, in it, and describes the select after the row's own hint", async () => {
    await openSettings();
    const line = screen.getByText(LINE);
    expect(line.closest(".row")).toBe(modelSelect().closest(".row"));
    expect(line.closest(".settings-bold-note")).not.toBeNull();
    const described = (modelSelect().getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
    expect(described.at(-1)).toBe(line.closest(".settings-bold-note")?.id);
    expect(described.length).toBe(2);
  });

  test("stays whatever model is chosen: the choice never reaches the «Смелая» frames", async () => {
    await openSettings();
    fireEvent.change(modelSelect(), { target: { value: SEEDREAM } });
    await flush();
    expect(screen.getByText(LINE)).toBeDefined();
  });

  test("the select gets the room of its longest option", async () => {
    await openSettings();
    expect(modelSelect().classList.contains("row-select-fit")).toBe(true);
  });
});
