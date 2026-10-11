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
