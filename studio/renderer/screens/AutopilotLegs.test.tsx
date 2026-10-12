import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { LAUNCH_REASONS_RU, type AvatarSummary, type LaunchDraftInput, type PhotoSummary } from "../../shared/engine";
import { freePhotos, MIA, SOFIA } from "../engine/mockEngine.testkit";
import type { MockEngine } from "../engine/mockEngine";
import { callsOf, flush, openSection, setup } from "../testing";
import { historyLibrary, octAt } from "./autopilot/historyTestkit";
import { PARIS } from "./photos/categoryScreenKit";
import { legsFrames } from "./photos/legs";

// S5.8b (plan s5a2 §7, I5.29; mockups 34 and 34#few of .omc/stage5/design): «Автопилот»'s settings gain a «Ножки» row under «Подача» («только во
// встроенных категориях»): «Нет» by default, a pick saying how many of the plan's new frames are legs, sent as `legsShare` only at 15 or 30. With no
// built-in category on the chips are off on «Нет»; when no avatar draws 4 new photos they are off on the pick, which is kept. A running launch shows its own.

const WHAT = "ножки и стопы крупно; лицо может не попасть в кадр, сходство на таких кадрах только отмечается.";
const BUILT_IN_ONLY = "Ножки — только во встроенных категориях";

function world() {
  const roster: AvatarSummary[] = [MIA, SOFIA];
  const photos: PhotoSummary[] = [...freePhotos(3, MIA), ...freePhotos(2, SOFIA)];
  const utils = setup({ avatars: roster.map((a) => ({ ...a, photoCount: 3, eligibleUnusedCount: 3 })), photos, categories: [PARIS], launchRun: "canned" });
  utils.engine.setRunImagePrice(70_000);
  return utils;
}

async function openAutopilot(): Promise<void> {
  await flush();
  await openSection("Автопилот");
  await screen.findByRole("heading", { level: 1, name: "Автопилот" });
  await flush();
}

function settings(): HTMLElement {
  return screen.getByRole("region", { name: "Настройки запуска" });
}
function legsGroup(): HTMLElement {
  return within(settings()).getByRole("radiogroup", { name: "Ножки" });
}
function legs(name: "Нет" | "Немного" | "Много"): HTMLInputElement {
  const radio = within(legsGroup()).getByRole("radio", { name: new RegExp(`^${name}`) });
  if (!(radio instanceof HTMLInputElement)) throw new Error("a legs share is a native radio");
  return radio;
}
/** The text of the elements the group's `aria-describedby` names, in order. */
function described(el: HTMLElement): string[] {
  return (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "");
}
const goButton = (): HTMLElement => screen.getByRole("button", { name: /^(Запустить|Считаем…|Запускаем…|Повторить оценку)/ });

async function settle(): Promise<void> {
  await flush();
  await waitFor(() => expect(goButton().getAttribute("aria-busy")).toBeNull());
}
async function choose(name: string): Promise<void> {
  fireEvent.click(within(screen.getByRole("group", { name: /^Аватары/ })).getByRole("button", { name }));
  await settle();
}
async function pick(name: "Нет" | "Немного" | "Много"): Promise<void> {
  fireEvent.click(legs(name));
  await settle();
}
async function category(name: string): Promise<void> {
  fireEvent.click(within(settings()).getByRole("button", { name }));
  await settle();
}

/** The plan calls (not the list's probe). */
function planCalls(engine: MockEngine) {
  return callsOf(engine, "autopilot.estimate").filter((c) => !(c.payload.draft.videosPerAvatar === 1 && !c.payload.draft.generate && c.payload.draft.library));
}

describe("«Ножки» in «Настройки запуска» (mockup 34)", () => {
  test("is a row «Ножки · только во встроенных категориях» under «Подача», «Нет» checked, with no caption", async () => {
    world();
    await openAutopilot();
    expect(within(settings()).getByText("только во встроенных категориях")).toBeDefined();
    const radios = within(legsGroup()).getAllByRole("radio");
    expect(radios.map((r) => r.getAttribute("value"))).toEqual(["0", "15", "30"]);
    expect(radios.map((r) => r.nextElementSibling?.textContent?.replace(/\s+/g, " "))).toEqual(["Нет", "Немного 15 %", "Много 30 %"]);
    expect(legs("Нет").checked).toBe(true);
    expect(radios.every((r) => r instanceof HTMLInputElement && !r.disabled)).toBe(true);
    expect(within(settings()).queryByText(/стопы крупно/) === null).toBe(true);
    const level = within(settings()).getByRole("radiogroup", { name: "Подача" });
    expect(level.compareDocumentPosition(legsGroup()) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(new Set(radios.map((r) => (r instanceof HTMLInputElement ? r.name : ""))).size).toBe(1);
  });

  test("a pick goes into the plan and the launch as `legsShare`, and says how many of the new frames are legs; «Нет» sends none", async () => {
    const { engine, client } = world();
    await openAutopilot();
    await choose("Mia");
    expect("legsShare" in (planCalls(engine).at(-1)?.payload.draft ?? {})).toBe(false);
    await pick("Немного");
    await waitFor(() => expect(planCalls(engine).at(-1)?.payload.draft.legsShare).toBe(15));
    await settle();
    const draft = planCalls(engine).at(-1)?.payload.draft;
    if (draft === undefined) throw new Error("no plan was asked");
    // The plan's own new photos, per avatar, over the launch's categories (I5.29).
    const reply = await client.request("autopilot.estimate", { draft });
    if (!reply.ok) throw new Error("estimate refused");
    const { preview } = reply.result;
    expect(preview.totals.toGenerate).toBeGreaterThanOrEqual(4);
    const frames = preview.avatars.filter((a) => a.blocked === null).reduce((sum, a) => sum + legsFrames(15, a.toGenerate, draft.categories), 0);
    const caption = within(settings()).getByText(new RegExp(`^≈ ${frames} из ${preview.totals.toGenerate}\\s(нового кадра|новых кадров) — ${WHAT}$`));
    expect(caption.classList.contains("gen-cap-why")).toBe(false);
    expect(described(legsGroup())).toEqual([caption.textContent ?? ""]);
    fireEvent.click(goButton());
    await flush();
    expect(callsOf(engine, "autopilot.start").at(-1)?.payload.draft.legsShare).toBe(15);
  });

  test("back to «Нет»: the plan names no share at all (the engine would store a 0)", async () => {
    const { engine } = world();
    await openAutopilot();
    await choose("Mia");
    await pick("Много");
    await waitFor(() => expect(planCalls(engine).at(-1)?.payload.draft.legsShare).toBe(30));
    await pick("Нет");
    await waitFor(() => expect("legsShare" in (planCalls(engine).at(-1)?.payload.draft ?? {})).toBe(false));
    expect(within(settings()).queryByText(/стопы крупно/) === null).toBe(true);
  });
});

describe("«Ножки» off (mockup 34, its variants)", () => {
  test("only custom categories on: the chips are off on «Нет», saying why; the plan names no share; a built-in back brings the pick back", async () => {
    const { engine } = world();
    await openAutopilot();
    await choose("Mia");
    await pick("Немного");
    for (const name of ["Дом", "Виды", "Улица", "Фитнес"]) await category(name);
    await category("Кофейни Парижа");
    const radios = [legs("Нет"), legs("Немного"), legs("Много")];
    expect(radios.every((r) => r.disabled)).toBe(true);
    expect(legs("Нет").checked).toBe(true);
    const why = within(settings()).getByText(BUILT_IN_ONLY);
    expect(why.classList.contains("gen-cap-why")).toBe(true);
    expect(described(legsGroup())).toEqual([BUILT_IN_ONLY]);
    await waitFor(() => expect(planCalls(engine).at(-1)?.payload.draft.categories).toEqual([PARIS.categoryId]));
    expect("legsShare" in (planCalls(engine).at(-1)?.payload.draft ?? {})).toBe(false);
    await category("Дом");
    expect(legs("Немного").checked).toBe(true);
    expect(legs("Немного").disabled).toBe(false);
    await waitFor(() => expect(planCalls(engine).at(-1)?.payload.draft.legsShare).toBe(15));
  });

  test("fewer than 4 new photos (mockup 34#few): the chips are off on the pick, which is kept, saying «Ножки — от 4 фото»", async () => {
    const { engine } = world();
    await openAutopilot();
    await choose("Mia");
    await pick("Немного");
    // One video, nothing from the library: one new photo.
    for (let i = 0; i < 9; i++) fireEvent.click(within(settings()).getByRole("button", { name: "Меньше видео" }));
    await settle();
    fireEvent.click(within(settings()).getByRole("switch", { name: "Сначала свободные фото из библиотеки" }));
    await settle();
    await waitFor(() => expect(within(settings()).getByText("Ножки — от 4 фото")).toBeDefined());
    expect(within(settings()).getByText("Ножки — от 4 фото").classList.contains("gen-cap-why")).toBe(true);
    expect([legs("Нет"), legs("Немного"), legs("Много")].every((r) => r.disabled)).toBe(true);
    expect(legs("Немного").checked).toBe(true);
    // The pick stays in the launch: it draws nothing this time.
    expect(planCalls(engine).at(-1)?.payload.draft.legsShare).toBe(15);
  });
});

describe("«Ножки» with «Догенерировать недостающие» off (wave 5e)", () => {
  test("no new frame is drawn: the chips are off on the kept pick, saying «Ножки — только для новых кадров»; on again, they work", async () => {
    const { engine } = world();
    await openAutopilot();
    await choose("Mia");
    await pick("Немного");
    fireEvent.click(within(settings()).getByRole("switch", { name: "Догенерировать недостающие" }));
    await settle();
    const why = await within(settings()).findByText("Ножки — только для новых кадров");
    expect(why.classList.contains("gen-cap-why")).toBe(true);
    expect(described(legsGroup())).toEqual(["Ножки — только для новых кадров"]);
    expect([legs("Нет"), legs("Немного"), legs("Много")].every((r) => r.disabled)).toBe(true);
    expect(legs("Немного").checked).toBe(true);
    expect(within(settings()).queryByText(/стопы крупно/) === null).toBe(true);
    // The pick stays in the launch, as at «Ножки — от 4 фото»: it draws nothing this time.
    expect(planCalls(engine).at(-1)?.payload.draft.legsShare).toBe(15);
    fireEvent.click(within(settings()).getByRole("switch", { name: "Догенерировать недостающие" }));
    await settle();
    expect(within(settings()).queryByText("Ножки — только для новых кадров") === null).toBe(true);
    expect(legs("Немного").disabled).toBe(false);
  });
});

describe("a running launch's «Ножки», read only", () => {
  async function startLaunch(over: Partial<LaunchDraftInput>): Promise<void> {
    const { client } = world();
    await flush();
    const draft: LaunchDraftInput = {
      avatarIds: [SOFIA.avatarId],
      videosPerAvatar: 1,
      mix: { single: 100, collage: 0, slides: 0 },
      categories: ["home"],
      library: true,
      generate: true,
      sceneReview: false,
      stickers: false,
      ...over,
    };
    await act(async () => {
      const estimate = await client.request("autopilot.estimate", { draft });
      if (!estimate.ok) throw new Error("estimate refused");
      const started = await client.request("autopilot.start", { draft: { ...draft, planSeed: estimate.result.preview.planSeed }, acceptedWorstMicros: estimate.result.preview.estimate.worstMicros });
      if (!started.ok) throw new Error("start refused");
    });
    await openAutopilot();
  }

  test("shows «Много» for a launch that asked for it; a click changes nothing", async () => {
    await startLaunch({ legsShare: 30 });
    expect(legs("Много").checked).toBe(true);
    expect(legs("Много").getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(legs("Нет"));
    await flush();
    expect(legs("Много").checked).toBe(true);
  });

  test("shows «Нет» for a launch from before «Ножки»", async () => {
    await startLaunch({});
    expect(legs("Нет").checked).toBe(true);
  });
});

describe("a launch's page (mockup 31)", () => {
  /** One ended launch of Mia's, as the history keeps it, its page open: the settings line's bits, a brighter one marked. */
  async function openLaunch(draft: Partial<LaunchDraftInput>): Promise<string[]> {
    const h = setup(historyLibrary());
    h.engine.seedLaunch({
      createdAt: octAt(11, 14, 2),
      endedAt: octAt(11, 14, 31),
      draft: { avatarIds: [MIA.avatarId], videosPerAvatar: 1, categories: ["home", "shoot", "glam"], ...draft },
      videos: [{ avatarId: MIA.avatarId, shape: "single", size: 1, state: "done", durationMs: 8_000, bytes: 2_000_000 }],
    });
    await openAutopilot();
    fireEvent.click(screen.getByRole("button", { name: /^История запусков/ }));
    await screen.findByRole("heading", { level: 1, name: "История запусков" });
    await flush();
    fireEvent.click(within(screen.getByRole("region", { name: "Запуски" })).getAllByRole("button", { name: /^Запуск / })[0] ?? document.body);
    await screen.findByRole("heading", { level: 1, name: "Запуск 11 окт., 14:02" });
    await flush();
    return Array.from(document.querySelectorAll(".ap-launch-bits > span")).map((s) => `${(s.textContent ?? "").replace(/\s+/g, " ")}${s.classList.contains("ap-bit-new") ? " [new]" : ""}`);
  }

  // The mock seeds an old launch's «Ракурсы» unless told otherwise: a launch this build makes stores none.
  test("«Подача: кокетливая · Ножки: немного, 15 %» after the categories, two brighter bits", async () => {
    const bits = await openLaunch({ poses: undefined, level: "flirty", legsShare: 15 });
    expect(bits.slice(2, 5)).toEqual(["Дом, Улица, Гламур", "Подача: кокетливая [new]", "Ножки: немного, 15 % [new]"]);
  });

  test("31#ordinary: «Подача: обычная · Ножки: нет»", async () => {
    const bits = await openLaunch({ poses: undefined });
    expect(bits.slice(2, 5)).toEqual(["Дом, Улица, Гламур", "Подача: обычная [new]", "Ножки: нет [new]"]);
  });

  test("31#old: a launch from before «Подача» names no «Ножки» either", async () => {
    const bits = await openLaunch({ poses: { profile: true, back: false } });
    expect(bits.some((bit) => bit.startsWith("Подача") || bit.startsWith("Ножки"))).toBe(false);
  });
});

describe("the refusal «legs-built-in-only»", () => {
  test("shows its Russian text in the plan", async () => {
    const { engine } = world();
    await openAutopilot();
    await choose("Mia");
    engine.failNext("autopilot.estimate", { code: "VALIDATION", launchReason: "legs-built-in-only" });
    fireEvent.click(legs("Немного"));
    await flush();
    // In the plan's own region, not anywhere on the screen (a stray copy elsewhere must not pass).
    const plan = await screen.findByRole("region", { name: "План" });
    await waitFor(() => expect(within(plan).getAllByText(LAUNCH_REASONS_RU["legs-built-in-only"]).length).toBeGreaterThan(0));
  });
});
