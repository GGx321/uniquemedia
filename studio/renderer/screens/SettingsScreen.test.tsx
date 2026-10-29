import { afterEach, describe, expect, jest, test } from "bun:test";
import { fireEvent, screen, within } from "@testing-library/react";
import { type ApiKeyStatus, AGE_CHECK_FALLBACK_PRICE, ERROR_MESSAGES_RU } from "../../shared/engine";
import { callsOf, flush, openSection, setup, inAct } from "../testing";

// Safety net for the clock-skew test's fake timers: if that test ever times
// out mid-`await`, its own `finally` never runs, and real timers would stay
// faked for every test after it. This restores them unconditionally between
// every test, whether or not the previous one actually enabled them.
afterEach(() => {
  jest.useRealTimers();
});

const NOT_SET: ApiKeyStatus = { stored: false, last4: null, encryptionAvailable: true, rejected: false };
const STORED: ApiKeyStatus = { stored: true, last4: "3f2a", encryptionAvailable: true, rejected: false };
const REJECTED: ApiKeyStatus = { stored: true, last4: "3f2a", encryptionAvailable: true, rejected: true };

async function openSettings(apiKey: ApiKeyStatus = STORED, extra: Parameters<typeof setup>[0] = {}) {
  const ctx = setup({ apiKey, ...extra });
  await flush();
  await openSection("Настройки");
  await screen.findByRole("heading", { level: 2, name: "OpenRouter и расходы" });
  return ctx;
}

function keyInput(): HTMLElement {
  return screen.getByLabelText("API-ключ");
}

/** The age-check switch, found by its row's name as a screen reader would. */
function ageSwitch(): HTMLElement {
  return screen.getByRole("switch", { name: "Автопроверка возраста на фото" });
}

function inputValues(): string[] {
  return Array.from(document.querySelectorAll("input"), (i) => i.value);
}

// ---------- key ----------

test("key state: stored shows only the last four characters", async () => {
  await openSettings(STORED);
  expect(screen.getByText("зашифрован системой")).toBeDefined();
  const mask = screen.getByDisplayValue("••••••3f2a");
  expect(mask.hasAttribute("readonly")).toBe(true);
  expect(mask.getAttribute("aria-label")).toBe("Ключ, последние символы 3f2a");
  expect(screen.getByRole("button", { name: "Заменить" })).toBeDefined();
});

test("key state: rejected by OpenRouter (401)", async () => {
  await openSettings(REJECTED);
  expect(screen.getByText("OpenRouter отклонил ключ (401)")).toBeDefined();
  expect(screen.getByText(/Генерация остановлена и сама не повторяется/)).toBeDefined();
  expect(screen.getByDisplayValue("••••••3f2a")).toBeDefined();
});

test("saving a key sends it once and never renders it again", async () => {
  const { engine } = await openSettings(NOT_SET);
  const key = "sk-or-v1-0123456789abcdef7890";
  fireEvent.change(keyInput(), { target: { value: key } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить ключ" }));
  await screen.findByDisplayValue("••••••7890");

  expect(callsOf(engine, "settings.setApiKey").map((c) => c.payload.key)).toEqual([key]);
  expect(document.body.innerHTML).not.toContain(key);
  expect(document.body.innerHTML).not.toContain("0123456789abcdef");
  expect(inputValues().some((v) => v.includes("0123456789"))).toBe(false);

  // Rotation opens an empty field: the old key is not there to show.
  fireEvent.click(screen.getByRole("button", { name: "Заменить" }));
  expect(inputValues().some((v) => v.includes("0123456789"))).toBe(false);
  fireEvent.change(keyInput(), { target: { value: "sk-or-v1-rotated-key-4444" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить ключ" }));
  await screen.findByDisplayValue("••••••4444");
  expect(document.body.innerHTML).not.toContain("rotated");
});

test("a failed save does not keep the key on screen either", async () => {
  const { engine } = await openSettings(NOT_SET);
  engine.failNext("settings.setApiKey", { code: "ENCRYPTION_UNAVAILABLE" });
  fireEvent.change(keyInput(), { target: { value: "sk-or-v1-failing-key-1111" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить ключ" }));
  await screen.findByText(ERROR_MESSAGES_RU.ENCRYPTION_UNAVAILABLE);
  expect(document.body.innerHTML).not.toContain("failing-key");
});

test("a malformed key is refused before it is sent", async () => {
  const { engine } = await openSettings(NOT_SET);
  fireEvent.change(keyInput(), { target: { value: "short" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить ключ" }));
  expect(screen.getByText(/от 8 печатных символов/)).toBeDefined();
  expect(callsOf(engine, "settings.setApiKey")).toHaveLength(0);
});

test("the key can be removed", async () => {
  const { engine } = await openSettings(STORED);
  fireEvent.click(screen.getByRole("button", { name: "Удалить" }));
  await screen.findByText(/^не задан/);
  expect(callsOf(engine, "settings.clearApiKey")).toHaveLength(1);
});

// ---------- budget ----------

test("the budget is typed in dollars and sent as integer micros", async () => {
  const { engine } = await openSettings();
  const input = screen.getByLabelText("Бюджет на месяц");
  expect(input instanceof HTMLInputElement ? input.value : null).toBe("$10.00");
  // Nothing to save until the amount changes.
  expect(screen.queryByRole("button", { name: "Сохранить бюджет" }) === null).toBe(true);
  fireEvent.change(input, { target: { value: "12.5" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить бюджет" }));
  await screen.findByText(/сохранён: \$12\.50 в месяц/);
  expect(callsOf(engine, "settings.setBudget").map((c) => c.payload.monthlyBudgetMicros)).toEqual([12_500_000]);
  expect(input instanceof HTMLInputElement ? input.value : null).toBe("$12.50");
});

test("an invalid budget is explained and not sent", async () => {
  const { engine } = await openSettings();
  const input = screen.getByLabelText("Бюджет на месяц");
  const form = input.closest("form");
  if (!form) throw new Error("budget form missing");
  const cases: [string, RegExp][] = [
    ["abc", /Только число/],
    ["10.123", /двух знаков после точки/],
    ["0", /больше нуля/],
    ["20000", /Не больше \$10 000/],
    ["", /Введите сумму/],
  ];
  for (const [value, message] of cases) {
    fireEvent.change(input, { target: { value } });
    fireEvent.submit(form);
    expect(screen.getByRole("alert").textContent ?? "").toMatch(message);
    expect(input.getAttribute("aria-invalid")).toBe("true");
  }
  expect(callsOf(engine, "settings.setBudget")).toHaveLength(0);
});

// ---------- money status and reconcile ----------

test("money status shows spent, the budget and open reserves", async () => {
  await openSettings(STORED, { money: { spentMicros: 1_420_000 } });
  // The sidebar shows the same month's spend; these are the card's own rows.
  const card = screen.getByRole("region", { name: "OpenRouter и расходы" });
  expect(within(card).getByText("Сентябрь · потрачено")).toBeDefined();
  expect(within(card).getByText("$1.42")).toBeDefined();
  expect(within(card).getByText("нет")).toBeDefined();
});

test("reconcile done shows both totals and that they match", async () => {
  const { engine } = await openSettings();
  engine.queueReconcile({ status: "done", creditsDeltaMicros: 207_600, deltaUnavailable: null, ledgerDeltaMicros: 211_000, mismatch: false, closedReserves: 2, aboveWorstAttempts: [], tornLineMoved: true, warnings: [] });
  fireEvent.click(screen.getByRole("button", { name: "Сверить" }));
  // The verdict sits in the reconcile row's hint, both totals in it.
  await screen.findByText(/сверено: \/credits \$0\.2076 · журнал \$0\.2110 — сходится/);
  expect(screen.getByText(/закрыто по худшей цене: 2\s*резерва/)).toBeDefined();
  expect(screen.getByText(/ledger\.torn/)).toBeDefined();
  // The money card is back to its calm state: nothing left to reconcile.
  await flush();
  expect(document.body.textContent).not.toContain("Нужна сверка расходов");
  expect(screen.getByText("нет")).toBeDefined();
});

test("reconcile mismatch above one cent is flagged", async () => {
  const { engine } = await openSettings();
  engine.queueReconcile({ status: "done", creditsDeltaMicros: 260_000, deltaUnavailable: null, ledgerDeltaMicros: 207_600, mismatch: true, closedReserves: 0, aboveWorstAttempts: [], tornLineMoved: false, warnings: [] });
  fireEvent.click(screen.getByRole("button", { name: "Сверить" }));
  await screen.findByText(/расхождение \$0\.0524: \/credits \$0\.2600 · журнал \$0\.2076/);
  expect(screen.getByText(/ключом пользовались вне Studio\?/)).toBeDefined();
});

test("a difference of exactly one cent is not a mismatch; one micro more is", async () => {
  const { engine } = await openSettings();
  engine.queueReconcile({ status: "done", creditsDeltaMicros: 110_000, deltaUnavailable: null, ledgerDeltaMicros: 100_000, mismatch: false, closedReserves: 0, aboveWorstAttempts: [], tornLineMoved: false, warnings: [] });
  fireEvent.click(screen.getByRole("button", { name: "Сверить" }));
  await screen.findByText(/— сходится/);

  engine.queueReconcile({ status: "done", creditsDeltaMicros: 110_001, deltaUnavailable: null, ledgerDeltaMicros: 100_000, mismatch: true, closedReserves: 0, aboveWorstAttempts: [], tornLineMoved: false, warnings: [] });
  fireEvent.click(screen.getByRole("button", { name: "Сверить" }));
  await screen.findByText(/расхождение \$0\.0100/);
});

test("reconcile refused while requests are in flight", async () => {
  const { engine } = await openSettings();
  engine.failNext("money.reconcile", { code: "IN_FLIGHT" });
  fireEvent.click(screen.getByRole("button", { name: "Сверить" }));
  expect(await screen.findByText(ERROR_MESSAGES_RU.IN_FLIGHT)).toBeDefined();
});

test("a settle above its reserve halts paid calls until a reconcile, and the reconcile lifts it", async () => {
  const { engine } = await openSettings();
  inAct(() => engine.haltAboveWorst());
  await flush();
  expect(screen.getByText("списание оказалось выше зарезервированного максимума")).toBeDefined();
  expect(screen.getByText("Нужна сверка расходов")).toBeDefined();
  expect(screen.getByRole("button", { name: "Сверить" }).className).toContain("btn-p");

  fireEvent.click(screen.getByRole("button", { name: "Сверить" }));
  await screen.findByText(/— сходится/);
  await flush();
  expect(document.body.textContent).not.toContain("списание оказалось выше зарезервированного максимума");
  expect(document.body.textContent).not.toContain("Нужна сверка расходов");
  expect(screen.getByRole("button", { name: "Сверить" }).className).not.toContain("btn-p");
});

test("a ledger that could not be read: no reconcile is offered, and the page says why", async () => {
  await openSettings(STORED, { money: { unavailable: { cause: "LEDGER_UNREADABLE", detail: "EACCES: permission denied" } } });
  expect(screen.queryByRole("button", { name: "Сверить" }) === null).toBe(true);
  expect(screen.queryByText("Сверка недоступна") !== null).toBe(true);
  expect(screen.getAllByText(ERROR_MESSAGES_RU.LEDGER_UNREADABLE).length).toBeGreaterThan(0);
});

test("a settle above its worst case known only from the status (after a restart) is a reason to reconcile", async () => {
  await openSettings(STORED, { money: { halt: { cause: "SETTLE_ABOVE_WORST", detail: "billed above", attemptIds: ["slot-1#1"] } } });
  expect(screen.getByText("Нужна сверка расходов")).toBeDefined();
  expect(screen.getByText("списание оказалось выше зарезервированного максимума")).toBeDefined();
  expect(screen.getByRole("button", { name: "Сверить" }).className).toContain("btn-p");
});

// ---------- performance, models, folders ----------

// Photo runs exist (slice 2b): the scene writer runs on the text model and the
// runs' photos on the image model, so neither row may still promise them.

// Owner's decision (2026-09-27): the paid image age check is optional, off by default.
describe("image age check toggle", () => {
  test("off by default: the switch is off and says so, with its per-photo estimate from the shared fallback price table", async () => {
    await openSettings(STORED, { imageAgeCheck: "off" });
    expect(ageSwitch().getAttribute("aria-checked")).toBe("false");
    // «≈», not «до»: this is only the dated fallback table (used when
    // OpenRouter did not answer), and «до» means a hard cap everywhere else
    // in the app — the live price can be higher — so it shows a range from
    // the expected price to the worst case, not the worst case alone.
    // Pinned to the fallback table's own numbers, and the rendered text is a
    // literal, not computed with formatUsdRange itself — a bug in that
    // function must still be caught here, not just agree with itself.
    expect(AGE_CHECK_FALLBACK_PRICE).toEqual({ expectedMicros: 1_660, worstMicros: 5_250 });
    expect(document.body.textContent).toContain("≈ $0.002–0.006 за фото");
    expect(screen.getByText(/по умолчанию выключена/i)).toBeDefined();
  });

  test("turning it on sends settings.setImageAgeCheck and reflects the engine's answer", async () => {
    const { engine } = await openSettings(STORED, { imageAgeCheck: "off" });

    fireEvent.click(ageSwitch());
    await flush();

    expect(callsOf(engine, "settings.setImageAgeCheck").map((c) => c.payload.imageAgeCheck)).toEqual(["on"]);
    expect(ageSwitch().getAttribute("aria-checked")).toBe("true");
  });

});


