import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { CATEGORY_REASONS_RU } from "../../shared/engine";
import { callsOf, describeElement, flush, inAct, openSection, runAll, withText } from "../testing";
import { category, chipsGroup, MONO, openPhotos, PARIS, WINTER } from "./photos/categoryScreenKit";
import { REVEALING_NOTE } from "./photos/revealingNote";

// CS.3 (phase 1 of custom categories): the category row of the generate card and the «Новая категория» dialog, against the mock engine.
// The artboards are CatChips, CatCreate, CatCreateBusy, CatCreateDone, CatCreateRejected, CatCreatePrice and the CategoryStates sheet
// (.omc/stage3/design/custom-categories). The paid button follows the app's rules: its price on it, keyed to the exact request and the
// text model the pool call runs on; PRICE_CHANGED asks for a new click; never sent twice; disabled with paidBlockedReason while blocked.

const BUILT_INS = ["Дом", "Виды", "Улица", "Гламур", "Фитнес"];

function chipNames(): string[] {
  return within(chipsGroup())
    .getAllByRole("button")
    // The chips kept for «Смелая» are disabled buttons (not choices of the row).
    .filter((b) => !(b as HTMLButtonElement).disabled)
    .map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");
}

function addChip(): HTMLElement {
  return within(chipsGroup()).getByRole("button", { name: "Своя" });
}

function dialog(): HTMLElement {
  return screen.getByRole("dialog", { name: "Новая категория" });
}

function field(label: RegExp): HTMLInputElement | HTMLTextAreaElement {
  const el = within(dialog()).getByLabelText(label);
  if (!(el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement)) throw new Error("not a field");
  return el;
}

function createButton(): HTMLElement {
  return within(dialog()).getByRole("button", { name: /^(Создать|Создаём…|Подтвердить новую цену)/ });
}

async function openCreate(): Promise<void> {
  fireEvent.click(addChip());
  await flush();
  await within(dialog()).findByRole("button", { name: /до \$0\.045$/ });
}

async function fill(name: string, description: string): Promise<void> {
  fireEvent.change(field(/^Название/), { target: { value: name } });
  fireEvent.change(field(/^Описание/), { target: { value: description } });
  await flush();
}

const isDisabled = (el: HTMLElement): boolean => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

describe("the category row", () => {
  test("the built-ins first, then the custom ones in creation order, off by default; «+ Своя» last and «Мои категории» with their number", async () => {
    await openPhotos({ categories: [PARIS, WINTER, MONO] });
    await within(chipsGroup()).findByRole("button", { name: "Кофейни Парижа" });
    // 2026-10-12, S5.9g (mockup 47): the two «Смелая» chips follow the five, off (they wait for «Смелая»), before the owner's own.
    expect(chipNames()).toEqual([...BUILT_INS.map((l) => `${l}: 4 фото`), "Ночнушки и бельё", "Пляж и бассейн", "Кофейни Парижа", "Горы зимой", "Студия ч/б", "Своя"]);
    for (const name of ["Кофейни Парижа", "Горы зимой", "Студия ч/б"]) expect(within(chipsGroup()).getByRole("button", { name }).getAttribute("aria-pressed")).toBe("false");
    expect(screen.getByRole("button", { name: "Мои категории · 3" }).getAttribute("aria-haspopup")).toBe("dialog");
    expect(addChip().getAttribute("aria-haspopup")).toBe("dialog");
  });

  test("chips clicked in any order run in creation order: the request and the split per chip say so", async () => {
    const { engine } = await openPhotos({ categories: [PARIS, WINTER, MONO] });
    await within(chipsGroup()).findByRole("button", { name: "Студия ч/б" });
    fireEvent.click(within(chipsGroup()).getByRole("button", { name: "Студия ч/б" }));
    fireEvent.click(within(chipsGroup()).getByRole("button", { name: "Кофейни Парижа" }));
    await flush();
    // 20 over seven categories: the remainder (6) goes one each to the earliest, the custom one made first included.
    expect(within(chipsGroup()).getByRole("button", { name: "Кофейни Парижа: 3 фото" }).getAttribute("aria-pressed")).toBe("true");
    expect(within(chipsGroup()).getByRole("button", { name: "Студия ч/б: 2 фото" })).toBeDefined();
    await waitFor(() => expect(callsOf(engine, "runs.estimate").at(-1)?.payload.categories).toEqual(["home", "travel", "shoot", "glam", "fit", PARIS.categoryId, MONO.categoryId]));
  });

  test("a category deleted in another window leaves the row and the run", async () => {
    const { engine, client } = await openPhotos({ categories: [PARIS, WINTER] });
    fireEvent.click(await within(chipsGroup()).findByRole("button", { name: "Горы зимой" }));
    await flush();
    await act(async () => {
      await client.request("categories.delete", { categoryId: WINTER.categoryId });
    });
    await flush();
    expect(within(chipsGroup()).queryByRole("button", { name: /^Горы зимой/ }) === null).toBe(true);
    await waitFor(() => expect(callsOf(engine, "runs.estimate").at(-1)?.payload.categories).toEqual(["home", "travel", "shoot", "glam", "fit"]));
  });

  test("at fifty «+ Своя» is unavailable, and says why under the row", async () => {
    const fifty = Array.from({ length: 49 }, (_, i) => ({ ...category(1, `Категория ${i + 1}`), categoryId: `cat-many-${String(i + 1).padStart(4, "0")}` as const }));
    await openPhotos({ categories: fifty, unreadableCategories: 1 });
    await within(chipsGroup()).findByRole("button", { name: "ещё 45" });
    expect(isDisabled(addChip())).toBe(true);
    const why = addChip().getAttribute("aria-describedby");
    expect(why !== null && document.getElementById(why)?.textContent).toBe("50 из 50 — удалите ненужную в «Мои категории».");
    fireEvent.click(addChip());
    await flush();
    expect(screen.queryByRole("dialog", { name: "Новая категория" }) === null).toBe(true);
  });
});

// S5.5: the pool generator draws no lingerie, swimwear or nudity yet; the dialog says so while the owner types, before he pays, and says nothing otherwise.
describe("«Новая категория»: the note on what is not drawn", () => {
});

describe("«Новая категория»", () => {
  test("«Создать» sends exactly the request and the worst case it showed; while composing the form is locked and the row has a chip with a spinner", async () => {
    const { engine, scheduler } = await openPhotos({ categories: [PARIS] });
    await openCreate();
    await fill("Рынки", "Рынки и прилавки с фруктами");
    engine.delayNext("categories.create", 100);
    fireEvent.click(createButton());
    fireEvent.click(createButton());
    await flush();
    expect(callsOf(engine, "categories.create").map((c) => c.payload)).toEqual([{ name: "Рынки", description: "Рынки и прилавки с фруктами", acceptedWorstMicros: 45_000 }]);
    const busy = createButton();
    expect(busy.textContent).toBe("Создаём… · до $0.045");
    expect(busy.getAttribute("aria-busy")).toBe("true");
    expect(isDisabled(busy)).toBe(true);
    expect(within(dialog()).getByText(/^Составляем места, наряды и кадры · \d+ с$/)).toBeDefined();
    expect(within(dialog()).getByText("Обычно 10–20 с. Окно можно скрыть: категория появится в ряду сама, когда будет готова.")).toBeDefined();
    expect((field(/^Название/) as HTMLInputElement).disabled).toBe(true);
    expect(within(chipsGroup()).getByRole("button", { name: "Рынки — создаётся" }).getAttribute("aria-busy")).toBe("true");
    runAll(scheduler);
    await flush();
    expect(callsOf(engine, "categories.create")).toHaveLength(1);
  });

  test("done: the pool as the model made it, read-only, what it cost; «Готово» puts the focus on the new chip, which is on in the run", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    await openCreate();
    await fill("Рынки", "Рынки и прилавки с фруктами");
    fireEvent.click(createButton());
    await flush();
    const done = screen.getByRole("dialog", { name: "Рынки" });
    expect(within(done).getByText("готово")).toBeDefined();
    expect(within(done).getByText(/^для модели «Mock theme [0-9a-f]{4}» · (телефон|редакционный) · потрачено \$0\.005$/)).toBeDefined();
    expect(within(done).getByText("Места · 5")).toBeDefined();
    expect(within(done).getByText("текст уходит в промпты по-английски")).toBeDefined();
    expect(within(done).getByText(/^Наряды · [3-5]$/)).toBeDefined();
    expect(within(done).getByText("Кадры")).toBeDefined();
    expect(within(done).getByText("Категория уже включена в запуск. Убрать место или наряд, поменять ракурсы — в «Мои категории».")).toBeDefined();
    // Read-only: nothing to remove here.
    expect(within(done).queryByRole("button", { name: /^Убрать/ }) === null).toBe(true);
    const ok = within(done).getByRole("button", { name: "Готово" });
    expect(describeElement(document.activeElement)).toBe(describeElement(ok));
    fireEvent.click(ok);
    await flush();
    const chip = within(chipsGroup()).getByRole("button", { name: /^Рынки: \d+ фото$/ });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(describeElement(document.activeElement)).toBe(describeElement(chip));
    const created = callsOf(engine, "categories.create").length;
    expect(created).toBe(1);
    await waitFor(() => expect(callsOf(engine, "runs.estimate").at(-1)?.payload.categories.at(-1)).toMatch(/^cat-/));
  });

  test("the run's form outlives a look at Settings: the new category stays on, the count and «Подача» as they were (CS.7 L4)", async () => {
    await openPhotos({ categories: [PARIS] });
    await openCreate();
    await fill("Рынки", "Рынки и прилавки с фруктами");
    fireEvent.click(createButton());
    await flush();
    fireEvent.click(within(screen.getByRole("dialog", { name: "Рынки" })).getByRole("button", { name: "Готово" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Больше" }));
    fireEvent.click(screen.getByRole("radio", { name: "Кокетливая" }));
    await flush();
    expect(within(chipsGroup()).getByRole("button", { name: /^Рынки: \d+ фото$/ }).getAttribute("aria-pressed")).toBe("true");
    await openSection("Настройки");
    await openSection("Фото");
    await screen.findByRole("button", { name: /^Сгенерировать \d+ фото · до \$/ });
    expect(within(chipsGroup()).getByRole("button", { name: /^Рынки: \d+ фото$/ }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("group", { name: "Сколько фото" }).textContent).toContain("25");
    const flirty = screen.getByRole("radio", { name: "Кокетливая" });
    expect(flirty instanceof HTMLInputElement && flirty.checked).toBe(true);
  });

  test("hidden, then failed: a notice under the card names it and what it cost; «Изменить описание» opens it again with the same text", async () => {
    const { engine, scheduler } = await openPhotos({ categories: [PARIS] });
    await openCreate();
    await fill("Рынки", "Рынки и прилавки");
    engine.delayNext("categories.create", 100);
    engine.failNextCategoryCall({ code: "POOL_REJECTED" }, 11_000);
    fireEvent.click(createButton());
    await flush();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Скрыть" }));
    await flush();
    runAll(scheduler);
    await flush();
    const notice = screen.getByText(withText(/^Категория «Рынки» не создана: модель дважды вернула неподходящий набор — переформулируйте описание\. Потрачено \$0\.011\.$/));
    // The amount is set in mono, as the design has it.
    expect(within(notice).getByText("$0.011").className).toBe("mono");
    expect(within(chipsGroup()).queryByRole("button", { name: /Рынки/ }) === null).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Изменить описание" }));
    await flush();
    expect(field(/^Название/).value).toBe("Рынки");
    expect(field(/^Описание/).value).toBe("Рынки и прилавки");
    expect(describeElement(document.activeElement)).toBe(describeElement(field(/^Описание/)));
    expect(within(dialog()).getByText("Модель дважды вернула неподходящий набор — переформулируйте описание.")).toBeDefined();
    // The notice under the card is the same news: it is not said twice.
    expect(screen.queryByText(/^Категория «Рынки» не создана/) === null).toBe(true);
  });

  test("POOL_REJECTED in the dialog: why, what both attempts cost, and the form ready to send again", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    await openCreate();
    await fill("Рынки", "Рынки");
    engine.failNextCategoryCall({ code: "POOL_REJECTED" }, 11_000);
    fireEvent.click(createButton());
    await flush();
    expect(within(dialog()).getByText("Модель дважды вернула неподходящий набор — переформулируйте описание.")).toBeDefined();
    expect(within(dialog()).getByText("POOL_REJECTED · потрачено $0.011 — обе попытки учтены")).toBeDefined();
    expect(createButton().textContent).toBe("Создать · до $0.045");
    expect(isDisabled(createButton())).toBe(false);
    expect(field(/^Описание/).value).toBe("Рынки");
  });

  test("MODERATION_REFUSED: free on the first attempt; after a rejected first answer it cost that answer", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    await openCreate();
    await fill("Рынки", "Рынки");
    engine.failNextCategoryCall({ code: "MODERATION_REFUSED" }, 0);
    fireEvent.click(createButton());
    await flush();
    expect(within(dialog()).getByText("Модель отказалась составлять набор по этому описанию — переформулируйте его.")).toBeDefined();
    expect(within(dialog()).getByText("MODERATION_REFUSED · потрачено $0.000 — отказ на первой попытке не списан")).toBeDefined();
    engine.failNextCategoryCall({ code: "MODERATION_REFUSED" }, 6_000);
    fireEvent.click(createButton());
    await flush();
    expect(within(dialog()).getByText("MODERATION_REFUSED · потрачено $0.006 — первая попытка, отклонённая проверкой, оплачена")).toBeDefined();
  });

  test("PRICE_CHANGED: nothing is created, the new price is shown and only a new click on it sends", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    await openCreate();
    await fill("Рынки", "Рынки");
    engine.setCategoryPrice({ expectedMicros: 7_000, worstMicros: 52_000 });
    fireEvent.click(createButton());
    await flush();
    expect(within(dialog()).getByText("Цена выросла")).toBeDefined();
    expect(within(dialog()).getByText((_, el) => el?.textContent === "Было не больше $0.045, теперь не больше $0.052. Проверьте новую оценку и подтвердите снова — без подтверждения ничего не отправляется.")).toBeDefined();
    expect(within(dialog()).getByText("≈ $0.007 · до $0.052")).toBeDefined();
    expect(createButton().textContent).toBe("Подтвердить новую цену · до $0.052");
    expect(callsOf(engine, "categories.create")).toHaveLength(1);
    fireEvent.click(createButton());
    await flush();
    expect(callsOf(engine, "categories.create").at(-1)?.payload.acceptedWorstMicros).toBe(52_000);
    expect(screen.getByRole("dialog", { name: "Рынки" })).toBeDefined();
  });

  test("PRICE_CHANGED: until the fresh price answers the button shows no price and sends nothing", async () => {
    const { engine, scheduler } = await openPhotos({ categories: [PARIS] });
    await openCreate();
    await fill("Рынки", "Рынки");
    engine.setCategoryPrice({ expectedMicros: 7_000, worstMicros: 52_000 });
    engine.delayNext("categories.estimate", 100);
    fireEvent.click(createButton());
    await flush();
    expect(createButton().textContent).toBe("Создать · до …");
    expect(isDisabled(createButton())).toBe(true);
    fireEvent.click(createButton());
    await flush();
    expect(callsOf(engine, "categories.create")).toHaveLength(1);
    runAll(scheduler);
    await flush();
    expect(createButton().textContent).toBe("Подтвердить новую цену · до $0.052");
    expect(isDisabled(createButton())).toBe(false);
  });

  test("a change of the text model while its price is asked: no price of the old model is offered, the button waits for the new one", async () => {
    const { engine, client, scheduler } = await openPhotos({ categories: [PARIS] });
    await openCreate();
    await fill("Рынки", "Рынки");
    expect(createButton().textContent).toBe("Создать · до $0.045");
    engine.setCategoryPrice({ expectedMicros: 7_000, worstMicros: 52_000 });
    engine.delayNext("categories.estimate", 100);
    await act(async () => {
      await client.request("settings.setModels", { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "openai/gpt-5-mini" });
    });
    await flush();
    expect(createButton().textContent).toBe("Создать · до …");
    expect(isDisabled(createButton())).toBe(true);
    runAll(scheduler);
    await flush();
    expect(createButton().textContent).toBe("Создать · до $0.052");
    expect(isDisabled(createButton())).toBe(false);
  });

});
