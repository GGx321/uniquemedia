import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { callsOf, describeElement, flush, inAct, openSection, runAll, setup } from "../testing";
import { MIA } from "./photos/categoryScreenKit";
import { SCENE_REVIEW_KEY } from "./photos/sceneReview";
import { ATTEMPT, card, column, goButton, isDisabled, nb, openReview, priceRow, reviewSwitch, sceneCard } from "./photos/sceneScreenKit";

// CS.6: «Сцены на проверку» — the switch, the card's compose mode and its strip, approval, a used set, «Пересоставить…», against the mock engine. The
// artboards are ReviewOff, ReviewCompose, ReviewComposing, ReviewReady (the card), ReviewUsed, ReviewRecompose and the ReviewStates sheet (A: the card's
// button in its modes). Every paid button follows the app's rules: its price on it, keyed to the exact request and models; PRICE_CHANGED asks for a new
// click; never sent twice; disabled with paidBlockedReason; nothing paid without a click.

describe("the switch", () => {
  test("ON by default: the card composes scenes first, and the column says how review works (ReviewCompose)", async () => {
    await openReview();
    expect(reviewSwitch().getAttribute("aria-checked")).toBe("true");
    await waitFor(() => expect(goButton().textContent).toBe("Составить 20 сцен · до $0.075"));
    expect(priceRow("Сцены")).toContain("≈ $0.009");
    expect(priceRow(/фото$/)).toContain("≈ $1.00");
    expect(priceRow("Весь запуск")).toContain("≈ $1.01");
    expect(card().textContent).toContain("до $3.08 без правок");
    expect(within(column()).getByText("сцены на проверку")).toBeDefined();
    expect(within(column()).getByText(/^Модель пишет 20/).textContent).toContain("≈ $0.009");
  });

  test("turned off it is today's path, and it stays off on this machine (ReviewOff)", async () => {
    const { engine } = await openReview();
    await waitFor(() => expect(goButton().textContent).toContain("Составить"));
    fireEvent.click(reviewSwitch());
    await flush();
    expect(reviewSwitch().getAttribute("aria-checked")).toBe("false");
    await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 20 фото · до $3.08"));
    expect(localStorage.getItem(SCENE_REVIEW_KEY)).toBe("off");
    expect(within(column()).getByText("проверка выключена")).toBeDefined();
    expect(callsOf(engine, "scenes.compose")).toHaveLength(0);
  });

  test("Space toggles it; its name is the visible label", async () => {
    await openReview();
    const sw = reviewSwitch();
    const label = document.getElementById(sw.getAttribute("aria-labelledby") ?? "");
    expect(label?.textContent).toBe("Сцены на проверку");
  });

  test("with review on the count may go to 0 — an empty set, free; turned off there it stands at 5", async () => {
    const { engine } = await openReview();
    await waitFor(() => expect(goButton().textContent).toContain("Составить"));
    const less = within(card()).getByRole("button", { name: "Меньше" });
    for (let i = 0; i < 4; i++) {
      fireEvent.click(less);
      await flush();
    }
    expect(within(card()).getByRole("group", { name: "Сколько фото" }).textContent).toContain("0");
    await waitFor(() => expect(goButton().textContent).toBe("Начать пустой набор · бесплатно"));
    expect(isDisabled(goButton())).toBe(false);
    fireEvent.click(reviewSwitch());
    await flush();
    expect(within(card()).getByRole("group", { name: "Сколько фото" }).textContent).toContain("5");
    await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 5 фото · до $0.83"));
    expect(callsOf(engine, "scenes.compose")).toHaveLength(0);
  });
});

describe("compose", () => {
  test("sends exactly the request it priced, once; the card becomes the set's strip and the column shows the job (ReviewComposing)", async () => {
    const { engine } = await openReview();
    const button = await screen.findByRole("button", { name: nb("Составить 20 сцен · до $0.075") });
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    const sent = callsOf(engine, "scenes.compose");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toEqual({ avatarId: MIA.avatarId, count: 20, categories: ["home", "travel", "shoot", "glam", "fit"], poses: { profile: false, back: false }, acceptedWorstMicros: 2 * ATTEMPT });
    await flush();
    expect(card().getAttribute("aria-label")).toBe("Генерация фото · набор сцен");
    expect(goButton().textContent).toBe("Составляем… · до $0.075");
    expect(goButton().getAttribute("aria-busy")).toBe("true");
    expect(priceRow("Сцены")).toContain("пишутся");
    expect(within(column()).getByText("Составляем сцены: 0 из 20")).toBeDefined();
    expect(within(column()).getByRole("button", { name: "Отменить" })).toBeDefined();
    expect(within(column()).getByText("Отмена посреди запроса остановит платные действия до сверки расходов.")).toBeDefined();
    expect(within(sceneCard(1)).getByText("пишется")).toBeDefined();
    // The sidebar's queue counts the scenes job on its own row.
    const queue = screen.getByRole("region", { name: "Очередь" });
    expect(within(queue).getByText("Сцены")).toBeDefined();
    expect(queue.textContent).toContain("0 / 20");
  });

  test("two clicks before the screen draws again (one batch) still send one compose", async () => {
    const { engine } = await openReview();
    const button = await screen.findByRole("button", { name: nb("Составить 20 сцен · до $0.075") });
    act(() => {
      button.click();
      button.click();
    });
    await flush();
    expect(callsOf(engine, "scenes.compose")).toHaveLength(1);
  });

  test("PRICE_CHANGED: nothing is sent again until a new click accepts the new price", async () => {
    const { engine } = await openReview();
    const button = await screen.findByRole("button", { name: nb("Составить 20 сцен · до $0.075") });
    engine.failNext("scenes.compose", { code: "PRICE_CHANGED" });
    fireEvent.click(button);
    await flush();
    await waitFor(() => expect(goButton().textContent).toBe("Подтвердить новую цену · до $0.075"));
    expect(screen.getByText(/^Было не больше/)).toBeDefined();
    expect(callsOf(engine, "scenes.compose")).toHaveLength(1);
    fireEvent.click(goButton());
    await flush();
    expect(callsOf(engine, "scenes.compose")).toHaveLength(2);
  });

  test("paidBlockedReason keeps it disabled and says why", async () => {
    const { engine } = await openReview();
    await waitFor(() => expect(goButton().textContent).toContain("Составить"));
    inAct(() => engine.requireReconcile(["open-reserves"]));
    await flush();
    expect(isDisabled(goButton())).toBe(true);
    expect(within(card()).getByText("Платные запросы остановлены до сверки расходов.")).toBeDefined();
  });

  test("the cancel of the job: scenes.cancel for the set, «Отменяем…» until its end", async () => {
    const { engine, scheduler } = await openReview();
    fireEvent.click(await screen.findByRole("button", { name: nb("Составить 20 сцен · до $0.075") }));
    await flush();
    fireEvent.click(within(column()).getByRole("button", { name: "Отменить" }));
    await flush();
    expect(callsOf(engine, "scenes.cancel")).toHaveLength(1);
    expect(within(column()).getByRole("button", { name: "Отменяем…" })).toBeDefined();
    expect(within(column()).getByText("отмена отправлена · ждём конца запроса")).toBeDefined();
    runAll(scheduler);
    await flush();
    expect(within(column()).getByText(/^Составление остановлено · готово 0 из 20/)).toBeDefined();
  });
});

describe("a ready set: the strip and «Отрисовать»", () => {
  test("the strip names the set, its categories, its settings and the models; the price is the images only (ReviewReady)", async () => {
    const { engine, scheduler } = await openReview();
    fireEvent.click(await screen.findByRole("button", { name: nb("Составить 20 сцен · до $0.075") }));
    await flush();
    runAll(scheduler);
    await flush();
    await waitFor(() => expect(goButton().textContent).toBe(nb("Отрисовать 20 фото · до $3.00")));
    const set = callsOf(engine, "runs.estimateFromScenes").at(-1)?.payload;
    expect(set?.revision).toBeGreaterThan(1);
    expect(card().textContent).toContain("Набор сцен");
    expect(within(card()).getByRole("list", { name: "Категории набора" }).textContent).toContain("Дом");
    expect(card().textContent).toContain("Ракурсы: анфас, три четверти.");
    expect(card().textContent).toContain("текст grok-4.3");
    expect(priceRow("Сцены")).toMatch(/\$0\.00\d/);
    expect(priceRow(/фото$/)).toContain("≈ $1.00");
    expect(priceRow("Ожидаемая")).toContain("≈ $1.00");
  });

  test("approve sends the revision it priced and the worst case on the button; the set becomes a read-only run (ReviewUsed)", async () => {
    const { engine, scheduler } = await openReview();
    fireEvent.click(await screen.findByRole("button", { name: nb("Составить 20 сцен · до $0.075") }));
    await flush();
    runAll(scheduler);
    await flush();
    const approve = await screen.findByRole("button", { name: nb("Отрисовать 20 фото · до $3.00") });
    const priced = callsOf(engine, "runs.estimateFromScenes").at(-1)?.payload;
    fireEvent.click(approve);
    fireEvent.click(approve);
    await flush();
    const sent = callsOf(engine, "runs.startFromScenes");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toEqual({ sceneSetId: priced?.sceneSetId ?? "", revision: priced?.revision ?? 0, acceptedWorstMicros: 3_000_000 });
    await flush();
    // The card is back in compose mode and waits for the run; the column holds the set, read-only, with the run's progress.
    await waitFor(() => expect(card().getAttribute("aria-label")).toBe("Генерация фото"));
    expect(within(card()).getByText("Дождитесь конца текущего запуска.")).toBeDefined();
    expect(within(column()).getByText(/^Рисуем фото: \d+ из 20$/)).toBeDefined();
    expect(within(column()).getByText(/^Набор стал запуском/)).toBeDefined();
    expect(within(sceneCard(1)).queryByRole("button") === null).toBe(true);
    expect(within(column()).queryByRole("button", { name: "Своя сцена" }) === null).toBe(true);
    runAll(scheduler);
    await flush();
    expect(within(column()).getByText(/^В галерее 20.фото этого набора/)).toBeDefined();
  });

  test("an edit landing while the price was asked: SCENES_CHANGED says so, the set is read again, nothing is sent", async () => {
    const { engine, scheduler } = await openReview();
    fireEvent.click(await screen.findByRole("button", { name: nb("Составить 20 сцен · до $0.075") }));
    await flush();
    runAll(scheduler);
    await flush();
    const approve = await screen.findByRole("button", { name: nb("Отрисовать 20 фото · до $3.00") });
    engine.failNext("runs.startFromScenes", { code: "SCENES_CHANGED" });
    const reads = callsOf(engine, "scenes.get").length;
    fireEvent.click(approve);
    await flush();
    expect(screen.getByText("Пока считалась цена, набор изменился — проверьте сцены и нажмите снова.")).toBeDefined();
    expect(callsOf(engine, "scenes.get").length).toBeGreaterThan(reads);
  });
});

describe("«Пересоставить…»", () => {
  test("asks first with the focus on «Отмена»; Escape goes back to the link; «Удалить набор» discards it and the card composes again (ReviewRecompose)", async () => {
    const { engine, scheduler } = await openReview();
    fireEvent.click(await screen.findByRole("button", { name: nb("Составить 20 сцен · до $0.075") }));
    await flush();
    runAll(scheduler);
    await flush();
    await screen.findByRole("button", { name: /^Отрисовать 20/ });
    const link = within(card()).getByRole("button", { name: "Пересоставить…" });
    fireEvent.click(link);
    await flush();
    const dialog = screen.getByRole("alertdialog", { name: "Пересоставить сцены?" });
    expect(describeElement(document.activeElement)).toBe(describeElement(within(dialog).getByRole("button", { name: "Отмена" })));
    expect(dialog.textContent).toContain("Набор удалится целиком.");
    expect(dialog.textContent).toMatch(/Набор уже стоил \$0\.0\d\d\. Эти деньги потрачены и не вернутся\./);
    expect(dialog.textContent).toContain("«Составить 20 сцен»");
    const buttons = within(dialog).getAllByRole("button").map((b) => b.textContent);
    expect(buttons.indexOf("Удалить набор")).toBeLessThan(buttons.indexOf("Отмена"));
    fireEvent.keyDown(document.activeElement ?? dialog, { key: "Escape" });
    await flush();
    expect(screen.queryByRole("alertdialog") === null).toBe(true);
    expect(describeElement(document.activeElement)).toBe(describeElement(within(card()).getByRole("button", { name: "Пересоставить…" })));
    fireEvent.click(within(card()).getByRole("button", { name: "Пересоставить…" }));
    await flush();
    fireEvent.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Удалить набор" }));
    await flush();
    expect(callsOf(engine, "scenes.discard")).toHaveLength(1);
    await waitFor(() => expect(goButton().textContent).toBe("Составить 20 сцен · до $0.075"));
    expect(describeElement(document.activeElement)).toBe(describeElement(goButton()));
  });
});

describe("review off with a set open", () => {
  test("the set is kept and hidden; the column says how to come back; on again, the strip is back (ReviewOff)", async () => {
    const { engine } = await openReview({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 20, written: 20, categories: ["home", "travel"] }] });
    await waitFor(() => expect(goButton().textContent).toBe(nb("Отрисовать 20 фото · до $3.00")));
    fireEvent.click(reviewSwitch());
    await flush();
    await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 20 фото · до $3.08"));
    expect(within(column()).getByText("проверка выключена")).toBeDefined();
    expect(within(column()).getByText(/^Открытый набор — 20.сцен — сохранён/)).toBeDefined();
    fireEvent.click(reviewSwitch());
    await flush();
    await waitFor(() => expect(goButton().textContent).toBe(nb("Отрисовать 20 фото · до $3.00")));
    expect(callsOf(engine, "scenes.discard")).toHaveLength(0);
  });
});

describe("the set's read and the other paid paths", () => {
  test("a set that could not be read is told with a retry, and nothing composes meanwhile (a second set would be refused)", async () => {
    const { engine } = setup({ avatars: [MIA], sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 4, written: 4 }] });
    engine.failNext("scenes.get", { code: "LIBRARY_UNAVAILABLE" });
    await screen.findByRole("heading", { level: 2, name: "Mia" });
    await openSection("Фото");
    await flush();
    const retry = await within(column()).findByRole("button", { name: "Повторить" });
    expect(isDisabled(goButton())).toBe(true);
    fireEvent.click(retry);
    await flush();
    await waitFor(() => expect(goButton().textContent).toBe(nb("Отрисовать 4 фото · до $0.60")));
    expect(callsOf(engine, "scenes.compose")).toHaveLength(0);
  });

  test("today's «Сгенерировать» waits while a scenes job of the avatar runs", async () => {
    const { engine } = await openReview();
    fireEvent.click(await screen.findByRole("button", { name: nb("Составить 20 сцен · до $0.075") }));
    await flush();
    fireEvent.click(reviewSwitch());
    await flush();
    await waitFor(() => expect(goButton().textContent).toBe("Сгенерировать 20 фото · до $3.08"));
    expect(isDisabled(goButton())).toBe(true);
    expect(within(card()).getByText("Дождитесь, пока модель допишет сцены.")).toBeDefined();
    expect(callsOf(engine, "runs.start")).toHaveLength(0);
  });
});

describe("nothing paid without a click", () => {
  test("a restart of the engine during review: the set is read again, and no paid command is sent", async () => {
    const { engine } = await openReview({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 20, written: 20 }] });
    await waitFor(() => expect(goButton().textContent).toBe(nb("Отрисовать 20 фото · до $3.00")));
    const reads = callsOf(engine, "scenes.get").length;
    await act(async () => {
      engine.restart();
    });
    await flush();
    await waitFor(() => expect(callsOf(engine, "scenes.get").length).toBeGreaterThan(reads));
    for (const paid of ["scenes.compose", "scenes.write", "runs.startFromScenes", "runs.start", "runs.resume"] as const) expect(callsOf(engine, paid)).toHaveLength(0);
  });
});
