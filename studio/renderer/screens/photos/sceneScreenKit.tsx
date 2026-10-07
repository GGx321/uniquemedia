import { screen, within } from "@testing-library/react";
import { flush, openSection, setup, type SetupOptions } from "../../testing";
import { MIA } from "./categoryScreenKit";

// CS.6 screen tests' kit: Mia's Photos screen with «Сцены на проверку» as the owner's default leaves it (ON), and the parts the review artboards draw.

/** One writer attempt at its ceilings at the mock's fallback prices; a fresh request is two. */
export const ATTEMPT = 37_500;

/** A count stays on one line with its word (the app's countOf binds them with a no-break space): «Составить 20 сцен», as the screen names it. */
export const nb = (text: string): string => text.replace(/(\d) (?=\p{L})/gu, "$1 ");

/** Opens Mia's Photos screen with review on (the default) and waits for the card's first price. */
export async function openReview(options: SetupOptions = {}) {
  const harness = setup({ avatars: [MIA], ...options });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  await openSection("Фото");
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  await flush();
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
