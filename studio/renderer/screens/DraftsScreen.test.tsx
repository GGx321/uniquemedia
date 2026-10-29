import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import { callsOf, flush, runAll } from "../testing";
import { asAnotherWindow, makeDraft, MIA, openDrafts, studio } from "./montage/screenKit";

// 3d.2: the drafts screen (EditorEmpty.dc.html), where the sidebar's «Монтаж» leads.

const cards = (): HTMLElement[] => screen.queryAllByRole("article");
const card = (name: string): HTMLElement => {
  const found = cards().find((c) => within(c).queryByRole("heading", { level: 3, name }) !== null);
  if (found === undefined) throw new Error(`no draft card «${name}»`);
  return found;
};

describe("the list", () => {
  test("«Монтаж» opens the drafts: the how-to card on top, then every draft, newest first", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? ""]);
    await makeDraft(client, MIA.avatarId, []);
    await openDrafts();

    expect(await screen.findByText(`2 черновика`)).toBeDefined();
    expect(screen.getByRole("heading", { level: 2, name: "Фото для нового ролика ещё не выбраны" })).toBeDefined();
    expect(screen.getByRole("list", { name: "Как начать" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Открыть фото Mia" })).toBeDefined();
    expect(screen.getByText("2 · сохраняются сами")).toBeDefined();

    const [newest, older] = cards();
    expect(within(newest ?? document.body).getByText("нет кадров")).toBeDefined();
    expect(within(older ?? document.body).getByText(`8.0 с · 1 кадр · без текста`)).toBeDefined();
    expect(within(older ?? document.body).getByRole("heading", { level: 3, name: "Mia · без названия" })).toBeDefined();
  });

  test("«Открыть» opens the draft in the editor", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [PHOTO_IDS[0] ?? ""]);
    await openDrafts();
    fireEvent.click(within(card("Mia · без названия")).getByRole("button", { name: "Открыть" }));
    await screen.findByRole("heading", { level: 1, name: "Mia · без названия" });
    expect(screen.getByRole("region", { name: "Таймлайн" })).toBeDefined();
  });

});

describe("what a card says about its render", () => {
  test("a rejected photo is named in amber: the render is not possible until it is replaced", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? "", PHOTO_IDS[2] ?? "", PHOTO_IDS[3] ?? "", PHOTO_IDS[4] ?? ""]);
    await asAnotherWindow(() => client.request("photos.setRejected", { avatarId: MIA.avatarId, photoId: PHOTO_IDS[1] ?? "", rejected: true }));
    await openDrafts();
    const note = await screen.findByText("Кадр 2: фото отклонено — замените его, иначе рендер недоступен");
    expect(note.closest("article")?.className).toContain("draft-card-warn");
  });

  test("a running render shows its progress; once done, the card counts the video", async () => {
    const { client, scheduler } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [PHOTO_IDS[0] ?? ""]);
    await openDrafts();
    await asAnotherWindow(() => client.request("videos.render", { montageId: made.montageId }));
    expect(await screen.findByRole("progressbar", { name: "Рендер: Mia · без названия" })).toBeDefined();
    expect(screen.getByText(/1\sрендер идёт/)).toBeDefined();

    runAll(scheduler);
    await flush();
    await screen.findByText(`✓ уже 1 видео из этого черновика`);
    expect(screen.queryByRole("progressbar") === null).toBe(true);
  });

  // 3d.6: the card reads the render as the editor and the sidebar do (the job model): the floor percent of frames, and the
  // saving phase is not «100 %».
  
});

describe("delete", () => {
  test("a draft is deleted only after its confirmation", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, []);
    await openDrafts();
    fireEvent.click(screen.getByRole("button", { name: "Удалить черновик Mia · без названия" }));
    expect(callsOf(engine, "montages.delete")).toHaveLength(0);
    const confirm = screen.getByRole("alert");
    expect(confirm.textContent).toContain("Удалить черновик?");

    fireEvent.click(within(confirm).getByRole("button", { name: "Отмена" }));
    expect(cards()).toHaveLength(1);

    fireEvent.click(screen.getByRole("button", { name: "Удалить черновик Mia · без названия" }));
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(cards()).toHaveLength(0));
    expect(callsOf(engine, "montages.delete")).toHaveLength(1);
  });

});

describe("«Пустой ролик»", () => {
  test("with one avatar it makes an empty draft for it and opens it (EditorNew)", async () => {
    const { engine } = await studio();
    await openDrafts();
    fireEvent.click(screen.getByRole("button", { name: "Пустой ролик" }));
    await screen.findByRole("heading", { level: 1, name: "Mia · без названия" });
    expect(callsOf(engine, "montages.create").at(-1)?.payload).toEqual({ avatarId: MIA.avatarId, photoIds: [] });
    expect(screen.getByText("черновик · создан только что")).toBeDefined();
    expect(screen.getByText("Ролик пока пуст")).toBeDefined();
  });

});
