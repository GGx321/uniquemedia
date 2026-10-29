import { expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ERROR_MESSAGES_RU, type Draft } from "../../shared/engine";
import { formatUsd } from "../lib/money";
import { DESCRIPTOR, MOCK_CANDIDATE_AGE_CHECK, MOCK_ESTIMATE, mockDescriptor } from "../engine/mockEngine";
import { DEFAULT_TRAITS } from "../lib/traits";
import { callsOf, estimateText, flush, runAll, setup, tick } from "../testing";

/** Flushes every latent response, including the ones a resolved one triggers in turn (settings, money, avatars.list). */
async function answerAll(scheduler: Parameters<typeof runAll>[0]): Promise<void> {
  for (let i = 0; i < 6; i++) {
    runAll(scheduler);
    await flush();
  }
}


function cardNames(): string[] {
  return screen.queryAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "");
}

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
  // The tile's counts (3e.2): its photos and its video records, the latter opening the avatar's «Видео» tab.
  expect(mia.querySelector(".avatar-counts")?.textContent).toBe("8\u00a0фото · 0\u00a0видео");
  expect(within(mia).getByRole("button", { name: "Видео аватара Mia: 0" })).toBeDefined();
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
  // S5.2d re-pin: the head holds the «Лицо и волосы» | «Тело» tabs now; the lock is said under the form, as the mockup's 03 does.
  expect(screen.getByText(/^Внешность и тело зафиксированы в черновике\./)).toBeDefined();
  expect(screen.getByText(draft.descriptor.text)).toBeDefined();

  fireEvent.click(screen.getByRole("radio", { name: "Вариант C" }));
  fireEvent.change(screen.getByRole("textbox", { name: /Имя/ }), { target: { value: "Lena" } });
  fireEvent.click(screen.getByRole("button", { name: "Сохранить" }));
  // S5.0d re-pin: «Сохранить» ends on the new avatar's «Внешность»; the grid, opened again, lists her and no longer the draft.
  await screen.findByRole("heading", { level: 1, name: "Lena" });
  expect(callsOf(engine, "avatars.pick")[0]?.payload).toEqual({ avatarId: draft.avatarId, photoId: "photo-draft-000c", name: "Lena" });
  fireEvent.click(screen.getByRole("button", { name: "Аватары" }));
  await screen.findByRole("heading", { level: 2, name: "Lena" });
  expect(screen.queryByRole("article", { name: "Черновик" }) === null).toBe(true);
});

// M5 follow-up: an ordinary offline (above) still offers a retry that can
// actually work; a dead-for-good engine must not — "Повторить" would just
// fail the same way forever, so it says so instead and offers no button.

// ---------- unreadable avatars: tiles, reasons and the rewrite recovery (T8a) ----------

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
  // S5.0d (plan §5.5): the known limit, beside the button — the rewrite brings the hair back to the nearest of the six stored colours.
  expect(screen.getByText("Цвет волос вернётся к ближайшему из шести — после этого проверьте описание").className).toBe("field-hint");
  fireEvent.click(button);

  await screen.findByRole("heading", { level: 2, name: "Zoe" });
  expect(screen.queryByText(REWRITE_LINE) === null).toBe(true);
  expect(callsOf(engine, "avatars.estimateRewriteDescriptor")).toHaveLength(1);
  expect(callsOf(engine, "avatars.rewriteDescriptor")[0]?.payload).toEqual({
    avatarId: "avatar-broken-0001",
    acceptedWorstMicros: DESCRIPTOR.worst,
  });
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

// S5.3d (mockup 14a): the import also starts five reference portraits, so the tile says their own engine price beside the import's — never the sum.
test("the import tile says the portraits' own engine price beside the import's, never their sum", async () => {
  const { engine } = setup({ preset: "demo" });
  const tile = await screen.findByRole("button", { name: /Импортировать аватара/ });
  await waitFor(() => expect(tile.textContent).toBe("Импортировать аватара1 фото · ≈ $0.007–0.063 · портреты до $0.30"));
  expect(callsOf(engine, "avatars.estimatePortraits").map((c) => c.payload)).toEqual([{}]);
});

test("the portraits price is asked again when the age check moves it", async () => {
  const { engine, client } = setup({ preset: "demo" });
  const tile = await screen.findByRole("button", { name: /Импортировать аватара/ });
  await waitFor(() => expect(tile.textContent).toContain("портреты до $0.30"));
  await act(async () => {
    await client.request("settings.setImageAgeCheck", { imageAgeCheck: "on" });
  });
  await waitFor(() => expect(tile.textContent).toContain("портреты до $0.33"));
  expect(callsOf(engine, "avatars.estimatePortraits")).toHaveLength(2);
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
  const worstOff = MOCK_ESTIMATE.worstMicros - 4 * MOCK_CANDIDATE_AGE_CHECK.worst;
  await waitFor(() => expect(within(tile).getByText(`4 портрета · до ${formatUsd(worstOff, 2, "up")}`)).toBeDefined());
});
