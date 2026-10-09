import { describe, expect, test } from "bun:test";
import { HOLDS, LOG_SAMPLES, drawingRow, libraryRow as fixtureLibraryRow, logLine, view as baseView } from "../../../shared/engine/autopilot.fixtures";
import { LOG_KINDS, LaunchView, LogLine, PaidHold, type LaunchAvatarView } from "../../../shared/engine";
import {
  askedView,
  avatarLine,
  durationLabel,
  endedLine,
  headerMeta,
  headerSub,
  liveNote,
  logRows,
  logText,
  namesList,
  nextMonthStart,
  resumePlace,
  resumeTitle,
  resumeWhy,
  shownStatus,
  spentBlock,
  stopSetLine,
  stopSetLines,
} from "./liveModel";
import { sidebarMark } from "./planModel";

// S4.9b: the live card's words for every state the design draws (AutopilotS4.dc.html review-wait … paused-reviewed; LaunchStates «Продолжить», «Пока ждём»,
// «Пауза и стоп», «Аватары», «Журнал»). Every fixture is parsed by the contract first, so each is a view the engine could send.

const NBSP = " ";
const A = "avatar-mia-0001";
const B = "avatar-sofia-0002";
const NAMES: Record<string, string> = { [A]: "Mia", [B]: "Sofia" };
const nameOf = (id: string): string => NAMES[id] ?? "Аватар";

/** A launch at $4.14, spent $1.25 by default, Mia montaging library photos and Sofia drawing. */
function launch(over: Record<string, unknown> = {}): LaunchView {
  const spent = typeof over.spentMicros === "number" ? over.spentMicros : 1_250_000;
  return LaunchView.parse({
    ...baseView,
    acceptedMicros: 4_140_000,
    plannedWorstMicros: 4_140_000,
    plannedExpectedMicros: 1_340_000,
    spentMicros: spent,
    remainingMicros: Math.max(0, 4_140_000 - spent),
    avatars: [libraryRow(A), drawingRow(B)],
    ...over,
  });
}
const row = (avatarId: string, over: Partial<LaunchAvatarView>): LaunchAvatarView => ({ ...drawingRow(avatarId), ...over });
/** An avatar of the launch whose videos are all made of library photos: nothing to generate, no set. */
const libraryRow = (avatarId: string): LaunchAvatarView => ({ ...fixtureLibraryRow(avatarId), photos: { done: 0, total: 0 } });
const paused = (cause: "owner" | "quit" | "engine-restart", over: Record<string, unknown> = {}): LaunchView =>
  launch({ status: "paused", paused: { cause, at: "2026-10-08T14:06:00.000Z" }, inFlight: { requests: 0, openMicros: 0 }, ...over });
const hold = (reason: string, over: Record<string, unknown> = {}): PaidHold => PaidHold.parse({ ...(HOLDS[reason] as object), ...over });

describe("the header", () => {
  test("the shown status follows a click until the engine's word: «Ставим на паузу…», «Останавливаем…»", () => {
    expect(shownStatus(launch(), { pause: true, stop: false })).toBe("pausing");
    expect(shownStatus(launch(), { pause: false, stop: true })).toBe("stopping");
    expect(shownStatus(paused("owner"), { pause: true, stop: false })).toBe("paused");
    expect(shownStatus(launch({ status: "stopped", endedAt: "2026-10-08T14:09:00.000Z" }), { pause: false, stop: true })).toBe("stopped");
  });

  test("since when and how long, the requests a pause waits for, why it is paused", () => {
    expect(durationLabel(161_000)).toBe("2:41");
    expect(durationLabel(3_912_000)).toBe("1:05:12");
    expect(headerMeta(launch(), "running", 161_000)).toMatch(/^с \d\d:\d\d · 2:41$/);
    expect(headerMeta(launch(), "pausing", 0)).toBe(`4${NBSP}запроса в работе`);
    expect(headerMeta(launch({ inFlight: { requests: 0, openMicros: 0 } }), "stopping", 0)).toBeNull();
    expect(headerMeta(paused("owner"), "paused", 208_000)).toMatch(/^с \d\d:\d\d · в работе 3:28$/);
    expect(headerMeta(paused("quit"), "paused", 0)).toMatch(/^Studio был закрыт в \d\d:\d\d$/);
    expect(headerMeta(paused("engine-restart"), "paused", 0)).toMatch(/^движок перезапустился в \d\d:\d\d$/);
    expect(headerMeta(launch({ status: "done", endedAt: "2026-10-08T14:31:00.000Z" }), "done", 0)).toMatch(/^\d\d:\d\d–\d\d:\d\d$/);
  });

  test("the line under it: a pause on its way (≤ 3 minutes), a paused launch's R of W′, accepted scenes, a stop, the outcome", () => {
    expect(headerSub(launch(), "pausing", nameOf)).toBe("Новые запросы и рендеры не начнутся. Ждём ответов на те, что уже ушли, — обычно до минуты, не дольше 3 минут; рендеры, что идут, доделаются.");
    expect(headerSub(paused("owner"), "paused", nameOf)).toBe("Ничего не тратится и не рендерится. «Продолжить» разрешит запуску потратить ещё до $2.89 — остаток предела $4.14.");
    const reviewed = paused("owner", { avatars: [libraryRow(A), row(B, { phase: "approved-waiting", slice: null, photos: { done: 0, total: 14 }, continuePhotos: 12 })] });
    expect(headerSub(reviewed, "paused", nameOf)).toBe(`Ничего не тратится и не рендерится. Сцены Sofia приняты — 12${NBSP}фото нарисуем после «Продолжить».`);
    expect(headerSub(launch(), "stopping", nameOf)).toBe(`Новых трат не будет. Ждём ответов на 4${NBSP}запроса — обычно до минуты, не дольше 3 минут.`);
    const done = launch({ status: "done", endedAt: "2026-10-08T14:31:00.000Z", plan: { videos: 20, photos: 56, fromLibrary: 37, toGenerate: 19 }, avatars: [libraryRow(A), row(B, { phase: "done", dropped: { count: 2, reason: "not-enough-photos" } })] });
    expect(headerSub(done, "done", nameOf)).toBe(`10 из 20${NBSP}видео в «Готовых видео». 2${NBSP}видео меньше: у Sofia — не хватило фото.`);
    expect(headerSub(launch({ status: "stopped", endedAt: "2026-10-08T14:09:00.000Z" }), "stopped", nameOf)).toBe(`10 из 20${NBSP}видео готовы. Потрачено $1.25 из $4.14.`);
    expect(headerSub(launch(), "running", nameOf)).toBeNull();
  });
});

describe("«Потрачено»", () => {
  test("S of W′, the open reserves of the requests in flight hatched and said; «Правки сцен» apart", () => {
    const block = spentBlock(launch({ reviewWritesMicros: 2_000 }));
    expect(block.spent).toBe("$1.25");
    expect(block.of).toBe("из $4.14");
    expect(block.sub).toBe(`вкл. до $0.28 — 4${NBSP}запроса в работе, по худшей цене до ответа`);
    expect(block.reviewWrites).toBe("$0.002");
    expect(block.settledPct + block.openPct).toBe(30.2);
    expect(block.openPct).toBe(6.8);
  });

  test("a network hold words the open reserves «без ответа», not «в работе»; a free launch reads «бесплатно»", () => {
    const network = launch({ paidHold: hold("network", { detail: { drops: 3, attempt: 2, nextAt: null } }), resumeBlockedBy: "network" });
    expect(spentBlock(network).sub).toBe(`вкл. до $0.28 за 4${NBSP}запроса без ответа — до сверки`);
    expect(spentBlock(network).openPct).toBe(6.8);
    expect(spentBlock(launch({ inFlight: { requests: 0, openMicros: 0 } })).sub).toBeNull();
    const free = launch({ acceptedMicros: 0, plannedWorstMicros: 0, plannedExpectedMicros: 0, spentMicros: 0, remainingMicros: 0, inFlight: { requests: 0, openMicros: 0 } });
    expect(spentBlock(free)).toMatchObject({ spent: null, of: "бесплатно" });
  });

  test("paused (M1): no hatched in-flight amount; the open reserves are inside «Потрачено», said in one plain line when a reconcile is required", () => {
    // Whatever the view says of requests in flight, a paused launch has none: nothing is hatched, nothing «в работе».
    const owner = spentBlock(paused("owner", { inFlight: { requests: 4, openMicros: 280_000 } }));
    expect(owner).toMatchObject({ sub: null, openPct: 0, settledPct: 30.2 });
    expect(owner.label).toBe("Потрачено $1.25 из $4.14");
    expect(spentBlock(paused("quit", { resumeBlockedBy: "reconcile-required" }))).toMatchObject({ sub: "Прерванные запросы уже в «Потрачено» по худшей цене — до сверки.", openPct: 0 });
    expect(spentBlock(paused("owner", { resumeBlockedBy: "network" })).sub).toBe("Запросы без ответа уже в «Потрачено» по худшей цене — до сверки.");
    expect(spentBlock(paused("owner", { resumeBlockedBy: "key" })).sub).toBeNull();
    // A halt is a settle above its worst case or a ledger line not written — not requests without an answer: no such line.
    expect(spentBlock(paused("owner", { resumeBlockedBy: "halt" })).sub).toBeNull();
    expect(spentBlock(paused("quit", { resumeBlockedBy: "halt" })).sub).toBeNull();
  });
});

describe("«Потрачено» from `unsettled` (S4.6v: ApPausedReconcile, ApHoldNetwork)", () => {
  const OPEN = { requests: 4, openMicros: 280_000 };
  const NONE = { requests: 0, openMicros: 0 };

  test("paused after a quit: the open reserves the quit cut off are hatched and said as the mockup does, «за N прерванных запроса — до сверки» (S4.9d)", () => {
    const block = spentBlock(paused("quit", { inFlight: NONE, unsettled: OPEN, resumeBlockedBy: "reconcile-required" }));
    expect(block.sub).toBe(`вкл. до $0.28 за 4${NBSP}прерванных запроса — до сверки`);
    expect(block.openPct).toBe(6.8);
    expect(block.settledPct + block.openPct).toBe(30.2);
    // The bar's label says what the line under it says.
    expect(block.label).toBe(`Потрачено $1.25 из $4.14, из них до $0.28 за 4${NBSP}прерванных запроса — до сверки`);
  });

  test("paused: whatever `inFlight` says, a paused launch shows only what is unsettled", () => {
    const block = spentBlock(paused("owner", { inFlight: { requests: 9, openMicros: 999_000 }, unsettled: { requests: 1, openMicros: 70_000 } }));
    expect(block.sub).toBe(`вкл. до $0.070 за 1${NBSP}запрос без ответа — до сверки`);
    expect(block.openPct).toBe(1.7);
  });

  test("a network hold on a running launch: the requests the drop left are «без ответа», nothing is in flight", () => {
    const held = launch({ paidHold: hold("network", { detail: { drops: 3, attempt: 2, nextAt: null } }), resumeBlockedBy: "network", inFlight: NONE, unsettled: OPEN });
    expect(spentBlock(held)).toMatchObject({ sub: `вкл. до $0.28 за 4${NBSP}запроса без ответа — до сверки`, openPct: 6.8 });
    expect(spentBlock(held).label).toBe(`Потрачено $1.25 из $4.14, из них до $0.28 за 4${NBSP}запроса без ответа — до сверки`);
  });

  test("running: requests in flight are «в работе», and nothing unsettled changes that", () => {
    const block = spentBlock(launch({ inFlight: OPEN, unsettled: NONE }));
    expect(block.sub).toBe(`вкл. до $0.28 — 4${NBSP}запроса в работе, по худшей цене до ответа`);
    expect(block.label).toBe("Потрачено $1.25 из $4.14, из них до $0.28 — запросы в работе");
  });

  test("running with both: the card shows what is in flight and does not add the unsettled to it", () => {
    const block = spentBlock(launch({ inFlight: { requests: 2, openMicros: 140_000 }, unsettled: { requests: 2, openMicros: 140_000 } }));
    expect(block.sub).toBe(`вкл. до $0.14 — 2${NBSP}запроса в работе, по худшей цене до ответа`);
    expect(block.openPct).toBe(3.4);
  });

  test("running with nothing in flight shows the unsettled the last drop left, even without a hold", () => {
    expect(spentBlock(launch({ inFlight: NONE, unsettled: { requests: 1, openMicros: 70_000 } })).sub).toBe(`вкл. до $0.070 за 1${NBSP}запрос без ответа — до сверки`);
  });

  test("after a reconcile (nothing unsettled) the hatched part and its line are gone", () => {
    const reconciled = spentBlock(paused("quit", { inFlight: NONE, unsettled: NONE }));
    expect(reconciled).toMatchObject({ sub: null, openPct: 0, settledPct: 30.2 });
    expect(reconciled.label).toBe("Потрачено $1.25 из $4.14");
  });

  test("a reconcile that is required while `unsettled` says there is nothing open claims no reserves: the line is gone (a torn line or another job's reserve)", () => {
    expect(spentBlock(paused("quit", { inFlight: NONE, unsettled: NONE, resumeBlockedBy: "reconcile-required" })).sub).toBeNull();
    expect(spentBlock(paused("owner", { inFlight: NONE, unsettled: NONE, resumeBlockedBy: "network" })).sub).toBeNull();
  });

  test("a view from before `unsettled` keeps the plain line for a required reconcile", () => {
    expect(spentBlock(paused("quit", { resumeBlockedBy: "reconcile-required" })).sub).toBe("Прерванные запросы уже в «Потрачено» по худшей цене — до сверки.");
  });

  test("the reconcile first: «она закроет эти N запроса» counts the unsettled ones, on a paused launch too", () => {
    const l = paused("quit", { inFlight: NONE, unsettled: { requests: 2, openMicros: 140_000 }, resumeBlockedBy: "network" });
    expect(resumeWhy(l, "network")).toBe(`Сначала сверка — она закроет эти 2${NBSP}запроса. Потом «Продолжить» покажет новый остаток.`);
  });

  test("the network hold's notice counts the unsettled requests and their ceiling", () => {
    const stuck = liveNote(
      launch({ paidHold: hold("network", { detail: { drops: 3, attempt: 2, nextAt: null } }), resumeBlockedBy: "network", inFlight: NONE, unsettled: OPEN, avatars: [libraryRow(A), row(B, { phase: "waiting", slice: null, waiting: { reason: "paid-hold" } })] }),
      "running",
      nameOf,
    );
    expect(stuck?.text).toContain(`4${NBSP}запроса без ответа до сверки считаются по худшей цене, до $0.28.`);
  });
});

describe("the avatars' rows", () => {
  const line = (r: LaunchAvatarView, over: Record<string, unknown> = {}) => {
    const l = launch({ avatars: [libraryRow(A), r], ...over });
    return avatarLine(l, r, "Sofia");
  };

  test("each phase in words and colour, with its cells and its one action", () => {
    expect(avatarLine(launch(), libraryRow(A), "Mia")).toMatchObject({ phase: "монтаж · фото из библиотеки", tone: "calm", action: null });
    expect(avatarLine(launch(), libraryRow(A), "Mia").cells[0]).toEqual({ text: "библиотека", pct: 100 });
    expect(line(row(B, {}))).toMatchObject({ phase: "рисуем фото · партия 2 из 4", tone: "act" });
    expect(line(row(B, { slice: null })).phase).toBe("рисуем фото · 9 из 14");
    expect(line(row(B, { phase: "planned", slice: null }))).toMatchObject({ phase: "в очереди", tone: "off" });
    expect(line(row(B, { phase: "composing", slice: null })).phase).toBe("пишем сцены · 14");
    const review = line(row(B, { phase: "awaiting-review", slice: null, photos: { done: 0, total: 14 }, scenesWithoutText: 2, continuePhotos: 12 }));
    expect(review).toMatchObject({ phase: "ждёт проверки сцен · 14, у 2 нет текста", tone: "info", action: { kind: "photos", label: "Открыть «Фото»" } });
    expect(review.cells[0].text).toBe("— / 14");
    expect(line(row(B, { phase: "approved-waiting", slice: null, continuePhotos: 12 })).phase).toBe(`проверено — ждёт «Продолжить» · 12${NBSP}фото`);
    expect(line(row(B, { phase: "done", slice: null }))).toMatchObject({ phase: "готово", tone: "ok" });
    expect(line(row(B, { phase: "montage", slice: null, waitingMusic: 3 }))).toMatchObject({ phase: `3${NBSP}видео ждут музыку`, tone: "warn" });
  });

  test("waiting: a busy avatar, an open set of the owner's, the launch's paid hold by its reason", () => {
    expect(line(row(B, { phase: "waiting", waiting: { reason: "avatar-busy" } })).phase).toBe("ждёт: идёт ваша генерация на «Фото» — продолжим сами");
    expect(line(row(B, { phase: "waiting", waiting: { reason: "library-unknown" } })).phase).toBe("ждёт: не читается, какие фото свободны — продолжим, когда библиотека ответит");
    expect(line(row(B, { phase: "waiting", waiting: { reason: "open-set" } }))).toMatchObject({ phase: "ждёт: открыт ваш набор сцен — завершите его на «Фото»", action: { kind: "photos" } });
    const held = row(B, { phase: "waiting", waiting: { reason: "paid-hold" } });
    expect(line(held, { paidHold: hold("budget") }).phase).toBe("ждёт бюджета · 9 из 14 фото");
    expect(line(held, { paidHold: hold("network", { detail: { drops: 3, attempt: 2, nextAt: null } }) }).phase).toBe("ждёт сверки · 9 из 14 фото");
    expect(line(held, { paidHold: hold("network") }).phase).toMatch(/^ждём связь · повтор в \d\d:\d\d$/);
    expect(line(held, { paidHold: hold("key") }).phase).toBe("ждёт ключ OpenRouter · 9 из 14 фото");
    expect(line(held, { paidHold: hold("credits") }).phase).toBe("ждёт пополнения · 9 из 14 фото");
    expect(line(held, { paidHold: hold("price-unavailable") }).phase).toBe("ждёт цены");
  });

  test("skipped, each reason with its own words, the action where there is something to do", () => {
    const skipped = (skip: Record<string, unknown>) => line(row(B, { phase: "skipped", skipped: skip as LaunchAvatarView["skipped"] }));
    expect(skipped({ reason: "failure-rate", failed: 3, total: 5 })).toMatchObject({ phase: "пропущена: много неудачных фото", tone: "danger", action: { kind: "photos" } });
    expect(skipped({ reason: "master-unusable" })).toMatchObject({ phase: "пропущена: мастер-портрет не годится для проверки лица", action: { kind: "avatars", label: "Открыть аватар" } });
    expect(skipped({ reason: "archived" })).toMatchObject({ phase: "пропущена: аватар в архиве", action: null });
    expect(skipped({ reason: "face-gate-unavailable" }).phase).toBe("пропущена: проверка лица недоступна");
    expect(skipped({ reason: "set-unreadable" }).phase).toBe("пропущена: набор сцен не читается");
  });

  test("a paused launch's rows read «на паузе», with how far the photos got; scenes accepted keep their words", () => {
    const p = paused("owner");
    expect(avatarLine(p, libraryRow(A), "Mia")).toMatchObject({ phase: "на паузе", tone: "off" });
    expect(avatarLine(p, drawingRow(B), "Sofia").phase).toBe("на паузе · 9 из 14 фото");
    const accepted = row(B, { phase: "approved-waiting", slice: null, continuePhotos: 12 });
    expect(avatarLine(p, accepted, "Sofia").tone).toBe("info");
  });
});

describe("«Продолжить · до $R»", () => {
  test("always with its sum: R of the view; «бесплатно» for a launch that pays for nothing", () => {
    expect(resumeTitle(2_930_000, 4_140_000)).toBe("Продолжить · до $2.93");
    expect(resumeTitle(0, 4_140_000)).toBe("Продолжить · без трат");
    expect(resumeTitle(0, 0)).toBe("Продолжить · бесплатно");
  });

  test("why it is closed, by `resumeBlockedBy`", () => {
    const l = launch({ paidHold: hold("budget") });
    expect(resumeWhy(l, "reconcile-required")).toBe("Сверить можно через 2 минуты после последнего запроса. Потом «Продолжить» покажет новый остаток.");
    expect(resumeWhy(l, "halt")).toBe("Сначала сверка — потом «Продолжить» покажет новый остаток.");
    expect(resumeWhy(l, "ledger")).toBe("«Продолжить» откроется, когда журнал расходов снова прочитается.");
    expect(resumeWhy(l, "key")).toBe("«Продолжить» откроется, когда ключ проверен.");
    expect(resumeWhy(l, "budget")).toBe("«Продолжить» откроется, когда в месяце будет свободно $1.05.");
    expect(resumeWhy(launch({ paidHold: hold("budget", { detail: { freeMicros: 180_000, needMicros: 210_000, kind: "new-slice" } }) }), "budget")).toBe(
      "«Продолжить» откроется, когда в месяце будет свободно $0.21; партия будет по месту.",
    );
    expect(resumeWhy(l, "network")).toBe(`Сначала сверка — она закроет эти 4${NBSP}запроса. Потом «Продолжить» покажет новый остаток.`);
    // Paused, nothing is in flight: the requests without an answer are not counted again.
    expect(resumeWhy(paused("owner", { inFlight: { requests: 4, openMicros: 280_000 } }), "network")).toBe("Сначала сверка — она закроет запросы без ответа. Потом «Продолжить» покажет новый остаток.");
    expect(resumeWhy(l, "internal")).toBe("Продолжить нельзя: выход — «Стоп».");
  });

  test("in the header of a paused launch, in the notice of a running one's paid hold, nowhere while it runs free", () => {
    expect(resumePlace(paused("owner"), "paused", null)).toBe("header");
    const held = launch({ paidHold: hold("credits") });
    expect(resumePlace(held, "running", liveNote(held, "running", nameOf))).toBe("note");
    expect(resumePlace(launch(), "running", liveNote(launch(), "running", nameOf))).toBeNull();
    const retrying = launch({ paidHold: hold("network") });
    expect(resumePlace(retrying, "running", liveNote(retrying, "running", nameOf))).toBeNull();
  });
});

describe("the notice under the header: each hold with its own words and fix (LaunchStates)", () => {
  const sofiaHeld = [libraryRow(A), row(B, { phase: "waiting", waiting: { reason: "paid-hold" } })];
  const note = (over: Record<string, unknown>, status: "running" | "paused" = "running") => {
    const l = status === "paused" ? paused("owner", over) : launch(over);
    return liveNote(l, status, nameOf);
  };

  test("budget: the one threshold `needMicros`, for the batch started or a new one, the month's turn in UTC, «Открыть Настройки»", () => {
    const resume = note({ paidHold: hold("budget"), resumeBlockedBy: "budget", avatars: sofiaHeld });
    expect(resume).toMatchObject({ title: "Ждёт бюджета", tone: "warn", resume: true, why: "«Продолжить» откроется, когда в месяце будет свободно $1.05." });
    expect(resume?.text).toBe("Доделать партию Sofia: нужно до $1.05, свободно $0.18. Поднимите бюджет или дождитесь 1 ноября (UTC). Монтаж из готовых фото идёт дальше.");
    expect(resume?.actions).toEqual([{ kind: "settings", focus: "money", label: "Открыть Настройки" }]);
    const fresh = note({ paidHold: hold("budget", { detail: { freeMicros: 180_000, needMicros: 210_000, kind: "new-slice" } }), resumeBlockedBy: "budget", avatars: sofiaHeld });
    expect(fresh?.text).toBe("Начать новую партию Sofia: нужно хотя бы $0.21 — одно фото, свободно $0.18. Поднимите бюджет или дождитесь 1 ноября (UTC). Монтаж из готовых фото идёт дальше.");
    expect(nextMonthStart("2026-12-31T23:00:00.000Z")).toBe("1 января");
  });

  test("network: the automatic retry with its number (no button), then after the third drop a reconcile and «Продолжить»", () => {
    const retry = note({ paidHold: hold("network"), avatars: sofiaHeld });
    expect(retry?.title).toMatch(/^Нет ответа — повторим в \d\d:\d\d$/);
    // L6: a retry that goes by itself is information, said politely.
    expect(retry).toMatchObject({ tone: "info", icon: "info", resume: false, actions: [], why: "Каждый обрыв сжигает по одной оплаченной попытке у фото в работе — до 6." });
    expect(retry?.text).toBe("Партия Sofia осталась без ответа. Продолжим её сами в пределах той же партии — повтор 1 из 2. Если связь пропадёт в третий раз, платная часть встанет до сверки.");
    const stuck = note({ paidHold: hold("network", { detail: { drops: 3, attempt: 2, nextAt: null } }), resumeBlockedBy: "network" });
    expect(stuck).toMatchObject({ title: "Нет ответа от OpenRouter", resume: true, actions: [{ kind: "settings", focus: "money", label: "Перейти к сверке" }] });
    expect(stuck?.text).toBe(
      `Связь пропала 3${NBSP}раза: 2 повтора (через 1 и 5 мин) не помогли — платная часть ждёт. 4${NBSP}запроса без ответа до сверки считаются по худшей цене, до $0.28. Монтаж из готовых фото идёт дальше.`,
    );
  });

  test("credits, key, halt, price, price-unavailable: each its words; credits is admitted, the answer decides", () => {
    expect(note({ paidHold: hold("credits") })).toMatchObject({ title: "Пополните баланс OpenRouter", resume: true, why: "Если денег всё ещё нет, запуск снова встанет здесь — без лишних трат." });
    expect(note({ paidHold: hold("key"), resumeBlockedBy: "key" })).toMatchObject({
      title: "Ключ OpenRouter отклонён",
      text: "OpenRouter не принял ключ посреди партии. Замените его в Настройках — потом «Продолжить». Монтаж из готовых фото идёт дальше.",
      actions: [{ kind: "settings", focus: "key", label: "Открыть Настройки" }],
      why: "«Продолжить» откроется, когда ключ проверен.",
    });
    expect(note({ paidHold: hold("halt"), resumeBlockedBy: "halt" })).toMatchObject({ title: "Расходы остановлены", tone: "danger", actions: [{ label: "Перейти к сверке" }] });
    expect(note({ paidHold: hold("halt", { detail: { code: "LEDGER_WRITE_FAILED" } }), resumeBlockedBy: "halt" })?.text).toMatch(/^Строка журнала расходов не записалась/);
    expect(note({ paidHold: hold("price") })).toMatchObject({ title: "Цена выросла", resume: true });
    expect(note({ paidHold: hold("price") })?.text).toMatch(/^Следующая партия не помещается в остаток запуска даже из одного фото\./);
    expect(note({ paidHold: hold("price", { detail: { stage: "compose", needMicros: 75_000, leftMicros: 60_000 } }) })?.text).toMatch(/^Сцены по новой цене не помещаются/);
    expect(note({ paidHold: hold("price-unavailable") })).toMatchObject({ tone: "info", resume: false, text: "Без цены запуск не тратит. Повтор 2 из 3. Монтаж из готовых фото идёт дальше." });
    expect(note({ paidHold: hold("price-unavailable", { detail: { attempt: 3, nextAt: null } }) })).toMatchObject({ title: "Цены OpenRouter не загрузились", resume: true });
  });

  test("internal: «Продолжить» never opens, «Стоп» is the way out", () => {
    const internal = note({ paidHold: hold("internal"), resumeBlockedBy: "internal" });
    expect(internal).toMatchObject({ title: "Внутренняя ошибка учёта", tone: "danger", resume: true, actions: [{ kind: "stop", label: "Стоп" }], why: "Продолжить нельзя: выход — «Стоп»." });
  });

  test("a paused launch: what stops «Продолжить» (a quit with requests in flight → «Сначала сверка»), else the restart's words", () => {
    const reconcile = liveNote(paused("quit", { resumeBlockedBy: "reconcile-required", logTail: [logLine("host-quit")] }), "paused", nameOf);
    expect(reconcile).toMatchObject({ title: "Сначала сверка", resume: false, actions: [{ label: "Перейти к сверке" }] });
    expect(reconcile?.text).toBe(`Studio закрылся, когда 4${NBSP}запроса были в работе. Пока OpenRouter не сверен, они считаются по худшей цене, и запуск не продолжить.`);
    const fromLog = liveNote(paused("engine-restart", { resumeBlockedBy: "reconcile-required", logTail: [logLine("app-restarted")] }), "paused", nameOf);
    expect(fromLog?.text).toBe(`Движок перезапустился, когда 4${NBSP}запроса были в работе. Пока OpenRouter не сверен, они считаются по худшей цене, и запуск не продолжить.`);
    expect(liveNote(paused("quit"), "paused", nameOf)).toMatchObject({ title: "Studio был закрыт — запуск ждёт вас", icon: "pause" });
    expect(liveNote(paused("quit"), "paused", nameOf)?.text).toBe(
      "После перезапуска автопилот ничего не делает сам: ни запросов, ни рендеров, ни музыки. «Продолжить» разрешит потратить ещё до $2.89 — остаток предела $4.14.",
    );
    expect(liveNote(paused("engine-restart"), "paused", nameOf)?.title).toBe("Studio перезапустил движок после сбоя");
    expect(liveNote(paused("owner"), "paused", nameOf)).toBeNull();
    expect(liveNote(paused("owner", { resumeBlockedBy: "ledger" }), "paused", nameOf)).toMatchObject({ title: "Журнал расходов не читается", tone: "danger" });
  });

  test("M3: a hold that waits while another reason closes «Продолжить» — the reason first, the wait said in it, `why` always the reason's", () => {
    const retry = hold("network");
    // A retry pending, then a restart: the reconcile is what closes the button; the retry waits for «Продолжить».
    const restart = liveNote(paused("engine-restart", { paidHold: retry, resumeBlockedBy: "reconcile-required" }), "paused", nameOf);
    expect(restart).toMatchObject({ title: "Сначала сверка", resume: false, why: "Сверить можно через 2 минуты после последнего запроса. Потом «Продолжить» покажет новый остаток." });
    expect(restart?.text).toMatch(/ Ещё платная часть ждёт: нет ответа от OpenRouter — повтор после «Продолжить»\.$/);
    // Running: the key closes the button though the hold is the credits'; the button stays in the notice, closed by the key.
    const key = liveNote(launch({ paidHold: hold("credits"), resumeBlockedBy: "key" }), "running", nameOf);
    expect(key).toMatchObject({ title: "Ключ OpenRouter отклонён", resume: true, why: "«Продолжить» откроется, когда ключ проверен." });
    expect(key?.text).toMatch(/ Ещё платная часть ждёт: пополнение баланса OpenRouter\.$/);
    const running = liveNote(launch({ paidHold: retry, resumeBlockedBy: "reconcile-required" }), "running", nameOf);
    expect(running?.title).toBe("Сначала сверка");
    expect(running?.text).toMatch(/ Ещё платная часть ждёт: нет ответа от OpenRouter — повтор в \d\d:\d\d\.$/);
    // The hold's own reason, paused: its own words, the button in the header described by the reason.
    expect(liveNote(paused("owner", { paidHold: hold("budget"), resumeBlockedBy: "budget" }), "paused", nameOf)).toMatchObject({
      title: "Ждёт бюджета",
      resume: false,
      why: "«Продолжить» откроется, когда в месяце будет свободно $1.05.",
    });
    // The credits' own line never replaces a reason's.
    expect(liveNote(paused("owner", { paidHold: hold("credits"), resumeBlockedBy: "ledger" }), "paused", nameOf)).toMatchObject({
      title: "Журнал расходов не читается",
      why: "«Продолжить» откроется, когда журнал расходов снова прочитается.",
    });
  });

  test("M3: retries during a pause go «после «Продолжить»»: nothing runs by itself", () => {
    const network = liveNote(paused("owner", { paidHold: hold("network") }), "paused", nameOf);
    expect(network).toMatchObject({ title: "Нет ответа — повтор после «Продолжить»", tone: "info", resume: false });
    expect(network?.text).toBe("Запросы партии остались без ответа. После «Продолжить» повторим её в пределах той же партии — повтор 1 из 2. Если связь пропадёт в третий раз, платная часть встанет до сверки.");
    const prices = liveNote(paused("quit", { paidHold: hold("price-unavailable") }), "paused", nameOf);
    expect(prices).toMatchObject({ title: "Цены не загрузились — повтор после «Продолжить»", tone: "info", text: "Без цены запуск не тратит. Повтор 2 из 3 — после «Продолжить»." });
  });

  test("free holds, music, review and a skip, most pressing first", () => {
    expect(note({ freeHold: { reason: "export", at: "2026-10-08T14:02:00.000Z", detail: { exportReason: "missing", neededBytes: null, freeBytes: null } } })).toMatchObject({
      title: "Папка «Готовые видео» недоступна",
      text: "Диск отключён или папку переименовали. Фото рисуются дальше, видео подождут папку.",
      actions: [{ kind: "settings", focus: "export" }],
    });
    expect(note({ freeHold: { reason: "export", at: "2026-10-08T14:02:00.000Z", detail: { exportReason: "not-enough-space", neededBytes: 9_000_000, freeBytes: 6_400_000 } } })).toMatchObject({
      title: "Мало места на диске",
      text: `Для следующего видео нужно ≈ 9${NBSP}МБ, свободно 6${NBSP}МБ. Освободите место — рендеры продолжатся сами.`,
    });
    const music = note({ waitingMusic: 3, logTail: [logLine("music-refresh")] });
    expect(music).toMatchObject({ title: `3${NBSP}видео ждут музыку`, why: "Автопилот уже обновлял тренды при старте — второй раз только вручную." });
    const review = note({ avatars: [libraryRow(A), row(B, { phase: "awaiting-review", slice: null, photos: { done: 0, total: 14 }, scenesWithoutText: 2, continuePhotos: 12 })] });
    expect(review).toMatchObject({ title: "Сцены Sofia ждут проверки", tone: "info" });
    expect(review?.text).toBe(`14${NBSP}сцен на «Фото», у 2 нет текста. Пока вы смотрите, Mia идёт дальше. Продолжить можно и отсюда: сцены без текста уберём, фото будет 12.`);
    expect(review?.actions).toEqual([{ kind: "continue", avatarId: B, sceneSetId: "set-mia-00000001", revision: 3, label: `Продолжить запуск: 12${NBSP}фото` }]);
    const skip = note({ avatars: [libraryRow(A), row(B, { phase: "skipped", skipped: { reason: "failure-rate", failed: 3, total: 5 } })] });
    expect(skip).toMatchObject({ title: "Sofia пропущена", actions: [{ kind: "photos", avatarId: B, label: "Открыть «Фото» Sofia" }] });
    expect(skip?.text).toMatch(/^3 из 5 новых фото не прошли проверки\. Новых фото Sofia в этом запуске не будет/);
    // A hold wins over the review it would otherwise sit beside.
    expect(note({ paidHold: hold("credits"), avatars: [libraryRow(A), row(B, { phase: "awaiting-review", slice: null, continuePhotos: 12 })] })?.title).toBe("Пополните баланс OpenRouter");
    expect(liveNote(launch(), "pausing", nameOf)).toBeNull();
  });
});

describe("the log", () => {
  test("every kind of the closed list is worded (nothing left to the engine's words)", () => {
    for (const kind of LOG_KINDS) {
      const parsed = LogLine.parse(logLine(kind));
      const { text } = logText(parsed, true);
      expect(text.length > 0 ? kind : `${kind}: empty`).toBe(kind);
    }
    expect(Object.keys(LOG_SAMPLES).sort()).toEqual([...LOG_KINDS].sort());
  });

  test("the design's lines, word for word (LaunchStates «Журнал»)", () => {
    const say = (kind: string, over: Record<string, unknown> = {}, avatar = false): string => logText(LogLine.parse(logLine(kind, { ...(avatar ? { avatarId: A } : {}), ...over })), true).text;
    expect(say("start")).toBe("запуск принят · до $4.14");
    expect(say("scenes-ready")).toBe("сцены готовы: 14, у 2 нет текста · ждут проверки");
    expect(say("review-continued")).toBe(`сцены проверены: 14${NBSP}фото · 2 дописаны вами`);
    expect(say("slice-start", { index: 1 })).toBe(`партия 1: 14${NBSP}фото · до $2.94`);
    expect(say("photo")).toBe("фото 9 из 14 · лицо 0.84");
    expect(say("photo-retry")).toBe("сцена 7: отказ → Seedream · попытка 2 из 3");
    expect(say("photo-failed")).toBe("фото 9: лицо 0.47 — не похоже · попыток 3");
    expect(say("video-done")).toBe(`видео 5 · коллаж 3 · 8.5${NBSP}с · 2.3${NBSP}МБ`);
    expect(say("degrade")).toBe(`2${NBSP}видео меньше: 3${NBSP}фото не получились`);
    expect(say("price-shrink")).toBe(`цена выросла: −1${NBSP}фото в партии`);
    expect(say("review-write")).toBe("правка сцен: «другая сцена» · $0.002 отдельно");
    expect(say("pausing")).toBe(`пауза: ждём 4${NBSP}запроса и 2${NBSP}рендера`);
    expect(say("paused")).toBe("на паузе: запросы закончились");
    expect(say("resumed")).toBe("продолжен · до $2.93");
    expect(say("host-quit")).toBe(`Studio закрыт · 4${NBSP}запроса прервались`);
    expect(say("network-retry")).toBe(`нет ответа · повтор 1 из 2 через 1${NBSP}мин`);
    expect(say("hold-budget")).toBe("доделать партию: нужно до $1.05, свободно $0.18");
    expect(say("skipped")).toBe("пропущена: 3 из 5 фото не прошли проверки");
    expect(say("waiting-music")).toBe(`видео 8 ждёт музыку · все треки короче 9.5${NBSP}с`);
    expect(say("review-approved-paused")).toBe(`сцены приняты на паузе: 12${NBSP}фото · ждут «Продолжить»`);
    expect(say("music-refresh")).toBe(`тренды обновлены: +6${NBSP}треков · осталось 20 из 30`);
    expect(say("stopped")).toBe("остановлен владельцем · потрачено $0.33");
    expect(say("done")).toBe(`запуск завершён · 28 из 30${NBSP}видео`);
    expect(say("done", { videosDone: 10, videosPlanned: 10 }, true)).toBe("готово: 10 из 10");
    expect(say("hold-network")).toBe("нет ответа 3-й раз · ждём сверки");
    expect(say("avatar-busy")).toBe("ждём: аватар занят вашей генерацией");
    expect(say("library-unknown")).toBe("ждём: не читается, какие фото свободны");
  });

  test("newest first, the avatar's name or «—», a tone for holds and the review", () => {
    const l = launch({ logTail: [logLine("start"), logLine("photo", { avatarId: B }), logLine("hold-budget")] });
    const rows = logRows(l, nameOf);
    expect(rows.map((r) => r.who)).toEqual(["—", "Sofia", "—"]);
    expect(rows.map((r) => r.tone)).toEqual(["warn", "plain", "plain"]);
    expect(rows[0]?.at).toMatch(/^\d\d:\d\d:\d\d$/);
  });
});

describe("«Остановить запуск?» by the phase of each set (round 1 M2)", () => {
  test("composing, waiting for the review, approved with no batch, drawn in part (with or without scenes left), drawn whole, library only", () => {
    expect(stopSetLine(row(B, { phase: "composing", slice: null, photos: { done: 0, total: 14 } }), "Sofia")).toMatchObject({ phase: "сцены пишутся" });
    expect(stopSetLine(row(B, { phase: "awaiting-review", slice: null, photos: { done: 0, total: 14 } }), "Sofia")).toEqual({
      avatarId: B,
      name: "Sofia",
      phase: "ждёт проверки",
      what: "Набор вернётся на «Фото» обычным: отрисовать его или удалить — решите там. За составление уже заплачено.",
    });
    expect(stopSetLine(row(B, { phase: "approved-waiting", slice: null, photos: { done: 0, total: 14 } }), "Sofia")).toMatchObject({
      phase: "проверен, не начат",
      what: "Набор проверен, но партий ещё нет — вернётся на «Фото» обычным открытым набором.",
    });
    expect(stopSetLine(row(B, {}), "Zoe")).toEqual({
      avatarId: B,
      name: "Zoe",
      phase: "партия 2 из 4",
      what: `Начатую партию (осталось 2${NBSP}фото) можно доделать на «Фото» своим кликом. Остальные 5${NBSP}сцен набора не нарисуются — их составление уже оплачено.`,
    });
    expect(stopSetLine(row(B, { slice: { index: 1, total: 1 }, photos: { done: 3, total: 5 }, undrawnScenes: 0, resumableSlots: 2 }), "Elena")).toMatchObject({
      phase: "рисуется 3 из 5",
      what: `Набор останется отрисованным частично. Начатую партию (осталось 2${NBSP}фото) можно доделать на «Фото» своим кликом; других сцен в наборе нет.`,
    });
    expect(stopSetLine(row(B, { phase: "montage", photos: { done: 14, total: 14 }, undrawnScenes: 0, resumableSlots: 0 }), "Sofia")).toMatchObject({ phase: "нарисован" });
    expect(stopSetLine(libraryRow(A), "Mia")).toMatchObject({ phase: "только библиотека", what: "Наборов сцен нет — ничего не меняется." });
  });

  test("L3: «проверен» is the approved set's only; a set the launch holds with no batch begun is said as such", () => {
    expect(stopSetLine(row(B, { phase: "drawing", slice: null, photos: { done: 0, total: 14 } }), "Sofia")).toMatchObject({
      phase: "партия не начата",
      what: "Партий ещё нет — набор вернётся на «Фото» обычным открытым набором.",
    });
    expect(stopSetLine(row(B, { phase: "waiting", waiting: { reason: "avatar-busy" }, slice: null, photos: { done: 0, total: 14 } }), "Sofia").phase).toBe("партия не начата");
  });

  test("names for a sentence", () => {
    expect(namesList(["Mia"])).toBe("Mia");
    expect(namesList(["Mia", "Elena"])).toBe("Mia и Elena");
    expect(namesList(["Mia", "Elena", "Nora"])).toBe("Mia, Elena и Nora");
  });
});

// ---------- S4.9d: the polish the S4.9b, S4.9c and S4.6g reviews left ----------

describe("S4.9d: «Потрачено» as the mockup words it — the request a quit cut off, the request a drop left (item 1)", () => {
  const NONE = { requests: 0, openMicros: 0 };

  test("a restart's cut-off requests read «прерванных», one, a few or many, and the label of the bar follows the line", () => {
    const one = spentBlock(paused("engine-restart", { inFlight: NONE, unsettled: { requests: 1, openMicros: 70_000 }, resumeBlockedBy: "reconcile-required" }));
    expect(one.sub).toBe(`вкл. до $0.070 за 1${NBSP}прерванный запрос — до сверки`);
    expect(one.label).toBe(`Потрачено $1.25 из $4.14, из них до $0.070 за 1${NBSP}прерванный запрос — до сверки`);
    const many = spentBlock(paused("quit", { inFlight: NONE, unsettled: { requests: 5, openMicros: 350_000 }, resumeBlockedBy: "reconcile-required" }));
    expect(many.sub).toBe(`вкл. до $0.35 за 5${NBSP}прерванных запросов — до сверки`);
    expect(spentBlock(paused("quit", { inFlight: NONE, unsettled: { requests: 21, openMicros: 350_000 } })).sub).toBe(`вкл. до $0.35 за 21${NBSP}прерванный запрос — до сверки`);
  });

  test("the owner's own pause, or a network hold kept over a restart: the requests had no answer, they were not cut off", () => {
    expect(spentBlock(paused("owner", { inFlight: NONE, unsettled: { requests: 4, openMicros: 280_000 }, resumeBlockedBy: "network" })).sub).toBe(`вкл. до $0.28 за 4${NBSP}запроса без ответа — до сверки`);
    const kept = paused("quit", { inFlight: NONE, unsettled: { requests: 4, openMicros: 280_000 }, resumeBlockedBy: "network", paidHold: hold("network", { detail: { drops: 3, attempt: 2, nextAt: null } }) });
    expect(spentBlock(kept).sub).toBe(`вкл. до $0.28 за 4${NBSP}запроса без ответа — до сверки`);
    expect(spentBlock(kept).label).toBe(`Потрачено $1.25 из $4.14, из них до $0.28 за 4${NBSP}запроса без ответа — до сверки`);
  });

  test("the line and the bar's label name one figure: the hatched part, never more than «Потрачено» holds", () => {
    // The contract keeps the open reserves inside `spentMicros`; the card's H1 interim takes `spentMicros` from `autopilot.get` over an announced view, so the
    // two can disagree for a moment — drawn and said capped, the same in both places.
    const announced = paused("quit", { inFlight: NONE, unsettled: { requests: 4, openMicros: 280_000 }, resumeBlockedBy: "reconcile-required" });
    const block = spentBlock({ ...announced, spentMicros: 250_000, remainingMicros: 3_890_000 });
    expect(block.sub).toBe(`вкл. до $0.25 за 4${NBSP}прерванных запроса — до сверки`);
    expect(block.label).toBe(`Потрачено $0.25 из $4.14, из них до $0.25 за 4${NBSP}прерванных запроса — до сверки`);
  });

  test("requests in flight keep their words («в работе, по худшей цене до ответа»), and their label", () => {
    const block = spentBlock(launch({ inFlight: { requests: 4, openMicros: 280_000 }, unsettled: NONE }));
    expect(block.sub).toBe(`вкл. до $0.28 — 4${NBSP}запроса в работе, по худшей цене до ответа`);
    expect(block.label).toBe("Потрачено $1.25 из $4.14, из них до $0.28 — запросы в работе");
  });
});

describe("S4.9d: the one «бесплатно» rule, and «из $0» for an A2 breach (S4.9c N2, N3)", () => {
  const FREE = { acceptedMicros: 0, plannedWorstMicros: 0, plannedExpectedMicros: 0, remainingMicros: 0, inFlight: { requests: 0, openMicros: 0 } };
  const ENDED = { status: "done", endedAt: "2026-10-08T14:31:00.000Z", paused: null };

  test("«Потрачено»: free only when nothing was planned AND nothing spent; a spend over a W′ of 0 shows the engine's figures «из $0»", () => {
    expect(spentBlock(launch({ ...FREE, spentMicros: 0 }))).toMatchObject({ spent: null, of: "бесплатно", label: "Потрачено: ничего — запуск бесплатный" });
    const breach = spentBlock(launch({ ...FREE, spentMicros: 300_000 }));
    expect(breach).toMatchObject({ spent: "$0.30", of: "из $0", label: "Потрачено $0.30 из $0" });
    // Planned, nothing spent yet: never «бесплатно».
    expect(spentBlock(launch({ spentMicros: 0, inFlight: { requests: 0, openMicros: 0 } }))).toMatchObject({ of: "из $4.14" });
  });

  test("the folded line of an ended card (1200): the same rule", () => {
    const span = /\d\d:\d\d–\d\d:\d\d$/;
    const free = endedLine(launch({ ...FREE, ...ENDED, spentMicros: 0 }));
    expect(free).toMatch(/^10 из 20 видео · бесплатно · /);
    expect(free).toMatch(span);
    expect(endedLine(launch({ ...FREE, ...ENDED, spentMicros: 300_000 }))).toMatch(/^10 из 20 видео · \$0\.30 из \$0 · \d\d:\d\d–\d\d:\d\d$/);
    expect(endedLine(launch({ ...ENDED, spentMicros: 1_690_000 }))).toMatch(/^10 из 20 видео · \$1\.69 из \$4\.14 · /);
  });

  test("a stopped launch's line and «Продолжить» of a free one say the same of the money", () => {
    const stopped = { status: "stopped", endedAt: "2026-10-08T14:09:00.000Z", paused: null };
    expect(headerSub(launch({ ...FREE, ...stopped, spentMicros: 0 }), "stopped", nameOf)).toBe(`10 из 20${NBSP}видео готовы.`);
    expect(headerSub(launch({ ...FREE, ...stopped, spentMicros: 300_000 }), "stopped", nameOf)).toBe(`10 из 20${NBSP}видео готовы. Потрачено $0.30 из $0.`);
  });
});

describe("S4.9d: log tones as the design colours them (item 2, LaunchStates «Журнал»)", () => {
  test("a slot that used up its tries and a launch made smaller are orange (warn), not plain", () => {
    expect(logText(LogLine.parse(logLine("photo-failed")), true).tone).toBe("warn");
    expect(logText(LogLine.parse(logLine("degrade")), true).tone).toBe("warn");
    expect(logText(LogLine.parse(logLine("degrade", { fewerVideos: 0 })), true).tone).toBe("warn");
    // Their neighbours on the sheet stay plain.
    expect(logText(LogLine.parse(logLine("photo-retry")), true).tone).toBe("plain");
    expect(logText(LogLine.parse(logLine("video-done")), true).tone).toBe("plain");
  });
});

describe("S4.9d: the export folder's wait only while the launch runs (item 6, S4.9b note)", () => {
  const FREE_HOLD = { reason: "export", at: "2026-10-08T14:02:00.000Z", detail: { exportReason: "missing", neededBytes: null, freeBytes: null } };

  test("running: the notice; pausing, paused, stopping, ended: none of it, and the sidebar does not say «ждёт»", () => {
    expect(liveNote(launch({ freeHold: FREE_HOLD }), "running", nameOf)?.id).toBe("free-export-missing");
    expect(liveNote(launch({ freeHold: FREE_HOLD }), "pausing", nameOf)).toBeNull();
    expect(liveNote(launch({ freeHold: FREE_HOLD, status: "stopping" }), "stopping", nameOf)).toBeNull();
    expect(liveNote(paused("owner", { freeHold: FREE_HOLD }), "paused", nameOf)).toBeNull();
    expect(liveNote(paused("quit", { freeHold: FREE_HOLD }), "paused", nameOf)?.id).toBe("restart-quit");
    expect(sidebarMark(paused("owner", { freeHold: FREE_HOLD }), null)?.text).toBe("пауза");
    expect(sidebarMark(launch({ freeHold: FREE_HOLD }), null)?.text).toBe("ждёт");
  });
});

describe("S4.9d: «Остановить запуск?» lists the sets that change first (S4.9b L4, ApStopConfirm)", () => {
  test("a set back on «Фото» and a set drawn in part before an avatar whose nothing changes; the launch's order kept inside each", () => {
    const E = "avatar-elena-0003";
    const N = "avatar-nora-0004";
    const l = launch({
      draft: { ...baseView.draft, avatarIds: [A, B, E, N] },
      avatars: [
        libraryRow(A),
        row(B, { phase: "awaiting-review", slice: null, photos: { done: 0, total: 14 } }),
        row(E, { slice: { index: 1, total: 1 }, photos: { done: 3, total: 5 }, undrawnScenes: 0, resumableSlots: 2 }),
        row(N, { phase: "montage", photos: { done: 14, total: 14 }, undrawnScenes: 0, resumableSlots: 0 }),
      ],
    });
    const names: Record<string, string> = { [A]: "Mia", [B]: "Sofia", [E]: "Elena", [N]: "Nora" };
    expect(stopSetLines(l, (id) => names[id] ?? "?").map((s) => `${s.name}: ${s.phase}`)).toEqual(["Sofia: ждёт проверки", "Elena: рисуется 3 из 5", "Mia: только библиотека", "Nora: нарисован"]);
  });
});

// ---------- S4.9d review LOWs ----------

describe("S4.9d review LOWs on the card's money", () => {
  const NONE = { requests: 0, openMicros: 0 };
  const OPEN = { requests: 4, openMicros: 280_000 };
  const FREE = { acceptedMicros: 0, plannedWorstMicros: 0, plannedExpectedMicros: 0, remainingMicros: 0, inFlight: NONE };

  test("L1: while the H1 interim stands, the open reserves come from the same answer as the spend — a reconcile done reads «до сверки» no more", () => {
    const announced = paused("quit", { inFlight: NONE, unsettled: OPEN, resumeBlockedBy: "reconcile-required" });
    const answer = paused("quit", { inFlight: NONE, unsettled: NONE, resumeBlockedBy: null });
    const shown = askedView(announced, answer);
    expect([shown.resumeBlockedBy, shown.spentMicros, shown.remainingMicros]).toEqual([null, answer.spentMicros, answer.remainingMicros]);
    expect(shown.unsettled).toEqual(NONE);
    expect(spentBlock(shown).sub).toBeNull();
    // A running launch's requests in flight are the answer's too.
    const flying = askedView(launch({ inFlight: OPEN }), launch({ inFlight: { requests: 1, openMicros: 70_000 } }));
    expect(flying.inFlight).toEqual({ requests: 1, openMicros: 70_000 });
  });

  test("L3: «Сначала сверка» names the ceiling of the cut-off requests, as ApPausedReconcile does (and as the network hold's banner does)", () => {
    const cut = liveNote(paused("quit", { inFlight: NONE, unsettled: OPEN, resumeBlockedBy: "reconcile-required", logTail: [logLine("host-quit")] }), "paused", nameOf);
    expect(cut?.text).toBe(`Studio закрылся, когда 4${NBSP}запроса были в работе. Пока OpenRouter не сверен, они считаются по худшей цене — до $0.28, — и запуск не продолжить.`);
    const unnamed = liveNote(paused("quit", { inFlight: NONE, unsettled: OPEN, resumeBlockedBy: "reconcile-required" }), "paused", nameOf);
    expect(unnamed?.text).toBe("В журнале расходов остались запросы прошлого запуска Studio. Пока OpenRouter не сверен, они считаются по худшей цене — до $0.28, — и запуск не продолжить.");
    // Nothing unsettled (or a view from before `unsettled`): no sum is claimed.
    expect(liveNote(paused("quit", { inFlight: NONE, unsettled: NONE, resumeBlockedBy: "reconcile-required", logTail: [logLine("host-quit")] }), "paused", nameOf)?.text).toBe(
      `Studio закрылся, когда 4${NBSP}запроса были в работе. Пока OpenRouter не сверен, они считаются по худшей цене, и запуск не продолжить.`,
    );
  });

  test("L10: a paused launch reads «бесплатный» only when nothing was planned and nothing spent; an A2 breach says it may spend nothing more", () => {
    expect(headerSub(paused("owner", { ...FREE, spentMicros: 0 }), "paused", nameOf)).toBe("Ничего не рендерится. «Продолжить» соберёт остальные видео — запуск бесплатный.");
    expect(headerSub(paused("owner", { ...FREE, spentMicros: 300_000 }), "paused", nameOf)).toBe(
      "Ничего не тратится и не рендерится. «Продолжить» не разрешит новых трат — от предела $0 ничего не осталось.",
    );
    expect(resumeTitle(0, 0, 0)).toBe("Продолжить · бесплатно");
    expect(resumeTitle(0, 0, 300_000)).toBe("Продолжить · без трат");
  });

  test("L11: «$0.30 из $0» fills the bar, as the month's bar does with a spend over a budget of 0; a spend over W′ never draws past the end", () => {
    const breach = spentBlock(paused("owner", { ...FREE, spentMicros: 300_000 }));
    expect([breach.settledPct, breach.openPct]).toEqual([100, 0]);
    const over = spentBlock({ ...paused("owner", { inFlight: NONE, unsettled: { requests: 1, openMicros: 70_000 } }), plannedWorstMicros: 1_000_000, spentMicros: 1_400_000 });
    expect(over.settledPct + over.openPct).toBe(100);
    expect(over.openPct).toBe(5);
  });
});

