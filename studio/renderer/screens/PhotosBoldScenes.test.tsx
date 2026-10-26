import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { PRICE_SCOPES_RU, type CategoryRef, type SceneLevel } from "../../shared/engine";
import { flush, openSection, setup } from "../testing";
import { MIA } from "./photos/categoryScreenKit";
import { boldAttemptLine } from "./photos/level";
import { card, sceneCard } from "./photos/sceneScreenKit";

// S5.9g (plan s5a3 §13.1 «Scene review», §13.3 row 49; mockup 49 of .omc/stage5/design): a «Смелая» set on review. A bold scene wears «смело» (with what
// «Смелая» means in its title), a flirty one «кокетливо» as before; a scene on the Seedream route says «Seedream · 2K»; the strip says «Подача: смелая», its
// models line names the bold frames' model, its price column the engine's price of one Seedream attempt; ⟳ «Другая сцена» stays free and keeps «Подача».
// The mock composes the set as the engine does (S5.9c/f): «Ночнушки и бельё» 6 + «Пляж и бассейн» 6 → scene 1 ordinary, 2 flirty and 3 bold, all on Seedream
// (5a.4, Q-A2: every nightwear outfit is), 7 an ordinary beach frame — on Seedream too, every beach outfit being swimwear.

const BOLD_TITLE = "Подача «Смелая»: бельё, ночнушки, купальники";
const ROUTE_TITLE = "Этот кадр рисует Seedream 5 Pro в 2K";

async function openSet(categories: readonly CategoryRef[], level?: SceneLevel) {
  const harness = setup({
    avatars: [MIA],
    sceneReview: "on",
    sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-0001", count: 12, written: 12, categories, ...(level === undefined ? {} : { level }) }],
  });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  await openSection("Фото");
  await screen.findByRole("region", { name: "Генерация фото · набор сцен" });
  await waitFor(() => expect(sceneCard(12)).toBeDefined());
  await flush();
  return harness;
}

/** A card's tags as read, in order. */
function tags(n: number): string[] {
  return Array.from(sceneCard(n).querySelectorAll(".scene-card-tags > .tag")).map((t) => t.textContent?.replace(/\s+/g, " ").trim() ?? "");
}
function lockLine(): string {
  return card().querySelector(".scene-strip-lock")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}
function modelsLine(): string {
  return card().querySelector(".scene-strip-models")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

describe("a «Смелая» set's scenes (mockup 49)", () => {
  test("a bold scene: «смело» after its other tags, with its title; then «Seedream · 2K» with its own", async () => {
    await openSet(["nightwear", "beach"], "bold");
    const badge = within(sceneCard(3)).getByText("смело");
    expect(badge.getAttribute("title")).toBe(BOLD_TITLE);
    expect(badge.classList.contains("scene-tag-bold")).toBe(true);
    const route = within(sceneCard(3)).getByText("Seedream · 2K");
    expect(route.getAttribute("title")).toBe(ROUTE_TITLE);
    expect(tags(3).slice(-2)).toEqual(["смело", "Seedream · 2K"]);
  });

  test("a flirty scene keeps «кокетливо»; on Seedream it says so too", async () => {
    await openSet(["nightwear", "beach"], "bold");
    expect(tags(2).slice(-2)).toEqual(["кокетливо", "Seedream · 2K"]);
    expect(within(sceneCard(2)).queryByText("смело") === null).toBe(true);
  });

  // 5a.4 (S5.BA2, 2026-10-26, Q-A2): every nightwear scene is on Seedream now, its ordinary ones included, so scene 1 says «Seedream · 2K» and no level; the scenes on the owner's model
  // are a «Смелая» «Дом» set's (still drawn as «Кокетливая» until S5.BA3 plans its companion).
  test("an ordinary scene says no level; an ordinary nightwear or beach scene is still on Seedream", async () => {
    await openSet(["nightwear", "beach"], "bold");
    expect(within(sceneCard(1)).queryByText("смело") === null).toBe(true);
    expect(within(sceneCard(1)).queryByText("кокетливо") === null).toBe(true);
    expect(within(sceneCard(1)).getByText("Seedream · 2K")).toBeDefined();
    expect(within(sceneCard(7)).getByText("Seedream · 2K")).toBeDefined();
    expect(within(sceneCard(7)).queryByText("смело") === null).toBe(true);
  });

  test("a scene on the owner's model has neither: a «Смелая» «Дом» set's", async () => {
    await openSet(["home"], "bold");
    const cards = Array.from({ length: 12 }, (_, i) => sceneCard(i + 1));
    for (const scene of cards) {
      expect(within(scene).queryByText("смело") === null).toBe(true);
      expect(within(scene).queryByText("Seedream · 2K") === null).toBe(true);
    }
    expect(cards.some((scene) => within(scene).queryByText("кокетливо") === null)).toBe(true);
  });

  test("the strip says «Подача: смелая · Ракурс — из сцены.»", async () => {
    await openSet(["nightwear", "beach"], "bold");
    expect(lockLine()).toBe("Подача: смелая · Ракурс — из сцены. Настройки набора не меняются — Пересоставить… начнёт заново.");
  });

  test("the models line names the bold frames' model last; an ordinary set's does not", async () => {
    await openSet(["nightwear", "beach"], "bold");
    expect(modelsLine().endsWith(" · смелые кадры — Seedream 5 Pro · 2K")).toBe(true);
  });

  test("the price column reads the engine's price of one Seedream attempt under «Ожидаемая»", async () => {
    const { client } = await openSet(["nightwear", "beach"], "bold");
    const set = await client.request("scenes.get", { avatarId: MIA.avatarId });
    if (!set.ok || set.result.sceneSet === null) throw new Error("no set");
    const reply = await client.request("runs.estimateFromScenes", { sceneSetId: set.result.sceneSet.sceneSetId, revision: set.result.sceneSet.revision });
    if (!reply.ok || reply.result.estimate.boldAttemptMicros === undefined) throw new Error("the engine priced no Seedream attempt");
    const line = await within(card()).findByText(boldAttemptLine(reply.result.estimate.boldAttemptMicros));
    expect(line.textContent).toBe("Seedream 2K — до $0.093 за попытку по прайсу");
    expect(line.previousElementSibling?.classList.contains("photos-cost-total")).toBe(true);
  });

  test("⟳ on a bold scene: free, and «Подача та же — смелая.»; on an ordinary one no «Подача»", async () => {
    await openSet(["nightwear", "beach"], "bold");
    const redo = within(sceneCard(3)).getByRole("button", { name: "Другая сцена вместо 03" });
    fireEvent.click(redo);
    await within(sceneCard(3)).findByRole("button", { name: "Заменить · бесплатно" });
    // Once priced (the app's template writes it), ⟳ itself says so too, as on every built-in scene (the column learns it from the popover's price).
    await waitFor(() => expect(within(sceneCard(3)).getByRole("button", { name: "Другая сцена вместо 03" }).getAttribute("title")).toBe("Другая сцена — бесплатно"));
    expect(within(sceneCard(3)).getByRole("dialog").querySelector(".scene-pop-head")?.textContent).toBe("Другая сценабесплатно");
    expect(within(sceneCard(3)).getByRole("dialog").querySelector(".scene-pop-text")?.textContent).toBe(
      "Новое место, наряд, действие, время дня и ракурс из категории «Ночнушки и бельё» и новый текст — его пишет приложение, поэтому бесплатно. Подача та же — смелая. Сцена 03 заменится сразу.",
    );
    fireEvent.click(within(sceneCard(3)).getByRole("button", { name: "Отмена" }));
    await flush();
    fireEvent.click(within(sceneCard(1)).getByRole("button", { name: "Другая сцена вместо 01" }));
    await within(sceneCard(1)).findByRole("button", { name: "Заменить · бесплатно" });
    expect(within(sceneCard(1)).getByRole("dialog").querySelector(".scene-pop-text")?.textContent?.includes("Подача та же") ?? true).toBe(false);
  });
});

describe("the strip when the 2K price is missing (gap D)", () => {
  test("«Отрисовать» cannot be priced: the line says state 55's sentence, never the general one, with its retry", async () => {
    const { engine } = await openSet(["nightwear", "beach"], "bold");
    engine.lackBoldPrice();
    // A change of the set asks the price again (the strip prices the set's revision).
    fireEvent.click(within(sceneCard(12)).getByRole("button", { name: "Убрать сцену 12" }));
    await flush();
    const line = await within(card()).findByText(PRICE_SCOPES_RU.bold);
    expect(line.closest(".price-failed")).not.toBeNull();
    expect(within(card()).queryByText(/^Цену не узнать/) === null).toBe(true);
    expect(within(card()).getByRole("button", { name: "Повторить" })).toBeDefined();
  });
});

describe("a set with no Seedream scene", () => {
  test("shows no route tag, no models segment and no Seedream price line", async () => {
    await openSet(["home", "glam"], "flirty");
    for (let n = 1; n <= 12; n++) expect(within(sceneCard(n)).queryByText("Seedream · 2K") === null).toBe(true);
    expect(modelsLine().includes("Seedream 5 Pro")).toBe(false);
    expect(within(card()).queryByText(/^Seedream 2K/) === null).toBe(true);
  });
});
