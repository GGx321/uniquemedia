import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { CATEGORY_REASONS_RU, ERROR_MESSAGES_RU } from "../../shared/engine";
import { callsOf, describeElement, flush, inAct, runAll, withText } from "../testing";
import { BED_POOL, category, chipsGroup, interruptedCreate, interruptedRegenerate, MIA, MONO, openPhotos, PARIS, WINTER } from "./photos/categoryScreenKit";
import { REVEALING_NOTE, REVEALING_NOTE_DONE } from "./photos/revealingNote";
import { card, goButton, nb, openReview } from "./photos/sceneScreenKit";

// CS.3: «Мои категории» (CatSheet, CatSheetRename, CatSheetRegen, CatSheetRegenBusy, CatSheetRegenFailed, CatSheetRegenDone,
// CatSheetDelete; the CategoryStates sheet: empty, limits, unreadable, regenerate failures, interrupted calls) against the mock engine.

function sheet(): HTMLElement {
  return screen.getByRole("dialog", { name: "Мои категории" });
}

function myCategories(): HTMLElement {
  return screen.getByRole("button", { name: /^Мои категории/ });
}

async function openSheet(): Promise<void> {
  fireEvent.click(myCategories());
  await flush();
  await within(sheet()).findByRole("navigation", { name: "Категории" }).catch(() => null);
}

function row(name: string): HTMLElement {
  return within(within(sheet()).getByRole("navigation", { name: "Категории" })).getByRole("button", { name: new RegExp(`^${name}`) });
}

const isDisabled = (el: HTMLElement): boolean => el.hasAttribute("disabled") || el.getAttribute("aria-disabled") === "true";

function regenButton(): HTMLElement {
  return within(sheet()).getByRole("button", { name: /^(Пересоздать|Пересоздаём…|Подтвердить новую цену|Пересоздать снова) · / });
}

describe("the panel", () => {
  test("lists the categories with their counts, the first selected and focused, its detail beside; Escape closes it back to «Мои категории»", async () => {
    await openPhotos({ categories: [PARIS, WINTER, MONO] });
    await openSheet();
    expect(within(sheet()).getByText("3 из 50 · общие для всех аватаров")).toBeDefined();
    expect(row("Кофейни Парижа").getAttribute("aria-current")).toBe("true");
    // The counts are bound to their words by no-break spaces; the matcher reads them as spaces.
    expect(within(row("Кофейни Парижа")).getByText("6 мест · 4 наряда")).toBeDefined();
    expect(within(row("Горы зимой")).getByText("5 мест · 3 наряда")).toBeDefined();
    expect(describeElement(document.activeElement)).toBe(describeElement(row("Кофейни Парижа")));
    expect(within(sheet()).getByRole("heading", { level: 3, name: "Кофейни Парижа" })).toBeDefined();
    expect(within(sheet()).getByText(withText(/^для модели «Paris cafes» · телефон · создана 1 сент\. · потрачено \$0\.005$/))).toBeDefined();
    // Each segment of the line is its own unbreakable piece: «создана 1 сент.» never splits over two lines.
    expect(within(sheet()).getByText("создана 1 сент.").className).toBe("nowrap");
    expect(within(sheet()).getByText(PARIS.description)).toBeDefined();
    expect(within(sheet()).getByText("Места · 6")).toBeDefined();
    expect(within(sheet()).getByText("Наряды · 4")).toBeDefined();
    expect(within(sheet()).getAllByText("утро").length).toBeGreaterThan(0);
    expect(within(sheet()).getByText("Стиль «телефон», как у Дома.")).toBeDefined();
    expect(within(sheet()).getByText("Встроенные пять — Дом, Путешествия, Фотосессия на телефон, Гламур, Фитнес — здесь не показываются и не меняются.")).toBeDefined();
    fireEvent.click(row("Горы зимой"));
    await flush();
    expect(within(sheet()).getByRole("heading", { level: 3, name: "Горы зимой" })).toBeDefined();
    fireEvent.keyDown(window, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("dialog", { name: "Мои категории" }) === null).toBe(true);
    expect(describeElement(document.activeElement)).toBe(describeElement(myCategories()));
  });

  test("every category file holds a place towards the 50: unreadable ones and ones past the 50th are counted and said", async () => {
    await openPhotos({ categories: [PARIS, WINTER], unreadableCategories: 1 });
    await openSheet();
    expect(within(sheet()).getByText("3 из 50 · общие для всех аватаров")).toBeDefined();
    expect(within(sheet()).getByText("1 файл категории не читается — он не удалён")).toBeDefined();
  });

  test("no category yet: one invitation instead of the list, and it opens «Новая категория»", async () => {
    await openPhotos();
    await openSheet();
    expect(within(sheet()).getByText("0 из 50 · общие для всех аватаров")).toBeDefined();
    expect(within(sheet()).getByRole("heading", { level: 3, name: "Своих категорий пока нет" })).toBeDefined();
    expect(within(sheet()).queryByRole("button", { name: "Новая" }) === null).toBe(true);
    const invite = within(sheet()).getByRole("button", { name: "Создать категорию" });
    expect(describeElement(document.activeElement)).toBe(describeElement(invite));
    fireEvent.click(invite);
    await flush();
    expect(screen.queryByRole("dialog", { name: "Мои категории" }) === null).toBe(true);
    const dialog = screen.getByRole("dialog", { name: "Новая категория" });
    expect(describeElement(document.activeElement)).toBe(describeElement(within(dialog).getByLabelText(/^Название/)));
    fireEvent.keyDown(window, { key: "Escape" });
    await flush();
    expect(describeElement(document.activeElement)).toBe(describeElement(myCategories()));
  });
});

// S5.5: a created category whose description asked for what the pool generator will not draw says so on its card (it came out in everyday clothes).
describe("the note on what is not drawn", () => {
  const LINGERIE = category(5, "Реклама белья", BED_POOL, { description: "В нижнем брендовом белье на кровати для рекламы" });

  test("a category whose description asks for lingerie carries the note on its card, and an ordinary one does not", async () => {
    await openPhotos({ categories: [PARIS, LINGERIE] });
    await openSheet();
    expect(within(sheet()).queryByText(REVEALING_NOTE) === null).toBe(true);
    fireEvent.click(row("Реклама белья"));
    await flush();
    expect(within(sheet()).getByText(REVEALING_NOTE_DONE)).toBeDefined();
    expect(within(sheet()).queryByText(REVEALING_NOTE) === null).toBe(true);
    fireEvent.click(row("Кофейни Парижа"));
    await flush();
    expect(within(sheet()).queryByText(REVEALING_NOTE_DONE) === null).toBe(true);
  });

  test("the regenerate box shows it for the text being typed, before the paid click", async () => {
    await openPhotos({ categories: [PARIS] });
    await openSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Пересоздать…" }));
    await flush();
    expect(within(sheet()).queryByText(REVEALING_NOTE) === null).toBe(true);
    fireEvent.change(within(sheet()).getByLabelText(/^Новое описание/), { target: { value: "кофейни, девушка в купальнике" } });
    await flush();
    expect(within(sheet()).getByText(REVEALING_NOTE)).toBeDefined();
  });
});

describe("rename (free)", () => {
  test("the pencil opens the field; Enter saves; the list and the chip take the new name; the focus goes back to the pencil", async () => {
    const { engine } = await openPhotos({ categories: [PARIS, WINTER] });
    await openSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Переименовать" }));
    await flush();
    const field = within(sheet()).getByLabelText("Название") as HTMLInputElement;
    expect(describeElement(document.activeElement)).toBe(describeElement(field));
    expect(field.value).toBe("Кофейни Парижа");
    fireEvent.change(field, { target: { value: "Кофейни и улочки Парижа" } });
    expect(within(sheet()).getByText("23/40")).toBeDefined();
    fireEvent.keyDown(field, { key: "Enter" });
    await flush();
    expect(callsOf(engine, "categories.update").map((c) => c.payload)).toEqual([{ categoryId: PARIS.categoryId, name: "Кофейни и улочки Парижа" }]);
    expect(row("Кофейни и улочки Парижа")).toBeDefined();
    expect(within(chipsGroup()).getByRole("button", { name: "Кофейни и улочки Парижа" })).toBeDefined();
    expect(describeElement(document.activeElement)).toBe(describeElement(within(sheet()).getByRole("button", { name: "Переименовать" })));
  });

  test("Escape cancels the rename, not the panel; a blank or taken name is refused before anything is sent", async () => {
    const { engine } = await openPhotos({ categories: [PARIS, WINTER] });
    await openSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Переименовать" }));
    await flush();
    const field = within(sheet()).getByLabelText("Название") as HTMLInputElement;
    fireEvent.change(field, { target: { value: "  " } });
    expect(within(sheet()).getByText("Введите название.")).toBeDefined();
    expect(isDisabled(within(sheet()).getByRole("button", { name: "Сохранить" }))).toBe(true);
    fireEvent.change(field, { target: { value: "горы ЗИМОЙ" } });
    expect(within(sheet()).getByText(CATEGORY_REASONS_RU["name-taken"])).toBeDefined();
    fireEvent.keyDown(field, { key: "Enter" });
    await flush();
    fireEvent.keyDown(window, { key: "Escape" });
    await flush();
    expect(screen.getByRole("dialog", { name: "Мои категории" })).toBeDefined();
    expect(within(sheet()).queryByLabelText("Название") === null).toBe(true);
    expect(describeElement(document.activeElement)).toBe(describeElement(within(sheet()).getByRole("button", { name: "Переименовать" })));
    expect(callsOf(engine, "categories.update")).toHaveLength(0);
  });
});

describe("remove a place or an outfit (free)", () => {
  test("× removes it; the focus goes to the × of the next row", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    await openSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Убрать место: sidewalk cafe terrace" }));
    await flush();
    expect(callsOf(engine, "categories.update").map((c) => c.payload)).toEqual([{ categoryId: PARIS.categoryId, removeLocations: ["sidewalk cafe terrace"] }]);
    expect(within(sheet()).queryByText("sidewalk cafe terrace") === null).toBe(true);
    expect(within(sheet()).getByText("Места · 5")).toBeDefined();
    expect(describeElement(document.activeElement)).toBe(describeElement(within(sheet()).getByRole("button", { name: "Убрать место: bookshop by the river" })));
    fireEvent.click(within(sheet()).getByRole("button", { name: "Убрать наряд: navy knit cardigan and midi skirt" }));
    await flush();
    expect(callsOf(engine, "categories.update").at(-1)?.payload).toEqual({ categoryId: PARIS.categoryId, removeOutfits: ["navy knit cardigan and midi skirt"] });
    // The last outfit went: the focus goes to the one before.
    expect(describeElement(document.activeElement)).toBe(describeElement(within(sheet()).getByRole("button", { name: "Убрать наряд: white blouse, high-waisted jeans" })));
  });

  test("the only mirror place of a mirror deck, and every item at its minimum, cannot go: the × says why, nothing is sent", async () => {
    const { engine } = await openPhotos({ categories: [PARIS, WINTER] });
    await openSheet();
    const mirror = within(sheet()).getByRole("button", { name: "Убрать место: cafe restroom mirror" });
    expect(mirror.getAttribute("aria-disabled")).toBe("true");
    expect(mirror.getAttribute("title")).toBe("Единственное место с зеркалом — без него не будет кадров в зеркале");
    fireEvent.click(mirror);
    fireEvent.click(row("Горы зимой"));
    await flush();
    for (const x of within(sheet()).getAllByRole("button", { name: /^Убрать (место|наряд):/ })) expect(x.getAttribute("aria-disabled")).toBe("true");
    expect(within(sheet()).getByText("Мест уже 5 — меньше нельзя. Пересоздайте категорию, если места не нравятся.")).toBeDefined();
    expect(within(sheet()).getByText("Нарядов уже 3 — меньше нельзя. Пересоздайте категорию, если наряды не нравятся.")).toBeDefined();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Убрать место: ski lift queue" }));
    await flush();
    expect(callsOf(engine, "categories.update")).toHaveLength(0);
  });

  test("a removal the engine refuses (another window took one meanwhile) says why, and nothing changes", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    await openSheet();
    engine.failNext("categories.update", { code: "VALIDATION", categoryReason: "below-minimum" });
    fireEvent.click(within(sheet()).getByRole("button", { name: "Убрать место: bookshop by the river" }));
    await flush();
    expect(within(sheet()).getByText(CATEGORY_REASONS_RU["below-minimum"])).toBeDefined();
    expect(within(sheet()).getByText("Места · 6")).toBeDefined();
  });
});

describe("regenerate (paid)", () => {
  test("«Пересоздать…» opens the box with the description and its price; one click sends exactly that; busy, the category cannot change", async () => {
    const { engine, scheduler } = await openPhotos({ categories: [PARIS, WINTER] });
    await openSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Пересоздать…" }));
    await flush();
    const box = within(sheet()).getByLabelText(/^Новое описание/) as HTMLTextAreaElement;
    expect(describeElement(document.activeElement)).toBe(describeElement(box));
    expect(box.value).toBe(PARIS.description);
    // CS.8: the angles are re-read from the new description, and ⟳ in an open set takes the new pool.
    expect(
      within(sheet()).getByText(
        "Новый набор заменит места, наряды, кадры и ракурсы — ракурсы снова возьмутся из описания; название останется. Составленные сцены и идущие запуски не изменятся; «Другая сцена» возьмёт уже новый.",
      ),
    ).toBeDefined();
    expect(regenButton().textContent).toBe("Пересоздать · до $0.045");
    fireEvent.change(box, { target: { value: "Кофейни и бистро Парижа" } });
    engine.delayNext("categories.regenerate", 100);
    fireEvent.click(regenButton());
    fireEvent.click(regenButton());
    await flush();
    expect(callsOf(engine, "categories.regenerate").map((c) => c.payload)).toEqual([{ categoryId: PARIS.categoryId, description: "Кофейни и бистро Парижа", acceptedWorstMicros: 45_000 }]);
    expect(regenButton().textContent).toBe("Пересоздаём… · до $0.045");
    expect(regenButton().getAttribute("aria-busy")).toBe("true");
    expect(within(sheet()).getByText(/^Пересоздаём набор · \d+ с\.$/)).toBeDefined();
    expect(isDisabled(within(sheet()).getByRole("button", { name: "Переименовать" }))).toBe(true);
    expect(isDisabled(within(sheet()).getByRole("button", { name: "Удалить" }))).toBe(true);
    expect(within(sheet()).getByRole("button", { name: "Убрать место: bookshop by the river" }).getAttribute("aria-disabled")).toBe("true");
    runAll(scheduler);
    await flush();
    expect(within(sheet()).getByText((_, el) => el?.textContent === "Набор пересоздан · потрачено $0.005")).toBeDefined();
    // What it changes, truly (CS.7 L3; CS.8 adds the angles): a running run keeps its own copy; an open set keeps the scenes it has, but its ⟳ draws from the new pool.
    expect(
      within(sheet()).getByText(
        "Ниже — новые места, наряды, кадры и ракурсы. Они идут в следующие наборы и запуски. Уже составленные сцены остались как были; «Другая сцена» в открытом наборе возьмёт новые. Идущий запуск — со старым, у него своя копия.",
      ),
    ).toBeDefined();
    expect(within(sheet()).getByText(withText(/^для модели «Mock theme [0-9a-f]{4}» · (телефон|редакционный) · пересоздана \d+ \S+ · всего потрачено \$0\.010$/))).toBeDefined();
    expect(within(sheet()).getByText(/^пересоздана \d+ \S+$/).className).toBe("nowrap");
    expect(within(sheet()).getByText("Кофейни и бистро Парижа")).toBeDefined();
    expect(within(sheet()).queryByLabelText(/^Новое описание/) === null).toBe(true);
    // The box closed with the focus in it: the focus goes to «Пересоздать…», which opens it again.
    expect(describeElement(document.activeElement)).toBe(describeElement(within(sheet()).getByRole("button", { name: "Пересоздать…" })));
  });

  test("a failed regeneration keeps the old pool, says what it cost, takes the focus to why, and the button is there again", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    await openSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Пересоздать…" }));
    await flush();
    engine.failNextCategoryCall({ code: "POOL_REJECTED" }, 11_000);
    fireEvent.click(regenButton());
    await flush();
    const notice = within(sheet()).getByText((_, el) => el?.textContent === "Старый набор остался · потрачено $0.011").closest(".notice");
    expect(notice?.getAttribute("role")).toBe("alert");
    expect(describeElement(document.activeElement)).toBe(describeElement(notice));
    expect(within(sheet()).getByText("Модель дважды вернула неподходящий набор — переформулируйте описание и пересоздайте снова.")).toBeDefined();
    expect(within(sheet()).getByText("POOL_REJECTED · обе попытки учтены")).toBeDefined();
    // The amount in the title is set in mono, as the design has it.
    expect(within(notice as HTMLElement).getByText("$0.011").className).toBe("mono");
    expect(within(sheet()).getByText("Места · 6")).toBeDefined();
    expect(within(sheet()).getByText(withText(/^для модели «Paris cafes» · телефон · создана 1 сент\. · всего потрачено \$0\.016$/))).toBeDefined();
    expect(isDisabled(regenButton())).toBe(false);
    expect(regenButton().textContent).toBe("Пересоздать · до $0.045");
  });

  test("PRICE_CHANGED: nothing is sent; the new price is confirmed by a new click", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    await openSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Пересоздать…" }));
    await flush();
    engine.setCategoryPrice({ expectedMicros: 7_000, worstMicros: 52_000 });
    fireEvent.click(regenButton());
    await flush();
    expect(within(sheet()).getByText("Старый набор остался · цена выросла")).toBeDefined();
    expect(within(sheet()).getByText((_, el) => el?.textContent === "Было не больше $0.045, теперь не больше $0.052. Ничего не отправлено — подтвердите новую цену.")).toBeDefined();
    expect(regenButton().textContent).toBe("Подтвердить новую цену · до $0.052");
    fireEvent.click(regenButton());
    await flush();
    expect(callsOf(engine, "categories.regenerate").map((c) => c.payload.acceptedWorstMicros)).toEqual([45_000, 52_000]);
  });

  test("PRICE_CHANGED: until the fresh price answers the button shows no price and sends nothing", async () => {
    const { engine, scheduler } = await openPhotos({ categories: [PARIS] });
    await openSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Пересоздать…" }));
    await flush();
    engine.setCategoryPrice({ expectedMicros: 7_000, worstMicros: 52_000 });
    engine.delayNext("categories.estimate", 100);
    fireEvent.click(regenButton());
    await flush();
    expect(regenButton().textContent).toBe("Пересоздать · до …");
    expect(isDisabled(regenButton())).toBe(true);
    fireEvent.click(regenButton());
    await flush();
    expect(callsOf(engine, "categories.regenerate")).toHaveLength(1);
    runAll(scheduler);
    await flush();
    expect(regenButton().textContent).toBe("Подтвердить новую цену · до $0.052");
  });

  test("another window composing a category: «Пересоздать» waits with the note until that call ends", async () => {
    const { engine, client, scheduler } = await openPhotos({ categories: [PARIS] });
    engine.delayNext("categories.create", 500);
    let other: Promise<unknown> = Promise.resolve();
    inAct(() => {
      other = client.request("categories.create", { name: "Горы зимой", description: "горы", acceptedWorstMicros: 45_000 });
    });
    await flush();
    await openSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Пересоздать…" }));
    await flush();
    expect(isDisabled(regenButton())).toBe(true);
    expect(within(sheet()).getByText("Сейчас составляется «Горы зимой». По одной категории за раз — дождитесь её.")).toBeDefined();
    runAll(scheduler);
    await act(async () => {
      await other;
    });
    await flush();
    expect(within(sheet()).queryByText(/Сейчас составляется/) === null).toBe(true);
    expect(isDisabled(regenButton())).toBe(false);
  });

  test("until a reconcile the button waits with the reconcile's reason", async () => {
    const { engine } = await openPhotos({ categories: [PARIS] });
    inAct(() => engine.requireReconcile(["open-reserves"]));
    await flush();
    await openSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Пересоздать…" }));
    await flush();
    expect(isDisabled(regenButton())).toBe(true);
    expect(within(sheet()).getByText("Платные запросы остановлены до сверки расходов.")).toBeDefined();
  });
});

describe("delete (free)", () => {
  test("asked on the spot with the focus on «Отмена»; Escape cancels back to «Удалить»; confirmed, the next category is selected and the chip goes", async () => {
    const { engine } = await openPhotos({ categories: [PARIS, WINTER] });
    await openSheet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Удалить" }));
    await flush();
    const confirm = within(sheet()).getByRole("alertdialog", { name: "Удалить «Кофейни Парижа»?" });
    expect(within(confirm).getByText("Фото этой категории останутся в галерее с её названием. Запуски, где она уже есть, не изменятся. Вернуть категорию нельзя.")).toBeDefined();
    expect(describeElement(document.activeElement)).toBe(describeElement(within(confirm).getByRole("button", { name: "Отмена" })));
    fireEvent.keyDown(window, { key: "Escape" });
    await flush();
    expect(within(sheet()).queryByRole("alertdialog") === null).toBe(true);
    expect(describeElement(document.activeElement)).toBe(describeElement(within(sheet()).getByRole("button", { name: "Удалить" })));
    fireEvent.click(within(sheet()).getByRole("button", { name: "Удалить" }));
    await flush();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Удалить категорию" }));
    await flush();
    expect(callsOf(engine, "categories.delete").map((c) => c.payload)).toEqual([{ categoryId: PARIS.categoryId }]);
    expect(row("Горы зимой").getAttribute("aria-current")).toBe("true");
    expect(describeElement(document.activeElement)).toBe(describeElement(row("Горы зимой")));
    expect(within(chipsGroup()).queryByRole("button", { name: /^Кофейни Парижа/ }) === null).toBe(true);
  });
});

describe("calls a closed Studio left", () => {
  test("an interrupted create: under the card and atop the panel; «Создать снова» waits for the reconcile; «Убрать» forgets it for free", async () => {
    const { engine } = await openPhotos({ categories: [PARIS], interruptedCategories: [interruptedCreate()] });
    inAct(() => engine.requireReconcile(["open-reserves"]));
    await flush();
    await screen.findByText("Создание прервано — Studio закрылась");
    const text = "Модель составляла набор для «Рынки», когда Studio закрылась. Категория не создана; описание сохранено. Запрос учтён по худшей цене — до $0.023 — до сверки расходов.";
    expect(screen.getByText(text)).toBeDefined();
    const retry = screen.getByRole("button", { name: "Создать снова · до $0.045" });
    expect(isDisabled(retry)).toBe(true);
    await openSheet();
    expect(within(sheet()).getByText(text)).toBeDefined();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Убрать" }));
    await flush();
    expect(callsOf(engine, "categories.dismissInterrupted").map((c) => c.payload)).toEqual([{ jobId: "job-left-0001" }]);
    expect(screen.queryByText("Создание прервано — Studio закрылась") === null).toBe(true);
  });

  test("«Создать снова» waits while another window composes a category, with the note, and is back when that call ends", async () => {
    const { engine, client, scheduler } = await openPhotos({ categories: [PARIS], interruptedCategories: [interruptedCreate({ spentMicros: 0, openReserveMicros: 0 })] });
    engine.delayNext("categories.create", 500);
    let other: Promise<unknown> = Promise.resolve();
    inAct(() => {
      other = client.request("categories.create", { name: "Горы зимой", description: "горы", acceptedWorstMicros: 45_000 });
    });
    await flush();
    fireEvent.click(myCategories());
    await flush();
    const retry = within(sheet()).getByRole("button", { name: "Создать снова · до $0.045" });
    expect(isDisabled(retry)).toBe(true);
    expect(within(sheet()).getByText("Сейчас составляется «Горы зимой». По одной категории за раз — дождитесь её.")).toBeDefined();
    runAll(scheduler);
    await act(async () => {
      await other;
    });
    await flush();
    expect(isDisabled(within(sheet()).getByRole("button", { name: "Создать снова · до $0.045" }))).toBe(false);
  });

  test("«Создать снова» is a new request at the price on it, followed in the dialog; «Изменить описание» opens the dialog with the text", async () => {
    const { engine } = await openPhotos({ categories: [PARIS], interruptedCategories: [interruptedCreate({ spentMicros: 0, openReserveMicros: 0 })] });
    await screen.findByText(/Запрос не успел уйти — ничего не потрачено\.$/);
    fireEvent.click(screen.getByRole("button", { name: "Изменить описание" }));
    await flush();
    const dialog = screen.getByRole("dialog", { name: "Новая категория" });
    expect((within(dialog).getByLabelText(/^Описание/) as HTMLTextAreaElement).value).toBe("Рынки и прилавки с фруктами");
    expect(describeElement(document.activeElement)).toBe(describeElement(within(dialog).getByLabelText(/^Описание/)));
    fireEvent.click(within(dialog).getByRole("button", { name: "Отмена" }));
    await flush();
    engine.delayNext("categories.create", 100);
    fireEvent.click(screen.getByRole("button", { name: "Создать снова · до $0.045" }));
    await flush();
    expect(callsOf(engine, "categories.create").map((c) => c.payload)).toEqual([{ name: "Рынки", description: "Рынки и прилавки с фруктами", acceptedWorstMicros: 45_000 }]);
    expect(within(screen.getByRole("dialog", { name: "Новая категория" })).getByRole("button", { name: "Создаём… · до $0.045" })).toBeDefined();
  });

  test("an interrupted regeneration: in its category's box, «Пересоздать снова» priced; «Убрать» counts its cost into the category", async () => {
    const { engine } = await openPhotos({ categories: [PARIS], interruptedCategories: [interruptedRegenerate(PARIS.categoryId)] });
    await openSheet();
    expect(within(sheet()).getByText("Пересоздание прервано")).toBeDefined();
    expect(within(sheet()).getByText("Studio закрылась, пока модель составляла новый набор. Старый набор остался. Запрос учтён по худшей цене — до $0.023 — до сверки расходов.")).toBeDefined();
    expect((within(sheet()).getByLabelText(/^Новое описание/) as HTMLTextAreaElement).value).toBe("Кофейни и бистро");
    expect(regenButton().textContent).toBe("Пересоздать снова · до $0.045");
    fireEvent.click(within(sheet()).getByRole("button", { name: "Убрать" }));
    await flush();
    expect(callsOf(engine, "categories.dismissInterrupted")).toHaveLength(1);
    await waitFor(() => expect(within(sheet()).queryByText("Пересоздание прервано") === null).toBe(true));
    expect(within(sheet()).getByText(withText(/^для модели «Paris cafes» · телефон · создана 1 сент\. · потрачено \$0\.028$/))).toBeDefined();
  });

  test("an interrupted regeneration whose cost the ledger cannot tell is not forgotten: the refusal says why", async () => {
    const { engine } = await openPhotos({ categories: [PARIS], interruptedCategories: [interruptedRegenerate(PARIS.categoryId, { spentMicros: null, openReserveMicros: null })] });
    await openSheet();
    expect(within(sheet()).getByText(/Сколько стоил запрос, неизвестно: журнал расходов сейчас не читается\.$/)).toBeDefined();
    await act(async () => {
      fireEvent.click(within(sheet()).getByRole("button", { name: "Убрать" }));
    });
    await flush();
    expect(callsOf(engine, "categories.dismissInterrupted")).toHaveLength(1);
    expect(within(sheet()).getByText("Пересоздание прервано")).toBeDefined();
    expect(within(sheet()).getByText(ERROR_MESSAGES_RU.LEDGER_UNREADABLE)).toBeDefined();
  });
});

describe("phase 2: «Мои категории» with a scene set open (CS.7 M1)", () => {
  /** Mia's open set of three scenes, all from «Кофейни Парижа»; the strip's «Мои категории» is the way in. */
  async function withOpenSet() {
    const harness = await openReview({ categories: [PARIS, WINTER], sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-paris-0001", count: 3, written: 3, categories: [PARIS.categoryId] }] });
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    fireEvent.click(within(card()).getByRole("button", { name: /^Мои категории/ }));
    await flush();
    return harness;
  }

  test("deleting a category the open set draws from says that «Другая сцена» goes for its scenes there (ReviewStates E)", async () => {
    await withOpenSet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Удалить" }));
    await flush();
    const confirm = within(sheet()).getByRole("alertdialog", { name: "Удалить «Кофейни Парижа»?" });
    expect(confirm.textContent).toContain(
      nb("Запуски, где она уже есть, не изменятся. В открытом наборе сцен её 3 сцены останутся как есть, но «Другая сцена» для них станет недоступна — новое место из удалённой категории не взять. Вернуть категорию нельзя."),
    );
    // A category the set does not draw from is deleted with the phase-1 words.
    fireEvent.click(within(confirm).getByRole("button", { name: "Отмена" }));
    await flush();
    fireEvent.click(row("Горы зимой"));
    await flush();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Удалить" }));
    await flush();
    expect(within(sheet()).getByRole("alertdialog", { name: "Удалить «Горы зимой»?" }).textContent).not.toContain("В открытом наборе");
  });

  test("a category made while the set is open goes into the next set; «Готово» hands the focus to the strip's «Мои категории» (decision 17)", async () => {
    await withOpenSet();
    fireEvent.click(within(sheet()).getByRole("button", { name: "Новая" }));
    await flush();
    const dialog = screen.getByRole("dialog", { name: "Новая категория" });
    fireEvent.change(within(dialog).getByLabelText(/^Название/), { target: { value: "Рынки" } });
    fireEvent.change(within(dialog).getByLabelText(/^Описание/), { target: { value: "Рынки и прилавки с фруктами" } });
    await flush();
    fireEvent.click(await within(dialog).findByRole("button", { name: /^Создать · до \$/ }));
    await flush();
    const done = screen.getByRole("dialog", { name: "Рынки" });
    expect(within(done).getByText("Набор сцен уже составлен — категория войдёт в следующий набор. Открытый набор не меняется.")).toBeDefined();
    expect(within(done).queryByText(/уже включена в запуск/) === null).toBe(true);
    fireEvent.click(within(done).getByRole("button", { name: "Готово" }));
    await flush();
    expect(describeElement(document.activeElement)).toBe(describeElement(within(card()).getByRole("button", { name: /^Мои категории/ })));
  });
});
