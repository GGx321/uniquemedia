import { describe, expect, test } from "bun:test";
import { fireEvent, waitFor, within } from "@testing-library/react";
import type { Capture, CommandMessage, ResponseMessage, SceneSetView } from "../../shared/engine";
import { MIA } from "./photos/categoryScreenKit";
import { card, sceneCard } from "./photos/sceneScreenKit";
import { showPhotos, WriterPricedEngine, writerPricedOptions } from "./photos/writerPricedKit";

// S5.7c (plan s5a2 §6.3; mockup 28 of .omc/stage5/design): a set's scenes on review — who took each photo (the capture's own label), the «кокетливо» badge of a
// flirty scene, the strip's «Подача: … · Ракурс — из сцены.» line where «Ракурсы: …» was, and ⟳ «Другая сцена» that the app writes for free. The mock's plan
// draws no flirty scene until S5.7b, so the set's VIEW is dressed here, test-side: a level and captures on the scenes `scenes.get` answers with.

interface Dress {
  /** The set's «Подача»; absent leaves the set as the mock made it (ordinary, no poses). */
  level?: "flirty";
  /**
   * A set made before «Подача», which still carries its «Ракурсы» toggles. Absent, the set is one a build with «Подача» made: it stores none (the mock's seed
   * stores the old default, so the dress takes it away).
   */
  poses?: { profile: boolean; back: boolean };
  /** Scene id → its capture, or `null` to show no capture (a set stored before captures). */
  captures?: Readonly<Record<number, Capture | null>>;
  /** Scene ids drawn flirty. */
  flirty?: readonly number[];
}

/** `WriterPricedEngine` whose `scenes.get` answers the set dressed as the test asks (the view only; the mock's state and plan are untouched). */
class DressedEngine extends WriterPricedEngine {
  dress: Dress = {};

  override async request(command: CommandMessage): Promise<ResponseMessage> {
    const response = await super.request(command);
    if (!response.ok || response.type !== "scenes.get" || response.result.sceneSet === null) return response;
    return { ...response, result: { ...response.result, sceneSet: dressed(response.result.sceneSet, this.dress) } };
  }
}

function dressed(set: SceneSetView, dress: Dress): SceneSetView {
  const scenes = set.scenes.map((scene) => {
    const capture = dress.captures?.[scene.sceneId];
    const { capture: _was, ...rest } = scene;
    const withCapture = capture === undefined ? scene : capture === null ? rest : { ...rest, capture };
    return dress.flirty?.includes(scene.sceneId) === true ? { ...withCapture, level: "flirty" as const } : withCapture;
  });
  const { poses: _seeded, ...rest } = set;
  return { ...rest, scenes, ...(dress.level === undefined ? {} : { level: dress.level }), ...(dress.poses === undefined ? {} : { poses: dress.poses }) };
}

const SET = {
  sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-0001", count: 10, written: 10, categories: ["home", "shoot", "travel", "glam", "fit"] as const }],
};

async function openDressed(dress: Dress, writerWorstMicros = 0): Promise<DressedEngine> {
  const engine = new DressedEngine(writerPricedOptions(SET));
  engine.dress = dress;
  engine.writerWorstMicros = writerWorstMicros;
  await showPhotos(engine, "on");
  return engine;
}

/** The strip's lock line: the set's look and «Настройки набора не меняются — Пересоставить… начнёт заново.». */
function lockLine(): string {
  return card().querySelector(".scene-strip-lock")?.textContent?.replace(/\s+/g, " ").trim() ?? "";
}

/** A card's tags as read: its category, who took the photo, its angle and its «Подача», in order. */
function tags(n: number): string[] {
  return Array.from(sceneCard(n).querySelectorAll(".scene-card-tags > .tag")).map((t) => t.textContent?.replace(/\s+/g, " ").trim() ?? "");
}

describe("who took the photo (mockup 28): the capture's own label", () => {
  test.each([
    ["mirror-hidden", "Зеркало, лицо за телефоном"],
    ["pov-legs", "Ножки сверху"],
    ["friend", "Попросила снять"],
  ] as const)("%s reads «%s»", async (capture, label) => {
    await openDressed({ captures: { 1: capture } });
    await waitFor(() => expect(tags(1)[1]).toBe(label));
  });

});

describe("«кокетливо» (mockup 28)", () => {
  test("marks a flirty scene after its other tags, with what «Кокетливая» means in its title; an ordinary scene has none", async () => {
    await openDressed({ level: "flirty", flirty: [2] });
    const badge = await within(sceneCard(2)).findByText("кокетливо");
    expect(badge.getAttribute("title")).toBe("Подача «Кокетливая»: взгляд, улыбка, поза");
    expect(tags(2).at(-1)).toBe("кокетливо");
    expect(within(sceneCard(1)).queryByText("кокетливо") === null).toBe(true);
  });
});

describe("the strip's line (mockup 28): «Подача» and the angle from the scene where «Ракурсы» was", () => {
  test("a flirty set: «Подача: кокетливая · Ракурс — из сцены.»", async () => {
    await openDressed({ level: "flirty", flirty: [2] });
    await waitFor(() => expect(lockLine()).toBe("Подача: кокетливая · Ракурс — из сцены. Настройки набора не меняются — Пересоставить… начнёт заново."));
  });

});

describe("⟳ «Другая сцена» the app writes (mockup 28)", () => {
  /** The scene's category as its card names it. */
  function categoryOf(n: number): string {
    return sceneCard(n).querySelector(".scene-tag-cat")?.textContent ?? "";
  }

  test("says it is free and at once, and that «Подача» stays for a flirty scene", async () => {
    await openDressed({ level: "flirty", flirty: [2] });
    fireEvent.click(await within(sceneCard(2)).findByRole("button", { name: "Другая сцена вместо 02" }));
    await within(sceneCard(2)).findByRole("button", { name: "Заменить · бесплатно" });
    expect(within(sceneCard(2)).getByRole("dialog").querySelector(".scene-pop-text")?.textContent).toBe(
      `Новое место, наряд, действие, время дня и ракурс из категории «${categoryOf(2)}» и новый текст — его пишет приложение, поэтому бесплатно. Подача та же — кокетливая. Сцена 02 заменится сразу.`,
    );
  });

  test("keeps the paid words where the model writes the scene", async () => {
    await openDressed({}, 75_000);
    fireEvent.click(await within(sceneCard(3)).findByRole("button", { name: "Другая сцена вместо 03" }));
    await within(sceneCard(3)).findByRole("button", { name: "Заменить · до $0.075" });
    expect(within(sceneCard(3)).getByRole("dialog").querySelector(".scene-pop-text")?.textContent).toBe(
      `Новое место, наряд, действие и время дня из «${categoryOf(3)}» и новый текст. Сцена 03 заменится, когда новая будет готова; если не выйдет — останется как есть.`,
    );
  });
});
