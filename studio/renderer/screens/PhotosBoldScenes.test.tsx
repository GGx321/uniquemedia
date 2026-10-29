import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { PRICE_SCOPES_RU, type CategoryRef, type CategorySummary, type SceneLevel } from "../../shared/engine";
import type { MockSceneSetSeed } from "../engine/mockSceneSets";
import { flush, openSection, setup } from "../testing";
import { category, MIA, PARIS, PARIS_POOL } from "./photos/categoryScreenKit";
import { boldAttemptLine } from "./photos/level";
import { card, sceneCard } from "./photos/sceneScreenKit";

// S5.9g (plan s5a3 §13.1 «Scene review», §13.3 row 49; mockup 49 of .omc/stage5/design): a «Смелая» set on review. A bold scene wears «смело» (with what
// «Смелая» means in its title), a flirty one «кокетливо» as before; a scene on the Seedream route says «Seedream · 2K»; the strip says «Подача: смелая», its
// models line names the bold frames' model, its price column the engine's price of one Seedream attempt; ⟳ «Другая сцена» stays free and keeps «Подача».
// The mock composes the set as the engine does (S5.9c/f): «Ночнушки и бельё» 6 + «Пляж и бассейн» 6 → scene 1 ordinary, 2 flirty and 3 bold, all on Seedream
// (5a.4, Q-A2: every nightwear outfit is), 7 an ordinary beach frame — on Seedream too, every beach outfit being swimwear.
// 5a.4 (S5.BA7, 2026-10-27, plan s5a4 r2.2 D1): the tiers are counted over the whole request now (5 / 5 / 2 of the 12, the tie of 2.5 bold each served in the request's order), so nightwear
// holds 3 bold, 2 flirty and 1 ordinary: scene 1 ordinary, 2 bold and 3 flirty. The cards below follow; what each card must say is unchanged.

const BOLD_TITLE = "Подача «Смелая»: бельё, ночнушки, купальники";
const ROUTE_TITLE = "Этот кадр рисует Seedream 5 Pro в 2K";

async function openSet(categories: readonly CategoryRef[], level?: SceneLevel, more: { customs?: readonly CategorySummary[]; scenes?: MockSceneSetSeed["scenes"] } = {}) {
  const count = more.scenes?.length ?? 12;
  const harness = setup({
    avatars: [MIA],
    sceneReview: "on",
    categories: [...(more.customs ?? [])],
    sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-0001", count, written: count, categories, ...(level === undefined ? {} : { level }), ...(more.scenes === undefined ? {} : { scenes: more.scenes }) }],
  });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  await openSection("Фото");
  await screen.findByRole("region", { name: "Генерация фото · набор сцен" });
  await waitFor(() => expect(sceneCard(count)).toBeDefined());
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
    const badge = within(sceneCard(2)).getByText("смело");
    expect(badge.getAttribute("title")).toBe(BOLD_TITLE);
    expect(badge.classList.contains("scene-tag-bold")).toBe(true);
    const route = within(sceneCard(2)).getByText("Seedream · 2K");
    expect(route.getAttribute("title")).toBe(ROUTE_TITLE);
    expect(tags(2).slice(-2)).toEqual(["смело", "Seedream · 2K"]);
  });

  // 5a.4 (S5.BA2, 2026-10-26, Q-A2): every nightwear scene is on Seedream now, its ordinary ones included, so scene 1 says «Seedream · 2K» and no level; the scenes on the owner's model
  // were a «Смелая» «Дом» set's.
  // 5a.4 (S5.BA3, 2026-10-26, plan s5a4 §7.4, BA2 part 2 review L1): «Смелая» plans «Дом» on the route once the mock mirrors the engine, so the owner's-model control is a «Кокетливая» «Дом» set's.
  // 5a.4 (S5.BA8b, plan s5a4 §5.9 row 24; mockup 66a): every scene of the set on the route — Seedream draws all of it, so the line names it alone, with the set's text model, and its
  // title says the settings do not change it. A set with a scene off the route (an old one, an own scene) keeps the settings' model and names the bold frames' last.
  test("every scene on the route: the line names Seedream 5 Pro · 2K alone, with the set's text model", async () => {
    await openSet(["nightwear", "beach"], "bold");
    expect(modelsLine()).toBe("Seedream 5 Pro · 2K · 9:16 · референс — мастер-портрет · текст grok-4.3");
    // BA8b round 2 (LOW-4): the model and its resolution are one segment, never broken apart, as mockup 66a and the bold segment have them.
    expect(card().querySelector(".scene-strip-models .nowrap")?.textContent).toBe("Seedream 5 Pro · 2K");
    expect(card().querySelector(".scene-strip-models")?.getAttribute("title")).toBe(
      "Картинки — Seedream 5 Pro в 2K: так рисуется каждый кадр «Смелой», Настройки его не меняют. Текст — модель этого набора: ею написаны его сцены.",
    );
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
    const redo = within(sceneCard(2)).getByRole("button", { name: "Другая сцена вместо 02" });
    fireEvent.click(redo);
    await within(sceneCard(2)).findByRole("button", { name: "Заменить · бесплатно" });
    // Once priced (the app's template writes it), ⟳ itself says so too, as on every built-in scene (the column learns it from the popover's price).
    await waitFor(() => expect(within(sceneCard(2)).getByRole("button", { name: "Другая сцена вместо 02" }).getAttribute("title")).toBe("Другая сцена — бесплатно"));
    expect(within(sceneCard(2)).getByRole("dialog").querySelector(".scene-pop-head")?.textContent).toBe("Другая сценабесплатно");
    expect(within(sceneCard(2)).getByRole("dialog").querySelector(".scene-pop-text")?.textContent).toBe(
      "Новое место, наряд, действие, время дня и ракурс из категории «Ночнушки и бельё» и новый текст — его пишет приложение, поэтому бесплатно. Подача та же — смелая. Сцена 02 заменится сразу.",
    );
    fireEvent.click(within(sceneCard(2)).getByRole("button", { name: "Отмена" }));
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
});

// 5a.4 (S5.BA8b, plan s5a4 §5.9 rows 24–26; mockup 66a): a «Смелая» set of a custom category. The writer sets each scene in the category's world (r2.2 D6): the card says which under
// its text, «мир категории: «…»»; ⟳ draws a new scene in that world with a new text, at the bold writer's price («до $0.098», r2.2 D5); every scene is Seedream's, so the models line
// names it alone.
describe("a custom category's «Смелая» set (mockup 66a)", () => {
  async function openCustom() {
    const harness = await openSet([PARIS.categoryId], "bold", { customs: [PARIS] });
    const reply = await harness.client.request("scenes.get", { avatarId: MIA.avatarId });
    if (!reply.ok || reply.result.sceneSet === null) throw new Error("no set");
    return { ...harness, set: reply.result.sceneSet };
  }

  test("⟳ «Другая сцена»: a new place, outfit, action and time in the category's world, a new text, «Подача» kept; at the bold writer's «до $0.098»", async () => {
    await openCustom();
    fireEvent.click(within(sceneCard(1)).getByRole("button", { name: "Другая сцена вместо 01" }));
    const pop = await within(sceneCard(1)).findByRole("dialog", { name: "Другая сцена" });
    await within(pop).findByRole("button", { name: "Заменить · до $0.098" });
    expect(pop.querySelector(".scene-pop-text")?.textContent).toBe(
      "Новое место, наряд, действие и время дня — в мире «Кофейни Парижа» — и новый текст. Подача та же — смелая. Сцена 01 заменится, когда новая будет готова; если не выйдет — останется как есть.",
    );
  });
});

describe("a scene with no world says none", () => {
});

// 5a.4 (S5.BA8b round 2, MEDIUM-1; r2.3 M6, QB-4): at «Смелая» a custom category's own angles do not apply — its scenes on the route take the angle from the scene — so the strip names
// no «у «…» — свои» for it. The rule is the scenes' route, not the set's level: a «Смелая» set stored before 5a.4 drew its custom scenes off the route, with their own angles.
describe("the strip's own-angles words for a custom category with angles of its own", () => {
  const ANGLED = category(5, "Балкон со спины", { ...PARIS_POOL, poses: ["three-quarter", "back"] });

});
