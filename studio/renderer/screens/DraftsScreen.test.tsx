import { describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { ERROR_MESSAGES_RU } from "../../shared/engine";
import { freePhotos, PHOTO_IDS } from "../engine/mockEngine.testkit";
import { callsOf, describeElement, flush, focusedLabel, runAll, tick } from "../testing";
import { asAnotherWindow, makeDraft, MIA, openDrafts, SOFIA, studio } from "./montage/screenKit";

// 3d.2: the drafts screen (EditorEmpty.dc.html), where the sidebar's «Монтаж» leads.

const runOne = (scheduler: Parameters<typeof tick>[0]): void => tick(scheduler);
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

  test("no drafts yet: the how-to card and the «Новый ролик» tile, which leads to the photos", async () => {
    await studio();
    await openDrafts();
    expect(await screen.findByText(`0 черновиков`)).toBeDefined();
    expect(cards()).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: /Новый ролик/ }));
    await screen.findByRole("heading", { level: 1, name: "Mia" });
  });

  test("«Открыть» opens the draft in the editor", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [PHOTO_IDS[0] ?? ""]);
    await openDrafts();
    fireEvent.click(within(card("Mia · без названия")).getByRole("button", { name: "Открыть" }));
    await screen.findByRole("heading", { level: 1, name: "Mia · без названия" });
    expect(screen.getByRole("region", { name: "Таймлайн" })).toBeDefined();
  });

  test("the avatar segment shows one avatar's drafts", async () => {
    const photos = [...freePhotos(3), ...freePhotos(2, SOFIA)];
    const { client } = await studio({ avatars: [MIA, SOFIA], photos });
    await makeDraft(client, MIA.avatarId, []);
    await makeDraft(client, SOFIA.avatarId, []);
    await openDrafts();
    expect(cards()).toHaveLength(2);

    const segment = screen.getByRole("group", { name: "Аватар" });
    fireEvent.click(within(segment).getByRole("button", { name: "Sofia" }));
    expect(cards()).toHaveLength(1);
    expect(screen.getByRole("heading", { level: 3, name: "Sofia · без названия" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Открыть фото Sofia" })).toBeDefined();
  });

  test("a failed list is shown with a retry", async () => {
    const { engine } = await studio();
    engine.failNext("montages.list", { code: "LIBRARY_UNAVAILABLE" });
    await openDrafts();
    await screen.findByText(ERROR_MESSAGES_RU.LIBRARY_UNAVAILABLE);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await waitFor(() => expect(screen.queryByText(ERROR_MESSAGES_RU.LIBRARY_UNAVAILABLE) === null).toBe(true));
    expect(await screen.findByText(`0 черновиков`)).toBeDefined();
  });

  test("the list follows drafts made and deleted elsewhere", async () => {
    const { client } = await studio();
    await openDrafts();
    const made = await makeDraft(client, MIA.avatarId, []);
    await waitFor(() => expect(cards()).toHaveLength(1));
    await asAnotherWindow(() => client.request("montages.delete", { montageId: made.montageId }));
    await waitFor(() => expect(cards()).toHaveLength(0));
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
  test("the card's percent is the job model's, and the saving phase says «Сохранение…» instead of a percent", async () => {
    const { client, scheduler } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [PHOTO_IDS[0] ?? ""]);
    await openDrafts();
    await asAnotherWindow(() => client.request("videos.render", { montageId: made.montageId }));
    const bar = await screen.findByRole("progressbar", { name: "Рендер: Mia · без названия" });
    expect(bar.getAttribute("aria-valuenow")).toBe("0");

    let sawPercent = false;
    let sawSaving = false;
    for (let i = 0; i < 40 && !sawSaving; i++) {
      runOne(scheduler);
      await flush();
      const article = card("Mia · без названия");
      sawSaving = within(article).queryByText("Сохранение…") !== null;
      const now = within(article).queryByRole("progressbar")?.getAttribute("aria-valuenow");
      if (now !== undefined && now !== null && Number(now) > 0 && !sawSaving) {
        sawPercent = true;
        expect(within(article).getByText(new RegExp(`^${now}\\s%$`))).toBeDefined();
        expect(Number(now)).toBeLessThan(100);
      }
      if (sawSaving) expect(within(article).queryByText(/\d\s%/) === null).toBe(true);
    }
    expect(sawPercent).toBe(true);
    expect(sawSaving).toBe(true);
  });
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

  test("the keyboard (slice review 5-M4): asked, the focus is on «Отмена»; Escape and «Отмена» give it back to the trash; deleted, it lands on the list's heading", async () => {
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, []);
    await openDrafts();
    const trash = (): HTMLElement => screen.getByRole("button", { name: "Удалить черновик Mia · без названия" });
    const cancel = (): HTMLElement => within(screen.getByRole("alert")).getByRole("button", { name: "Отмена" });
    // A key on the focused trash (the test DOM moves no focus on a click).
    const ask = async (): Promise<void> => {
      trash().focus();
      fireEvent.click(trash());
      await flush();
    };

    await ask();
    expect(focusedLabel()).toBe(describeElement(cancel()));
    // The trash stays in the tab order while the question is open; pressing it again asks nothing more.
    expect(trash().hasAttribute("disabled")).toBe(false);
    expect(trash().getAttribute("aria-disabled")).toBe("true");
    fireEvent.keyDown(cancel(), { key: "Escape" });
    await flush();
    expect(screen.queryByRole("alert") === null).toBe(true);
    expect(focusedLabel()).toBe(describeElement(trash()));

    await ask();
    fireEvent.click(cancel());
    await flush();
    expect(focusedLabel()).toBe(describeElement(trash()));

    await ask();
    fireEvent.click(within(screen.getByRole("alert")).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(cards()).toHaveLength(0));
    expect(focusedLabel()).toBe(describeElement(screen.getByRole("heading", { level: 2, name: "Черновики" })));
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

  test("under «Все» with several avatars it asks which one", async () => {
    const { engine } = await studio({ avatars: [MIA, SOFIA], photos: freePhotos(2) });
    await openDrafts();
    fireEvent.click(screen.getByRole("button", { name: "Пустой ролик" }));
    const menu = screen.getByRole("menu", { name: "Для какого аватара" });
    fireEvent.click(within(menu).getByRole("menuitem", { name: "Sofia" }));
    await screen.findByRole("heading", { level: 1, name: "Sofia · без названия" });
    expect(callsOf(engine, "montages.create").at(-1)?.payload).toEqual({ avatarId: SOFIA.avatarId, photoIds: [] });
  });

  test("with no avatar at all it is disabled, and says why", async () => {
    await studio({ avatars: [], photos: [] });
    await openDrafts();
    const button = screen.getByRole("button", { name: "Пустой ролик" });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toBe("Сначала нужен аватар");
    expect(screen.queryByRole("button", { name: /Открыть фото/ }) === null).toBe(true);
  });
});
