import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { EngineError } from "../../shared/engine";
import { callsOf, describeElement, flush, runAll } from "../testing";
import { MIA, PARIS } from "./photos/categoryScreenKit";
import { card, column, describedText, goButton, isDisabled, nb, openReview, sceneCard } from "./photos/sceneScreenKit";

// CS.7 M2: a free price that could not be had leaves no paid button dead and silent (README decision 16: paid but unavailable — the reason is always
// shown). Each paid button of the review — «Составить», «Дописать», ⟳ «Заменить», «Написать N сцен», «Повторить», «Другие сцены для N» — says why under
// it, as CS.3's create dialog does («Цену не узнать: … · Повторить»), and is described by that line; «Повторить» asks for the price again (free), and once
// it comes the focus that was on «Повторить» goes to the button, now priced.

const REFUSED: EngineError = { code: "PRICE_UNAVAILABLE", detail: "no price for the text model" };
const WHY = "Цену не узнать: не удалось узнать цену модели, поэтому запрос не отправлен.";

/** «Повторить» of the price line inside `root`: focused as a keyboard owner would, then pressed. */
async function retryPrice(root: HTMLElement): Promise<void> {
  const link = within(root).getByRole("button", { name: "Повторить" });
  link.focus();
  fireEvent.click(link);
  await flush();
}

async function reconcile(client: Awaited<ReturnType<typeof openReview>>["client"]): Promise<void> {
  await act(async () => {
    const reply = await client.request("money.reconcile", {});
    if (!reply.ok) throw new Error(reply.error.code);
  });
  await flush();
}

describe("a failed free price on a review paid button", () => {
  test("«Составить»: the reason under it and «Повторить»; the price asked again lands on the button, which takes the focus", async () => {
    const { engine } = await openReview();
    await waitFor(() => expect(goButton().textContent).toBe(nb("Составить 20 сцен · до $0.075")));
    engine.failNext("scenes.estimateCompose", REFUSED);
    fireEvent.click(within(card()).getByRole("button", { name: "Больше" }));
    await flush();
    expect(isDisabled(goButton())).toBe(true);
    expect(goButton().getAttribute("aria-busy")).toBe("false");
    expect(describedText(goButton())).toContain(WHY);
    const asked = callsOf(engine, "scenes.estimateCompose").length;
    await retryPrice(card());
    expect(callsOf(engine, "scenes.estimateCompose")).toHaveLength(asked + 1);
    await waitFor(() => expect(goButton().textContent).toBe(nb("Составить 25 сцен · до $0.075")));
    expect(isDisabled(goButton())).toBe(false);
    expect(within(card()).queryByText(/^Цену не узнать/) === null).toBe(true);
    expect(describeElement(document.activeElement)).toBe(describeElement(goButton()));
  });

  test("«Дописать»: refused after the reconcile, it says why; «Повторить» brings its price", async () => {
    const { engine, client } = await openReview({
      sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-cut-0001", count: 60, written: 25, stopped: "closed", cutOff: { chunk: 2 }, categories: ["home", "travel"] }],
    });
    await waitFor(() => expect(goButton().textContent).toBe(nb("Дописать 35 сцен · до $0.12")));
    engine.failNext("scenes.estimateWrite", REFUSED);
    await reconcile(client);
    await waitFor(() => expect(describedText(goButton())).toContain(WHY));
    expect(isDisabled(goButton())).toBe(true);
    await retryPrice(card());
    await waitFor(() => expect(isDisabled(goButton())).toBe(false));
    expect(goButton().textContent).toBe(nb("Дописать 35 сцен · до $0.12"));
    expect(describeElement(document.activeElement)).toBe(describeElement(goButton()));
  });

  test("⟳: the popover says why «Заменить» cannot go and offers «Повторить»", async () => {
    const { engine } = await openReview({ categories: [PARIS], sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 4, written: 4, categories: ["home", "travel"] }] });
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    engine.failNext("scenes.estimateWrite", REFUSED);
    fireEvent.click(within(sceneCard(2)).getByRole("button", { name: "Другая сцена вместо 02" }));
    await flush();
    const pop = within(sceneCard(2)).getByRole("dialog", { name: "Другая сцена" });
    const replace = within(pop).getByRole("button", { name: "Заменить · до …" });
    expect(isDisabled(replace)).toBe(true);
    expect(describedText(replace)).toContain(WHY);
    await retryPrice(pop);
    const priced = await within(pop).findByRole("button", { name: "Заменить · до $0.075" });
    expect(isDisabled(priced)).toBe(false);
    expect(describeElement(document.activeElement)).toBe(describeElement(priced));
  });

  test("«Написать N сцен»: the idea form says why and offers «Повторить»", async () => {
    const { engine } = await openReview({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 3, written: 3, categories: ["home"] }] });
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    engine.failNext("scenes.estimateWrite", REFUSED);
    fireEvent.click(within(column()).getByRole("button", { name: "Своя сцена" }));
    await flush();
    const form = within(column()).getByRole("region", { name: "Своя сцена · по описанию" });
    fireEvent.change(within(form).getByRole("textbox"), { target: { value: "Пикник в парке осенью" } });
    await flush();
    const write = within(form).getByRole("button", { name: nb("Написать 1 сцену · до …") });
    expect(isDisabled(write)).toBe(true);
    expect(describedText(write)).toContain(WHY);
    await retryPrice(form);
    const priced = await within(form).findByRole("button", { name: nb("Написать 1 сцену · до $0.075") });
    expect(isDisabled(priced)).toBe(false);
    expect(describeElement(document.activeElement)).toBe(describeElement(priced));
  });

  test("«Повторить» of a cut-off rewrite: the notice says why its price is missing and asks again", async () => {
    const { engine, client } = await openReview({
      sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-rw-0001", count: 6, written: 6, writes: 1, reviewWrites: [{ kind: "rewrite", k: 2, sceneIds: [2], redraw: true, cutOff: true }] }],
    });
    await within(column()).findByRole("button", { name: "Повторить · до $0.038" });
    engine.failNext("scenes.estimateWrite", REFUSED);
    await reconcile(client);
    const notice = await within(column()).findByRole("status");
    const resume = within(notice).getByRole("button", { name: "Повторить · до …" });
    expect(isDisabled(resume)).toBe(true);
    expect(describedText(resume)).toContain(WHY);
    await retryPrice(notice);
    const priced = await within(column()).findByRole("button", { name: "Повторить · до $0.038" });
    expect(isDisabled(priced)).toBe(false);
    expect(describeElement(document.activeElement)).toBe(describeElement(priced));
  });

  test("«Другие сцены для N»: the gave-up notice says why and offers «Повторить»", async () => {
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
    engine.failNext("scenes.estimateWrite", REFUSED);
    runAll(scheduler);
    await flush();
    const notice = within(column()).getByRole("status");
    const others = within(notice).getByRole("button", { name: "Другие сцены для 5 · до …" });
    expect(isDisabled(others)).toBe(true);
    expect(describedText(others)).toContain(WHY);
    await retryPrice(notice);
    const priced = await within(notice).findByRole("button", { name: "Другие сцены для 5 · до $0.075" });
    expect(isDisabled(priced)).toBe(false);
    expect(describeElement(document.activeElement)).toBe(describeElement(priced));
  });
});
