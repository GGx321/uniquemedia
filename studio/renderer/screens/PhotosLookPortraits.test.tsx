import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { ERROR_MESSAGES_RU, NO_ANSWER_DETAIL_PREFIX, type AvatarSummary, type RunRequest } from "../../shared/engine";
import { App } from "../App";
import { createEngineClient, type EngineBridge } from "../engine/client";
import { MockEngine } from "../engine/mockEngine";
import { MIA } from "../engine/mockEngine.testkit";
import { ManualScheduler } from "../engine/scheduler";
import { MOCK_PORTRAIT_SLOTS_SOME_FAILED, type MockPortraitSeed } from "../engine/mockPortraits";
import { callsOf, flush, focusedLabel, describeElement, runAll, setup, tick } from "../testing";
import { CHECK_HELD_REASON } from "./look/lookModel";

// S5.3d: an imported avatar's «Мастер-портрет» card and «Варианты мастер-портрета» panel on «Внешность», against the mock engine, state by state of
// .omc/stage5/design 15–23. The mock's batch plays its deterministic table: 0.76, 0.72, 0.61, one not hers at 0.48, one refused by the model. Its price
// is 5 × 60 000 µ$: «до $0.30», «≈ $0.30» (with the age check on, 5 × 65 250: «до $0.33»).

const NINI: AvatarSummary = { ...MIA, avatarId: "avatar-nini-0004", name: "Nini", masterPhotoId: "photo-nini-source" };
const AVA: AvatarSummary = { ...MIA, avatarId: "avatar-ava-0005", name: "Ava", masterPhotoId: "photo-ava-portrait" };
const NINI_SEED: MockPortraitSeed = { avatarId: NINI.avatarId, sourcePhotoId: "photo-nini-source" };
const AVA_SEED: MockPortraitSeed = { avatarId: AVA.avatarId, sourcePhotoId: "photo-ava-source", masterLikeness: 0.72 };
const BATCH_WORST = 300_000;

type SetupOptions = Parameters<typeof setup>[0];

/**
 * The avatar's page from the grid, then its «Внешность». `beforeTab` runs on the avatar's page before the tab opens (the grid asks prices of its own:
 * the import tile's portraits price among them). `pricedBefore`: the portraits prices asked before the tab opened.
 */
async function openLook(who: AvatarSummary, options: SetupOptions = {}, beforeTab: (engine: ReturnType<typeof setup>["engine"]) => void = () => undefined) {
  const harness = setup({ avatars: [NINI, AVA, MIA], portraits: [NINI_SEED, AVA_SEED], ...options });
  fireEvent.click(await screen.findByRole("button", { name: who.name }));
  await screen.findByRole("heading", { level: 1, name: who.name });
  await flush();
  const pricedBefore = callsOf(harness.engine, "avatars.estimatePortraits").length;
  beforeTab(harness.engine);
  fireEvent.click(screen.getByRole("tab", { name: "Внешность" }));
  await flush();
  return { ...harness, pricedBefore };
}

const text = (el: Element): string => el.textContent ?? "";
const isDisabled = (el: HTMLElement): boolean => el.hasAttribute("disabled");
const masterCard = (): HTMLElement => screen.getByRole("region", { name: "Мастер-портрет" });
const panel = (): HTMLElement => screen.getByRole("region", { name: "Варианты мастер-портрета" });
const noPanel = (): boolean => screen.queryByRole("region", { name: "Варианты мастер-портрета" }) === null;
const checkCard = (): HTMLElement => screen.getByRole("region", { name: "Сверка с фото" });
const startButton = (): HTMLElement => within(masterCard()).getByRole("button", { name: /^(Получить 5 вариантов|Подтвердить новую цену|Запускаем)/ });
const radios = (): HTMLElement[] => within(panel()).queryAllByRole("radio");
const pill = (): string => text(masterCard().querySelector(".look-master-pill") ?? masterCard());
/** What an element's aria-describedby points at, as one string. */
const describedText = (el: HTMLElement): string =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter(Boolean)
    .map((id) => document.getElementById(id)?.textContent ?? `(#${id} missing)`)
    .join(" | ");
/** The tiles of the grid without a portrait: their title and the line under it. */
const goneTiles = (): string[][] =>
  Array.from(panel().querySelectorAll(".cand-slot-failed, .cand-slot-hidden")).map((tile) =>
    [tile.querySelector(".cand-slot-title")?.textContent ?? "", tile.querySelector(".cand-slot-sub")?.textContent ?? ""].filter(Boolean),
  );

async function start(): Promise<void> {
  fireEvent.click(startButton());
  await flush();
}

const RUN: RunRequest = { avatarId: NINI.avatarId, count: 20, categories: ["home", "travel", "shoot", "glam", "fit"], poses: { profile: false, back: false } };

describe("a wizard avatar", () => {
});

describe("20 · an imported avatar whose master is the imported photo", () => {
  test("the card says what the master is, why a portrait, and offers the paid start at the engine's price", async () => {
    const { engine, pricedBefore } = await openLook(NINI);
    expect(pill()).toBe("исходное фото · сейчас мастер");
    expect(text(masterCard())).toContain("Если на исходном фото есть телефон, зеркало или комната, они попадают в сцены.");
    expect(startButton().textContent).toBe("Получить 5 вариантов · до $0.30");
    expect(startButton().className).toContain("btn-p");
    expect(text(masterCard())).toContain("ожидаемая ≈ $0.30 · 5 вариантов на выбор");
    expect(callsOf(engine, "avatars.estimatePortraits").slice(pricedBefore).map((c) => c.payload)).toEqual([{}]);
    expect(callsOf(engine, "avatars.generatePortraits")).toHaveLength(0);
    expect(noPanel()).toBe(true);
  });

});

describe("15 · a batch drawing", () => {
  test("the click sends the price on the button, once; the panel draws the slots as they land, nothing to choose yet", async () => {
    const { engine, scheduler } = await openLook(NINI);
    fireEvent.click(startButton());
    fireEvent.click(startButton()); // a second click before the busy button is drawn buys nothing
    await flush();
    expect(callsOf(engine, "avatars.generatePortraits").map((c) => c.payload)).toEqual([{ avatarId: NINI.avatarId, acceptedWorstMicros: BATCH_WORST }]);

    expect(text(panel())).toContain("Рисуем портреты: 0 из 5");
    expect(panel().className).toContain("portraits-panel-running");
    expect(panel().querySelectorAll(".cand-slot-drawing")).toHaveLength(5);
    // While the panel is open the card is the frame alone.
    expect(within(masterCard()).queryAllByRole("button")).toHaveLength(0);
    // The sidebar counts the batch's five slots from the start, never a candidates batch's four.
    expect(text(screen.getByRole("region", { name: "Очередь" }))).toContain("0 / 5");

    // B1: the list is read again on every step, so a portrait shows as soon as it is stored (before the progress that counts it).
    const reads = callsOf(engine, "avatars.portraits").length;
    tick(scheduler);
    await flush();
    expect(callsOf(engine, "avatars.portraits")).toHaveLength(reads + 1);
    expect(within(panel()).getAllByRole("img", { name: /готов/ })).toHaveLength(1);
    tick(scheduler);
    await flush();
    expect(callsOf(engine, "avatars.portraits")).toHaveLength(reads + 2);
    expect(text(panel())).toContain("Рисуем портреты: 2 из 5");
    expect(within(panel()).getAllByRole("img", { name: /готов/ }).map((el) => el.getAttribute("aria-label"))).toEqual([
      "Вариант A готов · сходство 0.76",
      "Вариант B готов · сходство 0.72",
    ]);
    expect(radios()).toHaveLength(0);
    expect(panel().querySelectorAll(".cand-slot-drawing")).toHaveLength(3);
    expect(text(panel())).toContain("Описание и тело можно менять и сейчас: варианты рисуются по тексту, взятому в начале.");
    // The batch holds her like a run: the check waits (15).
    expect(isDisabled(within(checkCard()).getByRole("button", { name: /^Проверить описание/ }))).toBe(true);
    expect(text(checkCard())).toContain(CHECK_HELD_REASON);
  });

});

describe("16 · the batch is ready", () => {
  test("portraits best first, the best chosen; the slots without one say why and cannot be chosen; a refusal is free", async () => {
    const { scheduler } = await openLook(NINI);
    await start();
    runAll(scheduler);
    await flush();

    expect(radios().map((r) => r.getAttribute("aria-label"))).toEqual(["Вариант A · сходство 0.76 · лучший", "Вариант B · сходство 0.72", "Вариант C · сходство 0.61"]);
    expect(radios().map((r) => (r instanceof HTMLInputElement ? r.checked : null))).toEqual([true, false, false]);
    expect(text(panel().querySelector(".cand-on") ?? panel())).toContain("Выбран");
    expect(text(panel().querySelector(".cand-on") ?? panel())).toContain("лучший");
    expect(goneTiles()).toEqual([["Не похожа · 0.48", "стоимость учтена"], ["Модель отказалась · бесплатно"]]);
    // The refusal cost nothing: no «стоимость попытки учтена» line for it.
    expect(text(panel())).not.toContain("не удалось получить");
    expect(text(panel().querySelector(".candidates-head") ?? panel())).toContain("3 варианта · выберите один");
    // Review L7: the panel names itself by a generated id, never a fixed one a second panel would share.
    const heading = within(panel()).getByRole("heading", { name: "Варианты мастер-портрета" });
    expect(panel().getAttribute("aria-labelledby")).toBe(heading.id);
    expect(heading.id).not.toBe("portraits-title");
    expect(text(panel())).toContain("сходство — с исходным фото · порог 0.55");
    const rail = panel().querySelector(".portraits-rail");
    expect(within(rail instanceof HTMLElement ? rail : panel()).getAllByRole("button").map(text)).toEqual(["Сделать мастером", "Ещё 5 вариантов · до $0.30", "Оставить исходное фото"]);
    expect(text(panel())).toContain("Бесплатно. Остальные варианты удалятся, исходное фото останется.");
    expect(text(panel())).toContain("Варианты удалятся.");
  });

  test("a manual choice survives a later batch (16b); «лучший» moves to the new best; the age check's drops say so", async () => {
    const { engine, scheduler } = await openLook(NINI, { imageAgeCheck: "on" });
    await start();
    runAll(scheduler);
    await flush();
    fireEvent.click(screen.getByRole("radio", { name: /^Вариант B/ }));

    engine.scriptNextPortraits({
      slots: [{ kind: "pass", likeness: 0.81 }, { kind: "age-rejected" }, { kind: "age-rejected" }, { kind: "pass", likeness: 0.7 }, { kind: "pass", likeness: 0.58 }],
    });
    const again = within(panel()).getByRole("button", { name: /^Ещё 5 вариантов/ });
    expect(again.textContent).toBe("Ещё 5 вариантов · до $0.33");
    fireEvent.click(again);
    await flush();
    expect(callsOf(engine, "avatars.generatePortraits").map((c) => c.payload.acceptedWorstMicros)).toEqual([326_250, 326_250]);
    runAll(scheduler);
    await flush();

    expect(radios().map((r) => r.getAttribute("aria-label"))).toEqual([
      "Вариант A · сходство 0.81 · лучший",
      "Вариант B · сходство 0.76",
      "Вариант C · сходство 0.72",
      "Вариант D · сходство 0.70",
      "Вариант E · сходство 0.61",
      "Вариант F · сходство 0.58",
    ]);
    const checked = radios().find((r) => r instanceof HTMLInputElement && r.checked);
    expect(checked?.getAttribute("aria-label")).toBe("Вариант C · сходство 0.72");
    expect(text(panel())).toContain("2 варианта отклонены проверкой возраста и не показаны. Их стоимость учтена.");
    expect(goneTiles()).toEqual([
      ["Скрыт проверкой возраста", "стоимость учтена"],
      ["Скрыт проверкой возраста", "стоимость учтена"],
    ]);
  });

  test("16c: at the limit «Ещё 5» waits with the reason, and the reset reads «Удалить варианты»", async () => {
    const fifteen = Array.from({ length: 15 }, (_, i) => ({ photoId: `photo-nini-c${String(i + 10)}`, likeness: 0.56 + i / 100 }));
    await openLook(NINI, { portraits: [{ ...NINI_SEED, candidates: fifteen }, AVA_SEED] });
    const again = within(panel()).getByRole("button", { name: /^Ещё 5 вариантов/ });
    expect(isDisabled(again)).toBe(true);
    expect(text(panel())).toContain("Уже 15 вариантов — выберите один или удалите все.");
    expect(within(panel()).getByRole("button", { name: "Удалить варианты" })).toBeDefined();
    expect(radios()).toHaveLength(15);
  });

  test("16c: the engine counts what the window cannot see (the age check's hidden ones): its refusal turns the panel to the limit (review L4)", async () => {
    const eight = Array.from({ length: 8 }, (_, i) => ({ photoId: `photo-nini-c${String(i + 10)}`, likeness: 0.6 + i / 100 }));
    const { engine } = await openLook(NINI, { portraits: [{ ...NINI_SEED, candidates: eight }, AVA_SEED] });
    engine.scriptNextPortraits({ refuse: { code: "VALIDATION", portraitReason: "too-many-candidates" } });
    fireEvent.click(within(panel()).getByRole("button", { name: /^Ещё 5 вариантов/ }));
    await flush();
    const again = within(panel()).getByRole("button", { name: /^Ещё 5 вариантов/ });
    expect(isDisabled(again)).toBe(true);
    expect(describedText(again)).toContain("Выберите один или нажмите «Удалить варианты», потом повторите.");
    expect(within(panel()).getByRole("button", { name: "Удалить варианты" })).toBeDefined();
    // Said once, at the button: no second copy over the panel.
    expect(screen.getAllByText(/Невыбранных вариантов слишком много/)).toHaveLength(1);
  });

});

describe("16e · some slots failed at a cost", () => {
  test("two timeouts: «Не получилось · стоимость учтена», and the line says the worst price until a reconcile", async () => {
    const { engine, scheduler } = await openLook(NINI);
    engine.scriptNextPortraits({ slots: MOCK_PORTRAIT_SLOTS_SOME_FAILED });
    await start();
    runAll(scheduler);
    await flush();
    expect(radios()).toHaveLength(3);
    expect(goneTiles()).toEqual([["Не получилось · стоимость учтена"], ["Не получилось · стоимость учтена"]]);
    // The mockup's 16e line, word for word.
    expect(text(panel())).toContain("2 варианта не удалось получить: OpenRouter не ответил вовремя. До сверки попытка считается по худшей цене. Стоимость попытки учтена.");
  });
});

describe("16e · with the age check on (review M2)", () => {
  test("a slot whose check the budget refused after its image was paid is said as paid, never «ничего не стоили»", async () => {
    const { engine, scheduler } = await openLook(NINI, { imageAgeCheck: "on" });
    engine.scriptNextPortraits({
      slots: [
        { kind: "pass", likeness: 0.76 },
        { kind: "pass", likeness: 0.72 },
        { kind: "pass", likeness: 0.61 },
        { kind: "failed", error: { code: "BUDGET_EXCEEDED" }, settle: "paid" },
        { kind: "failed", error: { code: "RATE_LIMITED" }, settle: "paid" },
      ],
    });
    await start();
    runAll(scheduler);
    await flush();
    expect(goneTiles()).toEqual([["Не получилось · стоимость учтена"], ["Не получилось · стоимость учтена"]]);
    expect(text(panel())).toContain("2 варианта не удалось получить: причины разные — подробности в журнале. Стоимость попытки учтена.");
    expect(text(panel())).not.toContain("ничего не стоили");
    expect(text(panel())).not.toContain("бесплатно");
  });
});

describe("16f · the reset asks first", () => {
  test("in place: «Отмена» takes the focus and gives it back; «Удалить» deletes the waiting portraits, and the card is back (20)", async () => {
    const { engine, scheduler } = await openLook(NINI);
    await start();
    runAll(scheduler);
    await flush();

    const reset = within(panel()).getByRole("button", { name: "Оставить исходное фото" });
    fireEvent.click(reset);
    await flush();
    const ask = within(panel()).getByRole("alert");
    expect(text(ask)).toContain("Все варианты удалятся, мастером останется исходное фото.");
    expect(focusedLabel()).toBe(describeElement(within(ask).getByRole("button", { name: "Отмена" })));
    fireEvent.click(within(ask).getByRole("button", { name: "Отмена" }));
    await flush();
    expect(focusedLabel()).toBe(describeElement(within(panel()).getByRole("button", { name: "Оставить исходное фото" })));
    expect(callsOf(engine, "avatars.discardPortraits")).toHaveLength(0);

    fireEvent.click(within(panel()).getByRole("button", { name: "Оставить исходное фото" }));
    await flush();
    fireEvent.click(within(within(panel()).getByRole("alert")).getByRole("button", { name: "Удалить" }));
    await flush();
    expect(callsOf(engine, "avatars.discardPortraits").map((c) => c.payload)).toEqual([{ avatarId: NINI.avatarId }]);
    expect(noPanel()).toBe(true);
    expect(startButton().textContent).toBe("Получить 5 вариантов · до $0.30");
    expect(focusedLabel()).toBe(describeElement(within(masterCard()).getByRole("heading", { name: "Мастер-портрет" })));
  });
});

describe("17 · none passed", () => {
});

describe("18 · the batch failed", () => {
});

describe("18b · the start refused before anything was paid", () => {
  test("the budget: the app's text, that nothing was started, and the way to the money", async () => {
    const { engine } = await openLook(NINI);
    engine.failNext("avatars.generatePortraits", { code: "BUDGET_EXCEEDED" });
    await start();
    const notice = screen.getByText(`${ERROR_MESSAGES_RU.BUDGET_EXCEEDED} Варианты не запускались — ничего не потрачено.`).closest(".notice");
    expect(notice?.className).toContain("notice-danger");
    expect(within(notice instanceof HTMLElement ? notice : document.body).getByRole("button", { name: "Открыть деньги в Настройках" })).toBeDefined();
    expect(isDisabled(startButton())).toBe(false);
  });

});

describe("a start whose answer never came (main's deadline, M1)", () => {
  test("says the command may have run, never that nothing was spent; the batch, once its events come, takes over", async () => {
    const { engine, client, scheduler } = await openLook(NINI);
    engine.failNext("avatars.generatePortraits", { code: "INTERNAL", detail: `${NO_ANSWER_DETAIL_PREFIX}30 s` });
    await start();
    const notice = screen.getByText(/^Движок не ответил вовремя/).closest(".notice");
    expect(text(notice ?? document.body)).not.toContain("ничего не потрачено");
    expect(text(notice ?? document.body)).not.toContain("Варианты не запускались");

    // The batch the lost answer did start announces itself by its events (here sent past the window, as main's deadline leaves it).
    await act(async () => {
      await client.request("avatars.generatePortraits", { avatarId: NINI.avatarId, acceptedWorstMicros: BATCH_WORST });
    });
    tick(scheduler);
    await flush();
    expect(screen.queryByText(/^Движок не ответил вовремя/) === null).toBe(true);
    expect(text(panel())).toContain("Рисуем портреты: 1 из 5");
  });
});

describe("19a / 19 · a portrait becomes the master", () => {
  test("«Сохраняем…» holds the grid; then the master is the portrait, the imported photo stays, and the line says what changes", async () => {
    const { engine, scheduler } = await openLook(NINI);
    await start();
    runAll(scheduler);
    await flush();
    fireEvent.click(screen.getByRole("radio", { name: /^Вариант B/ }));

    engine.delayNext("avatars.pickPortrait", 1_000);
    fireEvent.click(within(panel()).getByRole("button", { name: "Сделать мастером" }));
    await flush();
    const saving = within(panel()).getByRole("button", { name: /Сохраняем/ });
    expect(saving.getAttribute("aria-busy")).toBe("true");
    expect(panel().getAttribute("aria-busy")).toBe("true");
    expect(panel().querySelector("fieldset")?.hasAttribute("disabled")).toBe(true);
    expect(isDisabled(within(panel()).getByRole("button", { name: /^Ещё 5 вариантов/ }))).toBe(true);

    runAll(scheduler);
    await flush();
    const [picked] = callsOf(engine, "avatars.pickPortrait");
    expect(picked?.payload.avatarId).toBe(NINI.avatarId);
    expect(noPanel()).toBe(true);
    expect(pill()).toBe("мастер-портрет · сходство 0.72");
    expect(
      screen.getByText(
        "Мастер-портрет сохранён. Новые фото и автопилот используют его; уже снятые фото не меняются. Остановленная съёмка продолжится уже с мастер-портретом.",
      ),
    ).toBeDefined();
    expect(within(masterCard()).getByRole("button", { name: "Сделать мастером снова" })).toBeDefined();
    expect(text(masterCard())).toContain("исходное фото");
    // 21: the paid start is offered again, no longer the primary action.
    expect(startButton().textContent).toBe("Получить 5 вариантов · до $0.30");
    expect(startButton().className).not.toContain("btn-p");
    expect(focusedLabel()).toBe(describeElement(within(masterCard()).getByRole("heading", { name: "Мастер-портрет" })));
    // The check still compares with the imported photo.
    expect(text(checkCard().querySelector(".chk-pair") ?? checkCard())).toContain("исходное фото");
  });

});

describe("21 / 21b · after a switch, the way back", () => {
  test("asks in place; «Вернуть» makes the imported photo the master again (20)", async () => {
    const { engine } = await openLook(AVA);
    expect(pill()).toBe("мастер-портрет · сходство 0.72");
    expect(noPanel()).toBe(true);
    fireEvent.click(within(masterCard()).getByRole("button", { name: "Сделать мастером снова" }));
    await flush();
    const ask = within(masterCard()).getByRole("alert");
    expect(text(ask)).toContain("Портрет удалится. Вернуть исходное фото мастером?");
    expect(focusedLabel()).toBe(describeElement(within(ask).getByRole("button", { name: "Отмена" })));
    fireEvent.keyDown(ask, { key: "Escape" });
    await flush();
    expect(within(masterCard()).queryByRole("alert") === null).toBe(true);
    expect(focusedLabel()).toBe(describeElement(within(masterCard()).getByRole("button", { name: "Сделать мастером снова" })));

    fireEvent.click(within(masterCard()).getByRole("button", { name: "Сделать мастером снова" }));
    await flush();
    fireEvent.click(within(within(masterCard()).getByRole("alert")).getByRole("button", { name: "Вернуть" }));
    await flush();
    expect(callsOf(engine, "avatars.pickPortrait").map((c) => c.payload)).toEqual([{ avatarId: AVA.avatarId, photoId: "photo-ava-source" }]);
    await waitFor(() => expect(pill()).toBe("исходное фото · сейчас мастер"));
    expect(startButton().className).toContain("btn-p");
  });
});

describe("a portrait master whose file is gone (S5.3c `masterMissing`)", () => {
});

describe("22 · held by a photo run", () => {
});

describe("23 · the batch cancelled", () => {
  test("«Отменяем…» until it ends; the drawn portraits are kept and can be chosen", async () => {
    const { engine, scheduler } = await openLook(NINI);
    await start();
    tick(scheduler, 2);
    await flush();
    fireEvent.click(within(panel()).getByRole("button", { name: "Отменить" }));
    await flush();
    expect(callsOf(engine, "avatars.cancel")).toHaveLength(1);
    expect(within(panel()).getByRole("button", { name: "Отменяем…" })).toBeDefined();
    expect(focusedLabel()).toBe(describeElement(within(panel()).getByRole("heading", { name: "Варианты мастер-портрета" })));

    runAll(scheduler);
    await flush();
    expect(text(panel())).toContain("Генерация остановлена");
    expect(text(panel())).toContain("Прерванные запросы считаются по худшей цене, пока расходы не сверены. Готовые варианты сохранены.");
    expect(radios().map((r) => r.getAttribute("aria-label"))).toEqual(["Вариант A · сходство 0.76 · лучший", "Вариант B · сходство 0.72"]);
  });
});
