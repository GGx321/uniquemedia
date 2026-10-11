import { describe, expect, test } from "bun:test";
import { waitFor, within } from "@testing-library/react";
import { card, column, priceRow } from "./photos/sceneScreenKit";
import { openWriterPriced } from "./photos/writerPricedKit";

// S5.6e (mockups 24 and 32 of .omc/stage5/design): when the writer part of the price is zero — the scenes of built-in categories are written by the app
// from its template — the price column and the scenes column say so. The writer's price is injected here, so none of this depends on what the mock
// engine charges for a chunk.

describe("the price column when the app writes the scenes", () => {
  test("says the scenes are free and written by the app, with the review off", async () => {
    await openWriterPriced(0, "off");
    await waitFor(() => expect(priceRow("Сцены")).toBe("Сцены бесплатно"));
    expect(within(card()).getByText("их пишет приложение")).toBeDefined();
  });

  test("says the same in the compose step, with the review on", async () => {
    await openWriterPriced(0, "on");
    await waitFor(() => expect(priceRow("Сцены")).toContain("бесплатно"));
    expect(within(card()).getByText("их пишет приложение")).toBeDefined();
  });

  test("keeps the model's price and has no «бесплатно» row when the model writes (review on)", async () => {
    await openWriterPriced(75_000, "on");
    await waitFor(() => expect(priceRow("Сцены")).toContain("≈ $0.009"));
    expect(within(card()).queryByText("их пишет приложение") === null).toBe(true);
  });

  test("shows no scenes row when the model writes and the review is off", async () => {
    await openWriterPriced(75_000, "off");
    await within(card()).findByRole("button", { name: /^Сгенерировать 20 фото · до \$/ });
    expect(() => priceRow("Сцены")).toThrow();
    expect(within(card()).queryByText("их пишет приложение") === null).toBe(true);
  });
});

describe("the scenes column when the app writes the scenes", () => {
  test("names the app instead of the model beside the count", async () => {
    await openWriterPriced(0, "off");
    await waitFor(() => expect(column().querySelector(".scene-col-model")?.textContent).toBe("20 · пишет приложение"));
  });

  test("names the model beside the count when the model writes", async () => {
    await openWriterPriced(75_000, "off");
    await waitFor(() => expect(column().querySelector(".scene-col-model")?.textContent).toMatch(/^20 · \S*grok/));
  });
});
