import { afterEach, describe, expect, test } from "bun:test";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { MontageDraft } from "../../shared/engine";
import type { MockEngine } from "../engine/mockEngine";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import { callsOf, flush } from "../testing";
import { AUTOSAVE_DEBOUNCE_MS } from "./montage/autosave";
import { asAnotherWindow, makeDraft, MIA, openDrafts, paidMusicCalls, studio as openStudio } from "./montage/screenKit";
import { photoClip } from "./montage/testkit";

// Slice review 5-M2: the editor itself sends the owner to Settings (the trending list is refreshed only there, the export folder, an error's link).
// The way there and back must not cost the draft's session: the undo history, the media tab, the selection and the playhead are kept by the window
// for that draft, and Settings offers «К черновику». Reopened from the drafts list in the same window, the draft goes on where it was too.

const IDS = PHOTO_IDS.slice(0, 4);
const opened: MockEngine[] = [];
async function studio(): ReturnType<typeof openStudio> {
  const harness = await openStudio();
  opened.push(harness.engine);
  return harness;
}
afterEach(() => {
  for (const engine of opened.splice(0)) expect(paidMusicCalls(engine)).toEqual([]);
});

const timeline = (): HTMLElement => screen.getByRole("region", { name: "Таймлайн" });
const media = (): HTMLElement => screen.getByRole("complementary", { name: "Медиа" });
const undoButton = (): HTMLElement => screen.getByRole("button", { name: "Отменить" });
const clipCount = (): number => within(within(timeline()).getByRole("list", { name: "Кадры" })).getAllByRole("button").filter((b) => (b.getAttribute("aria-label") ?? "").startsWith("Кадр ")).length;

/** A draft of four 2 s photo clips, saved as another window would, then opened from the drafts list. */
async function openDraft(client: Parameters<typeof makeDraft>[0]): Promise<string> {
  const made = await makeDraft(client, MIA.avatarId, []);
  const spec: MontageDraft = { ...made.spec, clips: IDS.map((photoId, i) => photoClip(i, photoId ?? "", 2_000)) };
  const saved = await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec, name: "кафе" }));
  if (!saved.ok) throw new Error(`montages.save: ${saved.error.code}`);
  await openFromDrafts();
  return made.montageId;
}

async function openFromDrafts(): Promise<void> {
  await openDrafts();
  await screen.findByRole("heading", { level: 3, name: /Mia/ });
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();
}

/** Deletes clip 2 through its properties: one undo step (4 → 3), saved. */
async function deleteSecondClip(engine: MockEngine): Promise<void> {
  fireEvent.click(within(timeline()).getByRole("button", { name: /^Кадр 2/ }));
  await flush();
  fireEvent.click(within(screen.getByRole("complementary", { name: "Свойства" })).getByRole("button", { name: "Удалить" }));
  await waitFor(() => expect(callsOf(engine, "montages.save").length).toBeGreaterThan(1), { timeout: AUTOSAVE_DEBOUNCE_MS * 4 });
  await flush();
  expect(clipCount()).toBe(3);
}

describe("from the editor to Settings and back", () => {
  test("«Обновить список — в Настройках», then «К черновику»: undo, the tab and the selection are as they were", async () => {
    const { client, engine } = await studio();
    await openDraft(client);
    await deleteSecondClip(engine);
    fireEvent.click(within(media()).getByRole("tab", { name: "Музыка" }));
    await flush();
    fireEvent.click(within(timeline()).getByRole("button", { name: /^Кадр 3/ }));
    await flush();

    fireEvent.click(within(media()).getByRole("button", { name: /Обновить список — в Настройках/ }));
    await screen.findByRole("heading", { level: 1, name: "Настройки" });
    const back = screen.getByRole("button", { name: "К черновику Mia · «кафе»" });
    fireEvent.click(back);
    await screen.findByRole("region", { name: "Таймлайн" });
    await flush();

    expect(clipCount()).toBe(3);
    expect(undoButton().hasAttribute("disabled")).toBe(false);
    // Nothing changed elsewhere: nothing to say.
    expect(screen.queryByText("Черновик изменён в другом окне") === null).toBe(true);
    expect(within(media()).getByRole("tab", { name: "Музыка" }).getAttribute("aria-selected")).toBe("true");
    expect(within(timeline()).getByRole("button", { name: /^Кадр 3/ }).getAttribute("aria-pressed")).toBe("true");
    // The undo still works: it brings the deleted clip back, saved.
    const saves = callsOf(engine, "montages.save").length;
    fireEvent.click(undoButton());
    await waitFor(() => expect(callsOf(engine, "montages.save").length).toBeGreaterThan(saves), { timeout: AUTOSAVE_DEBOUNCE_MS * 4 });
    expect(clipCount()).toBe(4);
  });

  test("the sidebar's «Монтаж» and «Открыть» of the same draft go on where it was too; Settings from the sidebar offers the way back", async () => {
    const { client, engine } = await studio();
    await openDraft(client);
    await deleteSecondClip(engine);
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    await screen.findByRole("heading", { level: 1, name: "Настройки" });
    expect(screen.getByRole("button", { name: /^К черновику/ })).toBeDefined();
    await openFromDrafts();
    expect(clipCount()).toBe(3);
    expect(undoButton().hasAttribute("disabled")).toBe(false);
  });

  test("review r1 MEDIUM-1: a clip a click just added stays a placement's selection across the trip: the next click adds another clip", async () => {
    const { client } = await studio();
    await openDraft(client);
    const bin = (): HTMLElement => screen.getByRole("list", { name: "Фото аватара" });
    const freeTile = (): HTMLElement => {
      const item = within(bin()).getAllByRole("listitem").find((li) => (li.getAttribute("aria-label") ?? "").endsWith("не использовано"));
      const button = item === undefined ? undefined : within(item).getAllByRole("button")[0];
      if (button === undefined) throw new Error("no free photo in the bin");
      return button;
    };
    fireEvent.click(freeTile());
    await flush();
    expect(clipCount()).toBe(5);
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    await screen.findByRole("heading", { level: 1, name: "Настройки" });
    fireEvent.click(screen.getByRole("button", { name: /^К черновику/ }));
    await screen.findByRole("region", { name: "Таймлайн" });
    await flush();
    // The clip just added is still selected, and still not a target for a replace.
    expect(within(timeline()).getByRole("button", { name: /^Кадр 5/ }).getAttribute("aria-pressed")).toBe("true");
    expect(freeTile().getAttribute("aria-label")).toMatch(/: добавить кадр в конец ролика$/);
    fireEvent.click(freeTile());
    await flush();
    expect(clipCount()).toBe(6);
  });

  test("Settings opened from anywhere else has no way back to a draft", async () => {
    await studio();
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    await screen.findByRole("heading", { level: 1, name: "Настройки" });
    expect(screen.queryByRole("button", { name: /^К черновику/ }) === null).toBe(true);
  });

  test("a save from another window while the editor was away is taken on the way back, on top of this window's history", async () => {
    const { client, engine } = await studio();
    const montageId = await openDraft(client);
    await deleteSecondClip(engine);
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    await screen.findByRole("heading", { level: 1, name: "Настройки" });
    const now = await client.request("montages.get", { montageId });
    if (!now.ok) throw new Error("setup");
    const elsewhere = { ...now.result.montage.spec, clips: now.result.montage.spec.clips.slice(0, 2) };
    await asAnotherWindow(() => client.request("montages.save", { montageId, spec: elsewhere, name: "кафе" }));
    fireEvent.click(screen.getByRole("button", { name: /^К черновику/ }));
    await screen.findByRole("region", { name: "Таймлайн" });
    await flush();
    expect(clipCount()).toBe(2);
    // Review r1 LOW-1: said, so the first ⌘Z (which takes the other window's save back) is no surprise.
    const notice = (await screen.findByText("Черновик изменён в другом окне")).closest(".notice") as HTMLElement;
    expect(notice.textContent).toContain("«Отменить» сначала вернёт вашу версию");
    fireEvent.click(within(notice).getByRole("button", { name: "Понятно" }));
    await flush();
    expect(screen.queryByText("Черновик изменён в другом окне") === null).toBe(true);
    // ⌘Z here undoes the change from elsewhere first, then this window's own delete.
    fireEvent.click(undoButton());
    await flush();
    expect(clipCount()).toBe(3);
    fireEvent.click(undoButton());
    await flush();
    expect(clipCount()).toBe(4);
  });

  test("an edit that could not be saved and was left behind is not resumed: the draft opens as Studio holds it", async () => {
    const { client, engine } = await studio();
    await openDraft(client);
    engine.failNext("montages.save", { code: "LIBRARY_UNAVAILABLE" });
    fireEvent.click(within(timeline()).getByRole("button", { name: /^Кадр 2/ }));
    await flush();
    fireEvent.click(within(screen.getByRole("complementary", { name: "Свойства" })).getByRole("button", { name: "Удалить" }));
    await waitFor(() => expect(within(document.querySelector(".ed-head") as HTMLElement).getByText(/не сохранён/)).toBeDefined(), { timeout: AUTOSAVE_DEBOUNCE_MS * 4 });
    // The save on the way out is refused, and so is the last try the closing editor makes after «Уйти без сохранения».
    engine.failNext("montages.save", { code: "LIBRARY_UNAVAILABLE" });
    engine.failNext("montages.save", { code: "LIBRARY_UNAVAILABLE" });
    fireEvent.click(screen.getByRole("button", { name: "Настройки" }));
    fireEvent.click(await screen.findByRole("button", { name: "Уйти без сохранения" }));
    await screen.findByRole("heading", { level: 1, name: "Настройки" });
    await flush();
    // The edit was never stored: no way back offers a session that holds it.
    await openFromDrafts();
    expect(clipCount()).toBe(4);
    expect(undoButton().hasAttribute("disabled")).toBe(true);
    expect(callsOf(engine, "montages.save").filter((c) => c.payload.spec.clips.length === 3).length).toBeGreaterThan(0);
  });
});
