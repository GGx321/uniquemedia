import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { callsOf, describeElement, flush, inAct, runAll } from "../testing";
import { category, MIA, PARIS } from "./photos/categoryScreenKit";
import { ATTEMPT, card, column, fieldValue, goButton, isDisabled, nb, openReview, priceRow, querySceneCard, sceneCard } from "./photos/sceneScreenKit";

// CS.6: the «Сцены» column with a set open: the scene cards (remove and restore, the pencil's edit with its problem and Cyrillic hint, «не составлена»), ⟳
// with its price popover (a redraw for a planned scene, a rewrite from the idea for an own one, a deleted category, paid calls stopped), a rewrite running,
// and «+ Своя сцена · по описанию» with its placeholders. The artboards are ReviewReady, ReviewEdit, ReviewRewriting, ReviewAddIdea, ReviewIdeaWriting and
// ReviewEmpty, and the ReviewStates sheet (B: cards, C: popovers, D: the idea form). Every edit sends the revision it was made on; the approve price is
// asked again after each change.

const SET = "set-seed-0001";

/** Mia with a written set of `count` planned scenes in `categories`. */
function ready(count = 6, categories: readonly string[] = ["home", "travel"]) {
  return openReview({ categories: [PARIS], sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: SET, count, written: count, categories: categories as never }] });
}


describe("remove and restore", () => {
  test("× removes with the revision shown; the card greys with «Вернуть», which takes the focus; the header counts and the price follow (ReviewReady)", async () => {
    const { engine } = await ready(6);
    await waitFor(() => expect(goButton().textContent).toBe(nb("Отрисовать 6 фото · до $0.90")));
    fireEvent.click(within(sceneCard(3)).getByRole("button", { name: "Убрать сцену 03" }));
    await flush();
    const edit = callsOf(engine, "scenes.edit").at(-1)?.payload;
    expect(edit).toEqual({ sceneSetId: SET, revision: 1, op: { op: "remove", sceneIds: [3] } });
    expect(within(sceneCard(3)).getByText("убрана")).toBeDefined();
    expect(describeElement(document.activeElement)).toBe(describeElement(within(sceneCard(3)).getByRole("button", { name: "Вернуть сцену 03" })));
    expect(within(column()).getByText("1 убрана")).toBeDefined();
    await waitFor(() => expect(goButton().textContent).toBe(nb("Отрисовать 5 фото · до $0.75")));
    expect(callsOf(engine, "runs.estimateFromScenes").at(-1)?.payload.revision).toBe(2);
    fireEvent.click(within(sceneCard(3)).getByRole("button", { name: "Вернуть сцену 03" }));
    await flush();
    expect(callsOf(engine, "scenes.edit").at(-1)?.payload).toEqual({ sceneSetId: SET, revision: 2, op: { op: "restore", sceneIds: [3] } });
    expect(describeElement(document.activeElement)).toBe(describeElement(within(sceneCard(3)).getByRole("button", { name: "Убрать сцену 03" })));
  });

  test("an edit made on a revision another window moved: SCENES_CHANGED is told, nothing changed, the set is read again", async () => {
    const { engine } = await ready(4);
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    // Another window moved the revision first (the mock would announce it at once, so the refusal is forced).
    engine.failNext("scenes.edit", { code: "SCENES_CHANGED" });
    const reads = callsOf(engine, "scenes.get").length;
    fireEvent.click(within(sceneCard(2)).getByRole("button", { name: "Убрать сцену 02" }));
    await flush();
    expect(within(column()).getByText(/^Набор изменился в другом окне — ваша правка не сохранена\./)).toBeDefined();
    expect(callsOf(engine, "scenes.get").length).toBeGreaterThan(reads);
  });
});

describe("the pencil", () => {
  test("a word the prompt refuses is named in red and «Сохранить» waits; a good text is saved as «изменена»; Escape goes back to the pencil (ReviewEdit)", async () => {
    const { engine } = await ready(4);
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    fireEvent.click(within(sceneCard(3)).getByRole("button", { name: "Изменить текст сцены 03" }));
    await flush();
    const field = within(sceneCard(3)).getByRole("textbox", { name: "Текст сцены 03" });
    expect(describeElement(document.activeElement)).toBe(describeElement(field));
    fireEvent.change(field, { target: { value: "Sunny beach in Nice at midday, red bikini, holding a paper cup of iced coffee." } });
    expect(within(sceneCard(3)).getByText(/^\d+\/600 · бесплатно$/)).toBeDefined();
    fireEvent.click(within(sceneCard(3)).getByRole("button", { name: "Сохранить" }));
    await flush();
    expect(within(sceneCard(3)).getByText("Слово «bikini» не пройдёт в промпт — замените его. Откровенных нарядов нет ни в одной категории.")).toBeDefined();
    expect(field.getAttribute("aria-invalid")).toBe("true");
    expect(isDisabled(within(sceneCard(3)).getByRole("button", { name: "Сохранить" }))).toBe(true);
    fireEvent.change(field, { target: { value: "Sunny beach in Nice at midday, white linen dress, holding a paper cup of iced coffee." } });
    fireEvent.keyDown(field, { key: "Enter" });
    await flush();
    expect(callsOf(engine, "scenes.edit").at(-1)?.payload.op).toEqual({ op: "text", sceneId: 3, text: "Sunny beach in Nice at midday, white linen dress, holding a paper cup of iced coffee." });
    expect(within(sceneCard(3)).getByText("изменена")).toBeDefined();
    expect(describeElement(document.activeElement)).toBe(describeElement(within(sceneCard(3)).getByRole("button", { name: "Изменить текст сцены 03" })));
    fireEvent.click(within(sceneCard(2)).getByRole("button", { name: "Изменить текст сцены 02" }));
    await flush();
    fireEvent.keyDown(within(sceneCard(2)).getByRole("textbox"), { key: "Escape" });
    await flush();
    expect(describeElement(document.activeElement)).toBe(describeElement(within(sceneCard(2)).getByRole("button", { name: "Изменить текст сцены 02" })));
  });

  test("a Russian text is not refused, only told where it goes — by the scene's origin", async () => {
    await ready(3);
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    fireEvent.click(within(sceneCard(2)).getByRole("button", { name: "Изменить текст сцены 02" }));
    await flush();
    fireEvent.change(within(sceneCard(2)).getByRole("textbox"), { target: { value: "Селфи на неубранной кровати утром" } });
    expect(within(sceneCard(2)).getByText(/^Текст на русском уйдёт в промпт без перевода\. Написать его по-английски модель может только как новую сцену/)).toBeDefined();
    expect(isDisabled(within(sceneCard(2)).getByRole("button", { name: "Сохранить" }))).toBe(false);
  });
});

describe("the pencil keeps the revision it was opened on", () => {
  const DRAFT = "Sunny beach in Nice at midday, white linen dress, holding a paper cup of iced coffee.";

  async function openPencil(count: number) {
    const harness = await ready(count);
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    fireEvent.click(within(sceneCard(3)).getByRole("button", { name: "Изменить текст сцены 03" }));
    await flush();
    fireEvent.change(within(sceneCard(3)).getByRole("textbox", { name: "Текст сцены 03" }), { target: { value: DRAFT } });
    return harness;
  }

  async function sceneText(client: Awaited<ReturnType<typeof ready>>["client"], sceneId: number): Promise<string | null> {
    const reply = await client.request("scenes.get", { avatarId: MIA.avatarId });
    if (!reply.ok || reply.result.sceneSet === null) throw new Error("no set");
    return reply.result.sceneSet.scenes.find((s) => s.sceneId === sceneId)?.text ?? null;
  }

  test("another window edited the set after the pencil opened: the save goes with the opened revision, is refused, nothing is overwritten and the draft stays", async () => {
    const { engine, client } = await openPencil(4);
    const before = await sceneText(client, 3);
    // Another window's edit: the revision moves to 2 and this window hears it.
    await act(async () => {
      await client.request("scenes.edit", { sceneSetId: SET, revision: 1, op: { op: "remove", sceneIds: [4] } });
    });
    await flush();
    fireEvent.click(within(sceneCard(3)).getByRole("button", { name: "Сохранить" }));
    await flush();
    expect(callsOf(engine, "scenes.edit").at(-1)?.payload).toEqual({ sceneSetId: SET, revision: 1, op: { op: "text", sceneId: 3, text: DRAFT } });
    expect(within(column()).getByText(/^Набор изменился в другом окне — ваша правка не сохранена\./)).toBeDefined();
    expect(await sceneText(client, 3)).toBe(before);
    expect(fieldValue(within(sceneCard(3)).getByRole("textbox", { name: "Текст сцены 03" }))).toBe(DRAFT);
  });

  test("a rewrite of the scene finished while the pencil was open: the save is refused and the model's new text stays", async () => {
    const { engine, client, scheduler } = await openPencil(4);
    await act(async () => {
      const reply = await client.request("scenes.write", { sceneSetId: SET, revision: 1, target: { kind: "rewrite", sceneIds: [3], redraw: true }, acceptedWorstMicros: 2 * ATTEMPT });
      if (!reply.ok) throw new Error(reply.error.code);
    });
    runAll(scheduler);
    await flush();
    const rewritten = await sceneText(client, 3);
    expect(rewritten).not.toBe(DRAFT);
    fireEvent.click(within(sceneCard(3)).getByRole("button", { name: "Сохранить" }));
    await flush();
    expect(callsOf(engine, "scenes.edit").at(-1)?.payload).toMatchObject({ sceneSetId: SET, revision: 1, op: { op: "text", sceneId: 3, text: DRAFT } });
    expect(within(column()).getByText(/^Набор изменился в другом окне — ваша правка не сохранена\./)).toBeDefined();
    expect(await sceneText(client, 3)).toBe(rewritten);
    expect(fieldValue(within(sceneCard(3)).getByRole("textbox", { name: "Текст сцены 03" }))).toBe(DRAFT);
  });
});

describe("a scene given up on", () => {
  test("its own text, the header's counter and the reason under «Отрисовать» link to it (ReviewEdit, ReviewGaveUp)", async () => {
    const { engine, scheduler } = await openReview();
    engine.failNextSceneAttempt("rejected");
    engine.failNextSceneAttempt("rejected");
    fireEvent.click(await screen.findByRole("button", { name: nb("Составить 20 сцен · до $0.075") }));
    await flush();
    runAll(scheduler);
    await flush();
    expect(within(sceneCard(1)).getByText("не составлена")).toBeDefined();
    expect(within(sceneCard(1)).getByText(/^Отброшена при проверке: модель дважды вернула неподходящий текст\./)).toBeDefined();
    expect(isDisabled(goButton())).toBe(true);
    expect(goButton().textContent).toBe(nb("Отрисовать 0 фото · до …"));
    const reason = within(card()).getByRole("button", { name: "Сцена 01" });
    expect(reason.parentElement?.textContent).toContain(" и ещё 19 без текста — уберите их, попросите другие или напишите сами.");
    fireEvent.click(reason);
    await flush();
    expect(describeElement(document.activeElement)).toBe(describeElement(sceneCard(1)));
    const counter = within(column()).getByRole("button", { name: nb("20 сцен не составлены — перейти к первой, сцене 01") });
    fireEvent.click(sceneCard(5));
    fireEvent.click(counter);
    expect(describeElement(document.activeElement)).toBe(describeElement(sceneCard(1)));
  });
});

describe("⟳ and its price popover", () => {
  test("a planned scene: «Другая сцена», its price, the focus on «Отмена»; Escape gives the focus back to ⟳ (ReviewReady)", async () => {
    await ready(4);
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    const redo = within(sceneCard(2)).getByRole("button", { name: "Другая сцена вместо 02" });
    expect(redo.getAttribute("title")).toBe("Другая сцена — платно, цена перед отправкой");
    fireEvent.click(redo);
    await flush();
    const pop = within(sceneCard(2)).getByRole("dialog", { name: "Другая сцена" });
    expect(pop.getAttribute("aria-modal")).toBe("true");
    expect(describeElement(document.activeElement)).toBe(describeElement(within(pop).getByRole("button", { name: "Отмена" })));
    await waitFor(() => expect(within(pop).getByRole("button", { name: "Заменить · до $0.075" })).toBeDefined());
    expect(pop.textContent).toContain("Новое место, наряд, действие и время дня из «Дом» и новый текст. Сцена 02 заменится, когда новая будет готова");
    expect(pop.textContent).toContain("до $0.075 — предел одного запроса к модели (2 попытки)");
    expect(redo.getAttribute("aria-expanded")).toBe("true");
    fireEvent.keyDown(within(pop).getByRole("button", { name: "Отмена" }), { key: "Escape" });
    await flush();
    expect(within(sceneCard(2)).queryByRole("dialog") === null).toBe(true);
    expect(describeElement(document.activeElement)).toBe(describeElement(redo));
  });

  test("«Заменить» sends a redraw for that scene with the revision and the price shown; while it writes the set waits, then the scene is «новая» (ReviewRewriting)", async () => {
    const { engine, scheduler } = await ready(4);
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    fireEvent.click(within(sceneCard(2)).getByRole("button", { name: "Другая сцена вместо 02" }));
    await flush();
    const send = await within(sceneCard(2)).findByRole("button", { name: "Заменить · до $0.075" });
    fireEvent.click(send);
    fireEvent.click(send);
    await flush();
    const writes = callsOf(engine, "scenes.write");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.payload).toEqual({ sceneSetId: SET, revision: 1, target: { kind: "rewrite", sceneIds: [2], redraw: true }, acceptedWorstMicros: 2 * ATTEMPT });
    expect(within(column()).getByText("Пишем другую сцену вместо 02")).toBeDefined();
    expect(within(column()).getByText("≈ $0.000 · до $0.075 · правки набора — после неё")).toBeDefined();
    expect(within(sceneCard(2)).getByText("пишется…")).toBeDefined();
    expect(within(sceneCard(1)).getByRole("button", { name: "Убрать сцену 01" }).getAttribute("aria-disabled")).toBe("true");
    expect(isDisabled(goButton())).toBe(true);
    expect(within(card()).getByRole("button", { name: "сцену 02" }).parentElement?.textContent).toBe("Модель пишет сцену 02 — отрисовать можно, когда она закончит.");
    expect(describeElement(document.activeElement)).toBe(describeElement(within(column()).getByRole("button", { name: "Отменить" })));
    expect(within(screen.getByRole("region", { name: "Очередь" })).getByText("Сцены")).toBeDefined();
    runAll(scheduler);
    await flush();
    expect(within(sceneCard(2)).getByText("новая")).toBeDefined();
    await waitFor(() => expect(isDisabled(goButton())).toBe(false));
  });

  test("an own scene: «Переписать сцену» from its stored idea, no redraw", async () => {
    const { engine } = await openReview({
      sceneSets: [
        {
          avatarId: MIA.avatarId,
          sceneSetId: SET,
          count: 2,
          scenes: [
            { category: "home", shot: "friend", pose: "front", place: { location: "a sunny kitchen", timeOfDay: "morning", activity: "pouring coffee", outfit: "a linen shirt" }, text: "Kitchen." },
            { idea: "Утренний кофе на балконе с видом на море", shot: "friend", pose: "front", text: "Morning coffee on a seaside balcony." },
          ],
        },
      ],
    });
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    expect(within(sceneCard(2)).getByText("по описанию: «Утренний кофе на балконе с видом на море»")).toBeDefined();
    fireEvent.click(within(sceneCard(2)).getByRole("button", { name: "Переписать свою сцену 02" }));
    await flush();
    const pop = within(sceneCard(2)).getByRole("dialog", { name: "Переписать сцену" });
    expect(pop.textContent).toContain("Новый текст по вашему описанию «Утренний кофе на балконе…». Кадр и ракурс те же.");
    fireEvent.click(await within(pop).findByRole("button", { name: "Переписать · до $0.075" }));
    await flush();
    expect(callsOf(engine, "scenes.write").at(-1)?.payload.target).toEqual({ kind: "rewrite", sceneIds: [2], redraw: false });
  });

  test("a scene of a deleted category: «Другая сцена недоступна», for free", async () => {
    const MONO = category(7, "Студия ч/б");
    const { engine, client } = await openReview({ categories: [MONO], sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: SET, count: 2, written: 2, categories: [MONO.categoryId] }] });
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    await act(async () => {
      await client.request("categories.delete", { categoryId: MONO.categoryId });
    });
    fireEvent.click(within(sceneCard(1)).getByRole("button", { name: "Другая сцена вместо 01" }));
    await flush();
    const pop = await within(sceneCard(1)).findByRole("dialog", { name: "Другая сцена недоступна" });
    expect(pop.textContent).toContain("Категории «Студия ч/б» больше нет — новое место из неё не взять. Перепишите текст карандашом или уберите сцену.");
    expect(describeElement(document.activeElement)).toBe(describeElement(within(pop).getByRole("button", { name: "Понятно" })));
    expect(callsOf(engine, "scenes.write")).toHaveLength(0);
  });

  test("paid calls stopped: the popover still opens, shows the price, keeps «Заменить» disabled and says why, with the way to the reconcile", async () => {
    const { engine } = await ready(3);
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    inAct(() => engine.requireReconcile(["open-reserves"]));
    await flush();
    fireEvent.click(within(sceneCard(1)).getByRole("button", { name: "Другая сцена вместо 01" }));
    await flush();
    const pop = within(sceneCard(1)).getByRole("dialog");
    const send = await within(pop).findByRole("button", { name: "Заменить · до $0.075" });
    expect(isDisabled(send)).toBe(true);
    expect(pop.textContent).toContain("Платные запросы остановлены до сверки расходов.");
    expect(within(pop).getByRole("button", { name: "Перейти к сверке" })).toBeDefined();
  });

  test("the 500-write cap: the engine's refusal is told in plain words", async () => {
    const { engine } = await ready(3);
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    engine.failNext("scenes.write", { code: "VALIDATION", detail: "a set records at most 500 writes of this kind" });
    fireEvent.click(within(sceneCard(1)).getByRole("button", { name: "Другая сцена вместо 01" }));
    await flush();
    fireEvent.click(await within(sceneCard(1)).findByRole("button", { name: "Заменить · до $0.075" }));
    await flush();
    expect(within(sceneCard(1)).getByText("Слишком много правок в этом наборе — пересоставьте его.")).toBeDefined();
  });
});

describe("«+ Своя сцена · по описанию»", () => {
  test("opens with the focus in «Идея», its price, and sends the idea, the count and the shot; placeholders follow at the end (ReviewAddIdea, ReviewIdeaWriting)", async () => {
    const { engine, scheduler } = await ready(4);
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    const add = within(column()).getByRole("button", { name: "Своя сцена" });
    fireEvent.click(add);
    await flush();
    const form = within(column()).getByRole("region", { name: "Своя сцена · по описанию" });
    const idea = within(form).getByRole("textbox", { name: "Идея · на любом языке" });
    expect(describeElement(document.activeElement)).toBe(describeElement(idea));
    expect(form.textContent).toContain("Опишите идею.");
    expect(isDisabled(within(form).getByRole("button", { name: nb("Написать 1 сцену · до $0.075") }))).toBe(true);
    fireEvent.change(idea, { target: { value: "Утренний кофе на балконе с видом на море, в пижаме, а потом прогулка по пляжу с собакой" } });
    fireEvent.click(within(form).getByRole("button", { name: "Больше" }));
    fireEvent.change(within(form).getByRole("combobox", { name: "Кадр" }), { target: { value: "selfie" } });
    await flush();
    expect(form.textContent).toContain("≈ $0.001");
    const send = await within(form).findByRole("button", { name: nb("Написать 2 сцены · до $0.075") });
    fireEvent.click(send);
    await flush();
    expect(callsOf(engine, "scenes.write").at(-1)?.payload).toEqual({
      sceneSetId: SET,
      revision: 1,
      target: { kind: "idea", idea: "Утренний кофе на балконе с видом на море, в пижаме, а потом прогулка по пляжу с собакой", count: 2, shot: "selfie" },
      acceptedWorstMicros: 2 * ATTEMPT,
    });
    expect(within(column()).getByText("Пишем 2 своих сцены по описанию")).toBeDefined();
    expect(within(sceneCard(5)).getByText("пишется")).toBeDefined();
    expect(within(sceneCard(5)).getByText("по описанию: «Утренний кофе на балконе с видом на море…»")).toBeDefined();
    expect(querySceneCard(6) !== null).toBe(true);
    expect(describeElement(document.activeElement)).toBe(describeElement(sceneCard(5)));
    expect(within(column()).getByText("2 пишутся")).toBeDefined();
    runAll(scheduler);
    await flush();
    expect(within(sceneCard(5)).getByText("Своя сцена")).toBeDefined();
    expect(sceneCard(5).getAttribute("data-scene")).toBe("5");
  });

  test("Escape closes it and gives the focus back to «+ Своя сцена»", async () => {
    await ready(2);
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    fireEvent.click(within(column()).getByRole("button", { name: "Своя сцена" }));
    await flush();
    fireEvent.keyDown(within(column()).getByRole("textbox", { name: "Идея · на любом языке" }), { key: "Escape" });
    await flush();
    expect(within(column()).queryByRole("region", { name: "Своя сцена · по описанию" }) === null).toBe(true);
    expect(describeElement(document.activeElement)).toBe(describeElement(within(column()).getByRole("button", { name: "Своя сцена" })));
  });

  test("the provider refused the idea: the form opens again with it and says so", async () => {
    const { engine, scheduler } = await ready(2);
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    fireEvent.click(within(column()).getByRole("button", { name: "Своя сцена" }));
    await flush();
    fireEvent.change(within(column()).getByRole("textbox", { name: "Идея · на любом языке" }), { target: { value: "Пикник в парке" } });
    engine.failNextSceneAttempt("refused");
    fireEvent.click(await within(column()).findByRole("button", { name: nb("Написать 1 сцену · до $0.075") }));
    await flush();
    runAll(scheduler);
    await flush();
    const form = within(column()).getByRole("region", { name: "Своя сцена · по описанию" });
    expect(fieldValue(within(form).getByRole("textbox"))).toBe("Пикник в парке");
    expect(form.textContent).toContain("Модель отказалась писать по этой идее — переформулируйте её.");
  });

  test("an empty set opens with the form; «Отрисовать 0 фото» waits for a scene (ReviewEmpty)", async () => {
    const { engine } = await openReview();
    const less = within(card()).getByRole("button", { name: "Меньше" });
    for (let i = 0; i < 4; i++) {
      fireEvent.click(less);
      await flush();
    }
    fireEvent.click(await screen.findByRole("button", { name: "Начать пустой набор · бесплатно" }));
    await flush();
    expect(callsOf(engine, "scenes.compose").at(-1)?.payload).toMatchObject({ count: 0, acceptedWorstMicros: 0 });
    await waitFor(() => expect(goButton().textContent).toBe(nb("Отрисовать 0 фото")));
    expect(isDisabled(goButton())).toBe(true);
    expect(within(card()).getByText("Добавьте хотя бы одну сцену.")).toBeDefined();
    expect(card().textContent).toContain("пустой набор");
    expect(card().textContent).toContain("без категорий — только свои сцены");
    expect(priceRow("Сцены")).toContain("бесплатно");
    expect(within(column()).getByRole("region", { name: "Своя сцена · по описанию" })).toBeDefined();
    expect(within(column()).getByText("В наборе пока нет сцен. Опишите идею выше — сцены по ней напишет модель. Отрисовать можно, когда будет хотя бы одна.")).toBeDefined();
  });
});
