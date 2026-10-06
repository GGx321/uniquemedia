import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { CATEGORY_REASONS_RU } from "../../shared/engine";
import { callsOf, describeElement, flush, inAct, runAll } from "../testing";
import { category, chipsGroup, MONO, openPhotos, PARIS, WINTER } from "./photos/categoryScreenKit";

// CS.3 (phase 1 of custom categories): the category row of the generate card and the «Новая категория» dialog, against the mock engine.
// The artboards are CatChips, CatCreate, CatCreateBusy, CatCreateDone, CatCreateRejected, CatCreatePrice and the CategoryStates sheet
// (.omc/stage3/design/custom-categories). The paid button follows the app's rules: its price on it, keyed to the exact request and the
// text model the pool call runs on; PRICE_CHANGED asks for a new click; never sent twice; disabled with paidBlockedReason while blocked.

const BUILT_INS = ["Дом", "Путешествия", "Фотосессия", "Гламур 18+", "Фитнес"];

function chipNames(): string[] {
  return within(chipsGroup())
    .getAllByRole("button")
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
    expect(chipNames()).toEqual([...BUILT_INS.map((l) => `${l}: 4 фото`), "Кофейни Парижа", "Горы зимой", "Студия ч/б", "Своя"]);
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

  test("more than four custom ones: the first four and every one turned on stay, the rest wait behind «ещё N», opened in place", async () => {
    const seven = ["Кофейни Парижа", "Горы зимой", "Рынки", "Студия ч/б", "Книжные лавки", "Яхт-клуб", "Осенний парк"].map((name, i) => category(i + 1, name));
    await openPhotos({ categories: seven });
    const more = await within(chipsGroup()).findByRole("button", { name: "ещё 3" });
    expect(more.getAttribute("aria-expanded")).toBe("false");
    expect(within(chipsGroup()).queryByRole("button", { name: "Яхт-клуб" }) === null).toBe(true);
    fireEvent.click(more);
    await flush();
    fireEvent.click(within(chipsGroup()).getByRole("button", { name: "Яхт-клуб" }));
    const fold = within(chipsGroup()).getByRole("button", { name: "свернуть" });
    expect(fold.getAttribute("aria-expanded")).toBe("true");
    fireEvent.click(fold);
    await flush();
    // Turned on, it stays in the row; the other two wait.
    expect(within(chipsGroup()).getByRole("button", { name: /^Яхт-клуб: \d+ фото$/ })).toBeDefined();
    expect(within(chipsGroup()).getByRole("button", { name: "ещё 2" })).toBeDefined();
    expect(chipNames().at(-1)).toBe("Своя");
  });

  test("a long name is cut on the chip but whole in its title and accessible name", async () => {
    // 39 chars: the contract allows 40.
    const long = category(4, "Утренние пробежки по набережной Тюильри");
    await openPhotos({ categories: [long] });
    const chip = await within(chipsGroup()).findByRole("button", { name: long.name });
    expect(chip.getAttribute("title")).toBe(long.name);
    expect(chip.querySelector(".chip-cap")?.textContent).toBe(long.name);
  });

  test("a photo of a custom category is labelled by the name it kept, cut on the tile and whole in its title", async () => {
    const name = "Утренние пробежки по набережной Тюильри";
    await openPhotos({
      categories: [PARIS],
      photos: [
        {
          photoId: "photo-custom-0001",
          avatarId: "avatar-mia-0001",
          runId: "run-custom-0001",
          category: "cat-gone-from-library",
          categoryName: name,
          createdAt: "2026-09-20T10:00:00.000Z",
          used: false,
          usedIn: [],
          rejected: false,
          reserved: false,
          eligible: true,
        },
      ],
    });
    const label = await screen.findByText(name, { selector: ".photo-label" });
    expect(label.getAttribute("title")).toBe(name);
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

describe("«Новая категория»", () => {
  test("opens with the focus in «Название», the price on its button and nothing sent; Escape closes it back to «+ Своя»", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    await openCreate();
    expect(describeElement(document.activeElement)).toBe(describeElement(field(/^Название/)));
    expect(within(dialog()).getByText("≈ $0.006 · до $0.045")).toBeDefined();
    expect(within(dialog()).getByText(/^grok-4\.3 · не больше 2 попыток · цены OpenRouter · \d+ \S+$/)).toBeDefined();
    // Nothing typed yet: the button waits, no error is shouted.
    expect(isDisabled(createButton())).toBe(true);
    expect(within(dialog()).queryByText("Введите название.") === null).toBe(true);
    fireEvent.keyDown(window, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("dialog", { name: "Новая категория" }) === null).toBe(true);
    expect(describeElement(document.activeElement)).toBe(describeElement(addChip()));
    expect(callsOf(engine, "categories.create")).toHaveLength(0);
  });

  test("the fields are checked before anything is sent, free: a blank name, a long description, a name another category has", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    await openCreate();
    fireEvent.change(field(/^Название/), { target: { value: "x" } });
    fireEvent.change(field(/^Название/), { target: { value: "  " } });
    await flush();
    expect(within(dialog()).getByText("Введите название.")).toBeDefined();
    expect(field(/^Название/).getAttribute("aria-invalid")).toBe("true");
    await fill("Рынки", "а".repeat(512));
    expect(within(dialog()).getByText("Не больше 500 знаков — уберите 12.")).toBeDefined();
    expect(within(dialog()).getByText("512/500")).toBeDefined();
    expect(isDisabled(createButton())).toBe(true);
    await fill("  кофейни ПАРИЖА ", "кофейни");
    expect(within(dialog()).getByText(CATEGORY_REASONS_RU["name-taken"])).toBeDefined();
    expect(isDisabled(createButton())).toBe(true);
    fireEvent.click(createButton());
    await flush();
    expect(callsOf(engine, "categories.create")).toHaveLength(0);
  });

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
    expect(within(done).getByText(/^для модели «Mock theme [0-9a-f]{4}» · (телефон|редакционный) · потрачено \$0\.006$/)).toBeDefined();
    expect(within(done).getByText("Места · 5")).toBeDefined();
    expect(within(done).getByText("текст уходит в промпты по-английски")).toBeDefined();
    expect(within(done).getByText(/^Наряды · [3-5]$/)).toBeDefined();
    expect(within(done).getByText("Кадры")).toBeDefined();
    expect(within(done).getByText("Категория уже включена в запуск. Убрать место или наряд — в «Мои категории».")).toBeDefined();
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

  test("«Скрыть» while composing: the chip with the spinner takes the focus and opens the dialog again; done, the chip is on and keeps the focus", async () => {
    const { engine, scheduler } = await openPhotos({ categories: [PARIS] });
    await openCreate();
    await fill("Рынки", "Рынки и прилавки");
    engine.delayNext("categories.create", 100);
    fireEvent.click(createButton());
    await flush();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Скрыть" }));
    await flush();
    expect(screen.queryByRole("dialog") === null).toBe(true);
    const waiting = within(chipsGroup()).getByRole("button", { name: "Рынки — создаётся" });
    expect(describeElement(document.activeElement)).toBe(describeElement(waiting));
    fireEvent.click(waiting);
    await flush();
    expect(createButton().textContent).toBe("Создаём… · до $0.045");
    fireEvent.click(within(dialog()).getByRole("button", { name: "Скрыть" }));
    await flush();
    runAll(scheduler);
    await flush();
    const chip = within(chipsGroup()).getByRole("button", { name: /^Рынки: \d+ фото$/ });
    expect(chip.getAttribute("aria-pressed")).toBe("true");
    expect(describeElement(document.activeElement)).toBe(describeElement(chip));
    expect(screen.queryByRole("dialog") === null).toBe(true);
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
    expect(screen.getByText("Категория «Рынки» не создана: модель дважды вернула неподходящий набор — переформулируйте описание. Потрачено $0.011.")).toBeDefined();
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

  test("Enter that ends an input method's composition in «Название» is not «Создать»", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    await openCreate();
    await fill("Рынки", "Рынки");
    fireEvent.keyDown(field(/^Название/), { key: "Enter", isComposing: true });
    await flush();
    expect(callsOf(engine, "categories.create")).toHaveLength(0);
    fireEvent.keyDown(field(/^Название/), { key: "Enter" });
    await flush();
    expect(callsOf(engine, "categories.create")).toHaveLength(1);
  });

  test("the library's limit sends to «Мои категории»; a pool paid for but not stored sends to Settings", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    await openCreate();
    await fill("Рынки", "Рынки");
    engine.failNext("categories.create", { code: "VALIDATION", categoryReason: "limit" });
    fireEvent.click(createButton());
    await flush();
    expect(within(dialog()).getByText("В библиотеке уже 50 категорий — это предел. Удалите ненужную, потом создайте новую.")).toBeDefined();
    expect(within(dialog()).getByRole("button", { name: "Мои категории" })).toBeDefined();
    engine.failNextCategoryCall({ code: "INTERNAL", detail: "the paid category is kept in raw/x" }, 5_000);
    fireEvent.click(createButton());
    await flush();
    expect(within(dialog()).getByText("Набор оплачен, но не сохранился: папка библиотеки недоступна для записи. Проверьте её в Настройках и создайте категорию снова.")).toBeDefined();
    expect(within(dialog()).getByText("INTERNAL · потрачено $0.005")).toBeDefined();
    expect(within(dialog()).getByRole("button", { name: "Открыть Настройки" })).toBeDefined();
  });

  test("another window composing a category: the dialog says which, and a create sent anyway is refused for free", async () => {
    const { engine, client, scheduler } = await openPhotos({ categories: [PARIS] });
    engine.delayNext("categories.create", 500);
    let other: Promise<unknown> = Promise.resolve();
    inAct(() => {
      other = client.request("categories.create", { name: "Горы зимой", description: "горы", acceptedWorstMicros: 45_000 });
    });
    await flush();
    await openCreate();
    expect(within(dialog()).getByText("Сейчас составляется «Горы зимой». По одной категории за раз — дождитесь её, потом создайте эту.")).toBeDefined();
    runAll(scheduler);
    await act(async () => {
      await other;
    });
  });

  test("another window composing a category: «Создать» waits with the note, and both go when that call ends", async () => {
    const { engine, client, scheduler } = await openPhotos({ categories: [PARIS] });
    engine.delayNext("categories.create", 500);
    let other: Promise<unknown> = Promise.resolve();
    inAct(() => {
      other = client.request("categories.create", { name: "Горы зимой", description: "горы", acceptedWorstMicros: 45_000 });
    });
    await flush();
    await openCreate();
    await fill("Рынки", "Рынки");
    expect(isDisabled(createButton())).toBe(true);
    fireEvent.click(createButton());
    await flush();
    expect(callsOf(engine, "categories.create")).toHaveLength(1);
    runAll(scheduler);
    await act(async () => {
      await other;
    });
    await flush();
    expect(within(dialog()).queryByText(/Сейчас составляется/) === null).toBe(true);
    expect(isDisabled(createButton())).toBe(false);
  });

  test("a create refused because another window composes: the note goes and «Создать» is back when that call ends", async () => {
    const { engine, client, scheduler } = await openPhotos({ categories: [PARIS] });
    await openCreate();
    await fill("Рынки", "Рынки");
    engine.delayNext("categories.create", 500);
    let other: Promise<unknown> = Promise.resolve();
    inAct(() => {
      other = client.request("categories.create", { name: "Горы зимой", description: "горы", acceptedWorstMicros: 45_000 });
    });
    await flush();
    fireEvent.click(createButton());
    await flush();
    expect(within(dialog()).getByText(/Сейчас составляется «Горы зимой»/)).toBeDefined();
    runAll(scheduler);
    await act(async () => {
      await other;
    });
    await flush();
    expect(within(dialog()).queryByText(/Сейчас составляется/) === null).toBe(true);
    expect(isDisabled(createButton())).toBe(false);
  });

  test("without a usable key, or until a reconcile, «Создать» is unavailable and says why", async () => {
    const { engine } = await openPhotos({ categories: [PARIS], apiKey: { stored: false, last4: null, encryptionAvailable: true, rejected: false } });
    await openCreate();
    await fill("Рынки", "Рынки");
    expect(isDisabled(createButton())).toBe(true);
    expect(within(dialog()).getByText("Нужен рабочий ключ OpenRouter — добавьте его в Настройках.")).toBeDefined();
    fireEvent.click(createButton());
    await flush();
    expect(callsOf(engine, "categories.create")).toHaveLength(0);
  });

  test("until a reconcile the button waits with the reconcile's reason", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    inAct(() => engine.requireReconcile(["open-reserves"]));
    await flush();
    await openCreate();
    await fill("Рынки", "Рынки");
    expect(isDisabled(createButton())).toBe(true);
    expect(within(dialog()).getByText("Платные запросы остановлены до сверки расходов.")).toBeDefined();
  });
});
