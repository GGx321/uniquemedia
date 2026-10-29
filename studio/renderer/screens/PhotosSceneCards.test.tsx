import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { callsOf, describeElement, flush, inAct, runAll } from "../testing";
import { category, MIA, PARIS } from "./photos/categoryScreenKit";
import { ATTEMPT, card, column, fieldValue, goButton, isDisabled, LLM_ONLY_REF, nb, openReview, priceRow, querySceneCard, sceneCard } from "./photos/sceneScreenKit";

// CS.6: the «Сцены» column with a set open: the scene cards (remove and restore, the pencil's edit with its problem and Cyrillic hint, «не составлена»), ⟳
// with its price popover (a redraw for a planned scene, a rewrite from the idea for an own one, a deleted category, paid calls stopped), a rewrite running,
// and «+ Своя сцена · по описанию» with its placeholders. The artboards are ReviewReady, ReviewEdit, ReviewRewriting, ReviewAddIdea, ReviewIdeaWriting and
// ReviewEmpty, and the ReviewStates sheet (B: cards, C: popovers, D: the idea form). Every edit sends the revision it was made on; the approve price is
// asked again after each change.

const SET = "set-seed-0001";

/** Mia with a written set of `count` planned scenes in `categories`. */
function ready(count = 6, categories: readonly string[] = [LLM_ONLY_REF]) {
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
});

describe("⟳ and its price popover", () => {
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
    // «Авто» on its own keeps «Кадр» in the form's one row at 1200; what it picks is in the hint (CS.7 V3; CS.8: the mirror only when the idea names one).
    expect(within(form).getByRole("option", { name: "Авто" })).toBeDefined();
    expect(form.textContent).toContain("Зеркало — только если оно есть в идее.");
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

});
