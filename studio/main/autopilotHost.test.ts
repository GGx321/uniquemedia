import { describe, expect, test } from "bun:test";
import { COMMAND_TYPES, ENGINE_COMMAND_TYPES, EventMessage, HOST_ASLEEP_DETAIL, LaunchView, MAIN_ONLY_COMMANDS, PROTOCOL_VERSION, type CommandType, type EngineCommandMessage, type ResponseMessage } from "../shared/engine";
import { heldWhileAsleep } from "../shared/engine";
import { formatUsdTiered } from "../shared/engine/usd";
import { A, B, avatarRow, budgetHold, libraryRow, NOW, view as baseView, viewWith } from "../shared/engine/autopilot.fixtures";
import { useNativeGlobals } from "../testing/nativeGlobals";
import {
  AutopilotHost,
  DEFAULT_HOST_POLICY,
  gateWhileAsleep,
  holdsPowerBlocker,
  launchHasWork,
  notificationsFor,
  reopensWindowAfterStay,
  quitDialogOf,
  quitQuestionOf,
  watchPower,
  type HostPolicy,
  type NotificationTarget,
  type PowerMonitorPort,
  type QuitDialogSpec,
} from "./autopilotHost";
useNativeGlobals();

// S4.7 on main with fakes: the power blocker, the quit question, the notifications, the sleep. Nothing here touches Electron.

const launch = (over: Record<string, unknown> = {}): LaunchView => LaunchView.parse(viewWith(over));
const running = baseView; // two avatars, 4 requests in flight, A drawing, B montaging
const idleRunning = (over: Record<string, unknown> = {}): LaunchView =>
  launch({ inFlight: { requests: 0, openMicros: 0 }, ...over });
const paused = (cause: "owner" | "quit" | "engine-restart", over: Record<string, unknown> = {}): LaunchView =>
  launch({ status: "paused", paused: { cause, at: NOW }, inFlight: { requests: 0, openMicros: 0 }, ...over });
const ended = (status: "done" | "stopped"): LaunchView =>
  launch({ status, endedAt: NOW, inFlight: { requests: 0, openMicros: 0 }, avatars: [avatarRow(A, { phase: "done", videos: { done: 10, total: 10 } }), avatarRow(B, { phase: "done", videos: { done: 8, total: 10 } })] });
/** Both rows of the draft; the second rests unless told otherwise (a launch's rows are always the draft's avatars). */
const both = (first: Record<string, unknown>, second: Record<string, unknown> = { phase: "done" }) => [avatarRow(A, first), avatarRow(B, second)];
const reviewRow = (avatarId: string, over: Record<string, unknown> = {}) => avatarRow(avatarId, { phase: "awaiting-review", slice: null, scenes: 14, scenesWithoutText: 2, ...over });

const changed = (launchView: LaunchView): EventMessage =>
  EventMessage.parse({ v: PROTOCOL_VERSION, id: "evt-00000001", kind: "event", seq: 1, bootId: "boot-00000001", type: "autopilot.changed", payload: { launch: launchView } });

interface Rig {
  host: AutopilotHost;
  blocker: { starts: number; stops: number[]; held: () => number };
  shown: { title: string; body: string; click: () => void }[];
  opened: NotificationTarget[];
  power: string[];
  asked: QuitDialogSpec[];
  focused: { value: boolean };
  pressed: { value: number };
  names: Map<string, string>;
  clock: { value: number };
  logs: string[];
}

function rig(policy: Partial<HostPolicy> = {}, platform: NodeJS.Platform = "darwin"): Rig {
  const blockerState = { starts: 0, stops: [] as number[], live: new Set<number>() };
  const shown: Rig["shown"] = [];
  const opened: NotificationTarget[] = [];
  const power: string[] = [];
  const asked: QuitDialogSpec[] = [];
  const focused = { value: false };
  const pressed = { value: 0 };
  const names = new Map<string, string>([[A, "Mia"], [B, "Sofia"]]);
  const clock = { value: 0 };
  const logs: string[] = [];
  const host = new AutopilotHost({
    blocker: {
      start: () => {
        blockerState.starts += 1;
        blockerState.live.add(blockerState.starts);
        return blockerState.starts;
      },
      stop: (id) => {
        blockerState.stops.push(id);
        blockerState.live.delete(id);
      },
    },
    notifier: { show: (n, click) => void shown.push({ ...n, click }) },
    dialog: {
      ask: async (spec) => {
        asked.push(spec);
        return pressed.value;
      },
    },
    isWindowFocused: () => focused.value,
    openWindow: (target) => void opened.push(target),
    avatarName: async (id) => names.get(id) ?? null,
    sendPower: (state) => void power.push(state),
    now: () => clock.value,
    platform,
    log: (line) => void logs.push(line),
    policy: { ...DEFAULT_HOST_POLICY, ...policy },
  });
  return { host, blocker: { get starts() { return blockerState.starts; }, stops: blockerState.stops, held: () => blockerState.live.size }, shown, opened, power, asked, focused, pressed, names, clock, logs };
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

describe("launchHasWork: the blocker's decision over the launch view", () => {
  test("a running launch with requests in flight has work", () => {
    expect(launchHasWork(running)).toBe(true);
  });

  test("a running launch whose avatars draw or montage has work even between two requests", () => {
    expect(launchHasWork(idleRunning())).toBe(true);
  });

  test("a launch that only waits for the owner's scene review has none: the Mac may sleep", () => {
    expect(launchHasWork(idleRunning({ avatars: [reviewRow(A), reviewRow(B)] }))).toBe(false);
  });

  test("an avatar that is planned, composing, drawing or montaging is work; resting phases are not", () => {
    const row = (phase: string): Record<string, unknown> => ({ phase, waiting: phase === "waiting" ? { reason: "avatar-busy" } : null, skipped: phase === "skipped" ? { reason: "archived" } : null });
    for (const phase of ["planned", "composing", "drawing", "montage"]) expect(launchHasWork(idleRunning({ avatars: both(row(phase)) }))).toBe(true);
    for (const phase of ["awaiting-review", "approved-waiting", "done", "skipped", "waiting"]) expect(launchHasWork(idleRunning({ avatars: both(row(phase)) }))).toBe(false);
  });

  test("a paid hold with nothing in flight has no work, unless free montage goes on through it", () => {
    const hold = { paidHold: { reason: "credits", at: NOW, detail: {} } };
    expect(launchHasWork(idleRunning({ ...hold, avatars: both({ phase: "drawing" }) }))).toBe(false);
    expect(launchHasWork(idleRunning({ ...hold, avatars: [avatarRow(A, { phase: "drawing" }), libraryRow(B)] }))).toBe(true);
  });

  test("a paid hold with a request still in flight has work", () => {
    expect(launchHasWork(launch({ paidHold: budgetHold, avatars: both({ phase: "drawing" }) }))).toBe(true);
  });

  test("a hold that retries by itself has work (its timer must not nap); one that waits for a person has none", () => {
    const retry = { reason: "network", at: NOW, detail: { drops: 1, attempt: 1, nextAt: "2026-10-08T14:03:00.000Z" } };
    const person = { reason: "network", at: NOW, detail: { drops: 3, attempt: 2, nextAt: null } };
    const drawing = both({ phase: "drawing" });
    expect(launchHasWork(idleRunning({ paidHold: retry, avatars: drawing }))).toBe(true);
    expect(launchHasWork(idleRunning({ paidHold: person, avatars: drawing }))).toBe(false);
  });

  test("a pause, a stop and an end are not work, even with requests still counted", () => {
    expect(launchHasWork(paused("owner"))).toBe(false);
    expect(launchHasWork(launch({ status: "pausing" }))).toBe(false);
    expect(launchHasWork(launch({ status: "stopping" }))).toBe(false);
    expect(launchHasWork(ended("done"))).toBe(false);
    expect(launchHasWork(ended("stopped"))).toBe(false);
  });

  test("holdWhileDraining (SP1 may flip it) also holds while a pause or stop drains requests, and only then", () => {
    const policy = { ...DEFAULT_HOST_POLICY, holdWhileDraining: true };
    expect(launchHasWork(launch({ status: "pausing" }), policy)).toBe(true);
    expect(launchHasWork(launch({ status: "stopping" }), policy)).toBe(true);
    expect(launchHasWork(launch({ status: "pausing", inFlight: { requests: 0, openMicros: 0 } }), policy)).toBe(false);
  });

  test("the switch for Q5 turns the blocker off whatever the launch does", () => {
    expect(holdsPowerBlocker([running], { ...DEFAULT_HOST_POLICY, powerBlocker: false })).toBe(false);
    expect(holdsPowerBlocker([running])).toBe(true);
    expect(holdsPowerBlocker([])).toBe(false);
  });
});

describe("the power blocker on main, with a fake powerSaveBlocker", () => {
  test("held while the launch runs with work, started once however many events come", () => {
    const r = rig();
    r.host.observe(changed(running));
    r.host.observe(changed(launch({ spentMicros: 1_300_000, remainingMicros: 2_840_000 })));
    expect(r.blocker.starts).toBe(1);
    expect(r.host.blockerHeld).toBe(true);
  });

  test("released on pause, taken again on resume, released on stop and on done", () => {
    const r = rig();
    r.host.observe(changed(running));
    r.host.observe(changed(paused("owner")));
    expect(r.blocker.held()).toBe(0);
    expect(r.blocker.stops).toEqual([1]);

    r.host.observe(changed(running));
    expect(r.blocker.held()).toBe(1);
    expect(r.blocker.starts).toBe(2);

    r.host.observe(changed(ended("stopped")));
    expect(r.blocker.held()).toBe(0);

    r.host.observe(changed(running));
    r.host.observe(changed(ended("done")));
    expect(r.blocker.held()).toBe(0);
    expect(r.blocker.stops).toEqual([1, 2, 3]);
  });

  test("released while a paid hold has nothing in flight and nothing free to do, taken again when it clears", () => {
    const r = rig();
    r.host.observe(changed(running));
    r.host.observe(changed(idleRunning({ paidHold: { reason: "credits", at: NOW, detail: {} }, avatars: both({ phase: "drawing" }) })));
    expect(r.blocker.held()).toBe(0);
    r.host.observe(changed(running));
    expect(r.blocker.held()).toBe(1);
  });

  test("released while the scenes wait for the owner's review", () => {
    const r = rig();
    r.host.observe(changed(running));
    r.host.observe(changed(idleRunning({ avatars: [reviewRow(A), reviewRow(B)] })));
    expect(r.blocker.held()).toBe(0);
  });

  test("released when the engine goes (a restart reads a running launch as paused), and not held for a view it can no longer vouch for", () => {
    const r = rig();
    r.host.observe(changed(running));
    r.host.engineGone();
    expect(r.blocker.held()).toBe(0);
    r.host.observe(changed(paused("engine-restart")));
    expect(r.blocker.held()).toBe(0);
  });

  test("released on quit and never taken again", () => {
    const r = rig();
    r.host.observe(changed(running));
    r.host.dispose();
    expect(r.blocker.held()).toBe(0);
    r.host.observe(changed(running));
    expect(r.blocker.held()).toBe(0);
    expect(r.blocker.starts).toBe(1);
  });

  test("Q5 = no: the blocker is never started", () => {
    const r = rig({ powerBlocker: false });
    r.host.observe(changed(running));
    expect(r.blocker.starts).toBe(0);
  });

  test("an event that is not the launch's changes nothing", () => {
    const r = rig();
    r.host.observe(EventMessage.parse({ v: PROTOCOL_VERSION, id: "evt-00000002", kind: "event", seq: 2, bootId: "boot-00000001", type: "money.reconcileNeeded", payload: { reasons: ["open-reserves"], unsettledMicros: 0 } }));
    expect(r.blocker.starts).toBe(0);
  });
});

describe("the quit question", () => {
  test("none without a launch, with a paused or an ended one", () => {
    expect(quitQuestionOf([])).toBeNull();
    expect(quitQuestionOf([paused("owner"), ended("done"), ended("stopped")])).toBeNull();
  });

  test("a running launch asks, with N = the live requests in flight, and the exact text of the plan", () => {
    const question = quitQuestionOf([running]);
    expect(question).toEqual({ kind: "running", requests: 4 });
    const dialog = quitDialogOf(question ?? { kind: "running", requests: 0 });
    expect(dialog.message).toBe("Идёт автопилот");
    expect(dialog.detail).toBe("Если выйти, запуск встанет на паузу. Запросы, которые сейчас в работе (4), прервутся и до сверки будут считаться по худшей цене.");
    expect(dialog.buttons).toEqual(["Остаться", "Выйти"]);
    expect(dialog.defaultId).toBe(0);
    expect(dialog.cancelId).toBe(0);
  });

  test("Windows closes the window and Studio exits with it: the plan's text in the design's words for that", () => {
    const dialog = quitDialogOf({ kind: "running", requests: 4 }, "win32");
    expect(dialog.message).toBe("Идёт автопилот");
    expect(dialog.detail).toBe("Если закрыть окно, Studio выйдет и запуск встанет на паузу. Запросы, которые сейчас в работе (4), прервутся и до сверки будут считаться по худшей цене.");
    expect(quitDialogOf({ kind: "running", requests: 0 }, "win32").detail).toBe("Если закрыть окно, Studio выйдет и запуск встанет на паузу. Запросов в работе нет — ничего не прервётся.");
    expect(quitDialogOf({ kind: "pausing", requests: 4 }, "win32").detail).toBe(quitDialogOf({ kind: "pausing", requests: 4 }).detail);
  });

  test("a running launch between two requests asks, and says nothing will be interrupted", () => {
    const question = quitQuestionOf([idleRunning()]);
    expect(question).toEqual({ kind: "running", requests: 0 });
    expect(quitDialogOf(question ?? { kind: "running", requests: 0 }).detail).toBe("Если выйти, запуск встанет на паузу. Запросов в работе нет — ничего не прервётся.");
  });

  test("a pause or a stop that still drains requests asks with its own words; one that drained does not", () => {
    expect(quitQuestionOf([launch({ status: "pausing" })])).toEqual({ kind: "pausing", requests: 4 });
    expect(quitQuestionOf([launch({ status: "stopping", inFlight: { requests: 2, openMicros: 100_000 } })])).toEqual({ kind: "stopping", requests: 2 });
    expect(quitQuestionOf([launch({ status: "pausing", inFlight: { requests: 0, openMicros: 0 } })])).toBeNull();
    expect(quitDialogOf({ kind: "pausing", requests: 4 }).message).toBe("Запросы автопилота ещё в работе");
    expect(quitDialogOf({ kind: "pausing", requests: 4 }).detail).toBe(
      "Запуск ставится на паузу, но 4 запроса ещё ждут ответа. Если выйти сейчас, они прервутся и до сверки будут считаться по худшей цене. Обычно ответы приходят за минуту.",
    );
    expect(quitDialogOf({ kind: "stopping", requests: 1 }).detail).toContain("но 1 запрос ещё ждёт ответа. Если выйти сейчас, он прервётся и до сверки будет считаться по худшей цене.");
    expect(quitDialogOf({ kind: "stopping", requests: 5 }).detail).toContain("но 5 запросов ещё ждут ответа");
    expect(quitDialogOf({ kind: "stopping", requests: 2 }).detail).toContain("Запуск останавливается");
    expect(quitDialogOf({ kind: "pausing", requests: 4 }).detail).toContain("Запуск ставится на паузу");
  });

  test("askWhileDraining off: only a running launch asks", () => {
    expect(quitQuestionOf([launch({ status: "pausing" })], { ...DEFAULT_HOST_POLICY, askWhileDraining: false })).toBeNull();
    expect(quitQuestionOf([running], { ...DEFAULT_HOST_POLICY, askWhileDraining: false })).not.toBeNull();
  });

  test("a running launch wins over a draining one", () => {
    expect(quitQuestionOf([launch({ status: "pausing" }), running])?.kind).toBe("running");
  });

  test("the host shows a dialog only with a running launch: no launch, no dialog, the quit goes on", async () => {
    const r = rig();
    expect(await r.host.confirmQuit()).toBe(true);
    r.host.observe(changed(paused("owner")));
    expect(await r.host.confirmQuit()).toBe(true);
    expect(r.asked).toEqual([]);
  });

  test("«Остаться» (index 0) keeps the app, «Выйти» (index 1) leaves; N is the view's latest", async () => {
    const r = rig();
    r.host.observe(changed(running));
    r.host.observe(changed(launch({ inFlight: { requests: 3, openMicros: 200_000 } })));
    r.pressed.value = 0;
    expect(await r.host.confirmQuit()).toBe(false);
    expect(r.asked[0]?.detail).toContain("(3)");
    r.pressed.value = 1;
    expect(await r.host.confirmQuit()).toBe(true);
    expect(r.asked).toHaveLength(2);
  });

  test("the host words the dialog for its platform", async () => {
    const r = rig({}, "win32");
    r.host.observe(changed(running));
    await r.host.confirmQuit();
    expect(r.asked[0]?.detail).toStartWith("Если закрыть окно, Studio выйдет");
  });

  test("after the engine is gone nothing is asked: the launch no longer runs", async () => {
    const r = rig();
    r.host.observe(changed(running));
    r.host.engineGone();
    expect(await r.host.confirmQuit()).toBe(true);
    expect(r.asked).toEqual([]);
  });
});

describe("notifications", () => {
  test("done: one notification with the count and the money, once however often the view comes", async () => {
    const r = rig();
    r.host.observe(changed(running));
    r.host.observe(changed(ended("done")));
    r.host.observe(changed(ended("done")));
    await settle();
    expect(r.shown).toHaveLength(1);
    expect(r.shown[0]?.title).toBe("Автопилот: готово");
    expect(r.shown[0]?.body).toBe(`18 из 20 видео в «Готовых видео». Потрачено ${formatUsdTiered(1_210_000, "nearest")} из ${formatUsdTiered(4_140_000, "up")}.`);
  });

  test("stopped: told once, in its own words", async () => {
    const r = rig();
    r.host.observe(changed(running));
    r.host.observe(changed(ended("stopped")));
    await settle();
    expect(r.shown.map((n) => n.title)).toEqual(["Запуск остановлен: 18 из 20 видео"]);
    expect(r.shown[0]?.body).toBe("Потрачено $1.21 из $4.14.");
  });

  test("scenes waiting for the review: one per avatar, with the avatar's name, once", async () => {
    const r = rig();
    r.host.observe(changed(running));
    r.host.observe(changed(idleRunning({ avatars: [reviewRow(A), avatarRow(B, { phase: "drawing" })] })));
    r.host.observe(changed(idleRunning({ avatars: [reviewRow(A), avatarRow(B, { phase: "drawing" })], spentMicros: 1_300_000, remainingMicros: 2_840_000 })));
    await settle();
    expect(r.shown).toHaveLength(1);
    expect(r.shown[0]?.title).toBe("Сцены ждут проверки: Mia");
    expect(r.shown[0]?.body).toBe("14 сцен, у 2 нет текста. Остальные аватары идут дальше.");

    r.host.observe(changed(idleRunning({ avatars: [reviewRow(A), reviewRow(B)] })));
    await settle();
    expect(r.shown.map((n) => n.title)).toEqual(["Сцены ждут проверки: Mia", "Сцены ждут проверки: Sofia"]);
  });

  test("an avatar whose name cannot be looked up is told without one", async () => {
    const r = rig();
    r.names.clear();
    r.host.observe(changed(idleRunning({ avatars: [reviewRow(A), avatarRow(B, { phase: "done" })] })));
    await settle();
    expect(r.shown.map((n) => n.title)).toEqual(["Сцены ждут проверки"]);
  });

  test("a hold that needs a person: told once per hold, again for another reason or the same one raised anew", async () => {
    const r = rig();
    const credits = (at: string) => idleRunning({ paidHold: { reason: "credits", at, detail: {} } });
    r.host.observe(changed(running));
    r.host.observe(changed(credits(NOW)));
    r.host.observe(changed(credits(NOW)));
    await settle();
    expect(r.shown.map((n) => n.title)).toEqual(["Автопилот ждёт: кредиты OpenRouter"]);

    r.host.observe(changed(idleRunning({ paidHold: budgetHold })));
    await settle();
    expect(r.shown.at(-1)?.title).toBe("Автопилот ждёт: месячный бюджет");
    expect(r.shown.at(-1)?.body).toBe("Доделать партию: нужно до $1.05, свободно $0.18. Поднимите бюджет в Настройках, потом «Продолжить».");

    r.host.observe(changed(running)); // the owner clicked «Продолжить»
    r.host.observe(changed(credits("2026-10-08T14:20:00.000Z"))); // and the same cause came back
    await settle();
    expect(r.shown).toHaveLength(3);
    expect(r.shown.at(-1)?.title).toBe("Автопилот ждёт: кредиты OpenRouter");
  });

  test("every hold for a person has a notification of its own; a wait that ends by itself has none", async () => {
    const holds: [Record<string, unknown>, string | null][] = [
      [{ reason: "key", at: NOW, detail: {} }, "Автопилот ждёт: ключ OpenRouter"],
      [{ reason: "halt", at: NOW, detail: { code: "SETTLE_ABOVE_WORST" } }, "Автопилот ждёт: сверка"],
      [{ reason: "network", at: NOW, detail: { drops: 3, attempt: 2, nextAt: null } }, "Автопилот ждёт: сверка"],
      [{ reason: "network", at: NOW, detail: { drops: 1, attempt: 1, nextAt: "2026-10-08T14:03:00.000Z" } }, null],
      [{ reason: "price-unavailable", at: NOW, detail: { attempt: 3, nextAt: null } }, "Автопилот ждёт: цены"],
      [{ reason: "price-unavailable", at: NOW, detail: { attempt: 1, nextAt: "2026-10-08T14:07:00.000Z" } }, null],
      [{ reason: "price", at: NOW, detail: { stage: "slice", fromPhotos: 14, toPhotos: 10 } }, "Автопилот ждёт: цена выросла"],
      [{ reason: "internal", at: NOW, detail: { kind: "allocation-exceeded" } }, "Автопилот ждёт: ошибка запуска"],
      [{ reason: "internal", at: NOW, detail: { kind: "job-failed", message: "INTERNAL: x" } }, "Автопилот ждёт: ошибка шага"],
    ];
    for (const [paidHold, title] of holds) {
      const r = rig();
      r.host.observe(changed(idleRunning({ paidHold })));
      await settle();
      expect(r.shown.map((n) => n.title)).toEqual(title === null ? [] : [title]);
    }
  });

  test("a pause the owner did not ask for, with a reconcile to do, is told once; the owner's own pause is not", async () => {
    const r = rig();
    r.host.observe(changed(paused("owner", { resumeBlockedBy: "reconcile-required" })));
    await settle();
    expect(r.shown).toEqual([]);

    r.host.observe(changed(paused("engine-restart", { resumeBlockedBy: "reconcile-required" })));
    r.host.observe(changed(paused("engine-restart", { resumeBlockedBy: "reconcile-required" })));
    await settle();
    expect(r.shown.map((n) => n.title)).toEqual(["Автопилот ждёт: сверка"]);
  });

  test("an ordinary pause, an ordinary run and a view that does not change tell nothing", async () => {
    const r = rig();
    r.host.observe(changed(running));
    r.host.observe(changed(running));
    r.host.observe(changed(paused("owner")));
    r.host.observe(changed(paused("quit", { resumeBlockedBy: "budget" })));
    await settle();
    expect(r.shown).toEqual([]);
  });

  test("a focused window is not notified, and is not told later either", async () => {
    const r = rig();
    r.focused.value = true;
    r.host.observe(changed(running));
    r.host.observe(changed(ended("done")));
    await settle();
    expect(r.shown).toEqual([]);
    r.focused.value = false;
    r.host.observe(changed(ended("done")));
    await settle();
    expect(r.shown).toEqual([]);
  });

  test("notifyOnlyWhenUnfocused off (SP1 may flip it) tells a focused window too", async () => {
    const r = rig({ notifyOnlyWhenUnfocused: false });
    r.focused.value = true;
    r.host.observe(changed(running));
    r.host.observe(changed(ended("done")));
    await settle();
    expect(r.shown).toHaveLength(1);
  });

  test("a click opens the window on the Autopilot screen, or on «Фото» of the avatar whose scenes wait", async () => {
    const r = rig();
    r.host.observe(changed(idleRunning({ avatars: [avatarRow(A, { phase: "done" }), reviewRow(B)] })));
    r.host.observe(changed(ended("done")));
    await settle();
    for (const shown of r.shown) shown.click();
    expect(r.shown).toHaveLength(2);
    expect(r.opened).toContainEqual({ screen: "photos", avatarId: B });
    expect(r.opened).toContainEqual({ screen: "autopilot" });
  });

  test("notificationsFor sees only transitions: the same view twice yields nothing the second time", () => {
    expect(notificationsFor(null, ended("done"))).toHaveLength(1);
    expect(notificationsFor(ended("done"), ended("done"))).toEqual([]);
    expect(notificationsFor(running, running)).toEqual([]);
  });
});

describe("money in a notification is the card's: a ceiling rounds up, what is left rounds down, spent is nearest", () => {
  test("a budget hold", async () => {
    const r = rig();
    const hold = { reason: "budget", at: NOW, detail: { freeMicros: 184_999, needMicros: 1_050_001, kind: "resume-slice" } };
    r.host.observe(changed(idleRunning({ paidHold: hold })));
    await settle();
    expect(r.shown[0]?.body).toStartWith(`Доделать партию: нужно до ${formatUsdTiered(1_050_001, "up")}, свободно ${formatUsdTiered(184_999, "down")}.`);
    expect(r.shown[0]?.body).toStartWith("Доделать партию: нужно до $1.06, свободно $0.18.");
  });

  test("a small start threshold keeps three decimals, rounded up", async () => {
    const r = rig();
    r.host.observe(changed(idleRunning({ paidHold: { reason: "budget", at: NOW, detail: { freeMicros: 0, needMicros: 70_001, kind: "new-slice" } } })));
    await settle();
    expect(r.shown[0]?.body).toStartWith("Начать новую партию: нужно хотя бы $0.071.");
  });
});

describe("the sleep", () => {
  /** Past the window in which a key-up from the shortcut that put the Mac to sleep still counts as nothing. */
  const pastIgnore = DEFAULT_HOST_POLICY.activityIgnoreMs + 1;

  test("suspend and resume go to the engine as host.power, in order", () => {
    const r = rig();
    r.host.suspend();
    r.host.resume();
    expect(r.power).toEqual(["suspend", "resume"]);
  });

  test("a fake powerMonitor's events reach the host", () => {
    const listeners = new Map<string, () => void>();
    const monitor: PowerMonitorPort = { on: (event, listener) => void listeners.set(event, listener) };
    const r = rig();
    watchPower(monitor, r.host);
    listeners.get("suspend")?.();
    expect(r.host.refuses("autopilot.resume")).toBe(true);
    listeners.get("resume")?.();
    expect(r.host.refuses("autopilot.resume")).toBe(false);
    expect(r.power).toEqual(["suspend", "resume"]);
  });

  test("M2: unlock-screen and user-did-become-active are signs of life, like a key press", () => {
    for (const event of ["unlock-screen", "user-did-become-active"] as const) {
      const listeners = new Map<string, () => void>();
      const monitor: PowerMonitorPort = { on: (name, listener) => void listeners.set(name, listener) };
      const r = rig();
      watchPower(monitor, r.host);
      listeners.get("suspend")?.();
      r.clock.value = pastIgnore;
      listeners.get(event)?.();
      expect(r.host.refuses("autopilot.resume")).toBe(false);
      expect(r.power).toEqual(["suspend", "resume"]);
    }
  });

  test("a quick unlock (Touch ID) right after a suspend is not ignored, unlike a key or a focus", () => {
    for (const source of ["unlock", "active"] as const) {
      const r = rig();
      r.host.suspend();
      r.clock.value = 10;
      r.host.activity(source);
      expect(r.host.refuses("autopilot.resume")).toBe(false);
      expect(r.power).toEqual(["suspend", "resume"]);
    }
    for (const source of ["key", "focus"] as const) {
      const r = rig();
      r.host.suspend();
      r.clock.value = 10;
      r.host.activity(source);
      expect(r.power).toEqual(["suspend"]);
    }
  });

  test("L-c: the first activity after a resume says resume once more, the second says nothing", () => {
    const r = rig();
    r.host.suspend();
    r.host.resume();
    r.host.activity("key");
    r.host.activity("key");
    expect(r.power).toEqual(["suspend", "resume", "resume"]);
  });

  test("L-c: activity with no sleep behind it says nothing", () => {
    const r = rig();
    r.host.activity("key");
    expect(r.power).toEqual([]);
  });

  test("L-c: a resume that never came is made up by the first activity, which also unblocks the commands", () => {
    const r = rig();
    r.host.suspend();
    r.clock.value = pastIgnore;
    expect(r.host.refuses("autopilot.resume")).toBe(true);
    r.host.activity("key");
    expect(r.host.refuses("autopilot.resume")).toBe(false);
    expect(r.power).toEqual(["suspend", "resume"]);
    r.host.activity("key");
    expect(r.power).toEqual(["suspend", "resume"]);
  });

  test("OQ1: activity right after a suspend (the key-up of the shortcut that slept the Mac) does not wake it", () => {
    const r = rig();
    r.host.suspend();
    r.clock.value = DEFAULT_HOST_POLICY.activityIgnoreMs - 1;
    r.host.activity("key");
    expect(r.host.refuses("autopilot.resume")).toBe(true);
    expect(r.power).toEqual(["suspend"]);
    r.clock.value = DEFAULT_HOST_POLICY.activityIgnoreMs;
    r.host.activity("key");
    expect(r.power).toEqual(["suspend", "resume"]);
  });

  test("L-c off: a resume is said once and activity adds nothing", () => {
    const r = rig({ resendResumeOnActivity: false });
    r.host.suspend();
    r.host.resume();
    r.host.activity("key");
    expect(r.power).toEqual(["suspend", "resume"]);
  });

  test("a second suspend after a resume disarms the pending resume: its activity wakes it, once", () => {
    const r = rig();
    r.host.suspend();
    r.host.resume();
    r.host.suspend();
    r.clock.value = pastIgnore;
    r.host.activity("key");
    r.host.activity("key");
    expect(r.power).toEqual(["suspend", "resume", "suspend", "resume"]);
  });

  test("M2: a lost resume with a mouse-only owner: any command after the recovery time wakes the host and goes through", () => {
    const r = rig();
    r.host.suspend();
    r.clock.value = DEFAULT_HOST_POLICY.commandRecoveryMs - 1;
    expect(r.host.refuses("autopilot.resume")).toBe(true);
    r.clock.value = DEFAULT_HOST_POLICY.commandRecoveryMs;
    expect(r.host.refuses("autopilot.resume")).toBe(false);
    expect(r.power).toEqual(["suspend", "resume"]);
  });

  test("R2 MEDIUM: a read never wakes the host, however late: the window's own reads in the gap before the real sleep are not proof of wake", () => {
    const r = rig();
    r.host.suspend();
    for (const at of [100, DEFAULT_HOST_POLICY.commandRecoveryMs, 30_000, 120_000]) {
      r.clock.value = at;
      for (const type of ["autopilot.get", "videos.list", "engine.events", "engine.snapshot", "autopilot.stop"] as const) expect(r.host.refuses(type)).toBe(false);
    }
    expect(r.power).toEqual(["suspend"]);
    expect(r.blocker.held()).toBe(0);
    expect(r.host.blockerHeld).toBe(false);
    r.clock.value = 0;
    expect(r.host.refuses("runs.start")).toBe(true); // still asleep: the reads did not wake it
  });

  test("R2 MEDIUM: a held click (the owner's, with an accepted sum) after the recovery time does wake it", () => {
    const r = rig();
    r.host.observe(changed(running));
    r.host.suspend();
    r.clock.value = DEFAULT_HOST_POLICY.commandRecoveryMs - 1;
    expect(r.host.refuses("autopilot.resume")).toBe(true);
    r.clock.value = DEFAULT_HOST_POLICY.commandRecoveryMs;
    expect(r.host.refuses("autopilot.resume")).toBe(false);
    expect(r.power).toEqual(["suspend", "resume"]);
    expect(r.blocker.held()).toBe(1);
  });

  test("M2: while the host believes the Mac sleeps the power blocker is released, and taken again on wake", () => {
    const r = rig();
    r.host.observe(changed(running));
    expect(r.blocker.held()).toBe(1);
    r.host.suspend();
    expect(r.blocker.held()).toBe(0);
    r.host.resume();
    expect(r.blocker.held()).toBe(1);

    r.host.suspend();
    expect(r.blocker.held()).toBe(0);
    r.host.observe(changed(running)); // an event while asleep does not take it
    expect(r.blocker.held()).toBe(0);
    r.clock.value = DEFAULT_HOST_POLICY.activityIgnoreMs;
    r.host.activity("key"); // a lost resume, made up
    expect(r.blocker.held()).toBe(1);
  });
});

describe("L-d: the window's commands between suspend and resume", () => {
  const command = (type: CommandType = "autopilot.resume"): EngineCommandMessage => ({ v: PROTOCOL_VERSION, id: "cmd-00000001", kind: "command", type, payload: {} }) as EngineCommandMessage;
  const answered: ResponseMessage = { v: PROTOCOL_VERSION, id: "cmd-00000001", kind: "response", type: "avatars.list", ok: true, result: { avatars: [], unreadableAvatars: [], unreadableTotal: 0 } };

  function gated(policy: Partial<HostPolicy> = {}) {
    const r = rig(policy);
    const sent: EngineCommandMessage[] = [];
    const route = gateWhileAsleep(r.host, async (c) => {
      sent.push(c);
      return answered;
    });
    return { r, sent, route };
  }

  test("awake, a command goes to the engine", async () => {
    const { sent, route } = gated();
    expect(await route(command())).toEqual(answered);
    expect(sent).toHaveLength(1);
  });

  test("asleep, a command that starts paid work or moves the launch is refused with the code and the reason, and never reaches the engine", async () => {
    const { r, sent, route } = gated();
    r.host.suspend();
    const response = await route(command("autopilot.resume"));
    expect(sent).toEqual([]);
    expect(response.ok).toBe(false);
    if (!response.ok) {
      expect(response.id).toBe("cmd-00000001");
      expect(response.error.code).toBe("INTERNAL");
      expect(response.error.detail).toBe(HOST_ASLEEP_DETAIL);
    }
  });

  test("M1: asleep, reads, pause, stop and saves pass (a reconnect after the wake needs engine.events and engine.snapshot)", async () => {
    const { r, sent, route } = gated();
    r.host.suspend();
    for (const type of ["engine.snapshot", "engine.events", "autopilot.get", "autopilot.list", "autopilot.stop", "autopilot.pause", "montages.save"] as const) {
      expect((await route(command(type))).ok).toBe(true);
    }
    expect(sent.map((c) => c.type)).toEqual(["engine.snapshot", "engine.events", "autopilot.get", "autopilot.list", "autopilot.stop", "autopilot.pause", "montages.save"]);
  });

  test("M1: the paid starts are each refused", async () => {
    const { r, route } = gated();
    r.host.suspend();
    for (const type of ["autopilot.start", "autopilot.continueAfterReview", "runs.start", "scenes.compose", "avatars.createDraft"] as const) {
      expect((await route(command(type))).ok).toBe(false);
    }
  });

  test("after the resume it goes through again", async () => {
    const { r, sent, route } = gated();
    r.host.suspend();
    r.host.resume();
    expect(await route(command())).toEqual(answered);
    expect(sent).toHaveLength(1);
  });

  test("blockCommandsWhileAsleep off lets it through", async () => {
    const { r, sent, route } = gated({ blockCommandsWhileAsleep: false });
    r.host.suspend();
    await route(command());
    expect(sent).toHaveLength(1);
  });
});

describe("M3: the blocker is not held for a launch that cannot progress", () => {
  const exportHold = { reason: "export", at: NOW, detail: { exportReason: "missing", neededBytes: null, freeBytes: null } };

  test("under a free hold (the export folder is gone) montage is not work", () => {
    expect(launchHasWork(idleRunning({ avatars: [libraryRow(A), libraryRow(B)] }))).toBe(true);
    expect(launchHasWork(idleRunning({ freeHold: exportHold, avatars: [libraryRow(A), libraryRow(B)] }))).toBe(false);
  });

  test("under a free hold, paid drawing still is work", () => {
    expect(launchHasWork(idleRunning({ freeHold: exportHold, avatars: both({ phase: "drawing" }) }))).toBe(true);
  });

  test("under a paid hold and a free hold together there is no work", () => {
    expect(launchHasWork(idleRunning({ freeHold: exportHold, paidHold: { reason: "credits", at: NOW, detail: {} }, avatars: [libraryRow(A), libraryRow(B)] }))).toBe(false);
  });

  test("a montage row whose unfinished videos all wait for music is at rest; one with another unfinished video is not", () => {
    const waiting = (over: Record<string, unknown>) => idleRunning({ avatars: [{ ...libraryRow(A), ...over }, avatarRow(B, { phase: "done" })] });
    expect(launchHasWork(waiting({ videos: { done: 7, total: 10 }, waitingMusic: 3 }))).toBe(false);
    expect(launchHasWork(waiting({ videos: { done: 6, total: 10 }, waitingMusic: 3 }))).toBe(true);
  });
});

describe("the host's state across an engine restart", () => {
  test("LOW 1: after engineGone the next launch event takes the blocker and the quit asks again", async () => {
    const r = rig();
    r.host.observe(changed(running));
    r.host.engineGone();
    r.host.observe(changed(running));
    expect(r.blocker.held()).toBe(1);
    expect(await r.host.confirmQuit()).toBe(false); // the fake dialog answers «Остаться» (index 0)
    expect(r.asked).toHaveLength(1);
  });

  test("LOW 2: a stale running view of another launch does not come back with a later event", () => {
    const r = rig();
    r.host.observe(changed(running));
    r.host.engineGone();
    r.host.observe(changed(launch({ launchId: "launch-0a1b2c3d4e60", status: "paused", paused: { cause: "engine-restart", at: NOW }, inFlight: { requests: 0, openMicros: 0 } })));
    expect(r.blocker.held()).toBe(0);
  });
});

describe("notifications: the first view and the restart", () => {
  test("LOW 4: scenes of a paused launch, seen first after an app restart, are not announced; a running launch's are", async () => {
    const rows = [reviewRow(A), avatarRow(B, { phase: "done" })];
    const r = rig();
    r.host.observe(changed(paused("engine-restart", { avatars: rows })));
    await settle();
    expect(r.shown.map((n) => n.title).filter((t) => t.startsWith("Сцены"))).toEqual([]);
    const fresh = rig();
    fresh.host.observe(changed(idleRunning({ avatars: rows })));
    await settle();
    expect(fresh.shown.map((n) => n.title)).toEqual(["Сцены ждут проверки: Mia"]);
  });

  test("LOW 5: a pause by an engine restart is told even without a reconcile, once", async () => {
    const r = rig();
    r.host.observe(changed(paused("engine-restart")));
    r.host.observe(changed(paused("engine-restart")));
    await settle();
    expect(r.shown.map((n) => n.title)).toEqual(["Автопилот на паузе"]);
    expect(r.shown[0]?.body).toBe("Studio перезапустился, и запуск встал на паузу. Откройте «Автопилот» и нажмите «Продолжить».");
  });

  test("LOW 5: the owner's own pause and a quit's are not told", async () => {
    const r = rig();
    r.host.observe(changed(paused("owner")));
    r.host.observe(changed(paused("quit")));
    await settle();
    expect(r.shown).toEqual([]);
  });
});

describe("a port that throws", () => {
  const ports = {
    dialog: { ask: async () => 0 },
    isWindowFocused: () => false,
    openWindow: () => undefined,
    sendPower: () => undefined,
    now: () => 0,
    platform: "darwin" as const,
  };

  test("LOW 7: a blocker that throws does not stop observe, nor the notifications behind it", async () => {
    const shown: string[] = [];
    let started = 0;
    const host = new AutopilotHost({
      ...ports,
      blocker: {
        start: () => {
          started += 1;
          throw new Error("no blocker");
        },
        stop: () => undefined,
      },
      notifier: { show: (n) => void shown.push(n.title) },
      avatarName: async () => {
        throw new Error("no engine");
      },
    });
    expect(() => host.observe(changed(running))).not.toThrow();
    expect(started).toBe(1);
    expect(() => host.observe(changed(idleRunning({ avatars: [reviewRow(A), avatarRow(B, { phase: "done" })] })))).not.toThrow();
    await settle();
    expect(shown).toEqual(["Сцены ждут проверки"]);
  });

  test("LOW 7: a notifier that throws does not escape observe or become an unhandled rejection", async () => {
    const host = new AutopilotHost({
      ...ports,
      blocker: { start: () => 1, stop: () => undefined },
      notifier: {
        show: () => {
          throw new Error("no notifications");
        },
      },
      avatarName: async () => null,
    });
    expect(() => host.observe(changed(ended("done")))).not.toThrow();
    await settle();
    expect(host.blockerHeld).toBe(false);
  });
});

describe("R2: the log SP1 reads, and a sendPower that throws", () => {
  test("the wake reason and each refusal are logged, the type only", () => {
    const r = rig();
    r.host.suspend();
    r.clock.value = 5_000;
    r.host.refuses("autopilot.get");
    expect(r.host.refuses("runs.start")).toBe(false);
    expect(r.logs).toContain("studio: autopilot host: woke by command");

    const q = rig();
    q.host.suspend();
    expect(q.host.refuses("runs.start")).toBe(true);
    q.clock.value = 2_000;
    q.host.activity("focus");
    expect(q.logs).toEqual(["studio: autopilot host: held runs.start", "studio: autopilot host: woke by focus"]);

    const w = rig();
    w.host.suspend();
    w.host.resume();
    expect(w.logs).toEqual(["studio: autopilot host: woke by resume"]);
    for (const source of ["key", "unlock", "active"] as const) {
      const x = rig();
      x.host.suspend();
      x.clock.value = 2_000;
      x.host.activity(source);
      expect(x.logs).toEqual([`studio: autopilot host: woke by ${source}`]);
    }
  });

  test("a sendPower that throws leaves no blocker held and does not escape suspend, resume, activity or refuses", () => {
    const r = rig();
    const host = new AutopilotHost({
      blocker: { start: () => 7, stop: () => undefined },
      notifier: { show: () => undefined },
      dialog: { ask: async () => 0 },
      isWindowFocused: () => false,
      openWindow: () => undefined,
      avatarName: async () => null,
      sendPower: () => {
        throw new Error("port closed");
      },
      now: () => r.clock.value,
      platform: "darwin",
      log: (line) => void r.logs.push(line),
    });
    host.observe(changed(running));
    expect(host.blockerHeld).toBe(true);
    expect(() => host.suspend()).not.toThrow();
    expect(host.blockerHeld).toBe(false);
    r.clock.value = 6_000;
    expect(() => host.refuses("autopilot.resume")).not.toThrow();
    expect(host.blockerHeld).toBe(true);
    expect(() => host.resume()).not.toThrow();
    expect(() => host.activity("key")).not.toThrow();
  });
});

describe("every held command goes through the engine route the gate wraps", () => {
  test("a held command that was main-only would bypass the gate", () => {
    const held = ENGINE_COMMAND_TYPES.filter((type) => heldWhileAsleep(type));
    expect(held.length).toBeGreaterThan(10);
    expect(COMMAND_TYPES.filter((type) => heldWhileAsleep(type)).sort()).toEqual([...held].sort());
    expect(MAIN_ONLY_COMMANDS.filter((type) => heldWhileAsleep(type))).toEqual([]);
  });

  test("music.refresh, which spends one of the monthly flashapi requests, is held", () => {
    expect(heldWhileAsleep("music.refresh")).toBe(true);
  });
});

describe("small decisions", () => {
  test("LOW 6: «Остаться» opens a window again only where the last window's close is what asked (not on macOS)", () => {
    expect(reopensWindowAfterStay("win32", 0)).toBe(true);
    expect(reopensWindowAfterStay("linux", 0)).toBe(true);
    expect(reopensWindowAfterStay("darwin", 0)).toBe(false);
    expect(reopensWindowAfterStay("win32", 1)).toBe(false);
  });

  test("LOW 11: the default policy cannot be changed by accident", () => {
    expect(Object.isFrozen(DEFAULT_HOST_POLICY)).toBe(true);
  });
});
