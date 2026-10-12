import { describe, expect, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { flush } from "../testing";
import { BED, openPhotos, PARIS } from "./photos/categoryScreenKit";

// S5.8b (plan s5a2 §8 row 35, I5.29; mockups 35, 35#home and 36 of .omc/stage5/design): «Ножки» are drawn from the five built-in categories only, so every
// custom category's sheet says so, under its angles: «ⓘ «Ножки» в своих категориях не рисуются.»

const NOTE = "«Ножки» в своих категориях не рисуются.";

function sheet(): HTMLElement {
  return screen.getByRole("dialog", { name: "Мои категории" });
}

async function openSheet(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: /^Мои категории/ }));
  await flush();
  await within(sheet()).findByRole("navigation", { name: "Категории" }).catch(() => null);
}

function anglesGroup(): HTMLElement {
  return within(sheet()).getByRole("group", { name: "Ракурсы" });
}

/** The note's line in the open category's angles block, or null. */
function noteLine(): HTMLElement | null {
  const block = anglesGroup().closest(".cat-angles");
  const line = within(block instanceof HTMLElement ? block : sheet()).queryByText(NOTE)?.closest("p") ?? null;
  return line instanceof HTMLElement ? line : null;
}

describe("the custom category's sheet (mockup 35)", () => {
  test("says under the angles that «Ножки» are not drawn in own categories, with the info mark", async () => {
    await openPhotos({ categories: [PARIS, BED] });
    await openSheet();
    const line = noteLine();
    if (line === null) throw new Error("no «Ножки» note under the angles");
    expect(line.classList.contains("cat-legs-note")).toBe(true);
    expect(line.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    // After the angles hint, and not part of what the chips are described by.
    const hint = document.getElementById(anglesGroup().getAttribute("aria-describedby") ?? "");
    expect(hint !== null && hint.compareDocumentPosition(line) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(hint?.textContent?.includes("Ножки") ?? true).toBe(false);
  });

  test("says it for a category with angles of its own too (35's «Балкон со спины»)", async () => {
    await openPhotos({ categories: [PARIS, BED] });
    await openSheet();
    fireEvent.click(within(within(sheet()).getByRole("navigation", { name: "Категории" })).getByRole("button", { name: /^Домашнее у кровати/ }));
    await flush();
    expect(within(sheet()).getByRole("heading", { level: 3, name: "Домашнее у кровати" })).toBeDefined();
    expect(noteLine()?.textContent).toBe(NOTE);
  });
});
