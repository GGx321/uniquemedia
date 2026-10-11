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
  test("is free where the app writes the new scene: the popover and its button say so", async () => {
    await openWriterPriced(0, "on", OLD_SET);
    fireEvent.click(await within(sceneCard(2)).findByRole("button", { name: "Другая сцена вместо 02" }));
    await within(sceneCard(2)).findByRole("button", { name: "Заменить · бесплатно" });
    expect(within(sceneCard(2)).queryByText(/^до \$/) === null).toBe(true);
  });

  test("reads one separator on the button, not two", async () => {
    await openWriterPriced(0, "on", OLD_SET);
    fireEvent.click(await within(sceneCard(2)).findByRole("button", { name: "Другая сцена вместо 02" }));
    const button = await within(sceneCard(2)).findByRole("button", { name: "Заменить · бесплатно" });
    expect(button.textContent?.replace(/\s+/g, " ")).toBe("Заменить · бесплатно");
  });

  test("the ⟳ title does not call the action paid: the popover tells its price", async () => {
    await openWriterPriced(0, "on", OLD_SET);
    const redo = await within(sceneCard(2)).findByRole("button", { name: "Другая сцена вместо 02" });
    expect(redo.getAttribute("title")).toBe("Другая сцена — цена перед отправкой");
  });

  // Round-1 review of S5.6d (mockup 29): once the price is known, the ⟳ title says «бесплатно» where the app writes the scene, and keeps «цена перед отправкой» only where it is paid.
  test("the ⟳ title says «бесплатно» once the price shows the app writes the scene", async () => {
    await openWriterPriced(0, "on", OLD_SET);
    const redo = await within(sceneCard(2)).findByRole("button", { name: "Другая сцена вместо 02" });
    fireEvent.click(redo);
    await within(sceneCard(2)).findByRole("button", { name: "Заменить · бесплатно" });
    await waitFor(() => expect(redo.getAttribute("title")).toBe("Другая сцена — бесплатно"));
  });

  test("the ⟳ title keeps «цена перед отправкой» where the model writes the scene", async () => {
    await openWriterPriced(75_000, "on", OLD_SET);
    const redo = await within(sceneCard(2)).findByRole("button", { name: "Другая сцена вместо 02" });
    fireEvent.click(redo);
    await within(sceneCard(2)).findByRole("button", { name: "Заменить · до $0.075" });
    expect(redo.getAttribute("title")).toBe("Другая сцена — цена перед отправкой");
  });

  test("keeps its price where the model writes the new scene", async () => {
    await openWriterPriced(75_000, "on", OLD_SET);
    fireEvent.click(await within(sceneCard(2)).findByRole("button", { name: "Другая сцена вместо 02" }));
    await within(sceneCard(2)).findByRole("button", { name: "Заменить · до $0.075" });
  });
});

describe("the categories of an old set", () => {
  test("show the stored street and views scenes under their new names", async () => {
    await openWriterPriced(0, "on", OLD_SET);
    await waitFor(() => expect(within(sceneCard(13)).getByText("Улица")).toBeDefined());
    expect(within(sceneCard(7)).getByText("Виды")).toBeDefined();
    expect(column().textContent).not.toContain("Фотосессия");
    expect(column().textContent).not.toContain("Путешествия");
  });
});

// Round-1 review of S5.6d (mockup 24a): before the first compose, the column's «как работает проверка» names who writes the scenes and what it costs.
describe("the column's explainer before the first compose", () => {
  test("says the app writes the scenes, for nothing, where the template writes them", async () => {
    await openWriterPriced(0, "on");
    await waitFor(() => expect(within(column()).getByText(/^Приложение пишет 20/).textContent).toContain("бесплатно"));
    expect(column().textContent).not.toContain("Модель пишет 20");
  });

  test("keeps «Модель пишет» and its price where the model writes them", async () => {
    await openWriterPriced(75_000, "on");
    await waitFor(() => expect(within(column()).getByText(/^Модель пишет 20/).textContent).toContain("≈ $"));
  });
});
