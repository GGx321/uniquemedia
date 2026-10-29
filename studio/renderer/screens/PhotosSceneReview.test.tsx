import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { callsOf, describeElement, flush, inAct, openSection, runAll, setup } from "../testing";
import { MIA } from "./photos/categoryScreenKit";
import { SCENE_REVIEW_KEY } from "./photos/sceneReview";
import { ATTEMPT, card, column, describedText, goButton, isDisabled, LLM_ONLY_REF, nb, openReview, priceRow, reviewSwitch, sceneCard } from "./photos/sceneScreenKit";

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

  test("while a scenes job writes the set it waits and says why: «Отменить» of the job stays on screen (CS.7 M3)", async () => {
    const { scheduler } = await openReview();
    fireEvent.click(await screen.findByRole("button", { name: nb("Составить 20 сцен · до $0.075") }));
    await flush();
    expect(isDisabled(reviewSwitch())).toBe(true);
    expect(describedText(reviewSwitch())).toBe("Пока модель пишет сцены, проверку не выключить — дождитесь конца или отмените запись.");
    fireEvent.click(reviewSwitch());
    await flush();
    expect(reviewSwitch().getAttribute("aria-checked")).toBe("true");
    expect(localStorage.getItem(SCENE_REVIEW_KEY) === "off").toBe(false);
    expect(within(column()).getByRole("button", { name: "Отменить" })).toBeDefined();
    expect(within(column()).queryByText("проверка выключена") === null).toBe(true);
    runAll(scheduler);
    await flush();
    expect(isDisabled(reviewSwitch())).toBe(false);
    expect(reviewSwitch().getAttribute("aria-describedby") === null).toBe(true);
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
    expect(sent[0]?.payload).toEqual({ avatarId: MIA.avatarId, count: 20, categories: [LLM_ONLY_REF], acceptedWorstMicros: 2 * ATTEMPT });
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

  test("with the five built-ins on the app writes the scenes: the price row says «бесплатно» and the compose is accepted at $0 (twin of the model's price above)", async () => {
    // 5a.2 (S5.6e, m11): the built-ins' scenes come from the code template, so no writer request is made and nothing is reserved.
    const { engine, scheduler } = await openReview({ builtIns: true });
    await waitFor(() => expect(priceRow("Сцены")).toContain("бесплатно"));
    expect(within(card()).getByText("их пишет приложение")).toBeDefined();
    fireEvent.click(goButton());
    await flush();
    const sent = callsOf(engine, "scenes.compose");
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toEqual({ avatarId: MIA.avatarId, count: 20, categories: ["home", "travel", "shoot", "glam", "fit"], acceptedWorstMicros: 0 });
    runAll(scheduler);
    await flush();
    await waitFor(() => expect(goButton().textContent).toBe(nb("Отрисовать 20 фото · до $3.00")));
    expect(within(card()).getByRole("list", { name: "Категории набора" }).textContent).toContain("Дом");
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

});

describe("a ready set: the strip and «Отрисовать»", () => {
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
    // «Деньги на экране»: the amount in mono, as the artboard sets it (CS.7 V5).
    expect(within(dialog).getByText(/^\$0\.0\d\d$/).className).toBe("mono");
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
});

describe("the set's read and the other paid paths", () => {
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
