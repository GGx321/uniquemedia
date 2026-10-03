import { describe, expect, test } from "bun:test";
import { act, fireEvent, render, screen, within } from "@testing-library/react";
import { ERROR_MESSAGES_RU, MUSIC_UNAVAILABLE_REASONS_RU, type ApiKeyStatus, type MusicKeyStatus } from "../../shared/engine";
import { expectNoKeyFragment } from "../../testing/keyLeaks";
import { MockEngine, mockEngineClient, type MockMusicOptions } from "../engine/mockEngine";
import { EngineProvider } from "../engine/react";
import { ManualScheduler } from "../engine/scheduler";
import { NBSP } from "../lib/format";
import { createNavigation, NavigationProvider } from "../navigation";
import { ErrorNotice } from "../ui/Notice";
import { callsOf, describeElement, flush, focusedLabel, openSection, runAll, setup } from "../testing";
import { SettingsScreen } from "./SettingsScreen";

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
  test("sits in the right column under «Папки и экспорт», as the artboard has it", async () => {
    await openMusic();
    const headings = screen.getAllByRole("heading", { level: 2 }).map((h) => h.textContent);
    expect(headings.slice(-3)).toEqual(["Производительность", "Папки и экспорт", "Музыка · flashapi"]);
  });

  test("asks the engine for the music status when it opens", async () => {
    const { engine } = await openMusic();
    expect(callsOf(engine, "music.status").length).toBeGreaterThanOrEqual(1);
  });

  test("never offers «Проверить»: a check would spend one of the 30 requests (Q4)", async () => {
    await openMusic();
    expect(queryButton(/Проверить/)).toBeNull();
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

  test("not stored: a password field that is never remembered, and how to get a key", async () => {
    await openMusic({ musicKey: NO_KEY });
    const input = within(card()).getByLabelText("Ключ RapidAPI");
    expect(input.getAttribute("type")).toBe("password");
    expect(input.getAttribute("autocomplete")).toBe("off");
    expect(input.getAttribute("spellcheck")).toBe("false");
    expect(within(rowOf("Ключ RapidAPI")).getByText(/^не сохранён · /)).toBeDefined();
    expect(button("Сохранить ключ RapidAPI").hasAttribute("disabled")).toBe(true);
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

  test("«Заменить» opens an empty field; «Отмена» goes back to the mask", async () => {
    await openMusic();
    fireEvent.click(button("Заменить ключ RapidAPI"));
    const input = within(card()).getByLabelText("Ключ RapidAPI");
    expect(input instanceof HTMLInputElement ? input.value : null).toBe("");
    expect(focusedLabel()).toContain("input");
    fireEvent.click(button("Отменить замену ключа RapidAPI"));
    expect(within(card()).getByDisplayValue("••••••••7c1e")).toBeDefined();
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

describe("the quota: «отправлено N из 30 за 31 день»", () => {
  test("in the plan's words, with the figure, the bar and when the next request frees", async () => {
    await openMusic();
    const row = rowOf("Запросы flashapi");
    // getByText normalises whitespace, a no-break space included.
    expect(within(row).getByText(/^отправлено 12 из 30 за 31\sдень/)).toBeDefined();
    expect(row.textContent).toContain("12 из 30");
    expect(row.textContent).toMatch(/следующий освободится \d+ \S+/);
    expect(row.textContent).toContain("считаются и запросы с ошибкой");
    const bar = within(row).getByRole("progressbar");
    expect(bar.getAttribute("aria-valuenow")).toBe("12");
    expect(bar.getAttribute("aria-valuemax")).toBe("30");
    expect(bar.getAttribute("aria-valuetext")).toBe(`отправлено 12 из 30 за 31${NBSP}день`);
  });

  test.each([
    [12, "bar-accent"],
    [28, "bar-warn"],
    [30, "bar-danger"],
  ])("%i sent: %s", async (count, tone) => {
    await openMusic({ music: { sendsDaysAgo: days(count) } });
    expect(within(rowOf("Запросы flashapi")).getByRole("progressbar").className).toContain(tone);
  });
});

describe("«Обновить» confirms before it spends", () => {
  test("the list's age: manual only, when, how many tracks, how much disk", async () => {
    await openMusic();
    expect(rowOf("Тренды Instagram").textContent).toMatch(new RegExp(`только вручную · обновлено 21${NBSP}сент\\., \\d\\d:02 · 30${NBSP}треков${NBSP}·${NBSP}94${NBSP}МБ`));
  });

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

  test("Escape cancels too", async () => {
    const { engine } = await openMusic();
    fireEvent.click(button("Обновить · 1 запрос"));
    fireEvent.keyDown(button("Отмена"), { key: "Escape" });
    expect(queryButton("Отмена")).toBeNull();
    expect(callsOf(engine, "music.refresh")).toHaveLength(0);
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

  test("while it runs the button waits and the row shows how far it is; at the end the list's age is new", async () => {
    const { engine, scheduler } = await openMusic();
    fireEvent.click(button("Обновить · 1 запрос"));
    fireEvent.click(button("Обновить · 1 запрос"));
    await flush();
    expect(button(/Обновляется/).hasAttribute("disabled")).toBe(true);
    expect(rowOf("Тренды Instagram").textContent).toMatch(/обновляется · \d+ %/);
    expect(rowOf("Запросы flashapi").textContent).toContain("отправлено 13 из 30");
    runAll(scheduler);
    await flush();
    expect(rowOf("Тренды Instagram").textContent).not.toContain("21 сент.");
    expect(button("Обновить · 1 запрос").hasAttribute("disabled")).toBe(false);
    expect(callsOf(engine, "music.refresh")).toHaveLength(1);
  });

  test("a refresh that fails says its cause, and the button is offered again", async () => {
    const { engine, scheduler } = await openMusic();
    engine.failNextMusicRefresh({ code: "MUSIC_UNAVAILABLE", musicReason: "network", detail: "the request failed" });
    fireEvent.click(button("Обновить · 1 запрос"));
    fireEvent.click(button("Обновить · 1 запрос"));
    await flush();
    runAll(scheduler);
    await flush();
    expect(within(rowOf("Тренды Instagram")).getByRole("alert").textContent).toBe(MUSIC_UNAVAILABLE_REASONS_RU.network);
    expect(button("Обновить · 1 запрос").hasAttribute("disabled")).toBe(false);
  });

  test("a stopped download run says the rest comes at the next start, not that the list is unavailable", async () => {
    const { engine, scheduler } = await openMusic();
    engine.failNextMusicRefresh({ code: "MUSIC_UNAVAILABLE", musicReason: "downloads-stopped", detail: "the CDN refused the 2 sampled downloads (status-403)" });
    fireEvent.click(button("Обновить · 1 запрос"));
    fireEvent.click(button("Обновить · 1 запрос"));
    await flush();
    runAll(scheduler);
    await flush();
    const text = rowOf("Тренды Instagram").textContent ?? "";
    expect(text).toMatch(/оставшиеся треки будут докачаны при следующем запуске/);
    expect(text).not.toMatch(/недоступ/);
  });

  test("a refusal at the click says why, and the confirmation closes", async () => {
    const { engine } = await openMusic();
    fireEvent.click(button("Обновить · 1 запрос"));
    act(() => engine.setMusicQuotaLog("held"));
    fireEvent.click(button("Обновить · 1 запрос"));
    await flush();
    expect(within(card()).getByText(MUSIC_UNAVAILABLE_REASONS_RU["log-held"])).toBeDefined();
    expect(queryButton("Отмена")).toBeNull();
  });

  test("an IN_FLIGHT refusal is a refresh already running, not paid requests", async () => {
    const { engine } = await openMusic();
    engine.failNext("music.refresh", { code: "IN_FLIGHT" });
    fireEvent.click(button("Обновить · 1 запрос"));
    fireEvent.click(button("Обновить · 1 запрос"));
    await flush();
    expect(within(card()).getByText("Обновление уже идёт: второй запрос не отправлен.")).toBeDefined();
  });

  test("near the limit the button says how many are left, and the 30th says it is the last", async () => {
    await openMusic({ music: { sendsDaysAgo: days(28) } });
    expect(button("Обновить · 1 из 2 оставшихся")).toBeDefined();
  });

  test("29 sent: the last request, «останется 0 из 30»", async () => {
    const { engine } = await openMusic({ music: { sendsDaysAgo: days(29) } });
    fireEvent.click(button("Обновить · последний запрос"));
    expect(rowOf("Тренды Instagram").textContent).toContain("останется 0 из 30");
    fireEvent.click(button("Обновить · последний запрос"));
    await flush();
    expect(callsOf(engine, "music.refresh")).toHaveLength(1);
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

  test("flashapi's own 0: closed although the local count is low", async () => {
    await openMusic({ music: { sendsDaysAgo: [1], serverRemaining: { value: 0, daysAgo: 1 } } });
    closed();
    expect(rowOf("Тренды Instagram").textContent).toMatch(/flashapi ответил, что запросов не осталось/);
  });

  test("no key (also a key file that could not be read: it reads as no key): closed, pointing at the key", async () => {
    await openMusic({ musicKey: NO_KEY });
    closed();
    expect(rowOf("Тренды Instagram").textContent).toContain("Сначала добавьте ключ RapidAPI");
  });

  test("a rejected key: closed, pointing at the key", async () => {
    await openMusic({ musicKey: { ...KEY, rejected: true } });
    closed();
    expect(rowOf("Тренды Instagram").textContent).toContain("замените его");
  });

  test("a held log line: closed, with a warning that names the disk", async () => {
    await openMusic({ music: { ...TWELVE, quotaLog: "held" } });
    closed();
    expect(within(card()).getByText("Ответ сервиса ещё не записан в журнал")).toBeDefined();
  });

  // Review round 1 (HIGH): «Обновить» is closed while a line is held, so the card must not promise «the next refresh» writes
  // it: asking the status does (free), when the card opens and by «Проверить снова».
  test("a held log line says it is written when the card is opened again, and «Проверить снова» asks at once, sending nothing", async () => {
    const { engine } = await openMusic({ music: { ...TWELVE, quotaLog: "held" } });
    expect(card().textContent).toContain("запись повторится, когда вы снова откроете эту карточку");
    expect(card().textContent).not.toContain("при следующем обновлении");
    const before = callsOf(engine, "music.status").length;
    act(() => engine.setMusicQuotaLog("ok"));
    fireEvent.click(button("Проверить снова"));
    await flush();
    expect(callsOf(engine, "music.status").length).toBe(before + 1);
    expect(within(card()).queryByText("Ответ сервиса ещё не записан в журнал")).toBeNull();
    expect(button("Обновить · 1 запрос").hasAttribute("disabled")).toBe(false);
    expect(callsOf(engine, "music.refresh")).toHaveLength(0);
  });

  test("an unreadable log: closed, and nothing to recover", async () => {
    await openMusic({ music: { ...TWELVE, quotaLog: "unreadable" } });
    closed();
    expect(within(card()).getByText("Журнал запросов не читается")).toBeDefined();
    expect(queryButton(/Восстановить/)).toBeNull();
  });
});

describe("a damaged quota log", () => {
  test("reads 30 of 30, closes «Обновить», and offers the recovery with what it costs", async () => {
    await openMusic({ music: { ...TWELVE, quotaLog: "corrupt" } });
    expect(rowOf("Запросы flashapi").textContent).toContain("отправлено 30 из 30");
    closedRefresh();
    expect(within(card()).getByText("Журнал запросов повреждён")).toBeDefined();
    expect(button("Восстановить журнал…")).toBeDefined();
  });

  test("the first click sends nothing: it asks, naming the day the quota reopens", async () => {
    const { engine } = await openMusic({ music: { ...TWELVE, quotaLog: "corrupt" } });
    fireEvent.click(button("Восстановить журнал…"));
    expect(callsOf(engine, "music.recoverQuotaLog")).toHaveLength(0);
    expect(card().textContent).toMatch(/квота закроется до \d+ \S+: Studio посчитает, что за 31 день ушли все 30 запросов\. Ничего не отправится\./);
    expect(focusedLabel()).toContain("Отмена");
    fireEvent.click(button("Отмена"));
    expect(callsOf(engine, "music.recoverQuotaLog")).toHaveLength(0);
  });

  test("the confirmation sends ONE music.recoverQuotaLog {confirm: true}; then the quota reads closed, with its date", async () => {
    const { engine } = await openMusic({ music: { ...TWELVE, quotaLog: "corrupt" } });
    fireEvent.click(button("Восстановить журнал…"));
    const confirm = button("Восстановить и закрыть на 31 день");
    fireEvent.click(confirm);
    fireEvent.click(confirm);
    await flush();
    expect(callsOf(engine, "music.recoverQuotaLog").map((c) => c.payload)).toEqual([{ confirm: true }]);
    expect(within(card()).queryByText("Журнал запросов повреждён")).toBeNull();
    expect(rowOf("Тренды Instagram").textContent).toMatch(/Квота кончилась: следующий запрос — \d+ \S+/);
    expect(callsOf(engine, "music.refresh")).toHaveLength(0);
  });
});

/** «Обновить» is there and disabled. */
function closedRefresh(): void {
  expect(within(rowOf("Тренды Instagram")).getByRole("button", { name: /^Обновить/ }).hasAttribute("disabled")).toBe(true);
}

describe("a music error elsewhere (the editor's music tab, 3d.5) points at the card", () => {
  test("the notice offers «Открыть музыку в Настройках», which goes to Settings with the music card as its focus", () => {
    const visited: unknown[] = [];
    render(
      <NavigationProvider value={createNavigation((route) => void visited.push(route))}>
        <ErrorNotice error={{ code: "MUSIC_KEY_MISSING" }} />
      </NavigationProvider>,
    );
    fireEvent.click(screen.getByRole("button", { name: "Открыть музыку в Настройках" }));
    expect(visited).toEqual([{ name: "settings", focus: "music" }]);
  });

  test("Settings opened with that focus lands on the «Музыка · flashapi» card", async () => {
    const engine = new MockEngine({ scheduler: new ManualScheduler() });
    render(
      <EngineProvider client={mockEngineClient(engine)}>
        <SettingsScreen focus="music" />
      </EngineProvider>,
    );
    await flush();
    expect(focusedLabel()).toBe(describeElement(await screen.findByRole("heading", { level: 2, name: "Музыка · flashapi" })));
  });
});
