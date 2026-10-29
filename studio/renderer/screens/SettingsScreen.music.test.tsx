import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, within } from "@testing-library/react";
import { ERROR_MESSAGES_RU, type ApiKeyStatus, type MusicKeyStatus } from "../../shared/engine";
import { expectNoKeyFragment } from "../../testing/keyLeaks";
import { type MockMusicOptions } from "../engine/mockEngine";
import { NBSP } from "../lib/format";
import { callsOf, flush, focusedLabel, openSection, runAll, setup } from "../testing";

// 3c.6: the Settings «Музыка · flashapi» card, from the Stage 3 artboard (Settings.dc.html, the components sheet's quota):
// the RapidAPI key («Заменить» / «Удалить», no «Проверить»), «отправлено N из 30 за 31 день», the list's age, and «Обновить»,
// which spends one of the 30 requests only after a confirmation; plus the way out of a damaged quota log. All on the dev mock.

const KEY: MusicKeyStatus = { stored: true, last4: "7c1e", rejected: false };
const NO_KEY: MusicKeyStatus = { stored: false, last4: null, rejected: false };
const LIST = { fetchedAt: "2026-09-21T11:02:00.000Z", trackCount: 30, bytesOnDisk: 94_000_000 };
const TWELVE: MockMusicOptions = { sendsDaysAgo: [22, 19, 17, 15, 12, 10, 9, 7, 5, 4, 3, 1], list: LIST };
const days = (n: number, ago = 2): number[] => Array.from({ length: n }, () => ago);
/** A test key in the shape keyLeaks.ts asks for: obviously fake, no word the code uses. */
const TYPED = "Zq7-vKt9-Wm2x-Lp4s-0000";

async function openMusic(options: { musicKey?: MusicKeyStatus; music?: MockMusicOptions; apiKey?: ApiKeyStatus } = {}) {
  const ctx = setup({ musicKey: options.musicKey ?? KEY, music: options.music ?? TWELVE, ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }) });
  await flush();
  await openSection("Настройки");
  await screen.findByRole("heading", { level: 2, name: "Музыка · flashapi" });
  await flush();
  return ctx;
}

const card = (): HTMLElement => {
  const section = screen.getByRole("heading", { level: 2, name: "Музыка · flashapi" }).closest("section");
  if (!(section instanceof HTMLElement)) throw new Error("the music card is missing");
  return section;
};

const rowOf = (label: string): HTMLElement => {
  const found = within(card()).getByText(label, { selector: "b, label" }).closest(".row");
  if (!(found instanceof HTMLElement)) throw new Error(`the row «${label}» is missing`);
  return found;
};

const button = (name: string | RegExp): HTMLElement => within(card()).getByRole("button", { name });
const queryButton = (name: string | RegExp): HTMLElement | null => within(card()).queryByRole("button", { name });

describe("the card", () => {

  test("asks the engine for the music status when it opens", async () => {
    const { engine } = await openMusic();
    expect(callsOf(engine, "music.status").length).toBeGreaterThanOrEqual(1);
  });

});

describe("the RapidAPI key", () => {
  test("stored: the lock, «зашифрован системой», the last four only, «Заменить» and «Удалить»", async () => {
    await openMusic();
    const row = rowOf("Ключ RapidAPI");
    expect(within(row).getByText("зашифрован системой")).toBeDefined();
    const mask = within(row).getByDisplayValue("••••••••7c1e");
    expect(mask.hasAttribute("readonly")).toBe(true);
    expect(mask.getAttribute("aria-label")).toBe("Ключ RapidAPI, последние символы 7c1e");
    expect(button("Заменить ключ RapidAPI").textContent).toBe("Заменить");
    expect(button("Удалить ключ RapidAPI").textContent).toBe("Удалить");
  });

  test("saving sends the key once through main's flow, clears the field, and the window never holds it again", async () => {
    const { engine } = await openMusic({ musicKey: NO_KEY });
    fireEvent.change(within(card()).getByLabelText("Ключ RapidAPI"), { target: { value: `  ${TYPED}  ` } });
    fireEvent.click(button("Сохранить ключ RapidAPI"));
    await within(card()).findByDisplayValue("••••••••0000");
    expect(callsOf(engine, "settings.setMusicKey").map((c) => c.payload.key)).toEqual([TYPED]);
    expectNoKeyFragment(document.body.innerHTML, TYPED);
    expectNoKeyFragment(JSON.stringify({ ...localStorage }) + JSON.stringify({ ...sessionStorage }) + window.location.href, TYPED);
    expect(focusedLabel()).toContain("Заменить ключ RapidAPI");
  });

  test("a failed save does not keep the key on screen either", async () => {
    const { engine } = await openMusic({ musicKey: NO_KEY });
    engine.failNext("settings.setMusicKey", { code: "ENCRYPTION_UNAVAILABLE" });
    fireEvent.change(within(card()).getByLabelText("Ключ RapidAPI"), { target: { value: TYPED } });
    fireEvent.click(button("Сохранить ключ RapidAPI"));
    await within(card()).findByText(ERROR_MESSAGES_RU.ENCRYPTION_UNAVAILABLE);
    expectNoKeyFragment(document.body.innerHTML, TYPED);
  });

  test("a malformed key is refused before it is sent", async () => {
    const { engine } = await openMusic({ musicKey: NO_KEY });
    fireEvent.change(within(card()).getByLabelText("Ключ RapidAPI"), { target: { value: "short" } });
    fireEvent.click(button("Сохранить ключ RapidAPI"));
    expect(within(card()).getByText(/от 8 печатных символов/)).toBeDefined();
    expect(callsOf(engine, "settings.setMusicKey")).toHaveLength(0);
  });

  test("«Удалить» clears it through main's flow", async () => {
    const { engine } = await openMusic();
    fireEvent.click(button("Удалить ключ RapidAPI"));
    await flush();
    expect(callsOf(engine, "settings.clearMusicKey")).toHaveLength(1);
    expect(within(card()).getByLabelText("Ключ RapidAPI").getAttribute("type")).toBe("password");
  });

  test("rejected (401): said in the danger tone, with what it stops", async () => {
    await openMusic({ musicKey: { ...KEY, rejected: true } });
    expect(within(rowOf("Ключ RapidAPI")).getByText("RapidAPI отклонил ключ (401)")).toBeDefined();
    expect(within(card()).getByText(/Обновление списка остановлено/)).toBeDefined();
  });

  test("with no system encryption the field is disabled and says why", async () => {
    await openMusic({ musicKey: NO_KEY, apiKey: { stored: false, last4: null, encryptionAvailable: false, rejected: false } });
    expect(within(card()).getByLabelText("Ключ RapidAPI").hasAttribute("disabled")).toBe(true);
    expect(within(rowOf("Ключ RapidAPI")).getByText("шифрование недоступно — ключ не сохраняется")).toBeDefined();
  });
});

describe("«Обновить» confirms before it spends", () => {

  test("the first click sends NOTHING: it asks, saying what it costs, with «Отмена» focused", async () => {
    const { engine } = await openMusic();
    fireEvent.click(button("Обновить · 1 запрос"));
    expect(callsOf(engine, "music.refresh")).toHaveLength(0);
    expect(rowOf("Тренды Instagram").textContent).toMatch(new RegExp(`Спишется 1 запрос — останется 17 из 30; следующий освободится \\d+${NBSP}\\S+ Ошибка тоже считается, повторов нет\\.`));
    expect(focusedLabel()).toContain("Отмена");
    expect(within(rowOf("Тренды Instagram")).getByRole("group", { name: "Тренды Instagram" })).toBeDefined();
  });

  test("«Отмена» sends nothing and puts the button back", async () => {
    const { engine } = await openMusic();
    fireEvent.click(button("Обновить · 1 запрос"));
    fireEvent.click(button("Отмена"));
    expect(callsOf(engine, "music.refresh")).toHaveLength(0);
    expect(button("Обновить · 1 запрос")).toBeDefined();
    expect(focusedLabel()).toContain("Обновить");
  });

  test("the confirmation sends ONE music.refresh {confirm: true}, however often it is clicked", async () => {
    const { engine } = await openMusic();
    fireEvent.click(button("Обновить · 1 запрос"));
    const confirm = button("Обновить · 1 запрос");
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await flush();
    expect(callsOf(engine, "music.refresh").map((c) => c.payload)).toEqual([{ confirm: true }]);
  });

});

describe("«Обновить» is closed, with its reason on the row", () => {
  const closed = (): HTMLElement => {
    const found = within(rowOf("Тренды Instagram")).getByRole("button", { name: /^Обновить/ });
    expect(found.hasAttribute("disabled")).toBe(true);
    return found;
  };

  test.each([30, 31])("%i sent: the quota is spent, until a date", async (count) => {
    const { engine } = await openMusic({ music: { sendsDaysAgo: days(count) } });
    const reason = within(rowOf("Тренды Instagram")).getByText(/^Квота кончилась: следующий запрос — \d+\s\S+ Список остаётся прежним\.$/);
    expect(closed().getAttribute("aria-describedby")).toContain(reason.id);
    fireEvent.click(closed());
    expect(callsOf(engine, "music.refresh")).toHaveLength(0);
  });

  test("no key (also a key file that could not be read: it reads as no key): closed, pointing at the key", async () => {
    await openMusic({ musicKey: NO_KEY });
    closed();
    expect(rowOf("Тренды Instagram").textContent).toContain("Сначала добавьте ключ RapidAPI");
  });

  // Review round 1 (HIGH): «Обновить» is closed while a line is held, so the card must not promise «the next refresh» writes
  // it: asking the status does (free), when the card opens and by «Проверить снова».

});

describe("a damaged quota log", () => {
  test("reads 30 of 30, closes «Обновить», and offers the recovery with what it costs", async () => {
    await openMusic({ music: { ...TWELVE, quotaLog: "corrupt" } });
    expect(rowOf("Запросы flashapi").textContent).toContain("отправлено 30 из 30");
    closedRefresh();
    expect(within(card()).getByText("Журнал запросов повреждён")).toBeDefined();
    expect(button("Восстановить журнал…")).toBeDefined();
  });

  test("the confirmation sends ONE music.recoverQuotaLog {confirm: true}; then the quota reads closed, with its date", async () => {
    const { engine } = await openMusic({ music: { ...TWELVE, quotaLog: "corrupt" } });
    fireEvent.click(button("Восстановить журнал…"));
    const confirm = button("Восстановить и закрыть на 31 день");
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await flush();
    expect(callsOf(engine, "music.recoverQuotaLog").map((c) => c.payload)).toEqual([{ confirm: true }]);
    expect(within(card()).queryByText("Журнал запросов повреждён")?.textContent ?? null).toBeNull();
    expect(rowOf("Тренды Instagram").textContent).toMatch(/Квота кончилась: следующий запрос — \d+ \S+/);
    expect(callsOf(engine, "music.refresh")).toHaveLength(0);
  });
});

describe("the confirmation never comes back on its own (review round 1, LOW)", () => {
  test("asked, then the refresh starts elsewhere and ends: the row shows «Обновить» again, not the old confirmation", async () => {
    const { engine, client, scheduler } = await openMusic();
    fireEvent.click(button("Обновить · 1 запрос"));
    expect(queryButton("Отмена")?.textContent ?? null).not.toBeNull();
    await act(async () => {
      await client.request("music.refresh", { confirm: true });
    });
    await flush();
    expect(queryButton("Отмена")?.textContent ?? null).toBeNull();
    runAll(scheduler);
    await flush();
    expect(queryButton("Отмена")?.textContent ?? null).toBeNull();
    expect(button("Обновить · 1 запрос").hasAttribute("disabled")).toBe(false);
    expect(callsOf(engine, "music.refresh")).toHaveLength(1);
  });
});

/** «Обновить» is there and disabled. */
function closedRefresh(): void {
  expect(within(rowOf("Тренды Instagram")).getByRole("button", { name: /^Обновить/ }).hasAttribute("disabled")).toBe(true);
}

