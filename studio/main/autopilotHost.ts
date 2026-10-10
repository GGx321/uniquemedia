import { errorResponseFor, heldWhileAsleep, HOST_ASLEEP_DETAIL, type AvatarPhase, type CommandType, type EngineCommandMessage, type EventMessage, type LaunchView, type ResponseMessage } from "../shared/engine";
import { formatUsdTiered, isFree, limitUsd } from "../shared/engine/usd";
import type { HostControl } from "../engine/control";

// The autopilot's host in main (plan §3.8, S4.7): what only the main process can do for a launch that runs with the window closed.
//  - the power blocker: held exactly while a launch is `running` with work (`holdsPowerBlocker`);
//  - the quit question: asked while a launch runs (`quitQuestionOf`), through quitFlow's `confirmQuit`;
//  - three kinds of notification: done, scenes waiting for review, a hold or pause that needs the owner (`notificationsFor`);
//  - the sleep: `powerMonitor` suspend / resume go to the engine as `host.power`, and the window's commands wait while the Mac sleeps.
// Everything the system does is behind a small port, so the tests use fakes. Every choice SP1 may change is one field of `HostPolicy`.

/** The switches SP1 (the spike on the real build) may flip. Each one is read where it acts and nowhere else. */
export interface HostPolicy {
  /** Q5 (plan §17), default ON, pending the owner: keep the Mac from idle sleep while a launch works. */
  powerBlocker: boolean;
  /** Also hold the blocker while «Пауза» / «Стоп» drain (status `pausing` / `stopping` with requests in flight). The plan says «running»: off. */
  holdWhileDraining: boolean;
  /** Ask on quit also while a pause or stop drains with requests in flight (design HostStates, review M5). */
  askWhileDraining: boolean;
  /** Notify only when no Studio window has focus (design HostStates). SP1 may find that a focused window should be told as well. */
  notifyOnlyWhenUnfocused: boolean;
  /** Refuse the window's commands that start paid work or move a launch between `suspend` and `resume` (L-d; `shared/engine/commandHold.ts` says which). */
  blockCommandsWhileAsleep: boolean;
  /** Send `host.power resume` once more at the next sign of life after a `resume` (L-c). */
  resendResumeOnActivity: boolean;
  /** Signs of life (a key press or a focus, not an unlock) within this many ms of monotonic time after a `suspend` are ignored: the key-up of the shortcut that put the Mac to sleep is not a wake. */
  activityIgnoreMs: number;
  /** A held command (`heldWhileAsleep`) that arrives this many ms (monotonic) after a `suspend` with no `resume` proves the Mac is awake: a sleeping Mac sends none. A mouse-only owner needs it. */
  commandRecoveryMs: number;
}

export const DEFAULT_HOST_POLICY: HostPolicy = Object.freeze({
  powerBlocker: true,
  holdWhileDraining: false,
  askWhileDraining: true,
  notifyOnlyWhenUnfocused: true,
  blockCommandsWhileAsleep: true,
  resendResumeOnActivity: true,
  activityIgnoreMs: 2_000,
  commandRecoveryMs: 5_000,
});

// ---------- the power blocker ----------

/** Phases in which an avatar waits for the owner or has nothing left to do: no work of the launch's own runs for it. */
const RESTING_PHASES: ReadonlySet<AvatarPhase> = new Set<AvatarPhase>(["awaiting-review", "approved-waiting", "done", "skipped", "waiting"]);

/**
 * Whether a launch has work that a sleeping or napping Mac would hurt. `running` only (the plan): a pause, a stop, an end release it. Inside a running launch:
 *  - a request in flight is work;
 *  - a paid hold with nothing in flight is NOT, unless a retry is scheduled (`nextAt`, a timer that App Nap would delay) or free work goes on through it (a montage);
 *  - with no hold, work is any avatar that is not resting; a launch that waits for the owner's scene review everywhere has none.
 * A montage is work only while it can progress: not under a free hold (the export folder or the disk is gone), and not for a row whose unfinished videos all wait for a
 * track (the refresh of the music list is once per launch), or a launch could keep the Mac awake for days.
 */
export function launchHasWork(view: LaunchView, policy: HostPolicy = DEFAULT_HOST_POLICY): boolean {
  const draining = (view.status === "pausing" || view.status === "stopping") && view.inFlight.requests > 0;
  if (view.status !== "running") return policy.holdWhileDraining && draining;
  if (view.inFlight.requests > 0) return true;
  const hold = view.paidHold;
  if (hold !== null) {
    if ((hold.reason === "network" || hold.reason === "price-unavailable") && hold.detail.nextAt !== null) return true;
    return view.avatars.some((a) => a.phase === "montage" && montageCanProgress(view, a));
  }
  return view.avatars.some((a) => !RESTING_PHASES.has(a.phase) && (a.phase !== "montage" || montageCanProgress(view, a)));
}

function montageCanProgress(view: LaunchView, row: LaunchView["avatars"][number]): boolean {
  if (view.freeHold !== null) return false;
  const unfinished = row.videos.total - row.videos.done;
  return !(unfinished > 0 && row.waitingMusic >= unfinished);
}

export function holdsPowerBlocker(views: Iterable<LaunchView>, policy: HostPolicy = DEFAULT_HOST_POLICY): boolean {
  if (!policy.powerBlocker) return false;
  for (const view of views) if (launchHasWork(view, policy)) return true;
  return false;
}

/** `powerSaveBlocker`, the part main uses. */
export interface PowerBlockerPort {
  start(): number;
  stop(id: number): void;
}

// ---------- the quit question ----------

export type QuitQuestion = { kind: "running" | "pausing" | "stopping"; requests: number };

/** The launch the owner would interrupt by quitting now: a running one, else (policy) one still draining requests. null: no question. */
export function quitQuestionOf(views: Iterable<LaunchView>, policy: HostPolicy = DEFAULT_HOST_POLICY): QuitQuestion | null {
  let draining: QuitQuestion | null = null;
  for (const view of views) {
    if (view.status === "running") return { kind: "running", requests: view.inFlight.requests };
    if (policy.askWhileDraining && (view.status === "pausing" || view.status === "stopping") && view.inFlight.requests > 0) {
      draining ??= { kind: view.status, requests: view.inFlight.requests };
    }
  }
  return draining;
}

export const QUIT_STAY_LABEL = "Остаться";
export const QUIT_LEAVE_LABEL = "Выйти";

export interface QuitDialogSpec {
  message: string;
  detail: string;
  /** «Остаться» first and the default; Escape stays too. */
  buttons: readonly [string, string];
  defaultId: 0;
  cancelId: 0;
}

/** The texts of plan §3.8 and the design's HostStates sheet. */
export function quitDialogOf(question: QuitQuestion, platform: NodeJS.Platform = "darwin"): QuitDialogSpec {
  const n = question.requests;
  const worst = "прервутся и до сверки будут считаться по худшей цене";
  const base = { buttons: [QUIT_STAY_LABEL, QUIT_LEAVE_LABEL] as const, defaultId: 0 as const, cancelId: 0 as const };
  if (question.kind === "running") {
    return {
      ...base,
      message: "Идёт автопилот",
      detail: `${platform === "darwin" ? "Если выйти, запуск" : "Если закрыть окно, Studio выйдет и запуск"} встанет на паузу. ${n > 0 ? `Запросы, которые сейчас в работе (${n}), ${worst}.` : "Запросов в работе нет — ничего не прервётся."}`,
    };
  }
  const lead = question.kind === "pausing" ? "Запуск ставится на паузу" : "Запуск останавливается";
  return {
    ...base,
    message: "Запросы автопилота ещё в работе",
    detail: `${lead}, но ${n} ${plural(n, "запрос ещё ждёт", "запроса ещё ждут", "запросов ещё ждут")} ответа. Если выйти сейчас, ${n === 1 ? "он прервётся и до сверки будет считаться по худшей цене" : `они ${worst}`}. Обычно ответы приходят за минуту.`,
  };
}

/** `dialog.showMessageBox`, the part main uses: the index of the button pressed. */
export interface QuitDialogPort {
  ask(spec: QuitDialogSpec): Promise<number>;
}

// ---------- notifications ----------

/** Where a click goes: the Autopilot screen, or «Фото» of the avatar whose scenes wait. */
export type NotificationTarget = { screen: "autopilot" } | { screen: "photos"; avatarId: string };

export interface HostNotification {
  title: string;
  body: string;
  target: NotificationTarget;
}

export interface NotificationPort {
  /** Shows it; `onClick` runs when the owner clicks it. */
  show(notification: { title: string; body: string }, onClick: () => void): void;
}

function plural(n: number, one: string, few: string, many: string): string {
  const mod100 = n % 100;
  const mod10 = n % 10;
  if (mod100 >= 11 && mod100 <= 14) return many;
  if (mod10 === 1) return one;
  if (mod10 >= 2 && mod10 <= 4) return few;
  return many;
}

/**
 * The reason a paid hold needs a person, in the words of the design's «Автопилот ждёт: …» card, or null when it is a wait that ends by itself (a retry is scheduled):
 * that one is not a call for the owner.
 */
function holdWords(hold: NonNullable<LaunchView["paidHold"]>): { why: string; body: string } | null {
  switch (hold.reason) {
    case "budget": {
      const { freeMicros, needMicros, kind } = hold.detail;
      return {
        why: "месячный бюджет",
        body: `${kind === "resume-slice" ? `Доделать партию: нужно до ${formatUsdTiered(needMicros, "up")}, свободно ${formatUsdTiered(freeMicros, "down")}` : `Начать новую партию: нужно хотя бы ${formatUsdTiered(needMicros, "up")}`}. Поднимите бюджет в Настройках, потом «Продолжить».`,
      };
    }
    case "credits":
      return { why: "кредиты OpenRouter", body: "На счёте OpenRouter закончились деньги. Пополните его, потом «Продолжить»." };
    case "key":
      return { why: "ключ OpenRouter", body: "Ключ отклонён. Замените его в Настройках, потом «Продолжить»." };
    case "halt":
      return { why: "сверка", body: "Расходы не сходятся. Сверьте их, потом «Продолжить»." };
    case "network": {
      if (hold.detail.nextAt !== null) return null;
      // Worded from the automatic retries made (`attempt`), as the card is (S4.10 fix C, UI LOW 8 and round 1): the drops survive a reconcile and «Продолжить», so
      // under Q2 = Б (no automatic retries) a third drop made none. Two is the design's sentence (HostStates).
      const { attempt } = hold.detail;
      const lead = attempt > 0 ? `${attempt} ${plural(attempt, "повтор", "повтора", "повторов")} ${plural(attempt, "не помог", "не помогли", "не помогли")}` : "связь пропала";
      return { why: "сверка", body: `Нет ответа от OpenRouter: ${lead}. Сверьте расходы, потом «Продолжить».` };
    }
    case "price-unavailable":
      return hold.detail.nextAt !== null ? null : { why: "цены", body: "Цены OpenRouter не загрузились. Проверьте связь, потом «Продолжить»." };
    case "price":
      return { why: "цена выросла", body: "Цена выросла, и следующий шаг не помещается в долю запуска. Откройте «Автопилот»." };
    case "internal":
      return hold.detail.kind === "allocation-exceeded"
        ? { why: "ошибка запуска", body: "Запуск вышел за свою долю денег. Откройте «Автопилот»: выход только «Стоп»." }
        : { why: "ошибка шага", body: "Платный шаг не выполнился. Откройте «Автопилот», потом «Продолжить»." };
  }
}

/** The state the owner is asked about: a stable key (a reason and when it began, so the same wait never repeats and a new one does), and its words. */
function waitingOf(view: LaunchView): { key: string; title: string; body: string } | null {
  if (view.status === "paused" && view.paused !== null && view.paused.cause !== "owner") {
    const key = `pause:${view.paused.at}`;
    if (view.resumeBlockedBy === "reconcile-required") {
      return { key, title: "Автопилот ждёт: сверка", body: "Запуск на паузе, есть запросы без ответа. Сверьте расходы, потом «Продолжить»." };
    }
    // A restart stopped the launch: an owner who was away learns it here. A quit's pause is the owner's own doing.
    if (view.paused.cause === "engine-restart") {
      return { key, title: "Автопилот на паузе", body: "Studio перезапустился, и запуск встал на паузу. Откройте «Автопилот» и нажмите «Продолжить»." };
    }
  }
  if (view.status === "running" && view.paidHold !== null) {
    const words = holdWords(view.paidHold);
    if (words === null) return null;
    return { key: `hold:${view.paidHold.reason}:${view.paidHold.at}`, title: `Автопилот ждёт: ${words.why}`, body: words.body };
  }
  return null;
}

function reviewBody(row: LaunchView["avatars"][number], view: LaunchView): string {
  const scenes = row.scenes ?? 0;
  const without = row.scenesWithoutText ?? 0;
  const head = `${scenes} ${plural(scenes, "сцена", "сцены", "сцен")}`;
  const gaps = without > 0 ? `, у ${without} нет текста` : "";
  const others = view.avatars.some((a) => a.avatarId !== row.avatarId && !RESTING_PHASES.has(a.phase));
  return `${head}${gaps}.${others ? " Остальные аватары идут дальше." : ""}`;
}

function doneWords(view: LaunchView): { title: string; body: string } {
  const done = view.avatars.reduce((sum, a) => sum + a.videos.done, 0);
  // The card's one money rule (S4.10 fix C, UI LOW 7): a launch that planned and spent nothing is «бесплатный», never «$0.000 из $0.000»; W′ of 0 reads «$0».
  const spent = isFree(view.spentMicros, view.plannedWorstMicros)
    ? "Запуск бесплатный."
    : `Потрачено ${formatUsdTiered(view.spentMicros, "nearest")} из ${limitUsd(view.plannedWorstMicros)}.`;
  return view.status === "done"
    ? { title: "Автопилот: готово", body: `${done} из ${view.plan.videos} видео в «Готовых видео». ${spent}` }
    : { title: `Запуск остановлен: ${done} из ${view.plan.videos} видео`, body: spent };
}

/** The review notification's title without a name; the host adds «: <name>» when it can look the avatar up. */
export const REVIEW_TITLE = "Сцены ждут проверки";

/**
 * What changed from `prev` to `next` that the owner should be told, one entry per transition:
 *  - the launch ended (`done`, or `stopped`);
 *  - an avatar's scenes began to wait for the review.
 * Waiting (a hold or pause for a person) is decided separately, by its key, in `AutopilotHost`.
 */
export function notificationsFor(prev: LaunchView | null, next: LaunchView): HostNotification[] {
  const out: HostNotification[] = [];
  if ((next.status === "done" || next.status === "stopped") && prev?.status !== next.status) {
    out.push({ ...doneWords(next), target: { screen: "autopilot" } });
  }
  // Only a launch that runs: a paused one met first after an app restart has had its review announced long ago.
  for (const row of next.status === "running" ? next.avatars : []) {
    if (row.phase !== "awaiting-review") continue;
    if (prev?.avatars.find((a) => a.avatarId === row.avatarId)?.phase === "awaiting-review") continue;
    out.push({
      title: REVIEW_TITLE,
      body: reviewBody(row, next),
      target: { screen: "photos", avatarId: row.avatarId },
    });
  }
  return out;
}

// ---------- the sleep ----------

/** What proved the Mac awake (logged, and `key` / `focus` are the ones the early-ignore window applies to). */
export type ActivitySource = "key" | "focus" | "unlock" | "active";
type WakeReason = ActivitySource | "command";

/** `powerMonitor`, the part main uses. `unlock-screen` and `user-did-become-active` are signs of life (a mouse-only owner sends no key press). */
export interface PowerMonitorPort {
  on(event: "suspend" | "resume" | "unlock-screen" | "user-did-become-active", listener: () => void): void;
}

// ---------- the host ----------

export interface AutopilotHostDeps {
  blocker: PowerBlockerPort;
  notifier: NotificationPort;
  dialog: QuitDialogPort;
  /** Whether any Studio window has focus. */
  isWindowFocused(): boolean;
  /** A click on a notification: focus the window or open one (the target says where, once the window can be told). */
  openWindow(target: NotificationTarget): void;
  /** An avatar's name, for a notification's title; null when unknown (the title then has none). */
  avatarName(avatarId: string): Promise<string | null>;
  /** `host.power` to the engine. */
  sendPower(state: Extract<HostControl, { type: "host.power" }>["state"]): void;
  /** Monotonic milliseconds (`performance.now()`). Whether it stops while the Mac sleeps (so that it measures time awake) is an ASSUMPTION for SP1 to check. */
  now(): number;
  /** The words of the quit dialog differ on Windows, where the last window's close is what asks. */
  platform: NodeJS.Platform;
  policy?: HostPolicy;
  /** A line for the log when a port fails; the failing port's name only, never a payload. */
  log?: (line: string) => void;
}

/**
 * Main's view of the launch and everything main does about it. It learns the launch from the engine's `autopilot.changed` (whole view), and forgets that any of them
 * still runs when the engine goes (a restarted engine reads a running launch as `paused { restart }` and says so in its own events). Each port is called inside a guard:
 * a port that throws costs its own feature and nothing else.
 */
export class AutopilotHost {
  readonly #deps: AutopilotHostDeps;
  readonly #policy: HostPolicy;
  /** The last view of each launch seen, for the transitions. Kept across an engine restart so a state already told is not told again. */
  readonly #views = new Map<string, LaunchView>();
  /** Launches whose view is from an engine that is gone: they count as nothing running until the new engine says otherwise. */
  readonly #stale = new Set<string>();
  /** The wait last notified, per launch (its key): the same key never notifies twice. */
  readonly #told = new Map<string, string>();
  #disposed = false;
  #blockerId: number | null = null;
  #asleep = false;
  #suspendedAt = 0;
  /** Wall clock (ms since the epoch) of the last `suspend`, or null before the first: the log compares it with the monotonic delta (does `performance.now()` run in sleep?). */
  #suspendedWall: number | null = null;
  /** The held command types already logged in this sleep: one line each. */
  #heldLogged = new Set<CommandType>();
  #resumePending = false;

  constructor(deps: AutopilotHostDeps) {
    this.#deps = deps;
    this.#policy = deps.policy ?? DEFAULT_HOST_POLICY;
  }

  #guard(what: string, work: () => void): void {
    try {
      work();
    } catch (error) {
      (this.#deps.log ?? console.warn)(`studio: the autopilot host's ${what} failed (${error instanceof Error ? error.name : typeof error})`);
    }
  }

  /** The engine's events: only `autopilot.changed` matters. Never throws. */
  observe(event: EventMessage): void {
    if (event.type !== "autopilot.changed") return;
    const next = event.payload.launch;
    const prev = this.#views.get(next.launchId) ?? null;
    this.#stale.delete(next.launchId);
    this.#views.set(next.launchId, next);
    this.#guard("power blocker", () => this.#syncBlocker());
    this.#guard("notifications", () => this.#notify(prev, next));
  }

  /** The engine process is gone (a crash, a restart): what it ran is no longer running, so nothing is held and nothing is asked about. */
  engineGone(): void {
    for (const id of this.#views.keys()) this.#stale.add(id);
    this.#guard("power blocker", () => this.#syncBlocker());
  }

  /** The launches main believes run now. */
  #current(): LaunchView[] {
    return [...this.#views].filter(([id]) => !this.#stale.has(id)).map(([, view]) => view);
  }

  /** Held while a launch has work, and never while the host believes the Mac sleeps (a held blocker would only fight the sleep it is about to lose). */
  #syncBlocker(): void {
    const hold = !this.#disposed && !this.#asleep && holdsPowerBlocker(this.#current(), this.#policy);
    if (hold && this.#blockerId === null) this.#blockerId = this.#deps.blocker.start();
    else if (!hold && this.#blockerId !== null) {
      const id = this.#blockerId;
      this.#blockerId = null;
      this.#deps.blocker.stop(id);
    }
  }

  /** Whether the blocker is held now (for the tests and diagnostics). */
  get blockerHeld(): boolean {
    return this.#blockerId !== null;
  }

  /** The quit is going on: the blocker goes and is not taken again. */
  dispose(): void {
    this.#disposed = true;
    this.#guard("power blocker", () => this.#syncBlocker());
  }

  // ---- quit ----

  /** quitFlow's `confirmQuit`: true to quit. No question when no launch runs; «Остаться» (or Escape) keeps the app. */
  async confirmQuit(): Promise<boolean> {
    const question = quitQuestionOf(this.#current(), this.#policy);
    if (question === null) return true;
    const pressed = await this.#deps.dialog.ask(quitDialogOf(question, this.#deps.platform));
    return pressed === 1;
  }

  // ---- notifications ----

  #notify(prev: LaunchView | null, next: LaunchView): void {
    const entries = notificationsFor(prev, next);
    const waiting = waitingOf(next);
    let waitingEntry: HostNotification | null = null;
    if (waiting !== null && this.#told.get(next.launchId) !== waiting.key) {
      this.#told.set(next.launchId, waiting.key);
      waitingEntry = { title: waiting.title, body: waiting.body, target: { screen: "autopilot" } };
    }
    const all = waitingEntry === null ? entries : [...entries, waitingEntry];
    if (all.length === 0) return;
    if (this.#policy.notifyOnlyWhenUnfocused && this.#deps.isWindowFocused()) return;
    for (const entry of all) {
      this.#show(entry).catch((error: unknown) => (this.#deps.log ?? console.warn)(`studio: the autopilot host's notification failed (${error instanceof Error ? error.name : typeof error})`));
    }
  }

  async #show(entry: HostNotification): Promise<void> {
    let title = entry.title;
    if (entry.target.screen === "photos") {
      const name = await this.#deps.avatarName(entry.target.avatarId).catch(() => null);
      if (name !== null) title = `${REVIEW_TITLE}: ${name}`;
    }
    this.#deps.notifier.show({ title, body: entry.body }, () => this.#deps.openWindow(entry.target));
  }

  // ---- sleep ----

  /** One log line of the sleep: wall time, then the monotonic ms since the last `suspend` (n/a before any), then the event. Never a payload. */
  #note(event: string, wallDelta = false): void {
    const wall = Date.now();
    const mono = this.#suspendedWall === null ? "n/a" : `+${Math.round(this.#deps.now() - this.#suspendedAt)}ms`;
    const wallPart = wallDelta && this.#suspendedWall !== null ? ` wall +${wall - this.#suspendedWall}ms` : "";
    (this.#deps.log ?? console.warn)(`studio: autopilot host: ${new Date(wall).toISOString()} mono ${mono}${wallPart} ${event}`);
  }

  /** `powerMonitor` `suspend`: the engine sends no new attempt, the window's paid starts wait, and the blocker is let go. */
  suspend(): void {
    this.#asleep = true;
    this.#heldLogged.clear();
    this.#suspendedAt = this.#deps.now();
    this.#suspendedWall = Date.now();
    this.#note("suspend");
    this.#guard("power blocker", () => this.#syncBlocker());
    this.#guard("host.power", () => this.#deps.sendPower("suspend"));
  }

  /** `powerMonitor` `resume`: sending goes on. Armed to be said once more at the next sign of life (L-c). */
  resume(): void {
    const slept = this.#asleep;
    this.#note(slept ? "resume" : "resume (already awake)", true);
    this.#asleep = false;
    this.#resumePending = this.#policy.resendResumeOnActivity;
    this.#guard("power blocker", () => this.#syncBlocker());
    this.#guard("host.power", () => this.#deps.sendPower("resume"));
    if (slept) this.#note("woke by resume");
  }

  /** The Mac is awake though no `resume` said so: the sleep ends, the blocker may be held again, the engine is told. */
  #wake(reason: WakeReason): void {
    this.#asleep = false;
    this.#resumePending = false;
    this.#note(`woke by ${reason}`);
    this.#guard("power blocker", () => this.#syncBlocker());
    this.#guard("host.power", () => this.#deps.sendPower("resume"));
  }

  /**
   * A sign of life: a key press, a window focus, an unlock, the user becoming active. It ends a sleep whose `resume` never came, and says `resume` once more after one
   * that did (the engine ignores a `resume` it does not need), so a `resume` the engine lost does not strand the launch (L-c). A key or a focus within `activityIgnoreMs` after a
   * `suspend` is nothing: it is the key-up of the shortcut that slept the Mac. An unlock or `user-did-become-active` is not ignored: a quick Touch ID unlock is the owner.
   */
  activity(source: ActivitySource): void {
    if (this.#asleep) {
      const early = this.#deps.now() - this.#suspendedAt < this.#policy.activityIgnoreMs;
      if (early && (source === "key" || source === "focus")) {
        this.#note(`dropped early ${source}`);
        return;
      }
      this.#wake(source);
    } else if (this.#resumePending) {
      // Once per wake: which sign of life came after the `resume` (SP1 reads the order of the wake's events from these lines).
      this.#note(`activity after resume: ${source}`);
      this.#resumePending = false;
      this.#guard("host.power", () => this.#deps.sendPower("resume"));
    }
  }

  /**
   * L-d: whether this command of the window waits now. Only a command that starts paid work or moves a launch can (`commandHold.ts`); a read, a pause, a stop and a save always
   * pass. Only such a held command, the owner's click with an accepted sum, can also END the sleep, and only `commandRecoveryMs` after the `suspend`: the window's own reads
   * (made in answer to engine events) arrive in the gap between `suspend` and the real sleep, up to ~30 s on macOS and longer on Windows, and are no proof of wake.
   * ASSUMPTION for SP1 to check, not a fact: `performance.now()` does not run while the Mac sleeps, so the time is time awake.
   */
  refuses(type: CommandType): boolean {
    const held = heldWhileAsleep(type);
    if (this.#asleep && held && this.#deps.now() - this.#suspendedAt >= this.#policy.commandRecoveryMs) this.#wake("command");
    const refused = this.#policy.blockCommandsWhileAsleep && this.#asleep && held;
    // One line per command type per sleep: a window that repeats a held command while the `resume` is lost must not flood the log.
    if (refused && !this.#heldLogged.has(type)) {
      this.#heldLogged.add(type);
      this.#note(`held ${type}`);
    }
    return refused;
  }
}

/** Wires `powerMonitor` to the host. */
export function watchPower(monitor: PowerMonitorPort, host: AutopilotHost): void {
  monitor.on("suspend", () => host.suspend());
  monitor.on("resume", () => host.resume());
  monitor.on("unlock-screen", () => host.activity("unlock"));
  monitor.on("user-did-become-active", () => host.activity("active"));
}

/** The engine route of `handleRendererRequest`, refusing with the reason while the Mac sleeps (L-d). */
export function gateWhileAsleep(host: { refuses(type: CommandType): boolean }, route: (command: EngineCommandMessage) => Promise<ResponseMessage>): (command: EngineCommandMessage) => Promise<ResponseMessage> {
  return (command) => (host.refuses(command.type) ? Promise.resolve(errorResponseFor(command, { code: "INTERNAL", detail: HOST_ASLEEP_DETAIL })) : route(command));
}

/** «Остаться» in the quit dialog: where the last window's close is what asked (everywhere but macOS) its window is already gone, so one is opened again. */
export function reopensWindowAfterStay(platform: NodeJS.Platform, windowCount: number): boolean {
  return platform !== "darwin" && windowCount === 0;
}
