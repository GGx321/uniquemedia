import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { callsOf, describeElement, flush, runAll } from "../testing";
import { MIA } from "./photos/categoryScreenKit";
import { ATTEMPT, card, column, fieldValue, goButton, isDisabled, nb, openReview, priceRow, sceneCard } from "./photos/sceneScreenKit";

// CS.6: a set stopped or cut short, against the mock engine: a compose a closed Studio cut off, before the reconcile and after it (ReviewStopped,
// ReviewStoppedReconciled), a compose that gave up on a request (ReviewGaveUp), a rewrite cut off (ReviewRewriteInterrupted) — its ⟳ offering both
// «Повторить» and a new one — a rewrite of a scene since removed, and an idea write cut off. A failed or interrupted paid write is told in ONE place, the
// column's notice (+ the card's marker); «Повторить» is priced by the attempts it has left; step 1 shows what the set already spent, stopped too.

const SET = "set-cut-0001";

/** Mia with 60 planned scenes, the first request written, the second cut off by a closed Studio (its reserve open), the third fresh. */
function cutOff() {
  return openReview({
    sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: SET, count: 60, written: 25, stopped: "closed", cutOff: { chunk: 2 }, categories: ["home", "travel", "shoot", "glam", "fit"] }],
  });
}

async function reconcile(client: Awaited<ReturnType<typeof cutOff>>["client"]): Promise<void> {
  await act(async () => {
    const reply = await client.request("money.reconcile", {});
    if (!reply.ok) throw new Error(reply.error.code);
  });
  await flush();
}

describe("a compose cut off by a closed Studio", () => {
  test("before the reconcile: the banner at «до $0.038», «Дописать» priced at the attempts left and waiting, «Дальше», step 1's spend (ReviewStopped)", async () => {
    const { engine } = await cutOff();
    await waitFor(() => expect(goButton().textContent).toBe(nb("Дописать 35 сцен · до $0.12")));
    expect(isDisabled(goButton())).toBe(true);
    expect(within(card()).getByText("Платные запросы остановлены до сверки расходов.")).toBeDefined();
    // The account banner tells an open reserve by «Деньги на экране»: three decimals below $0.10, rounded up.
    expect(screen.getByText(/Незакрытые резервы считаются по худшей цене: до \$0\.038\./)).toBeDefined();
    expect(priceRow("Сцены")).toBe("1 Сцены 25 из 60");
    expect(card().textContent).toMatch(/потрачено до \$0\.04\d/);
    expect(priceRow(/фото$/)).toContain("≈ $3.00");
    await waitFor(() => expect(priceRow("Дальше")).toContain("≈ $3.02"));
    expect(card().textContent).toContain("до $9.12 без правок");
    expect(card().textContent).toContain("составлено 25");
    const notice = within(column()).getByRole("alert");
    expect(notice.textContent).toContain("Составление прервано · готово 25 из 60");
    expect(notice.textContent).toContain("Прерванный запрос до сверки расходов учтён по худшей цене — дописать остальные можно после неё.");
    expect(within(sceneCard(26)).getByText("ждёт")).toBeDefined();
    expect(within(sceneCard(26)).queryByRole("button") === null).toBe(true);
    expect(within(column()).getByText("25 из 60 составлены")).toBeDefined();
    expect(callsOf(engine, "scenes.write")).toHaveLength(0);
  });

  test("after the reconcile: «Дописать» goes with the price it shows; the notice says the request was closed at its worst and counts (ReviewStoppedReconciled)", async () => {
    const { engine, client } = await cutOff();
    await waitFor(() => expect(goButton().textContent).toBe(nb("Дописать 35 сцен · до $0.12")));
    await reconcile(client);
    await waitFor(() => expect(isDisabled(goButton())).toBe(false));
    const notice = within(column()).getByRole("status");
    expect(notice.textContent).toContain("прерванный запрос закрыт при сверке по худшей цене — $0.038 — и считается попыткой: у его 25 сцен осталась одна.");
    fireEvent.click(goButton());
    fireEvent.click(goButton());
    await flush();
    const writes = callsOf(engine, "scenes.write");
    expect(writes).toHaveLength(1);
    expect(writes[0]?.payload).toMatchObject({ sceneSetId: SET, target: { kind: "unwritten" }, acceptedWorstMicros: ATTEMPT + 2 * ATTEMPT });
    expect(within(column()).getByText("Составляем сцены: 0 из 35")).toBeDefined();
  });

  test("«Убрать 35 пустых» is one free edit of every scene still empty; the focus goes to the column's title", async () => {
    const { engine } = await cutOff();
    const remove = await within(column()).findByRole("button", { name: nb("Убрать 35 пустых") });
    fireEvent.click(remove);
    await flush();
    expect(callsOf(engine, "scenes.edit").at(-1)?.payload.op).toEqual({ op: "remove", sceneIds: Array.from({ length: 35 }, (_, i) => 26 + i) });
    expect(describeElement(document.activeElement)).toBe(describeElement(within(column()).getByRole("heading", { name: "Сцены" })));
    await waitFor(() => expect(goButton().textContent).toBe(nb("Отрисовать 25 фото · до $3.75")));
  });
});

describe("a compose that gave up on a request", () => {
  test("«Готово 35 из 60 · 25 не составлены», «Убрать 25 пустых» and «Другие сцены для 5»; × hides it and the focus goes to the counter (ReviewGaveUp)", async () => {
    const { engine, scheduler } = await openReview();
    const more = within(card()).getByRole("button", { name: "Больше" });
    for (let i = 0; i < 8; i++) {
      fireEvent.click(more);
      await flush();
    }
    engine.failNextSceneAttempt("ok");
    engine.failNextSceneAttempt("rejected");
    engine.failNextSceneAttempt("rejected");
    fireEvent.click(await screen.findByRole("button", { name: nb("Составить 60 сцен · до $0.23") }));
    await flush();
    runAll(scheduler);
    await flush();
    const notice = within(column()).getByRole("status");
    expect(notice.textContent).toContain("Готово 35 из 60 · 25 не составлены");
    expect(notice.textContent).toContain("Отброшены при проверке: модель дважды вернула для них неподходящий текст.");
    expect(within(notice).getByRole("button", { name: nb("Убрать 25 пустых") })).toBeDefined();
    const others = await within(notice).findByRole("button", { name: "Другие сцены для 5 · до $0.075" });
    expect(within(column()).getByRole("button", { name: nb("25 сцен не составлены — перейти к первой, сцене 26") })).toBeDefined();
    expect(priceRow("Сцены")).toMatch(/\$0\.0\d\d/);
    fireEvent.click(others);
    await flush();
    expect(callsOf(engine, "scenes.write").at(-1)?.payload).toMatchObject({ target: { kind: "rewrite", sceneIds: [26, 27, 28, 29, 30], redraw: true }, acceptedWorstMicros: 2 * ATTEMPT });
    runAll(scheduler);
    await flush();
    fireEvent.click(within(within(column()).getByRole("status")).getByRole("button", { name: "Скрыть плашку — счётчик в шапке колонки останется" }));
    await flush();
    expect(within(column()).queryByRole("status") === null).toBe(true);
    expect(describeElement(document.activeElement)).toBe(describeElement(within(column()).getByRole("button", { name: nb("20 сцен не составлены — перейти к первой, сцене 31") })));
  });
});

describe("a rewrite cut off", () => {
  function rewriteCut(patch: { removed?: boolean } = {}) {
    return openReview({
      sceneSets: [
        {
          avatarId: MIA.avatarId,
          sceneSetId: "set-rw-0001",
          count: 6,
          written: 6,
          writes: 1,
          reviewWrites: [{ kind: "rewrite", k: 2, sceneIds: [2], redraw: true, cutOff: true }],
        },
      ],
    }).then(async (h) => {
      if (patch.removed === true) {
        await act(async () => {
          await h.client.request("scenes.edit", { sceneSetId: "set-rw-0001", revision: 1, op: { op: "remove", sceneIds: [2] } });
        });
        await flush();
      }
      return h;
    });
  }

  test("the notice says the scene stayed as it was; «Повторить» is priced at the one attempt left and waits for the reconcile; the card is marked (ReviewRewriteInterrupted)", async () => {
    await rewriteCut();
    const notice = await within(column()).findByRole("alert");
    expect(notice.textContent).toContain("Замена сцены 02 прервана");
    expect(notice.textContent).toContain("Studio закрылась, пока модель писала другую сцену 02, — сцена осталась как была.");
    const retry = await within(notice).findByRole("button", { name: "Повторить · до $0.038" });
    expect(isDisabled(retry)).toBe(true);
    expect(notice.textContent).toContain("Платные запросы остановлены до сверки расходов.");
    expect(within(sceneCard(2)).getByText("замена прервана")).toBeDefined();
    expect(priceRow("Сцены")).toMatch(/до \$0\.0\d\d/);
  });

  test("«Оставить как есть» lets the scene go free of its marker; the focus goes to that card", async () => {
    const { engine } = await rewriteCut();
    const notice = await within(column()).findByRole("alert");
    fireEvent.click(within(notice).getByRole("button", { name: "Оставить как есть" }));
    await flush();
    expect(callsOf(engine, "scenes.edit").at(-1)?.payload.op).toEqual({ op: "dismissInterrupted", sceneIds: [2] });
    expect(within(sceneCard(2)).queryByText("замена прервана") === null).toBe(true);
    expect(describeElement(document.activeElement)).toBe(describeElement(sceneCard(2)));
  });

  test("its ⟳ offers both: carrying the cut-off write on («Повторить · до $0.038») and a new one («Заменить · до $0.075»)", async () => {
    const { engine, client } = await rewriteCut();
    await reconcile(client);
    fireEvent.click(within(sceneCard(2)).getByRole("button", { name: "Другая сцена вместо 02" }));
    await flush();
    const pop = within(sceneCard(2)).getByRole("dialog", { name: "Другая сцена" });
    const resume = await within(pop).findByRole("button", { name: "Повторить · до $0.038" });
    expect(await within(pop).findByRole("button", { name: "Заменить · до $0.075" })).toBeDefined();
    expect(pop.textContent).toContain("Прошлая замена этой сцены прервана.");
    fireEvent.click(resume);
    await flush();
    expect(callsOf(engine, "scenes.write").at(-1)?.payload).toMatchObject({ target: { kind: "resume", write: 2 }, acceptedWorstMicros: ATTEMPT });
  });

  test("a scene removed since: no marker on its card, and the notice says to bring it back before carrying it on", async () => {
    await rewriteCut({ removed: true });
    await waitFor(() => expect(within(sceneCard(2)).getByText("убрана")).toBeDefined());
    expect(within(sceneCard(2)).queryByText("замена прервана") === null).toBe(true);
    // Every scene of the write removed: there is nothing to carry on, so nothing is said.
    expect(within(column()).queryByText(/Замена сцены 02/) === null).toBe(true);
  });
});

describe("an idea write cut off", () => {
  test("«Свои сцены не написаны»: «Повторить», «Открыть идею» (the form with the idea), «Не нужно» (free; the focus goes to «+ Своя сцена»)", async () => {
    const { engine } = await openReview({
      sceneSets: [
        { avatarId: MIA.avatarId, sceneSetId: "set-idea-0001", count: 3, written: 3, writes: 1, reviewWrites: [{ kind: "idea", k: 2, idea: "Утренний кофе на балконе", count: 2, shot: null, sceneIds: [4, 5], cutOff: true }] },
      ],
    });
    const notice = await within(column()).findByRole("alert");
    expect(notice.textContent).toContain("Свои сцены не написаны");
    expect(notice.textContent).toContain("Studio закрылась, пока модель писала 2 сцены по вашему описанию, — они не добавлены. Текст идеи сохранён.");
    expect(await within(notice).findByRole("button", { name: "Повторить · до $0.038" })).toBeDefined();
    fireEvent.click(within(notice).getByRole("button", { name: "Открыть идею" }));
    await flush();
    const form = within(column()).getByRole("region", { name: "Своя сцена · по описанию" });
    expect(fieldValue(within(form).getByRole("textbox"))).toBe("Утренний кофе на балконе");
    fireEvent.click(within(form).getByRole("button", { name: "Отмена" }));
    await flush();
    fireEvent.click(within(within(column()).getByRole("alert")).getByRole("button", { name: "Не нужно" }));
    await flush();
    expect(callsOf(engine, "scenes.edit").at(-1)?.payload.op).toEqual({ op: "dismissInterrupted", write: 2 });
    expect(within(column()).queryByText("Свои сцены не написаны") === null).toBe(true);
    expect(describeElement(document.activeElement)).toBe(describeElement(within(column()).getByRole("button", { name: "Своя сцена" })));
  });
});
