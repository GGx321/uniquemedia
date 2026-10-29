import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { PRICE_SCOPES_RU, type AvatarSummary, type LaunchDraftInput, type PhotoSummary } from "../../shared/engine";
import type { MockEngine } from "../engine/mockEngine";
import { freePhotos, MIA, SOFIA } from "../engine/mockEngine.testkit";
import { errorText } from "../lib/errors";
import { callsOf, flush, openSection, setup } from "../testing";
import { launchLevelCaption } from "./photos/level";
import { launchMonthLine } from "./autopilot/monthLine";

// S5.9g (plan s5a3 §13.1 «Autopilot», §10.2 option B; mockups 52 and 53 of .omc/stage5/design): «Автопилот» gets «Смелая» too. «Ночнушки и бельё» and «Пляж и
// бассейн» join «Категории сцен» with the card's gating (they work only under «Смелая»; a pick is kept, off, under another «Подача»); the caption counts the
// plan's new frames from the shared rules; «Предел запуска» says that every new photo is priced at the Seedream 2K unit at any «Смелая» launch (5a.4, I5.77); the launch's
// page says «Подача: смелая».

/** A caption as testing-library reads text: its spaces plain. The words are pinned in `photos/levelCaption.test.ts`; here the screen is held to saying them. */
const plain = (text: string | null): string => {
  if (text === null) throw new Error("the launch has something to say here");
  return text.replace(/\s+/g, " ");
};
const GATED = "Только со «Смелой»: «Ночнушки и бельё» и «Пляж и бассейн».";
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
/** The plan calls (not the list's probe). */
function planCalls(engine: MockEngine) {
  return callsOf(engine, "autopilot.estimate").filter((c) => !(c.payload.draft.videosPerAvatar === 1 && !c.payload.draft.generate && c.payload.draft.library));
}
function limitSub(): string {
  const row = within(settings()).getByText("Предел запуска").closest(".rl");
  return row?.querySelector("span")?.textContent ?? "";
}

describe("«Категории сцен» with the two «Смелая» chips (mockup 52)", () => {

  test("«Смелая»: the two work, the draft asks `level: \"bold\"` with them, the caption counts the plan's new frames, «Предел запуска» says option B", async () => {
    const { engine, client } = world();
    await openAutopilot();
    await choose("Mia");
    await click(level("Смелая"));
    expect(within(settings()).queryByText(GATED) === null).toBe(true);
    // 5a.4 (r2.2 I5.77, §5.9 row 21): option B holds at any «Смелая» launch, the five included.
    expect(limitSub()).toBe(LIMIT_BOLD);
    await only("Ночнушки и бельё", "Пляж и бассейн");
    expect(within(settings()).getByText("2 из 7")).toBeDefined();
    const draft = planCalls(engine).at(-1)?.payload.draft;
    if (draft === undefined) throw new Error("no plan was asked");
    expect(draft.level).toBe("bold");
    expect(draft.categories).toEqual(["nightwear", "beach"]);
    const reply = await client.request("autopilot.estimate", { draft });
    if (!reply.ok) throw new Error("estimate refused");
    const { preview } = reply.result;
    expect(preview.totals.toGenerate).toBeGreaterThan(0);
    // The caption sums the engine's own plan, avatar by avatar (Mia is read as imported: no cover clause).
    const caption = launchLevelCaption("bold", preview, draft.categories, { avatars: [{ name: MIA.name, origin: MIA.origin }], legs: 0, customs: [] });
    expect(within(settings()).getByText(plain(caption))).toBeDefined();
    expect(limitSub()).toBe(LIMIT_BOLD);
    // The launch starts: the plan's button gives way to the live card, so this click waits for nothing on it.
    fireEvent.click(goButton());
    await flush();
    const started = callsOf(engine, "autopilot.start").at(-1)?.payload.draft;
    expect(started?.level).toBe("bold");
    expect(started?.categories).toEqual(["nightwear", "beach"]);
  });

  // 5a.4 (S5.BA8a, §5.9 row 22a, r2.3 M3): the avatar list's «своб.» legend says whose frames are free.

  // 5a.4 (S5.BA8b, §5.9 row 22, r2.2 D2): at «Смелая» the library offers only the routed frames, so its switch says so; the other levels keep their line.

  // Review M-1: the probe that counts the «своб.» of the avatars not chosen asks at the form's level, so at «Смелая» their number is of the routed frames only, like the plan's.

  // 5a.4 (S5.BA8a, §5.9 row 20, r2.3 M1): the month line divides the budget by the plan's own unit; the window computes no price.
  test("the month line at «Смелая» is the plan's unit over the month's budget, and only there", async () => {
    const { engine, client } = world();
    await openAutopilot();
    await choose("Mia");
    expect(within(settings()).queryByText(/^Каждое фото «Смелой»/) === null).toBe(true);
    await click(level("Смелая"));
    const draft = planCalls(engine).at(-1)?.payload.draft;
    if (draft === undefined) throw new Error("no plan was asked");
    const reply = await client.request("autopilot.estimate", { draft });
    if (!reply.ok) throw new Error("estimate refused");
    const { preview } = reply.result;
    if (preview.unitPhotoWorstMicros === undefined) throw new Error("the plan names no unit");
    const line = launchMonthLine("bold", preview, false);
    const shown = within(settings()).getByText(plain(line));
    expect(plain(line)).toMatch(/^Каждое фото «Смелой» — до \$\d/);
    // Mockup 67: a quiet note under the caption, as the card's slow-frames line is (S5.BA8a review).
    expect(shown.className).toBe("ap-row-note gen-cap gen-cap-quiet");
    await click(level("Кокетливая"));
    expect(within(settings()).queryByText(/^Каждое фото «Смелой»/) === null).toBe(true);
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
    // A running launch has no plan to count (its photos are drawing): the share of ten, as before.
    const running = launchLevelCaption("bold", null, ["nightwear", "beach"], { avatars: [{ name: SOFIA.name, origin: SOFIA.origin }], legs: 0, customs: [] });
    expect(within(settings()).getByText(plain(running))).toBeDefined();
  });

  // Round 3 (LOW): the launch says how many new photos each avatar draws (`photos.total`; 0 is «только библиотека»): with none at all, there is no bold frame to speak of.
  
});

// Round 2 (e): a start refused for the 2K tier alone says state 55's sentence too, not the general price text.
describe("«Запустить» refused for the 2K tier", () => {
  test("shows state 55's warning, never the general price text", async () => {
    const { engine } = world();
    await openAutopilot();
    await choose("Mia");
    await click(level("Смелая"));
    await click(categoryChip("Ночнушки и бельё"));
    engine.failNext("autopilot.start", { code: "PRICE_UNAVAILABLE", priceScope: "bold", detail: "the price list has no 2K tier" });
    fireEvent.click(goButton());
    await flush();
    const notice = await screen.findByText(PRICE_SCOPES_RU.bold);
    expect(notice.closest(".notice")?.classList.contains("notice-warn")).toBe(true);
    expect(screen.queryByText(errorText({ code: "PRICE_UNAVAILABLE" })) === null).toBe(true);
  });
});

