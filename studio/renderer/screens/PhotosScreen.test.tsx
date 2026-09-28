import { expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ERROR_MESSAGES_RU, type AvatarSummary, type PhotoSummary, type RunRequest } from "../../shared/engine";
import { mockDescriptor } from "../engine/mockEngine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { callsOf, flush, openSection, runAll, setup, tick, withText } from "../testing";

function avatar(name: string, n: number, status: AvatarSummary["status"] = "active"): AvatarSummary {
  const id = `${name.toLowerCase()}-000${n}`;
  return {
    avatarId: `avatar-${id}`,
    name,
    descriptor: mockDescriptor(DEFAULT_TRAITS),
    masterPhotoId: `photo-${id}`,
    createdAt: "2026-09-24T09:00:00.000Z",
    status,
    photoCount: 1,
  };
}

const MIA = avatar("Mia", 1);
const SOFIA = avatar("Sofia", 2);

function photo(n: number, patch: Partial<PhotoSummary> = {}): PhotoSummary {
  return {
    photoId: `photo-run-000${n}`,
    avatarId: MIA.avatarId,
    runId: "run-00000001",
    category: "home",
    resolution: "1k",
    createdAt: `2026-09-2${n}T10:00:00.000Z`,
    ...patch,
  };
}

/** The default request the screen opens with: 20 photos at 1K, every category, no profile or back. */
const DEFAULT_REQUEST: RunRequest = {
  avatarId: MIA.avatarId,
  count: 20,
  categories: ["home", "travel", "shoot", "glam", "fit"],
  resolution: "1k",
  poses: { profile: false, back: false },
};

/** Opens the Photos screen from the sidebar and waits for its first price: 20 × 1K is ≈ $1.01, до $3.07 in the mock. */
async function openPhotos(options: Parameters<typeof setup>[0] = {}) {
  const harness = setup({ avatars: [MIA], ...options });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  await openSection("Фото");
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  return harness;
}

async function priced(): Promise<HTMLElement> {
  return await screen.findByRole("button", { name: /до \$\d/ });
}

function goButton(): HTMLElement {
  const button = document.querySelector<HTMLElement>(".photos-go");
  if (!button) throw new Error("no generate button");
  return button;
}

function expectedText(): string {
  return document.querySelector(".photos-cost-total")?.textContent ?? "";
}

function isDisabled(el: HTMLElement): boolean {
  return el.hasAttribute("disabled");
}

// ---------- price ----------

test("the screen prices the run before anything is spent: expected «≈» and worst «до»", async () => {
  const { engine } = await openPhotos();
  expect((await priced()).textContent).toBe("Сгенерировать 20 фото · до $3.07");
  expect(expectedText()).toBe("Ожидаемая≈ $1.01");
  expect(callsOf(engine, "runs.estimate").map((c) => c.payload)).toEqual([DEFAULT_REQUEST]);
  expect(callsOf(engine, "runs.start")).toHaveLength(0);
  // The age check is off by default (owner's decision), and the price says where it came from.
  expect(screen.getByText("выкл.")).toBeDefined();
  expect(screen.getByText(/^OpenRouter · /)).toBeDefined();
});

test("every change of the request is priced again; the chips show the planner's split per category", async () => {
  const { engine } = await openPhotos();
  await priced();
  expect(screen.getByRole("button", { name: "Дом: 4 фото" }).getAttribute("aria-pressed")).toBe("true");

  fireEvent.click(screen.getByRole("button", { name: "Больше" }));
  expect(screen.getByText("25")).toBeDefined();
  // 25 × 3 attempts × $0.05 + one writer chunk $0.07 = $3.82; ≈ 25 × ($0.05 + $0.000458) = $1.26.
  await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 25 фото · до $3.82"));
  expect(expectedText()).toBe("Ожидаемая≈ $1.26");

  // 25 over four categories: the remainder goes to the earliest (the planner's own rule).
  fireEvent.click(screen.getByRole("button", { name: "Фитнес: 5 фото" }));
  expect(screen.getByRole("button", { name: "Дом: 7 фото" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Путешествия: 6 фото" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Фитнес" }).getAttribute("aria-pressed")).toBe("false");

  fireEvent.click(screen.getByRole("button", { name: "2K" }));
  // 75 attempts × $0.07 + $0.07 = $5.32.
  await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 25 фото · до $5.32"));
  expect(callsOf(engine, "runs.estimate").at(-1)?.payload).toEqual({ ...DEFAULT_REQUEST, count: 25, categories: ["home", "travel", "shoot", "glam"], resolution: "2k" });
});

test("the worst case rounds up on the button, and the raw micros are what is sent", async () => {
  const harness = setup({ avatars: [MIA] });
  // 60 attempts × $0.050001 + $0.07 = $3.070060: never shown as $3.07, which would understate the limit.
  harness.engine.setRunImagePrice("1k", 50_001);
  await openSection("Фото");
  const button = await priced();
  expect(button.textContent).toBe("Сгенерировать 20 фото · до $3.08");
  expect(expectedText()).toBe("Ожидаемая≈ $1.01");

  fireEvent.click(button);
  await screen.findByText(/Рисуем фото/);
  expect(callsOf(harness.engine, "runs.start").map((c) => c.payload.acceptedWorstMicros)).toEqual([3_070_060]);
});

test("an estimate answer for a request that is gone by then is dropped", async () => {
  const { engine, scheduler } = await openPhotos();
  await priced();
  engine.delayNext("runs.estimate", 50);
  const more = screen.getByRole("button", { name: "Больше" });
  fireEvent.click(more); // 25 photos: its price is held back
  fireEvent.click(more); // 30 photos: answered at once
  // 90 attempts × $0.05 + two writer chunks × $0.07.
  await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 30 фото · до $4.64"));

  tick(scheduler, 1); // the 25-photo price arrives late
  await flush();
  expect(goButton().textContent).toBe("Сгенерировать 30 фото · до $4.64");
});

test("a settings change that moves the price (the age check) prices the run again", async () => {
  const { client } = await openPhotos();
  await priced();
  expect(screen.getByText("выкл.")).toBeDefined();

  // As another window (or Settings) would: the engine's settings.changed reaches this window's store.
  await act(async () => {
    await client.request("settings.setImageAgeCheck", { imageAgeCheck: "on" });
  });
  // Every attempt gains an age check: 60 × $0.002 more.
  await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 20 фото · до $3.19"));
  expect(screen.getByText("вкл.")).toBeDefined();
});

test("the stepper stays within 5–100 photos", async () => {
  await openPhotos();
  await priced();
  const fewer = screen.getByRole("button", { name: "Меньше" });
  for (let i = 0; i < 5; i++) fireEvent.click(fewer);
  expect(screen.getByText("5")).toBeDefined();
  expect(isDisabled(fewer)).toBe(true);
  // 15 attempts × $0.05 + $0.07.
  await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 5 фото · до $0.82"));
});

test("the stepper stays within 5–100 photos at the top too, and stays put past 100 (M4)", async () => {
  await openPhotos();
  await priced();
  const more = screen.getByRole("button", { name: "Больше" });
  for (let i = 0; i < 15; i++) fireEvent.click(more); // 20 → 95, the stepper's own last step below the cap
  expect(screen.getByText("95")).toBeDefined();
  expect(isDisabled(more)).toBe(false);

  fireEvent.click(more); // 95 → 100
  expect(screen.getByText("100")).toBeDefined();
  expect(isDisabled(more)).toBe(true);

  fireEvent.click(more); // one more click must not push past the contract's own max
  expect(screen.getByText("100")).toBeDefined();
  // 300 attempts × $0.05 + 4 writer chunks (25 photos each) × $0.07.
  await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 100 фото · до $15.28"));
});

test("with no category chosen there is nothing to price and nothing to start", async () => {
  const { engine } = await openPhotos();
  await priced();
  for (const name of [/^Дом/, /^Путешествия/, /^Фотосессия/, /^Гламур 18\+/, /^Фитнес/]) fireEvent.click(screen.getByRole("button", { name }));
  await flush();

  expect(isDisabled(goButton())).toBe(true);
  expect(goButton().textContent).toBe("Сгенерировать 20 фото");
  expect(screen.getByText("Выберите хотя бы одну категорию.")).toBeDefined();
  // Priced at every step down to one category, never with none (the contract requires at least one).
  expect(callsOf(engine, "runs.estimate").map((c) => c.payload.categories.length)).toEqual([5, 4, 3, 2, 1]);
  expect(screen.queryByText(/Гламур — только неоткровенные наряды/)).toBeNull();
});

test("turning off every category clears a stale estimate error, not just the price (L12)", async () => {
  const { engine } = await openPhotos();
  await priced();
  fireEvent.click(screen.getByRole("button", { name: /^Дом/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Путешествия/ }));
  fireEvent.click(screen.getByRole("button", { name: /^Фотосессия/ }));
  await flush();

  // Two categories left; the next estimate (for one category left) fails.
  engine.failNext("runs.estimate", { code: "NETWORK" });
  fireEvent.click(screen.getByRole("button", { name: /^Гламур 18\+/ })); // one left: Фитнес
  await screen.findByText(ERROR_MESSAGES_RU.NETWORK);

  fireEvent.click(screen.getByRole("button", { name: /^Фитнес/ })); // the last one off: nothing left to price
  await flush();
  expect(screen.queryByText(ERROR_MESSAGES_RU.NETWORK)).toBeNull();
  expect(screen.getByText("Выберите хотя бы одну категорию.")).toBeDefined();
});

// ---------- start ----------

test("start sends exactly the request and the worst case the button showed", async () => {
  const { engine } = await openPhotos();
  fireEvent.click(await priced());

  await screen.findByText("Рисуем фото: 0 из 20");
  expect(callsOf(engine, "runs.start").map((c) => c.payload)).toEqual([{ ...DEFAULT_REQUEST, acceptedWorstMicros: 3_070_000 }]);
  // The engine refuses a second run of this avatar while one runs: the button waits and says why.
  expect(isDisabled(goButton())).toBe(true);
  expect(screen.getByText("Дождитесь конца текущего запуска.")).toBeDefined();
  // The sidebar queue knows the run's size from the start, before its first progress event.
  expect(within(screen.getByRole("region", { name: "Очередь" })).getByText("0 / 20")).toBeDefined();
});

test("the poses toggles map to RunRequest.poses; front and three-quarter are always on", async () => {
  const { engine } = await openPhotos();
  await priced();

  const front = screen.getByRole("button", { name: "Анфас" });
  expect(front.getAttribute("aria-pressed")).toBe("true");
  expect(front.getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByRole("button", { name: "Три четверти" }).getAttribute("aria-disabled")).toBe("true");
  expect(screen.getByText("профиль и со спины — только если разрешите, без проверки сходства")).toBeDefined();

  const profile = screen.getByRole("button", { name: "Профиль" });
  expect(profile.getAttribute("aria-pressed")).toBe("false");
  fireEvent.click(profile);
  expect(profile.getAttribute("aria-pressed")).toBe("true");
  await waitFor(() => expect(callsOf(engine, "runs.estimate").at(-1)?.payload.poses).toEqual({ profile: true, back: false }));
  await waitFor(() => expect(isDisabled(goButton())).toBe(false));

  fireEvent.click(goButton());
  await screen.findByText(/Рисуем фото/);
  expect(callsOf(engine, "runs.start")[0]?.payload.poses).toEqual({ profile: true, back: false });
});

test("the button and the form are locked while runs.start is in flight, and a second click sends nothing", async () => {
  const { engine, scheduler } = await openPhotos();
  const button = await priced();
  engine.delayNext("runs.start", 50);

  fireEvent.click(button);
  fireEvent.click(button);
  expect(button.textContent).toBe("Отправляем… · до $3.07");
  expect(isDisabled(button)).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");
  // The whole form sits in a disabled fieldset (the browser disables every control in it; happy-dom
  // does not model that inheritance, so the fieldset itself is what is checked here).
  expect(document.querySelector("fieldset.lock-dim")?.hasAttribute("disabled")).toBe(true);
  expect(document.querySelector("fieldset.lock-dim")?.contains(screen.getByRole("button", { name: "Больше" }))).toBe(true);

  tick(scheduler, 1);
  await screen.findByText("Рисуем фото: 0 из 20");
  expect(callsOf(engine, "runs.start")).toHaveLength(1);
  expect(document.querySelector("fieldset.lock-dim")?.hasAttribute("disabled")).toBe(false);
});

test("unmounting mid-flight still tracks the started run in the window-wide store (M4)", async () => {
  const { engine, scheduler } = await openPhotos();
  const button = await priced();
  engine.delayNext("runs.start", 50);
  fireEvent.click(button);
  expect(button.textContent).toContain("Отправляем…");

  // Navigate away before runs.start answers: GenerateCard (and the whole
  // Photos screen) unmounts mid-flight.
  await openSection("Аватары");
  await screen.findByRole("heading", { level: 2, name: "Mia" });

  tick(scheduler, 1); // runs.start answers now, with nothing mounted to receive it
  await flush();

  // The window-wide store still learned of it (store.trackRunJob runs before
  // the component's mounted check): the sidebar queue shows it under way.
  expect(within(screen.getByRole("region", { name: "Очередь" })).getByText("0 / 20")).toBeDefined();

  await openSection("Фото");
  await screen.findByText(/Рисуем фото/);
  expect(callsOf(engine, "runs.start")).toHaveLength(1);
});

test("PRICE_CHANGED keeps the button busy until the fresh price replaces it, then asks again", async () => {
  const { engine, scheduler } = await openPhotos();
  const button = await priced();
  engine.setRunImagePrice("1k", 60_000);
  engine.delayNext("runs.estimate", 50);

  fireEvent.click(button);
  await waitFor(() => expect(callsOf(engine, "runs.estimate")).toHaveLength(2));
  // The re-price is on its way: the refused price is still on a disabled, busy button.
  expect(isDisabled(goButton())).toBe(true);
  expect(goButton().getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByText("Цена выросла")).toBeNull();

  tick(scheduler, 1);
  await screen.findByText("Цена выросла");
  // 60 attempts × $0.06 + $0.07.
  expect(screen.getByText(withText(/Было не больше \$3\.07, теперь не больше \$3\.67/))).toBeDefined();
  expect(goButton().textContent).toBe("Подтвердить новую цену · до $3.67");
  expect(callsOf(engine, "runs.start")).toHaveLength(1);

  fireEvent.click(goButton());
  await screen.findByText(/Рисуем фото/);
  expect(callsOf(engine, "runs.start").map((c) => c.payload.acceptedWorstMicros)).toEqual([3_070_000, 3_670_000]);
  expect(screen.queryByText("Цена выросла")).toBeNull();
});

test("a failed re-price after PRICE_CHANGED drops the refused price: the button can only ask again", async () => {
  const { engine } = await openPhotos();
  const button = await priced();
  engine.setRunImagePrice("1k", 60_000);
  engine.failNext("runs.estimate", { code: "NETWORK" });

  fireEvent.click(button);
  await screen.findByText(ERROR_MESSAGES_RU.NETWORK);
  expect(goButton().textContent).toBe("Повторить оценку");
  expect(goButton().textContent).not.toContain("$3.07");
  expect(expectedText()).toBe("Ожидаемая—");
  expect(callsOf(engine, "runs.start")).toHaveLength(1);

  fireEvent.click(goButton());
  await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 20 фото · до $3.67"));
  expect(callsOf(engine, "runs.start")).toHaveLength(1);
});

test("PRICE_CHANGED reads «Цена изменилась», not «выросла», when the fresh price is not actually higher (L4)", async () => {
  const { engine, scheduler } = await openPhotos();
  const button = await priced(); // $3.07
  engine.setRunImagePrice("1k", 60_000); // server-side price now higher; the client still shows $3.07
  engine.delayNext("runs.estimate", 50); // delays the reprice inside start(), not the mount-time one already resolved

  fireEvent.click(button); // accepts $3.07 — refused PRICE_CHANGED against the now-higher price
  await waitFor(() => expect(callsOf(engine, "runs.estimate")).toHaveLength(2));

  // The price drops back to exactly what was accepted before the reprice answers.
  engine.setRunImagePrice("1k", 50_000);
  tick(scheduler, 1);

  await screen.findByText("Цена изменилась");
  expect(screen.queryByText("Цена выросла")).toBeNull();
  expect(goButton().textContent).toBe("Подтвердить новую цену · до $3.07");
});

test("PRICE_CHANGED for a stale key must not clobber a fresher price the key's own re-estimate already landed", async () => {
  // K1: age check off, до $3.07. Clicking accepts K1's price; while runs.start
  // is in flight, another window turns the age check on — a genuinely new key
  // (K2) whose own estimate effect fires and lands ($3.19) before runs.start
  // answers PRICE_CHANGED for the (now stale) K1 request it was sent with.
  const { engine, scheduler, client } = await openPhotos();
  const button = await priced();
  expect(button.textContent).toBe("Сгенерировать 20 фото · до $3.07");

  engine.delayNext("runs.start", 50);
  fireEvent.click(button);

  await act(async () => {
    await client.request("settings.setImageAgeCheck", { imageAgeCheck: "on" });
  });
  // K2's own estimate, asked for by the key change alone, lands in the
  // background — but while sending, the button shows K1's own accepted worst
  // (LOW-4), the price actually in flight, not K2's fresher one.
  await flush();
  expect(goButton().textContent).toBe("Отправляем… · до $3.07");

  tick(scheduler, 1); // runs.start (sent for K1) is handled now: PRICE_CHANGED
  await flush();

  // K2's price must still be the one shown — not clobbered by the stale
  // re-price the PRICE_CHANGED path asks for K1 — and the button must be
  // clickable, not stuck disabled with nothing to accept.
  expect(goButton().textContent).toBe("Сгенерировать 20 фото · до $3.19");
  expect(isDisabled(goButton())).toBe(false);
  expect(screen.queryByText("Цена выросла")).toBeNull();

  fireEvent.click(goButton());
  await screen.findByText(/Рисуем фото/);
  expect(callsOf(engine, "runs.start").map((c) => c.payload)).toEqual([
    { ...DEFAULT_REQUEST, acceptedWorstMicros: 3_070_000 },
    { ...DEFAULT_REQUEST, acceptedWorstMicros: 3_190_000 },
  ]);
});

test("a refusal other than PRICE_CHANGED is shown and the price stays for another try", async () => {
  const { engine } = await openPhotos({ money: { monthlyBudgetMicros: 1_000_000 } });
  fireEvent.click(await priced());
  await screen.findByText(ERROR_MESSAGES_RU.BUDGET_EXCEEDED);
  expect(goButton().textContent).toBe("Сгенерировать 20 фото · до $3.07");
  expect(isDisabled(goButton())).toBe(false);
  expect(callsOf(engine, "runs.start")).toHaveLength(1);
});

test("without a usable key the price shows but nothing paid can be sent", async () => {
  const { engine } = await openPhotos({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
  const button = await priced();
  expect(isDisabled(button)).toBe(true);
  expect(screen.getByText("Нужен рабочий ключ OpenRouter — добавьте его в Настройках.")).toBeDefined();
  fireEvent.click(button);
  await flush();
  expect(callsOf(engine, "runs.start")).toHaveLength(0);
});

test("an archived avatar keeps its gallery but is never priced or started", async () => {
  const archived = avatar("Nora", 3, "archived");
  const { engine } = setup({ avatars: [archived], photos: [photo(1, { avatarId: archived.avatarId })] });
  await openSection("Фото");
  await screen.findByRole("heading", { level: 1, name: "Nora" });
  await screen.findByText("лицо не проверялось");

  expect(screen.getByText("Аватар в архиве — новые фото для него не создаются.")).toBeDefined();
  expect(isDisabled(goButton())).toBe(true);
  expect(callsOf(engine, "runs.estimate")).toHaveLength(0);
});

// ---------- the running job ----------

test("a running run shows its progress and pending tiles; each step refreshes the gallery", async () => {
  const { engine, scheduler } = await openPhotos({ concurrency: 2 });
  fireEvent.click(await priced());
  await screen.findByText("Рисуем фото: 0 из 20");
  // At most the network's concurrency can be drawing; the rest wait in one tile.
  expect(screen.getAllByText("Рисуется")).toHaveLength(2);
  expect(screen.getByText("ещё 18")).toBeDefined();

  const listed = callsOf(engine, "photos.list").length;
  tick(scheduler, 1);
  await screen.findByText("Рисуем фото: 1 из 20");
  await screen.findByText("лицо 0.86");
  expect(callsOf(engine, "photos.list").length).toBeGreaterThan(listed);
  expect(screen.getByText("ещё 17")).toBeDefined();
  expect(screen.getByRole("progressbar", { name: "Рисуем фото: 1 из 20" }).getAttribute("aria-valuenow")).toBe("1");

  runAll(scheduler);
  await screen.findByText("Запуск завершён");
  expect(screen.getByText(/В галерее 20 фото этого запуска\./)).toBeDefined();
  expect(screen.queryByText("Рисуется")).toBeNull();
  await waitFor(() => expect(document.querySelectorAll(".photo-tile:not(.photo-tile-drawing):not(.photo-tile-queued)")).toHaveLength(20));
  // Every fifth photo carries no similarity in the mock (a profile or back shot).
  expect(screen.getAllByText("лицо не проверялось")).toHaveLength(4);
});

test("a second run started by another window after this one saw the first finish is shown as running (HIGH regression, P1)", async () => {
  const { scheduler, client } = await openPhotos();
  await priced();
  // Both runs start straight through the engine, like another window's own
  // GenerateCard would: this screen never calls store.trackRunJob for
  // either, so each is known only through its own events.
  const r1 = await act(async () => client.request("runs.start", { ...DEFAULT_REQUEST, acceptedWorstMicros: 3_070_000 }));
  if (!r1.ok) throw new Error(`r1 ${r1.error.code}`);
  tick(scheduler, 1); // an intermediate render while running, so this screen actually watches it (and can then notice it end)
  await screen.findByText("Рисуем фото: 1 из 20");
  runAll(scheduler);
  await flush();
  await screen.findByText("Запуск завершён");

  const r2 = await act(async () => client.request("runs.start", { ...DEFAULT_REQUEST, acceptedWorstMicros: 3_070_000 }));
  if (!r2.ok) throw new Error(`r2 ${r2.error.code}`);
  tick(scheduler, 1);
  await flush();

  // The second run must show as running, not the first (already finished) one.
  await screen.findByText("Рисуем фото: 1 из 20");
  expect(isDisabled(goButton())).toBe(true);
  expect(screen.getByText("Дождитесь конца текущего запуска.")).toBeDefined();
  expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(false);
});

test("cancel shows «Отменяем…» until the job really ends; the cancelled attempts' reserves stay open until reconciled (M3)", async () => {
  const { engine, scheduler, client } = await openPhotos();
  fireEvent.click(await priced());
  await screen.findByText("Рисуем фото: 0 из 20");
  tick(scheduler, 1);
  await screen.findByText("Рисуем фото: 1 из 20");
  const listed = await client.request("runs.list", {});
  const started = (listed.ok ? listed.result.runs.find((r) => r.running)?.runId : undefined) ?? "no running run";
  expect(started).toMatch(/^run-/);

  fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
  expect(screen.getByRole("button", { name: "Отменяем…" }).hasAttribute("disabled")).toBe(true);
  await flush();
  // Exactly the run this screen started — not merely some run (LOW-1).
  expect(callsOf(engine, "runs.cancel").map((c) => c.payload.runId)).toEqual([started]);
  // Accepted, but the job has not ended yet.
  expect(screen.getByRole("button", { name: "Отменяем…" })).toBeDefined();
  expect(screen.queryByText("Генерация остановлена")).toBeNull();

  runAll(scheduler);
  await screen.findByText("Генерация остановлена");
  await screen.findByText(/Готово 1 из 20 · осталось 19/);
  // The 19 open slots' reserves stay open, like the real engine's own
  // open-reserves rule (and the mock's avatar.candidates cancel) — but only
  // 6 of them (the network's own default concurrency) were ever actually in
  // flight (MEDIUM-2): no paid start or resume until a reconcile, and the
  // price meanwhile is capped by what the cap has left on top of that (до
  // $2.12), not the open slots' own raw worst case (до $2.85).
  expect(screen.getAllByText("Платные запросы остановлены до сверки расходов.").length).toBeGreaterThan(0);
  expect(isDisabled(goButton())).toBe(true);
  // The row still shows its price — runs.estimateResume is free — but cannot be clicked while blocked.
  const resume = await screen.findByRole("button", { name: "Продолжить · до $2.12" });
  expect(isDisabled(resume)).toBe(true);

  await act(async () => {
    await client.request("money.reconcile", {});
  });
  await waitFor(() => expect(screen.queryByText("Платные запросы остановлены до сверки расходов.")).toBeNull());
  expect(isDisabled(goButton())).toBe(false);
  // Reconciling releases the 13 slots that were never actually sent: the row
  // re-asks its price on its own (MEDIUM-1) and shows the higher, uncapped one.
  const resumeAfter = await screen.findByRole("button", { name: "Продолжить · до $2.85" });
  expect(isDisabled(resumeAfter)).toBe(false);

  fireEvent.click(resumeAfter);
  await screen.findByText("Рисуем фото: 1 из 20");
  expect(callsOf(engine, "runs.resume").map((c) => c.payload.runId)).toEqual([started]);
});

test("cancel targets the run this window started even after the screen remounts and runs.list then fails (M2)", async () => {
  const { engine, scheduler, client } = await openPhotos();
  fireEvent.click(await priced());
  await screen.findByText("Рисуем фото: 0 из 20");
  tick(scheduler, 1);
  await screen.findByText("Рисуем фото: 1 из 20");
  const listed = await client.request("runs.list", {});
  const started = (listed.ok ? listed.result.runs.find((r) => r.running)?.runId : undefined) ?? "no running run";
  expect(started).toMatch(/^run-/);

  // Leaving and coming back remounts AvatarPhotos: any runId kept only in
  // component state (the old `ownRuns`) would be lost here. runs.list, which
  // cancel must not depend on for a run this window itself started, is made
  // to fail on top of that.
  await openSection("Аватары");
  engine.failNext("runs.list", { code: "INTERNAL" });
  await openSection("Фото");
  await screen.findByText("Рисуем фото: 1 из 20");
  await flush();

  const cancel = screen.getByRole("button", { name: "Отменить" });
  expect(cancel.hasAttribute("disabled")).toBe(false);
  fireEvent.click(cancel);
  await flush();
  // Exactly the run this screen started — not merely some run (LOW-1).
  expect(callsOf(engine, "runs.cancel").map((c) => c.payload.runId)).toEqual([started]);
});

test("a run job seen only through another window's progress resolves its cancel target via runs.list, with a retry on failure (M2)", async () => {
  const { engine, scheduler, client } = setup({ avatars: [MIA] });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  // Simulated another window: the run starts straight through the engine,
  // never through this window's own GenerateCard (so store.trackRunJob,
  // which would otherwise record its runId right away, is never called).
  const reply = await act(async () => client.request("runs.start", { ...DEFAULT_REQUEST, acceptedWorstMicros: 3_070_000 }));
  if (!reply.ok) throw new Error(`expected ok, got ${reply.error.code}`);
  tick(scheduler, 1);
  await flush();

  engine.failNext("runs.list", { code: "INTERNAL" });
  await openSection("Фото");
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  await screen.findByText("Рисуем фото: 1 из 20");
  await screen.findByText(ERROR_MESSAGES_RU.INTERNAL);

  // The runId is not known yet (only job.progress has been seen): cancel waits, not stuck forever.
  expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  await waitFor(() => expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(false));

  fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
  await flush();
  expect(callsOf(engine, "runs.cancel").map((c) => c.payload.runId)).toEqual([reply.result.runId]);
});

test("a stopped run is resumed with exactly the worst case runs.estimateResume showed", async () => {
  const harness = setup({ avatars: [MIA] });
  const runId = harness.engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home", "travel"], resolution: "1k" }, 8);
  await openSection("Фото");

  const resume = await screen.findByRole("button", { name: "Продолжить · до $0.60" });
  expect(screen.getByText(/Готово 8 из 12 · осталось 4/)).toBeDefined();
  expect(callsOf(harness.engine, "runs.estimateResume").map((c) => c.payload)).toEqual([{ runId }]);
  expect(callsOf(harness.engine, "runs.resume")).toHaveLength(0);

  fireEvent.click(resume);
  await screen.findByText("Рисуем фото: 8 из 12");
  expect(callsOf(harness.engine, "runs.resume").map((c) => c.payload)).toEqual([{ runId, acceptedWorstMicros: 600_000 }]);
  // The resumed run is running now: no second resume offered for it.
  await waitFor(() => expect(screen.queryByRole("button", { name: /Продолжить/ })).toBeNull());
});

test("a resume refused with PRICE_CHANGED shows the new price and asks again", async () => {
  const harness = setup({ avatars: [MIA] });
  const runId = harness.engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home"], resolution: "1k" }, 8);
  await openSection("Фото");
  const resume = await screen.findByRole("button", { name: "Продолжить · до $0.60" });
  harness.engine.setRunImagePrice("1k", 60_000);

  fireEvent.click(resume);
  const confirm = await screen.findByRole("button", { name: "Подтвердить новую цену · до $0.72" });
  expect(screen.getByText(withText(/Было не больше \$0\.60, теперь не больше \$0\.72/))).toBeDefined();

  fireEvent.click(confirm);
  await screen.findByText("Рисуем фото: 8 из 12");
  expect(callsOf(harness.engine, "runs.resume").map((c) => c.payload)).toEqual([
    { runId, acceptedWorstMicros: 600_000 },
    { runId, acceptedWorstMicros: 720_000 },
  ]);
});

test("a resume's PRICE_CHANGED also reads «Цена изменилась», not «выросла», when the fresh price is not actually higher (L4)", async () => {
  const harness = setup({ avatars: [MIA] });
  harness.engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home"], resolution: "1k" }, 8);
  await openSection("Фото");
  const resume = await screen.findByRole("button", { name: "Продолжить · до $0.60" });
  harness.engine.setRunImagePrice("1k", 60_000);
  harness.engine.delayNext("runs.estimateResume", 50);

  fireEvent.click(resume);
  await waitFor(() => expect(callsOf(harness.engine, "runs.estimateResume")).toHaveLength(2));

  harness.engine.setRunImagePrice("1k", 50_000); // back to exactly what was accepted, before the reprice answers
  tick(harness.scheduler, 1);

  await screen.findByText("Цена изменилась");
  expect(screen.queryByText("Цена выросла")).toBeNull();
  expect(await screen.findByRole("button", { name: "Подтвердить новую цену · до $0.60" })).toBeDefined();
});

test("a resume stays busy through its PRICE_CHANGED re-price, and a double click sends one resume", async () => {
  const harness = setup({ avatars: [MIA] });
  harness.engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home"], resolution: "1k" }, 8);
  await openSection("Фото");
  const resume = await screen.findByRole("button", { name: "Продолжить · до $0.60" });
  harness.engine.setRunImagePrice("1k", 60_000);
  harness.engine.delayNext("runs.estimateResume", 50);

  fireEvent.click(resume);
  fireEvent.click(resume);
  await waitFor(() => expect(callsOf(harness.engine, "runs.estimateResume")).toHaveLength(2));
  // Refused, and the new price is on its way: the old one is still on a disabled, busy button.
  expect(callsOf(harness.engine, "runs.resume")).toHaveLength(1);
  expect(resume.hasAttribute("disabled")).toBe(true);
  expect(resume.getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByText("Цена выросла")).toBeNull();

  tick(harness.scheduler, 1);
  const confirm = await screen.findByRole("button", { name: "Подтвердить новую цену · до $0.72" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await screen.findByText("Рисуем фото: 8 из 12");
  expect(callsOf(harness.engine, "runs.resume").map((c) => c.payload.acceptedWorstMicros)).toEqual([600_000, 720_000]);
});

test("a resume in flight locks the generate card too, until it answers (L5)", async () => {
  const harness = setup({ avatars: [MIA] });
  harness.engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home"], resolution: "1k" }, 8);
  await openSection("Фото");
  const resume = await screen.findByRole("button", { name: "Продолжить · до $0.60" });
  await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 20 фото · до $3.07"));

  harness.engine.delayNext("runs.resume", 50);
  fireEvent.click(resume);
  expect(isDisabled(goButton())).toBe(true);
  expect(screen.getByText(/Дождитесь окончания другого платного действия/)).toBeDefined();
  fireEvent.click(goButton()); // must really do nothing, not merely look disabled
  await flush();
  expect(callsOf(harness.engine, "runs.start")).toHaveLength(0);

  tick(harness.scheduler, 1);
  await screen.findByText("Рисуем фото: 8 из 12");
  // The card unlocks from the shared flag, but stays blocked for the usual reason (a run is now active).
  expect(isDisabled(goButton())).toBe(true);
  expect(screen.getByText("Дождитесь конца текущего запуска.")).toBeDefined();
});

test("the generate card in flight locks every resume row too, until it answers (L5)", async () => {
  const harness = setup({ avatars: [MIA] });
  harness.engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home"], resolution: "1k" }, 8);
  await openSection("Фото");
  const resume = await screen.findByRole("button", { name: "Продолжить · до $0.60" });
  await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 20 фото · до $3.07"));

  harness.engine.delayNext("runs.start", 50);
  fireEvent.click(goButton());
  expect(isDisabled(resume)).toBe(true);
  fireEvent.click(resume); // must really do nothing
  await flush();
  expect(callsOf(harness.engine, "runs.resume")).toHaveLength(0);

  tick(harness.scheduler, 1);
  await screen.findByText(/Рисуем фото/);
});

test("a remount while runs.start is in flight still locks the new card, so a second start cannot be sent (LOW-3, P2)", async () => {
  const { engine, scheduler } = await openPhotos();
  const btn = await priced();
  engine.delayNext("runs.start", 50);
  fireEvent.click(btn);

  // Leaving and coming back remounts AvatarPhotos entirely: a paid-in-flight
  // flag kept only in its own component state would be lost here.
  await openSection("Аватары");
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  await openSection("Фото");
  await screen.findByRole("heading", { level: 1, name: "Mia" });

  await waitFor(() => expect(goButton().textContent).toContain("до $"));
  expect(isDisabled(goButton())).toBe(true);
  expect(screen.getByText("Дождитесь окончания другого платного действия.")).toBeDefined();

  fireEvent.click(goButton()); // must really do nothing, not merely look disabled
  await flush();
  tick(scheduler, 1); // the original runs.start answers now
  await flush();
  expect(callsOf(engine, "runs.start")).toHaveLength(1);
});

test("a failed re-price after a resume's PRICE_CHANGED drops the refused price: the row can only ask again", async () => {
  const harness = setup({ avatars: [MIA] });
  harness.engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home"], resolution: "1k" }, 8);
  await openSection("Фото");
  const resume = await screen.findByRole("button", { name: "Продолжить · до $0.60" });
  harness.engine.setRunImagePrice("1k", 60_000);
  harness.engine.failNext("runs.estimateResume", { code: "NETWORK" });

  fireEvent.click(resume);
  const ask = await screen.findByRole("button", { name: "Узнать цену" });
  expect(ask.textContent).not.toContain("$");
  expect(screen.getByText(ERROR_MESSAGES_RU.NETWORK)).toBeDefined();

  fireEvent.click(ask);
  expect(await screen.findByRole("button", { name: "Продолжить · до $0.72" })).toBeDefined();
  expect(callsOf(harness.engine, "runs.resume")).toHaveLength(1);
});

test("a resume row whose very first (mount-time) estimateResume fails shows «Узнать цену», with a retry that gets it (M4)", async () => {
  const harness = setup({ avatars: [MIA] });
  harness.engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home"], resolution: "1k" }, 8);
  harness.engine.failNext("runs.estimateResume", { code: "NETWORK" });
  await openSection("Фото");

  const ask = await screen.findByRole("button", { name: "Узнать цену" });
  expect(ask.textContent).not.toContain("$");
  expect(screen.getByText(ERROR_MESSAGES_RU.NETWORK)).toBeDefined();
  expect(callsOf(harness.engine, "runs.resume")).toHaveLength(0);

  fireEvent.click(ask);
  expect(await screen.findByRole("button", { name: "Продолжить · до $0.60" })).toBeDefined();
  expect(screen.queryByText(ERROR_MESSAGES_RU.NETWORK)).toBeNull();
});

test("a resume whose cap is fully used up shows a non-paid «limit exhausted» state, never «до $0.00» (L6)", async () => {
  const harness = setup({ avatars: [MIA] });
  // 8 done slots at $0.05 each settled $0.40; the cap is seeded at exactly that, leaving nothing for the 4 open slots.
  harness.engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home"], resolution: "1k" }, 8, 400_000);
  await openSection("Фото");

  await screen.findByText("Лимит запуска исчерпан");
  expect(screen.queryByRole("button", { name: /Продолжить/ })).toBeNull();
  expect(screen.queryByText("до $0.00")).toBeNull();
  expect(callsOf(harness.engine, "runs.resume")).toHaveLength(0);
});

// ---------- the gallery ----------

test("a failed refresh keeps the gallery already shown and says what went wrong above it", async () => {
  const { engine, scheduler } = await openPhotos({ photos: [photo(1, { qa: { faceCos: 0.9 } })] });
  await screen.findByText("лицо 0.90");
  fireEvent.click(await priced());
  await screen.findByText("Рисуем фото: 0 из 20");

  engine.failNext("photos.list", { code: "INTERNAL" });
  tick(scheduler, 1); // a slot lands: the gallery asks again, and that ask fails
  await screen.findByText(ERROR_MESSAGES_RU.INTERNAL);
  expect(screen.getByText("лицо 0.90")).toBeDefined();
  expect(screen.getAllByText("Рисуется").length).toBeGreaterThan(0);
});

test("the gallery shows each photo's face similarity, and says when the face was not checked", async () => {
  await openPhotos({
    photos: [
      photo(1, { qa: { faceCos: 0.86 } }),
      photo(2, { category: "travel" }),
      photo(3, { category: "fit", qa: { faceCos: 0.412, age: { adult: true, confidence: 0.9 } } }),
    ],
  });
  const high = await screen.findByText("лицо 0.86");
  expect(high.className).not.toContain("photo-face-low");
  // Stored under the gate's 0.55 retry line (its attempts ran out): flagged for the owner's eye.
  expect(screen.getByText("лицо 0.41").className).toContain("photo-face-low");
  expect(screen.getAllByText("лицо не проверялось")).toHaveLength(1);
  expect(screen.getByRole("img", { name: "Фото 2: Путешествия" })).toBeDefined();
  // Every pick button is told apart by its position, not only its category.
  expect(screen.getByRole("button", { name: "Выбрать для монтажа: фото 2, Путешествия" })).toBeDefined();
  // Newest first, as photos.list answers.
  const labels = Array.from(document.querySelectorAll(".photo-label")).map((l) => l.textContent);
  expect(labels).toEqual(["Фитнес", "Путешествия", "Дом"]);
  expect(screen.getByText("3 фото")).toBeDefined();
});

test("the low-score badge styling compares on the same rounded value it displays, not the raw score (L2)", async () => {
  await openPhotos({
    photos: [
      photo(1, { qa: { faceCos: 0.5449 } }), // rounds down to «0.54»: below the line
      photo(2, { category: "travel", qa: { faceCos: 0.545 } }), // rounds up to «0.55»: at the line, not below
      photo(3, { category: "fit", qa: { faceCos: 0.55 } }), // exactly the line
      photo(4, { category: "shoot", qa: { faceCos: 0.549 } }), // rounds up to «0.55»: must not read as low
    ],
  });
  await screen.findByText("лицо 0.54");
  expect(screen.getByText("лицо 0.54").className).toContain("photo-face-low");
  for (const label of ["лицо 0.55"]) {
    // Three photos (0.545, 0.55, 0.549) all round to the same displayed «0.55» and must all read the same way.
    const badges = screen.getAllByText(label);
    expect(badges).toHaveLength(3);
    for (const badge of badges) expect(badge.className).not.toContain("photo-face-low");
  }
});

test("photos picked for a montage are marked and counted; the montage itself is still to come", async () => {
  await openPhotos({ photos: [photo(1, { qa: { faceCos: 0.8 } }), photo(2)] });
  const pick = await screen.findAllByRole("button", { name: /Выбрать для монтажа/ });
  const montage = screen.getByRole("button", { name: /Монтаж из выбранных/ });
  expect(montage.textContent).toBe("Монтаж из выбранных · 0");
  expect(isDisabled(montage)).toBe(true);

  fireEvent.click(pick[0] ?? document.body);
  expect(pick[0]?.getAttribute("aria-pressed")).toBe("true");
  expect(pick[0]?.closest(".photo-tile")?.classList.contains("photo-tile-on")).toBe(true);
  expect(montage.textContent).toBe("Монтаж из выбранных · 1");
});

test("photos the engine could not list are counted discreetly after the gallery", async () => {
  await openPhotos({ photos: [photo(1)], skippedPhotos: { [MIA.avatarId]: 3 } });
  const note = await screen.findByRole("note", { name: "Показаны не все фото" });
  expect(within(note).getByText("Ещё 3 фото не читаются.")).toBeDefined();
});

test("an avatar with no photos yet gets an empty gallery that says where they will come from", async () => {
  await openPhotos();
  expect(await screen.findByText("Фото пока нет")).toBeDefined();
  expect(screen.getByText("0 фото")).toBeDefined();
  expect(screen.queryByRole("button", { name: /Продолжить/ })).toBeNull();
  expect(screen.queryByRole("note", { name: "Показаны не все фото" })).toBeNull();
});

test("a failed photos.list is shown with a retry", async () => {
  const harness = setup({ avatars: [MIA], photos: [photo(1)] });
  harness.engine.failNext("photos.list", { code: "INTERNAL" });
  await openSection("Фото");
  await screen.findByText(ERROR_MESSAGES_RU.INTERNAL);
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  expect(await screen.findByText("лицо не проверялось")).toBeDefined();
});

// ---------- later stages, marked ----------

test("the shot caption's quality word matches the model: «low» for the settings' own model, none for the Seedream fallback (L3)", async () => {
  const { client } = await openPhotos();
  await screen.findByText(/· low · 9:16 · референс — мастер-портрет$/);

  await act(async () => {
    await client.request("settings.setModels", { imageModel: "bytedance-seed/seedream-5-0-pro", textModel: "x-ai/grok-4.3" });
  });
  // The engine's own route sends quality: null once the settings' image model
  // already is the fallback (nothing lower to fall back to): no «low» here either.
  await screen.findByText(/· 9:16 · референс — мастер-портрет$/);
  expect(screen.queryByText(/· low · 9:16/)).toBeNull();
});

test("what the contract cannot do yet is drawn disabled and marked «скоро»", async () => {
  await openPhotos();
  await priced();
  for (const name of ["История сцен", "Видео"]) expect(isDisabled(screen.getByRole("tab", { name }))).toBe(true);
  expect(screen.getByRole("tab", { name: "Фото" }).getAttribute("aria-selected")).toBe("true");
  expect(isDisabled(screen.getByRole("button", { name: "Пересоставить" }))).toBe(true);
  expect(isDisabled(screen.getByRole("button", { name: "Неиспользованные" }))).toBe(true);
  expect(isDisabled(screen.getByRole("button", { name: "Отклонённые" }))).toBe(true);
  const review = screen.getByRole("switch", { name: "Сцены на проверку" });
  // Owner decision: aria-disabled, not the native attribute — full opacity,
  // not the near-invisible 45%-dimmed disabled track; the «скоро» tag alone says it is not available yet.
  expect(isDisabled(review)).toBe(false);
  expect(review.getAttribute("aria-disabled")).toBe("true");
  expect(review.getAttribute("aria-checked")).toBe("false");
  expect(screen.getAllByText("скоро").length).toBeGreaterThanOrEqual(3);
});

test("the «Сцены на проверку» switch cannot be toggled by click or keyboard (LOW-6, P3)", async () => {
  await openPhotos();
  await priced();
  const review = screen.getByRole("switch", { name: "Сцены на проверку" });

  fireEvent.click(review);
  expect(review.getAttribute("aria-checked")).toBe("false");

  fireEvent.keyDown(review, { key: " " });
  fireEvent.keyUp(review, { key: " " });
  expect(review.getAttribute("aria-checked")).toBe("false");

  fireEvent.keyDown(review, { key: "Enter" });
  expect(review.getAttribute("aria-checked")).toBe("false");
});

// ---------- navigation ----------

test("avatar A's delayed runs.estimate and photos.list answering after a switch to B must not render on B (M4, LOW-2)", async () => {
  // Mia and Sofia must actually differ (LOW-2): with the same default form
  // and an empty gallery for both, a leaked reply would be indistinguishable
  // from the real one and this test could never fail. Mia gets two real
  // photos of her own; Sofia gets none.
  const { engine, scheduler } = setup({ avatars: [MIA, SOFIA], photos: [photo(1, { qa: { faceCos: 0.86 } }), photo(2, { category: "travel" })] });
  engine.delayNext("runs.estimate", 500);
  engine.delayNext("photos.list", 500);
  fireEvent.click(await screen.findByRole("button", { name: "Mia" }));
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  // Mia's own price and gallery are still in flight (delayed) when this
  // window switches to Sofia: the Photos screen (keyed on avatarId) unmounts
  // Mia's entirely, so her stale replies must land on nothing.

  await openSection("Аватары");
  fireEvent.click(await screen.findByRole("button", { name: "Sofia" }));
  await screen.findByRole("heading", { level: 1, name: "Sofia" });
  await priced(); // Sofia's own price, asked for fresh and not delayed
  await screen.findByText("Фото пока нет"); // Sofia's own, real gallery: empty — nothing was ever seeded for her

  tick(scheduler, 2); // Mia's stale runs.estimate and photos.list (with her 2 photos) land now
  await flush();

  expect(await screen.findByRole("heading", { level: 1, name: "Sofia" })).toBeDefined();
  // Still Sofia's own state: Mia's two photos did not leak onto her gallery.
  expect(screen.getByText("Фото пока нет")).toBeDefined();
  expect(screen.queryByText("лицо 0.86")).toBeNull();
  expect(document.querySelectorAll(".photo-tile:not(.photo-tile-drawing):not(.photo-tile-queued)")).toHaveLength(0);
  expect(callsOf(engine, "photos.list").map((c) => c.payload.avatarId)).toContain(SOFIA.avatarId);
});

test("an avatar's name on the grid opens its photos; the sidebar's «Фото» comes back to it", async () => {
  const { engine } = setup({ avatars: [MIA, SOFIA] });
  fireEvent.click(await screen.findByRole("button", { name: "Sofia" }));
  await screen.findByRole("heading", { level: 1, name: "Sofia" });
  await waitFor(() => expect(callsOf(engine, "photos.list").map((c) => c.payload.avatarId)).toEqual([SOFIA.avatarId]));
  expect(screen.getByRole("button", { name: "Фото" }).getAttribute("aria-current")).toBe("page");

  await openSection("Аватары");
  await openSection("Фото");
  expect(await screen.findByRole("heading", { level: 1, name: "Sofia" })).toBeDefined();
  await priced();
});

test("the sidebar's «Фото» opens the first active avatar when none was shown yet", async () => {
  setup({ avatars: [avatar("Nora", 3, "archived"), MIA] });
  await openSection("Фото");
  expect(await screen.findByRole("heading", { level: 1, name: "Mia" })).toBeDefined();
  await priced();
});

test("the sidebar's «Фото» with no avatar named pins its resolved avatar: another window archiving it does not silently switch the screen (L11)", async () => {
  const { client } = setup({ avatars: [MIA, SOFIA] });
  await openSection("Фото");
  expect(await screen.findByRole("heading", { level: 1, name: "Mia" })).toBeDefined();
  await priced();

  // Another window archives the avatar this one resolved to and pinned.
  await act(async () => {
    await client.request("avatars.archive", { avatarId: MIA.avatarId });
  });

  // Still Mia — archived now, not silently switched to Sofia (the new "first active").
  expect(await screen.findByRole("heading", { level: 1, name: "Mia" })).toBeDefined();
  expect(screen.getByText("Аватар в архиве — новые фото для него не создаются.")).toBeDefined();
  expect(screen.queryByRole("heading", { level: 1, name: "Sofia" })).toBeNull();
});

test("if the pinned avatar disappears (a library switch), the fallback is re-pinned too, not left exposed to the same switch bug (LOW-9)", async () => {
  const { engine, client } = setup({ avatars: [MIA] });
  await openSection("Фото");
  expect(await screen.findByRole("heading", { level: 1, name: "Mia" })).toBeDefined();
  await priced();

  // A library switch: the new folder has Sofia and Elena, not Mia at all.
  const ELENA = avatar("Elena", 3);
  engine.setAvatarsForNextSnapshot([SOFIA, ELENA]);
  await act(async () => {
    await client.request("settings.setLibraryPath", { path: "/Users/studio/Other/library" });
  });
  await flush();
  expect(await screen.findByRole("heading", { level: 1, name: "Sofia" })).toBeDefined();

  // Another window archives Sofia: without re-pinning the fallback, this
  // would silently switch to Elena — the exact bug L11 fixes for the first pin.
  await act(async () => {
    await client.request("avatars.archive", { avatarId: SOFIA.avatarId });
  });
  expect(await screen.findByRole("heading", { level: 1, name: "Sofia" })).toBeDefined();
  expect(screen.getByText("Аватар в архиве — новые фото для него не создаются.")).toBeDefined();
  expect(screen.queryByRole("heading", { level: 1, name: "Elena" })).toBeNull();
});

test("with no saved avatar the Photos screen points back to the Avatars screen", async () => {
  setup();
  await openSection("Фото");
  expect(await screen.findByText("Сначала нужен аватар")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "К аватарам" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Аватары" })).toBeDefined();
});
