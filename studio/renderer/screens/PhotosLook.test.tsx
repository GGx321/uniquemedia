import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ERROR_MESSAGES_RU, type DescriptorCheck, type RunRequest } from "../../shared/engine";
import { MIA } from "../engine/mockEngine.testkit";
import { callsOf, flush, runAll, setup } from "../testing";
import { CHECK_HELD_REASON, EDIT_HELD_REASON } from "./look/lookModel";

// S5.0d: the avatar page's «Внешность» against the mock engine, state by state of .omc/stage5/design (07, 09–13; the «Тело» card is S5.2d's), plus
// the state the mockup lacks: the check refused, or not offered, while a photo run or another job holds the avatar. The check's price is the mock's
// own estimate at the fallback table: «до $0.025», «≈ $0.003».

const TEXT = MIA.descriptor.text;
const HAIR_OLD = "wavy chestnut hair";
const HAIR_NEW = "straight platinum-white hair with bangs";
const PROPOSAL = TEXT.replace(HAIR_OLD, HAIR_NEW);

function hairMismatch(patch: Partial<DescriptorCheck> = {}): DescriptorCheck {
  return {
    matches: false,
    aspects: { hair: { state: "mismatch", descriptor: "волнистые каштановые", photo: "прямые платиновые с чёлкой" }, eyes: { state: "ok" }, marks: { state: "ok" }, body: { state: "not-visible" } },
    proposal: PROPOSAL,
    checkedText: TEXT,
    ...patch,
  };
}

const RUN: RunRequest = { avatarId: MIA.avatarId, count: 20, categories: ["home", "travel", "shoot", "glam", "fit"], poses: { profile: false, back: false } };

/** Mia's page from the Avatars grid, then its «Внешность». */
async function openLook(options: Parameters<typeof setup>[0] = {}) {
  const harness = setup({ avatars: [MIA], ...options });
  fireEvent.click(await screen.findByRole("button", { name: "Mia" }));
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  fireEvent.click(screen.getByRole("tab", { name: "Внешность" }));
  await flush();
  return harness;
}

const checkCard = (): HTMLElement => screen.getByRole("region", { name: "Сверка с фото" });
const descCard = (): HTMLElement => screen.getByRole("region", { name: "Описание" });
const checkButton = (name: RegExp): HTMLElement => within(checkCard()).getByRole("button", { name });
const isDisabled = (el: HTMLElement): boolean => el.hasAttribute("disabled");
const text = (el: Element): string => el.textContent ?? "";
/** What the description's text field holds. */
function fieldValue(): string {
  const field = within(descCard()).getByRole("textbox", { name: "Текст описания" });
  return field instanceof HTMLTextAreaElement ? field.value : "";
}
/** What the card's polite live region says now. */
const said = (card: HTMLElement): string => within(card).getAllByRole("status").map(text).join(" | ");

async function runCheck(): Promise<void> {
  fireEvent.click(checkButton(/Проверить описание|Проверить снова|Повторить сверку|Подтвердить новую цену/));
  await flush();
}

describe("the tab", () => {
  test("is the fourth on the avatar's page; its price is asked for only when it is opened, and nothing paid is sent", async () => {
    const harness = setup({ avatars: [MIA] });
    fireEvent.click(await screen.findByRole("button", { name: "Mia" }));
    await screen.findByRole("heading", { level: 1, name: "Mia" });
    await flush();
    expect(screen.getAllByRole("tab").map(text)).toEqual(["Фото", "История сцен", "Видео", "Внешность"]);
    expect(callsOf(harness.engine, "avatars.estimateCheckDescriptor")).toHaveLength(0);

    fireEvent.click(screen.getByRole("tab", { name: "Внешность" }));
    await flush();
    expect(screen.getByRole("tab", { name: "Внешность" }).getAttribute("aria-selected")).toBe("true");
    expect(callsOf(harness.engine, "avatars.estimateCheckDescriptor").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId }]);
    expect(callsOf(harness.engine, "avatars.checkDescriptor")).toHaveLength(0);
  });

  test("← and → go round the three tabs that work", async () => {
    await openLook();
    const look = screen.getByRole("tab", { name: "Внешность" });
    fireEvent.keyDown(look, { key: "ArrowRight" });
    await flush();
    expect(screen.getByRole("tab", { name: "Фото" }).getAttribute("aria-selected")).toBe("true");
    expect(document.activeElement === screen.getByRole("tab", { name: "Фото" })).toBe(true);
    fireEvent.keyDown(screen.getByRole("tab", { name: "Фото" }), { key: "ArrowLeft" });
    await flush();
    expect(screen.getByRole("tab", { name: "Внешность" }).getAttribute("aria-selected")).toBe("true");
  });
});

describe("07 · never checked", () => {
  test("«Описание» shows the stored text and its length; «Сверка с фото» offers the check at the engine's price", async () => {
    await openLook();
    expect(within(descCard()).getByText(TEXT).tagName).toBe("P");
    expect(within(descCard()).getByText(`${TEXT.length} / 600`).tagName).toBe("SPAN");
    expect(isDisabled(within(descCard()).getByRole("button", { name: "Изменить текст" }))).toBe(false);

    const button = checkButton(/^Проверить описание/);
    expect(text(button)).toBe("Проверить описание · до $0.025");
    expect(isDisabled(button)).toBe(false);
    expect(text(checkCard())).toContain("ожидаемая ≈ $0.003 · один запрос с мастер-портретом");
    expect(text(checkCard())).toContain("последняя: ещё не было");
    expect(text(checkCard())).toContain("grok-4.3");
    expect(screen.getByText("мастер-портрет").className).toContain("pill");
  });
});

describe("09 · the check runs", () => {
  test("the aspects wait, the button is busy, the edit waits for it; then the verdict", async () => {
    const { engine, scheduler } = await openLook();
    engine.delayNext("avatars.checkDescriptor", 1_000);
    await runCheck();

    expect(checkCard().getAttribute("aria-busy")).toBe("true");
    expect(text(checkCard())).toContain("Сверяем описание с фото…");
    expect(text(checkCard())).toContain("до $0.025 · несколько секунд");
    const items = within(within(checkCard()).getByRole("list", { name: "Что сверяется" })).getAllByRole("listitem").map(text);
    expect(items).toEqual(["Волосы — сверяем", "Глаза — сверяем", "Приметы — сверяем", "Тело если в кадре"]);
    const busy = checkButton(/Проверяем…/);
    expect([isDisabled(busy), busy.getAttribute("aria-busy")]).toEqual([true, "true"]);
    // The check holds the avatar in the engine: an edit now would be refused, so it waits.
    expect(isDisabled(within(descCard()).getByRole("button", { name: "Изменить текст" }))).toBe(true);
    expect(text(descCard())).toContain(EDIT_HELD_REASON);

    runAll(scheduler);
    await flush();
    expect(text(checkCard())).toContain("Описание совпадает с фото");
    expect(isDisabled(within(descCard()).getByRole("button", { name: "Изменить текст" }))).toBe(false);
  });
});

describe("11 · the description matches", () => {
  test("a verdict per aspect, the body grey when the photo does not show it, and «Проверить снова» at the same price", async () => {
    const { engine } = await openLook();
    await runCheck();

    expect(callsOf(engine, "avatars.checkDescriptor").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId, acceptedWorstMicros: 25_000 }]);
    expect(text(checkCard())).toContain("Описание совпадает с фото");
    expect(text(checkCard())).toMatch(/сегодня, \d\d:\d\d/);
    const items = within(within(checkCard()).getByRole("list", { name: "Что сверяется" })).getAllByRole("listitem").map(text);
    expect(items).toEqual(["Волосы — совпадает", "Глаза — совпадает", "Приметы — совпадает", "Тело на фото не видно"]);
    expect(text(checkButton(/^Проверить снова/))).toBe("Проверить снова · до $0.025");
    expect(said(checkCard())).toContain("Сверка: описание совпадает с фото");
    // A check never writes: the description is as it was.
    expect(callsOf(engine, "avatars.editDescriptor")).toHaveLength(0);
    expect(within(descCard()).getByText(TEXT).tagName).toBe("P");
  });

  test("the verdict survives a look at «Фото» and back", async () => {
    await openLook();
    await runCheck();
    fireEvent.click(screen.getByRole("tab", { name: "Фото" }));
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "Внешность" }));
    await flush();
    expect(text(checkCard())).toContain("Описание совпадает с фото");
  });
});

describe("10 · the description does not match", () => {
  test("the card says what differs; «Описание» offers the fix as an edit, and nothing is applied by itself", async () => {
    const { engine } = await openLook();
    engine.setNextDescriptorCheck(hairMismatch());
    await runCheck();

    expect(text(checkCard())).toContain("Не совпадает: волосы");
    expect(text(checkCard())).toContain("В описании: волнистые каштановые");
    expect(text(checkCard())).toContain("На фото: прямые платиновые с чёлкой");
    expect(text(checkCard())).toContain("Исправленный текст — в «Описании» справа. Сам он не применится.");
    // The card ends at its pointer while the proposal waits (the mockup's 10): no second check before it is dealt with.
    expect(within(checkCard()).queryByRole("button") === null).toBe(true);
    expect(said(checkCard())).toContain("Сверка: не совпадает: волосы");

    expect(within(descCard()).getByText("предложение сверки").className).toContain("tag-warn");
    expect(within(descCard()).getByText(`${PROPOSAL.length} / 600`).tagName).toBe("SPAN");
    const struck = Array.from(descCard().querySelectorAll("del.dx")).map(text);
    const inserted = Array.from(descCard().querySelectorAll("ins.dx")).map(text);
    expect(struck).toEqual(["убрать: wavy chestnut"]);
    expect(inserted).toEqual(["вставить: straight platinum-white", "вставить:  with bangs"]);
    expect(text(descCard())).toContain("Сверка видит на фото: волосы — прямые платиновые с чёлкой.");
    expect(callsOf(engine, "avatars.editDescriptor")).toHaveLength(0);
  });

  test("«Исправить описание» stores the proposal against the text the check judged, and the page shows the stored text", async () => {
    const { engine } = await openLook();
    engine.setNextDescriptorCheck(hairMismatch());
    await runCheck();

    fireEvent.click(within(descCard()).getByRole("button", { name: "Исправить описание" }));
    await flush();

    expect(callsOf(engine, "avatars.editDescriptor").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId, text: PROPOSAL, expectedText: TEXT }]);
    expect(within(descCard()).getByText(PROPOSAL).tagName).toBe("P");
    expect(within(descCard()).queryByText("предложение сверки") === null).toBe(true);
    expect(text(checkCard())).toContain("Описание исправлено по сверке");
    expect(text(checkButton(/^Проверить снова/))).toBe("Проверить снова · до $0.025");
    expect(said(descCard())).toContain("Описание исправлено");
  });

  test("«Оставить» keeps the description as it was and offers the check again", async () => {
    const { engine } = await openLook();
    engine.setNextDescriptorCheck(hairMismatch());
    await runCheck();

    fireEvent.click(within(descCard()).getByRole("button", { name: "Оставить" }));
    await flush();

    expect(callsOf(engine, "avatars.editDescriptor")).toHaveLength(0);
    expect(within(descCard()).getByText(TEXT).tagName).toBe("P");
    expect(text(checkCard())).toContain("Не совпадает: волосы");
    expect(text(checkCard())).toContain("Описание оставлено как было.");
    expect(text(checkButton(/^Проверить снова/))).toBe("Проверить снова · до $0.025");
  });

  test("a proposal refused as stale goes: the window reads the description again and says it changed", async () => {
    const { engine } = await openLook();
    engine.setNextDescriptorCheck(hairMismatch());
    await runCheck();
    engine.failNext("avatars.editDescriptor", { code: "VALIDATION", descriptorReason: "stale", detail: "the stored description is not the one this edit was made against" });

    fireEvent.click(within(descCard()).getByRole("button", { name: "Исправить описание" }));
    await flush();

    expect(callsOf(engine, "avatars.list").length).toBeGreaterThan(0);
    expect(text(descCard())).toContain("Описание уже изменилось — проверьте ещё раз");
    expect(within(descCard()).queryByRole("button", { name: "Исправить описание" }) === null).toBe(true);
    expect(text(checkCard())).toContain("Описание уже изменилось — проверьте ещё раз.");
    expect(isDisabled(checkButton(/^Проверить снова/))).toBe(false);
  });

  test("a description changed by another window after the check drops the proposal by itself", async () => {
    const { engine, client } = await openLook();
    engine.setNextDescriptorCheck(hairMismatch());
    await runCheck();

    const other = TEXT.replace("hazel eyes", "green eyes");
    await act(async () => {
      await client.request("avatars.editDescriptor", { avatarId: MIA.avatarId, text: other, expectedText: TEXT });
    });
    await flush();

    expect(within(descCard()).getByText(other).tagName).toBe("P");
    expect(within(descCard()).queryByRole("button", { name: "Исправить описание" }) === null).toBe(true);
    expect(text(checkCard())).toContain("Описание изменено после сверки — проверьте ещё раз.");
  });

  test("a body mismatch has no text fix: the body row says so, and no proposal is offered", async () => {
    const { engine } = await openLook();
    engine.setNextDescriptorCheck({
      matches: false,
      aspects: { hair: { state: "ok" }, eyes: { state: "ok" }, marks: { state: "ok" }, body: { state: "mismatch", descriptor: "спортивное", photo: "мягкие формы" } },
      proposal: null,
      checkedText: TEXT,
    });
    await runCheck();

    expect(text(checkCard())).toContain("Не совпадает: тело");
    expect(text(checkCard())).toContain("На фото: мягкие формы");
    expect(within(descCard()).queryByText("предложение сверки") === null).toBe(true);
    expect(text(checkCard())).not.toContain("Исправленный текст");
    expect(isDisabled(checkButton(/^Проверить снова/))).toBe(false);
  });
});

describe("12 · no key", () => {
  test("the button waits with the app's reason and a way to Settings; nothing is sent", async () => {
    const { engine } = await openLook({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
    expect(screen.getByText("Добавьте ключ OpenRouter").tagName).toBe("P");
    const button = checkButton(/^Проверить описание/);
    expect(isDisabled(button)).toBe(true);
    expect(text(checkCard())).toContain("Нужен рабочий ключ OpenRouter — добавьте его в Настройках.");
    expect(button.getAttribute("aria-describedby") !== null).toBe(true);

    fireEvent.click(within(checkCard()).getByRole("button", { name: "Открыть ключ в Настройках" }));
    await screen.findByRole("heading", { level: 1, name: "Настройки" });
    expect(callsOf(engine, "avatars.checkDescriptor")).toHaveLength(0);
  });
});

describe("13 · the check fails", () => {
  test("no network: «Сверка не прошла» with the app's text, the last verdict kept, and «Повторить сверку» at the price", async () => {
    const { engine } = await openLook();
    await runCheck();
    engine.setNextDescriptorCheck({ code: "NETWORK" });
    await runCheck();

    expect(text(checkCard())).toContain("Сверка не прошла");
    expect(text(checkCard())).toContain(ERROR_MESSAGES_RU.NETWORK);
    expect(text(checkCard())).toMatch(/последняя: \d\d:\d\d · совпадало/);
    expect(text(checkButton(/^Повторить сверку/))).toBe("Повторить сверку · до $0.025");
    expect(said(checkCard())).toContain("Сверка не прошла");

    await runCheck();
    expect(text(checkCard())).toContain("Описание совпадает с фото");
    expect(callsOf(engine, "avatars.checkDescriptor")).toHaveLength(3);
  });

  test("a higher price is shown before anything more is sent, and the next click accepts it", async () => {
    const { engine } = await openLook();
    engine.setCheckPrice({ expectedMicros: 5_000, worstMicros: 40_000 });
    await runCheck();

    expect(text(checkCard())).toContain("Цена выросла");
    expect(text(checkCard())).toContain("Было не больше $0.025, теперь не больше $0.040.");
    expect(text(checkButton(/^Подтвердить новую цену/))).toBe("Подтвердить новую цену · до $0.040");
    expect(callsOf(engine, "avatars.checkDescriptor").map((c) => c.payload.acceptedWorstMicros)).toEqual([25_000]);

    await runCheck();
    expect(callsOf(engine, "avatars.checkDescriptor").map((c) => c.payload.acceptedWorstMicros)).toEqual([25_000, 40_000]);
    expect(text(checkCard())).toContain("Описание совпадает с фото");
  });
});

describe("held by other work (IN_FLIGHT, not drawn on the mockup)", () => {
  test("while her photo run draws, the check waits with the reason; the edit stays open and says the run keeps the old text", async () => {
    const { engine, client, scheduler } = await openLook();
    const started = await act(async () => client.request("runs.start", { ...RUN, acceptedWorstMicros: 3_075_000 }));
    if (!started.ok) throw new Error(`runs.start: ${started.error.code}`);
    await flush();

    const button = checkButton(/^Проверить описание/);
    expect(isDisabled(button)).toBe(true);
    expect(text(checkCard())).toContain(CHECK_HELD_REASON);

    fireEvent.click(within(descCard()).getByRole("button", { name: "Изменить текст" }));
    await flush();
    expect(text(descCard())).toContain("Съёмка, которая идёт сейчас, закончит со старым описанием — новое возьмут следующие фото.");
    fireEvent.click(within(descCard()).getByRole("button", { name: "Отмена" }));
    await flush();

    runAll(scheduler);
    await flush();
    await waitFor(() => expect(isDisabled(checkButton(/^Проверить описание/))).toBe(false));
    expect(text(checkCard())).not.toContain(CHECK_HELD_REASON);
    expect(callsOf(engine, "avatars.checkDescriptor")).toHaveLength(0);
  });

  test("refused IN_FLIGHT for work the window cannot see: the same reason, not «Сверка не прошла», and a retry", async () => {
    const { engine } = await openLook();
    engine.setAvatarBusy(MIA.avatarId, true);
    await runCheck();

    expect(text(checkCard())).toContain(CHECK_HELD_REASON);
    expect(text(checkCard())).not.toContain("Сверка не прошла");
    expect(isDisabled(checkButton(/^Повторить сверку/))).toBe(false);

    engine.setAvatarBusy(MIA.avatarId, false);
    await runCheck();
    expect(text(checkCard())).toContain("Описание совпадает с фото");
  });

  test("an edit refused IN_FLIGHT says the description can be changed when that work ends", async () => {
    const { engine } = await openLook();
    engine.setAvatarEditing(MIA.avatarId, true);
    fireEvent.click(within(descCard()).getByRole("button", { name: "Изменить текст" }));
    fireEvent.change(within(descCard()).getByRole("textbox", { name: "Текст описания" }), { target: { value: `${TEXT} Soft smile.` } });
    fireEvent.click(within(descCard()).getByRole("button", { name: "Сохранить" }));
    await flush();

    expect(within(descCard()).getByRole("alert").textContent).toBe(EDIT_HELD_REASON);
    expect(within(descCard()).getByRole("textbox", { name: "Текст описания" }).getAttribute("aria-invalid")).toBe("true");
  });
});

describe("«Изменить текст»", () => {
  test("saves free, against the stored text; the next edit is made against what the engine stored, not what was typed", async () => {
    const { engine } = await openLook();
    fireEvent.click(within(descCard()).getByRole("button", { name: "Изменить текст" }));
    await flush();
    const field = within(descCard()).getByRole("textbox", { name: "Текст описания" });
    expect(document.activeElement === field).toBe(true);
    // An en dash the engine folds to a hyphen.
    const typed = TEXT.replace("hazel eyes", "grey–blue eyes");
    fireEvent.change(field, { target: { value: typed } });
    expect(within(descCard()).getByText(`${typed.length} / 600`).tagName).toBe("SPAN");
    fireEvent.click(within(descCard()).getByRole("button", { name: "Сохранить" }));
    await flush();

    const stored = TEXT.replace("hazel eyes", "grey-blue eyes");
    expect(callsOf(engine, "avatars.editDescriptor").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId, text: typed, expectedText: TEXT }]);
    expect(within(descCard()).getByText(stored).tagName).toBe("P");
    expect(said(descCard())).toContain("Описание сохранено");
    expect(document.activeElement === within(descCard()).getByRole("button", { name: "Изменить текст" })).toBe(true);

    fireEvent.click(within(descCard()).getByRole("button", { name: "Изменить текст" }));
    fireEvent.change(within(descCard()).getByRole("textbox", { name: "Текст описания" }), { target: { value: `${stored} Soft smile.` } });
    fireEvent.click(within(descCard()).getByRole("button", { name: "Сохранить" }));
    await flush();
    expect(callsOf(engine, "avatars.editDescriptor").at(-1)?.payload.expectedText).toBe(stored);
  });

  test("a text the rules refuse says which rule, with her own age in the anchor example; Escape leaves without saving", async () => {
    const { engine } = await openLook();
    fireEvent.click(within(descCard()).getByRole("button", { name: "Изменить текст" }));
    const field = within(descCard()).getByRole("textbox", { name: "Текст описания" });

    fireEvent.change(field, { target: { value: TEXT.replace("25-year-old", "adult") } });
    fireEvent.click(within(descCard()).getByRole("button", { name: "Сохранить" }));
    await flush();
    expect(within(descCard()).getByRole("alert").textContent).toBe("В описании должна быть фраза «<возраст>-year-old» с возрастом этого аватара, например «25-year-old»");
    // The same text is not sent again: «Сохранить» waits for another one, and the reason goes as soon as the owner types.
    expect(isDisabled(within(descCard()).getByRole("button", { name: "Сохранить" }))).toBe(true);
    fireEvent.change(field, { target: { value: "25-year-old девушка" } });
    expect(within(descCard()).queryByRole("alert") === null).toBe(true);
    expect(isDisabled(within(descCard()).getByRole("button", { name: "Сохранить" }))).toBe(false);
    fireEvent.click(within(descCard()).getByRole("button", { name: "Сохранить" }));
    await flush();
    expect(within(descCard()).getByRole("alert").textContent).toBe("Описание пишется латиницей — английскими словами");

    fireEvent.keyDown(field, { key: "Escape" });
    await flush();
    expect(within(descCard()).queryByRole("textbox") === null).toBe(true);
    expect(within(descCard()).getByText(TEXT).tagName).toBe("P");
    expect(callsOf(engine, "avatars.editDescriptor")).toHaveLength(2);
  });

  test("stale: the text changed in another window meanwhile — the editor shows it, and the next save is made against it", async () => {
    const { engine, client } = await openLook();
    fireEvent.click(within(descCard()).getByRole("button", { name: "Изменить текст" }));
    const mine = `${TEXT} Soft smile.`;
    fireEvent.change(within(descCard()).getByRole("textbox", { name: "Текст описания" }), { target: { value: mine } });

    const theirs = TEXT.replace("hazel eyes", "green eyes");
    await act(async () => {
      await client.request("avatars.editDescriptor", { avatarId: MIA.avatarId, text: theirs, expectedText: TEXT });
    });
    await flush();
    fireEvent.click(within(descCard()).getByRole("button", { name: "Сохранить" }));
    await flush();

    expect(within(descCard()).getByRole("alert").textContent).toBe("Описание уже изменилось — проверьте ещё раз");
    expect(text(descCard())).toContain("Сейчас в описании:");
    expect(within(descCard()).getByText(theirs).tagName).toBe("P");
    // The owner's own words stay in the field until he takes the stored ones.
    expect(fieldValue()).toBe(mine);
    fireEvent.click(within(descCard()).getByRole("button", { name: "Взять этот текст" }));
    expect(fieldValue()).toBe(theirs);

    const merged = `${theirs} Soft smile.`;
    fireEvent.change(within(descCard()).getByRole("textbox", { name: "Текст описания" }), { target: { value: merged } });
    fireEvent.click(within(descCard()).getByRole("button", { name: "Сохранить" }));
    await flush();
    const edits = callsOf(engine, "avatars.editDescriptor").map((c) => c.payload);
    expect(edits.at(-2)).toEqual({ avatarId: MIA.avatarId, text: mine, expectedText: TEXT });
    expect(edits.at(-1)).toEqual({ avatarId: MIA.avatarId, text: merged, expectedText: theirs });
    expect(within(descCard()).getByText(merged).tagName).toBe("P");
  });
});
