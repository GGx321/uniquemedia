import { describe, expect, test } from "bun:test";
import { MUSIC_UNAVAILABLE_REASONS_RU, type MusicKeyStatus, type MusicStatus } from "../../shared/engine";
import { NBSP } from "./format";
import { listLine, musicFailureText, quotaView, recoveryText, refreshGate, refreshLabel, refusalText } from "./music";

// 3c.6: what the Settings «Музыка» card says and allows, from the key's state and the music status alone. The gate is the
// money side of the card: «Обновить» spends one of 30 requests per 31 days, so it is offered only when the engine would let
// one leave, and only after a confirmation that says what it costs.

const UTC = "UTC";
const NOW = Date.UTC(2026, 8, 24, 10, 0, 0);
const DAY = 24 * 3600 * 1000;
const KEY: MusicKeyStatus = { stored: true, last4: "7c1e", rejected: false };
const IDLE: MusicStatus = {
  listFetchedAt: "2026-09-21T11:02:00.000Z",
  trackCount: 30,
  bytesOnDisk: 94_000_000,
  sentLast31d: 12,
  limit: 30,
  serverRemaining: 18,
  nextFreeAt: "2026-10-03T10:00:00.000Z",
  refresh: { state: "idle" },
  quotaLog: "ok",
};
const sent = (n: number, patch: Partial<MusicStatus> = {}): MusicStatus => ({ ...IDLE, sentLast31d: n, serverRemaining: null, ...patch });

describe("quotaView: «отправлено N из 30 за 31 день»", () => {
  test("says the count in the plan's words, with the bar's share", () => {
    const view = quotaView(IDLE, UTC);
    expect(view.line).toBe(`отправлено 12 из 30 за 31${NBSP}день`);
    expect(view.figure).toEqual({ sent: 12, limit: 30 });
    expect(view.share).toBe(40);
    expect(view.tone).toBe("accent");
  });

  test("names when the oldest send leaves the window, in the rolling window's words (never «в этом месяце»)", () => {
    expect(quotaView(IDLE, UTC).nextFree).toBe(`следующий освободится 3${NBSP}окт.`);
  });

  test("with nothing sent there is nothing to free", () => {
    expect(quotaView(sent(0, { nextFreeAt: null }), UTC).nextFree).toBeNull();
  });

  test.each([
    [0, "accent"],
    [27, "accent"],
    [28, "warn"],
    [29, "warn"],
    [30, "danger"],
  ] as const)("%i sent reads %s", (count, tone) => {
    expect(quotaView(sent(count), UTC).tone).toBe(tone);
  });

  test("the server's 0 is exhausted whatever the local count", () => {
    expect(quotaView(sent(3, { serverRemaining: 0 }), UTC).tone).toBe("danger");
  });

  test.each(["corrupt", "unreadable"] as const)("a %s log reads 30 of 30, in the danger tone, and names no date", (quotaLog) => {
    const view = quotaView(sent(30, { quotaLog, nextFreeAt: null }), UTC);
    expect(view).toMatchObject({ tone: "danger", share: 100, nextFree: null });
  });

  test("shows flashapi's own figure only when it is lower than the local room", () => {
    expect(quotaView({ ...IDLE, serverRemaining: 18 }, UTC).server).toBeNull();
    expect(quotaView({ ...IDLE, serverRemaining: 5 }, UTC).server).toBe("по последнему ответу flashapi осталось 5");
  });
});

describe("refreshGate: «Обновить» is offered only when a request would leave", () => {
  test("before the status is known: loading", () => {
    expect(refreshGate(KEY, null, NOW, UTC)).toEqual({ kind: "loading" });
  });

  test("ready, with the confirmation that says what it costs: 1 request, what is left, when the next frees, and that an error counts", () => {
    const gate = refreshGate(KEY, IDLE, NOW, UTC);
    expect(gate.kind).toBe("ready");
    if (gate.kind !== "ready") return;
    expect(gate.confirm).toBe(`Спишется 1 запрос — останется 17 из 30; следующий освободится 3${NBSP}окт. Ошибка тоже считается, повторов нет.`);
  });

  test("the 30th request: «останется 0 из 30»", () => {
    const gate = refreshGate(KEY, sent(29), NOW, UTC);
    expect(gate.kind === "ready" ? gate.confirm : "").toContain("останется 0 из 30");
  });

  test("with nothing in the window the request frees its own slot 31 days from now", () => {
    const gate = refreshGate(KEY, sent(0, { nextFreeAt: null }), NOW, UTC);
    expect(gate.kind === "ready" ? gate.confirm : "").toContain(`следующий освободится 25${NBSP}окт.`);
  });

  test("warns when flashapi's own figure says less is left than the local count", () => {
    const gate = refreshGate(KEY, { ...IDLE, serverRemaining: 3 }, NOW, UTC);
    expect(gate.kind === "ready" ? gate.confirm : "").toContain("По последнему ответу flashapi останется 2.");
  });

  test.each([30, 31])("%i sent: blocked, naming the date, never ready", (count) => {
    const gate = refreshGate(KEY, sent(Math.min(count, 30)), NOW, UTC);
    expect(gate).toEqual({ kind: "blocked", reason: `Квота кончилась: следующий запрос — 3${NBSP}окт. Список остаётся прежним.`, fix: null });
  });

  test("the server's 0: blocked with flashapi's own words", () => {
    expect(refreshGate(KEY, sent(4, { serverRemaining: 0 }), NOW, UTC)).toEqual({
      kind: "blocked",
      reason: `flashapi ответил, что запросов не осталось: следующий — 3${NBSP}окт. Список остаётся прежним.`,
      fix: null,
    });
  });

  test("no key: blocked, pointing at the key", () => {
    expect(refreshGate({ stored: false, last4: null, rejected: false }, IDLE, NOW, UTC)).toMatchObject({ kind: "blocked", fix: "key" });
  });

  test("a rejected key: blocked, pointing at the key, before the quota is even looked at", () => {
    const gate = refreshGate({ ...KEY, rejected: true }, sent(30), NOW, UTC);
    expect(gate).toMatchObject({ kind: "blocked", fix: "key" });
    expect(gate.kind === "blocked" ? gate.reason : "").toMatch(/отклонил ключ/);
  });

  test("a corrupt log: blocked, pointing at its recovery", () => {
    expect(refreshGate(KEY, sent(30, { quotaLog: "corrupt", nextFreeAt: null }), NOW, UTC)).toMatchObject({ kind: "blocked", fix: "recover" });
  });

  test("a held log says the line is written when the card is opened again, never «at the next refresh» (which is closed)", () => {
    const gate = refreshGate(KEY, sent(4, { quotaLog: "held" }), NOW, UTC);
    expect(gate.kind === "blocked" ? gate.reason : "").toContain("когда вы снова откроете эту карточку");
  });

  test.each(["unreadable", "held"] as const)("a %s log: blocked, with nothing to click", (quotaLog) => {
    const gate = refreshGate(KEY, sent(quotaLog === "held" ? 4 : 30, { quotaLog }), NOW, UTC);
    expect(gate).toMatchObject({ kind: "blocked", fix: null });
    expect(gate.kind === "blocked" ? gate.reason : "").toMatch(/журнал/i);
  });

  test("a refresh in flight: running, with its share, and nothing to click", () => {
    expect(refreshGate(KEY, { ...IDLE, refresh: { state: "running", done: 31, total: 61 } }, NOW, UTC)).toEqual({ kind: "running", percent: 50 });
    expect(refreshGate(KEY, { ...IDLE, refresh: { state: "running", done: 0, total: 1 } }, NOW, UTC)).toEqual({ kind: "running", percent: 0 });
  });

  test("a failed refresh does not block the next one", () => {
    expect(refreshGate(KEY, { ...IDLE, refresh: { state: "failed", error: { code: "MUSIC_UNAVAILABLE", musicReason: "network" } } }, NOW, UTC).kind).toBe("ready");
  });
});

describe("refreshLabel: what the button spends", () => {
  test.each([
    [12, "Обновить · 1 запрос"],
    [27, "Обновить · 1 запрос"],
    [28, "Обновить · 1 из 2 оставшихся"],
    [29, "Обновить · последний запрос"],
  ])("%i sent: %s", (count, label) => {
    expect(refreshLabel(sent(count))).toBe(label);
  });
});

describe("listLine: the list's age", () => {
  test("manual only, when it was fetched, how many tracks and how much disk", () => {
    expect(listLine(IDLE, "Europe/Kyiv")).toBe(`только вручную · обновлено 21${NBSP}сент., 14:02 · 30${NBSP}треков${NBSP}·${NBSP}94${NBSP}МБ`);
  });

  test("a list never fetched says so", () => {
    expect(listLine({ ...IDLE, listFetchedAt: null, trackCount: 0, bytesOnDisk: 0 }, UTC)).toBe("только вручную · список ещё не загружался");
  });

  test("Russian plurals and a small size with one decimal", () => {
    expect(listLine({ ...IDLE, trackCount: 1, bytesOnDisk: 2_400_000 }, UTC)).toContain(`1${NBSP}трек${NBSP}·${NBSP}2.4${NBSP}МБ`);
    expect(listLine({ ...IDLE, trackCount: 22, bytesOnDisk: 0 }, UTC)).toMatch(new RegExp(`22${NBSP}трека$`));
  });
});

describe("what a failed refresh or a refusal says", () => {
  test("MUSIC_UNAVAILABLE says its cause, not «Попробуйте позже»", () => {
    for (const [musicReason, text] of Object.entries(MUSIC_UNAVAILABLE_REASONS_RU)) {
      const parsed = { code: "MUSIC_UNAVAILABLE" as const, musicReason: musicReason as keyof typeof MUSIC_UNAVAILABLE_REASONS_RU };
      expect(musicFailureText(parsed)).toBe(text);
    }
  });

  test("the breaker's stop says the rest comes at the next start", () => {
    expect(musicFailureText({ code: "MUSIC_UNAVAILABLE", musicReason: "downloads-stopped" })).toMatch(/оставшиеся треки будут докачаны при следующем запуске/);
  });

  test("a 429 with a wait says how long", () => {
    expect(musicFailureText({ code: "MUSIC_UNAVAILABLE", musicReason: "rate-limited", retryAfterMs: 120_000 })).toMatch(/Повторите через 2 мин\.$/);
  });

  test("a refusal at the click: IN_FLIGHT is a refresh already running, not paid requests", () => {
    expect(refusalText({ code: "IN_FLIGHT" })).toBe("Обновление уже идёт: второй запрос не отправлен.");
  });

  test("any other refusal reads like the failure", () => {
    expect(refusalText({ code: "MUSIC_UNAVAILABLE", musicReason: "log-held" })).toBe(MUSIC_UNAVAILABLE_REASONS_RU["log-held"]);
  });
});

describe("recoveryText: what recovering a damaged log costs", () => {
  test("names the exact day the quota reopens: 31 days from now", () => {
    expect(recoveryText(NOW, UTC).confirm).toBe(`Повреждённый журнал отложится в сторону, а квота закроется до 25${NBSP}окт.: Studio посчитает, что за 31${NBSP}день ушли все 30 запросов. Ничего не отправится.`);
  });

  test("31 days from now, at the day boundary", () => {
    expect(recoveryText(Date.UTC(2026, 9, 1, 0, 0, 0), UTC).until).toBe(`1${NBSP}нояб.`);
    expect(recoveryText(NOW + DAY, UTC).until).toBe(`26${NBSP}окт.`);
  });
});
