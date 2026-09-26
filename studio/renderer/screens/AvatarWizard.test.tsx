import { expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ERROR_MESSAGES_RU, type Draft } from "../../shared/engine";
import { MOCK_ESTIMATE, mockDescriptor } from "../engine/mockEngine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { callsOf, estimateText, flush, openWizard, runAll, setup, tick, inAct, describeElement, focusedLabel } from "../testing";

function continuedDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    avatarId: "avatar-continue-0001",
    traits: DEFAULT_TRAITS,
    descriptor: mockDescriptor(DEFAULT_TRAITS),
    candidates: [],
    estimate: null,
    ...overrides,
  };
}

/** Opens the wizard on an existing draft from the Avatars grid, as "Продолжить" does. */
async function continueDraft(): Promise<void> {
  const card = await screen.findByRole("article", { name: "Черновик" });
  fireEvent.click(within(card).getByRole("button", { name: "Продолжить" }));
  await screen.findByRole("heading", { level: 1, name: "Новый аватар" });
}

async function estimate(): Promise<void> {
  fireEvent.click(screen.getByRole("button", { name: "Оценить стоимость" }));
  await waitFor(() => expect(estimateText()).not.toBeNull());
}

function generateButton(): HTMLElement {
  return screen.getByRole("button", { name: /Сгенерировать 4 варианта/ });
}

function isChecked(el: HTMLElement): boolean {
  return el instanceof HTMLInputElement && el.checked;
}

/** The vibe's live error region (always present, filled only when the vibe is refused). */
function vibeErrors(): string {
  const region = document.querySelector(".vibe-errors");
  if (!region) throw new Error("vibe error region missing");
  expect(region.getAttribute("aria-live")).toBe("polite");
  return region.textContent ?? "";
}

function vibeInput(): HTMLElement {
  return screen.getByRole("textbox", { name: "Вайб" });
}

test("the estimate is shown before anything is spent", async () => {
  const { engine } = setup();
  await openWizard();
  expect(screen.queryByRole("button", { name: /Сгенерировать/ })).toBeNull();

  await estimate();
  expect(estimateText()).toBe("≈ $0.21, не больше $0.23");
  expect(generateButton().textContent).toBe("Сгенерировать 4 варианта · до $0.23");
  expect(callsOf(engine, "avatars.estimate")).toHaveLength(1);
  expect(callsOf(engine, "avatars.createDraft")).toHaveLength(0);
  expect(callsOf(engine, "avatars.generateCandidates")).toHaveLength(0);
});

test("generate sends the whole new-avatar worst to createDraft, then the draft's own batch worst to generateCandidates", async () => {
  const { engine } = setup();
  await openWizard();
  await estimate();
  fireEvent.click(generateButton());
  await screen.findByText(/Рисуем портреты/);

  const [draft] = callsOf(engine, "avatars.createDraft");
  const [generate] = callsOf(engine, "avatars.generateCandidates");
  expect(draft?.payload.acceptedWorstMicros).toBe(223_000); // the whole new-avatar worst, as before
  expect(draft?.payload.traits.age).toBe(25);
  // Not 223_000 again: the engine checks generateCandidates against the
  // batch job alone (studio/engine/engine.ts ~:890), no descriptor in it, so
  // sending the whole avatar's worst here let the two commands' spend add up
  // past what the user actually accepted (whole-slice review, M1).
  expect(generate?.payload.acceptedWorstMicros).toBe(220_000);
});

test("a price that arrives after the traits changed is dropped, never shown for the new traits", async () => {
  const { engine } = setup();
  await openWizard();
  fireEvent.click(screen.getByRole("button", { name: "Оценить стоимость" }));
  // The answer is still on its way when the user picks another look.
  fireEvent.click(screen.getByRole("radio", { name: "Азиатский" }));
  await flush();
  expect(callsOf(engine, "avatars.estimate")).toHaveLength(1);
  expect(estimateText()).toBeNull();
  expect(screen.queryByRole("button", { name: /Сгенерировать/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Оценить стоимость" }).hasAttribute("disabled")).toBe(false);
});

test("the form is locked while the paid commands are being sent", async () => {
  setup();
  await openWizard();
  await estimate();
  fireEvent.click(generateButton());
  // A disabled fieldset disables every control inside it.
  expect(screen.getByRole("radio", { name: "Азиатский" }).closest("fieldset.traits")?.hasAttribute("disabled")).toBe(true);
  await screen.findByText(/Рисуем портреты/);
});

test("changing the traits drops the estimate, so a stale price can never be accepted", async () => {
  setup();
  await openWizard();
  await estimate();
  fireEvent.click(screen.getByRole("radio", { name: "Азиатский" }));
  expect(estimateText()).toBeNull();
  expect(screen.queryByRole("button", { name: /Сгенерировать/ })).toBeNull();
  expect(screen.getByRole("button", { name: "Оценить стоимость" })).toBeDefined();
});

test("PRICE_CHANGED shows the new estimate and asks again before spending", async () => {
  const { engine } = setup();
  await openWizard();
  await estimate();
  engine.setPrice({ expectedMicros: 215_000, worstMicros: 250_000 });
  fireEvent.click(generateButton());

  await screen.findByText("Цена выросла");
  expect(estimateText()).toBe("≈ $0.22, не больше $0.25");
  expect(screen.getByText(/Было не больше \$0\.23, теперь не больше \$0\.25/)).toBeDefined();
  expect(callsOf(engine, "avatars.createDraft")).toHaveLength(1);
  expect(callsOf(engine, "avatars.generateCandidates")).toHaveLength(0);

  fireEvent.click(screen.getByRole("button", { name: "Подтвердить новую цену · до $0.25" }));
  await screen.findByText(/Рисуем портреты/);
  expect(callsOf(engine, "avatars.createDraft").map((c) => c.payload.acceptedWorstMicros)).toEqual([223_000, 250_000]);
  // 247_000, not the whole 250_000 the retry accepted: once createDraft
  // succeeds, generateCandidates is sent the draft's own batch worst
  // (250_000 − 3_000, the descriptor excluded), never the whole avatar's.
  expect(callsOf(engine, "avatars.generateCandidates").map((c) => c.payload.acceptedWorstMicros)).toEqual([247_000]);
});

test("«Ещё 4 варианта» shows the draft's own batch price, not the whole new-avatar price it replaced", async () => {
  const { scheduler } = setup();
  await openWizard();
  await estimate();
  expect(generateButton().textContent).toBe("Сгенерировать 4 варианта · до $0.23");
  fireEvent.click(generateButton());
  await screen.findByText(/Рисуем портреты/);
  runAll(scheduler);
  await screen.findByText(/Готово: 4 варианта на выбор/);

  // The descriptor is already paid for; only the batch's own worst case is
  // left, so the ceiling for another round must drop from the whole $0.23
  // to the draft's own batch price $0.22 (whole-slice review, M1, bug #2).
  expect(screen.getByRole("button", { name: "Ещё 4 варианта · до $0.22" })).toBeDefined();
});

test("a price rise while the batch is being bought re-asks via avatars.estimateCandidates, never the full avatars.estimate, before any candidates are sent", async () => {
  const { engine, scheduler } = setup();
  await openWizard();
  await estimate();
  // Only the batch call is delayed: the price can move in the gap between
  // the draft's own estimate (already back from createDraft) and the batch
  // actually being sent.
  engine.delayNext("avatars.generateCandidates", 50);
  fireEvent.click(generateButton());
  await waitFor(() => expect(callsOf(engine, "avatars.generateCandidates")).toHaveLength(1));
  expect(callsOf(engine, "avatars.generateCandidates")[0]?.payload.acceptedWorstMicros).toBe(220_000);

  engine.setPrice({ expectedMicros: 215_000, worstMicros: 250_000 });
  tick(scheduler, 1);

  await screen.findByText("Цена выросла");
  // "Было" is the batch's own worst ($0.22, what was actually sent to
  // generateCandidates), not the whole new-avatar worst ($0.23) — that
  // number was never sent for this command, so it must not appear as what
  // was "accepted" for it.
  expect(screen.getByText(/Было не больше \$0\.22, теперь не больше \$0\.25/)).toBeDefined();
  // The refusal lands right after a fresh createDraft: it must re-price only
  // the next batch, never the whole new avatar again. That needs the
  // avatarId generate() just created — its own local variable, not the
  // (still null before this render) avatarId state the closure would
  // otherwise read (finding #3).
  expect(callsOf(engine, "avatars.estimateCandidates")).toHaveLength(1);
  expect(callsOf(engine, "avatars.estimate")).toHaveLength(1); // only the original, upfront one
  expect(callsOf(engine, "avatars.generateCandidates")).toHaveLength(1); // the refused first attempt

  fireEvent.click(screen.getByRole("button", { name: "Подтвердить новую цену · до $0.25" }));
  await screen.findByText(/Рисуем портреты/);
  // First attempt at the batch's then-current worst (220_000), retried at
  // the new one (247_000 = 250_000 − 3_000, the batch alone) — never the
  // whole avatar's worst either time.
  expect(callsOf(engine, "avatars.generateCandidates").map((c) => c.payload.acceptedWorstMicros)).toEqual([220_000, 247_000]);
});

test("a fresh draft with no batch estimate re-prices via avatars.estimateCandidates and asks before any batch is sent", async () => {
  const { engine, scheduler } = setup();
  await openWizard();
  await estimate();
  engine.dropNextDraftEstimate();
  // The fallback price is a separate, later call: it can land from a
  // fresher (higher) price book than createDraft's own accepted-check used,
  // and the user has not seen it — the same class of bug as M1, so it must
  // not go straight to generateCandidates.
  engine.delayNext("avatars.estimateCandidates", 50);
  fireEvent.click(generateButton());
  await waitFor(() => expect(callsOf(engine, "avatars.estimateCandidates")).toHaveLength(1));
  expect(callsOf(engine, "avatars.generateCandidates")).toHaveLength(0);

  engine.setPrice({ expectedMicros: 215_000, worstMicros: 250_000 });
  tick(scheduler, 1);

  await screen.findByText("Цена выросла");
  expect(screen.getByText(/Было не больше \$0\.23, теперь не больше \$0\.25/)).toBeDefined();
  expect(callsOf(engine, "avatars.generateCandidates")).toHaveLength(0); // still nothing sent without a click

  fireEvent.click(screen.getByRole("button", { name: "Подтвердить новую цену · до $0.25" }));
  await screen.findByText(/Рисуем портреты/);
  // Exactly the shown batch worst (250_000 − 3_000, the descriptor excluded), never the whole avatar's.
  expect(callsOf(engine, "avatars.generateCandidates").map((c) => c.payload.acceptedWorstMicros)).toEqual([247_000]);
});

test("a failed fallback re-estimate clears the stale whole-avatar price so it can never be sent, and a retry gets the batch price", async () => {
  const { engine } = setup();
  await openWizard();
  await estimate();
  engine.dropNextDraftEstimate();
  engine.failNext("avatars.estimateCandidates", { code: "NETWORK" });
  fireEvent.click(generateButton());

  await screen.findByText(ERROR_MESSAGES_RU.NETWORK);
  // The whole-avatar estimate ($0.23) shown before generate() was clicked
  // must not sit around clickable: a click on it would send that whole
  // worst to generateCandidates, bringing back M1. With the batch price
  // unknown, there must be no generate button at all right now.
  expect(screen.queryByRole("button", { name: /Сгенерировать 4 варианта|Ещё 4 варианта/ })).toBeNull();
  expect(callsOf(engine, "avatars.generateCandidates")).toHaveLength(0);

  fireEvent.click(screen.getByRole("button", { name: "Повторить оценку" }));
  await waitFor(() => expect(callsOf(engine, "avatars.estimateCandidates")).toHaveLength(2));
  expect(screen.getByRole("button", { name: "Ещё 4 варианта · до $0.22" })).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "Ещё 4 варианта · до $0.22" }));
  await screen.findByText(/Рисуем портреты/);
  // The draft's own batch worst, never the whole avatar's.
  expect(callsOf(engine, "avatars.generateCandidates").map((c) => c.payload.acceptedWorstMicros)).toEqual([220_000]);
});

test("progress, then four candidates, then pick and save", async () => {
  const { engine, scheduler } = setup();
  await openWizard();
  await estimate();
  fireEvent.click(generateButton());
  await screen.findByText(/Рисуем портреты: 0 из 4/);

  tick(scheduler, 2);
  expect(screen.getByText("Рисуем портреты: 2 из 4")).toBeDefined();
  expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("2");

  runAll(scheduler);
  const radios = screen.getAllByRole("radio", { name: /^Вариант [A-D]$/ });
  expect(radios).toHaveLength(4);
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(screen.getByText(/Готово: 4 варианта на выбор/)).toBeDefined();

  // Save is not possible before a candidate is chosen.
  const save = screen.getByRole("button", { name: "Сохранить" });
  expect(save.hasAttribute("disabled")).toBe(true);

  fireEvent.click(screen.getByRole("radio", { name: "Вариант B" }));
  expect(screen.getByText("Мастер-портрет — вариант B.")).toBeDefined();
  fireEvent.change(screen.getByRole("textbox", { name: /Имя/ }), { target: { value: "  Mia " } });
  fireEvent.click(save);

  await screen.findByRole("heading", { level: 1, name: "Аватары" });
  const [pick] = callsOf(engine, "avatars.pick");
  const draftCall = callsOf(engine, "avatars.createDraft")[0];
  expect(pick?.payload.name).toBe("Mia");
  expect(pick?.payload.photoId).toBe(radios[1]?.getAttribute("value") ?? "");
  expect(screen.getByText(/Аватар «Mia» сохранён/)).toBeDefined();
  expect(screen.getByRole("heading", { level: 2, name: "Mia" })).toBeDefined();
  expect(draftCall).toBeDefined();
});

test("a blank name is refused in place", async () => {
  const { engine, scheduler } = setup();
  await openWizard();
  await estimate();
  fireEvent.click(generateButton());
  await screen.findByText(/Рисуем портреты/);
  runAll(scheduler);
  fireEvent.click(screen.getByRole("radio", { name: "Вариант A" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Имя/ }), { target: { value: "   " } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  expect(screen.getByText("Введите имя.")).toBeDefined();
  expect(callsOf(engine, "avatars.pick")).toHaveLength(0);
});

test("focus moves to the candidates when the generate button goes away", async () => {
  setup();
  await openWizard();
  await estimate();
  generateButton().focus();
  fireEvent.click(generateButton());
  await screen.findByText(/Рисуем портреты/);
  expect(focusedLabel()).toBe(describeElement(screen.getByRole("heading", { level: 2, name: "Кандидаты" })));
});

test("another batch does not claim to rewrite the descriptor", async () => {
  const { scheduler } = setup();
  await openWizard();
  await estimate();
  expect(document.querySelector(".estimate-caption")?.textContent).toContain("Дескриптор, 4 портрета");
  fireEvent.click(generateButton());
  await screen.findByText(/Рисуем портреты/);
  runAll(scheduler);
  const caption = document.querySelector(".estimate-caption")?.textContent ?? "";
  expect(caption).not.toContain("Дескриптор,");
  expect(caption).toContain("не пересоздаётся");
});

test("cancel sends avatars.cancel for the running job", async () => {
  const { engine, scheduler } = setup();
  await openWizard();
  await estimate();
  fireEvent.click(generateButton());
  await screen.findByText(/Рисуем портреты/);
  tick(scheduler, 1);

  fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
  await flush();
  runAll(scheduler); // the mock's own cancel-confirm delay elapses (M-optimistic-cancel), separate from the command's own reply
  await screen.findByText("Генерация остановлена");
  const jobId = callsOf(engine, "avatars.cancel")[0]?.payload.jobId;
  expect(jobId).toMatch(/^job-/);
  runAll(scheduler);
  // The one candidate already drawn before the cancel stays: only its three
  // still-queued siblings are gone, not the whole batch.
  expect(screen.queryAllByRole("radio", { name: /^Вариант/ })).toHaveLength(1);
  // Another batch can be started, again under an accepted worst case — the
  // draft's own batch price ($0.22), not the whole new-avatar price ($0.23)
  // that was already spent in part on the (now-done) descriptor.
  expect(screen.getByRole("button", { name: "Ещё 4 варианта · до $0.22" })).toBeDefined();
});

/**
 * Optimistic cancel (M-optimistic-cancel): the real engine answers
 * avatars.cancel before the job actually ends (engine.ts's #runCandidates
 * settles it later, once the in-flight requests really stop) — so the UI
 * must not call the job cancelled just because its own command was accepted.
 * The two tests below pin this at both ends: the command's own round trip,
 * and the separate, later real end.
 */
test("cancel keeps «Отменяем…» after its own command replies, until the job actually ends", async () => {
  const { engine, scheduler } = setup();
  await openWizard();
  await estimate();
  fireEvent.click(generateButton());
  await screen.findByText(/Рисуем портреты/);
  tick(scheduler, 1);

  const cancelButton = screen.getByRole("button", { name: "Отменить" });
  fireEvent.click(cancelButton);
  expect(screen.getByRole("button", { name: "Отменяем…" })).toBeDefined();
  expect(cancelButton.hasAttribute("disabled")).toBe(true);

  // The command's own (fast) reply lands — the mock, like the real engine,
  // answers before the job actually ends.
  await flush();
  expect(callsOf(engine, "avatars.cancel")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Отменяем…" })).toBeDefined();
  expect(screen.queryByText("Генерация остановлена")).toBeNull();
  // Still not done: the progress line stays, it is just being cancelled.
  expect(screen.getByText(/Рисуем портреты/)).toBeDefined();

  // Only now does the mock's own job.cancelled land, mirroring #runCandidates.
  runAll(scheduler);
  await flush();
  await screen.findByText("Генерация остановлена");
});

test("a delayed avatars.cancel reply also shows «Отменяем…» while in flight, and it still outlives that reply", async () => {
  const { engine, scheduler } = setup();
  await openWizard();
  await estimate();
  fireEvent.click(generateButton());
  await screen.findByText(/Рисуем портреты/);
  tick(scheduler, 1);

  // Only the cancel command's own reply is delayed: the batch's timers are untouched.
  engine.delayNext("avatars.cancel", 30);
  const cancelButton = screen.getByRole("button", { name: "Отменить" });
  fireEvent.click(cancelButton);
  expect(screen.getByRole("button", { name: "Отменяем…" })).toBeDefined();
  expect(cancelButton.hasAttribute("disabled")).toBe(true);
  expect(screen.queryByText("Генерация остановлена")).toBeNull();

  tick(scheduler, 1); // the delayed avatars.cancel reply arrives
  await flush();
  expect(callsOf(engine, "avatars.cancel")).toHaveLength(1);
  // Accepted, but not yet actually ended.
  expect(screen.getByRole("button", { name: "Отменяем…" })).toBeDefined();
  expect(screen.queryByText("Генерация остановлена")).toBeNull();

  runAll(scheduler); // the mock's own, separate cancel-confirm delay elapses
  await flush();
  await screen.findByText("Генерация остановлена");
});

test("failed slots are explained in Russian and their cost is called out, alongside whatever did succeed", async () => {
  const { engine, scheduler } = setup();
  engine.failNextSlots(2, { code: "MODERATION_REFUSED" });
  await openWizard();
  await estimate();
  fireEvent.click(generateButton());
  await screen.findByText(/Рисуем портреты/);
  runAll(scheduler);

  expect(screen.getAllByRole("radio", { name: /^Вариант/ })).toHaveLength(2);
  expect(screen.getByText(new RegExp(`варианта не удалось получить: ${ERROR_MESSAGES_RU.MODERATION_REFUSED}`))).toBeDefined();
  expect(screen.getByText(/Стоимость попытки учтена/)).toBeDefined();
});

test("when every slot fails the empty state explains it instead of showing blank letters", async () => {
  const { engine, scheduler } = setup();
  engine.failNextSlots(4, { code: "NETWORK" });
  await openWizard();
  await estimate();
  fireEvent.click(generateButton());
  await screen.findByText(/Рисуем портреты/);
  runAll(scheduler);

  expect(screen.queryAllByRole("radio", { name: /^Вариант/ })).toHaveLength(0);
  expect(screen.getByText(/Ни один вариант не получился/)).toBeDefined();
  // Russian plurals: 4 falls in the "few" form ("варианта"), not "вариантов".
  expect(screen.getByText(new RegExp(`4 варианта не удалось получить: ${ERROR_MESSAGES_RU.NETWORK}`))).toBeDefined();
  // A retry is a fresh, separately accepted attempt, at the draft's own
  // batch price ($0.22), not the whole new-avatar price ($0.23).
  expect(screen.getByRole("button", { name: "Ещё 4 варианта · до $0.22" })).toBeDefined();
});

test("errors are shown in Russian with a way to fix them", async () => {
  const { engine } = setup();
  await openWizard();
  await estimate();
  engine.failNext("avatars.createDraft", { code: "BUDGET_EXCEEDED" });
  fireEvent.click(generateButton());
  await screen.findByText(ERROR_MESSAGES_RU.BUDGET_EXCEEDED);
  fireEvent.click(screen.getByRole("button", { name: "Открыть деньги в Настройках" }));
  await screen.findByRole("heading", { level: 1, name: "Настройки" });
});

test("RECONCILE_REQUIRED from the engine is explained", async () => {
  const { engine } = setup();
  await openWizard();
  await estimate();
  engine.failNext("avatars.createDraft", { code: "RECONCILE_REQUIRED" });
  fireEvent.click(generateButton());
  expect(await screen.findByText(ERROR_MESSAGES_RU.RECONCILE_REQUIRED)).toBeDefined();
});

test("a pending reconcile blocks generation before anything is sent", async () => {
  const { engine } = setup();
  await openWizard();
  await estimate();
  inAct(() => engine.requireReconcile(["open-reserves"]));
  await flush();
  expect(generateButton().hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Платные запросы остановлены до сверки расходов.")).toBeDefined();
  expect(screen.getByText("Нужна сверка расходов")).toBeDefined();
});

test("a ledger that could not be read blocks generation and says why, with no reconcile to offer", async () => {
  setup({ money: { unavailable: { cause: "LEDGER_CORRUPT", detail: "ledger.jsonl:3 is not valid JSON" } } });
  await openWizard();
  await estimate();
  expect(generateButton().hasAttribute("disabled")).toBe(true);
  expect(screen.getAllByText(ERROR_MESSAGES_RU.LEDGER_CORRUPT).length).toBeGreaterThan(0);
  expect(screen.queryByRole("button", { name: "Перейти к сверке" }) === null).toBe(true);
});

test("a failed ledger write known from the snapshot blocks generation until a restart", async () => {
  setup({ money: { halt: { cause: "LEDGER_WRITE_FAILED", detail: "a ledger write failed" } } });
  await openWizard();
  await estimate();
  expect(generateButton().hasAttribute("disabled")).toBe(true);
  expect(screen.getAllByText(/Перезапустите Studio/).length).toBeGreaterThan(0);
});

test("a settle above its worst case known only from the snapshot blocks generation until a reconcile", async () => {
  setup({ money: { halt: { cause: "SETTLE_ABOVE_WORST", detail: "billed above", attemptIds: ["slot-1#1"] } } });
  await openWizard();
  await estimate();
  expect(generateButton().hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Платные запросы остановлены до сверки расходов.")).toBeDefined();
  expect(screen.getByText("Нужна сверка расходов")).toBeDefined();
});

test("a 401 in the middle of the job stops it and says so", async () => {
  const { engine, scheduler } = setup();
  await openWizard();
  await estimate();
  fireEvent.click(generateButton());
  await screen.findByText(/Рисуем портреты/);
  tick(scheduler, 1);
  inAct(() => engine.rejectKey());
  await flush();
  expect(screen.getByText(ERROR_MESSAGES_RU.AUTH_INVALID)).toBeDefined();
  expect(screen.getByText("OpenRouter отклонил ключ (401)")).toBeDefined();
  expect(screen.queryByRole("progressbar")).toBeNull();
});

test("without a key the wizard explains and does not offer to spend", async () => {
  setup({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
  await openWizard();
  await estimate();
  expect(generateButton().hasAttribute("disabled")).toBe(true);
  expect(screen.getByText(/Нужен рабочий ключ OpenRouter/)).toBeDefined();
});

test("the vibe is checked live: «schoolgirl» is refused, «girl next door» is fine", async () => {
  setup();
  await openWizard();
  const estimateButton = screen.getByRole("button", { name: "Оценить стоимость" });

  fireEvent.change(vibeInput(), { target: { value: "schoolgirl look, coffee" } });
  expect(vibeErrors()).toContain("«schoolgirl»");
  // Announced politely, not as an alert on every keystroke.
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.getByText("Исправьте поле «Вайб».")).toBeDefined();
  expect(vibeInput().getAttribute("aria-invalid")).toBe("true");
  expect(estimateButton.hasAttribute("disabled")).toBe(true);

  fireEvent.change(vibeInput(), { target: { value: "girl next door" } });
  expect(vibeErrors()).toBe("");
  expect(vibeInput().getAttribute("aria-invalid")).toBe("false");
  expect(estimateButton.hasAttribute("disabled")).toBe(false);
});

test("an age in the vibe that is not the slider's is refused", async () => {
  setup();
  await openWizard();
  fireEvent.change(vibeInput(), { target: { value: "looks 17, loves books" } });
  expect(vibeErrors()).toContain("другой возраст (17)");
});

test("«Случайно» fills valid traits", async () => {
  setup();
  await openWizard();
  fireEvent.change(vibeInput(), { target: { value: "teen" } });
  expect(vibeErrors()).not.toBe("");
  fireEvent.click(screen.getByRole("button", { name: "Случайно" }));
  expect(vibeErrors()).toBe("");
  expect(screen.getByRole("button", { name: "Оценить стоимость" }).hasAttribute("disabled")).toBe(false);
});

test("the form is labelled and keyboard operable with native controls", async () => {
  setup();
  await openWizard();
  expect(focusedLabel()).toBe(describeElement(screen.getByRole("heading", { level: 1, name: "Новый аватар" })));

  const age = screen.getByRole("slider", { name: "Возраст" });
  expect(age.getAttribute("min")).toBe("21");
  expect(age.getAttribute("max")).toBe("35");
  fireEvent.change(age, { target: { value: "31" } });
  expect(age.getAttribute("aria-valuetext")).toBe("31 год");

  const typage = screen.getByRole("group", { name: "Типаж" });
  expect(within(typage).getAllByRole("radio")).toHaveLength(5);
  expect(screen.getByRole("radio", { name: "Светлая оливковая" })).toBeDefined();
  expect(screen.getByRole("radio", { name: "Блонд" })).toBeDefined();
  expect(screen.getByRole("group", { name: "Длина волос" })).toBeDefined();
  expect(screen.getByRole("group", { name: "Текстура волос" })).toBeDefined();

  const freckles = screen.getByRole("checkbox", { name: "Веснушки" });
  expect(isChecked(freckles)).toBe(true);
  fireEvent.click(freckles);
  expect(isChecked(freckles)).toBe(false);

  const steps = screen.getByRole("list", { name: "Шаги" });
  expect(within(steps).getByText("Внешность").closest("li")?.getAttribute("aria-current")).toBe("step");
  // No language selector: on-video text is English only.
  expect(screen.queryByText(/Язык/)).toBeNull();
});

test("the wizard says when the engine stops answering, and blocks spending until it is back", async () => {
  const { engine } = setup();
  await openWizard();
  await estimate();
  engine.failNext("engine.snapshot", { code: "INTERNAL" });
  inAct(() => engine.restart());
  await flush();
  expect(screen.getByText("Движок не отвечает")).toBeDefined();
  expect(generateButton().hasAttribute("disabled")).toBe(true);

  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  await flush();
  expect(document.body.textContent).not.toContain("Движок не отвечает");
  expect(generateButton().hasAttribute("disabled")).toBe(false);
});

test("leaving the wizard while the draft is being created buys no batch afterwards: generateCandidates is never sent", async () => {
  const { engine, scheduler } = setup({ latencyMs: 500 });
  /** Answers every pending mock response and lets the UI take them in. */
  const answerAll = async () => {
    for (let i = 0; i < 5; i++) {
      runAll(scheduler);
      await flush();
    }
  };
  await answerAll();
  await openWizard();
  fireEvent.click(screen.getByRole("button", { name: "Оценить стоимость" }));
  await answerAll();
  await waitFor(() => expect(estimateText()).not.toBeNull());

  fireEvent.click(generateButton());
  await flush();
  expect(callsOf(engine, "avatars.createDraft")).toHaveLength(1);
  const back = document.querySelector(".back-link");
  if (!(back instanceof HTMLElement)) throw new Error("no back link");
  fireEvent.click(back);
  await flush();
  expect(screen.queryByRole("heading", { level: 1, name: "Новый аватар" })).toBeNull();

  await answerAll();

  expect(callsOf(engine, "avatars.generateCandidates")).toHaveLength(0);
});

// ---------- continuing an existing draft: its own estimate, IN_FLIGHT, DESCRIPTOR_INVALID (T8a) ----------

test("a continued draft with no cached price fetches one via avatars.estimateCandidates, not the full avatars.estimate", async () => {
  const draft = continuedDraft();
  const { engine } = setup({ drafts: [draft] });
  await continueDraft();

  await waitFor(() => expect(estimateText()).not.toBeNull());
  expect(estimateText()).toBe("≈ $0.21, не больше $0.22");
  expect(callsOf(engine, "avatars.estimateCandidates").map((c) => c.payload)).toEqual([{ avatarId: draft.avatarId }]);
  expect(callsOf(engine, "avatars.estimate")).toHaveLength(0);
  expect(screen.getByRole("button", { name: /Ещё 4 варианта/ })).toBeDefined();
});

// A schema-invalid descriptor cannot sit in a fixture draft: the mock validates
// its own snapshot against the same AvatarDescriptor contract, so it would
// throw before the app even loaded. failNext models the engine's own defensive
// re-check (the descriptor could have stopped fitting today's rules between
// listing and this command) without needing an actually-broken fixture.
test("DESCRIPTOR_INVALID on a continued draft's own price points at the rewrite recovery in Аватары", async () => {
  const draft = continuedDraft();
  const { engine } = setup({ drafts: [draft] });
  engine.failNext("avatars.estimateCandidates", { code: "DESCRIPTOR_INVALID" });
  await continueDraft();

  await screen.findByText(ERROR_MESSAGES_RU.DESCRIPTOR_INVALID);
  expect(screen.queryByRole("button", { name: /Ещё 4 варианта/ })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Переписать описание" }));
  await screen.findByRole("heading", { level: 1, name: "Аватары" });
});

test("DESCRIPTOR_INVALID on avatars.generateCandidates points at the rewrite recovery too", async () => {
  const draft = continuedDraft({ estimate: { ...MOCK_ESTIMATE } });
  const { engine } = setup({ drafts: [draft] });
  await continueDraft();
  engine.failNext("avatars.generateCandidates", { code: "DESCRIPTOR_INVALID" });

  fireEvent.click(screen.getByRole("button", { name: /Ещё 4 варианта/ }));
  await screen.findByText(ERROR_MESSAGES_RU.DESCRIPTOR_INVALID);
  expect(callsOf(engine, "avatars.generateCandidates")).toHaveLength(1);
  expect(screen.getByRole("button", { name: "Переписать описание" })).toBeDefined();
});

test("DESCRIPTOR_INVALID on avatars.pick (save) points at the rewrite recovery in the save card", async () => {
  const draft = continuedDraft({
    estimate: { ...MOCK_ESTIMATE },
    candidates: [{ avatarId: "avatar-continue-0001", photoId: "photo-continue-0001" }],
  });
  const { engine } = setup({ drafts: [draft] });
  await continueDraft();
  engine.failNext("avatars.pick", { code: "DESCRIPTOR_INVALID" });

  fireEvent.click(screen.getByRole("radio", { name: "Вариант A" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Имя/ }), { target: { value: "Mia" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));

  await screen.findByText(ERROR_MESSAGES_RU.DESCRIPTOR_INVALID);
  expect(callsOf(engine, "avatars.pick")).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Переписать описание" }));
  await screen.findByRole("heading", { level: 1, name: "Аватары" });
});

test("a second batch (PRICE_CHANGED) on a continued draft re-asks via avatars.estimateCandidates, never the full estimate", async () => {
  const draft = continuedDraft({ estimate: { ...MOCK_ESTIMATE } });
  const { engine } = setup({ drafts: [draft] });
  await continueDraft();

  engine.setPrice({ expectedMicros: 215_000, worstMicros: 250_000 });
  fireEvent.click(screen.getByRole("button", { name: /Ещё 4 варианта/ }));

  await screen.findByText("Цена выросла");
  expect(callsOf(engine, "avatars.estimateCandidates")).toHaveLength(1);
  expect(callsOf(engine, "avatars.estimate")).toHaveLength(0);
  expect(callsOf(engine, "avatars.generateCandidates")).toHaveLength(1); // the refused first attempt
});

test("running a batch disables Сохранить for candidates already on hand, with a hint why", async () => {
  const draft = continuedDraft({
    estimate: { ...MOCK_ESTIMATE },
    candidates: [{ avatarId: "avatar-continue-0001", photoId: "photo-continue-0001" }],
  });
  const { scheduler } = setup({ drafts: [draft] });
  await continueDraft();
  fireEvent.click(screen.getByRole("radio", { name: "Вариант A" }));
  const save = screen.getByRole("button", { name: "Сохранить" });
  expect(save.hasAttribute("disabled")).toBe(false);

  fireEvent.click(screen.getByRole("button", { name: /Ещё 4 варианта/ }));
  await screen.findByText(/Рисуем портреты/);
  expect(save.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Дождитесь конца генерации, чтобы сохранить.")).toBeDefined();

  runAll(scheduler);
  await waitFor(() => expect(save.hasAttribute("disabled")).toBe(false));
});
