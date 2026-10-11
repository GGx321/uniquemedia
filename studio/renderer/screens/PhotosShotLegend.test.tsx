import { expect, test } from "bun:test";
import { within } from "@testing-library/react";
import { openPhotos } from "./photos/categoryScreenKit";
import { card } from "./photos/sceneScreenKit";

// S5.6e (mockup 24): the card's «Тип кадра» legend names the decks' shots. The photographer left the decks, so the legend no longer lists one.

test("the shot-type legend lists the four shots of the decks, with no photographer", async () => {
  await openPhotos();
  const legend = within(card()).getByRole("list", { name: /^Типы кадра/ });
  expect(Array.from(legend.querySelectorAll("li"), (li) => li.textContent)).toEqual(["Попросила снять", "Селфи", "Зеркало", "Кэндид"]);
});
