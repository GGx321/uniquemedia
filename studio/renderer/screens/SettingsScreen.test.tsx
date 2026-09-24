import { expect, test } from "bun:test";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { type ApiKeyStatus, ERROR_MESSAGES_RU } from "../../shared/engine";
import { callsOf, flush, openSection, setup, inAct, describeElement, focusedLabel } from "../testing";

const NOT_SET: ApiKeyStatus = { stored: false, last4: null, encryptionAvailable: true, rejected: false };
const STORED: ApiKeyStatus = { stored: true, last4: "3f2a", encryptionAvailable: true, rejected: false };
const REJECTED: ApiKeyStatus = { stored: true, last4: "3f2a", encryptionAvailable: true, rejected: true };
const NO_CRYPTO: ApiKeyStatus = { stored: false, last4: null, encryptionAvailable: false, rejected: false };

async function openSettings(apiKey: ApiKeyStatus = STORED, extra: Parameters<typeof setup>[0] = {}) {
  const ctx = setup({ apiKey, ...extra });
  await flush();
  await openSection("Настройки");
  await screen.findByRole("heading", { level: 2, name: "OpenRouter" });
  return ctx;
}

function keyInput(): HTMLElement {
  return screen.getByLabelText("API-ключ");
}

function inputValues(): string[] {
  return Array.from(document.querySelectorAll("input"), (i) => i.value);
}

// ---------- key ----------

test("key state: not set", async () => {
  await openSettings(NOT_SET);
  expect(screen.getByText("Не задан")).toBeDefined();
  expect(keyInput().getAttribute("type")).toBe("password");
  expect(screen.queryByText(/••••/)).toBeNull();
});

test("key state: stored shows only the last four characters", async () => {
  await openSettings(STORED);
  expect(screen.getByText("Сохранён и зашифрован")).toBeDefined();
  expect(screen.getByText("•••• 3f2a")).toBeDefined();
  expect(screen.getByRole("button", { name: "Заменить" })).toBeDefined();
});

test("key state: rejected by OpenRouter (401)", async () => {
  await openSettings(REJECTED);
  expect(screen.getByText("OpenRouter отклонил ключ (401)")).toBeDefined();
  expect(screen.getByText("•••• 3f2a")).toBeDefined();
});

test("key state: encryption unavailable explains why nothing is stored", async () => {
  await openSettings(NO_CRYPTO);
  expect(screen.getByText("Системное шифрование недоступно")).toBeDefined();
  expect(screen.getByText(/поэтому ключ не сохраняется/)).toBeDefined();
  expect(keyInput().hasAttribute("disabled")).toBe(true);
});

test("saving a key sends it once and never renders it again", async () => {
  const { engine } = await openSettings(NOT_SET);
  const key = "sk-or-v1-0123456789abcdef7890";
  fireEvent.change(keyInput(), { target: { value: key } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить ключ" }));
  await screen.findByText("•••• 7890");

  expect(callsOf(engine, "settings.setApiKey").map((c) => c.payload.key)).toEqual([key]);
  expect(document.body.innerHTML).not.toContain(key);
  expect(document.body.innerHTML).not.toContain("0123456789abcdef");
  expect(inputValues().some((v) => v.includes("0123456789"))).toBe(false);

  // Rotation opens an empty field: the old key is not there to show.
  fireEvent.click(screen.getByRole("button", { name: "Заменить" }));
  expect(inputValues().some((v) => v.includes("0123456789"))).toBe(false);
  fireEvent.change(keyInput(), { target: { value: "sk-or-v1-rotated-key-4444" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить ключ" }));
  await screen.findByText("•••• 4444");
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
  await screen.findByText("Не задан");
  expect(callsOf(engine, "settings.clearApiKey")).toHaveLength(1);
});

// ---------- budget ----------

test("the budget is typed in dollars and sent as integer micros", async () => {
  const { engine } = await openSettings();
  const input = screen.getByLabelText("Месячный бюджет");
  expect(input instanceof HTMLInputElement ? input.value : null).toBe("10.00");
  fireEvent.change(input, { target: { value: "12.5" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить бюджет" }));
  await screen.findByText(/Бюджет сохранён: \$12\.50 в месяц/);
  expect(callsOf(engine, "settings.setBudget").map((c) => c.payload.monthlyBudgetMicros)).toEqual([12_500_000]);
});

test("an invalid budget is explained and not sent", async () => {
  const { engine } = await openSettings();
  const input = screen.getByLabelText("Месячный бюджет");
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
  expect(screen.getByText("Сентябрь 2026 · потрачено")).toBeDefined();
  expect(screen.getByText("$1.42")).toBeDefined();
  expect(screen.getByText("нет")).toBeDefined();
});

test("reconcile needed: reasons, then too-early with the wait", async () => {
  const { engine } = await openSettings();
  inAct(() => engine.requireReconcile(["open-reserves", "torn-ledger-line"]));
  await flush();
  expect(screen.getByText(/остались незакрытые резервы/)).toBeDefined();
  expect(screen.getByText(/последняя строка журнала расходов обрезана/)).toBeDefined();

  engine.queueReconcile({ status: "too-early", retryAfterMs: 95_000 });
  fireEvent.click(screen.getByRole("button", { name: "Сверить" }));
  await screen.findByText("Слишком рано");
  expect(screen.getByText(/Сверить можно через 1\s*мин 35\s*с/)).toBeDefined();
  expect(screen.getByRole("button", { name: "Сверить" }).hasAttribute("disabled")).toBe(true);
});

test("reconcile done shows both totals and that they match", async () => {
  const { engine } = await openSettings();
  engine.queueReconcile({ status: "done", creditsDeltaMicros: 207_600, ledgerDeltaMicros: 211_000, closedReserves: 2, tornLineMoved: true });
  fireEvent.click(screen.getByRole("button", { name: "Сверить" }));
  await screen.findByText("$0.2076");
  expect(screen.getByText("$0.2110")).toBeDefined();
  expect(screen.getByText(/Суммы сходятся/)).toBeDefined();
  expect(screen.getByText(/Закрыто по худшей цене: 2\s*резерва/)).toBeDefined();
  expect(screen.getByText(/ledger\.torn/)).toBeDefined();
  // The money card is back to its calm state: nothing left to reconcile.
  await flush();
  expect(document.body.textContent).not.toContain("Нужна сверка расходов");
  expect(screen.getByText("нет")).toBeDefined();
});

test("reconcile mismatch above one cent is flagged", async () => {
  const { engine } = await openSettings();
  engine.queueReconcile({ status: "done", creditsDeltaMicros: 260_000, ledgerDeltaMicros: 207_600, closedReserves: 0, tornLineMoved: false });
  fireEvent.click(screen.getByRole("button", { name: "Сверить" }));
  await screen.findByText("Расхождение $0.0524");
  expect(screen.getByText(/OpenRouter насчитал больше/)).toBeDefined();
});

test("a difference of exactly one cent is not a mismatch; one micro more is", async () => {
  const { engine } = await openSettings();
  engine.queueReconcile({ status: "done", creditsDeltaMicros: 110_000, ledgerDeltaMicros: 100_000, closedReserves: 0, tornLineMoved: false });
  fireEvent.click(screen.getByRole("button", { name: "Сверить" }));
  await screen.findByText(/Суммы сходятся/);

  engine.queueReconcile({ status: "done", creditsDeltaMicros: 110_001, ledgerDeltaMicros: 100_000, closedReserves: 0, tornLineMoved: false });
  fireEvent.click(screen.getByRole("button", { name: "Сверить" }));
  await screen.findByText("Расхождение $0.0100");
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
  expect(screen.getByRole("button", { name: "Сверить" }).className).toContain("btn-primary");

  fireEvent.click(screen.getByRole("button", { name: "Сверить" }));
  await screen.findByText(/Суммы сходятся/);
  await flush();
  expect(document.body.textContent).not.toContain("списание оказалось выше зарезервированного максимума");
  expect(document.body.textContent).not.toContain("Нужна сверка расходов");
  expect(screen.getByRole("button", { name: "Сверить" }).className).not.toContain("btn-primary");
});

test("after the reconcile the wizard can spend again", async () => {
  const { engine } = await openSettings();
  inAct(() => engine.haltAboveWorst());
  await flush();
  fireEvent.click(screen.getByRole("button", { name: "Сверить" }));
  await screen.findByText(/Суммы сходятся/);
  await flush();
  await openSection("Аватары");
  expect(document.body.textContent).not.toContain("Нужна сверка расходов");
});

// ---------- performance, models, folders ----------

test("network concurrency steps through the contract's range, 1 to 16", async () => {
  const { engine } = await openSettings();
  for (let i = 0; i < 3; i++) {
    fireEvent.click(screen.getByRole("button", { name: "Больше" }));
    await flush();
  }
  expect(callsOf(engine, "settings.setConcurrency").map((c) => c.payload.network)).toEqual([7, 8, 9]);
  expect(screen.getByText(/От 1 до 16/)).toBeDefined();
});

test("the stepper stops at both ends of the range", async () => {
  await openSettings(STORED, { concurrency: 16 });
  expect(screen.getByRole("button", { name: "Больше" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByRole("button", { name: "Меньше" }).hasAttribute("disabled")).toBe(false);
});

test("focus follows the key flow: into the field on «Заменить», back to «Заменить» after saving", async () => {
  await openSettings(STORED);
  fireEvent.click(screen.getByRole("button", { name: "Заменить" }));
  expect(focusedLabel()).toBe(describeElement(keyInput()));
  fireEvent.change(keyInput(), { target: { value: "sk-or-v1-focus-flow-5555" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить ключ" }));
  await screen.findByText("•••• 5555");
  expect(focusedLabel()).toBe(describeElement(screen.getByRole("button", { name: "Заменить" })));
});

test("models are shown read-only", async () => {
  await openSettings();
  expect(screen.getByText("x-ai/grok-imagine-image-2.0")).toBeDefined();
  expect(screen.getByText("x-ai/grok-4.3")).toBeDefined();
});

test("the library folder can be changed to an absolute path only", async () => {
  const { engine } = await openSettings();
  expect(screen.getByText("/Users/studio/Studio/library")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Изменить" }));
  const input = screen.getByLabelText("Библиотека");
  fireEvent.change(input, { target: { value: "relative/library" } });
  const form = input.closest("form");
  if (!form) throw new Error("library form missing");
  fireEvent.submit(form);
  expect(screen.getByText(/Нужен полный путь/)).toBeDefined();
  expect(callsOf(engine, "settings.setLibraryPath")).toHaveLength(0);

  fireEvent.change(input, { target: { value: "/Volumes/Data/Studio" } });
  fireEvent.submit(form);
  await screen.findByText("/Volumes/Data/Studio");
  expect(callsOf(engine, "settings.setLibraryPath").map((c) => c.payload.path)).toEqual(["/Volumes/Data/Studio"]);
});

test("an error link lands on the money card with focus", async () => {
  const { engine } = setup();
  await flush();
  inAct(() => engine.requireReconcile(["open-reserves"]));
  await flush();
  fireEvent.click(await screen.findByRole("button", { name: "Перейти к сверке" }));
  await flush();
  expect(focusedLabel()).toBe(describeElement(screen.getByRole("heading", { level: 2, name: "Деньги" })));
});
