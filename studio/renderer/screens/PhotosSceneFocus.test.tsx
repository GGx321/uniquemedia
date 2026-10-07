import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describeElement, flush, runAll } from "../testing";
import { MIA, PARIS } from "./photos/categoryScreenKit";
import { card, column, goButton, isDisabled, nb, openReview, sceneCard } from "./photos/sceneScreenKit";

// CS.7 M4: where the focus lands after the review's paid clicks and when their jobs end (README «Keyboard and focus»). A click that starts a job hands the
// focus to that job's «Отменить» — «Составить» like «Дописать», «Отрисовать» to the run's; when the job ends with the focus on its «Отменить» (gone now) or
// nowhere, it goes to what the job made — the first scene it wrote or replaced — or, when it made nothing, to the column title «Сцены», whose notice says
// why. Never to a paid button, and never away from where the owner put it meanwhile.

const focused = (): string => describeElement(document.activeElement);
const cancelButton = (): HTMLElement => within(column()).getByRole("button", { name: "Отменить" });
const columnTitle = (): HTMLElement => within(column()).getByRole("heading", { name: "Сцены" });

async function composed() {
  const harness = await openReview();
  fireEvent.click(await screen.findByRole("button", { name: nb("Составить 20 сцен · до $0.075") }));
  await flush();
  return harness;
}

describe("a compose", () => {
  test("«Составить» hands the focus to the job's «Отменить»; the end of the compose to the first scene it wrote", async () => {
    const { scheduler } = await composed();
    await waitFor(() => expect(focused()).toBe(describeElement(cancelButton())));
    runAll(scheduler);
    await flush();
    expect(within(column()).queryByRole("button", { name: "Отменить" }) === null).toBe(true);
    expect(focused()).toBe(describeElement(sceneCard(1)));
  });

  test("cancelled, it wrote nothing: the focus goes to the column title, whose notice says what stopped", async () => {
    const { scheduler } = await composed();
    await waitFor(() => expect(focused()).toBe(describeElement(cancelButton())));
    fireEvent.click(cancelButton());
    await flush();
    runAll(scheduler);
    await flush();
    expect(within(column()).getByText(/^Составление остановлено/)).toBeDefined();
    expect(focused()).toBe(describeElement(columnTitle()));
  });

  test("a focus the owner moved elsewhere meanwhile stays there", async () => {
    const { scheduler } = await composed();
    await waitFor(() => expect(focused()).toBe(describeElement(cancelButton())));
    const sheet = within(card()).getByRole("button", { name: /^Мои категории/ });
    sheet.focus();
    runAll(scheduler);
    await flush();
    expect(focused()).toBe(describeElement(sheet));
  });
});

describe("⟳ and «Дописать»", () => {
  test("⟳: once the other scene is written the focus goes to that scene's card", async () => {
    const { scheduler } = await openReview({ categories: [PARIS], sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 4, written: 4, categories: ["home", "travel"] }] });
    await waitFor(() => expect(goButton().textContent).toContain("Отрисовать"));
    fireEvent.click(within(sceneCard(3)).getByRole("button", { name: "Другая сцена вместо 03" }));
    await flush();
    fireEvent.click(await within(sceneCard(3)).findByRole("button", { name: "Заменить · до $0.075" }));
    await flush();
    await waitFor(() => expect(focused()).toBe(describeElement(cancelButton())));
    runAll(scheduler);
    await flush();
    expect(within(sceneCard(3)).getByText("новая")).toBeDefined();
    expect(focused()).toBe(describeElement(sceneCard(3)));
  });

  test("«Дописать»: once the waiting scenes are written the focus goes to the first of them", async () => {
    const { client, scheduler } = await openReview({
      sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-cut-0001", count: 60, written: 25, stopped: "closed", cutOff: { chunk: 2 }, categories: ["home", "travel"] }],
    });
    await waitFor(() => expect(goButton().textContent).toBe(nb("Дописать 35 сцен · до $0.12")));
    await act(async () => {
      const reply = await client.request("money.reconcile", {});
      if (!reply.ok) throw new Error(reply.error.code);
    });
    await flush();
    await waitFor(() => expect(isDisabled(goButton())).toBe(false));
    fireEvent.click(goButton());
    await flush();
    await waitFor(() => expect(focused()).toBe(describeElement(cancelButton())));
    runAll(scheduler);
    await flush();
    expect(within(sceneCard(26)).queryByText("ждёт") === null).toBe(true);
    expect(focused()).toBe(describeElement(sceneCard(26)));
  });
});

describe("«Отрисовать»", () => {
  test("hands the focus to the run's «Отменить»; the run's end to the column title, over its outcome", async () => {
    const { scheduler } = await openReview({ sceneSets: [{ avatarId: MIA.avatarId, sceneSetId: "set-seed-0001", count: 5, written: 5, categories: ["home"] }] });
    await waitFor(() => expect(goButton().textContent).toBe(nb("Отрисовать 5 фото · до $0.75")));
    fireEvent.click(goButton());
    await flush();
    await waitFor(() => expect(within(column()).getByText(/^Рисуем фото: 0 из 5/)).toBeDefined());
    expect(focused()).toBe(describeElement(cancelButton()));
    runAll(scheduler);
    await flush();
    expect(within(column()).getByText("Запуск завершён")).toBeDefined();
    expect(focused()).toBe(describeElement(columnTitle()));
  });
});
