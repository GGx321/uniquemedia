import { describe, expect, test } from "bun:test";
import { StrictMode } from "react";
import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { DescriptorCheck, Draft } from "../../shared/engine";
import { App } from "../App";
import { MOCK_ESTIMATE, MockEngine, mockDescriptor, mockEngineClient } from "../engine/mockEngine";
import { ManualScheduler } from "../engine/scheduler";
import { DEFAULT_TRAITS } from "../lib/traits";
import { callsOf, estimateText, flush, inAct, setup, withText } from "../testing";

// S5.0d: the wizard and the import end on the new avatar's «Внешность» (the owner's decision; mockup 11 after «Сохранить», 05–06 after
// «Импортировать»). After «Сохранить» the check the wizard priced under the button runs there, at exactly that worst case; the import brings the
// check it ran itself. Nothing paid is ever sent at a price that was not shown.

const DRAFT_ID = "avatar-landing-0001";
const DRAFT_TEXT = mockDescriptor(DEFAULT_TRAITS).text;
/** The mock import's own descriptor (its fixed traits, as `mockEngine.ts` writes them for every imported photo). */
const IMPORT_TEXT = mockDescriptor({ ...DEFAULT_TRAITS, age: 26, skinTone: "light", hairColor: "dark-brown", hairLength: "long", hairTexture: "straight", eyeColor: "brown", build: "slim", marks: [], vibe: "" }).text;

function readyDraft(): Draft {
  return {
    avatarId: DRAFT_ID,
    traits: DEFAULT_TRAITS,
    descriptor: mockDescriptor(DEFAULT_TRAITS),
    candidates: ["a", "b", "c", "d"].map((x) => ({ avatarId: DRAFT_ID, photoId: `photo-landing-000${x}` })),
    hiddenBelowThreshold: 0,
    estimate: { ...MOCK_ESTIMATE },
  };
}

function mismatch(checkedText: string, from: string, to: string): DescriptorCheck {
  return {
    matches: false,
    aspects: { hair: { state: "ok" }, eyes: { state: "mismatch", descriptor: "карие", photo: "зелёные" }, marks: { state: "ok" }, body: { state: "not-visible" } },
    proposal: checkedText.replace(from, to),
    checkedText,
  };
}

const text = (el: Element): string => el.textContent ?? "";
const checkCard = (): HTMLElement => screen.getByRole("region", { name: "Сверка с фото" });
const descCard = (): HTMLElement => screen.getByRole("region", { name: "Описание" });
const HINT = /^Затем — сверка описания с ним · до \$/;

/** The accessible description an element points at, as one string. */
function describedBy(el: HTMLElement): string {
  const ids = (el.getAttribute("aria-describedby") ?? "").split(" ").filter(Boolean);
  return ids.map((id) => document.getElementById(id)?.textContent ?? `(#${id} missing)`).join(" ");
}

/** From the grid into the draft, pick «Вариант B» and name her Mia: the wizard is one click from «Сохранить». */
async function readyToSave(): Promise<void> {
  const card = await screen.findByRole("article", { name: "Черновик" });
  fireEvent.click(within(card).getByRole("button", { name: "Продолжить" }));
  await screen.findByRole("heading", { level: 1, name: "Новый аватар" });
  await flush();
  fireEvent.click(screen.getByRole("radio", { name: "Вариант B" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Имя/ }), { target: { value: "Mia" } });
}

async function save(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  await flush();
}

describe("after «Сохранить» (11)", () => {
  test("the wizard shows the check's price under the button; the avatar's «Внешность» runs it at that price, once", async () => {
    const { engine } = setup({ drafts: [readyDraft()] });
    await readyToSave();
    expect(callsOf(engine, "avatars.estimateCheckDescriptor").map((c) => c.payload)).toEqual([{ avatarId: DRAFT_ID }]);
    expect(screen.getByText(withText(HINT)).textContent).toBe("Затем — сверка описания с ним · до $0.025");
    // Review r1 (4): one line, as the mockup's 03, and the button says what its click also accepts.
    expect(describedBy(screen.getByRole("button", { name: "Сохранить" }))).toBe("Мастер-портрет — вариант B. Затем — сверка описания с ним · до $0.025");

    await save();
    expect(screen.getByRole("tab", { name: "Внешность" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Аватар «Mia» сохранён. Мастер-портрет готов для фото.").tagName).toBe("DIV");
    expect(callsOf(engine, "avatars.checkDescriptor").map((c) => c.payload)).toEqual([{ avatarId: DRAFT_ID, acceptedWorstMicros: 25_000 }]);
    expect(text(checkCard())).toContain("Описание совпадает с фото");
    expect(text(checkCard())).toContain("при сохранении");
    expect(within(descCard()).getByText(DRAFT_TEXT).tagName).toBe("P");

    // A look at «Фото» and back is not a second landing.
    fireEvent.click(screen.getByRole("tab", { name: "Фото" }));
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "Внешность" }));
    await flush();
    expect(callsOf(engine, "avatars.checkDescriptor")).toHaveLength(1);
    expect(text(checkCard())).toContain("при сохранении");
  });

  test("a mismatch lands with its proposal; «Исправить описание» stores it against the saved text", async () => {
    const { engine } = setup({ drafts: [readyDraft()] });
    engine.setNextDescriptorCheck(mismatch(DRAFT_TEXT, "hazel eyes", "green eyes"));
    await readyToSave();
    await save();

    expect(text(checkCard())).toContain("Не совпадает: глаза");
    expect(text(checkCard())).toContain("при сохранении");
    expect(within(descCard()).getByText("предложение сверки").className).toContain("tag-warn");
    fireEvent.click(within(descCard()).getByRole("button", { name: "Исправить описание" }));
    await flush();
    expect(callsOf(engine, "avatars.editDescriptor").map((c) => c.payload)).toEqual([
      { avatarId: DRAFT_ID, text: DRAFT_TEXT.replace("hazel eyes", "green eyes"), expectedText: DRAFT_TEXT },
    ]);
  });

  test("a price that rose after it was shown is refused, not paid: the card shows the new price and waits for a click", async () => {
    const { engine } = setup({ drafts: [readyDraft()] });
    await readyToSave();
    await waitFor(() => expect(screen.queryByText(withText(HINT)) === null).toBe(false));
    engine.setCheckPrice({ expectedMicros: 5_000, worstMicros: 40_000 });
    await save();

    expect(callsOf(engine, "avatars.checkDescriptor").map((c) => c.payload.acceptedWorstMicros)).toEqual([25_000]);
    expect(text(checkCard())).toContain("Было не больше $0.025, теперь не больше $0.040.");
    expect(within(checkCard()).getByRole("button", { name: /^Подтвердить новую цену/ }).textContent).toBe("Подтвердить новую цену · до $0.040");
  });

  test("no key when she is saved: the price was shown, but no check is sent, and the card says why (review r1, 8)", async () => {
    const { engine } = setup({ drafts: [readyDraft()], apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
    await readyToSave();
    await waitFor(() => expect(screen.queryByText(withText(HINT)) === null).toBe(false));
    await save();

    expect(callsOf(engine, "avatars.checkDescriptor")).toHaveLength(0);
    expect(text(checkCard())).toContain("Нужен рабочий ключ OpenRouter — добавьте его в Настройках.");
    expect(within(checkCard()).getByRole("button", { name: /^Проверить описание/ }).hasAttribute("disabled")).toBe(true);
  });

  test("paid requests stopped for a reconcile when she is saved: no check is sent (review r1, 8)", async () => {
    const { engine } = setup({ drafts: [readyDraft()] });
    await readyToSave();
    await waitFor(() => expect(screen.queryByText(withText(HINT)) === null).toBe(false));
    inAct(() => engine.requireReconcile(["open-reserves"]));
    await flush();
    await save();

    expect(callsOf(engine, "avatars.checkDescriptor")).toHaveLength(0);
    expect(text(checkCard())).toContain("Платные запросы остановлены до сверки расходов.");
  });

  test("React's development double mount (StrictMode) still sends the check once (review r1, 8)", async () => {
    const scheduler = new ManualScheduler();
    const engine = new MockEngine({ scheduler, latencyMs: 0, drafts: [readyDraft()] });
    render(
      <StrictMode>
        <App client={mockEngineClient(engine)} />
      </StrictMode>,
    );
    await readyToSave();
    await waitFor(() => expect(screen.queryByText(withText(HINT)) === null).toBe(false));
    await save();
    await flush();

    expect(callsOf(engine, "avatars.checkDescriptor").map((c) => c.payload)).toEqual([{ avatarId: DRAFT_ID, acceptedWorstMicros: 25_000 }]);
    expect(text(checkCard())).toContain("Описание совпадает с фото");
  });

  test("no price under «Сохранить», no check after it", async () => {
    const { engine } = setup({ drafts: [readyDraft()] });
    engine.failNext("avatars.estimateCheckDescriptor", { code: "INTERNAL" });
    await readyToSave();
    expect(screen.queryByText(withText(HINT)) === null).toBe(true);

    await save();
    expect(callsOf(engine, "avatars.checkDescriptor")).toHaveLength(0);
    expect(text(checkCard())).toContain("последняя: ещё не было");
    expect(within(checkCard()).getByRole("button", { name: /^Проверить описание/ }).textContent).toBe("Проверить описание · до $0.025");
  });
});

describe("after «Импортировать» (05–06)", () => {
  async function importZoe(): Promise<void> {
    fireEvent.click(await screen.findByRole("button", { name: "Импортировать аватара" }));
    await screen.findByRole("heading", { level: 1, name: "Импортировать аватара" });
    fireEvent.click(screen.getByRole("button", { name: /Выбрать фото/ }));
    await waitFor(() => expect(estimateText()).not.toBeNull());
    fireEvent.change(screen.getByPlaceholderText("Mia"), { target: { value: "Zoe" } });
    fireEvent.click(screen.getByRole("button", { name: /Импортировать · до/ }));
    await screen.findByRole("heading", { level: 1, name: "Zoe" });
    await flush();
  }

  test("the import's own check is shown as it came, «при импорте»; no second check is bought", async () => {
    const { engine } = setup();
    await importZoe();

    expect(screen.getByRole("tab", { name: "Внешность" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("Аватар «Zoe» импортирован. Описание прочитано с фото и сверено с ним.").tagName).toBe("DIV");
    expect(text(checkCard())).toContain("Описание совпадает с фото");
    expect(text(checkCard())).toContain("при импорте");
    expect(within(descCard()).getByText(IMPORT_TEXT).tagName).toBe("P");
    expect(within(descCard()).getByText("прочитано с фото").className).toBe("tag");
    expect(callsOf(engine, "avatars.checkDescriptor")).toHaveLength(0);
  });

  test("«прочитано с фото» goes once the owner edits the text, and stays gone after a look at «Фото» and back (review r1, 1)", async () => {
    setup();
    await importZoe();
    fireEvent.click(within(descCard()).getByRole("button", { name: "Изменить текст" }));
    fireEvent.change(within(descCard()).getByRole("textbox", { name: "Текст описания" }), { target: { value: `${IMPORT_TEXT} Soft smile.` } });
    fireEvent.click(within(descCard()).getByRole("button", { name: "Сохранить" }));
    await flush();
    expect(within(descCard()).getByText(`${IMPORT_TEXT} Soft smile.`).tagName).toBe("P");
    expect(within(descCard()).queryByText("прочитано с фото") === null).toBe(true);

    fireEvent.click(screen.getByRole("tab", { name: "Фото" }));
    await flush();
    fireEvent.click(screen.getByRole("tab", { name: "Внешность" }));
    await flush();
    expect(within(descCard()).queryByText("прочитано с фото") === null).toBe(true);
  });

  test("a mismatch at import (06): the notice points at it, and the proposal is fixed against the text the import read", async () => {
    const { engine, client } = setup();
    engine.setNextDescriptorCheck(mismatch(IMPORT_TEXT, "brown eyes", "green eyes"));
    await importZoe();

    expect(screen.getByText("Аватар «Zoe» импортирован. Описание прочитано с фото — проверьте сверку.").tagName).toBe("DIV");
    expect(text(checkCard())).toContain("Не совпадает: глаза");
    expect(text(checkCard())).toContain("В описании: карие");
    expect(text(checkCard())).toContain("На фото: зелёные");
    expect(text(checkCard())).toContain("при импорте");
    fireEvent.click(within(descCard()).getByRole("button", { name: "Исправить описание" }));
    await flush();

    const listed = await client.request("avatars.list", {});
    const zoeId = listed.ok ? (listed.result.avatars.find((a) => a.name === "Zoe")?.avatarId ?? null) : null;
    expect(callsOf(engine, "avatars.editDescriptor").map((c) => c.payload)).toEqual([
      { avatarId: zoeId ?? "(Zoe is not listed)", text: IMPORT_TEXT.replace("brown eyes", "green eyes"), expectedText: IMPORT_TEXT },
    ]);
    // Edited now: no longer as read from the photo.
    expect(within(descCard()).queryByText("прочитано с фото") === null).toBe(true);
  });

  test("an import whose check came back empty keeps the avatar and offers the check here", async () => {
    const { engine } = setup();
    engine.setNextDescriptorCheck({ code: "TIMEOUT" });
    await importZoe();

    expect(screen.getByText("Аватар «Zoe» импортирован. Описание прочитано с фото.").tagName).toBe("DIV");
    expect(text(checkCard())).toContain("Сверка при импорте не прошла");
    const button = within(checkCard()).getByRole("button", { name: /^Проверить описание/ });
    expect(button.textContent).toBe("Проверить описание · до $0.025");

    fireEvent.click(button);
    await flush();
    expect(callsOf(engine, "avatars.checkDescriptor").map((c) => c.payload.acceptedWorstMicros)).toEqual([25_000]);
    expect(text(checkCard())).toContain("Описание совпадает с фото");
  });
});
