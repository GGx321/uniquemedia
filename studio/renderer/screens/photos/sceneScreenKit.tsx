import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { App } from "../../App";
import { LLM_ONLY_CATEGORY_RECORD, LLM_ONLY_REF } from "../../../engine/scenes/testing/llmOnlyFixture";
import { MockEngine, type MockEngineOptions, mockEngineClient } from "../../engine/mockEngine";
import { ManualScheduler } from "../../engine/scheduler";
import { flush, openSection, setup, type SetupOptions } from "../../testing";
import { chipsGroup, MIA } from "./categoryScreenKit";
import { SCENE_REVIEW_KEY } from "./sceneReview";

// CS.6 screen tests' kit: Mia's Photos screen with «Сцены на проверку» as the owner's default leaves it (ON), and the parts the review artboards draw.

/** One writer attempt at its ceilings at the mock's fallback prices; a fresh request is two. */
export const ATTEMPT = 37_500;

/** A count stays on one line with its word (the app's countOf binds them with a no-break space): «Составить 20 сцен», as the screen names it. */
export const nb = (text: string): string => text.replace(/(\d) (?=\p{L})/gu, "$1 ");

export { LLM_ONLY_REF };

/**
 * The category whose scenes only the model writes (5a.2, S5.6e): the mock lists it as a custom category the owner made. It is seeded AFTER the test's own
 * categories and is the oldest of them, so the library lists it last and a screen that opens the first category still opens the test's own.
 */
export const FIXTURE = { ...LLM_ONLY_CATEGORY_RECORD, createdAt: "2026-08-01T10:00:00.000Z", updatedAt: "2026-08-01T10:00:00.000Z" };

/** Leaves the fixture's chip as the only one on. A card that holds a set shows its strip instead of the chips: nothing to choose there, and nothing is done. */
async function chooseOnlyTheFixture(): Promise<void> {
  if (screen.queryByRole("group", { name: "Категории · фото в каждой" }) === null) return;
  const chip = await within(chipsGroup()).findByRole("button", { name: "Только модель" });
  if (chip.getAttribute("aria-pressed") !== "true") fireEvent.click(chip);
  await flush();
  for (const other of within(chipsGroup()).getAllByRole("button")) {
    if (other !== chip && other.getAttribute("aria-pressed") === "true") fireEvent.click(other);
  }
  await flush();
}

export interface OpenReviewOptions extends SetupOptions {
  /** Keep the five built-ins on (the app writes their scenes, free). By default the run is planned from the fixture alone, so the model writes every scene. */
  builtIns?: boolean;
}

/**
 * Opens Mia's Photos screen with review on (the default) and waits for the card's first price. Unless `builtIns` is asked, the fixture's chip is the only
 * one on: 20 photos in ONE category the code template cannot write, so the model is asked and the card shows its price.
 */
export async function openReview({ builtIns = false, ...options }: OpenReviewOptions = {}) {
  const harness = setup({ avatars: [MIA], ...options, categories: [...(options.categories ?? []), FIXTURE] });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  await openSection("Фото");
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  await flush();
  if (!builtIns) await chooseOnlyTheFixture();
  return harness;
}

/** The generate card, full (compose or today's path) or collapsed to the set's strip. */
export function card(): HTMLElement {
  return screen.getByRole("region", { name: /^Генерация фото/ });
}

/** The card's main button, whatever it says now. */
export function goButton(): HTMLElement {
  return within(card()).getByRole("button", { name: /^(Составить|Начать пустой набор|Сгенерировать|Отрисовать|Дописать|Составляем|Дописываем|Подтвердить новую цену|Считаем|Отправляем|Повторить оценку)/ });
}

export function reviewSwitch(): HTMLElement {
  return within(card()).getByRole("switch", { name: "Сцены на проверку" });
}

/** The «Сцены» column. */
export function column(): HTMLElement {
  return screen.getByRole("region", { name: "Сцены" });
}

/** A scene's card in the column (`aria-label` «Сцена 02»). */
export function sceneCard(n: number): HTMLElement {
  return within(column()).getByRole("article", { name: `Сцена ${String(n).padStart(2, "0")}` });
}

export function querySceneCard(n: number): HTMLElement | null {
  return within(column()).queryByRole("article", { name: `Сцена ${String(n).padStart(2, "0")}` });
}

/** The visible text of a price row in the card's price column, by its label («Сцены», «19 фото», «Ожидаемая», «Весь запуск», «Дальше»). */
export function priceRow(label: string | RegExp): string {
  const rows = Array.from(card().querySelectorAll<HTMLElement>(".photos-cost-row, .scene-step"));
  const row = rows.find((r) => {
    const name = r.querySelector("[data-label]")?.textContent ?? r.firstElementChild?.textContent ?? "";
    return typeof label === "string" ? name.trim() === label : label.test(name.trim());
  });
  if (row === undefined) throw new Error(`no price row «${String(label)}»`);
  // Its parts as they are laid out side by side: «1 Сцены · 25 из 60 до $0.049».
  return Array.from(row.children)
    .map((part) => (part.textContent ?? "").replace(/\s+/g, " ").trim())
    .filter((part) => part !== "")
    .join(" ");
}

/** A text field's value, read from the element itself (no cast). */
export function fieldValue(el: HTMLElement): string {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLInputElement) return el.value;
  throw new Error("not a text field");
}

export const isDisabled = (el: HTMLElement): boolean => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

/** The text of everything an element is described by (`aria-describedby`), the lines joined by « | ». */
export function describedText(el: HTMLElement): string {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" | ");
}

/**
 * A mock engine whose events can be held back: the real engine answers a command and announces its effect (`scenes.changed`) as two messages, and the
 * mock sends them back to back. Holding the events makes the window between the answer and the event, where a paid button must still be shut.
 */
export class GatedEngine extends MockEngine {
  #held = false;
  readonly #queue: (() => void)[] = [];

  override subscribe(listener: (event: unknown) => void): () => void {
    return super.subscribe((event) => {
      if (this.#held) this.#queue.push(() => listener(event));
      else listener(event);
    });
  }

  holdEvents(): void {
    this.#held = true;
  }

  releaseEvents(): void {
    this.#held = false;
    const queued = this.#queue.splice(0);
    act(() => {
      for (const deliver of queued) deliver();
    });
  }
}

/** `openReview` on a `GatedEngine`. */
export async function openGated({ builtIns = false, ...options }: MockEngineOptions & { builtIns?: boolean } = {}) {
  try {
    localStorage.removeItem(SCENE_REVIEW_KEY);
  } catch {
    // No storage in this environment: the switch reads ON.
  }
  const scheduler = new ManualScheduler();
  const engine = new GatedEngine({ scheduler, latencyMs: 0, avatars: [MIA], ...options, categories: [...(options.categories ?? []), FIXTURE] });
  const client = mockEngineClient(engine);
  render(<App client={client} />);
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  await openSection("Фото");
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  await flush();
  if (!builtIns) await chooseOnlyTheFixture();
  return { engine, scheduler, client };
}
