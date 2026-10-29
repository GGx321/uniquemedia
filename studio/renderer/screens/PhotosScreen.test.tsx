import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ERROR_MESSAGES_RU, type AvatarSummary, type PhotoSummary, type RunRequest } from "../../shared/engine";
import { mockDescriptor, type MockEngine } from "../engine/mockEngine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { callsOf, flush, openSection, runAll, setup as setupWith, tick, withText } from "../testing";

// CS.6: «Сцены на проверку» is on by default; this file pins today's path (the run writes its own scenes), so it turns review off. The review path's own
// tests are PhotosSceneReview*.test.tsx.
const setup = (options: Parameters<typeof setupWith>[0] = {}) => setupWith({ sceneReview: "off", ...options });

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
    videoCount: 0,
    eligibleUnusedCount: 0,
    usage: { state: "ok" },
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
    createdAt: `2026-09-2${n}T10:00:00.000Z`,
    used: false,
    usedIn: [],
    rejected: false,
    reserved: false,
    eligible: true,
    ...patch,
  };
}

/** N4: `n` real, distinctly-counted photos for `avatarId` (unlike `photo()`, safe past single-digit counts). The first carries a similarity badge when `withFace`. */
function manyPhotos(n: number, avatarId: string, idPrefix: string, withFace: boolean): PhotoSummary[] {
  return Array.from({ length: n }, (_, i) => ({
    photoId: `photo-${idPrefix}-${String(i + 1).padStart(4, "0")}`,
    avatarId,
    runId: `run-${idPrefix}-0001`,
    category: "home" as const,
    createdAt: new Date(Date.UTC(2026, 8, 24, 10, 0, i)).toISOString(),
    used: false,
    usedIn: [],
    rejected: false,
    reserved: false,
    eligible: true,
    ...(withFace && i === 0 ? { qa: { faceCos: 0.86 } } : {}),
  }));
}

/** The default request the screen opens with: 20 photos, every category; S5.7c: no poses (the angle comes from the scene), «Подача» «Обычная» not sent. */
const DEFAULT_REQUEST: RunRequest = {
  avatarId: MIA.avatarId,
  count: 20,
  categories: ["home", "travel", "shoot", "glam", "fit"],
};

/** Opens the Photos screen from the sidebar and waits for its first price: 20 photos is ≈ $1.00, до $3.00 in the mock. */
async function openPhotos(options: Parameters<typeof setup>[0] = {}) {
  const harness = setup({ avatars: [MIA], ...options });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  await openSection("Фото");
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  return harness;
}

/** The gallery's photo tiles (not the slots of a run still drawing). */
function galleryTiles(): Element[] {
  return Array.from(document.querySelectorAll(".photos-gallery .photo-tile:not(.photo-tile-drawing):not(.photo-tile-queued):not(.photo-tile-skipped)"));
}

async function priced(): Promise<HTMLElement> {
  return await screen.findByRole("button", { name: /до \$\d/ });
}

function goButton(): HTMLElement {
  const button = document.querySelector<HTMLElement>(".photos-go");
  if (!button) throw new Error("no generate button");
  return button;
}

/** The generation card: its hint is pinned here, since a resume row can briefly say the same words until runs.list refreshes. */
function generateCard(): HTMLElement {
  return screen.getByRole("region", { name: "Генерация фото" });
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
  expect((await priced()).textContent).toBe("Сгенерировать 20 фото · до $3.00");
  expect(expectedText()).toBe("Ожидаемая≈ $1.00");
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
  // 25 × 3 attempts × $0.05 = $3.75, no writer (the template writes a built-in whole); ≈ 25 × $0.05 = $1.25.
  await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 25 фото · до $3.75"));
  expect(expectedText()).toBe("Ожидаемая≈ $1.25");

  // 25 over four categories: the remainder goes to the earliest (the planner's own rule).
  fireEvent.click(screen.getByRole("button", { name: "Фитнес: 5 фото" }));
  expect(screen.getByRole("button", { name: "Дом: 7 фото" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Виды: 6 фото" })).toBeDefined();
  expect(screen.getByRole("button", { name: "Фитнес" }).getAttribute("aria-pressed")).toBe("false");

  expect(callsOf(engine, "runs.estimate").at(-1)?.payload).toEqual({ ...DEFAULT_REQUEST, count: 25, categories: ["home", "travel", "shoot", "glam"] });
});

// Owner decision 2026-09-29: 2K is removed end to end; a photo is always 1K.
test("the worst case rounds up on the button, and the raw micros are what is sent", async () => {
  const harness = setup({ avatars: [MIA] });
  // 60 attempts × $0.0501 = $3.006000: never shown as $3.00, which would understate the limit.
  harness.engine.setRunImagePrice(50_100);
  await openSection("Фото");
  const button = await priced();
  expect(button.textContent).toBe("Сгенерировать 20 фото · до $3.01");
  expect(expectedText()).toBe("Ожидаемая≈ $1.00");

  fireEvent.click(button);
  await screen.findByText(/Рисуем фото/);
  expect(callsOf(harness.engine, "runs.start").map((c) => c.payload.acceptedWorstMicros)).toEqual([3_006_000]);
});

test("an estimate answer for a request that is gone by then is dropped", async () => {
  const { engine, scheduler } = await openPhotos();
  await priced();
  engine.delayNext("runs.estimate", 50);
  const more = screen.getByRole("button", { name: "Больше" });
  fireEvent.click(more); // 25 photos: its price is held back
  fireEvent.click(more); // 30 photos: answered at once
  // 90 attempts × $0.05.
  await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 30 фото · до $4.50"));

  tick(scheduler, 1); // the 25-photo price arrives late
  await flush();
  expect(goButton().textContent).toBe("Сгенерировать 30 фото · до $4.50");
});

test("a settings change that moves the price (the age check) prices the run again", async () => {
  const { client } = await openPhotos();
  await priced();
  expect(screen.getByText("выкл.")).toBeDefined();

  // As another window (or Settings) would: the engine's settings.changed reaches this window's store.
  await act(async () => {
    await client.request("settings.setImageAgeCheck", { imageAgeCheck: "on" });
  });
  // Every attempt gains an age check: 60 × $0.00525 more (the engine's price of the call).
  await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 20 фото · до $3.32"));
  expect(screen.getByText("вкл.")).toBeDefined();
});

test("the stepper stays within 5–100 photos", async () => {
  await openPhotos();
  await priced();
  const fewer = screen.getByRole("button", { name: "Меньше" });
  for (let i = 0; i < 5; i++) fireEvent.click(fewer);
  expect(screen.getByText("5")).toBeDefined();
  expect(isDisabled(fewer)).toBe(true);
  // 15 attempts × $0.05.
  await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 5 фото · до $0.75"));
});

test("with no category chosen there is nothing to price and nothing to start", async () => {
  const { engine } = await openPhotos();
  await priced();
  for (const name of [/^Дом/, /^Виды/, /^Улица/, /^Гламур/, /^Фитнес/]) fireEvent.click(screen.getByRole("button", { name }));
  await flush();

  expect(isDisabled(goButton())).toBe(true);
  expect(goButton().textContent).toBe("Сгенерировать 20 фото");
  expect(screen.getByText("Выберите хотя бы одну категорию.")).toBeDefined();
  // Priced at every step down to one category, never with none (the contract requires at least one).
  expect(callsOf(engine, "runs.estimate").map((c) => c.payload.categories.length)).toEqual([5, 4, 3, 2, 1]);
  expect(screen.queryByText(/Гламур — вечер выхода/) === null).toBe(true);
});

// ---------- start ----------

test("start sends exactly the request and the worst case the button showed", async () => {
  const { engine } = await openPhotos();
  fireEvent.click(await priced());

  await screen.findByText("Рисуем фото: 0 из 20");
  expect(callsOf(engine, "runs.start").map((c) => c.payload)).toEqual([{ ...DEFAULT_REQUEST, acceptedWorstMicros: 3_000_000 }]);
  // The engine refuses a second run of this avatar while one runs: the button waits and says why.
  expect(isDisabled(goButton())).toBe(true);
  expect(within(generateCard()).getByText("Дождитесь конца текущего запуска.")).toBeDefined();
  // The sidebar queue knows the run's size from the start, before its first progress event.
  expect(within(screen.getByRole("region", { name: "Очередь" })).getByText("0 / 20")).toBeDefined();
});

// S5.7c (plan s5a2 §6.1): «Ракурсы» gave way to «Подача» (PhotosLevel.test.tsx has its states): the request maps «Кокетливая» to `level`, never sends poses.
test("«Подача» maps to RunRequest.level; the request carries no poses", async () => {
  const { engine } = await openPhotos();
  await priced();
  expect(screen.queryByRole("button", { name: "Анфас" }) === null).toBe(true);
  expect(screen.queryByRole("button", { name: "Профиль" }) === null).toBe(true);

  fireEvent.click(screen.getByRole("radio", { name: "Кокетливая" }));
  await waitFor(() => expect(callsOf(engine, "runs.estimate").at(-1)?.payload).toEqual({ ...DEFAULT_REQUEST, level: "flirty" }));
  await waitFor(() => expect(isDisabled(goButton())).toBe(false));

  fireEvent.click(goButton());
  await screen.findByText(/Рисуем фото/);
  expect(callsOf(engine, "runs.start")[0]?.payload).toEqual({ ...DEFAULT_REQUEST, level: "flirty", acceptedWorstMicros: 3_000_000 });
});

test("the button and the form are locked while runs.start is in flight, and a second click sends nothing", async () => {
  const { engine, scheduler } = await openPhotos();
  const button = await priced();
  engine.delayNext("runs.start", 50);

  fireEvent.click(button);
  fireEvent.click(button);
  expect(button.textContent).toBe("Отправляем… · до $3.00");
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
  engine.setRunImagePrice(60_000);
  engine.delayNext("runs.estimate", 50);

  fireEvent.click(button);
  await waitFor(() => expect(callsOf(engine, "runs.estimate")).toHaveLength(2));
  // The re-price is on its way: the refused price is still on a disabled, busy button.
  expect(isDisabled(goButton())).toBe(true);
  expect(goButton().getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByText("Цена выросла") === null).toBe(true);

  tick(scheduler, 1);
  await screen.findByText("Цена выросла");
  // 60 attempts × $0.06.
  expect(screen.getByText(withText(/Было не больше \$3\.00, теперь не больше \$3\.60/))).toBeDefined();
  expect(goButton().textContent).toBe("Подтвердить новую цену · до $3.60");
  expect(callsOf(engine, "runs.start")).toHaveLength(1);

  fireEvent.click(goButton());
  await screen.findByText(/Рисуем фото/);
  expect(callsOf(engine, "runs.start").map((c) => c.payload.acceptedWorstMicros)).toEqual([3_000_000, 3_600_000]);
  expect(screen.queryByText("Цена выросла") === null).toBe(true);
});

test("a failed re-price after PRICE_CHANGED drops the refused price: the button can only ask again", async () => {
  const { engine } = await openPhotos();
  const button = await priced();
  engine.setRunImagePrice(60_000);
  engine.failNext("runs.estimate", { code: "NETWORK" });

  fireEvent.click(button);
  await screen.findByText(ERROR_MESSAGES_RU.NETWORK);
  expect(goButton().textContent).toBe("Повторить оценку");
  expect(goButton().textContent).not.toContain("$3.00");
  expect(expectedText()).toBe("Ожидаемая—");
  expect(callsOf(engine, "runs.start")).toHaveLength(1);

  fireEvent.click(goButton());
  await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 20 фото · до $3.60"));
  expect(callsOf(engine, "runs.start")).toHaveLength(1);
});

test("PRICE_CHANGED for a stale key must not clobber a fresher price the key's own re-estimate already landed", async () => {
  // K1: age check off, до $3.00. Clicking accepts K1's price; while runs.start
  // is in flight, another window turns the age check on — a genuinely new key
  // (K2) whose own estimate effect fires and lands ($3.32) before runs.start
  // answers PRICE_CHANGED for the (now stale) K1 request it was sent with.
  const { engine, scheduler, client } = await openPhotos();
  const button = await priced();
  expect(button.textContent).toBe("Сгенерировать 20 фото · до $3.00");

  engine.delayNext("runs.start", 50);
  fireEvent.click(button);

  await act(async () => {
    await client.request("settings.setImageAgeCheck", { imageAgeCheck: "on" });
  });
  // K2's own estimate, asked for by the key change alone, lands in the
  // background — but while sending, the button shows K1's own accepted worst
  // (LOW-4), the price actually in flight, not K2's fresher one.
  await flush();
  expect(goButton().textContent).toBe("Отправляем… · до $3.00");

  tick(scheduler, 1); // runs.start (sent for K1) is handled now: PRICE_CHANGED
  await flush();

  // K2's price must still be the one shown — not clobbered by the stale
  // re-price the PRICE_CHANGED path asks for K1 — and the button must be
  // clickable, not stuck disabled with nothing to accept.
  expect(goButton().textContent).toBe("Сгенерировать 20 фото · до $3.32");
  expect(isDisabled(goButton())).toBe(false);
  expect(screen.queryByText("Цена выросла") === null).toBe(true);

  fireEvent.click(goButton());
  await screen.findByText(/Рисуем фото/);
  expect(callsOf(engine, "runs.start").map((c) => c.payload)).toEqual([
    { ...DEFAULT_REQUEST, acceptedWorstMicros: 3_000_000 },
    { ...DEFAULT_REQUEST, acceptedWorstMicros: 3_315_000 },
  ]);
});

test("a refusal other than PRICE_CHANGED is shown and the price stays for another try", async () => {
  const { engine } = await openPhotos({ money: { monthlyBudgetMicros: 1_000_000 } });
  fireEvent.click(await priced());
  await screen.findByText(ERROR_MESSAGES_RU.BUDGET_EXCEEDED);
  expect(goButton().textContent).toBe("Сгенерировать 20 фото · до $3.00");
  expect(isDisabled(goButton())).toBe(false);
  expect(callsOf(engine, "runs.start")).toHaveLength(1);
});

// The refusals a start can meet that no mock run ever produced: each shows its own Russian text, the price stays for another try,
// and nothing was created or sent (no run, no progress).
describe.each([
  { name: "FACE_GATE_UNAVAILABLE", text: ERROR_MESSAGES_RU.FACE_GATE_UNAVAILABLE, options: {}, arm: (e: MockEngine) => e.setFaceGateAvailable(false) },
  { name: "AGE_GATE_UNAVAILABLE", text: ERROR_MESSAGES_RU.AGE_GATE_UNAVAILABLE, options: { imageAgeCheck: "on" as const }, arm: (e: MockEngine) => e.setAgeGateAvailable(false) },
  { name: "LIBRARY_UNAVAILABLE", text: ERROR_MESSAGES_RU.LIBRARY_UNAVAILABLE, options: {}, arm: (e: MockEngine) => e.setLibraryAvailable(false) },
  { name: "a missing master (NOT_FOUND)", text: ERROR_MESSAGES_RU.NOT_FOUND, options: {}, arm: (e: MockEngine) => e.removeMaster(MIA.avatarId) },
  { name: "MASTER_FACE_UNUSABLE", text: ERROR_MESSAGES_RU.MASTER_FACE_UNUSABLE, options: {}, arm: (e: MockEngine) => e.setMasterPreflightFailure(MIA.avatarId, { code: "MASTER_FACE_UNUSABLE" }) },
  { name: "INTERNAL (the gates could not be prepared)", text: ERROR_MESSAGES_RU.INTERNAL, options: {}, arm: (e: MockEngine) => e.setMasterPreflightFailure(MIA.avatarId, { code: "INTERNAL" }) },
])("a start refused with $name", ({ text, options, arm }) => {
  test("shows the Russian text, keeps the price, and starts nothing", async () => {
    const { engine, client } = await openPhotos(options);
    const button = await priced();
    arm(engine);
    fireEvent.click(button);

    await screen.findByText(text);
    expect(callsOf(engine, "runs.start")).toHaveLength(1);
    expect(isDisabled(goButton())).toBe(false);
    expect(goButton().textContent).toMatch(/до \$\d/);
    expect(screen.queryByText(/Рисуем фото/) === null).toBe(true);
    const listed = await client.request("runs.list", {});
    expect(listed.ok ? listed.result.runs : "runs.list failed").toEqual([]);
  });
});

describe.each([
  { name: "FACE_GATE_UNAVAILABLE", text: ERROR_MESSAGES_RU.FACE_GATE_UNAVAILABLE, arm: (e: MockEngine) => e.setFaceGateAvailable(false) },
  { name: "LIBRARY_UNAVAILABLE", text: ERROR_MESSAGES_RU.LIBRARY_UNAVAILABLE, arm: (e: MockEngine) => e.setLibraryAvailable(false) },
])("a resume refused with $name", ({ text, arm }) => {
  test("shows the Russian text in its row and starts no job", async () => {
    const { engine } = setup({ avatars: [MIA] });
    engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home"] }, 8);
    await openSection("Фото");
    const resume = await screen.findByRole("button", { name: /Продолжить/ });
    arm(engine);
    fireEvent.click(resume);

    await screen.findByText(text);
    expect(callsOf(engine, "runs.resume")).toHaveLength(1);
    expect(screen.queryByText(/Рисуем фото/) === null).toBe(true);
  });
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
  expect(screen.queryByText("Рисуется") === null).toBe(true);
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
  const r1 = await act(async () => client.request("runs.start", { ...DEFAULT_REQUEST, acceptedWorstMicros: 3_000_000 }));
  if (!r1.ok) throw new Error(`r1 ${r1.error.code}`);
  tick(scheduler, 1); // an intermediate render while running, so this screen actually watches it (and can then notice it end)
  await screen.findByText("Рисуем фото: 1 из 20");
  runAll(scheduler);
  await flush();
  await screen.findByText("Запуск завершён");

  const r2 = await act(async () => client.request("runs.start", { ...DEFAULT_REQUEST, acceptedWorstMicros: 3_000_000 }));
  if (!r2.ok) throw new Error(`r2 ${r2.error.code}`);
  tick(scheduler, 1);
  await flush();

  // The second run must show as running, not the first (already finished) one.
  await screen.findByText("Рисуем фото: 1 из 20");
  expect(isDisabled(goButton())).toBe(true);
  expect(within(generateCard()).getByText("Дождитесь конца текущего запуска.")).toBeDefined();
  expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(false);
});

/** R1, started through the engine directly, finishes and is watched; R2, started the same way, is running. Both known only through their own events (N1). */
async function twoRunsSecondRunning() {
  const harness = await openPhotos();
  await priced();
  const r1 = await act(async () => harness.client.request("runs.start", { ...DEFAULT_REQUEST, acceptedWorstMicros: 3_000_000 }));
  if (!r1.ok) throw new Error(`r1 ${r1.error.code}`);
  tick(harness.scheduler, 1);
  await screen.findByText("Рисуем фото: 1 из 20");
  runAll(harness.scheduler);
  await flush();
  await screen.findByText("Запуск завершён");

  const r2 = await act(async () => harness.client.request("runs.start", { ...DEFAULT_REQUEST, acceptedWorstMicros: 3_000_000 }));
  if (!r2.ok) throw new Error(`r2 ${r2.error.code}`);
  tick(harness.scheduler, 1);
  await screen.findByText("Рисуем фото: 1 из 20");
  return harness;
}

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
  expect(screen.queryByText("Генерация остановлена") === null).toBe(true);

  runAll(scheduler);
  await screen.findByText("Генерация остановлена");
  await screen.findByText(/Готово 1 из 20 · осталось 19/);
  // The 19 open slots' reserves stay open, like the real engine's own
  // open-reserves rule (and the mock's avatar.candidates cancel) — but only
  // 6 of them (the network's own default concurrency) were ever actually in
  // flight (MEDIUM-2): no paid start or resume until a reconcile, and the
  // price meanwhile is capped by what the cap has left on top of that (до
  // $2.05), not the open slots' own raw worst case (до $2.85).
  expect(screen.getAllByText("Платные запросы остановлены до сверки расходов.").length).toBeGreaterThan(0);
  expect(isDisabled(goButton())).toBe(true);
  // The row still shows its price — runs.estimateResume is free — but cannot be clicked while blocked.
  const resume = await screen.findByRole("button", { name: "Продолжить · до $2.05" });
  expect(isDisabled(resume)).toBe(true);

  await act(async () => {
    await client.request("money.reconcile", {});
  });
  await waitFor(() => expect(screen.queryByText("Платные запросы остановлены до сверки расходов.") === null).toBe(true));
  expect(isDisabled(goButton())).toBe(false);
  // Reconciling releases the 13 slots that were never actually sent: the row
  // re-asks its price on its own (MEDIUM-1) and shows the higher, uncapped one.
  const resumeAfter = await screen.findByRole("button", { name: "Продолжить · до $2.85" });
  expect(isDisabled(resumeAfter)).toBe(false);

  fireEvent.click(resumeAfter);
  await screen.findByText("Рисуем фото: 1 из 20");
  expect(callsOf(engine, "runs.resume").map((c) => c.payload.runId)).toEqual([started]);
  // L4: exactly the button's own re-asked price (до $2.85) — the higher,
  // uncapped one from MEDIUM-1's own re-ask, not the stale до $2.05.
  expect(callsOf(engine, "runs.resume").at(-1)?.payload.acceptedWorstMicros).toBe(2_850_000);
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

// The launch announcement (done 0) is all another window ever hears before the first photo: enough to see the run and cancel it.
// The backlog's gap: a run that failed before its first job.progress was invisible in every window but the one that started it.
test("a stopped run is resumed with exactly the worst case runs.estimateResume showed", async () => {
  const harness = setup({ avatars: [MIA] });
  const runId = harness.engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home", "travel"] }, 8);
  await openSection("Фото");

  const resume = await screen.findByRole("button", { name: "Продолжить · до $0.60" });
  expect(screen.getByText(/Готово 8 из 12 · осталось 4/)).toBeDefined();
  expect(callsOf(harness.engine, "runs.estimateResume").map((c) => c.payload)).toEqual([{ runId }]);
  expect(callsOf(harness.engine, "runs.resume")).toHaveLength(0);

  fireEvent.click(resume);
  await screen.findByText("Рисуем фото: 8 из 12");
  expect(callsOf(harness.engine, "runs.resume").map((c) => c.payload)).toEqual([{ runId, acceptedWorstMicros: 600_000 }]);
  // The resumed run is running now: no second resume offered for it.
  await waitFor(() => expect(screen.queryByRole("button", { name: /Продолжить/ }) === null).toBe(true));
});

test("a resume refused with PRICE_CHANGED shows the new price and asks again", async () => {
  const harness = setup({ avatars: [MIA] });
  const runId = harness.engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home"] }, 8);
  await openSection("Фото");
  const resume = await screen.findByRole("button", { name: "Продолжить · до $0.60" });
  harness.engine.setRunImagePrice(60_000);

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

test("a resume stays busy through its PRICE_CHANGED re-price, and a double click sends one resume", async () => {
  const harness = setup({ avatars: [MIA] });
  harness.engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home"] }, 8);
  await openSection("Фото");
  const resume = await screen.findByRole("button", { name: "Продолжить · до $0.60" });
  harness.engine.setRunImagePrice(60_000);
  harness.engine.delayNext("runs.estimateResume", 50);

  fireEvent.click(resume);
  fireEvent.click(resume);
  await waitFor(() => expect(callsOf(harness.engine, "runs.estimateResume")).toHaveLength(2));
  // Refused, and the new price is on its way: the old one is still on a disabled, busy button.
  expect(callsOf(harness.engine, "runs.resume")).toHaveLength(1);
  expect(resume.hasAttribute("disabled")).toBe(true);
  expect(resume.getAttribute("aria-busy")).toBe("true");
  expect(screen.queryByText("Цена выросла") === null).toBe(true);

  tick(harness.scheduler, 1);
  const confirm = await screen.findByRole("button", { name: "Подтвердить новую цену · до $0.72" });
  fireEvent.click(confirm);
  fireEvent.click(confirm);
  await screen.findByText("Рисуем фото: 8 из 12");
  expect(callsOf(harness.engine, "runs.resume").map((c) => c.payload.acceptedWorstMicros)).toEqual([600_000, 720_000]);
});

test("a resume in flight locks the generate card too, until it answers (L5)", async () => {
  const harness = setup({ avatars: [MIA] });
  harness.engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home"] }, 8);
  await openSection("Фото");
  const resume = await screen.findByRole("button", { name: "Продолжить · до $0.60" });
  await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 20 фото · до $3.00"));

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
  expect(within(generateCard()).getByText("Дождитесь конца текущего запуска.")).toBeDefined();
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

test("an older estimateResume answer landing after a newer one must not win the button back (N2)", async () => {
  const { engine, scheduler } = setup({ avatars: [MIA] });
  engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home"] }, 8);
  engine.delayNext("runs.estimateResume", 300); // the mount-time ask: issued first, resolves LAST
  await openSection("Фото");
  await screen.findByRole("heading", { level: 1, name: "Mia" });

  // Before the mount-time ask lands, a reconcile flip (MEDIUM-1) fires a second, faster one.
  engine.delayNext("runs.estimateResume", 50); // the reconcile-triggered ask: issued second, resolves FIRST
  act(() => engine.requireReconcile(["open-reserves"]));

  tick(scheduler, 1); // the faster, newer ask lands first — succeeds normally
  await flush();
  await screen.findByRole("button", { name: "Продолжить · до $0.60" });

  // Only now, after the newer ask already succeeded, make the still-pending older one fail once it finally lands.
  engine.failNext("runs.estimateResume", { code: "NETWORK" });
  tick(scheduler, 1); // the slower, older (now stale) mount-time ask lands now
  await flush();

  // Must still show the newer, already-accepted price — a sequence guard drops the stale failure.
  expect(document.querySelector(".photos-run-go")?.textContent).toContain("до $0.60");
  expect(screen.queryByText(ERROR_MESSAGES_RU.NETWORK) === null).toBe(true);
});

test("a run whose cap is used up is shown as ended: a plain summary with no button, nothing priced and nothing to resume (L6)", async () => {
  const harness = setup({ avatars: [MIA] });
  // 8 done slots at $0.05 each settled $0.40; the cap is seeded at exactly that, leaving nothing for the 4 open slots.
  harness.engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home"] }, 8, 400_000);
  await openSection("Фото");

  await screen.findByText("Лимит исчерпан");
  expect(screen.getByText(/Готово 8 из 12 · не дорисовано 4/)).toBeDefined();
  expect(screen.queryByRole("button", { name: /Продолжить/ }) === null).toBe(true);
  expect(screen.queryByText("до $0.00") === null).toBe(true);
  expect(screen.queryByText("Остановлен") === null).toBe(true);
  expect(document.querySelector(".photos-run-go") === null).toBe(true);
  // Not resumable, so no price is even asked for it, and nothing can be sent.
  expect(callsOf(harness.engine, "runs.estimateResume")).toHaveLength(0);
  expect(callsOf(harness.engine, "runs.resume")).toHaveLength(0);
});

test("a run whose cap still leaves one attempt stays a resume row: «Остановлен» with its price", async () => {
  const harness = setup({ avatars: [MIA] });
  harness.engine.seedRun({ ...DEFAULT_REQUEST, count: 12, categories: ["home"] }, 8, 400_000 + 50_000);
  await openSection("Фото");

  await screen.findByRole("button", { name: /Продолжить/ });
  expect(screen.getByText("Остановлен")).toBeDefined();
  expect(screen.queryByText("Лимит исчерпан") === null).toBe(true);
});

// ---------- the gallery ----------

test("photos picked for a montage are marked and counted; nothing picked, nothing to make", async () => {
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

test("a failed photos.list is shown with a retry", async () => {
  const harness = setup({ avatars: [MIA], photos: [photo(1)] });
  harness.engine.failNext("photos.list", { code: "INTERNAL" });
  await openSection("Фото");
  await screen.findByText(ERROR_MESSAGES_RU.INTERNAL);
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  expect(await screen.findByText("лицо не проверялось")).toBeDefined();
});

// ---------- later stages, marked ----------

// ---------- navigation ----------

test("with no saved avatar the Photos screen points back to the Avatars screen", async () => {
  setup();
  await openSection("Фото");
  expect(await screen.findByText("Сначала нужен аватар")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "К аватарам" }));
  expect(await screen.findByRole("heading", { level: 1, name: "Аватары" })).toBeDefined();
});
