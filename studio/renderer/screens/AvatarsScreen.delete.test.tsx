import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { LaunchView, type AvatarSummary, type Draft } from "../../shared/engine";
import { view as launchFixture } from "../../shared/engine/autopilot.fixtures";
import { DEFAULT_TRAITS } from "../lib/traits";
import { mockDescriptor, type MockEngine } from "../engine/mockEngine";
import { freePhotos, NORA, PHOTO_IDS, SOFIA } from "../engine/mockEngine.testkit";
import { callsOf, describeElement, flush, focusedLabel, runAll, setup } from "../testing";
import { asAnotherWindow, makeDraft, MIA, studio, withCounts } from "./montage/screenKit";

// «Удалить аватар» on the Avatars screen: a trash button on the card of an active, an archived and a draft avatar; its confirmation (inline, like a draft's:
// the focus on «Отмена», Escape cancels) shows what would go and says it goes to the Trash; «Удалить» is main's `avatars.delete`, and the card goes with the
// engine's `avatar.removed`.

const SENTENCE = "Аватар, его фото, черновики и готовые видео уйдут в Корзину — оттуда их можно вернуть.";

const A_DRAFT: Draft = { avatarId: "avatar-draft-0009", traits: DEFAULT_TRAITS, descriptor: mockDescriptor(DEFAULT_TRAITS), candidates: [{ avatarId: "avatar-draft-0009", photoId: "photo-cand-0001" }, { avatarId: "avatar-draft-0009", photoId: "photo-cand-0002" }], hiddenBelowThreshold: 0, estimate: null };

const trash = (name = "Mia"): HTMLElement => screen.getByRole("button", { name: `Удалить аватар ${name}` });
const panel = (): HTMLElement => screen.getByRole("alert");
/** The confirmation as read: a no-break space is a space. */
const panelText = (): string => (panel().textContent ?? "").replace(/\u00a0/g, " ");
const cardNames = (): string[] => screen.queryAllByRole("heading", { level: 2 }).map((h) => h.textContent ?? "");

/** The trash pressed with the focus on it (the test DOM moves no focus on a click), and the preview answered. */
async function ask(name = "Mia"): Promise<void> {
  trash(name).focus();
  fireEvent.click(trash(name));
  await flush();
}

async function withMia(extra: { avatars?: AvatarSummary[]; drafts?: Draft[] } = {}) {
  const photos = [...freePhotos(6), ...freePhotos(2, SOFIA)];
  const avatars = [MIA, SOFIA, ...(extra.avatars ?? [])].map((a) => withCounts(a, photos));
  const harness = setup({ avatars, photos, ...(extra.drafts === undefined ? {} : { drafts: extra.drafts }) });
  await screen.findByRole("heading", { level: 2, name: "Mia" });
  return harness;
}

describe("the button", () => {
  test("is on the card of an active avatar, an archived one and a draft, and not on the «Новый аватар» tile", async () => {
    await withMia({ avatars: [NORA], drafts: [A_DRAFT] });

    expect(screen.getByRole("button", { name: "Удалить аватар Mia" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Удалить аватар Nora" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Удалить черновик аватара" })).toBeDefined();
    expect(screen.getAllByRole("button", { name: /^Удалить/ })).toHaveLength(4);
  });

  test("asks nothing of the engine until it is pressed", async () => {
    const { engine } = await withMia();

    expect(callsOf(engine, "avatars.deletePreview")).toHaveLength(0);
    expect(callsOf(engine, "avatars.delete")).toHaveLength(0);
  });
});

describe("the confirmation", () => {
  test("pressing the trash asks the engine what would go and shows it with the Trash sentence; nothing is deleted yet", async () => {
    const { engine } = await withMia();

    await ask();

    expect(callsOf(engine, "avatars.deletePreview").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId }]);
    expect(callsOf(engine, "avatars.delete")).toHaveLength(0);
    expect(panelText()).toContain("6 фото");
    expect(panelText()).toContain(SENTENCE);
  });

  test("counts the drafts, the videos and the video files found", async () => {
    const { client, scheduler } = await studio({ photos: freePhotos(6) });
    await makeDraft(client, MIA.avatarId, [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? ""]);
    const second = await makeDraft(client, MIA.avatarId, [PHOTO_IDS[2] ?? ""]);
    await asAnotherWindow(() => client.request("videos.render", { montageId: second.montageId }));
    runAll(scheduler);
    await flush();

    await ask();

    expect(panelText()).toContain("2 черновика монтажа");
    expect(panelText()).toContain("Видео: 1");
    expect(panelText()).toContain("1 из 1");
  });

  test("a video whose file is not in «Готовые видео» now is said to stay where it is", async () => {
    const { client, engine, scheduler } = await studio({ photos: freePhotos(6) });
    const made = await makeDraft(client, MIA.avatarId, [PHOTO_IDS[0] ?? ""]);
    const rendered = await asAnotherWindow(() => client.request("videos.render", { montageId: made.montageId }));
    if (!rendered.ok) throw new Error("the render was refused");
    runAll(scheduler);
    await flush();
    engine.setVideoFileState(rendered.result.videoId, "missing");

    await ask();

    expect(panelText()).toContain("не уйдут");
    expect(panelText()).not.toContain("0 из 1");
    expect(panelText()).not.toContain("они уйдут в Корзину");
    expect(panelText()).toContain("останутся как есть");
  });

  test("says how to get it back: the avatar and each video file are separate things in the Trash, and Studio is restarted to see the avatar again", async () => {
    await withMia();

    await ask();

    expect(panelText()).toContain("отдельными");
    expect(panelText()).toContain("перезапустите Studio");
  });

  test("says that the owner's own files («Мои») are not touched", async () => {
    await withMia();

    await ask();

    expect(panelText()).toContain("«Мои»");
  });

  test("the focus is on «Отмена»; Escape and «Отмена» give it back to the trash", async () => {
    await withMia();

    await ask();
    const cancel = (): HTMLElement => within(panel()).getByRole("button", { name: "Отмена" });
    expect(focusedLabel()).toBe(describeElement(cancel()));
    // The trash stays in the tab order while the question is open, and pressing it again asks nothing more.
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
  });

  test("cancelling deletes nothing and leaves the card", async () => {
    const { engine } = await withMia();
    await ask();

    fireEvent.click(within(panel()).getByRole("button", { name: "Отмена" }));
    await flush();

    expect(callsOf(engine, "avatars.delete")).toHaveLength(0);
    expect(cardNames()).toContain("Mia");
  });

  test("«Удалить» is the danger button", async () => {
    await withMia();
    await ask();

    expect(within(panel()).getByRole("button", { name: "Удалить" }).className).toContain("btn-d");
  });
});

describe("deleting", () => {
  test("«Удалить» sends avatars.delete for the avatar, and the card is gone from the grid", async () => {
    const { engine } = await withMia();
    await ask();

    fireEvent.click(within(panel()).getByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(cardNames()).not.toContain("Mia"));
    expect(callsOf(engine, "avatars.delete").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId }]);
    expect(cardNames()).toContain("Sofia");
  });

  test("the focus lands on the screen's title, not on the body", async () => {
    await withMia();
    await ask();

    fireEvent.click(within(panel()).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(cardNames()).not.toContain("Mia"));

    expect(focusedLabel()).toBe(describeElement(screen.getByRole("heading", { level: 1, name: "Аватары" })));
  });

  test("while it is on its way the buttons are off and the question is busy", async () => {
    const { engine, scheduler } = await withMia();
    engine.delayNext("avatars.delete", 50);
    await ask();

    fireEvent.click(within(panel()).getByRole("button", { name: "Удалить" }));
    await flush();

    expect(within(panel()).getByRole("button", { name: "Удалить" }).hasAttribute("disabled")).toBe(true);
    expect(within(panel()).getByRole("button", { name: "Отмена" }).hasAttribute("disabled")).toBe(true);
    runAll(scheduler);
    await waitFor(() => expect(cardNames()).not.toContain("Mia"));
  });

  test("the focus stays in the confirmation while the delete runs: never on the body", async () => {
    const { engine, scheduler } = await withMia();
    engine.delayNext("avatars.delete", 50);
    await ask();
    const confirm = within(panel()).getByRole("button", { name: "Удалить" });
    confirm.focus();

    fireEvent.click(confirm);
    await flush();

    expect(panel().contains(document.activeElement)).toBe(true);
    runAll(scheduler);
    await waitFor(() => expect(cardNames()).not.toContain("Mia"));
  });

  test("a second press while it is on its way sends nothing more", async () => {
    const { engine, scheduler } = await withMia();
    engine.delayNext("avatars.delete", 50);
    await ask();

    const button = within(panel()).getByRole("button", { name: "Удалить" });
    fireEvent.click(button);
    fireEvent.click(button);
    await flush();
    runAll(scheduler);
    await flush();

    expect(callsOf(engine, "avatars.delete")).toHaveLength(1);
  });

  test("an archived avatar is deleted like an active one", async () => {
    await withMia({ avatars: [NORA] });
    await ask("Nora");

    fireEvent.click(within(panel()).getByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(cardNames()).not.toContain("Nora"));
  });

  test("a draft is deleted from its card", async () => {
    const { engine } = await withMia({ drafts: [A_DRAFT] });
    fireEvent.click(screen.getByRole("button", { name: "Удалить черновик аватара" }));
    await flush();
    expect(panelText()).toContain("2 варианта");

    fireEvent.click(within(panel()).getByRole("button", { name: "Удалить" }));

    await waitFor(() => expect(screen.queryByRole("button", { name: "Удалить черновик аватара" }) === null).toBe(true));
    expect(callsOf(engine, "avatars.delete").map((c) => c.payload)).toEqual([{ avatarId: A_DRAFT.avatarId }]);
  });
});

describe("what goes wrong", () => {
  test("an avatar that is busy (a render is running) is said to be busy, and offers no «Удалить»", async () => {
    const { client, engine } = await studio({ photos: freePhotos(6) });
    const made = await makeDraft(client, MIA.avatarId, [PHOTO_IDS[0] ?? ""]);
    await asAnotherWindow(() => client.request("videos.render", { montageId: made.montageId }));

    await ask();

    expect(panelText()).toContain("занят");
    expect(panelText()).toContain("удаляется другой аватар");
    expect(within(panel()).queryByRole("button", { name: "Удалить" }) === null).toBe(true);
    expect(within(panel()).getByRole("button", { name: "Отмена" })).toBeDefined();
    expect(callsOf(engine, "avatars.delete")).toHaveLength(0);
  });

  test("a Trash that refuses is told in Russian, the avatar stays, and the question stays open with the focus on «Отмена»", async () => {
    const { engine } = await withMia();
    engine.failNext("avatars.delete", { code: "TRASH_UNAVAILABLE" });
    await ask();

    const confirm = within(panel()).getByRole("button", { name: "Удалить" });
    confirm.focus();
    fireEvent.click(confirm);
    await flush();

    expect(screen.getByText(/Системная Корзина не приняла папку аватара/)).toBeDefined();
    expect(cardNames()).toContain("Mia");
    expect(within(panel()).getByRole("button", { name: "Удалить" }).hasAttribute("disabled")).toBe(false);
    expect(focusedLabel()).toBe(describeElement(within(panel()).getByRole("button", { name: "Отмена" })));
  });

  test("a preview the engine could not make is shown, with «Отмена» and no «Удалить»", async () => {
    const { engine } = await withMia();
    engine.failNext("avatars.deletePreview", { code: "LIBRARY_UNAVAILABLE" });

    await ask();

    expect(screen.getByText(/Папка библиотеки недоступна/)).toBeDefined();
    expect(within(panel()).queryByRole("button", { name: "Удалить" }) === null).toBe(true);
  });

  test("an avatar that is gone by the time «Удалить» is pressed is told so", async () => {
    const { engine } = await withMia();
    await ask();
    engine.failNext("avatars.delete", { code: "NOT_FOUND" });

    fireEvent.click(within(panel()).getByRole("button", { name: "Удалить" }));
    await flush();

    expect(screen.getByText("Запрошенный объект не найден.")).toBeDefined();
  });

  test("video files that stayed behind are told once the avatar is gone", async () => {
    const { engine } = await withMia();
    engine.keepVideoFilesOnDelete(2);
    await ask();

    fireEvent.click(within(panel()).getByRole("button", { name: "Удалить" }));

    await screen.findByText(/2 видео не удалось переместить в Корзину/);
    expect(cardNames()).not.toContain("Mia");
  });

  test("the notice names the folder the files stayed in", async () => {
    const { client, engine, scheduler } = await studio({ photos: freePhotos(6) });
    const made = await makeDraft(client, MIA.avatarId, [PHOTO_IDS[0] ?? ""]);
    await asAnotherWindow(() => client.request("videos.render", { montageId: made.montageId }));
    runAll(scheduler);
    await flush();
    engine.keepVideoFilesOnDelete(1);
    await ask();

    fireEvent.click(within(panel()).getByRole("button", { name: "Удалить" }));

    await screen.findByText(/«Готовые видео\/Mia»/);
  });

  test("a notice about video files that stayed behind outlives the screen: it is still there when the owner comes back, until dismissed", async () => {
    const { engine } = await withMia();
    engine.keepVideoFilesOnDelete(2);
    await ask();
    fireEvent.click(within(panel()).getByRole("button", { name: "Удалить" }));
    await screen.findByText(/2 видео не удалось переместить в Корзину/);

    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    await flush();
    fireEvent.click(screen.getByRole("button", { name: "Аватары" }));
    await flush();
    expect(screen.getByText(/2 видео не удалось переместить в Корзину/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Понятно" }));
    expect(screen.queryByText(/не удалось переместить в Корзину/) === null).toBe(true);
  });

  test("a second delete does not wipe out the unread warning about the first one's files", async () => {
    const { engine } = await withMia();
    engine.keepVideoFilesOnDelete(2);
    await ask();
    fireEvent.click(within(panel()).getByRole("button", { name: "Удалить" }));
    await screen.findByText(/2 видео не удалось переместить в Корзину/);

    await ask("Sofia");
    // the first warning is itself an alert: the question is found by its own class
    const question = document.querySelector<HTMLElement>(".avatar-confirm") ?? document.body;
    fireEvent.click(within(question).getByRole("button", { name: "Удалить" }));
    await screen.findByText(/Аватар «Sofia» в Корзине/);

    expect(screen.getByText(/Аватар «Mia» в Корзине/)).toBeDefined();
    expect(screen.getByText(/2 видео не удалось переместить в Корзину/)).toBeDefined();
    fireEvent.click(screen.getAllByRole("button", { name: "Понятно" })[0] ?? document.body);
    expect(screen.queryByText(/Аватар «Mia» в Корзине/) === null).toBe(true);
    expect(screen.getByText(/Аватар «Sofia» в Корзине/)).toBeDefined();
  });

  test("a Trash that refuses says what to do on THIS system: Windows gets the Recycle Bin advice, macOS its own sentence", async () => {
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, "platform");
    try {
      for (const [platform, expected, absent] of [
        ["Win32", "удалите любой файл с него в Корзину один раз", "Finder"],
        ["MacIntel", "удалите папку аватара вручную в Finder", "в Корзину один раз"],
      ] as const) {
        Object.defineProperty(navigator, "platform", { value: platform, configurable: true });
        const { engine, unmount } = await withMia();
        engine.failNext("avatars.delete", { code: "TRASH_UNAVAILABLE" });
        await ask();
        fireEvent.click(within(panel()).getByRole("button", { name: "Удалить" }));
        await flush();

        expect(panelText()).toContain(expected);
        expect(panelText()).not.toContain(absent);
        unmount();
      }
    } finally {
      Reflect.deleteProperty(navigator, "platform");
      if (original !== undefined) Object.defineProperty(Navigator.prototype, "platform", original);
    }
  });

  test("a draft is spoken of as a draft, whatever the avatar is called", async () => {
    await withMia({ drafts: [A_DRAFT] });
    fireEvent.click(screen.getByRole("button", { name: "Удалить черновик аватара" }));
    await flush();

    fireEvent.click(within(panel()).getByRole("button", { name: "Удалить" }));

    await screen.findByText(/Черновик аватара в Корзине/);
  });

  test("an avatar that is itself called «Черновик» is spoken of by its name, not as a draft", async () => {
    const odd: AvatarSummary = { ...SOFIA, avatarId: "avatar-odd-0007", name: "Черновик" };
    await withMia({ avatars: [odd] });
    fireEvent.click(screen.getByRole("button", { name: "Удалить аватар Черновик" }));
    await flush();

    fireEvent.click(within(panel()).getByRole("button", { name: "Удалить" }));

    await screen.findByText(/Аватар «Черновик» в Корзине/);
  });

  test("nothing is said of video files when none stayed behind", async () => {
    await withMia();
    await ask();

    fireEvent.click(within(panel()).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(cardNames()).not.toContain("Mia"));

    expect(screen.queryByText(/не удалось переместить в Корзину/) === null).toBe(true);
  });
});

describe("S4.10 fix C (M1): an avatar in an unfinished autopilot launch", () => {
  /** The engine's own refusal (engine.ts `#deleteBusy`): the avatar is held by a launch that is not done or stopped. */
  const HELD = { code: "IN_FLIGHT", detail: "the avatar is in an unfinished autopilot launch: stop the launch first" } as const;
  /** HostStates: «Sofia в запуске автопилота от 8 окт., 14:02 — удалить её можно после «Стоп» или конца запуска.» (the day and time in the viewer's zone). */
  const HELD_TEXT = /^Mia в запуске автопилота от \d{1,2} окт\., \d\d:\d\d — удалить её можно после «Стоп» или конца запуска\.$/;
  const PAUSED = { status: "paused", paused: { cause: "owner", at: "2026-10-08T14:06:00.000Z" }, inFlight: { requests: 0, openMicros: 0 } };

  function announce(engine: MockEngine, over: Record<string, unknown> = {}): void {
    act(() => engine.announceLaunch(LaunchView.parse({ ...launchFixture, ...over })));
  }
  const heldLine = (): HTMLElement | undefined => Array.from(panel().querySelectorAll("span")).find((s) => HELD_TEXT.test((s.textContent ?? "").replace(/\u00a0/g, " ")));

  test("a refused preview says whose launch holds the avatar and since when, with «Открыть «Автопилот»» and «Понятно», and nothing to delete", async () => {
    const { engine } = await withMia();
    announce(engine);
    engine.failNext("avatars.deletePreview", HELD);

    await ask();

    expect(heldLine()).toBeDefined();
    expect(panelText()).not.toContain("занят");
    expect(within(panel()).getByRole("button", { name: "Открыть «Автопилот»" })).toBeDefined();
    expect(within(panel()).getByRole("button", { name: "Понятно" })).toBeDefined();
    expect(within(panel()).queryByRole("button", { name: "Удалить" }) === null).toBe(true);
    expect(within(panel()).queryByRole("button", { name: "Отмена" }) === null).toBe(true);
    expect(focusedLabel()).toBe(describeElement(within(panel()).getByRole("button", { name: "Понятно" })));
    expect(callsOf(engine, "avatars.delete")).toHaveLength(0);
  });

  test("«Понятно» closes it and gives the focus back to the trash; Escape does the same", async () => {
    const { engine } = await withMia();
    announce(engine);
    engine.failNext("avatars.deletePreview", HELD);
    await ask();

    fireEvent.click(within(panel()).getByRole("button", { name: "Понятно" }));
    await flush();
    expect(screen.queryByRole("alert") === null).toBe(true);
    expect(focusedLabel()).toBe(describeElement(trash()));

    engine.failNext("avatars.deletePreview", HELD);
    await ask();
    fireEvent.keyDown(within(panel()).getByRole("button", { name: "Понятно" }), { key: "Escape" });
    await flush();
    expect(screen.queryByRole("alert") === null).toBe(true);
    expect(focusedLabel()).toBe(describeElement(trash()));
  });

  test("«Открыть «Автопилот»» opens the Autopilot screen", async () => {
    const { engine } = await withMia();
    announce(engine);
    engine.failNext("avatars.deletePreview", HELD);
    await ask();

    fireEvent.click(within(panel()).getByRole("button", { name: "Открыть «Автопилот»" }));

    expect(await screen.findByRole("heading", { level: 1, name: "Автопилот" })).toBeDefined();
  });

  test("a paused launch holds the avatar too (it is unfinished)", async () => {
    const { engine } = await withMia();
    announce(engine, PAUSED);
    engine.failNext("avatars.deletePreview", HELD);

    await ask();

    expect(heldLine()).toBeDefined();
  });

  test("the delete itself refused after the preview (the launch began meanwhile): the same words, and no «Удалить» left to press", async () => {
    const { engine } = await withMia();
    await ask();
    announce(engine);
    engine.failNext("avatars.delete", HELD);

    fireEvent.click(within(panel()).getByRole("button", { name: "Удалить" }));
    await flush();

    expect(heldLine()).toBeDefined();
    expect(within(panel()).queryByRole("button", { name: "Удалить" }) === null).toBe(true);
    expect(focusedLabel()).toBe(describeElement(within(panel()).getByRole("button", { name: "Понятно" })));
    expect(cardNames()).toContain("Mia");
  });

  test("an avatar the launch does not hold, and a launch that ended, keep the ordinary «занят» words", async () => {
    const { engine } = await withMia();
    announce(engine, { draft: { ...launchFixture.draft, avatarIds: [SOFIA.avatarId] }, avatars: launchFixture.avatars.filter((a) => a.avatarId === SOFIA.avatarId) });
    engine.failNext("avatars.deletePreview", { code: "IN_FLIGHT" });
    await ask();
    expect(panelText()).toContain("занят");
    expect(heldLine() === undefined).toBe(true);
    fireEvent.click(within(panel()).getByRole("button", { name: "Отмена" }));
    await flush();

    announce(engine, { status: "done", endedAt: "2026-10-08T14:31:00.000Z", inFlight: { requests: 0, openMicros: 0 } });
    engine.failNext("avatars.deletePreview", { code: "IN_FLIGHT" });
    await ask();
    expect(panelText()).toContain("занят");
    expect(heldLine() === undefined).toBe(true);
  });

  test("the words stay those of the refusal when the launch ends while they are open", async () => {
    const { engine } = await withMia();
    announce(engine);
    engine.failNext("avatars.deletePreview", HELD);
    await ask();

    announce(engine, { status: "stopped", endedAt: "2026-10-08T14:31:00.000Z", inFlight: { requests: 0, openMicros: 0 } });
    await flush();

    expect(heldLine()).toBeDefined();
  });
});
