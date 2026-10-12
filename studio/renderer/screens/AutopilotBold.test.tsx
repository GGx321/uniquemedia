import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { PRICE_SCOPES_RU, type AvatarSummary, type LaunchDraftInput, type PhotoSummary } from "../../shared/engine";
import type { MockEngine } from "../engine/mockEngine";
import { freePhotos, MIA, SOFIA } from "../engine/mockEngine.testkit";
import { errorText } from "../lib/errors";
import { callsOf, flush, openSection, setup } from "../testing";
import { historyLibrary, octAt } from "./autopilot/historyTestkit";
import { levelFrames } from "./photos/level";

// S5.9g (plan s5a3 §13.1 «Autopilot», §10.2 option B; mockups 52 and 53 of .omc/stage5/design): «Автопилот» gets «Смелая» too. «Ночнушки и бельё» and «Пляж и
// бассейн» join «Категории сцен» with the card's gating (they work only under «Смелая»; a pick is kept, off, under another «Подача»); the caption counts the
// plan's new frames from the shared rules; «Предел запуска» says that every new photo is priced at the Seedream 2K unit only while a «Смелая» category is on
// under «Смелая»; the launch's page says «Подача: смелая».

/** The no-break space between a count and its word, as testing-library's text matching normalises it: a plain space. */
const NB = " ";
const GATED = "Только со «Смелой»: «Ночнушки и бельё» и «Пляж и бассейн».";
const LIMIT_PLAIN = "худшая цена: до 3 попыток на фото — дороже не выйдет";
const LIMIT_BOLD = "худшая цена: до 3 попыток на фото — дороже не выйдет; со «Смелой» каждое новое фото считается по цене Seedream 2K";

function world() {
  const roster: AvatarSummary[] = [MIA, SOFIA];
  const photos: PhotoSummary[] = [...freePhotos(3, MIA), ...freePhotos(2, SOFIA)];
  const utils = setup({ avatars: roster.map((a) => ({ ...a, photoCount: 3, eligibleUnusedCount: 3 })), photos, launchRun: "canned" });
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
function level(name: "Обычная" | "Кокетливая" | "Смелая"): HTMLInputElement {
  const radio = within(within(settings()).getByRole("radiogroup", { name: "Подача" })).getByRole("radio", { name });
  if (!(radio instanceof HTMLInputElement)) throw new Error("a level is a native radio");
  return radio;
}
function categoryChip(name: string): HTMLElement {
  return within(within(settings()).getByRole("group", { name: "Категории сцен" })).getByRole("button", { name });
}
const goButton = (): HTMLElement => screen.getByRole("button", { name: /^(Запустить|Считаем…|Запускаем…|Повторить оценку)/ });
async function settle(): Promise<void> {
  await flush();
  await waitFor(() => expect(goButton().getAttribute("aria-busy")).toBeNull());
}
async function click(el: HTMLElement): Promise<void> {
  fireEvent.click(el);
  await settle();
}
async function choose(name: string): Promise<void> {
  await click(within(screen.getByRole("group", { name: /^Аватары/ })).getByRole("button", { name }));
}
/** Leaves on exactly the named categories (a gated chip is left as it is). */
async function only(...names: string[]): Promise<void> {
  for (const name of ["Дом", "Виды", "Улица", "Гламур", "Фитнес", "Ночнушки и бельё", "Пляж и бассейн"]) {
    const el = categoryChip(name);
    if (el.getAttribute("aria-disabled") === "true") continue;
    if ((el.getAttribute("aria-pressed") === "true") !== names.includes(name)) await click(el);
  }
}
function described(el: HTMLElement): string[] {
  return (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean).map((id) => document.getElementById(id)?.textContent ?? "");
}
/** The plan calls (not the list's probe). */
function planCalls(engine: MockEngine) {
  return callsOf(engine, "autopilot.estimate").filter((c) => !(c.payload.draft.videosPerAvatar === 1 && !c.payload.draft.generate && c.payload.draft.library));
}
function limitSub(): string {
  const row = within(settings()).getByText("Предел запуска").closest(".rl");
  return row?.querySelector("span")?.textContent ?? "";
}

describe("«Категории сцен» with the two «Смелая» chips (mockup 52)", () => {
  test("they follow the five, never on by default, and wait for «Смелая»: dimmed, described by the note, a click does nothing", async () => {
    const { engine } = world();
    await openAutopilot();
    const chips = within(within(settings()).getByRole("group", { name: "Категории сцен" })).getAllByRole("button").map((b) => b.textContent);
    expect(chips).toEqual(["Дом", "Виды", "Улица", "Гламур", "Фитнес", "Ночнушки и бельё", "Пляж и бассейн"]);
    expect(within(settings()).getByText("4 из 7")).toBeDefined();
    for (const name of ["Ночнушки и бельё", "Пляж и бассейн"]) {
      const el = categoryChip(name);
      expect(el.getAttribute("aria-pressed")).toBe("false");
      expect(el.getAttribute("aria-disabled")).toBe("true");
      expect(el.classList.contains("gen-chip-gated")).toBe(true);
      expect(described(el)).toEqual([GATED]);
      fireEvent.click(el);
      await flush();
      expect(categoryChip(name).getAttribute("aria-pressed")).toBe("false");
    }
    await choose("Mia");
    expect(planCalls(engine).some((c) => c.payload.draft.categories.some((ref) => ref === "nightwear" || ref === "beach"))).toBe(false);
  });

  test("«Смелая»: the two work, the draft asks `level: \"bold\"` with them, the caption counts the plan's new frames, «Предел запуска» says option B", async () => {
    const { engine, client } = world();
    await openAutopilot();
    await choose("Mia");
    await click(level("Смелая"));
    expect(within(settings()).queryByText(GATED) === null).toBe(true);
    expect(limitSub()).toBe(LIMIT_PLAIN);
    await only("Ночнушки и бельё", "Пляж и бассейн");
    expect(within(settings()).getByText("2 из 7")).toBeDefined();
    const draft = planCalls(engine).at(-1)?.payload.draft;
    if (draft === undefined) throw new Error("no plan was asked");
    expect(draft.level).toBe("bold");
    expect(draft.categories).toEqual(["nightwear", "beach"]);
    const reply = await client.request("autopilot.estimate", { draft });
    if (!reply.ok) throw new Error("estimate refused");
    const { preview } = reply.result;
    const counted = preview.avatars.filter((a) => a.blocked === null).map((a) => levelFrames(a.toGenerate, draft.categories, "bold"));
    const bold = counted.reduce((sum, c) => sum + c.bold, 0);
    const flirty = counted.reduce((sum, c) => sum + c.flirty, 0);
    expect(preview.totals.toGenerate).toBeGreaterThan(0);
    const words = preview.totals.toGenerate % 10 === 1 && preview.totals.toGenerate % 100 !== 11 ? "нового кадра" : "новых кадров";
    expect(within(settings()).getByText(`≈ ${bold} из ${preview.totals.toGenerate}${NB}${words} — смелые: бельё, купальники; ${flirty} — кокетливые. Смелые кадры рисует Seedream 5 Pro · 2K.`)).toBeDefined();
    expect(limitSub()).toBe(LIMIT_BOLD);
    // The launch starts: the plan's button gives way to the live card, so this click waits for nothing on it.
    fireEvent.click(goButton());
    await flush();
    const started = callsOf(engine, "autopilot.start").at(-1)?.payload.draft;
    expect(started?.level).toBe("bold");
    expect(started?.categories).toEqual(["nightwear", "beach"]);
  });

  test("a pick kept under «Кокетливая»: dashed and dimmed, not pressed, left out of the draft and the count, the option B line gone", async () => {
    const { engine } = world();
    await openAutopilot();
    await choose("Mia");
    await click(level("Смелая"));
    await click(categoryChip("Ночнушки и бельё"));
    expect(limitSub()).toBe(LIMIT_BOLD);
    await click(level("Кокетливая"));
    const kept = categoryChip("Ночнушки и бельё");
    // Round 2 (L4): kept, but not in this launch — never announced as pressed; its description says it comes back with «Смелая».
    expect(kept.getAttribute("aria-pressed")).toBe("false");
    expect(kept.getAttribute("aria-disabled")).toBe("true");
    expect(kept.classList.contains("gen-chip-kept")).toBe(true);
    expect(described(kept)).toEqual(["Только со «Смелой»: выбранная «Ночнушки и бельё» вернётся вместе с ней."]);
    expect(within(settings()).getByText("Только со «Смелой»: выбранная «Ночнушки и бельё» вернётся вместе с ней.")).toBeDefined();
    expect(within(settings()).getByText("4 из 7")).toBeDefined();
    expect(limitSub()).toBe(LIMIT_PLAIN);
    const draft = planCalls(engine).at(-1)?.payload.draft;
    expect(draft?.level).toBe("flirty");
    expect(draft?.categories).toEqual(["home", "travel", "shoot", "fit"]);
    await click(level("Смелая"));
    expect(planCalls(engine).at(-1)?.payload.draft.categories).toEqual(["home", "travel", "shoot", "fit", "nightwear"]);
  });

  test("guard: no draft the screen asks for names a «Смелая» category without `level: \"bold\"`", async () => {
    const { engine } = world();
    await openAutopilot();
    await choose("Mia");
    await click(level("Смелая"));
    await click(categoryChip("Пляж и бассейн"));
    for (const face of ["Обычная", "Кокетливая", "Смелая", "Обычная"] as const) await click(level(face));
    const drafts = planCalls(engine).map((c) => c.payload.draft);
    expect(drafts.length).toBeGreaterThan(3);
    for (const draft of drafts) if (draft.categories.some((ref) => ref === "nightwear" || ref === "beach")) expect(draft.level).toBe("bold");
  });
});

// Round 2 (L1): a running launch's caption reads the launch's own categories, never the window's form (another window, a restart: the form says otherwise).
describe("a running «Смелая» launch's caption", () => {
  test("names the launch's «Смелая» categories though this window's form holds others", async () => {
    const { client } = world();
    await openAutopilot();
    await choose("Mia");
    const draft: LaunchDraftInput = {
      avatarIds: [SOFIA.avatarId],
      videosPerAvatar: 1,
      mix: { single: 100, collage: 0, slides: 0 },
      categories: ["nightwear", "beach"],
      level: "bold",
      library: true,
      generate: true,
      sceneReview: false,
      stickers: false,
    };
    await act(async () => {
      const estimate = await client.request("autopilot.estimate", { draft });
      if (!estimate.ok) throw new Error("estimate refused");
      const started = await client.request("autopilot.start", { draft: { ...draft, planSeed: estimate.result.preview.planSeed }, acceptedWorstMicros: estimate.result.preview.estimate.worstMicros });
      if (!started.ok) throw new Error("start refused");
    });
    await flush();
    expect(level("Смелая").checked).toBe(true);
    expect(within(settings()).getByText(`≈ 4 из 10${NB}новых кадров — смелые: бельё, купальники; 4 — кокетливые. Смелые кадры рисует Seedream 5 Pro · 2K.`)).toBeDefined();
    expect(within(settings()).queryByText(/^Смелые кадры — только в/) === null).toBe(true);
  });
});

describe("the plan when the 2K price is missing (gap D)", () => {
  test("says state 55's sentence as a warning, never the general price text; without a «Смелая» category it plans as before", async () => {
    const { engine } = world();
    engine.lackBoldPrice();
    await openAutopilot();
    await choose("Mia");
    await click(level("Смелая"));
    await click(categoryChip("Ночнушки и бельё"));
    const notice = await screen.findByText(PRICE_SCOPES_RU.bold);
    expect(notice.closest(".notice")?.classList.contains("notice-warn")).toBe(true);
    expect(screen.queryByText(errorText({ code: "PRICE_UNAVAILABLE" })) === null).toBe(true);
    await click(categoryChip("Ночнушки и бельё"));
    expect(screen.queryByText(PRICE_SCOPES_RU.bold) === null).toBe(true);
    expect(goButton().textContent?.startsWith("Запустить")).toBe(true);
  });
});

describe("a «Смелая» launch's page (mockup 53)", () => {
  test("«Ночнушки и бельё, Пляж и бассейн», then «Подача: смелая» as the brighter bit", async () => {
    const h = setup(historyLibrary());
    const draft: Partial<LaunchDraftInput> = { categories: ["nightwear", "beach"], level: "bold" };
    h.engine.seedLaunch({
      createdAt: octAt(11, 14, 2),
      endedAt: octAt(11, 14, 31),
      draft: { avatarIds: [MIA.avatarId], videosPerAvatar: 1, categories: ["home"], ...draft },
      videos: [{ avatarId: MIA.avatarId, shape: "single", size: 1, state: "done", durationMs: 8_000, bytes: 2_000_000 }],
    });
    await openAutopilot();
    fireEvent.click(screen.getByRole("button", { name: /^История запусков/ }));
    await screen.findByRole("heading", { level: 1, name: "История запусков" });
    await flush();
    fireEvent.click(within(screen.getByRole("region", { name: "Запуски" })).getAllByRole("button", { name: /^Запуск / })[0] ?? document.body);
    await screen.findByRole("heading", { level: 1, name: "Запуск 11 окт., 14:02" });
    await flush();
    const bits = Array.from(document.querySelectorAll(".ap-launch-bits > span")).map((s) => `${s.textContent ?? ""}${s.classList.contains("ap-bit-new") ? " [new]" : ""}`);
    expect(bits.slice(2, 5)).toEqual(["Ночнушки и бельё, Пляж и бассейн", "Подача: смелая [new]", "Ножки: нет [new]"]);
  });
});
