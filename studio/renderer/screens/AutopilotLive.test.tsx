import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import {
  ERROR_MESSAGES_RU,
  LaunchView,
  PRICE_SCOPES_RU,
  type AvatarSummary,
  type LaunchAvatarView,
  type LaunchDraftInput,
  type LogLine,
  type PhotoSummary,
} from "../../shared/engine";
import type { EngineClient } from "../engine/client";
import type { MockEngine } from "../engine/mockEngine";
import type { ManualScheduler } from "../engine/scheduler";
import { freePhotos, MIA, SOFIA } from "../engine/mockEngine.testkit";
import { formatUsdTiered } from "../lib/money";
import { callsOf, describeElement, flush, openSection, setup } from "../testing";

// S4.9b: the live launch card of «Автопилот» against the mock engine (AutopilotS4.dc.html, states review-wait … paused-reviewed; LaunchStates; plan §3.5–§3.8,
// §4.6–§4.8, §18). The mock moves a launch only by the owner's clicks (pause, resume, stop, the review hand-off); every other state the engine can send — a
// hold, «Ставим на паузу…», a restart, the log — is announced through the contract (`MockEngine.announceLaunch`, parsed by `LaunchView`) on top of the
// mock's own launch, so the commands the card sends still reach the mock.

const NBSP = "\u00a0";
const ELENA: AvatarSummary = { ...MIA, avatarId: "avatar-elena-0004", name: "Elena", masterPhotoId: "photo-elena-master" };
const AT = "2026-10-08T14:06:00.000Z";

function library(extra: readonly AvatarSummary[] = []): { avatars: AvatarSummary[]; photos: PhotoSummary[] } {
  const counts: Record<string, number> = { [MIA.avatarId]: 31, [SOFIA.avatarId]: 4, [ELENA.avatarId]: 14 };
  const roster = [MIA, SOFIA, ELENA, ...extra];
  return {
    avatars: roster.map((a) => ({ ...a, photoCount: counts[a.avatarId] ?? 6, eligibleUnusedCount: counts[a.avatarId] ?? 6 })),
    photos: roster.flatMap((a) => freePhotos(counts[a.avatarId] ?? 6, a)),
  };
}

afterEach(() => {
  const hd: unknown = Reflect.get(window, "happyDOM");
  const setViewport: unknown = hd !== null && typeof hd === "object" ? Reflect.get(hd, "setViewport") : null;
  if (typeof setViewport === "function") Reflect.apply(setViewport, hd, [{ width: 1024, height: 768 }]);
});


interface Started {
  readonly engine: MockEngine;
  readonly client: EngineClient;
  readonly launch: LaunchView;
  readonly scheduler: ManualScheduler;
}

/** The mock with Mia (31 free photos), Sofia (4) and Elena (14), a launch of the three started through the engine, and «Автопилот» open. */
async function started({ review = false, extra = [] as readonly AvatarSummary[], videos = 10, libraryOn = true } = {}): Promise<Started> {
  // S4.8: the card's states are announced through the contract over the mock's CANNED launch (a mid-run state that moves only by clicks); the mock now runs one by default.
  const { engine, client, scheduler } = setup({ ...library(extra), sceneReview: "off", launchRun: "canned" });
  engine.setRunImagePrice(70_000);
  await flush();
  const draft: LaunchDraftInput = {
    avatarIds: [MIA.avatarId, SOFIA.avatarId, ELENA.avatarId, ...extra.map((a) => a.avatarId)],
    videosPerAvatar: videos,
    mix: { single: 70, collage: 20, slides: 10 },
    categories: ["home"],
    poses: { profile: false, back: false },
    library: libraryOn,
    generate: true,
    sceneReview: review,
    stickers: false,
  };
  let launch: LaunchView | null = null;
  await act(async () => {
    const estimate = await client.request("autopilot.estimate", { draft });
    if (!estimate.ok) throw new Error(`estimate refused: ${estimate.error.code}`);
    const reply = await client.request("autopilot.start", { draft: { ...draft, planSeed: estimate.result.preview.planSeed }, acceptedWorstMicros: estimate.result.preview.estimate.worstMicros });
    if (!reply.ok) throw new Error(`start refused: ${reply.error.code}`);
    launch = reply.result.launch;
  });
  await openSection("Автопилот");
  await screen.findByRole("heading", { level: 1, name: "Автопилот" });
  await flush();
  if (launch === null) throw new Error("no launch");
  return { engine, client, launch, scheduler };
}

/** The engine's word on the launch, as the contract lets it be: `over` on top of `base`, with R kept W′ − spent. */
function vary(base: LaunchView, over: Record<string, unknown>): LaunchView {
  const merged = { ...base, ...over };
  const worst = typeof merged.plannedWorstMicros === "number" ? merged.plannedWorstMicros : base.plannedWorstMicros;
  const spent = typeof merged.spentMicros === "number" ? merged.spentMicros : base.spentMicros;
  return LaunchView.parse({ ...merged, remainingMicros: Math.max(0, worst - spent) });
}

/** The design's launch: $4.14 accepted, $1.25 spent, 4 requests in flight ($0.28 at worst). */
const money = { acceptedMicros: 4_140_000, plannedWorstMicros: 4_140_000, plannedExpectedMicros: 1_340_000, spentMicros: 1_250_000, inFlight: { requests: 4, openMicros: 280_000 } };

const rowOf = (launch: LaunchView, avatarId: string, over: Partial<LaunchAvatarView>): LaunchAvatarView => {
  const row = launch.avatars.find((a) => a.avatarId === avatarId);
  if (row === undefined) throw new Error(`no row of ${avatarId}`);
  return { ...row, ...over };
};

/** Mia montaging library photos, Sofia drawing her first batch (9 of 14), Elena montaging. */
function designRows(launch: LaunchView): LaunchAvatarView[] {
  return [
    rowOf(launch, MIA.avatarId, { phase: "montage", photos: { done: 0, total: 0 }, sceneSetId: null, setRevision: null, scenes: null, scenesWithoutText: null, continuePhotos: null, slice: null, undrawnScenes: 0, resumableSlots: 0, drawAllocationMicros: null }),
    rowOf(launch, SOFIA.avatarId, { phase: "drawing", photos: { done: 9, total: 14 }, sceneSetId: "set-sofia-00000001", setRevision: 2, scenes: 14, scenesWithoutText: 0, continuePhotos: 14, slice: { index: 1, total: 1 }, undrawnScenes: 0, resumableSlots: 5, drawAllocationMicros: 2_940_000 }),
    rowOf(launch, ELENA.avatarId, { phase: "montage", photos: { done: 5, total: 5 }, sceneSetId: "set-elena-00000001", setRevision: 1, scenes: 5, scenesWithoutText: 0, continuePhotos: 5, slice: null, undrawnScenes: 0, resumableSlots: 0, drawAllocationMicros: 1_050_000 }),
  ];
}

function announce(engine: MockEngine, view: LaunchView): void {
  act(() => engine.announceLaunch(view));
}

const card = (): HTMLElement => {
  const live = document.getElementById("ap-live");
  if (live === null) throw new Error("no live card");
  return live;
};
const button = (name: string | RegExp): HTMLElement => within(card()).getByRole("button", { name });
const resumeButton = (): HTMLElement => within(card()).getByRole("button", { name: /^Продолжить · / });
const descriptionOf = (el: HTMLElement): string =>
  (el.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .filter((id) => id !== "")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" ");
/** The card's notice by its title, read exactly (no-break spaces and all). */
const noteTitled = (title: string): HTMLElement => {
  const found = Array.from(card().querySelectorAll<HTMLElement>(".notice-title"))
    .filter((t) => t.textContent === title)
    .map((t) => t.closest<HTMLElement>(".notice"))
    .find((n) => n !== null);
  if (found === undefined || found === null) throw new Error(`no notice «${title}»`);
  return found;
};
const line = (kind: string, fields: Record<string, unknown>, avatarId?: string, at = AT): LogLine => ({ at, kind, ...(avatarId === undefined ? {} : { avatarId }), ...fields }) as LogLine;

describe("the live card while the launch runs (ApRunning)", () => {
  test("the status, since when and how long, «Потрачено $S из $W′» with the requests in flight, the rows and the log, newest first", async () => {
    const { engine, launch } = await started();
    announce(
      engine,
      vary(launch, {
        ...money,
        activeMs: 161_000,
        avatars: designRows(launch),
        logTail: [line("start", { acceptedMicros: 4_140_000 }), line("photo", { done: 9, total: 14, faceCos: 0.84 }, SOFIA.avatarId)],
      }),
    );
    expect(within(card()).getByRole("heading", { level: 2, name: "Идёт запуск" })).toBeDefined();
    expect(card().querySelector(".ap-live-meta")?.textContent).toMatch(/^с \d\d:\d\d · 2:4\d$/);
    expect(card().querySelector(".ap-spent-value")?.textContent).toBe("$1.25 из $4.14");
    expect(within(card()).getByText(`вкл. до $0.28 — 4${NBSP}запроса в работе, по худшей цене до ответа`.replace(NBSP, " "))).toBeDefined();
    expect(within(card()).getByRole("img", { name: "Потрачено $1.25 из $4.14, из них до $0.28 — запросы в работе" })).toBeDefined();
    const rows = within(card()).getAllByRole("row").slice(1);
    expect(rows.map((r) => r.querySelector(".ap-row-name")?.textContent)).toEqual(["Mia", "Sofia", "Elena"]);
    expect(rows.map((r) => r.querySelector(".ap-row-phase")?.textContent)).toEqual(["монтаж · фото из библиотеки", "рисуем фото · партия 1 из 1", "монтаж"]);
    expect(Array.from(rows[1]?.querySelectorAll(".ap-cell-text") ?? []).map((c) => c.textContent)).toEqual(["9 / 14", `${launch.avatars[1]?.montage.done ?? 0} / ${launch.avatars[1]?.montage.total ?? 0}`, `${launch.avatars[1]?.videos.done ?? 0} / ${launch.avatars[1]?.videos.total ?? 0}`]);
    const log = within(card()).getByRole("list", { name: "Журнал" });
    expect(Array.from(log.querySelectorAll("li")).map((li) => li.textContent?.replace(/^\d\d:\d\d:\d\d/, ""))).toEqual(["Sofia · фото 9 из 14 · лицо 0.84", "запуск принят · до $4.14"]);
    expect(button("Пауза").getAttribute("aria-disabled")).toBeNull();
    expect(button("Стоп").getAttribute("aria-disabled")).toBeNull();
    expect(within(card()).queryByRole("button", { name: /^Продолжить/ }) === null).toBe(true);
  });

});

describe("«Пауза» and «Продолжить · до $R»", () => {
  test("«Пауза» asks nothing; once paused the focus goes to «Продолжить · до $R», which sends exactly R; accepted, the focus is on «Идёт запуск»", async () => {
    const { engine, client, launch } = await started();
    const pause = button("Пауза");
    pause.focus();
    fireEvent.click(pause);
    await flush();
    expect(callsOf(engine, "autopilot.pause")).toHaveLength(1);
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
    await screen.findByRole("heading", { level: 2, name: "Запуск на паузе" });
    await waitFor(() => expect(describeElement(document.activeElement)).toBe(describeElement(resumeButton())));
    const now = await client.request("autopilot.get", { launchId: launch.launchId });
    if (!now.ok) throw new Error("get refused");
    const r = now.result.launch.remainingMicros;
    expect(resumeButton().textContent).toBe(`Продолжить · до ${formatUsdTiered(r, "up")}`);
    expect(
      within(card()).getByText(`Ничего не тратится и не рендерится. «Продолжить» разрешит запуску потратить ещё до ${formatUsdTiered(r, "up")} — остаток предела ${formatUsdTiered(launch.plannedWorstMicros, "up")}.`),
    ).toBeDefined();
    fireEvent.click(resumeButton());
    await flush();
    expect(callsOf(engine, "autopilot.resume")[0]?.payload).toEqual({ launchId: launch.launchId, acceptedRemainingMicros: r });
    const running = await screen.findByRole("heading", { level: 2, name: "Идёт запуск" });
    await waitFor(() => expect(describeElement(document.activeElement)).toBe(describeElement(running)));
  });

  test("R moved under the screen (PRICE_CHANGED): the engine's new R on the button, «Остаток пересчитан», the focus stays; the next click sends it", async () => {
    const { engine, client, launch } = await started();
    await act(async () => {
      await client.request("autopilot.pause", { launchId: launch.launchId });
    });
    const fresh = await client.request("autopilot.get", { launchId: launch.launchId });
    if (!fresh.ok) throw new Error("get refused");
    const real = fresh.result.launch;
    // The screen still holds an older word: more spent, so less left than the engine now says.
    announce(engine, vary(real, { spentMicros: real.spentMicros + 20_000 }));
    const stale = resumeButton().textContent;
    resumeButton().focus();
    fireEvent.click(resumeButton());
    await flush();
    await flush();
    expect(callsOf(engine, "autopilot.resume")[0]?.payload.acceptedRemainingMicros).toBe(real.remainingMicros - 20_000);
    expect(noteTitled("Остаток пересчитан").textContent).toMatch(/Было до \$[\d.]+, теперь до \$[\d.]+ — нажмите ещё раз\./);
    expect(resumeButton().textContent === stale).toBe(false);
    expect(describeElement(document.activeElement)).toBe(describeElement(resumeButton()));
    fireEvent.click(resumeButton());
    await flush();
    expect(callsOf(engine, "autopilot.resume")[1]?.payload.acceptedRemainingMicros).toBe(real.remainingMicros);
    await screen.findByRole("heading", { level: 2, name: "Идёт запуск" });
  });

  test("after a quit with requests in flight: «Продолжить» closed with its reason, «Сначала сверка» leads to Settings (ApPausedReconcile)", async () => {
    const { engine, client, launch } = await started();
    await act(async () => {
      await client.request("autopilot.pause", { launchId: launch.launchId });
    });
    announce(
      engine,
      vary(launch, {
        ...money,
        inFlight: { requests: 0, openMicros: 0 },
        // The four requests the quit cut off are open reserves with no request out: the engine tells them as `unsettled` (S4.6v).
        unsettled: { requests: 4, openMicros: 280_000 },
        status: "paused",
        paused: { cause: "quit", at: AT },
        resumeBlockedBy: "reconcile-required",
        avatars: designRows(launch),
        logTail: [line("host-quit", { requests: 4 }), line("app-restarted", { cause: "quit", requests: 4 })],
      }),
    );
    expect(card().querySelector(".ap-live-meta")?.textContent).toMatch(/^Studio был закрыт в \d\d:\d\d$/);
    const resume = resumeButton();
    expect(resume.textContent).toBe("Продолжить · до $2.89");
    expect(resume.getAttribute("aria-disabled")).toBe("true");
    expect(descriptionOf(resume)).toBe("Сверить можно через 2 минуты после последнего запроса. Потом «Продолжить» покажет новый остаток.");
    // S4.9d review L3: the banner names the ceiling, as ApPausedReconcile does.
    expect(noteTitled("Сначала сверка").textContent).toContain(`Studio закрылся, когда 4${NBSP}запроса были в работе. Пока OpenRouter не сверен, они считаются по худшей цене — до $0.28, — и запуск не продолжить.`);
    // Paused: nothing is in flight; the open reserves are inside «Потрачено», hatched and said once, from `unsettled`.
    expect(card().querySelector(".ap-spent-sub")?.textContent).toBe(`вкл. до $0.28 за 4${NBSP}прерванных запроса — до сверки`);
    expect(card().querySelector(".ap-spent-bar .ap-hatch")?.getAttribute("style")).toBe("width: 6.8%;");
    expect(within(card()).getByRole("img", { name: `Потрачено $1.25 из $4.14, из них до $0.28 за 4${NBSP}прерванных запроса — до сверки` })).toBeDefined();
    fireEvent.click(resume);
    await flush();
    expect(callsOf(engine, "autopilot.resume")).toHaveLength(0);
    fireEvent.click(within(noteTitled("Сначала сверка")).getByRole("button", { name: "Перейти к сверке" }));
    await flush();
    expect(screen.getByRole("heading", { level: 1, name: "Настройки" })).toBeDefined();
  });

  test("after a restart the reserves of the earlier process are hatched «за N прерванных запроса — до сверки» from `unsettled`, and a reconcile takes the line away (ApPausedReconcile)", async () => {
    const { engine, client, launch } = await started();
    await act(async () => {
      await client.request("autopilot.pause", { launchId: launch.launchId });
    });
    const restarted = { ...money, inFlight: { requests: 0, openMicros: 0 }, status: "paused", paused: { cause: "engine-restart", at: AT }, avatars: designRows(launch), resumeBlockedBy: "reconcile-required" } as const;
    announce(engine, vary(launch, { ...restarted, unsettled: { requests: 4, openMicros: 280_000 } }));
    expect(card().querySelector(".ap-spent-sub")?.textContent).toBe(`вкл. до $0.28 за 4${NBSP}прерванных запроса — до сверки`);
    announce(engine, vary(launch, { ...restarted, resumeBlockedBy: null, unsettled: { requests: 0, openMicros: 0 } }));
    expect(card().querySelector(".ap-spent-sub")?.textContent).toBeUndefined();
  });
});

describe("a paid click is sent once, and stays busy until the view says what it did (round 1 M4)", () => {
  async function pausedLaunch(review = false): Promise<Started> {
    const utils = await started({ review });
    await act(async () => {
      await utils.client.request("autopilot.pause", { launchId: utils.launch.launchId });
    });
    return utils;
  }

  test("two clicks on «Продолжить · до $R» before anything answers: one `autopilot.resume`", async () => {
    const { engine } = await pausedLaunch();
    fireEvent.click(resumeButton());
    fireEvent.click(resumeButton());
    await flush();
    expect(callsOf(engine, "autopilot.resume")).toHaveLength(1);
  });

  test("the reply came, the view has not yet: «Продолжить» stays busy and a click sends nothing; the view then lands", async () => {
    const { engine } = await pausedLaunch();
    engine.setDelivery(false);
    fireEvent.click(resumeButton());
    await flush();
    expect(callsOf(engine, "autopilot.resume")).toHaveLength(1);
    expect(within(card()).getByRole("heading", { level: 2, name: "Запуск на паузе" })).toBeDefined();
    expect(resumeButton().getAttribute("aria-busy")).toBe("true");
    expect(resumeButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(resumeButton());
    await flush();
    expect(callsOf(engine, "autopilot.resume")).toHaveLength(1);
    engine.setDelivery(true);
    act(() => engine.touchMoney());
    await flush();
    await screen.findByRole("heading", { level: 2, name: "Идёт запуск" });
  });

  test("«Продолжить запуск: M фото» on the card: two clicks send one; after the reply, before the view, none", async () => {
    const { engine } = await started({ review: true });
    const go = (): HTMLElement => within(noteTitled("Сцены Sofia ждут проверки")).getByRole("button", { name: /^Продолжить запуск/ });
    engine.setDelivery(false);
    fireEvent.click(go());
    fireEvent.click(go());
    await flush();
    expect(callsOf(engine, "autopilot.continueAfterReview")).toHaveLength(1);
    expect(go().getAttribute("aria-busy")).toBe("true");
    fireEvent.click(go());
    await flush();
    expect(callsOf(engine, "autopilot.continueAfterReview")).toHaveLength(1);
    engine.setDelivery(true);
    act(() => engine.touchMoney());
    await flush();
    await waitFor(() => expect(within(card()).queryAllByText("Сцены Sofia ждут проверки")).toHaveLength(0));
  });
});

// S4.8: the engine re-announces the current launch from `#emitMoney` and `#emitSettings` (S4.6w H1), and the mock now does the same. These two tests used to pin the engine's SILENCE
// (no `autopilot.changed` after a reconcile) that the card's interim fallback was written for; they now pin that the button still opens when the window is told, and the fallback's
// own tests (the card asks `autopilot.get` itself on a money change) are unchanged above and below.
describe("the engine tells the launch again after a money change (H1)", () => {
  test("a reconcile in Settings opens «Продолжить» on the card, and the window is told with a new `autopilot.changed`", async () => {
    const { engine, client, launch } = await started();
    // The ledger now wants a reconcile; the pause is the engine's last word on the launch, and it says so.
    act(() => engine.requireReconcile(["open-reserves"]));
    await act(async () => {
      await client.request("autopilot.pause", { launchId: launch.launchId });
    });
    const blocked = await client.request("autopilot.get", { launchId: launch.launchId });
    if (!blocked.ok) throw new Error("get refused");
    expect(blocked.result.launch.resumeBlockedBy).toBe("reconcile-required");
    await flush();
    expect(resumeButton().getAttribute("aria-disabled")).toBe("true");
    expect(noteTitled("Сначала сверка")).toBeDefined();
    const changed: string[] = [];
    const stop = client.subscribe((event) => {
      if (event.type === "autopilot.changed") changed.push(event.type);
    });
    await act(async () => {
      const done = await client.request("money.reconcile", {});
      if (!done.ok) throw new Error(`reconcile refused: ${done.error.code}`);
    });
    await flush();
    await waitFor(() => expect(resumeButton().getAttribute("aria-disabled")).toBeNull());
    expect(changed.length).toBeGreaterThan(0);
    stop();
    fireEvent.click(resumeButton());
    await flush();
    expect(callsOf(engine, "autopilot.resume")[0]?.payload.acceptedRemainingMicros).toBe(blocked.result.launch.remainingMicros);
  });

  test("the main path: «Перейти к сверке» → Settings → the reconcile → back to «Автопилот»: the button opens, and the launch was told again while the card was not on screen", async () => {
    const { engine, client, launch } = await started();
    act(() => engine.requireReconcile(["open-reserves"]));
    await act(async () => {
      await client.request("autopilot.pause", { launchId: launch.launchId });
    });
    await flush();
    expect(resumeButton().getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(within(noteTitled("Сначала сверка")).getByRole("button", { name: "Перейти к сверке" }));
    await flush();
    expect(screen.getByRole("heading", { level: 1, name: "Настройки" })).toBeDefined();
    const changed: string[] = [];
    const stop = client.subscribe((event) => {
      if (event.type === "autopilot.changed") changed.push(event.type);
    });
    await act(async () => {
      const done = await client.request("money.reconcile", {});
      if (!done.ok) throw new Error(`reconcile refused: ${done.error.code}`);
    });
    await flush();
    await openSection("Автопилот");
    await screen.findByRole("heading", { level: 1, name: "Автопилот" });
    await flush();
    await waitFor(() => expect(resumeButton().getAttribute("aria-disabled")).toBeNull());
    expect(card().querySelectorAll(".notice-title")).toHaveLength(0);
    expect(changed.length).toBeGreaterThan(0);
    stop();
  });
});

describe("M3 on the card: what closes «Продолжить» comes first, the hold said in it", () => {
  test("running, a credits hold while the key closes the button: the key's notice, the button in it closed by the key, the credits mentioned", async () => {
    const { engine, launch } = await started();
    announce(engine, vary(launch, { ...money, avatars: designRows(launch), paidHold: { reason: "credits", at: AT, detail: {} }, resumeBlockedBy: "key" }));
    const note = noteTitled("Ключ OpenRouter отклонён");
    expect(note.textContent).toContain("Ещё платная часть ждёт: пополнение баланса OpenRouter.");
    const resume = within(note).getByRole("button", { name: /^Продолжить/ });
    expect(resume.getAttribute("aria-disabled")).toBe("true");
    expect(descriptionOf(resume)).toBe("«Продолжить» откроется, когда ключ проверен.");
    expect(card().querySelectorAll(".ap-live-note")).toHaveLength(1);
  });
});

describe("the holds: each reason with its banner and its fix (LaunchStates «Продолжить», «Пока ждём»)", () => {
  async function held(hold: Record<string, unknown>, blocked: string | null, extra: Record<string, unknown> = {}) {
    const utils = await started();
    const rows = designRows(utils.launch).map((r) => (r.avatarId === SOFIA.avatarId ? { ...r, phase: "waiting" as const, waiting: { reason: "paid-hold" as const } } : r));
    announce(utils.engine, vary(utils.launch, { ...money, inFlight: { requests: 0, openMicros: 0 }, avatars: rows, paidHold: { at: AT, ...hold }, resumeBlockedBy: blocked, ...extra }));
    return utils;
  }

  test("budget: «Доделать партию Sofia: нужно до $1.05, свободно $0.18», «Открыть Настройки», «Продолжить» closed until the month has room (ApHoldBudget)", async () => {
    await held({ reason: "budget", detail: { freeMicros: 180_000, needMicros: 1_050_000, kind: "resume-slice" } }, "budget");
    const note = noteTitled("Ждёт бюджета");
    expect(note.getAttribute("role")).toBe("alert");
    expect(note.textContent).toContain("Доделать партию Sofia: нужно до $1.05, свободно $0.18. Поднимите бюджет или дождитесь 1 ноября (UTC). Монтаж из готовых фото идёт дальше.");
    const resume = within(note).getByRole("button", { name: "Продолжить · до $2.89" });
    expect(resume.getAttribute("aria-disabled")).toBe("true");
    expect(descriptionOf(resume)).toBe("«Продолжить» откроется, когда в месяце будет свободно $1.05.");
    // The header keeps «Пауза» and «Стоп» (decision 7): a hold is not a pause.
    expect(within(card()).getByRole("heading", { level: 2, name: "Идёт запуск" })).toBeDefined();
    expect(button("Пауза").getAttribute("aria-disabled")).toBeNull();
    expect(within(card()).getAllByRole("row")[2]?.querySelector(".ap-row-phase")?.textContent).toBe("ждёт бюджета · 9 из 14 фото");
    fireEvent.click(within(note).getByRole("button", { name: "Открыть Настройки" }));
    await flush();
    expect(screen.getByRole("heading", { level: 1, name: "Настройки" })).toBeDefined();
  });

  test("credits: «Продолжить» stays open (a 402 brings the hold back at no cost) and sends R", async () => {
    const { engine } = await held({ reason: "credits", detail: {} }, null);
    const note = noteTitled("Пополните баланс OpenRouter");
    expect(note.textContent).toContain("Если денег всё ещё нет, запуск снова встанет здесь — без лишних трат.");
    const resume = within(note).getByRole("button", { name: "Продолжить · до $2.89" });
    expect(resume.getAttribute("aria-disabled")).toBeNull();
    fireEvent.click(resume);
    await flush();
    expect(callsOf(engine, "autopilot.resume")[0]?.payload.acceptedRemainingMicros).toBe(2_890_000);
  });

  test("key, halt, price, prices not loaded: each its own words and its fix", async () => {
    const { engine, launch } = await held({ reason: "key", detail: {} }, "key");
    expect(within(noteTitled("Ключ OpenRouter отклонён")).getByRole("button", { name: "Открыть Настройки" })).toBeDefined();
    expect(descriptionOf(within(noteTitled("Ключ OpenRouter отклонён")).getByRole("button", { name: /^Продолжить/ }))).toBe("«Продолжить» откроется, когда ключ проверен.");
    const again = (hold: Record<string, unknown>, blocked: string | null): void =>
      announce(engine, vary(launch, { ...money, inFlight: { requests: 0, openMicros: 0 }, avatars: designRows(launch), paidHold: { at: AT, ...hold }, resumeBlockedBy: blocked }));
    again({ reason: "halt", detail: { code: "SETTLE_ABOVE_WORST" } }, "halt");
    expect(noteTitled("Расходы остановлены").textContent).toContain("Запрос стоил больше своей худшей цены — Studio остановил все платные запросы. Сверка проверит журнал и снимет остановку.");
    expect(within(noteTitled("Расходы остановлены")).getByRole("button", { name: "Перейти к сверке" })).toBeDefined();
    again({ reason: "price", detail: { stage: "slice", fromPhotos: 5, toPhotos: 0 } }, null);
    expect(within(noteTitled("Цена выросла")).getByRole("button", { name: /^Продолжить/ }).getAttribute("aria-disabled")).toBeNull();
    again({ reason: "price-unavailable", detail: { attempt: 2, nextAt: "2026-10-08T14:21:00.000Z" } }, null);
    expect(within(card()).getByText("Без цены запуск не тратит. Повтор 2 из 3. Монтаж из готовых фото идёт дальше.")).toBeDefined();
    expect(within(card()).queryByRole("button", { name: /^Продолжить/ }) === null).toBe(true);
    again({ reason: "price-unavailable", detail: { attempt: 3, nextAt: null } }, null);
    expect(within(noteTitled("Цены OpenRouter не загрузились")).getByRole("button", { name: /^Продолжить/ }).getAttribute("aria-disabled")).toBeNull();
  });

});

describe("the review hand-off", () => {
  test("scenes waiting: the notice and the row; «Продолжить запуск: M фото» sends the view's set and revision, and the avatar draws (ApReviewWait)", async () => {
    const { engine } = await started({ review: true });
    const note = noteTitled("Сцены Sofia ждут проверки");
    expect(note.getAttribute("role")).toBe("status");
    const sofia = within(card()).getAllByRole("row").find((r) => r.querySelector(".ap-row-name")?.textContent === "Sofia");
    expect(sofia?.querySelector(".ap-row-phase")?.textContent ?? "").toMatch(/^ждёт проверки сцен · \d+$/);
    expect(within(sofia ?? card()).getByRole("button", { name: "Открыть «Фото» · Sofia" })).toBeDefined();
    const go = within(note).getByRole("button", { name: /^Продолжить запуск: \d+\sфото$/ });
    fireEvent.click(go);
    await flush();
    const [sent] = callsOf(engine, "autopilot.continueAfterReview");
    expect(sent?.payload).toMatchObject({ avatarId: SOFIA.avatarId, revision: 1 });
    expect(sent?.payload.sceneSetId).toMatch(/^set-mock-/);
    await waitFor(() => expect(within(card()).queryAllByText("Сцены Sofia ждут проверки")).toHaveLength(0));
    expect(sofia?.querySelector(".ap-row-phase")?.textContent ?? "").toMatch(/^рисуем фото/);
  });

  // S5.9g round 3 (plan s5a3 gap D): «Продолжить запуск» refused for the 2K tier alone says state 55's sentence on the card, not the general price text.
  test("refused for a missing 2K tier (priceScope «bold»): state 55's warning, never the general price text", async () => {
    const { engine } = await started({ review: true });
    engine.failNext("autopilot.continueAfterReview", { code: "PRICE_UNAVAILABLE", priceScope: "bold", detail: "the price list has no 2K tier" });
    fireEvent.click(within(noteTitled("Сцены Sofia ждут проверки")).getByRole("button", { name: /^Продолжить запуск: \d+\sфото$/ }));
    await flush();
    const notice = within(card()).getByText(PRICE_SCOPES_RU.bold);
    expect(notice.closest(".notice")?.classList.contains("notice-warn")).toBe(true);
    expect(within(card()).queryByText(ERROR_MESSAGES_RU.PRICE_UNAVAILABLE) === null).toBe(true);
  });

});

describe("the end of a launch", () => {
  test("done: «Запуск завершён» with its span; at 1200 one line of figures, at 1440 the outcome and «Потрачено» (ApDone)", async () => {
    const { engine, launch } = await started();
    const done = vary(launch, {
      ...money,
      inFlight: { requests: 0, openMicros: 0 },
      spentMicros: 1_690_000,
      status: "done",
      endedAt: "2026-10-08T14:31:00.000Z",
      plan: { ...launch.plan, videos: 30 },
      avatars: launch.avatars.map((r) => ({ ...r, phase: "done" as const, waiting: null, videos: { done: r.videos.total, total: r.videos.total }, montage: { done: r.montage.total, total: r.montage.total } })),
    });
    announce(engine, done);
    expect(within(card()).getByRole("heading", { level: 2, name: "Запуск завершён" })).toBeDefined();
    expect(within(card()).queryByRole("button", { name: "Стоп" }) === null).toBe(true);
    // S4.9c fix round 1 (ApDone at 1200): the span is in the folded line, so the header holds the title and «Результаты · N» on one row.
    expect(card().querySelector(".ap-live-line")?.textContent).toMatch(/^\d+ из 30 видео · \$1\.69 из \$4\.14 · \d\d:\d\d–\d\d:\d\d$/);
    expect(card().querySelector(".ap-live-meta") === null).toBe(true);
    expect(within(card()).getByRole("button", { name: /^Результаты · \d+$/ })).toBeDefined();
  });
});

describe("S4.10 fix C (M2): a pause, stop or resume the engine refuses because the launch moved on", () => {
  const MOVED = "Состояние запуска уже изменилось — посмотрите карточку.";
  const alertText = (): string => within(card()).queryAllByRole("alert").map((a) => a.textContent ?? "").join(" | ");


  test("«Продолжить · до $R» refused with a VALIDATION: the same words and a fresh read; the button is not left busy, the focus on the heading", async () => {
    const { engine, client, launch } = await started();
    await act(async () => {
      await client.request("autopilot.pause", { launchId: launch.launchId });
    });
    engine.failNext("autopilot.resume", { code: "VALIDATION", detail: "the month has 0 µ$ of room, the held step needs 1050000 µ$" });
    const gets = callsOf(engine, "autopilot.get").length;
    resumeButton().focus();

    fireEvent.click(resumeButton());
    await flush();
    await flush();

    expect(alertText()).toContain(MOVED);
    expect(callsOf(engine, "autopilot.get").length).toBeGreaterThan(gets);
    expect(resumeButton().getAttribute("aria-busy")).toBeNull();
    expect(describeElement(document.activeElement)).toBe(describeElement(within(card()).getByRole("heading", { level: 2, name: "Запуск на паузе" })));
  });

});

