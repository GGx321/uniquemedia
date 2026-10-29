import { expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ERROR_MESSAGES_RU, type Draft } from "../../shared/engine";
import { mockDescriptor } from "../engine/mockEngine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { callsOf, estimateText, flush, openWizard, runAll, setup, tick, inAct, withText } from "../testing";

function continuedDraft(overrides: Partial<Draft> = {}): Draft {
  return {
    avatarId: "avatar-continue-0001",
    traits: DEFAULT_TRAITS,
    descriptor: mockDescriptor(DEFAULT_TRAITS),
    candidates: [],
    hiddenBelowThreshold: 0,
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
  const { engine } = setup({ imageAgeCheck: "on" });
  await openWizard();
  expect(screen.queryByRole("button", { name: /Сгенерировать/ }) === null).toBe(true);

  await estimate();
  expect(estimateText()).toBe("до $0.23 · ожидаемая ≈ $0.21");
  expect(generateButton().textContent).toBe("Сгенерировать 4 варианта · до $0.23");
  expect(callsOf(engine, "avatars.estimate")).toHaveLength(1);
  expect(callsOf(engine, "avatars.createDraft")).toHaveLength(0);
  expect(callsOf(engine, "avatars.generateCandidates")).toHaveLength(0);
});

test("generate sends the whole new-avatar worst to createDraft, then the draft's own batch worst to generateCandidates", async () => {
  const { engine } = setup({ imageAgeCheck: "on" });
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
  expect(screen.queryByRole("button", { name: /Сгенерировать/ }) === null).toBe(true);
  expect(screen.getByRole("button", { name: "Оценить стоимость" }).hasAttribute("disabled")).toBe(false);
});

test("changing the traits drops the estimate, so a stale price can never be accepted", async () => {
  setup();
  await openWizard();
  await estimate();
  fireEvent.click(screen.getByRole("radio", { name: "Азиатский" }));
  expect(estimateText()).toBeNull();
  expect(screen.queryByRole("button", { name: /Сгенерировать/ }) === null).toBe(true);
  expect(screen.getByRole("button", { name: "Оценить стоимость" })).toBeDefined();
});

test("PRICE_CHANGED shows the new estimate and asks again before spending", async () => {
  const { engine } = setup({ imageAgeCheck: "on" });
  await openWizard();
  await estimate();
  engine.setPrice({ expectedMicros: 215_000, worstMicros: 250_000 });
  fireEvent.click(generateButton());

  await screen.findByText("Цена выросла");
  expect(estimateText()).toBe("до $0.25 · ожидаемая ≈ $0.22");
  expect(screen.getByText(withText(/Было не больше \$0\.23, теперь не больше \$0\.25/))).toBeDefined();
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
  const { scheduler } = setup({ imageAgeCheck: "on" });
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
  const { engine, scheduler } = setup({ imageAgeCheck: "on" });
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
  expect(screen.getByText(withText(/Было не больше \$0\.22, теперь не больше \$0\.25/))).toBeDefined();
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
  expect(screen.queryByRole("progressbar") === null).toBe(true);
  expect(screen.getByText(/Готово: 4 варианта на выбор/)).toBeDefined();

  // Save is not possible before a candidate is chosen.
  const save = screen.getByRole("button", { name: "Сохранить" });
  expect(save.hasAttribute("disabled")).toBe(true);

  fireEvent.click(screen.getByRole("radio", { name: "Вариант B" }));
  expect(screen.getByText("Мастер-портрет — вариант B.")).toBeDefined();
  fireEvent.change(screen.getByRole("textbox", { name: /Имя/ }), { target: { value: "  Mia " } });
  fireEvent.click(save);

  // S5.0d re-pin (the owner's decision, plan §5.5): «Сохранить» ends on the new avatar's «Внешность», not on the Avatars grid.
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  const [pick] = callsOf(engine, "avatars.pick");
  const draftCall = callsOf(engine, "avatars.createDraft")[0];
  expect(pick?.payload.name).toBe("Mia");
  expect(pick?.payload.photoId).toBe(radios[1]?.getAttribute("value") ?? "");
  expect(screen.getByText("Аватар «Mia» сохранён. Мастер-портрет готов для фото.").tagName).toBe("DIV");
  expect(screen.getByRole("tab", { name: "Внешность" }).getAttribute("aria-selected")).toBe("true");
  expect(draftCall).toBeDefined();
});

// Owner's decision (2026-09-27): the paid image age check is optional, off by
// default; the wizard's Russian texts that mention it must be accurate in
// both modes.

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
  expect(screen.queryByRole("progressbar") === null).toBe(true);
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
  expect(screen.queryByRole("alert") === null).toBe(true);
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

// Three steps, as on the mockup: the estimate belongs to «Кандидаты».

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
  expect(screen.queryByRole("heading", { level: 1, name: "Новый аватар" }) === null).toBe(true);

  await answerAll();

  expect(callsOf(engine, "avatars.generateCandidates")).toHaveLength(0);
});

// ---------- continuing an existing draft: its own estimate, IN_FLIGHT, DESCRIPTOR_INVALID (T8a) ----------

test("a continued draft with no cached price fetches one via avatars.estimateCandidates, not the full avatars.estimate", async () => {
  // A distinct age from DEFAULT_TRAITS: the grid's own «Новый аватар» tile
  // estimates with DEFAULT_TRAITS, so a draft that also used DEFAULT_TRAITS
  // could not tell the two calls apart by their traits.
  const draftTraits = { ...DEFAULT_TRAITS, age: 30 };
  const draft = continuedDraft({ traits: draftTraits, descriptor: mockDescriptor(draftTraits) });
  const { engine } = setup({ drafts: [draft], imageAgeCheck: "on" });
  // The grid's own «Новый аватар» tile prices a new avatar — one call, counted
  // before the wizard opens, so any the wizard itself made would show on top.
  // Filtered by payload.traits rather than a raw count: what matters is that
  // no avatars.estimate call carries this draft's own traits, not that the
  // total number of calls (which an unrelated future one could also change)
  // happens to be exactly 1.
  await screen.findByRole("article", { name: "Черновик" });
  await waitFor(() => expect(callsOf(engine, "avatars.estimate").map((c) => c.payload.traits)).toEqual([DEFAULT_TRAITS]));
  await continueDraft();

  await waitFor(() => expect(estimateText()).not.toBeNull());
  expect(estimateText()).toBe("до $0.22 · ожидаемая ≈ $0.21");
  expect(callsOf(engine, "avatars.estimateCandidates").map((c) => c.payload)).toEqual([{ avatarId: draft.avatarId }]);
  expect(callsOf(engine, "avatars.estimate").map((c) => c.payload.traits)).not.toContainEqual(draftTraits);
  expect(screen.getByRole("button", { name: /Ещё 4 варианта/ })).toBeDefined();
});

// A stricter age calibration can hide every stored candidate of a draft (or
// only some), which otherwise looks exactly like "never generated" — both
// show candidates: [] or a partial grid with no explanation.

// A schema-invalid descriptor cannot sit in a fixture draft: the mock validates
// its own snapshot against the same AvatarDescriptor contract, so it would
// throw before the app even loaded. failNext models the engine's own defensive
// re-check (the descriptor could have stopped fitting today's rules between
// listing and this command) without needing an actually-broken fixture.

