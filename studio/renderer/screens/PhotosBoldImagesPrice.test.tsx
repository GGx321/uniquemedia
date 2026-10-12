import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { callsOf, flush, openSection, setup } from "../testing";
import { chipsGroup, MIA } from "./photos/categoryScreenKit";
import { about } from "./photos/scenePaid";
import { card, priceRow } from "./photos/sceneScreenKit";

// S5.R4-fix: the photos' price on the card's step 2 («Сцены на проверку») and on the owner's strip (before «Отрисовать» can be priced) is the engine's figure for the «Подача» and the
// categories of what is drawn: the «Смелая» share at the 2K unit. The window passes the form's (or the set's) level and categories and works nothing out.

async function openCard() {
  const harness = setup({ avatars: [MIA], sceneReview: "on" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  await openSection("Фото");
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  await flush();
  return harness;
}

async function click(el: HTMLElement): Promise<void> {
  fireEvent.click(el);
  await flush();
}

/** Leaves on exactly the named chips (a dimmed «Смелая» chip is left as it is). */
async function only(...names: string[]): Promise<void> {
  for (const name of ["Дом", "Виды", "Улица", "Гламур", "Фитнес", "Ночнушки и бельё", "Пляж и бассейн"]) {
    const el = within(chipsGroup()).getByRole("button", { name: new RegExp(`^${name}`) });
    if (el.getAttribute("aria-disabled") === "true") continue;
    if ((el.getAttribute("aria-pressed") === "true") !== names.includes(name)) await click(el);
  }
}

describe("the generate card's step 2 under «Смелая»", () => {
  test("«Ночнушки и бельё» 10 + «Пляж и бассейн» 10: the photos are the engine's price for that level and those categories, not the owner's model's", async () => {
    const { engine, client } = await openCard();
    await click(within(within(card()).getByRole("radiogroup", { name: "Подача" })).getByRole("radio", { name: "Смелая" }));
    await only("Ночнушки и бельё", "Пляж и бассейн");
    const asked = await client.request("runs.estimateImages", { avatarId: MIA.avatarId, count: 20, level: "bold", categories: ["nightwear", "beach"] });
    if (!asked.ok) throw new Error("the engine refused the price");
    const ordinary = await client.request("runs.estimateImages", { avatarId: MIA.avatarId, count: 20 });
    if (!ordinary.ok) throw new Error("the engine refused the price");
    expect(asked.result.estimate.expectedMicros).toBeGreaterThan(ordinary.result.estimate.expectedMicros);
    await waitFor(() => expect(priceRow(/фото$/)).toContain(about(asked.result.estimate.expectedMicros)));
    expect(callsOf(engine, "runs.estimateImages").some((c) => "count" in c.payload && c.payload.level === "bold" && c.payload.categories?.join() === "nightwear,beach")).toBe(true);
  });
});

describe("the owner's strip under «Смелая»", () => {
  test("asks the engine for the set's level and categories and shows its price for the photos", async () => {
    const { engine, client } = setup({
      avatars: [MIA],
      sceneReview: "on",
      sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-cut-0002", count: 60, written: 25, stopped: "closed", cutOff: { chunk: 2 }, categories: ["nightwear", "beach"], level: "bold" }],
    });
    await screen.findByRole("heading", { level: 2, name: "Mia" });
    await openSection("Фото");
    await screen.findByRole("region", { name: /^Генерация фото/ });
    await flush();
    const asked = await client.request("runs.estimateImages", { avatarId: MIA.avatarId, count: 60, level: "bold", categories: ["nightwear", "beach"] });
    if (!asked.ok) throw new Error("the engine refused the price");
    await waitFor(() => expect(priceRow(/фото$/)).toContain(about(asked.result.estimate.expectedMicros)));
    expect(callsOf(engine, "runs.estimateImages").some((c) => "count" in c.payload && c.payload.count === 60 && c.payload.level === "bold")).toBe(true);
  });
});
