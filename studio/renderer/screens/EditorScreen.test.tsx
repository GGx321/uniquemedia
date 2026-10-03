import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { DRAFT_CHANGING_DETAIL, DRAFT_TOO_NEW_DETAIL, ERROR_MESSAGES_RU, type Montage } from "../../shared/engine";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import { callsOf, flush, runAll, tick } from "../testing";
import { AUTOSAVE_DEBOUNCE_MS } from "./montage/autosave";
import { asAnotherWindow, makeDraft, MIA, openDrafts, studio } from "./montage/screenKit";

// 3d.2: the editor shell (Editor.dc.html, EditorNew.dc.html): the header with the draft's name, its save state,
// the output line and «Рендер» with the reason it is disabled; autosave, undo/redo, the echoes of this window's own
// saves; and the states of a draft that cannot be opened.

const P1 = PHOTO_IDS[0] ?? "";
const P2 = PHOTO_IDS[1] ?? "";

/** Opens the one draft there is from the drafts screen, and waits for the editor. */
async function openEditor(): Promise<void> {
  await openDrafts();
  await screen.findByRole("heading", { level: 3, name: /Mia/ });
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();
}

const renderButton = (): HTMLElement => screen.getByRole("button", { name: "Рендер" });
/** The header's output line as read, both of its parts. */
const outputText = (): string | undefined => document.querySelector(".ed-output")?.textContent?.replace(/\s/g, " ");
const header = (): HTMLElement => {
  const found = document.querySelector<HTMLElement>(".ed-head");
  if (found === null) throw new Error("no editor header");
  return found;
};

/** A copy of `montage`'s spec with its first clip `ms` long. */
function withFirstClip(montage: Montage, ms: number): Montage["spec"] {
  const [first, ...rest] = montage.spec.clips;
  if (first === undefined) throw new Error("no clip");
  return { ...montage.spec, clips: [{ ...first, durationMs: ms }, ...rest] };
}

describe("the empty draft (EditorNew)", () => {
  test("nothing to render yet: the reason next to «Рендер», the empty frame and the dashed tracks", async () => {
    const { client } = await studio();
    const made = await makeDraft(client, MIA.avatarId, []);
    await openEditor();

    expect(renderButton().hasAttribute("disabled")).toBe(true);
    expect(screen.getByText("Добавьте хотя бы один кадр").id).toBe(renderButton().getAttribute("aria-describedby") ?? "");
    expect(outputText()).toBe("1080×1920 · 30 fps · 0 с");
    expect(screen.getByText("Ролик пока пуст")).toBeDefined();
    expect(screen.getByRole("button", { name: /Перетащите фото или видео сюда/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /Добавить музыку/ }).hasAttribute("disabled")).toBe(true);
    expect(within(screen.getByRole("complementary", { name: "Свойства" })).getByText("ролик пуст")).toBeDefined();
  });
});

describe("the header", () => {
  test("a rename is saved at once and the title follows; the save line then shows the time", async () => {
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();

    fireEvent.click(screen.getByRole("button", { name: "Переименовать черновик" }));
    const field = screen.getByRole("textbox", { name: "Название черновика" });
    fireEvent.change(field, { target: { value: "  кафе и город " } });
    fireEvent.keyDown(field, { key: "Enter" });

    await screen.findByRole("heading", { level: 1, name: "Mia · «кафе и город»" });
    await waitFor(() => expect(callsOf(engine, "montages.save")).toHaveLength(1));
    expect(callsOf(engine, "montages.save")[0]?.payload).toMatchObject({ montageId: made.montageId, name: "кафе и город" });
    await waitFor(() => expect(within(header()).getByText(/^черновик · сохранён \d\d:\d\d$/)).toBeDefined());
  });

  test("a name the draft cannot take is refused with the reason, and the field stays open", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Переименовать черновик" }));
    const field = screen.getByRole("textbox", { name: "Название черновика" });
    fireEvent.change(field, { target: { value: "кафе\tи город" } });
    fireEvent.keyDown(field, { key: "Enter" });

    expect(screen.getByText("В названии не может быть служебных символов (табуляции и других) — уберите их.")).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Название черновика" }).getAttribute("aria-invalid")).toBe("true");
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
  });

  test("Enter while a word is still being composed (an input method) does not rename yet", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Переименовать черновик" }));
    const field = screen.getByRole("textbox", { name: "Название черновика" });
    fireEvent.change(field, { target: { value: "утро" } });
    fireEvent.keyDown(field, { key: "Enter", isComposing: true });
    expect(screen.getByRole("textbox", { name: "Название черновика" })).toBeDefined();
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
  });

  test("the late echo of an older save of this window changes nothing on screen", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    // The first rename's event is held back; the second one's event makes the store catch up, so the first echo
    // arrives late, after both answers.
    engine.setDelivery(false);
    fireEvent.click(screen.getByRole("button", { name: "Переименовать черновик" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Название черновика" }), { target: { value: "первое" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Название черновика" }), { key: "Enter" });
    await screen.findByRole("heading", { level: 1, name: "Mia · «первое»" });
    await waitFor(() => expect(within(header()).getByText(/^черновик · сохранён/)).toBeDefined());
    engine.setDelivery(true);

    fireEvent.click(screen.getByRole("button", { name: "Переименовать черновик" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Название черновика" }), { target: { value: "второе" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Название черновика" }), { key: "Enter" });
    await waitFor(() => expect(callsOf(engine, "engine.events").length).toBeGreaterThan(0));
    await flush();
    await flush();

    expect(screen.getByRole("heading", { level: 1, name: "Mia · «второе»" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);
  });

  test("a late echo of this window's older version is not taken as a change from elsewhere: no undo steps appear", async () => {
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    // Another window saves 5 s: taken, one undo step back to 8 s.
    await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec: withFirstClip(made, 5_000), name: null }));
    await screen.findByText("5.0 с · ≈ 2.2 МБ");
    const saves = callsOf(engine, "montages.save").length;

    // ⌘Z saves 8 s while events are held: its echo will come late.
    engine.setDelivery(false);
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await waitFor(() => expect(callsOf(engine, "montages.save").length).toBe(saves + 1), { timeout: AUTOSAVE_DEBOUNCE_MS * 4 });
    await waitFor(() => expect(within(header()).getByText(/^черновик · сохранён/)).toBeDefined());
    engine.setDelivery(true);

    // ⇧⌘Z saves 5 s again; its echo reveals the gap, and the held 8 s echo arrives after it.
    fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
    await waitFor(() => expect(callsOf(engine, "montages.save").length).toBe(saves + 2), { timeout: AUTOSAVE_DEBOUNCE_MS * 4 });
    await waitFor(() => expect(callsOf(engine, "engine.events").length).toBeGreaterThan(0));
    for (let i = 0; i < 4; i++) await flush();

    // The history is this window's own: 8 s → 5 s, one step back and no more.
    expect(screen.getByText("5.0 с · ≈ 2.2 МБ")).toBeDefined();
    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await screen.findByText("8.0 с · ≈ 3.5 МБ");
    expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);
  });

  test("the echo of this window's own save is not an undo step", async () => {
    const { client } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    fireEvent.click(screen.getByRole("button", { name: "Переименовать черновик" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Название черновика" }), { target: { value: "утро" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Название черновика" }), { key: "Enter" });
    await screen.findByRole("heading", { level: 1, name: "Mia · «утро»" });
    await flush();
    expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);
  });

  test("a failed save says so, keeps the edit, and saves it again on request", async () => {
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    engine.failNext("montages.save", { code: "LIBRARY_UNAVAILABLE" });
    fireEvent.click(screen.getByRole("button", { name: "Переименовать черновик" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Название черновика" }), { target: { value: "вечер" } });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Название черновика" }), { key: "Enter" });

    await screen.findByText(ERROR_MESSAGES_RU.LIBRARY_UNAVAILABLE);
    expect(within(header()).getByText(/черновик · не сохранён/)).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Сохранить ещё раз" }));
    await waitFor(() => expect(screen.queryByText(ERROR_MESSAGES_RU.LIBRARY_UNAVAILABLE)).toBeNull());
    expect(callsOf(engine, "montages.save").at(-1)?.payload).toMatchObject({ name: "вечер" });
  });
});

/** An unsaved edit: another window saves the clip at 5 s, and ⌘Z brings this window's 8 s back (not yet sent). */
async function unsavedEdit(client: Parameters<typeof makeDraft>[0], made: Montage): Promise<void> {
  await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec: withFirstClip(made, 5_000), name: null }));
  await screen.findByText(/5\.0 с · ≈ 2\.2 МБ/);
  fireEvent.keyDown(window, { key: "z", metaKey: true });
  await screen.findByText(/8\.0 с · ≈ 3\.5 МБ/);
  expect(within(header()).getByText("черновик · сохраняется…")).toBeDefined();
}

describe("leaving never drops an edit (the review's HIGH 1)", () => {
  test("«Черновики» with a save the engine refuses stays on the draft; leaving without it is the owner's choice", async () => {
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await unsavedEdit(client, made);
    engine.failNext("montages.save", { code: "LIBRARY_UNAVAILABLE" });

    fireEvent.click(screen.getByRole("button", { name: "Черновики" }));
    await screen.findByText(ERROR_MESSAGES_RU.LIBRARY_UNAVAILABLE);
    expect(screen.getByRole("region", { name: "Таймлайн" })).toBeDefined();
    expect(screen.queryByRole("heading", { level: 2, name: "Черновики" })).toBeNull();
    expect(within(header()).getByText(/черновик · не сохранён/)).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "Уйти без сохранения" }));
    await screen.findByRole("heading", { level: 2, name: "Черновики" });
  });

  test("the sidebar asks the editor first: a refused save keeps the window on the draft", async () => {
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await unsavedEdit(client, made);
    engine.failNext("montages.save", { code: "INTERNAL", detail: "the draft could not be saved (EIO)" });

    fireEvent.click(screen.getByRole("button", { name: "Аватары" }));
    await screen.findByText(ERROR_MESSAGES_RU.INTERNAL);
    expect(screen.getByRole("region", { name: "Таймлайн" })).toBeDefined();
    expect(screen.getByRole("button", { name: "Монтаж" }).getAttribute("aria-current")).toBe("page");

    // Saved on the second try: the way out goes on to where the owner was going.
    fireEvent.click(screen.getByRole("button", { name: "Сохранить и перейти" }));
    await screen.findByRole("heading", { level: 1, name: "Аватары" });
    expect(callsOf(engine, "montages.save").at(-1)?.payload.spec.clips[0]?.durationMs).toBe(8_000);
  });

  test("the sidebar with an edit on its way saves it first, then goes", async () => {
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await unsavedEdit(client, made);
    const before = callsOf(engine, "montages.save").length;

    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    await screen.findByRole("heading", { level: 1, name: "Настройки" });
    expect(callsOf(engine, "montages.save").length).toBe(before + 1);
  });
});

describe("opening a draft whose last editor is still saving (the review's open question b)", () => {
  /** Leaves the draft with its edit unsaved: the save before leaving is refused, and the owner leaves anyway. */
  async function leaveUnsaved(engine: Awaited<ReturnType<typeof studio>>["engine"]): Promise<void> {
    engine.failNext("montages.save", { code: "LIBRARY_UNAVAILABLE" });
    fireEvent.click(screen.getByRole("button", { name: "Черновики" }));
    await screen.findByRole("button", { name: "Уйти без сохранения" });
  }

  test("the draft is read only once the old editor's save answered, so it opens as saved", async () => {
    const { client, engine, scheduler } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await unsavedEdit(client, made);
    await leaveUnsaved(engine);
    // The editor sends its edit once more as it closes; that save is slow.
    engine.delayNext("montages.save", 10_000);
    fireEvent.click(screen.getByRole("button", { name: "Уйти без сохранения" }));
    await screen.findByRole("heading", { level: 2, name: "Черновики" });

    const gets = callsOf(engine, "montages.get").length;
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await flush();
    expect(callsOf(engine, "montages.get").length).toBe(gets);

    runAll(scheduler);
    await screen.findByRole("region", { name: "Таймлайн" });
    expect(within(header()).getByText(/8\.0 с · ≈ 3\.5 МБ/)).toBeDefined();
  });

  test("after «Уйти без сохранения» a failed last try is not told again: the draft opens as Studio holds it", async () => {
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await unsavedEdit(client, made);
    await leaveUnsaved(engine);
    engine.failNext("montages.save", { code: "LIBRARY_UNAVAILABLE" });
    fireEvent.click(screen.getByRole("button", { name: "Уйти без сохранения" }));
    await screen.findByRole("heading", { level: 2, name: "Черновики" });

    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await screen.findByRole("region", { name: "Таймлайн" });
    expect(screen.queryByText("Последнее изменение не сохранилось")).toBeNull();
    expect(within(header()).getByText(/5\.0 с · ≈ 2\.2 МБ/)).toBeDefined();
  });
});

describe("closing the window or quitting never drops an edit (the review's HIGH 2)", () => {
  const originalClose = window.close;
  afterEach(() => {
    Reflect.set(window, "close", originalClose);
    Reflect.deleteProperty(window, "studio");
  });

  /** Counts `window.close()` calls instead of closing. */
  function spyClose(): { count: () => number } {
    let n = 0;
    Reflect.set(window, "close", () => void (n += 1));
    return { count: () => n };
  }

  function closeWindow(): Event {
    const event = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(event);
    return event;
  }

  test("⌘W with an edit on its way holds the close, saves the edit, then closes the window itself", async () => {
    const closes = spyClose();
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await unsavedEdit(client, made);
    const before = callsOf(engine, "montages.save").length;

    const event = closeWindow();
    expect(event.defaultPrevented).toBe(true);
    await waitFor(() => expect(closes.count()).toBe(1));
    expect(callsOf(engine, "montages.save").length).toBe(before + 1);
    expect(callsOf(engine, "montages.save").at(-1)?.payload.spec.clips[0]?.durationMs).toBe(8_000);
  });

  test("with nothing unsaved the close is not held", async () => {
    const closes = spyClose();
    const { client } = await studio();
    await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    expect(closeWindow().defaultPrevented).toBe(false);
    await flush();
    expect(closes.count()).toBe(0);
  });

  test("a save refused while closing keeps the window; closing without it is the owner's choice", async () => {
    const closes = spyClose();
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await unsavedEdit(client, made);
    engine.failNext("montages.save", { code: "LIBRARY_UNAVAILABLE" });

    expect(closeWindow().defaultPrevented).toBe(true);
    await screen.findByText(ERROR_MESSAGES_RU.LIBRARY_UNAVAILABLE);
    expect(closes.count()).toBe(0);

    fireEvent.click(screen.getByRole("button", { name: "Закрыть без сохранения" }));
    expect(closes.count()).toBe(1);
    // The owner chose to close: the next close is not held again.
    expect(closeWindow().defaultPrevented).toBe(false);
  });

  /** A preload bridge that records main's asks and the owner's «Выйти без сохранения». */
  function bridge(): { asks: (() => Promise<boolean>)[]; quits: () => number } {
    const asks: (() => Promise<boolean>)[] = [];
    let quits = 0;
    Reflect.set(window, "studio", {
      version: async () => "0.0.0",
      onFlushRequest: (handler: () => Promise<boolean>) => {
        asks.push(handler);
        return () => asks.splice(asks.indexOf(handler), 1);
      },
      quitWithoutSaving: () => void (quits += 1),
    });
    return { asks, quits: () => quits };
  }

  test("main's ask before a quit saves the edit and answers «saved» only once it is saved", async () => {
    const main = bridge();
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await unsavedEdit(client, made);
    const before = callsOf(engine, "montages.save").length;
    expect(main.asks).toHaveLength(1);

    const answers = await asAnotherWindow(() => Promise.all(main.asks.map((ask) => ask())));
    expect(answers).toEqual([true]);
    expect(callsOf(engine, "montages.save").length).toBe(before + 1);
    expect(within(header()).getByText(/^черновик · сохранён/)).toBeDefined();
  });

  test("a save refused on the way out of a quit answers «not saved» (the quit is cancelled) and offers «Выйти без сохранения»", async () => {
    const main = bridge();
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await unsavedEdit(client, made);
    engine.failNext("montages.save", { code: "LIBRARY_UNAVAILABLE" });

    const answers = await asAnotherWindow(() => Promise.all(main.asks.map((ask) => ask())));
    expect(answers).toEqual([false]);
    await screen.findByText(ERROR_MESSAGES_RU.LIBRARY_UNAVAILABLE);

    fireEvent.click(screen.getByRole("button", { name: "Выйти без сохранения" }));
    expect(main.quits()).toBe(1);
    // The owner chose: the close that follows is not held again.
    expect(closeWindow().defaultPrevented).toBe(false);
  });
});

describe("undo, redo and the saves of another window", () => {
  test("a save from elsewhere is taken; ⌘Z brings this window's version back and saves it, ⇧⌘Z redoes", async () => {
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(true);

    await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec: withFirstClip(made, 5_000), name: null }));
    await screen.findByText("5.0 с · ≈ 2.2 МБ");
    expect(screen.getByRole("button", { name: "Отменить" }).hasAttribute("disabled")).toBe(false);
    const before = callsOf(engine, "montages.save").length;

    fireEvent.keyDown(window, { key: "z", metaKey: true });
    await screen.findByText("8.0 с · ≈ 3.5 МБ");
    await waitFor(() => expect(callsOf(engine, "montages.save").length).toBe(before + 1), { timeout: AUTOSAVE_DEBOUNCE_MS * 4 });
    expect(callsOf(engine, "montages.save").at(-1)?.payload.spec.clips[0]?.durationMs).toBe(8_000);

    fireEvent.keyDown(window, { key: "z", metaKey: true, shiftKey: true });
    await screen.findByText("5.0 с · ≈ 2.2 МБ");
  });

  test("⌘Z in the name field is the field's own undo, not the draft's", async () => {
    const { client } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec: withFirstClip(made, 5_000), name: null }));
    await screen.findByText("5.0 с · ≈ 2.2 МБ");
    fireEvent.click(screen.getByRole("button", { name: "Переименовать черновик" }));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Название черновика" }), { key: "z", metaKey: true });
    await flush();
    expect(screen.getByText("5.0 с · ≈ 2.2 МБ")).toBeDefined();
  });

  test("a draft deleted elsewhere: the editor says so and saves nothing more", async () => {
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await asAnotherWindow(() => client.request("montages.delete", { montageId: made.montageId }));
    await screen.findByText("Черновик удалён");
    expect(within(header()).getByText("черновик удалён")).toBeDefined();
    expect(screen.getByRole("button", { name: "Переименовать черновик" }).hasAttribute("disabled")).toBe(true);
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
  });
});

describe("«Рендер»", () => {
  test("the unsaved edit is saved first, then the render is asked for", async () => {
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec: withFirstClip(made, 5_000), name: null }));
    await screen.findByText("5.0 с · ≈ 2.2 МБ");
    fireEvent.click(screen.getByRole("button", { name: "Отменить" }));

    // Within the quiet spell: nothing is saved yet.
    fireEvent.click(renderButton());
    await waitFor(() => expect(callsOf(engine, "videos.render")).toHaveLength(1));
    const order = engine.calls.map((c) => c.type).filter((t) => t === "montages.save" || t === "videos.render");
    expect(order.slice(-2)).toEqual(["montages.save", "videos.render"]);
    expect(callsOf(engine, "montages.save").at(-1)?.payload.spec.clips[0]?.durationMs).toBe(8_000);
  });

  test("an answer that beats the job's first event keeps the button busy: no second render in between", async () => {
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    engine.setDelivery(false);
    fireEvent.click(renderButton());
    await waitFor(() => expect(callsOf(engine, "videos.render")).toHaveLength(1));
    await flush();
    const busy = screen.getByRole("button", { name: "Рендер…" });
    expect(busy.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(busy);
    await flush();
    expect(callsOf(engine, "videos.render").map((c) => c.payload)).toEqual([{ montageId: made.montageId }]);
  });

  test("a running render shows on the button; once done, the photos are in that video and «Рендер» says so (Q1)", async () => {
    const { client, scheduler } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1, P2, PHOTO_IDS[2] ?? "", PHOTO_IDS[3] ?? "", PHOTO_IDS[4] ?? ""]);
    await openEditor();
    fireEvent.click(renderButton());
    await screen.findByRole("button", { name: /Рендер · \d+\s%|В очереди/ });

    runAll(scheduler);
    await flush();
    await screen.findByText("Фото уже в видео из этого черновика — замените их или удалите то видео");
    expect(renderButton().hasAttribute("disabled")).toBe(true);
  });

  test("when a render ends, «Рендер» stays busy until the engine's verdict read after the end answers: it never flashes ready", async () => {
    const { client, engine, scheduler } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1, P2, PHOTO_IDS[2] ?? "", PHOTO_IDS[3] ?? "", PHOTO_IDS[4] ?? ""]);
    await openEditor();
    // Every verdict read from here on is slow: none answers before the render's own steps are over, so the last
    // verdict the window holds is the one from before the render (its photos still free).
    for (let i = 0; i < 12; i++) engine.delayNext("montages.get", 60_000);
    fireEvent.click(renderButton());
    await screen.findByRole("button", { name: /Рендер · \d+\s%|В очереди/ });

    for (let i = 0; i < 30 && screen.queryByRole("button", { name: /Рендер · \d+\s%|В очереди/ }) !== null; i++) tick(scheduler);
    await flush();
    expect(screen.queryByRole("button", { name: /Рендер · \d+\s%|В очереди/ })).toBeNull();
    const button = screen.getByRole("button", { name: /^Рендер/ });
    expect(button.hasAttribute("disabled") || button.getAttribute("aria-disabled") === "true").toBe(true);

    runAll(scheduler);
    await flush();
    await screen.findByText("Фото уже в видео из этого черновика — замените их или удалите то видео");
    expect(made.montageId).toMatch(/^montage-/);
  });

  test("when the draft cannot be read after a render ends, the reason shows with «Повторить», not an endless «Рендер…»", async () => {
    const { client, engine, scheduler } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1, P2, PHOTO_IDS[2] ?? "", PHOTO_IDS[3] ?? "", PHOTO_IDS[4] ?? ""]);
    await openEditor();
    fireEvent.click(renderButton());
    await screen.findByRole("button", { name: /Рендер · \d+\s%|В очереди/ });
    for (let i = 0; i < 8; i++) engine.failNext("montages.get", { code: "LIBRARY_UNAVAILABLE" });

    runAll(scheduler);
    await flush();
    await screen.findByText(ERROR_MESSAGES_RU.LIBRARY_UNAVAILABLE);
    expect(screen.queryByRole("button", { name: "Рендер…" })).toBeNull();
    expect(screen.getByText("Черновик не удалось проверить после рендера")).toBeDefined();
    expect(renderButton().hasAttribute("disabled")).toBe(true);

    // The library is back (the refusals queued for this test are used up), and «Повторить» reads the draft again. That
    // read is slow: while it is out, the old failure is gone and the button waits for the new answer.
    await asAnotherWindow(async () => {
      for (let i = 0; i < 8; i++) if ((await client.request("montages.get", { montageId: made.montageId })).ok) break;
    });
    engine.delayNext("montages.get", 60_000);
    const notice = screen.getByText(ERROR_MESSAGES_RU.LIBRARY_UNAVAILABLE).closest(".notice");
    if (!(notice instanceof HTMLElement)) throw new Error("no notice");
    fireEvent.click(within(notice).getByRole("button", { name: "Повторить" }));
    await flush();
    expect(screen.queryByText(ERROR_MESSAGES_RU.LIBRARY_UNAVAILABLE)).toBeNull();
    expect(screen.getByRole("button", { name: "Рендер…" })).toBeDefined();

    runAll(scheduler);
    await screen.findByText("Фото уже в видео из этого черновика — замените их или удалите то видео");
  });

  test("a save made elsewhere while this window heard nothing is picked up when the window comes back", async () => {
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    engine.setDelivery(false);
    await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec: withFirstClip(made, 5_000), name: "из другого окна" }));
    expect(within(header()).getByText(/8\.0 с · ≈ 3\.5 МБ/)).toBeDefined();

    engine.setDelivery(true);
    window.dispatchEvent(new Event("focus"));
    await screen.findByRole("heading", { level: 1, name: "Mia · «из другого окна»" });
    expect(within(header()).getByText(/5\.0 с · ≈ 2\.2 МБ/)).toBeDefined();
  });

  test("the export folder the engine found unavailable blocks it, with the way to Settings", async () => {
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    expect(renderButton().hasAttribute("disabled")).toBe(false);

    engine.setExportDisk({ status: "unavailable", reason: "missing" });
    await asAnotherWindow(() => client.request("videos.list", { avatarId: MIA.avatarId }));
    await screen.findByText(/Папка «Готовые видео» недоступна/);
    expect(renderButton().hasAttribute("disabled")).toBe(true);
    fireEvent.click(within(header()).getByRole("button", { name: "Настройки" }));
    await screen.findByRole("heading", { level: 1, name: "Настройки" });
  });
});

describe("a draft that cannot be opened", () => {
  test("a draft deleted before it opened: said plainly, with the way back", async () => {
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, []);
    await openDrafts();
    engine.failNext("montages.get", { code: "NOT_FOUND", detail: `no montage draft ${made.montageId}` });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await screen.findByText("Черновик удалён");
    fireEvent.click(screen.getByRole("button", { name: "К черновикам" }));
    await screen.findByRole("heading", { level: 2, name: "Черновики" });
  });

  test("no library: the engine's reason and a retry that opens it once the library is back", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, []);
    await openDrafts();
    engine.failNext("montages.get", { code: "LIBRARY_UNAVAILABLE" });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await screen.findByText(ERROR_MESSAGES_RU.LIBRARY_UNAVAILABLE);
    fireEvent.click(screen.getByRole("button", { name: "Повторить" }));
    await screen.findByRole("region", { name: "Таймлайн" });
  });

  test("a draft from a newer Studio says to update the app, and offers no retry", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, []);
    await openDrafts();
    engine.failNext("montages.get", { code: "INTERNAL", detail: DRAFT_TOO_NEW_DETAIL });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await screen.findByText(/сохранён более новой версией Studio/);
    expect(screen.queryByText(ERROR_MESSAGES_RU.INTERNAL)).toBeNull();
    expect(screen.queryByRole("button", { name: "Повторить" })).toBeNull();
  });

  test("a draft that was being saved while it was read is read again by itself", async () => {
    const { client, engine } = await studio();
    await makeDraft(client, MIA.avatarId, []);
    await openDrafts();
    engine.failNext("montages.get", { code: "INTERNAL", detail: DRAFT_CHANGING_DETAIL });
    engine.failNext("montages.get", { code: "INTERNAL", detail: DRAFT_CHANGING_DETAIL });
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await screen.findByRole("region", { name: "Таймлайн" });
    expect(callsOf(engine, "montages.get").length).toBeGreaterThanOrEqual(3);
  });
});

describe("the shell's slots", () => {
  test("the media tabs: «Фото» with the avatar's photos, the others «Скоро»; the draft's photos carry their clip number", async () => {
    const { client } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    const tabs = within(screen.getByRole("tablist", { name: "Тип медиа" })).getAllByRole("tab");
    expect(tabs.map((t) => t.textContent)).toEqual(["Фото", "Мои", "Музыка", "GIF", "Текст"]);
    expect(tabs.map((t) => t.hasAttribute("disabled"))).toEqual([false, true, true, true, true]);
    const bin = await screen.findByRole("list", { name: "Фото аватара" });
    expect(within(bin).getAllByRole("listitem")).toHaveLength(6);
    expect(within(bin).getByRole("listitem", { name: /в кадре 1/ })).toBeDefined();
  });

  test("every region is there, and «Кадры +» takes the focus to the photos", async () => {
    const { client } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1]);
    await openEditor();
    for (const name of ["Медиа", "Свойства"]) expect(screen.getByRole("complementary", { name })).toBeDefined();
    for (const name of ["Превью", "Таймлайн"]) expect(screen.getByRole("region", { name })).toBeDefined();
    expect(within(screen.getByRole("list", { name: "Кадры" })).getByRole("listitem", { name: /^Кадр 1, 8\.0\sс$/ })).toBeDefined();
    fireEvent.click(screen.getByRole("button", { name: "Добавить кадр" }));
    expect(document.activeElement?.textContent).toBe("Фото");
  });
});

test("leaving by «Черновики» comes back to the list", async () => {
  const { client } = await studio();
  const made = await makeDraft(client, MIA.avatarId, []);
  await openEditor();
  fireEvent.click(screen.getByRole("button", { name: "Черновики" }));
  await screen.findByRole("heading", { level: 2, name: "Черновики" });
});
