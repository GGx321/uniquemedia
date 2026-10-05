import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { UNKNOWN_IMAGE_MODEL_RU } from "../../shared/engine";
import { callsOf, flush, openSection, setup } from "../testing";

// The Settings «Модели» card, image model and quality (docs/studio/2026-10-05-image-models.md): the «Фото» select over the engine's
// catalogue, the quality select for a model that has one, and «Реализм камеры». They apply to NEW runs, and the card says so.

const GROK = "x-ai/grok-imagine-image-2.0";
const SEEDREAM = "bytedance-seed/seedream-5-0-pro";

async function openSettings(extra: Parameters<typeof setup>[0] = {}) {
  const ctx = setup(extra);
  await flush();
  await openSection("Настройки");
  await screen.findByRole("heading", { level: 2, name: "Модели" });
  await flush();
  return ctx;
}

const modelSelect = (): HTMLSelectElement => screen.getByRole<HTMLSelectElement>("combobox", { name: "Фото" });
const qualitySelect = (): HTMLSelectElement | null => screen.queryByRole<HTMLSelectElement>("combobox", { name: "Качество фото" });
const realismSwitch = (): HTMLElement => screen.getByRole("switch", { name: "Реализм камеры" });

describe("the image model select", () => {
  test("lists the engine's catalogue by name, with the price of one photo (from the cheapest quality when there are two)", async () => {
    await openSettings();
    const labels = within(modelSelect())
      .getAllByRole("option")
      .map((o) => o.textContent);

    expect(labels).toEqual(["Grok Imagine Image 2.0 · от $0.050", "Grok Imagine Image Quality · $0.060", "Seedream 5.0 Pro · $0.048"]);
  });

  test("shows the model that is set", async () => {
    await openSettings();

    expect(modelSelect().value).toBe(GROK);
  });

  test("saves a chosen model with settings.setModels, keeping the text model, and shows the new one", async () => {
    const { engine } = await openSettings();
    fireEvent.change(modelSelect(), { target: { value: SEEDREAM } });
    await flush();

    expect(callsOf(engine, "settings.setModels").at(-1)?.payload).toEqual({ imageModel: SEEDREAM, textModel: "x-ai/grok-4.3" });
    expect(modelSelect().value).toBe(SEEDREAM);
  });

  test("says the change applies to new runs", async () => {
    await openSettings();

    expect(modelSelect().closest(".row")?.textContent).toContain("применяется к новым запускам");
  });

  test("keeps the portraits-and-runs explanation of the row", async () => {
    await openSettings();

    expect(modelSelect().closest(".row")?.textContent).toContain("портреты аватара и фото-раны");
  });

  test("the row states the price of one photo at the chosen quality, a reference image included", async () => {
    await openSettings();

    expect(modelSelect().closest(".row")?.textContent).toContain("≈ $0.050 за фото");
  });

  test("a model the engine refuses is answered with its Russian text, and the select goes back to the saved model", async () => {
    const { engine } = await openSettings();
    engine.failNext("settings.setModels", { code: "VALIDATION", detail: UNKNOWN_IMAGE_MODEL_RU });
    fireEvent.change(modelSelect(), { target: { value: SEEDREAM } });
    await flush();

    expect(await screen.findByText(UNKNOWN_IMAGE_MODEL_RU)).toBeDefined();
    expect(modelSelect().value).toBe(GROK);
  });

  test("a catalogue that did not load leaves the model shown read-only, with a line that says why", async () => {
    const { engine } = setup();
    engine.failNext("settings.imageModels", { code: "INTERNAL" });
    await flush();
    await openSection("Настройки");
    await screen.findByRole("heading", { level: 2, name: "Модели" });
    await flush();

    expect(screen.queryByRole("combobox", { name: "Фото" }) === null).toBe(true);
    expect(screen.getByText(GROK)).toBeDefined();
    expect(screen.getByText(/список моделей не загрузился/i)).toBeDefined();
  });

  test("a model that is set but not in the catalogue stays selectable as the current one, marked", async () => {
    await openSettings({ imageModel: "acme/old-image" });
    const options = within(modelSelect()).getAllByRole("option");

    expect(modelSelect().value).toBe("acme/old-image");
    expect(options.map((o) => o.textContent)).toContain("acme/old-image · нет в списке");
  });

  test("says when the list is the bundled one, because OpenRouter's could not be read", async () => {
    await openSettings();

    expect(screen.getByText(/встроенный список/i)).toBeDefined();
  });
});

describe("the quality select", () => {
  test("is there for a model with two qualities, with the price of each and the saved quality chosen", async () => {
    await openSettings();
    const labels = within(qualitySelect() as HTMLElement)
      .getAllByRole("option")
      .map((o) => o.textContent);

    expect(labels).toEqual(["Низкое · $0.050", "Среднее · $0.070"]);
    expect(qualitySelect()?.value).toBe("low");
  });

  test("saves a chosen quality with the current model, and the price in the row follows", async () => {
    const { engine } = await openSettings();
    fireEvent.change(qualitySelect() as HTMLElement, { target: { value: "medium" } });
    await flush();

    expect(callsOf(engine, "settings.setModels").at(-1)?.payload).toEqual({ imageModel: GROK, imageQuality: "medium", textModel: "x-ai/grok-4.3" });
    expect(qualitySelect()?.value).toBe("medium");
    expect(modelSelect().closest(".row")?.textContent).toContain("≈ $0.070 за фото");
  });

  test("is not shown for a model with no quality knob", async () => {
    await openSettings();
    fireEvent.change(modelSelect(), { target: { value: SEEDREAM } });
    await flush();

    expect(qualitySelect() === null).toBe(true);
  });
});

describe("camera realism", () => {
  test("is off by default, with a one-line hint that names what it adds and that it applies to new runs", async () => {
    await openSettings();

    expect(realismSwitch().getAttribute("aria-checked")).toBe("false");
    const row = screen.getByText("Реализм камеры").closest(".row");
    expect(row?.textContent).toContain("новым запускам");
    expect(row?.textContent).toMatch(/поры|шум/);
  });

  test("turning it on sends settings.setCameraRealism and the switch follows", async () => {
    const { engine } = await openSettings();
    fireEvent.click(realismSwitch());
    await flush();

    expect(callsOf(engine, "settings.setCameraRealism").at(-1)?.payload).toEqual({ cameraRealism: true });
    expect(realismSwitch().getAttribute("aria-checked")).toBe("true");
  });

  test("turning it off again sends false", async () => {
    const { engine } = await openSettings();
    fireEvent.click(realismSwitch());
    await flush();
    fireEvent.click(realismSwitch());
    await flush();

    expect(callsOf(engine, "settings.setCameraRealism").at(-1)?.payload).toEqual({ cameraRealism: false });
    expect(realismSwitch().getAttribute("aria-checked")).toBe("false");
  });
});
