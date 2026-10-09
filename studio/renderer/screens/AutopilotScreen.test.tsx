import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import type { AvatarSummary, LaunchDraftInput, LaunchPreview, PhotoSummary } from "../../shared/engine";
import { App } from "../App";
import type { EngineClient } from "../engine/client";
import { freePhotos, MIA, NORA, SOFIA } from "../engine/mockEngine.testkit";
import { MockEngine, mockEngineClient } from "../engine/mockEngine";
import { ManualScheduler } from "../engine/scheduler";
import { formatUsdTiered } from "../lib/money";
import { callsOf, describeElement, flush, openSection, setup, tick, type SetupOptions } from "../testing";
import { MIX_KEY } from "./autopilot/launchForm";
import { GO_WHY } from "./autopilot/planModel";
import { WORLD_DEBOUNCE_MS } from "./autopilot/useLaunchPlan";

// S4.9a: the «Автопилот» screen against the mock engine (AutopilotS4.dc.html; plan §4.2–4.4, §9, §13 items 4, 8–12): the plan is the engine's, asked
// again as the form changes; «Запустить» sends exactly the shown worst case; PRICE_CHANGED asks again and needs a new click; a running launch's settings
// are read only and its plan folds; the sidebar marks the launch from any screen.

const NBSP = " ";
const ELENA: AvatarSummary = { ...MIA, avatarId: "avatar-elena-0004", name: "Elena", masterPhotoId: "photo-elena-master" };
const VERA: AvatarSummary = { ...MIA, avatarId: "avatar-vera-0005", name: "Vera", masterPhotoId: "photo-vera-master" };

interface World extends SetupOptions {
  /** Free scene photos per avatar (category «Дом»). */
  free?: Partial<Record<string, number>>;
  extra?: AvatarSummary[];
}

/** Mia 31 free photos, Sofia 4, Elena 14, Nora archived. */
function library({ free = {}, extra = [] }: Pick<World, "free" | "extra"> = {}): { avatars: AvatarSummary[]; photos: PhotoSummary[] } {
  const counts: Record<string, number> = { [MIA.avatarId]: 31, [SOFIA.avatarId]: 4, [ELENA.avatarId]: 14, [VERA.avatarId]: 0 };
  for (const [id, n] of Object.entries(free)) if (n !== undefined) counts[id] = n;
  const roster = [MIA, SOFIA, ELENA, NORA, ...extra];
  const photos: PhotoSummary[] = roster.flatMap((a) => freePhotos(counts[a.avatarId] ?? 0, a));
  const avatars = roster.map((a) => ({ ...a, photoCount: counts[a.avatarId] ?? 0, eligibleUnusedCount: counts[a.avatarId] ?? 0 }));
  return { avatars, photos };
}

/** That library, the image attempt at $0.07 (the plan's figure). */
function world({ free = {}, extra = [], ...options }: World = {}) {
  const utils = setup({ ...library({ free, extra }), ...options });
  utils.engine.setRunImagePrice(70_000);
  return utils;
}

afterEach(() => {
  try {
    localStorage.removeItem(MIX_KEY);
  } catch {
    // No storage here.
  }
  const hd: unknown = Reflect.get(window, "happyDOM");
  const setViewport: unknown = hd !== null && typeof hd === "object" ? Reflect.get(hd, "setViewport") : null;
  if (typeof setViewport === "function") Reflect.apply(setViewport, hd, [{ width: 1024, height: 768 }]);
});

/** The window at the design's wide size: the folded plan card and the longer words are drawn there. */
function wideWindow(): void {
  const hd: unknown = Reflect.get(window, "happyDOM");
  const setViewport: unknown = hd !== null && typeof hd === "object" ? Reflect.get(hd, "setViewport") : null;
  if (typeof setViewport === "function") Reflect.apply(setViewport, hd, [{ width: 1440, height: 900 }]);
}

async function openAutopilot(): Promise<void> {
  await flush();
  await openSection("Автопилот");
  await screen.findByRole("heading", { level: 1, name: "Автопилот" });
  await flush();
}

const goButton = (): HTMLElement => screen.getByRole("button", { name: /^(Запустить|Считаем…|Запускаем…|Повторить оценку)/ });
const avatarButton = (name: string): HTMLElement => within(screen.getByRole("group", { name: /^Аватары/ })).getByRole("button", { name });
/** The text an element is described by (aria-describedby, every id). */
const descriptionOf = (el: HTMLElement): string =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");

/** The plan of the form as it stands is on screen (no estimate on its way). */
async function settled(): Promise<void> {
  await waitFor(() => expect(goButton().getAttribute("aria-busy")).toBeNull());
}

/** The plan calls (not the list's probe, which asks one library video of every active avatar). */
function planCalls(engine: MockEngine) {
  return callsOf(engine, "autopilot.estimate").filter((c) => !(c.payload.draft.videosPerAvatar === 1 && !c.payload.draft.generate && c.payload.draft.library));
}

/** The engine's own preview of the last plan asked (the seed it kept), to compare the screen's words with. */
async function lastPreview(engine: MockEngine, client: EngineClient): Promise<LaunchPreview> {
  const call = planCalls(engine).at(-1);
  if (call === undefined) throw new Error("no plan was asked");
  const reply = await client.request("autopilot.estimate", { draft: call.payload.draft });
  if (!reply.ok) throw new Error(`estimate refused: ${reply.error.code}`);
  return reply.result.preview;
}

const titleOf = (preview: LaunchPreview): string =>
  `Запустить: ${preview.totals.videos}${NBSP}видео · ${preview.estimate.worstMicros > 0 ? `до ${formatUsdTiered(preview.estimate.worstMicros, "up")}` : "бесплатно"}`;

async function choose(...names: string[]): Promise<void> {
  for (const name of names) fireEvent.click(avatarButton(name));
  await flush();
  await settled();
}

describe("the form before a launch", () => {
  test("the active avatars to choose with their free photos, nobody chosen, «Запустить» closed with its reason", async () => {
    world();
    await openAutopilot();
    expect(screen.getByRole("heading", { level: 2, name: /^Аватары/ }).textContent).toBe("Аватары 0 из 3");
    for (const name of ["Mia", "Sofia", "Elena"]) expect(avatarButton(name).getAttribute("aria-pressed")).toBe("false");
    // Nora is archived: the autopilot works with active avatars only.
    expect(within(screen.getByRole("group", { name: /^Аватары/ })).queryByRole("button", { name: "Nora" }) === null).toBe(true);
    // «своб.» comes from the engine's plan of every active avatar, not from the avatar's own counts.
    await waitFor(() => expect(descriptionOf(avatarButton("Mia"))).toBe("31 своб."));
    expect(descriptionOf(avatarButton("Sofia"))).toBe("4 своб.");
    const go = goButton();
    expect(go.textContent).toBe("Запустить");
    expect(go.getAttribute("aria-disabled")).toBe("true");
    expect(descriptionOf(go)).toBe(GO_WHY.noneChosen);
    expect(screen.queryByText(/Текст на видео/) === null).toBe(true);
    expect(screen.getByRole("switch", { name: "Сцены на проверку" }).getAttribute("aria-checked")).toBe("true");
  });

  test("choosing avatars asks the plan and words the engine's figures: the tiles, the month, «Запустить: N видео · до $W»", async () => {
    const { engine, client } = world();
    await openAutopilot();
    await choose("Mia", "Sofia", "Elena");
    const preview = await lastPreview(engine, client);
    expect(planCalls(engine).at(-1)?.payload.draft).toMatchObject({ avatarIds: [MIA.avatarId, SOFIA.avatarId, ELENA.avatarId], videosPerAvatar: 10, mix: { single: 70, collage: 20, slides: 10 } });
    expect(goButton().textContent).toBe(titleOf(preview));
    expect(goButton().getAttribute("aria-disabled")).toBeNull();
    const tile = (label: string): string => screen.getByText(label, { selector: ".ap-tile-label" }).nextElementSibling?.textContent ?? "";
    expect(tile("Видео")).toBe(String(preview.totals.videos));
    expect(tile("Из библиотеки")).toBe(String(preview.totals.fromLibrary));
    expect(tile("Сгенерировать")).toBe(String(preview.totals.toGenerate));
    expect(tile("Ожидаемая")).toBe(`≈ ${formatUsdTiered(preview.estimate.expectedMicros, "nearest")}`);
    expect(screen.getByText("В месяце свободно")).toBeDefined();
    expect(screen.getByRole("img", { name: /^Месячный бюджет \$10\.00/ })).toBeDefined();
    // The legend's price per shape is the engine's (1, 3, 5 × a photo's expected price), three decimals below $0.10.
    expect(screen.getByText("≈ $0.070")).toBeDefined();
    expect(screen.getByText(`до ${formatUsdTiered(preview.estimate.worstMicros, "up")}`, { selector: ".ap-limit" })).toBeDefined();
  });

  test("a run of stepper clicks asks the plan once, after the form has been still", async () => {
    const { engine } = world();
    await openAutopilot();
    await choose("Mia");
    const before = planCalls(engine).length;
    const more = screen.getByRole("button", { name: "Больше видео" });
    fireEvent.click(more);
    fireEvent.click(more);
    fireEvent.click(more);
    await flush();
    expect(planCalls(engine).length).toBe(before);
    await settled();
    expect(planCalls(engine).length).toBe(before + 1);
    expect(planCalls(engine).at(-1)?.payload.draft.videosPerAvatar).toBe(13);
    // The seed of the first plan is kept: the start plans the very videos the last preview showed.
    const seeds = planCalls(engine).map((c) => c.payload.draft.planSeed);
    expect(seeds[0]).toBeUndefined();
    expect(seeds.at(-1)).toBeNumber();
  });

  test("«Сцены на проверку» starts as the «Фото» screen left it, and needs generation", async () => {
    world({ sceneReview: "off" });
    await openAutopilot();
    const review = screen.getByRole("switch", { name: "Сцены на проверку" });
    expect(review.getAttribute("aria-checked")).toBe("false");
    fireEvent.click(screen.getByRole("switch", { name: "Догенерировать недостающие" }));
    expect(review.getAttribute("aria-disabled")).toBe("true");
    expect(descriptionOf(review)).toBe("нужна только для новых фото");
    fireEvent.click(review);
    expect(review.getAttribute("aria-checked")).toBe("false");
  });

  test("the form is the window's: it survives a look at Settings", async () => {
    world();
    await openAutopilot();
    await choose("Sofia");
    fireEvent.click(screen.getByRole("button", { name: "Больше видео" }));
    await openSection("Настройки");
    await openAutopilot();
    expect(avatarButton("Sofia").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("11", { selector: "output" })).toBeDefined();
  });
});

describe("the mix", () => {
  test("two handles with the keyboard: ← → by 5 %, the legend follows, «Сбросить» puts 70 / 20 / 10 back and the focus on the first handle", async () => {
    world();
    await openAutopilot();
    const first = screen.getByRole("slider", { name: "Граница «Одно фото» и «Коллаж»" });
    const second = screen.getByRole("slider", { name: "Граница «Коллаж» и «Слайды»" });
    expect(screen.getByText("по умолчанию")).toBeDefined();
    first.focus();
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    fireEvent.keyDown(first, { key: "ArrowLeft" });
    expect(first.getAttribute("aria-valuenow")).toBe("60");
    expect(first.getAttribute("aria-valuetext")).toBe("одно фото 60 %, коллаж 30 %");
    fireEvent.keyDown(second, { key: "End" });
    expect(second.getAttribute("aria-valuetext")).toBe("коллаж 40 %, слайды 0 %");
    expect(screen.getByText("40%")).toBeDefined();
    expect(localStorage.getItem(MIX_KEY)).toBe("60/40/0");
    expect(screen.getByText(/^На аватар 6 · 4 · 0/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Сбросить · 70 / 20 / 10" }));
    await flush();
    expect(first.getAttribute("aria-valuenow")).toBe("70");
    expect(describeElement(document.activeElement)).toBe(describeElement(screen.getByRole("slider", { name: "Граница «Одно фото» и «Коллаж»" })));
    expect(localStorage.getItem(MIX_KEY)).toBe("70/20/10");
  });

  test("the remembered mix is the next window's", async () => {
    localStorage.setItem(MIX_KEY, "50/20/30");
    world();
    await openAutopilot();
    expect(screen.getByRole("slider", { name: "Граница «Одно фото» и «Коллаж»" }).getAttribute("aria-valuenow")).toBe("50");
    expect(screen.getByRole("button", { name: "Сбросить · 70 / 20 / 10" })).toBeDefined();
  });
});

describe("the month's budget", () => {
  // Mia, library off: 10 videos are 7 singles, 2 collages of 3 and slides of 5 = 18 new photos; worst 18 × 3 × $0.07 + one writer chunk $0.075 = $3.855,
  // expected 18 × ≈ $0.0705 ≈ $1.27 (the mock's unit prices).
  async function miaFromScratch(): Promise<void> {
    await openAutopilot();
    fireEvent.click(screen.getByRole("switch", { name: "Сначала свободные фото из библиотеки" }));
    await choose("Mia");
  }

  test("fits-expected: «Хватит, если без повторов» with the raise to ⌈W − R + B⌉ that opens Settings; the launch may go", async () => {
    world({ money: { monthlyBudgetMicros: 3_000_000 } });
    await miaFromScratch();
    const note = screen.getByText("Хватит, если без повторов").closest(".notice");
    expect(note?.getAttribute("role")).toBe("status");
    expect(goButton().getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(within(note as HTMLElement).getByRole("button", { name: "поднимите бюджет до $4" }));
    await screen.findByRole("heading", { level: 1, name: "Настройки" });
  });

  test("short: «Бюджета не хватит», «Запустить» closed with its reason, and a click sends nothing", async () => {
    const { engine } = world({ money: { monthlyBudgetMicros: 1_000_000 } });
    await miaFromScratch();
    expect(screen.getByText("Бюджета не хватит").closest(".notice")?.getAttribute("role")).toBe("alert");
    expect(screen.getByText(/^Не хватит даже на ожидаемую цену: свободно \$1\.00, нужно ≈ \$1\.27/)).toBeDefined();
    const go = goButton();
    expect(go.getAttribute("aria-disabled")).toBe("true");
    expect(descriptionOf(go)).toBe(GO_WHY.short);
    fireEvent.click(go);
    await flush();
    expect(callsOf(engine, "autopilot.start")).toHaveLength(0);
  });
});

describe("what blocks the launch", () => {
  test("an open scene set: a tag on the avatar's row, «Запуск не собрать» with its fix, a link to its «Фото»", async () => {
    world({ sceneSets: [{ avatarId: SOFIA.avatarId, sceneSetId: "set-sofia-0001", count: 5, written: 5 }] });
    await openAutopilot();
    await choose("Mia", "Sofia");
    expect(descriptionOf(avatarButton("Sofia"))).toBe("набор сцен 4 своб.");
    expect(screen.getByText("Запуск не собрать")).toBeDefined();
    expect(goButton().getAttribute("aria-disabled")).toBe("true");
    expect(descriptionOf(goButton())).toBe(GO_WHY.blocked);
    fireEvent.click(screen.getByRole("button", { name: "«Фото»" }));
    await screen.findByRole("heading", { level: 1, name: "Sofia" });
  });

  test("over 100 new photos: «> 100 фото» and its own reason", async () => {
    localStorage.setItem(MIX_KEY, "50/20/30");
    world();
    await openAutopilot();
    fireEvent.click(screen.getByRole("switch", { name: "Сначала свободные фото из библиотеки" }));
    const more = screen.getByRole("button", { name: "Больше видео" });
    for (let i = 0; i < 40; i++) fireEvent.click(more);
    await choose("Mia");
    expect(descriptionOf(avatarButton("Mia"))).toBe("> 100 фото 31 своб.");
    expect(screen.getByText("Больше 100 новых фото на аватара")).toBeDefined();
    expect(screen.getByText(/нужно 130 новых фото, больше 100 за запуск нельзя/)).toBeDefined();
    expect(descriptionOf(goButton())).toBe(GO_WHY.tooMany);
    // Nothing is left to count: no «0 видео · бесплатно», no limit.
    expect(goButton().textContent).toBe("Запустить");
    expect(screen.getByText("—", { selector: ".ap-limit" })).toBeDefined();
  });

  test("usage that cannot be read: «нет данных» on the row whether chosen or not", async () => {
    world({ extra: [{ ...VERA, usage: { state: "unknown", reasons: ["index-stale"] } }] });
    await openAutopilot();
    await waitFor(() => expect(descriptionOf(avatarButton("Vera"))).toBe("нет данных — своб."));
    await choose("Vera");
    expect(screen.getByText(/не читается, какие её фото заняты/)).toBeDefined();
  });

  test("no OpenRouter key: closed with the way out, generation off builds from the library for free", async () => {
    world({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
    await openAutopilot();
    await choose("Sofia");
    expect(descriptionOf(goButton())).toBe(GO_WHY.noKey);
    fireEvent.click(screen.getByRole("switch", { name: "Догенерировать недостающие" }));
    await flush();
    await settled();
    // Sofia's 4 free photos make one collage and one single (the mock's sizes); the rest of her ten are dropped, nothing is paid.
    expect(goButton().textContent).toBe(`Запустить: 2${NBSP}видео · бесплатно`);
    expect(goButton().getAttribute("aria-disabled")).toBeNull();
  });

  test("library only: «Видео: N из M — не хватает фото» per avatar, «бесплатно», no month bar", async () => {
    world();
    await openAutopilot();
    fireEvent.click(screen.getByRole("switch", { name: "Догенерировать недостающие" }));
    await choose("Mia", "Sofia");
    expect(screen.getByText(/^Видео: \d+ из 20 — не хватает фото$/)).toBeDefined();
    expect(screen.getByText(/^: \d из 10 — свободных фото в этих категориях 4\.$/)).toBeDefined();
    expect(goButton().textContent).toMatch(/· бесплатно$/);
    expect(screen.queryByText("В месяце свободно") === null).toBe(true);
    expect(screen.getByText("бесплатно", { selector: ".ap-limit" })).toBeDefined();
  });

  test("both sources off, no category, no active avatar: each closes «Запустить» with its own reason", async () => {
    const { engine } = world();
    await openAutopilot();
    await choose("Mia");
    fireEvent.click(screen.getByRole("switch", { name: "Сначала свободные фото из библиотеки" }));
    fireEvent.click(screen.getByRole("switch", { name: "Догенерировать недостающие" }));
    expect(descriptionOf(goButton())).toBe(GO_WHY.nothingEnabled);
    fireEvent.click(screen.getByRole("switch", { name: "Сначала свободные фото из библиотеки" }));
    for (const label of ["Дом", "Путешествия", "Фотосессия", "Фитнес"]) fireEvent.click(screen.getByRole("button", { name: label }));
    expect(descriptionOf(goButton())).toBe(GO_WHY.noCategory);
    expect(callsOf(engine, "autopilot.start")).toHaveLength(0);
  });

  test("no active avatar: the list says so and opens «Аватары»", async () => {
    setup({ avatars: [NORA] });
    await openAutopilot();
    expect(screen.getByText("Активных аватаров нет")).toBeDefined();
    expect(descriptionOf(goButton())).toBe(GO_WHY.noAvatars);
    fireEvent.click(screen.getByRole("button", { name: "Открыть «Аватары»" }));
    await screen.findByRole("heading", { level: 1, name: "Аватары" });
  });
});

describe("«Запустить»", () => {
  test("sends exactly the plan's worst case and seed; the settings turn read only, the plan folds and the focus goes to «Идёт запуск»", async () => {
    wideWindow();
    const { engine, client } = world({ sceneReview: "off" });
    await openAutopilot();
    await choose("Mia", "Elena");
    const preview = await lastPreview(engine, client);
    const go = goButton();
    go.focus();
    fireEvent.click(go);
    await flush();
    const [sent] = callsOf(engine, "autopilot.start");
    expect(sent?.payload.acceptedWorstMicros).toBe(preview.estimate.worstMicros);
    expect(sent?.payload.draft).toMatchObject({ avatarIds: [MIA.avatarId, ELENA.avatarId], planSeed: preview.planSeed, sceneReview: false });
    const live = await screen.findByRole("heading", { level: 2, name: "Идёт запуск" });
    await waitFor(() => expect(describeElement(document.activeElement)).toBe(describeElement(live)));
    // The plan card is gone; «План запуска» says what was accepted (drawn at 1440).
    expect(screen.queryByRole("heading", { level: 2, name: "План" }) === null).toBe(true);
    expect(screen.queryByRole("button", { name: /^Запустить/ }) === null).toBe(true);
    expect(screen.getByRole("heading", { level: 2, name: "План запуска" })).toBeDefined();
    expect(screen.getByText(`предел до ${formatUsdTiered(preview.estimate.worstMicros, "up")}`)).toBeDefined();
    expect(screen.getByText(/^Это настройки идущего запуска/)).toBeDefined();
  });

  test("a running launch's settings cannot be changed, and nothing is estimated while it runs", async () => {
    const { engine } = world({ sceneReview: "off" });
    await openAutopilot();
    await choose("Mia");
    fireEvent.click(goButton());
    await screen.findByRole("heading", { level: 2, name: "Идёт запуск" });
    const asked = callsOf(engine, "autopilot.estimate").length;
    const mia = avatarButton("Mia");
    expect(mia.getAttribute("aria-pressed")).toBe("true");
    expect(mia.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(avatarButton("Sofia"));
    expect(avatarButton("Sofia").getAttribute("aria-pressed")).toBe("false");
    const more = screen.getByRole("button", { name: "Больше видео" });
    expect(more.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(more);
    fireEvent.keyDown(screen.getByRole("slider", { name: "Граница «Одно фото» и «Коллаж»" }), { key: "ArrowLeft" });
    fireEvent.click(screen.getByRole("switch", { name: "GIF-стикеры" }));
    expect(screen.getByText("10", { selector: "output" })).toBeDefined();
    expect(screen.getByRole("slider", { name: "Граница «Одно фото» и «Коллаж»" }).getAttribute("aria-valuenow")).toBe("70");
    expect(screen.getByRole("switch", { name: "GIF-стикеры" }).getAttribute("aria-checked")).toBe("false");
    // «Все» / «Никого» belong to a form that can change; the music line keeps the last plan's words.
    expect(screen.queryByRole("button", { name: "Все" }) === null).toBe(true);
    expect(screen.getByText(/^Тренды \+ мои · 0\sтреков$/)).toBeDefined();
    await new Promise((resolve) => setTimeout(resolve, 300));
    await flush();
    expect(callsOf(engine, "autopilot.estimate").length).toBe(asked);
  });

  test("PRICE_CHANGED: the new price on the button and in a note, the focus stays on it; the next click starts with the new price", async () => {
    const { engine, client } = world({ sceneReview: "off" });
    await openAutopilot();
    await choose("Mia", "Sofia");
    const before = await lastPreview(engine, client);
    engine.setRunImagePrice(80_000);
    const go = goButton();
    go.focus();
    fireEvent.click(go);
    await flush();
    await settled();
    const after = await lastPreview(engine, client);
    expect(after.estimate.worstMicros).toBeGreaterThan(before.estimate.worstMicros);
    expect(screen.getByText("Цена выросла")).toBeDefined();
    expect(screen.getByText(`Было не больше ${formatUsdTiered(before.estimate.worstMicros, "up")}, теперь ${formatUsdTiered(after.estimate.worstMicros, "up")}.`)).toBeDefined();
    expect(goButton().textContent).toBe(titleOf(after));
    expect(describeElement(document.activeElement)).toBe(describeElement(goButton()));
    expect(screen.queryByRole("heading", { level: 2, name: "Идёт запуск" }) === null).toBe(true);
    fireEvent.click(goButton());
    await flush();
    const starts = callsOf(engine, "autopilot.start");
    expect(starts).toHaveLength(2);
    expect(starts[1]?.payload.acceptedWorstMicros).toBe(after.estimate.worstMicros);
    await screen.findByRole("heading", { level: 2, name: "Идёт запуск" });
  });

  test("a launch already unfinished when the screen opens shows its own settings read only", async () => {
    const { client } = world();
    await flush();
    const draft: LaunchDraftInput = {
      avatarIds: [SOFIA.avatarId],
      videosPerAvatar: 3,
      mix: { single: 70, collage: 20, slides: 10 },
      categories: ["home"],
      poses: { profile: true, back: false },
      library: true,
      generate: true,
      sceneReview: true,
      stickers: true,
    };
    await act(async () => {
      const estimate = await client.request("autopilot.estimate", { draft });
      if (!estimate.ok) throw new Error("estimate refused");
      const started = await client.request("autopilot.start", { draft: { ...draft, planSeed: estimate.result.preview.planSeed }, acceptedWorstMicros: estimate.result.preview.estimate.worstMicros });
      if (!started.ok) throw new Error("start refused");
    });
    await openAutopilot();
    expect(screen.getByText(/^Это настройки идущего запуска/)).toBeDefined();
    expect(avatarButton("Sofia").getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByText("3", { selector: "output" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Профиль" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "Путешествия" }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("switch", { name: "GIF-стикеры" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByRole("heading", { level: 2, name: "Идёт запуск" })).toBeDefined();
  });
});

describe("the sidebar's mark at «Автопилот»", () => {
  const nav = (): HTMLElement => within(screen.getByRole("navigation", { name: "Разделы" })).getByRole("button", { name: "Автопилот" });

  test("the count while it runs, seen from another screen; «пауза» on pause; nothing once stopped; the item's name stays «Автопилот»", async () => {
    const { client } = world({ sceneReview: "off" });
    await openAutopilot();
    expect(nav().getAttribute("aria-describedby")).toBeNull();
    await choose("Mia");
    fireEvent.click(goButton());
    await screen.findByRole("heading", { level: 2, name: "Идёт запуск" });
    await openSection("Аватары");
    expect(descriptionOf(nav())).toMatch(/^идёт: готово \d+ из 10 видео$/);
    expect(nav().textContent).toMatch(/^Автопилот\d+ \/ 10/);
    const listed = await client.request("autopilot.list", {});
    if (!listed.ok) throw new Error("list refused");
    const id = listed.result.launches[0]?.launchId ?? "";
    await act(async () => {
      await client.request("autopilot.pause", { launchId: id });
    });
    expect(descriptionOf(nav())).toBe("запуск на паузе");
    await act(async () => {
      await client.request("autopilot.stop", { launchId: id });
    });
    expect(nav().getAttribute("aria-describedby")).toBeNull();
  });

  test("«сцены» while an avatar's scenes wait for the owner", async () => {
    world({ sceneReview: "on" });
    await openAutopilot();
    fireEvent.click(screen.getByRole("switch", { name: "Сначала свободные фото из библиотеки" }));
    await choose("Mia");
    fireEvent.click(goButton());
    await screen.findByRole("heading", { level: 2, name: "Идёт запуск" });
    expect(descriptionOf(nav())).toBe("сцены ждут проверки");
  });
});

describe("React's StrictMode (the dev build runs the window in it)", () => {
  // H1 (S4.9a round 1): StrictMode runs every effect, cleans it up and runs it again. A «mounted» flag that the cleanup turned off and nothing turned back on
  // dropped every answer: the plan never came and «Считаем…» hung. The window is rendered here as main.tsx renders it, in <StrictMode>, on a root of its own.
  test("the plan of a chosen avatar comes, and «Запустить» names it; the list's probe comes too", async () => {
    const engine = new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0, ...library() });
    engine.setRunImagePrice(70_000);
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await act(async () => {
        root.render(
          <StrictMode>
            <App client={mockEngineClient(engine)} />
          </StrictMode>,
        );
      });
      await flush();
      await openSection("Автопилот");
      await screen.findByRole("heading", { level: 1, name: "Автопилот" });
      await flush();
      fireEvent.click(avatarButton("Mia"));
      await waitFor(() => expect(goButton().textContent).toMatch(/^Запустить: \d+\sвидео · /), { timeout: 2_000 });
      expect(goButton().getAttribute("aria-busy")).toBeNull();
      expect(goButton().getAttribute("aria-disabled")).toBeNull();
      await waitFor(() => expect(descriptionOf(avatarButton("Elena"))).toBe("14 своб."), { timeout: 2_000 });
    } finally {
      await act(async () => root.unmount());
      container.remove();
    }
  });
});

describe("«Стоп»", () => {
  /** A launch that pays for new photos (the library off), so the dialog has a spend to say. */
  async function running(): Promise<ReturnType<typeof world>> {
    const utils = world({ sceneReview: "off" });
    await openAutopilot();
    fireEvent.click(screen.getByRole("switch", { name: "Сначала свободные фото из библиотеки" }));
    await choose("Mia");
    fireEvent.click(goButton());
    await screen.findByRole("heading", { level: 2, name: "Идёт запуск" });
    return utils;
  }

  test("asks first: the dialog takes the focus on «Отмена»; Escape and «Отмена» close it and put the focus back on «Стоп»", async () => {
    const { engine } = await running();
    fireEvent.click(screen.getByRole("button", { name: "Стоп" }));
    const dialog = await screen.findByRole("alertdialog", { name: "Остановить запуск?" });
    expect(within(dialog).getByText(/^Новых запросов и рендеров не будет/)).toBeDefined();
    expect(within(dialog).getByText("Останется")).toBeDefined();
    expect(within(dialog).getByText(/^Потрачено \$[\d.]+ из \$[\d.]+ — остальное запуск уже не потратит\.$/)).toBeDefined();
    await waitFor(() => expect(describeElement(document.activeElement)).toBe(describeElement(within(dialog).getByRole("button", { name: "Отмена" }))));
    fireEvent.keyDown(window, { key: "Escape" });
    await waitFor(() => expect(screen.queryByRole("alertdialog") === null).toBe(true));
    expect(describeElement(document.activeElement)).toBe(describeElement(screen.getByRole("button", { name: "Стоп" })));
    fireEvent.click(screen.getByRole("button", { name: "Стоп" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Отмена" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog") === null).toBe(true));
    expect(describeElement(document.activeElement)).toBe(describeElement(screen.getByRole("button", { name: "Стоп" })));
    expect(callsOf(engine, "autopilot.stop")).toHaveLength(0);
    expect(screen.getByRole("heading", { level: 2, name: "Идёт запуск" })).toBeDefined();
  });

  test("«Остановить» stops the launch: «Останавливаем…» until the engine says stopped, the focus on the heading, then the form opens again", async () => {
    const { engine, scheduler } = await running();
    engine.delayNext("autopilot.stop", 1_000);
    fireEvent.click(screen.getByRole("button", { name: "Стоп" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Остановить" }));
    await flush();
    const heading = screen.getByRole("heading", { level: 2, name: "Останавливаем…" });
    await waitFor(() => expect(describeElement(document.activeElement)).toBe(describeElement(heading)));
    expect(screen.getByText(/^Новых трат не будет\./)).toBeDefined();
    expect(screen.getByRole("button", { name: "Стоп" }).getAttribute("aria-disabled")).toBe("true");
    const [sent] = callsOf(engine, "autopilot.stop");
    expect(sent?.payload.launchId).toMatch(/^launch-/);
    // The settings stay the launch's until it has stopped.
    expect(screen.getByText(/^Это настройки идущего запуска/)).toBeDefined();
    tick(scheduler);
    await flush();
    const stopped = await screen.findByRole("heading", { level: 2, name: "Запуск остановлен" });
    // The same heading, renamed: the focus stayed on it.
    expect(describeElement(document.activeElement)).toBe(describeElement(stopped));
    expect(screen.queryByRole("button", { name: "Стоп" }) === null).toBe(true);
    expect(screen.queryByText(/^Это настройки идущего запуска/) === null).toBe(true);
    expect(avatarButton("Mia").getAttribute("aria-disabled")).toBeNull();
    expect(goButton()).toBeDefined();
  });

  test("a refused stop says why and offers «Стоп» again", async () => {
    const { engine } = await running();
    engine.failNext("autopilot.stop", { code: "VALIDATION", detail: "launch is stopping" });
    fireEvent.click(screen.getByRole("button", { name: "Стоп" }));
    fireEvent.click(within(await screen.findByRole("alertdialog")).getByRole("button", { name: "Остановить" }));
    await flush();
    expect(screen.getByRole("heading", { level: 2, name: "Идёт запуск" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Стоп" }).getAttribute("aria-disabled")).toBeNull();
    expect(screen.getByRole("alert")).toBeDefined();
  });
});

describe("the engine's world moves", () => {
  // M2 (round 1): a burst of engine events (a run storing photos, a reject marked ten times) asks the plan once and the probe once, a moment after it ends.
  test("ten avatar.changed within a second ask one plan and one probe; a budget change re-plans and does not re-probe", async () => {
    const { engine, client } = world();
    await openAutopilot();
    await choose("Mia");
    await waitFor(() => expect(descriptionOf(avatarButton("Elena"))).toBe("14 своб."));
    const probes = (): number => callsOf(engine, "autopilot.estimate").length - planCalls(engine).length;
    const plansBefore = planCalls(engine).length;
    const probesBefore = probes();
    for (let i = 0; i < 10; i++) {
      await act(async () => {
        await client.request("photos.setRejected", { avatarId: MIA.avatarId, photoId: "photo-mia-0001", rejected: i % 2 === 0 });
        await new Promise((resolve) => setTimeout(resolve, 90));
      });
    }
    // Within the burst's quiet time: nothing asked yet.
    expect(planCalls(engine).length).toBe(plansBefore);
    expect(probes()).toBe(probesBefore);
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, WORLD_DEBOUNCE_MS + 400));
    });
    await flush();
    expect(planCalls(engine).length).toBe(plansBefore + 1);
    expect(probes()).toBe(probesBefore + 1);

    await act(async () => {
      await client.request("settings.setBudget", { monthlyBudgetMicros: 20_000_000 });
    });
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, WORLD_DEBOUNCE_MS + 400));
    });
    await flush();
    expect(planCalls(engine).length).toBe(plansBefore + 2);
    expect(probes()).toBe(probesBefore + 1);
  });
});
