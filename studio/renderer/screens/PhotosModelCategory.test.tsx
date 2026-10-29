import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { flush, openSection, setup } from "../testing";
import { chipsGroup, MIA, openPhotos } from "./photos/categoryScreenKit";
import { column, FIXTURE, priceRow } from "./photos/sceneScreenKit";

// S5.7c (plan s5a2 §6.3, §8 state 26; mockup 26 of .omc/stage5/design): a custom category the app's template does not cover («Только модель» here) is
// written by the model. The card's price column says what its scenes cost and for which category the model writes, with the review off as on; the scenes
// column says both writers when the run mixes them.

function card(): HTMLElement {
  return screen.getByRole("region", { name: "Генерация фото" });
}
/** The line under the «Сцены» price row. */
function scenesSub(): string | null {
  return card().querySelector(".gen-scenes-sub")?.textContent ?? null;
}
async function turnOn(name: string): Promise<void> {
  fireEvent.click(within(chipsGroup()).getByRole("button", { name: new RegExp(`^${name}`) }));
  await flush();
}

describe("the price column with the review off (mockup 26)", () => {
  test("a category the model writes: «Сцены ≈ $X · до $Y», «для «{имя}» текст пишет модель»", async () => {
    await openPhotos({ categories: [FIXTURE] });
    await turnOn("Только модель");
    await waitFor(() => expect(priceRow("Сцены")).toMatch(/^Сцены ≈ \$0\.\d+ · до \$0\.075$/));
    expect(scenesSub()).toBe("для «Только модель» текст пишет модель");
  });

});

describe("the price column with the review on (mockup 26)", () => {
});

describe("the scenes column (mockup 26)", () => {
});
