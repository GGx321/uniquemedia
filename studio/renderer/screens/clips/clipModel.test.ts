import { describe, expect, test } from "bun:test";
import type { ClipCost, ClipFailReason, ClipFace, ClipSummary, Estimate } from "../../../shared/engine";
import {
  clipLength,
  costFact,
  faceBadge,
  faceFact,
  failedTile,
  modelFact,
  phaseLine,
  queuePhase,
  readyMeta,
  whenLabel,
  type FailAction,
  type FailedTileModel,
  type PhaseContext,
} from "./clipModel";

// Stage 5, 5b.1, S5.V8 (plan s5b1 §5.7 «Tiles», §6 states 40–43 and 46; README §S5.VD / §S5.VD2): every word a clip's tile, its viewer and its queue row say, from the
// engine's summary and job alone. The figures are the engine's (`ClipCost`, `grokOffer`, `providerCostMicros`): the model only picks and formats them, a maximum rounded up.

const AVATAR = "avatar-nini-0001";
// Local wall-clock times, so «сегодня, 14:06» reads the same in every time zone the suite runs in.
const NOW = new Date(2026, 9, 11, 14, 30, 0).getTime();

const common = {
  clipId: "clip-00000001",
  avatarId: AVATAR,
  photoId: "photo-nini-0007",
  createdAt: new Date(2026, 9, 11, 14, 6, 0).toISOString(),
  seen: false,
  motion: { source: "code" as const, label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" },
  request: { model: "kling" as const, quality: "std" as const, seconds: 5 as const, fallback: "auto" as const },
  model: "kling-std" as const,
  fallback: false,
  recovered: false,
  cost: { micros: 420_000, kind: "billed" } as ClipCost,
  exports: [],
};

type Ready = Extract<ClipSummary, { status: "ready" }>;
type Failed = Extract<ClipSummary, { status: "failed" }>;

const ready = (over: Partial<Ready> = {}): Ready => ({ ...common, status: "ready", width: 720, height: 1280, durationMs: 5_000, face: { verdict: "match", p75: 0.71, frames: 11 }, ...over });
const failed = (reason: ClipFailReason, cost: ClipCost, over: Partial<Failed> = {}): Failed => ({ ...common, status: "failed", cost, failure: { reason }, ...over });

const FREE: ClipCost = { micros: 0, kind: "free" };
const PAID: ClipCost = { micros: 420_000, kind: "billed" };
const WORST: ClipCost = { micros: 504_000, kind: "estimated" };
const OPEN: ClipCost = { micros: 504_000, kind: "open" };
const GROK_OFFER: Estimate = { expectedMicros: 710_000, worstMicros: 850_000, prices: "live", pricesAsOf: "2026-10-10" };

const ctx = { nowMs: NOW, bold: false };

describe("a failed tile (§6 42, the tone by the money)", () => {
  const cases: [string, Failed, { text: string; tone: FailedTileModel["tone"]; money: string | null; actions: FailAction[] }][] = [
    ["42a Kling and Grok refused free", failed("refused-both", FREE), { text: "Kling и Grok отказали — бесплатно", tone: "free", money: null, actions: ["again"] }],
    ["42b a refusal after the generation", failed("refused-paid", PAID), { text: "Отказ модели после генерации — оплачено $0.42", tone: "paid", money: null, actions: ["again"] }],
    ["42c a refusal whose cost could not be read", failed("refused-unknown", WORST), { text: "Отказ модели — стоимость не прочитана, списано по максимуму $0.51", tone: "paid", money: null, actions: [] }],
    ["42d an uncertain submit", failed("submit-uncertain", OPEN), { text: "Неизвестно, оплачено ли — сверка покажет", tone: "open", money: "до $0.51 — спишется при сверке", actions: [] }],
    ["42d after the reconcile", failed("submit-uncertain", WORST), { text: "Неизвестно, оплачено ли — сверка покажет", tone: "paid", money: "списано по максимуму $0.51", actions: [] }],
    ["42e never came", failed("late", OPEN), { text: "Клип так и не пришёл — сверка спишет его по максимуму", tone: "open", money: "до $0.51 — спишется при сверке", actions: [] }],
    ["42i no credits", failed("no-credits", FREE), { text: "Не хватает средств на OpenRouter", tone: "free", money: "бесплатно", actions: [] }],
    ["42i the key refused", failed("key-invalid", FREE), { text: "Ключ OpenRouter не принят", tone: "free", money: "бесплатно", actions: [] }],
    ["42j rate-limited", failed("rate-limited", FREE), { text: "OpenRouter занят — бесплатно. Попробуйте через минуту.", tone: "free", money: null, actions: ["again"] }],
    ["42k a bad request", failed("bad-request", FREE), { text: "OpenRouter не принял запрос — бесплатно", tone: "free", money: null, actions: ["again"] }],
    ["42l a provider error, free", failed("provider-error", FREE), { text: "Kling не снял клип — бесплатно", tone: "free", money: null, actions: ["again"] }],
    ["42l′ a provider error, billed", failed("provider-error", PAID), { text: "Kling не снял клип — оплачено $0.42", tone: "paid", money: null, actions: [] }],
    ["42l′ a provider error at the worst", failed("provider-error", WORST), { text: "Kling не снял клип — стоимость не прочитана, списано по максимуму $0.51", tone: "paid", money: null, actions: [] }],
    ["42m no room for Grok", failed("grok-no-room", FREE), { text: "Kling отказал бесплатно, а на Grok не хватило месячного бюджета", tone: "free", money: null, actions: ["again"] }],
    ["42p refused free without the fallback", failed("refused-free", FREE, { request: { ...common.request, fallback: "none" } }), { text: "Kling отказал бесплатно", tone: "free", money: null, actions: ["again"] }],
    ["42r a Grok clip refused free", failed("refused-free", FREE, { model: "grok", request: { ...common.request, model: "grok", fallback: "none" } }), { text: "Grok отказал бесплатно", tone: "free", money: null, actions: ["again"] }],
    ["42o the file is gone at OpenRouter", failed("download-expired", PAID), { text: "Файл у OpenRouter больше недоступен — оплачено $0.42", tone: "paid", money: null, actions: [] }],
    ["46 lost", failed("lost", OPEN), { text: "Клип не дошёл до OpenRouter или потерян — сверка спишет его по максимуму", tone: "open", money: "до $0.51 — спишется при сверке", actions: [] }],
  ];
  for (const [name, clip, want] of cases) {
    test(name, () => {
      const tile = failedTile(clip, ctx);
      expect({ text: tile.text, tone: tile.tone, money: tile.money, actions: tile.actions }).toEqual(want);
    });
  }

  test("42q: a frame of «Смелая» refused free says there is no fallback for it, and «Оживить снова…» opens its own sheet", () => {
    const tile = failedTile(failed("refused-free", FREE, { request: { ...common.request, fallback: "none" } }), { nowMs: NOW, bold: true });
    expect(tile.text).toBe("Kling отказал бесплатно — для кадров «Смелой» запасной модели нет");
    expect(tile.actions).toEqual(["again"]);
  });

  test("mode auto, a fallback allowed, and still «refused free»: Grok was never reserved because paid work had stopped (RECONCILE_REQUIRED, a halt) — the tile says so", () => {
    const blocked = failedTile(failed("refused-free", FREE), { nowMs: NOW, bold: false, mode: "auto" });
    expect(blocked.text).toBe("Kling отказал бесплатно, а Grok не запущен: платные запросы были остановлены");
    expect(blocked.actions).toEqual(["again"]);
    // In mode offer the same end is the offer's (42n, or 42p without a fallback); a frame of «Смелая» has none (42q).
    expect(failedTile(failed("refused-free", FREE), { nowMs: NOW, bold: false, mode: "offer" }).text).toBe("Kling отказал бесплатно");
    expect(failedTile(failed("refused-free", FREE), { nowMs: NOW, bold: true, mode: "auto" }).text).toBe("Kling отказал бесплатно — для кадров «Смелой» запасной модели нет");
  });

  test("42n: mode offer, refused free: «Снять на Grok · до $0.85» at the engine's own price, never «Оживить снова…»", () => {
    const tile = failedTile(failed("refused-free", FREE, { failure: { reason: "refused-free", grokOffer: GROK_OFFER } }), ctx);
    expect(tile.text).toBe("Kling отказал бесплатно");
    expect(tile.actions).toEqual(["grok"]);
    expect(tile.grokWorst).toBe("$0.85");
  });

  test("42f, 42f′, 42g: a paid file that did not land offers «Скачать снова · до HH:MM» until its deadline", () => {
    const until = new Date(NOW + 36 * 60_000).toISOString();
    const local = new Date(NOW + 36 * 60_000);
    const hhmm = `${String(local.getHours()).padStart(2, "0")}:${String(local.getMinutes()).padStart(2, "0")}`;
    const f = failedTile(failed("download-failed", PAID, { retryDownloadUntil: until }), ctx);
    expect([f.text, f.money, f.actions, f.retryUntil]).toEqual(["Файл клипа не скачался — оплачено $0.42", null, ["redownload"], hhmm]);
    const broken = failedTile(failed("invalid-file", PAID, { retryDownloadUntil: until }), ctx);
    expect([broken.text, broken.actions]).toEqual(["Файл клипа повреждён — оплачено $0.42", ["redownload"]]);
    const full = failedTile(failed("disk-full", PAID, { retryDownloadUntil: until }), ctx);
    expect([full.text, full.money, full.actions, full.tone]).toEqual(["Нет места на диске — клип оплачен", "$0.42", ["redownload"], "paid"]);
  });

  test("past `retryDownloadUntil` the button hides and the tile reads as 42o (the file is gone at OpenRouter)", () => {
    const until = new Date(NOW - 1).toISOString();
    const tile = failedTile(failed("download-failed", PAID, { retryDownloadUntil: until }), ctx);
    expect(tile.text).toBe("Файл у OpenRouter больше недоступен — оплачено $0.42");
    expect(tile.actions).toEqual([]);
  });

  test("a charge still open on a tile whose text names no money reads «… — спишется при сверке»", () => {
    expect(failedTile(failed("refused-unknown", OPEN), ctx).money).toBe("до $0.51 — спишется при сверке");
  });
});

describe("a ready tile (§6 41, 46)", () => {
  test("41: a new Kling clip — its length, «новый», the face, the billed cost and when", () => {
    expect(readyMeta(ready(), NOW)).toEqual({ line: null, meta: `$0.42 · ${whenLabel(common.createdAt, NOW)}` });
    expect(whenLabel(common.createdAt, NOW)).toBe("сегодня, 14:06");
    expect(clipLength(5_000)).toBe("0:05");
    expect(clipLength(10_000)).toBe("0:10");
  });

  test("46 #recovered: «до сверки» with the provider's own figure, then «списано по максимуму» after the reconcile (the maximum rounded up)", () => {
    expect(readyMeta(ready({ recovered: true, cost: OPEN, providerCostMicros: 420_000 }), NOW).line).toBe("Клип восстановлен после перезапуска · до сверки: $0.51 (OpenRouter: $0.42)");
    expect(readyMeta(ready({ recovered: true, cost: WORST, providerCostMicros: 420_000 }), NOW).line).toBe("Клип восстановлен после перезапуска · списано по максимуму $0.51 (OpenRouter: $0.42)");
  });

  test("a late arrival: «Клип пришёл с опозданием · до сверки: $0.51 (OpenRouter: $0.42)», then «… · списано по максимуму $0.51 (OpenRouter: $0.42)»", () => {
    expect(readyMeta(ready({ cost: OPEN, providerCostMicros: 420_000 }), NOW).line).toBe("Клип пришёл с опозданием · до сверки: $0.51 (OpenRouter: $0.42)");
    expect(readyMeta(ready({ cost: WORST, providerCostMicros: 420_000 }), NOW).line).toBe("Клип пришёл с опозданием · списано по максимуму $0.51 (OpenRouter: $0.42)");
  });

  test("the face badges: «лицо 0.71», «Лицо не совпало · 0.48», «лицо не проверялось»", () => {
    expect(faceBadge({ verdict: "match", p75: 0.71, frames: 11 })).toEqual({ kind: "ok", text: "лицо 0.71" });
    expect(faceBadge({ verdict: "mismatch", p75: 0.48, frames: 11 })).toEqual({ kind: "low", text: "Лицо не совпало · 0.48" });
    expect(faceBadge({ verdict: "skipped", frames: 0, why: "hidden" })).toEqual({ kind: "none", text: "лицо не проверялось" });
  });

  test("when: today, yesterday, an older day", () => {
    const today = new Date(NOW);
    today.setHours(14, 6, 0, 0);
    const yesterday = new Date(today.getTime() - 24 * 3_600_000);
    yesterday.setHours(19, 12, 0, 0);
    expect(whenLabel(today.toISOString(), today.getTime() + 60_000)).toBe("сегодня, 14:06");
    expect(whenLabel(yesterday.toISOString(), today.getTime())).toBe("вчера, 19:12");
    expect(whenLabel(new Date(today.getTime() - 5 * 24 * 3_600_000).toISOString(), today.getTime())).toMatch(/^\d{1,2} [а-я]+\.?, \d\d:\d\d$/);
  });
});

describe("the clip viewer's facts (§6 43)", () => {
  test("the model, by what made the file: Kling's 720p and 1080p (the approved 38's label), Grok as the fallback or as the offer's clip", () => {
    expect(modelFact(ready())).toBe("Kling 3.0 · 720p · 5 с");
    expect(modelFact(ready({ model: "kling-pro", width: 1080, height: 1920 }))).toBe("Kling 3.0 · 1080p · 5 с");
    expect(modelFact(ready({ model: "grok", fallback: true }))).toBe("Grok 1.5 · 720p · 5 с — запасная модель");
    expect(modelFact(ready({ model: "grok", request: { ...common.request, model: "grok", fallback: "none" } }))).toBe("Grok 1.5 · 720p · 5 с");
    expect(modelFact(ready({ durationMs: 10_000, request: { ...common.request, seconds: 10 } }))).toBe("Kling 3.0 · 720p · 10 с");
    // A pro request that came back 720p is badged by the real file (I5.54).
    expect(modelFact(ready({ model: "kling-pro", width: 720, height: 1280 }))).toBe("Kling 3.0 · 720p · 5 с");
  });

  test("the cost: billed to the nearest cent; a maximum rounded up, «при сверке» when the reconcile closed it, the provider's figure in brackets", () => {
    expect(costFact(ready())).toBe("$0.42");
    expect(costFact(ready({ recovered: true, cost: WORST, providerCostMicros: 420_000 }))).toBe("$0.51 — списано по максимуму при сверке (OpenRouter: $0.42)");
    expect(costFact(ready({ cost: WORST }))).toBe("$0.51 — списано по максимуму");
    expect(costFact(ready({ cost: OPEN, providerCostMicros: 420_000 }))).toBe("до $0.51 — спишется при сверке (OpenRouter: $0.42)");
  });

  test("the face, each verdict and each reason it was not checked", () => {
    const fact = (face: ClipFace) => faceFact(face);
    expect(fact({ verdict: "match", p75: 0.71, frames: 11 })).toEqual({ tone: "ok", value: "0.71", text: "(по 11 кадрам)" });
    expect(fact({ verdict: "mismatch", p75: 0.48, frames: 11 })).toEqual({ tone: "warn", value: null, text: "не совпало: 0.48 — клип оставлен, решать вам" });
    expect(fact({ verdict: "skipped", frames: 0, why: "hidden" })).toEqual({ tone: "quiet", value: null, text: "не проверялось: лицо скрыто в кадре" });
    expect(fact({ verdict: "skipped", frames: 0, why: "profile" })).toEqual({ tone: "quiet", value: null, text: "не проверялось: лицо в профиль" });
    expect(fact({ verdict: "skipped", frames: 2, why: "few-faces" })).toEqual({ tone: "quiet", value: null, text: "не проверялось: мало кадров с лицом" });
    expect(fact({ verdict: "skipped", frames: 0, why: "worker" }).text).toBe("не проверялось");
  });
});

describe("a clip at work: its tile's phase (§6 40) and its queue row (README S5.VD decision 10)", () => {
  const submitted = new Date(NOW - 80_000).toISOString();
  const base: PhaseContext = { nowMs: NOW, seenMs: NOW - 80_000, lateUntilMs: null, grokOffer: false };
  const line = (phase: Parameters<typeof phaseLine>[0]["phase"], over: Partial<Parameters<typeof phaseLine>[0]> = {}, c: Partial<typeof base> = {}) => phaseLine({ phase, ...over }, { ...base, ...c });

  test("each phase verbatim, its tone and its pill", () => {
    expect(line("preparing")).toEqual({ text: "Готовим кадр", tone: "work", pill: "в работе", cancel: true });
    expect(line("submitting", { model: "kling" })).toEqual({ text: "Отправляем в Kling", tone: "work", pill: "в работе", cancel: false });
    expect(line("rendering", { model: "kling", submittedAt: submitted }).text).toBe("Снимается · 1:20");
    expect(line("proving", { model: "kling" }).text).toBe("Kling отказал — проверяем, что бесплатно · до 2 мин");
    expect(line("rendering", { model: "grok", submittedAt: new Date(NOW - 40_000).toISOString() }).text).toBe("Kling отказал бесплатно — снимает Grok · 0:40");
    expect(line("submitting", { model: "grok" }).text).toBe("Kling отказал бесплатно — снимает Grok");
    expect(line("downloading").text).toBe("Скачивается");
    expect(line("checking").text).toBe("Проверяем лицо");
    expect(line("saving").text).toBe("Сохраняем");
    expect(line("recovering")).toEqual({ text: "Восстанавливаем после перезапуска", tone: "quiet", pill: "после перезапуска", cancel: false });
  });

  test("the offer's Grok clip is sent to Grok, not «снимает Grok» behind a refusal", () => {
    expect(line("submitting", { model: "grok" }, { grokOffer: true }).text).toBe("Отправляем в Grok");
    expect(line("rendering", { model: "grok", submittedAt: new Date(NOW - 40_000).toISOString() }, { grokOffer: true }).text).toBe("Снимается · 0:40");
  });

  test("late: «Задерживается. Клип ещё может прийти до HH:MM — потом понадобится сверка расходов.», in the warning's tone", () => {
    const until = new Date(NOW + 30 * 60_000);
    const hhmm = `${String(until.getHours()).padStart(2, "0")}:${String(until.getMinutes()).padStart(2, "0")}`;
    expect(line("late", { model: "kling" }, { lateUntilMs: until.getTime() })).toEqual({
      text: `Задерживается. Клип ещё может прийти до ${hhmm} — потом понадобится сверка расходов.`,
      tone: "warn",
      pill: "задерживается",
      cancel: false,
    });
  });

  test("a submit time far from this window's clock (another machine's, or the demo engine's) counts from when the window first saw it", () => {
    expect(line("rendering", { model: "kling", submittedAt: "2026-09-24T10:00:00.000Z" }, { seenMs: NOW - 5_000 }).text).toBe("Снимается · 0:05");
  });

  test("the queue row's short phases, the export's with its percent (VD2's «Клип · Nini · Сохраняем 40 %»)", () => {
    const q = (phase: Parameters<typeof queuePhase>[0]["phase"], over: Partial<Parameters<typeof queuePhase>[0]> = {}) => queuePhase({ phase, done: 0, total: 4, ...over }, base);
    expect(q("preparing")).toEqual({ text: "Готовим кадр", warn: false });
    expect(q("submitting", { model: "kling" }).text).toBe("Отправляем");
    expect(q("rendering", { model: "kling", submittedAt: submitted }).text).toBe("Снимается 1:20");
    expect(q("rendering", { model: "grok", submittedAt: new Date(NOW - 40_000).toISOString() }).text).toBe("Grok · 0:40");
    expect(q("proving").text).toBe("Проверка отказа");
    expect(q("late")).toEqual({ text: "Задерживается", warn: true });
    expect(q("downloading").text).toBe("Скачивается");
    expect(q("checking").text).toBe("Проверка лица");
    expect(q("saving").text).toBe("Сохраняем");
    expect(q("recovering").text).toBe("Восстановление");
    expect(q("exporting", { done: 60, total: 150 }).text).toBe("Сохраняем 40\u00a0%");
  });
});
