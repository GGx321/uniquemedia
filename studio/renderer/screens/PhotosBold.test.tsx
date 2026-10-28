import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { PRICE_SCOPES_RU, type RunRequest } from "../../shared/engine";
import type { MockEngine } from "../engine/mockEngine";
import { errorText } from "../lib/errors";
import { formatUsd } from "../lib/money";
import { callsOf, flush, openSection, setup } from "../testing";
import { chipsGroup, MIA, openPhotos, PARIS } from "./photos/categoryScreenKit";
import { cardImportedLine, cardLevelCaption, LEVEL_KEY_PREFIX } from "./photos/level";
import type { CategoryRef, CategorySummary } from "../../shared/engine";
import { column, FIXTURE, priceRow } from "./photos/sceneScreenKit";

// S5.9g (plan s5a3 §13.1, §13.2, §14 «S5.9g», gaps C and D; mockups 47, 47a, 47b, 48, 48a and 55 of .omc/stage5/design): «Смелая» on the generate card. All three
// faces of «Подача» are live; «Ночнушки и бельё» and «Пляж и бассейн» are real chips that work only under «Смелая» (dimmed, «Только со «Смелой»», otherwise); a pick
// made under «Смелая» stays in the form, off, and comes back with it; the caption counts from the shared rules; the price line reads the engine's
// `boldAttemptMicros`; a missing 2K price says so (state 55) and nothing else does.

const SLOW = "Кадры «Смелой» рисуются дольше — около минуты каждый.";

/**
 * What the card says at «Смелая» for `count` photos over `categories`, as testing-library reads text (its spaces plain): the caption and the imported-avatar line of Mia, whom the fixtures
 * read as imported. The words are pinned in `photos/levelCaption.test.ts`; here the screen is held to saying them, with the avatar and the library it has.
 */
function said(count: number, categories: readonly CategoryRef[], customs: readonly CategorySummary[] = []): { caption: string; imported: string } {
  const context = { avatar: MIA, legs: 0 as const, customs };
  const plain = (text: string | null): string => {
    if (text === null) throw new Error("the card has something to say here");
    return text.replace(/\s+/g, " ");
  };
  return { caption: plain(cardLevelCaption("bold", count, categories, context)), imported: plain(cardImportedLine("bold", count, categories, context)) };
}
const GATED = "Только со «Смелой»: «Ночнушки и бельё» и «Пляж и бассейн».";
const HINT = {
  // 5a.4 (S5.BA8b, plan s5a4 §5.9 row 12, r2.2 D3): it draws only at «Смелая», always underwear (Q-A2), so it says so at every «Подача».
  nightwear: "Ночнушки и бельё — дома у зеркала и в кровати: бельё, атлас, чулки; в части кадров лицо закрыто телефоном.",
  beach: "Пляж и бассейн — пляж, море и бассейн; снимает подруга или прохожий, иногда телефон на таймере; купальники.",
} as const;

function card(): HTMLElement {
  return screen.getByRole("region", { name: "Генерация фото" });
}
function level(name: "Обычная" | "Кокетливая" | "Смелая"): HTMLInputElement {
  const radio = within(within(card()).getByRole("radiogroup", { name: "Подача" })).getByRole("radio", { name });
  if (!(radio instanceof HTMLInputElement)) throw new Error("a level is a native radio");
  return radio;
}
function chip(name: string): HTMLElement {
  return within(chipsGroup()).getByRole("button", { name: new RegExp(`^${name}`) });
}
async function click(el: HTMLElement): Promise<void> {
  fireEvent.click(el);
  await flush();
}
async function pickLevel(name: "Обычная" | "Кокетливая" | "Смелая"): Promise<void> {
  await click(level(name));
}
/** Leaves on exactly the named chips (the rest of the five off; a gated chip is left as it is). */
async function only(...names: string[]): Promise<void> {
  for (const name of ["Дом", "Виды", "Улица", "Гламур", "Фитнес", "Ночнушки и бельё", "Пляж и бассейн"]) {
    const el = chip(name);
    if (el.getAttribute("aria-disabled") === "true") continue;
    const on = el.getAttribute("aria-pressed") === "true";
    if (on !== names.includes(name)) await click(el);
  }
}
/** The texts of what an element's `aria-describedby` names, in order, their spaces as the matchers read them. */
function described(el: HTMLElement): string[] {
  return (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => (document.getElementById(id)?.textContent ?? "").replace(/\s+/g, " "));
}
function lastEstimate(engine: MockEngine): RunRequest | undefined {
  return callsOf(engine, "runs.estimate").at(-1)?.payload;
}
/** The card's «Ожидаемая» figure as shown. */
function expectedShown(): string {
  const row = Array.from(card().querySelectorAll(".photos-cost-total")).at(0);
  return row?.lastElementChild?.textContent ?? "";
}
type Client = Awaited<ReturnType<typeof openPhotos>>["client"];
/** The engine's own answer to `request`, asked aside (free): the figures the card must show as they are. */
async function engineEstimate(client: Client, request: RunRequest) {
  const reply = await client.request("runs.estimate", request);
  if (!reply.ok) throw new Error("the engine refused the estimate");
  return reply.result.estimate;
}
const escaped = (text: string): string => text.replace(/[$.]/g, "\\$&");
const goName = (count: number, worst: number): RegExp => new RegExp(`^Сгенерировать ${count} фото · до ${escaped(formatUsd(worst, 2, "up"))}$`);

describe("«Подача: Обычная · Кокетливая · Смелая», all live (mockup 47)", () => {
  test("«Смелая» can be chosen like the other two; nothing says it comes later any more", async () => {
    await openPhotos();
    for (const name of ["Обычная", "Кокетливая", "Смелая"] as const) expect(level(name).disabled).toBe(false);
    await pickLevel("Смелая");
    expect(level("Смелая").checked).toBe(true);
    expect(card().textContent?.includes("появится позже") ?? true).toBe(false);
    expect(card().textContent?.includes("появятся позже") ?? true).toBe(false);
  });

  test("47: «Ночнушки и бельё» and «Пляж и бассейн» on, 10 each — the caption, the slow line, the engine's prices and its Seedream line", async () => {
    const { engine, client } = await openPhotos();
    await pickLevel("Смелая");
    await only("Ночнушки и бельё", "Пляж и бассейн");
    expect(chip("Ночнушки и бельё").getAttribute("aria-label")).toBe("Ночнушки и бельё: 10 фото");
    expect(chip("Пляж и бассейн").getAttribute("aria-label")).toBe("Пляж и бассейн: 10 фото");
    const { caption, imported } = said(20, ["nightwear", "beach"]);
    expect(within(card()).getByText(caption)).toBeDefined();
    expect(within(card()).getByText(imported)).toBeDefined();
    expect(within(card()).getByText(SLOW)).toBeDefined();
    expect(described(within(card()).getByRole("radiogroup", { name: "Подача" }))).toEqual([caption, imported, SLOW]);
    // The figures are the engine's own answer to this very request: nothing is worked out here.
    const request: RunRequest = { avatarId: MIA.avatarId, count: 20, categories: ["nightwear", "beach"], level: "bold" };
    expect(lastEstimate(engine)).toEqual(request);
    const estimate = await engineEstimate(client, request);
    expect(estimate.boldAttemptMicros).toBeDefined();
    await within(card()).findByRole("button", { name: goName(20, estimate.worstMicros) });
    expect(expectedShown()).toBe(`≈ ${formatUsd(estimate.expectedMicros)}`);
    // Mockup 47's figures at the mock's prices (§10.3: «≈ $1.86 · до $5.58», «до $0.093 за попытку»).
    expect(expectedShown()).toBe("≈ $1.86");
    expect(within(card()).getByRole("button", { name: /^Сгенерировать 20 фото · до \$5\.58$/ })).toBeDefined();
    expect(within(card()).getByText("Seedream 2K — до $0.093 за попытку по прайсу")).toBeDefined();
  });

  // 5a.4 (S5.BA7, 2026-10-27, plan s5a4 I5.77, §5.7; BA5 review L-5): scope edit. the mock prices «Смелая» as the engine does, so «Дом»'s photos are on the 2K unit too: §5.7's
  // «Дом» 10 + «Ночнушки» 10 is $1.86 / $5.58, not 5a.3's $1.53 / $4.59.
  test("47a: «Дом» 10 + «Ночнушки и бельё» 10 — the tiers over the whole request, the engine's ≈ $1.86 · до $5.58", async () => {
    const { engine, client } = await openPhotos();
    // §10.3's example prices «Дом» on Grok quality, 60 000 µ$ an attempt; the mock's own default is cheaper.
    engine.setRunImagePrice(60_000);
    await pickLevel("Смелая");
    await only("Дом", "Ночнушки и бельё");
    expect(within(card()).getByText(said(20, ["home", "nightwear"]).caption)).toBeDefined();
    const estimate = await engineEstimate(client, { avatarId: MIA.avatarId, count: 20, categories: ["home", "nightwear"], level: "bold" });
    await within(card()).findByRole("button", { name: goName(20, estimate.worstMicros) });
    expect(expectedShown()).toBe(`≈ ${formatUsd(estimate.expectedMicros)}`);
    expect(expectedShown()).toBe("≈ $1.86");
    expect(within(card()).getByRole("button", { name: /^Сгенерировать 20 фото · до \$5\.58$/ })).toBeDefined();
  });

  // 5a.4 (S5.BA7, 2026-10-27, plan s5a4 I5.77, §5.7; BA5 review L-5): scope edit. the five at «Смелая» draw on the route (I5.71), so the engine prices them at the 2K unit and the card
  // shows the Seedream price line; 5a.4 (S5.BA8a): every category draws «Смелая», so the card captions the five and says the frames are slow.
  test("47b: only the five — the engine prices them on the 2K route, the card captions them and says the Seedream price and that the frames are slow", async () => {
    const { engine, client } = await openPhotos();
    await pickLevel("Смелая");
    const five: CategoryRef[] = ["home", "travel", "shoot", "glam", "fit"];
    expect(within(card()).getByText(said(20, five).caption)).toBeDefined();
    expect(lastEstimate(engine)).toEqual({ avatarId: MIA.avatarId, count: 20, categories: ["home", "travel", "shoot", "glam", "fit"], level: "bold" });
    const estimate = await engineEstimate(client, { avatarId: MIA.avatarId, count: 20, categories: ["home", "travel", "shoot", "glam", "fit"], level: "bold" });
    expect(estimate.boldAttemptMicros).toBe(93_000);
    await within(card()).findByRole("button", { name: goName(20, estimate.worstMicros) });
    expect(within(card()).getByText("Seedream 2K — до $0.093 за попытку по прайсу")).toBeDefined();
    expect(within(card()).getByText(SLOW)).toBeDefined();
  });

  // 5a.4 (S5.BA8a, QB-4, r2.2): a custom category draws «Смелая» like the rest, so it has a caption and the slow line; «Подача — только во встроенных категориях» is «Кокетливая»'s.
  test("47b#own: only a custom category — captioned like the rest, with the slow line", async () => {
    await openPhotos({ categories: [PARIS] });
    await pickLevel("Смелая");
    await only();
    await click(chip("Кофейни Парижа"));
    expect(within(card()).getByText(said(20, [PARIS.categoryId], [PARIS]).caption)).toBeDefined();
    expect(within(card()).queryByText("Подача — только во встроенных категориях") === null).toBe(true);
    expect(within(card()).getByText(SLOW)).toBeDefined();
  });

  test("the caption follows the stepper: 25 photos → 10 and 10 of them bold and flirty", async () => {
    await openPhotos();
    await pickLevel("Смелая");
    await only("Ночнушки и бельё", "Пляж и бассейн");
    await click(within(card()).getByRole("button", { name: "Больше" }));
    expect(within(card()).getByText(said(25, ["nightwear", "beach"]).caption)).toBeDefined();
  });
});

describe("the two chips under another «Подача» (mockup 48)", () => {
  test("the form's defaults never include them: off, the request names only the five", async () => {
    const { engine } = await openPhotos();
    for (const name of ["Ночнушки и бельё", "Пляж и бассейн"]) expect(chip(name).getAttribute("aria-pressed")).toBe("false");
    expect(lastEstimate(engine)?.categories).toEqual(["home", "travel", "shoot", "glam", "fit"]);
  });

  test("under «Обычная» and «Кокетливая» they are dimmed, «Только со «Смелой»», described by the note, and a click does nothing", async () => {
    const { engine } = await openPhotos();
    for (const face of ["Обычная", "Кокетливая"] as const) {
      await pickLevel(face);
      for (const name of ["Ночнушки и бельё", "Пляж и бассейн"]) {
        const el = chip(name);
        expect(el.getAttribute("aria-disabled")).toBe("true");
        expect(el.classList.contains("gen-chip-gated")).toBe(true);
        expect(el.getAttribute("title")).toBe("Только со «Смелой»");
        expect(described(el)).toEqual([GATED]);
        await click(el);
        expect(chip(name).getAttribute("aria-pressed")).toBe("false");
      }
      expect(within(card()).getByText(GATED)).toBeDefined();
    }
    expect(callsOf(engine, "runs.estimate").some((c) => c.payload.categories.some((ref) => ref === "nightwear" || ref === "beach"))).toBe(false);
  });

  test("under «Смелая» they are plain chips and the note goes", async () => {
    await openPhotos();
    await pickLevel("Смелая");
    for (const name of ["Ночнушки и бельё", "Пляж и бассейн"]) {
      const el = chip(name);
      expect(el.getAttribute("aria-disabled")).toBeNull();
      expect(el.classList.contains("gen-chip-gated")).toBe(false);
      expect(el.getAttribute("title")).toBe(name);
    }
    expect(within(card()).queryByText(/^Только со «Смелой»/) === null).toBe(true);
  });

  test("48#kept: a pick made under «Смелая» stays, off, under «Кокетливая» and comes back with «Смелая» (7 + 7 + 6)", async () => {
    const { engine } = await openPhotos();
    await pickLevel("Смелая");
    await only("Дом", "Виды", "Ночнушки и бельё");
    expect(chip("Ночнушки и бельё").getAttribute("aria-label")).toBe("Ночнушки и бельё: 6 фото");
    expect(within(card()).getByText(said(20, ["home", "travel", "nightwear"]).caption)).toBeDefined();

    await pickLevel("Кокетливая");
    const kept = chip("Ночнушки и бельё");
    // Round 2 (L4): kept, but not in this run — never announced as pressed; its description says it comes back with «Смелая».
    expect(kept.getAttribute("aria-pressed")).toBe("false");
    expect(kept.getAttribute("aria-disabled")).toBe("true");
    expect(kept.classList.contains("gen-chip-kept")).toBe(true);
    expect(kept.getAttribute("aria-label")).toBe("Ночнушки и бельё");
    expect(described(kept)).toEqual(["Только со «Смелой»: выбранная «Ночнушки и бельё» вернётся вместе с ней."]);
    expect(within(card()).getByText("Только со «Смелой»: выбранная «Ночнушки и бельё» вернётся вместе с ней.")).toBeDefined();
    expect(chip("Дом").getAttribute("aria-label")).toBe("Дом: 10 фото");
    expect(lastEstimate(engine)).toEqual({ avatarId: MIA.avatarId, count: 20, categories: ["home", "travel"], level: "flirty" });

    await pickLevel("Смелая");
    expect(chip("Ночнушки и бельё").getAttribute("aria-disabled")).toBeNull();
    expect(chip("Ночнушки и бельё").getAttribute("aria-label")).toBe("Ночнушки и бельё: 6 фото");
    expect(lastEstimate(engine)).toEqual({ avatarId: MIA.avatarId, count: 20, categories: ["home", "travel", "nightwear"], level: "bold" });
  });

  test("48#kept, both: «выбранные вернутся вместе с ней»; with nothing else on there is nothing to send", async () => {
    await openPhotos();
    await pickLevel("Смелая");
    await only("Ночнушки и бельё", "Пляж и бассейн");
    await pickLevel("Обычная");
    expect(within(card()).getByText("Только со «Смелой»: выбранные вернутся вместе с ней.")).toBeDefined();
    expect(within(card()).getByText("Выберите хотя бы одну категорию.")).toBeDefined();
  });

  test("the pick goes into the run itself only with «Смелая»: runs.start carries the category and `level: \"bold\"`", async () => {
    const { engine, client } = await openPhotos();
    await pickLevel("Смелая");
    await only("Ночнушки и бельё");
    const estimate = await engineEstimate(client, { avatarId: MIA.avatarId, count: 20, categories: ["nightwear"], level: "bold" });
    await click(await within(card()).findByRole("button", { name: goName(20, estimate.worstMicros) }));
    expect(callsOf(engine, "runs.start").at(-1)?.payload).toEqual({ avatarId: MIA.avatarId, count: 20, categories: ["nightwear"], level: "bold", acceptedWorstMicros: estimate.worstMicros });
  });

  test("a set is composed with `level: \"bold\"` and the «Смелая» category, with the review on", async () => {
    const { engine } = setup({ avatars: [MIA], sceneReview: "on" });
    await screen.findByRole("heading", { level: 2, name: "Mia" });
    await openSection("Фото");
    await within(await screen.findByRole("region", { name: "Генерация фото" })).findByRole("button", { name: /^Составить 20\sсцен/ });
    await pickLevel("Смелая");
    await only("Дом", "Пляж и бассейн");
    await click(await within(card()).findByRole("button", { name: /^Составить 20\sсцен/ }));
    const sent = callsOf(engine, "scenes.compose").at(-1)?.payload;
    expect(sent?.level).toBe("bold");
    expect(sent?.categories).toEqual(["home", "beach"]);
  });
});

describe("the scenes column's writers with a kept «Смелая» pick", () => {
  test("a kept «Ночнушки и бельё» writes nothing: with only the model's category asked for, the column names the model alone", async () => {
    await openPhotos({ categories: [FIXTURE] });
    await pickLevel("Смелая");
    await only("Ночнушки и бельё");
    await click(chip("Только модель"));
    await waitFor(() => expect(column().querySelector(".scene-col-model")?.textContent).toMatch(/^20 · пишет приложение и \S*grok\S*$/));
    await pickLevel("Кокетливая");
    await waitFor(() => expect(column().querySelector(".scene-col-model")?.textContent).toMatch(/^20 · \S*grok\S*$/));
  });
});

// 5a.4 (S5.BA8b, plan s5a4 §5.9 row 6; mockup 65a): at «Смелая» the model writes every custom category's scenes in its bold mode (the scene carries its world). The price column says
// so, at the bold writer's price, against the ordinary writer's «до $0.075» below «Смелая». The ceiling is the plan's «до $0.098» (two attempts of 48 750 µ$, r2.2 D5). The expected
// figure is the engine's own (`writerExpectedMicros`, the mock held to it): one request's typical 6 240 µ$ plus 251.25 µ$ a scene, so ≈ $0.007 for Paris's 2–3 scenes, not the
// mockup's «≈ $0.002», which priced 758 µ$ a scene before BA5 measured the bold call.
describe("«Кто пишет сцены» at «Смелая» (mockup 65a)", () => {
  test("the five + «Пляж и бассейн» + «Кофейни Парижа»: «Сцены ≈ $0.007 · до $0.098», «для «Кофейни Парижа» текст пишет модель»", async () => {
    await openPhotos({ categories: [PARIS] });
    await within(chipsGroup()).findByRole("button", { name: /^Кофейни Парижа/ });
    await click(chip("Кофейни Парижа"));
    await waitFor(() => expect(priceRow("Сцены")).toMatch(/ · до \$0\.075$/));
    await pickLevel("Смелая");
    await click(chip("Пляж и бассейн"));
    await waitFor(() => expect(priceRow("Сцены")).toBe("Сцены ≈ $0.007 · до $0.098"));
    expect(card().querySelector(".gen-scenes-sub")?.textContent).toBe("для «Кофейни Парижа» текст пишет модель");
    await waitFor(() => expect(column().querySelector(".scene-col-model")?.textContent).toMatch(/^20 · пишет приложение и \S*grok\S*$/));
    await pickLevel("Обычная");
    await waitFor(() => expect(priceRow("Сцены")).toMatch(/ · до \$0\.075$/));
  });
});

// 5a.4 (S5.BA8b, plan s5a4 §5.9 row 23; mockup 65): at «Смелая» Seedream 5 Pro draws every frame in 2K (Q-A2), whatever the settings' image model, so the line under «Тип кадра»
// says so; the other levels name the settings' model, as before.
describe("the model line under «Тип кадра»", () => {
  const shotLine = (): string => card().querySelector(".photos-shot-caption")?.textContent?.replace(/\s+/g, " ") ?? "";

  test("«Смелая»: «Seedream 5 Pro · 2K · 9:16 · референс — мастер-портрет»; «Обычная» and «Кокетливая»: the settings' model", async () => {
    await openPhotos();
    await waitFor(() => expect(shotLine()).toMatch(/· low · 9:16 · референс — мастер-портрет$/));
    const ordinary = shotLine();
    expect(ordinary.startsWith("Seedream")).toBe(false);
    await pickLevel("Смелая");
    expect(shotLine()).toBe("Seedream 5 Pro · 2K · 9:16 · референс — мастер-портрет");
    await pickLevel("Кокетливая");
    expect(shotLine()).toBe(ordinary);
  });
});

describe("the two chips' hints (mockup 48a)", () => {
  test("«Ночнушки и бельё» under the pointer, «Пляж и бассейн» in focus — under «Смелая» and while they wait for it", async () => {
    await openPhotos();
    fireEvent.pointerEnter(chip("Ночнушки и бельё"));
    expect(screen.getByText(HINT.nightwear)).toBeDefined();
    fireEvent.pointerLeave(chip("Ночнушки и бельё"));
    await pickLevel("Смелая");
    fireEvent.focus(chip("Пляж и бассейн"));
    expect(screen.getByText(HINT.beach)).toBeDefined();
  });
});

describe("state 55: the 2K price is missing", () => {
  test("says «Смелая» cannot start and the rest works, as a warning the retry is described by; no general price text", async () => {
    const { engine } = await openPhotos();
    engine.lackBoldPrice();
    await pickLevel("Смелая");
    await only("Ночнушки и бельё");
    const notice = await within(document.body).findByText(PRICE_SCOPES_RU.bold);
    expect(notice.closest(".notice")?.classList.contains("notice-warn")).toBe(true);
    const retry = within(card()).getByRole("button", { name: "Повторить оценку" });
    expect(described(retry)).toEqual([PRICE_SCOPES_RU.bold]);
    expect(screen.queryByText(errorText({ code: "PRICE_UNAVAILABLE" })) === null).toBe(true);
    expect(expectedShown()).toBe("—");
    // The price list has its tier again: the retry prices the run and the notice goes.
    engine.lackBoldPrice(false);
    await click(retry);
    await within(card()).findByRole("button", { name: /^Сгенерировать 20 фото · до \$/ });
    expect(screen.queryByText(PRICE_SCOPES_RU.bold) === null).toBe(true);
  });

  // 5a.4 (S5.BA7, 2026-10-27, plan s5a4 I5.77, §5.7; BA5 review L-5): scope edit. at «Смелая» the five need the 2K tier too, so the card that prices as before is a «Кокетливая» one.
  test("the rest still works: below «Смелая» the card prices as before", async () => {
    const { engine } = await openPhotos();
    engine.lackBoldPrice();
    await pickLevel("Кокетливая");
    await within(card()).findByRole("button", { name: /^Сгенерировать 20 фото · до \$/ });
    expect(screen.queryByText(PRICE_SCOPES_RU.bold) === null).toBe(true);
  });

  test("any other price failure shows today's general text, never state 55's", async () => {
    const { engine } = await openPhotos();
    await pickLevel("Смелая");
    await only("Дом");
    // The next price asked fails without a scope: the one for the request with «Ночнушки и бельё» on.
    engine.failNext("runs.estimate", { code: "PRICE_UNAVAILABLE" });
    await click(chip("Ночнушки и бельё"));
    await waitFor(() => expect(screen.getByText(errorText({ code: "PRICE_UNAVAILABLE" }))).toBeDefined());
    expect(lastEstimate(engine)?.categories).toEqual(["home", "nightwear"]);
    expect(screen.queryByText(PRICE_SCOPES_RU.bold) === null).toBe(true);
  });
});

describe("«Смелая» remembered per avatar, like «Кокетливая»", () => {
  test("comes back «Смелая» in a new window, for this avatar only", async () => {
    const first = await openPhotos();
    await pickLevel("Смелая");
    expect(localStorage.getItem(`${LEVEL_KEY_PREFIX}${MIA.avatarId}`)).toBe("bold");
    first.unmount();
    const second = await openPhotos({ keepLevels: true });
    expect(level("Смелая").checked).toBe(true);
    // A new window's form starts from the defaults: the «Смелая» chips are not on until picked.
    expect(chip("Ночнушки и бельё").getAttribute("aria-pressed")).toBe("false");
    await pickLevel("Обычная");
    expect(localStorage.getItem(`${LEVEL_KEY_PREFIX}${MIA.avatarId}`) === null).toBe(true);
    second.unmount();
  });

  // Round 2 (L5): «for this avatar only» — a second avatar keeps her own «Подача», on screen and in storage, and Mia keeps hers.
  test("a second avatar keeps her own «Подача»: Mia «Смелая», Sofia «Кокетливая», each back as it was", async () => {
    const SOFIA = { ...MIA, avatarId: "avatar-sofia-0002", name: "Sofia", masterPhotoId: "photo-sofia-0001" };
    async function openAvatarPhotos(name: string): Promise<void> {
      fireEvent.click(screen.getByRole("button", { name: "Аватары" }));
      fireEvent.click(await screen.findByRole("button", { name }));
      await screen.findByRole("heading", { level: 1, name });
      await openSection("Фото");
      await screen.findByRole("heading", { level: 1, name });
    }
    await openPhotos({ avatars: [MIA, SOFIA] });
    await pickLevel("Смелая");
    await openAvatarPhotos("Sofia");
    expect(level("Обычная").checked).toBe(true);
    await pickLevel("Кокетливая");
    await openAvatarPhotos("Mia");
    expect(level("Смелая").checked).toBe(true);
    await openAvatarPhotos("Sofia");
    expect(level("Кокетливая").checked).toBe(true);
    expect(localStorage.getItem(`${LEVEL_KEY_PREFIX}${MIA.avatarId}`)).toBe("bold");
    expect(localStorage.getItem(`${LEVEL_KEY_PREFIX}${SOFIA.avatarId}`)).toBe("flirty");
  });
});
