import { expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { AvatarSummary, Draft } from "../../shared/engine";
import { DESCRIPTOR, MOCK_ESTIMATE, mockDescriptor } from "../engine/mockEngine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { callsOf, flush, runAll, setup, inAct, tick } from "../testing";

/** Flushes every latent response, including the ones a resolved one triggers in turn (settings, money, avatars.list). */
async function answerAll(scheduler: Parameters<typeof runAll>[0]): Promise<void> {
  for (let i = 0; i < 6; i++) {
    runAll(scheduler);
    await flush();
  }
}

function zoe(): AvatarSummary {
  return {
    avatarId: "avatar-zoe-0001",
    name: "Zoe",
    descriptor: mockDescriptor(DEFAULT_TRAITS),
    masterPhotoId: "photo-zoe-0001",
    createdAt: "2026-09-24T09:00:00.000Z",
    status: "active",
    photoCount: 3,
  };
}

function cardNames(): string[] {
  return screen.queryAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "");
}

test("a fresh library shows the empty state with a way to start", async () => {
  setup();
  expect(await screen.findByText("Библиотека пуста")).toBeDefined();
  expect(screen.getByRole("button", { name: /Создать первый аватар/ })).toBeDefined();
});

test("without a key the empty state also points to Settings", async () => {
  setup({ apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
  expect(await screen.findByRole("button", { name: "Сначала добавить ключ OpenRouter" })).toBeDefined();
  expect(screen.getByText("Добавьте ключ OpenRouter")).toBeDefined();
});

test("the grid comes from engine.snapshot and is refreshed with avatars.list", async () => {
  const { engine } = setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  await flush();
  expect(cardNames()).toEqual(["Mia", "Sofia", "Elena", "Ava", "Kira"]);
  expect(callsOf(engine, "engine.snapshot")).toHaveLength(1);
  expect(callsOf(engine, "avatars.list")).toHaveLength(1);
  expect(screen.getByText(/5\s*аватаров · 466 фото/)).toBeDefined();

  const mia = screen.getByRole("article", { name: "Mia" });
  expect(within(mia).getByText("124 фото")).toBeDefined();
  expect(within(mia).getByText("Активен")).toBeDefined();
  expect(within(mia).getByRole("img", { name: "Мастер-портрет: Mia" })).toBeDefined();
});

test("the archive filter shows archived avatars only", async () => {
  setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  fireEvent.click(screen.getByRole("radio", { name: "Архив · 1" }));
  expect(cardNames()).toEqual(["Nora"]);
  expect(screen.getByText("В архиве")).toBeDefined();
  expect(screen.queryByRole("button", { name: /Новый аватар/ })).toBeNull();
  fireEvent.click(screen.getByRole("radio", { name: "Активные · 5" }));
  expect(cardNames()).toContain("Mia");
});

test("a seq hole is caught up through engine.events", async () => {
  const { engine } = setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  engine.setDelivery(false);
  inAct(() => engine.touchMoney());
  engine.setDelivery(true);
  inAct(() => engine.touchMoney());
  await flush();
  expect(callsOf(engine, "engine.events")).toHaveLength(1);
  expect(callsOf(engine, "engine.snapshot")).toHaveLength(1);
});

test("a gap refetches the snapshot and shows what changed meanwhile", async () => {
  const { engine } = setup({ preset: "demo", eventCapacity: 2 });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  engine.setDelivery(false);
  engine.addAvatarSilently(zoe());
  inAct(() => engine.touchMoney());
  inAct(() => engine.touchMoney());
  inAct(() => engine.touchMoney());
  engine.setDelivery(true);
  inAct(() => engine.touchMoney());
  expect(await screen.findByRole("heading", { level: 2, name: "Zoe" })).toBeDefined();
  expect(callsOf(engine, "engine.snapshot")).toHaveLength(2);
});

test("a new bootId (engine restart) refetches the snapshot", async () => {
  const { engine } = setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  engine.addAvatarSilently(zoe());
  inAct(() => engine.restart());
  expect(await screen.findByRole("heading", { level: 2, name: "Zoe" })).toBeDefined();
  expect(callsOf(engine, "engine.snapshot")).toHaveLength(2);
});

test("returning to the window catches up via engine.events", async () => {
  const { engine } = setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  document.dispatchEvent(new Event("visibilitychange"));
  await flush();
  expect(callsOf(engine, "engine.events").length).toBeGreaterThanOrEqual(1);
});

test("a draft from the snapshot is listed and reopens the wizard with its candidates", async () => {
  const draft: Draft = {
    avatarId: "avatar-draft-0001",
    traits: DEFAULT_TRAITS,
    descriptor: mockDescriptor(DEFAULT_TRAITS),
    candidates: ["a", "b", "c", "d"].map((x) => ({ avatarId: "avatar-draft-0001", photoId: `photo-draft-000${x}` })),
    estimate: { ...MOCK_ESTIMATE },
  };
  const { engine } = setup({ drafts: [draft] });
  const card = await screen.findByRole("article", { name: "Черновик" });
  expect(within(card).getByText(/4\s*варианта — выберите/)).toBeDefined();

  fireEvent.click(within(card).getByRole("button", { name: "Продолжить" }));
  await screen.findByRole("heading", { level: 1, name: "Новый аватар" });
  expect(screen.getAllByRole("radio", { name: /^Вариант [A-D]$/ })).toHaveLength(4);
  expect(screen.getByText("зафиксирована в черновике")).toBeDefined();
  expect(screen.getByText(draft.descriptor.text)).toBeDefined();

  fireEvent.click(screen.getByRole("radio", { name: "Вариант C" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Имя/ }), { target: { value: "Lena" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  await screen.findByRole("heading", { level: 2, name: "Lena" });
  expect(callsOf(engine, "avatars.pick")[0]?.payload).toEqual({ avatarId: draft.avatarId, photoId: "photo-draft-000c", name: "Lena" });
  expect(screen.queryByRole("article", { name: "Черновик" })).toBeNull();
});

test("an engine that does not answer shows a retry", async () => {
  const { engine } = setup({ preset: "demo" });
  // The snapshot request is in flight but not yet answered: make its answer an error.
  engine.failNext("engine.snapshot", { code: "INTERNAL" });
  expect(await screen.findByText("Движок не отвечает")).toBeDefined();
  expect(screen.getByText("Внутренняя ошибка движка.")).toBeDefined();
  fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
  expect(await screen.findByRole("heading", { level: 2, name: "Mia" })).toBeDefined();
});

// ---------- unreadable avatars: tiles, reasons and the rewrite recovery (T8a) ----------

test("unreadable tiles show a clear Russian reason per code, never the raw detail text, and none offer a rewrite", async () => {
  setup({
    unreadableAvatars: [
      { avatarId: "avatar-broken-0001", reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" },
      { avatarId: null, reason: "contract-mismatch", detail: "its stored record no longer fits the contract" },
    ],
  });
  await screen.findAllByText("Не читается");
  expect(screen.getAllByText("Не читается")).toHaveLength(2);
  expect(screen.getByText(/Файл записи не удалось прочитать или разобрать/)).toBeDefined();
  expect(screen.getByText(/формате, который сегодняшняя версия Studio больше не читает/)).toBeDefined();
  expect(document.body.textContent).not.toContain("its manifest file could not be read or parsed");
  expect(document.body.textContent).not.toContain("its stored record no longer fits the contract");
  expect(screen.queryByRole("button", { name: "Переписать описание" })).toBeNull();
});

test("unreadableTotal beyond the shown list says how many more there are", async () => {
  setup({
    unreadableAvatars: [{ avatarId: "avatar-broken-0001", reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" }],
    unreadableTotal: 5,
  });
  await screen.findByText("Не читается");
  // Russian plurals: 4 falls in the "few" form ("записи"), not "записей".
  expect(screen.getByText("Ещё 4 записи не читаются.")).toBeDefined();
});

test("a library with only unreadable records is not shown as the empty state", async () => {
  setup({
    unreadableAvatars: [{ avatarId: "avatar-broken-0001", reason: "contract-mismatch", detail: "its stored record no longer fits the contract" }],
  });
  await screen.findByText("Не читается");
  expect(screen.queryByText("Библиотека пуста")).toBeNull();
});

test("the rewrite recovery estimates, then sends exactly that estimate's worst case, and the tile disappears on success", async () => {
  const { engine } = setup();
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0001", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Zoe", traits: DEFAULT_TRAITS },
  );
  await screen.findByText("Не читается");

  fireEvent.click(screen.getByRole("button", { name: "Переписать описание" }));
  await screen.findByText("≈ $0.00, не больше $0.01");
  fireEvent.click(screen.getByRole("button", { name: "Переписать · до $0.01" }));

  await screen.findByRole("heading", { level: 2, name: "Zoe" });
  expect(screen.queryByText("Не читается")).toBeNull();
  expect(callsOf(engine, "avatars.estimateRewriteDescriptor").map((c) => c.payload)).toEqual([{ avatarId: "avatar-broken-0001" }]);
  expect(callsOf(engine, "avatars.rewriteDescriptor")[0]?.payload).toEqual({
    avatarId: "avatar-broken-0001",
    acceptedWorstMicros: DESCRIPTOR.worst,
  });
});

test("PRICE_CHANGED on the rewrite re-estimates and asks again before spending", async () => {
  const { engine } = setup();
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0002", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Nora", traits: DEFAULT_TRAITS },
  );
  await screen.findByText("Не читается");
  fireEvent.click(screen.getByRole("button", { name: "Переписать описание" }));
  await screen.findByText("≈ $0.00, не больше $0.01");

  engine.failNext("avatars.rewriteDescriptor", { code: "PRICE_CHANGED" });
  fireEvent.click(screen.getByRole("button", { name: "Переписать · до $0.01" }));

  await screen.findByText("Цена выросла");
  expect(callsOf(engine, "avatars.rewriteDescriptor")).toHaveLength(1);
  expect(callsOf(engine, "avatars.estimateRewriteDescriptor")).toHaveLength(2);

  fireEvent.click(screen.getByRole("button", { name: "Подтвердить новую цену · до $0.01" }));
  await screen.findByRole("heading", { level: 2, name: "Nora" });
  expect(callsOf(engine, "avatars.rewriteDescriptor")).toHaveLength(2);
});

test("confirmRewrite stays busy through a PRICE_CHANGED re-estimate, so a click while it is still in flight sends nothing", async () => {
  const { engine, scheduler } = setup();
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0005", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Vika", traits: DEFAULT_TRAITS },
  );
  await screen.findByText("Не читается");
  fireEvent.click(screen.getByRole("button", { name: "Переписать описание" }));
  await screen.findByText("≈ $0.00, не больше $0.01");

  engine.failNext("avatars.rewriteDescriptor", { code: "PRICE_CHANGED" });
  engine.delayNext("avatars.estimateRewriteDescriptor", 30);
  const confirmButton = screen.getByRole("button", { name: "Переписать · до $0.01" });
  fireEvent.click(confirmButton);
  await flush();

  // The rewrite was refused and the re-estimate it triggered is still on its way (delayed): stays busy.
  expect(callsOf(engine, "avatars.rewriteDescriptor")).toHaveLength(1);
  expect(callsOf(engine, "avatars.estimateRewriteDescriptor")).toHaveLength(2);
  expect(confirmButton.hasAttribute("disabled")).toBe(true);

  // A click while still disabled must not resend the stale, already-rejected worst case.
  fireEvent.click(confirmButton);
  await flush();
  expect(callsOf(engine, "avatars.rewriteDescriptor")).toHaveLength(1);

  tick(scheduler, 1); // the delayed re-estimate arrives
  await flush();
  await screen.findByText("Цена выросла");
  expect(screen.getByRole("button", { name: "Подтвердить новую цену · до $0.01" }).hasAttribute("disabled")).toBe(false);
});

test("the rewrite button disables while its own command is in flight, both while estimating and while rewriting", async () => {
  const { engine, scheduler } = setup({ latencyMs: 20 });
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0003", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Mia", traits: DEFAULT_TRAITS },
  );
  await answerAll(scheduler);
  await screen.findByText("Не читается");

  const startButton = screen.getByRole("button", { name: "Переписать описание" });
  fireEvent.click(startButton);
  expect(startButton.hasAttribute("disabled")).toBe(true);
  await answerAll(scheduler);
  await waitFor(() => expect(screen.getByRole("button", { name: /Переписать · до/ }).hasAttribute("disabled")).toBe(false));

  const confirmButton = screen.getByRole("button", { name: /Переписать · до/ });
  fireEvent.click(confirmButton);
  expect(confirmButton.hasAttribute("disabled")).toBe(true);
});

test("the rewrite button stays disabled while paid calls are halted, with the reason shown", async () => {
  const { engine } = setup({ money: { halt: { cause: "SETTLE_ABOVE_WORST", detail: "billed above", attemptIds: ["slot-1#1"] } } });
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0004", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Ava", traits: DEFAULT_TRAITS },
  );
  await screen.findByText("Не читается");
  expect(screen.getByRole("button", { name: "Переписать описание" }).hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Платные запросы остановлены до сверки расходов.")).toBeDefined();
});
