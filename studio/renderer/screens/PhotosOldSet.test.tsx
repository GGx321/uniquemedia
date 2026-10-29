import { describe, expect, test } from "bun:test";
import { fireEvent, waitFor, within } from "@testing-library/react";
import { MIA } from "./photos/categoryScreenKit";
import { column, goButton, nb, sceneCard } from "./photos/sceneScreenKit";
import { openWriterPriced } from "./photos/writerPricedKit";

// S5.6e (mockup 29): a set made before the scene system, 25 of 30 scenes written. Where the app's template writes the rest, «Дописать» and «Другая сцена» cost
// nothing; where the model writes, they keep their «до $X». The writer's price is injected, so none of this depends on the mock engine's pricing.

const OLD_SET = {
  sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-old-0001", count: 30, written: 25, stopped: "closed" as const, categories: ["home", "travel", "shoot", "glam", "fit"] as const }],
};

describe("«Дописать» on an old set", () => {
  test("says «бесплатно» where the app writes the waiting scenes", async () => {
    await openWriterPriced(0, "on", OLD_SET);
    await waitFor(() => expect(goButton().textContent).toBe(nb("Дописать 5 сцен · бесплатно")));
  });

  test("keeps «до $X» where the model writes them", async () => {
    await openWriterPriced(75_000, "on", OLD_SET);
    await waitFor(() => expect(goButton().textContent).toBe(nb("Дописать 5 сцен · до $0.075")));
  });
});

describe("«Другая сцена» on an old set", () => {
  // Round-1 review of S5.6d (mockup 29): once the price is known, the ⟳ title says «бесплатно» where the app writes the scene, and keeps «цена перед отправкой» only where it is paid.
  test("the ⟳ title keeps «цена перед отправкой» where the model writes the scene", async () => {
    await openWriterPriced(75_000, "on", OLD_SET);
    const redo = await within(sceneCard(2)).findByRole("button", { name: "Другая сцена вместо 02" });
    fireEvent.click(redo);
    await within(sceneCard(2)).findByRole("button", { name: "Заменить · до $0.075" });
    expect(redo.getAttribute("title")).toBe("Другая сцена — цена перед отправкой");
  });

});

describe("the categories of an old set", () => {
});

// Round-1 review of S5.6d (mockup 24a): before the first compose, the column's «как работает проверка» names who writes the scenes and what it costs.
describe("the column's explainer before the first compose", () => {
  test("keeps «Модель пишет» and its price where the model writes them", async () => {
    await openWriterPriced(75_000, "on");
    await waitFor(() => expect(within(column()).getByText(/^Модель пишет 20/).textContent).toContain("≈ $"));
  });
});
