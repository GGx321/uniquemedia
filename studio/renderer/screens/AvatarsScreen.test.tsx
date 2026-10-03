import { expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ENGINE_GONE_DETAIL, ERROR_MESSAGES_RU, IMPORT_FALLBACK_PRICE, type AvatarSummary, type Draft } from "../../shared/engine";
import { formatUsd } from "../lib/money";
import { DESCRIPTOR, MOCK_AGE_CHECK_PER_SLOT, MOCK_ESTIMATE, mockDescriptor } from "../engine/mockEngine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { callsOf, estimateText, flush, runAll, setup, inAct, tick } from "../testing";

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
    videoCount: 0,
    eligibleUnusedCount: 0,
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
  // «Все» by default, as on the mockup: the archived Nora is listed too, marked as such.
  expect(cardNames()).toEqual(["Mia", "Sofia", "Elena", "Ava", "Kira", "Nora"]);
  expect(callsOf(engine, "engine.snapshot")).toHaveLength(1);
  expect(callsOf(engine, "avatars.list")).toHaveLength(1);
  // Mia's own count is 8 (T8b, L7 demo data consistency): matches what her seeded photos.list actually lists.
  expect(screen.getByText(/5\s*аватаров · 350\s*фото/)).toBeDefined();

  const mia = screen.getByRole("article", { name: "Mia" });
  expect(within(mia).getByText("8 фото")).toBeDefined();
  expect(within(mia).queryByText("В архиве") === null).toBe(true);
  expect(within(mia).getByRole("img", { name: "Мастер-портрет: Mia" })).toBeDefined();
  expect(within(screen.getByRole("article", { name: "Nora" })).getByText("В архиве")).toBeDefined();
});

test("the search narrows the grid by name", async () => {
  setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  fireEvent.change(screen.getByRole("searchbox", { name: "Поиск" }), { target: { value: "  so " } });
  expect(cardNames()).toEqual(["Sofia"]);
  fireEvent.change(screen.getByRole("searchbox", { name: "Поиск" }), { target: { value: "" } });
  expect(cardNames()).toContain("Mia");
});

test("the archive filter shows archived avatars only; «Активные» leaves them out", async () => {
  setup({ preset: "demo" });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  expect(screen.getByRole("radio", { name: "Все", checked: true })).toBeDefined();

  fireEvent.click(screen.getByRole("radio", { name: "Архив" }));
  expect(cardNames()).toEqual(["Nora"]);
  expect(screen.getByText("В архиве")).toBeDefined();
  // The dashed «Новый аватар» / «Импортировать аватара» tiles belong with the working avatars, not the archive.
  expect(document.querySelector(".new-tile") === null).toBe(true);

  fireEvent.click(screen.getByRole("radio", { name: "Активные" }));
  expect(cardNames()).toEqual(["Mia", "Sofia", "Elena", "Ava", "Kira"]);
  expect(document.querySelectorAll(".new-tile")).toHaveLength(2);
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
    hiddenBelowThreshold: 0,
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
  expect(screen.queryByRole("article", { name: "Черновик" }) === null).toBe(true);
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

// M5 follow-up: an ordinary offline (above) still offers a retry that can
// actually work; a dead-for-good engine must not — "Повторить" would just
// fail the same way forever, so it says so instead and offers no button.
test("an engine dead for good shows a distinct message and no retry", async () => {
  const { engine } = setup({ preset: "demo" });
  engine.failNext("engine.snapshot", { code: "INTERNAL", detail: ENGINE_GONE_DETAIL });
  expect(await screen.findByText("Движок не отвечает")).toBeDefined();
  expect(screen.getByText(/остановился и не будет перезапущен/)).toBeDefined();
  expect(screen.queryByText("Внутренняя ошибка движка.") === null).toBe(true);
  expect(screen.queryByRole("button", { name: "Повторить" }) === null).toBe(true);
});

// ---------- unreadable avatars: tiles, reasons and the rewrite recovery (T8a) ----------

test("unreadable tiles show a clear Russian reason per code, never the raw detail text, and none offer a rewrite", async () => {
  setup({
    unreadableAvatars: [
      { avatarId: "avatar-broken-0001", name: null, reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" },
      { avatarId: null, name: "Vera", reason: "contract-mismatch", detail: "its stored record no longer fits the contract" },
    ],
  });
  await screen.findByText("Vera");
  expect(screen.getByText("Без имени")).toBeDefined();
  expect(screen.getByText(/файл записи не читается/)).toBeDefined();
  expect(screen.getByText(/в старом формате — эта версия Studio её не читает/)).toBeDefined();
  expect(screen.getByRole("img", { name: "Не читается: файл повреждён" })).toBeDefined();
  expect(document.body.textContent).not.toContain("its manifest file could not be read or parsed");
  expect(document.body.textContent).not.toContain("its stored record no longer fits the contract");
  expect(screen.queryByRole("button", { name: /Переписать описание/ }) === null).toBe(true);
});

test("an unreadable card shows the avatar's name when the engine still has one, and a neutral fallback when it does not", async () => {
  setup({
    unreadableAvatars: [
      { avatarId: "avatar-broken-0010", name: "Nora", reason: "contract-mismatch", detail: "its stored record no longer fits the contract" },
      { avatarId: "avatar-broken-0011", name: null, reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" },
    ],
  });
  expect(await screen.findByRole("heading", { level: 2, name: "Nora" })).toBeDefined();
  expect(screen.getByRole("heading", { level: 2, name: "Без имени" })).toBeDefined();
});

test("unreadableTotal beyond the shown list says how many more there are", async () => {
  setup({
    unreadableAvatars: [{ avatarId: "avatar-broken-0001", name: null, reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" }],
    unreadableTotal: 5,
  });
  await screen.findByText("Без имени");
  // Russian plurals: 4 falls in the "few" form ("записи"), not "записей".
  expect(screen.getByText("Ещё 4 записи не читаются.")).toBeDefined();
});

test("a library with only unreadable records is not shown as the empty state", async () => {
  setup({
    unreadableAvatars: [{ avatarId: "avatar-broken-0001", name: "Vera", reason: "contract-mismatch", detail: "its stored record no longer fits the contract" }],
  });
  await screen.findByText("Vera");
  expect(screen.queryByText("Библиотека пуста") === null).toBe(true);
});

// The rewrite recovery is one button that carries its price: the free
// estimate is asked for as soon as the tile is shown, and a click accepts
// exactly the worst case written on it («Переписать описание · до $X»).
const REWRITE_LINE = "описание не проходит текущую проверку";

test("the rewrite recovery prices itself up front, sends nothing paid until the click, then sends exactly the shown worst case", async () => {
  const { engine } = setup();
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0001", name: "Zoe", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Zoe", traits: DEFAULT_TRAITS },
  );
  await screen.findByText(REWRITE_LINE);

  const button = await screen.findByRole("button", { name: "Переписать описание · до $0.01" });
  expect(callsOf(engine, "avatars.estimateRewriteDescriptor").map((c) => c.payload)).toEqual([{ avatarId: "avatar-broken-0001" }]);
  expect(callsOf(engine, "avatars.rewriteDescriptor")).toHaveLength(0);
  fireEvent.click(button);

  await screen.findByRole("heading", { level: 2, name: "Zoe" });
  expect(screen.queryByText(REWRITE_LINE) === null).toBe(true);
  expect(callsOf(engine, "avatars.estimateRewriteDescriptor")).toHaveLength(1);
  expect(callsOf(engine, "avatars.rewriteDescriptor")[0]?.payload).toEqual({
    avatarId: "avatar-broken-0001",
    acceptedWorstMicros: DESCRIPTOR.worst,
  });
});

test("a failed up-front price leaves a plain «Переписать описание» that only asks for the price, never spends", async () => {
  const { engine } = setup();
  engine.failNext("avatars.estimateRewriteDescriptor", { code: "NETWORK" });
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0006", name: "Lia", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Lia", traits: DEFAULT_TRAITS },
  );
  await screen.findByText(ERROR_MESSAGES_RU.NETWORK);

  fireEvent.click(screen.getByRole("button", { name: "Переписать описание" }));
  // Asking again is busy and closed to clicks too, until the price is back.
  const asking = screen.getByRole("button", { name: "Считаем…" });
  expect(asking.hasAttribute("disabled")).toBe(true);
  expect(asking.getAttribute("aria-busy")).toBe("true");
  await screen.findByRole("button", { name: "Переписать описание · до $0.01" });
  expect(callsOf(engine, "avatars.estimateRewriteDescriptor")).toHaveLength(2);
  expect(callsOf(engine, "avatars.rewriteDescriptor")).toHaveLength(0);
});

test("a price rise on the rewrite is confirmed at the new price, and exactly that new worst case is sent", async () => {
  const { engine } = setup();
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0007", name: "Rita", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Rita", traits: DEFAULT_TRAITS },
  );
  const button = await screen.findByRole("button", { name: "Переписать описание · до $0.01" });

  // The engine's price moves after the tile showed its own: the click carries the old, lower worst case.
  engine.setRewritePrice({ expectedMicros: 20_000, worstMicros: 25_000 });
  fireEvent.click(button);
  await screen.findByText("Цена выросла");
  expect(callsOf(engine, "avatars.rewriteDescriptor").map((c) => c.payload.acceptedWorstMicros)).toEqual([DESCRIPTOR.worst]);

  fireEvent.click(screen.getByRole("button", { name: "Подтвердить новую цену · до $0.03" }));
  await screen.findByRole("heading", { level: 2, name: "Rita" });
  expect(callsOf(engine, "avatars.rewriteDescriptor").map((c) => c.payload.acceptedWorstMicros)).toEqual([DESCRIPTOR.worst, 25_000]);
});

test("a failed re-estimate after PRICE_CHANGED drops the refused price: the button only asks for a new one", async () => {
  const { engine } = setup();
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0008", name: "Tina", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Tina", traits: DEFAULT_TRAITS },
  );
  const button = await screen.findByRole("button", { name: "Переписать описание · до $0.01" });

  engine.failNext("avatars.rewriteDescriptor", { code: "PRICE_CHANGED" });
  engine.failNext("avatars.estimateRewriteDescriptor", { code: "NETWORK" });
  fireEvent.click(button);
  await screen.findByText(ERROR_MESSAGES_RU.NETWORK);

  expect(screen.queryByRole("button", { name: /^(Переписать описание|Подтвердить новую цену) · до/ }) === null).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Переписать описание" }));
  await screen.findByRole("button", { name: "Переписать описание · до $0.01" });
  expect(callsOf(engine, "avatars.rewriteDescriptor")).toHaveLength(1);
});

test("a search while a rewrite is on its way keeps its tile busy, so the paid call cannot be sent twice", async () => {
  const { engine, scheduler } = setup({ preset: "demo" });
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0009", name: "Yana", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Yana", traits: DEFAULT_TRAITS },
  );
  const button = await screen.findByRole("button", { name: "Переписать описание · до $0.01" });
  engine.delayNext("avatars.rewriteDescriptor", 50);
  fireEvent.click(button);
  await flush();

  const search = screen.getByRole("searchbox", { name: "Поиск" });
  fireEvent.change(search, { target: { value: "Mia" } });
  expect(screen.queryByRole("heading", { level: 2, name: "Yana" }) === null).toBe(true);
  fireEvent.change(search, { target: { value: "" } });

  const again = screen.getByRole("button", { name: /Переписываем…/ });
  expect(again === button).toBe(true);
  expect(again.hasAttribute("disabled")).toBe(true);
  fireEvent.click(again);
  await flush();
  expect(callsOf(engine, "avatars.rewriteDescriptor")).toHaveLength(1);
  expect(callsOf(engine, "avatars.estimateRewriteDescriptor")).toHaveLength(1);

  tick(scheduler, 1);
  await screen.findByRole("heading", { level: 2, name: "Yana" });
});

test("a filter change while a rewrite is on its way keeps its tile busy, so the paid call cannot be sent twice", async () => {
  const { engine, scheduler } = setup({ preset: "demo" });
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0012", name: "Yara", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Yara", traits: DEFAULT_TRAITS },
  );
  const button = await screen.findByRole("button", { name: "Переписать описание · до $0.01" });
  engine.delayNext("avatars.rewriteDescriptor", 50);
  fireEvent.click(button);
  await flush();

  // Unlike a search query, «Активные»/«Все» carry no status for an unreadable
  // record (it has none to filter on) — the to-do stays listed on both, so the
  // busy tile must still be the very same node, not a fresh remount, at every step.
  fireEvent.click(screen.getByRole("radio", { name: "Активные" }));
  expect(screen.getByRole("button", { name: /Переписываем…/ }) === button).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Все" }));

  // «Архив» is the only filter that hides the tile at all (via `hidden`, not
  // an unmount): switching to it and back must still be the same node.
  fireEvent.click(screen.getByRole("radio", { name: "Архив" }));
  expect(screen.queryByRole("button", { name: /Переписываем…/ }) === null).toBe(true);
  fireEvent.click(screen.getByRole("radio", { name: "Все" }));

  const again = screen.getByRole("button", { name: /Переписываем…/ });
  expect(again === button).toBe(true);
  expect(again.hasAttribute("disabled")).toBe(true);
  fireEvent.click(again);
  await flush();
  expect(callsOf(engine, "avatars.rewriteDescriptor")).toHaveLength(1);
  expect(callsOf(engine, "avatars.estimateRewriteDescriptor")).toHaveLength(1);

  tick(scheduler, 1);
  await screen.findByRole("heading", { level: 2, name: "Yara" });
});

test("PRICE_CHANGED on the rewrite re-estimates and asks again before spending", async () => {
  const { engine } = setup();
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0002", name: "Nora", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Nora", traits: DEFAULT_TRAITS },
  );
  const button = await screen.findByRole("button", { name: "Переписать описание · до $0.01" });

  engine.failNext("avatars.rewriteDescriptor", { code: "PRICE_CHANGED" });
  fireEvent.click(button);

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
    { avatarId: "avatar-broken-0005", name: "Vika", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Vika", traits: DEFAULT_TRAITS },
  );
  const confirmButton = await screen.findByRole("button", { name: "Переписать описание · до $0.01" });

  engine.failNext("avatars.rewriteDescriptor", { code: "PRICE_CHANGED" });
  engine.delayNext("avatars.estimateRewriteDescriptor", 30);
  fireEvent.click(confirmButton);
  await flush();

  // The rewrite was refused and the re-estimate it triggered is still on its way (delayed): stays busy.
  expect(callsOf(engine, "avatars.rewriteDescriptor")).toHaveLength(1);
  expect(callsOf(engine, "avatars.estimateRewriteDescriptor")).toHaveLength(2);
  expect(confirmButton.hasAttribute("disabled")).toBe(true);
  expect(confirmButton.getAttribute("aria-busy")).toBe("true");

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
    { avatarId: "avatar-broken-0003", name: "Mia", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Mia", traits: DEFAULT_TRAITS },
  );
  // Answer only until the tile is on screen: its up-front estimate is then sent and still unanswered.
  for (let i = 0; i < 10 && screen.queryByText(REWRITE_LINE) === null; i++) {
    runAll(scheduler);
    await flush();
  }
  const button = screen.getByRole("button", { name: "Считаем…" });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(button.getAttribute("aria-busy")).toBe("true");

  await answerAll(scheduler);
  await waitFor(() => expect(screen.getByRole("button", { name: "Переписать описание · до $0.01" }).hasAttribute("disabled")).toBe(false));

  const confirmButton = screen.getByRole("button", { name: "Переписать описание · до $0.01" });
  fireEvent.click(confirmButton);
  expect(confirmButton.hasAttribute("disabled")).toBe(true);
  expect(callsOf(engine, "avatars.rewriteDescriptor")).toHaveLength(1);
});

test("an unrewritable descriptor-invalid tile says so plainly and hides the rewrite button", async () => {
  // Seeded without a recoverTo: the mock's own rewriteRefusal answers
  // VALIDATION, exactly like a record isRewritable rejects for real (a name
  // over 60 chars, untyped traits, ...) although its reason is still
  // descriptor-invalid in the snapshot.
  const { engine } = setup();
  engine.seedUnreadable({ avatarId: "avatar-broken-0013", name: "Nadia", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" });

  await screen.findByText("Эту запись переписать нельзя");
  expect(screen.queryByRole("button", { name: /Переписать описание/ }) === null).toBe(true);
});

test("the rewrite button stays disabled while paid calls are halted, with the reason shown", async () => {
  const { engine } = setup({ money: { halt: { cause: "SETTLE_ABOVE_WORST", detail: "billed above", attemptIds: ["slot-1#1"] } } });
  engine.seedUnreadable(
    { avatarId: "avatar-broken-0004", name: "Ava", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" },
    { status: "active", name: "Ava", traits: DEFAULT_TRAITS },
  );
  const button = await screen.findByRole("button", { name: "Переписать описание · до $0.01" });
  expect(button.hasAttribute("disabled")).toBe(true);
  expect(screen.getByText("Платные запросы остановлены до сверки расходов.")).toBeDefined();
  fireEvent.click(button);
  await flush();
  expect(callsOf(engine, "avatars.rewriteDescriptor")).toHaveLength(0);
});

// L8: the import tile's price text is built from IMPORT_FALLBACK_PRICE
// (shared with plan.test.ts and the mock's own spend), never a hand-typed
// string that could silently drift from the real numbers. «≈», not «до»: this
// is only the dated fallback table (used when OpenRouter did not answer), and
// «до» means a hard cap everywhere else in the app — the live price can be
// higher — so it shows a range from the expected price to the worst case, not
// the worst case alone (which would overstate the approximate cost).
test("the import tile's price text is derived from IMPORT_FALLBACK_PRICE, not a hard-coded string, and is approximate", async () => {
  // Pinned to the fallback table's own numbers, and the rendered text is a
  // literal, not computed with formatUsdRange itself — a bug in that
  // function must still be caught here, not just agree with itself.
  expect(IMPORT_FALLBACK_PRICE.whole).toEqual({ expectedMicros: 5_535, worstMicros: 37_750 });
  setup({ preset: "demo" });
  const tile = await screen.findByRole("button", { name: /Импортировать аватара/ });
  expect(within(tile).getByText("1 фото · ≈ $0.01–0.04")).toBeDefined();
});

test("the new-avatar tile's «до $X» is the engine's own free estimate, never a spend", async () => {
  const { engine } = setup({ preset: "demo", imageAgeCheck: "on" });
  const tile = await screen.findByRole("button", { name: /^Новый аватар 4/ });
  await waitFor(() => expect(within(tile).getByText(`4 портрета · до ${formatUsd(MOCK_ESTIMATE.worstMicros, 2, "up")}`)).toBeDefined());
  expect(callsOf(engine, "avatars.estimate")).toHaveLength(1);
  expect(callsOf(engine, "avatars.createDraft")).toHaveLength(0);

  // Switching filters does not ask again; the price stays with the tile.
  fireEvent.click(screen.getByRole("radio", { name: "Архив" }));
  fireEvent.click(screen.getByRole("radio", { name: "Все" }));
  await flush();
  expect(callsOf(engine, "avatars.estimate")).toHaveLength(1);

  // The tile's price never reaches the wizard: a new avatar starts unpriced, behind its own «Оценить стоимость».
  fireEvent.click(screen.getByRole("button", { name: /^Новый аватар 4/ }));
  await screen.findByRole("heading", { level: 1, name: "Новый аватар" });
  expect(estimateText()).toBeNull();
  expect(screen.getByRole("button", { name: "Оценить стоимость" })).toBeDefined();
  expect(screen.queryByRole("button", { name: /Сгенерировать/ }) === null).toBe(true);
});

test("the new-avatar tile's price re-estimates when the age-check toggle changes, even without leaving the screen", async () => {
  const { engine, client } = setup({ preset: "demo", imageAgeCheck: "on" });
  const tile = await screen.findByRole("button", { name: /^Новый аватар 4/ });
  await waitFor(() => expect(within(tile).getByText(`4 портрета · до ${formatUsd(MOCK_ESTIMATE.worstMicros, 2, "up")}`)).toBeDefined());
  expect(callsOf(engine, "avatars.estimate")).toHaveLength(1);

  // Toggled directly through the engine, as Настройки's own switch would —
  // the settings.changed event alone must invalidate the tile's cached price.
  void client.request("settings.setImageAgeCheck", { imageAgeCheck: "off" });
  await flush();

  await waitFor(() => expect(callsOf(engine, "avatars.estimate")).toHaveLength(2));
  const worstOff = MOCK_ESTIMATE.worstMicros - 4 * MOCK_AGE_CHECK_PER_SLOT.worst;
  await waitFor(() => expect(within(tile).getByText(`4 портрета · до ${formatUsd(worstOff, 2, "up")}`)).toBeDefined());
});
