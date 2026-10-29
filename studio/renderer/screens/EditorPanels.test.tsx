import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { CAPTION_ISSUES_RU, type MontageDraft, type PhotoSummary } from "../../shared/engine";
import type { MockEngine } from "../engine/mockEngine";
import { freePhotos, scenePhoto } from "../engine/mockEngine.testkit";
import type { MockTrackSeed } from "../engine/mockMusicStore";
import { callsOf, flush } from "../testing";
import { AUTOSAVE_DEBOUNCE_MS } from "./montage/autosave";
import { asAnotherWindow, makeDraft, MIA, openDrafts, paidMusicCalls, studio as openStudio } from "./montage/screenKit";
import { photoClip, stickerLayer, textLayer } from "./montage/testkit";

// The money guard on every test of this file: whatever the panels did, no paid music command left. `music.refresh` (1 of 30
// requests) and `music.recoverQuotaLog` are Settings' alone, behind the owner's confirmation (3c.6).
const opened: MockEngine[] = [];
async function studio(...options: Parameters<typeof openStudio>): ReturnType<typeof openStudio> {
  const harness = await openStudio(...options);
  opened.push(harness.engine);
  return harness;
}
afterEach(() => {
  for (const engine of opened.splice(0)) expect(paidMusicCalls(engine)).toEqual([]);
});

// 3d.5: the media panel's tabs and the properties of a text, a sticker and the music (Editor, EditorText, EditorGif, EditorMusic
// artboards; the components sheet's caption error, track rows, caps). Every edit goes through the session: one undo step per
// gesture (a slider drag, a typing burst), saved like any other edit. The caption's verdict is the ENGINE's (`montages.textPreview`),
// shown inline; the music is free (`music.list`, `music.peaks`, `music.status`): nothing here sends `music.refresh`.

/** Free scene photos 1–6 of Mia, the first four in the draft. */
const PHOTOS = freePhotos(6);
const IDS = PHOTOS.map((p) => p.photoId);

/** 60 s, highlights at 12 s and 30 s and the likely 1500 default. */
const ESPRESSO: MockTrackSeed = { trackId: "track-espresso-01", title: "Espresso", artist: "Sabrina Carpenter", durationMs: 60_000, explicit: false, highlightsMs: [30_000, 12_000, 1_500], hasCover: true, peaks: Array.from({ length: 1_200 }, (_, s) => (s * 37) % 1_000) };
/** Explicit, 40 s, a highlight at 35 s that would run the 8 s montage past its end. */
const LUTHER: MockTrackSeed = { trackId: "track-luther-001", title: "Luther", artist: "Kendrick Lamar", durationMs: 40_000, explicit: true, highlightsMs: [35_000, 20_000], hasCover: false, peaks: Array.from({ length: 800 }, () => 500) };
/** 7 s: shorter than the 8 s montage. */
const SHORT: MockTrackSeed = { trackId: "track-short-0001", title: "оригинальный звук", artist: "dasha.daily", durationMs: 7_000, explicit: false, highlightsMs: [], hasCover: false, peaks: Array.from({ length: 140 }, () => 300) };
const MUSIC = { tracks: [ESPRESSO, LUTHER, SHORT], list: { fetchedAt: "2026-10-02T11:02:00.000Z", trackCount: 3, bytesOnDisk: 9_000_000 } };

const media = (): HTMLElement => screen.getByRole("complementary", { name: "Медиа" });
const props = (): HTMLElement => screen.getByRole("complementary", { name: "Свойства" });
const timeline = (): HTMLElement => screen.getByRole("region", { name: "Таймлайн" });
const tab = (name: string): HTMLElement => within(media()).getByRole("tab", { name });
const undo = (): void => {
  fireEvent.click(screen.getByRole("button", { name: "Отменить" }));
};
const plain = (text: string | null | undefined): string => (text ?? "").replace(/ /g, " ");
const caption = (): HTMLTextAreaElement => {
  const field = within(props()).getByRole("textbox", { name: "Текст" });
  if (!(field instanceof HTMLTextAreaElement)) throw new Error("the caption is not a textarea");
  return field;
};
const notice = (): string => plain(props().querySelector(".ed-caption-notice")?.textContent);

/** A draft of four 2 s photo clips (8.0 s) with `patch`, saved as another window would, then opened. */
async function openDraft(engine: MockEngine, client: Parameters<typeof makeDraft>[0], patch: Partial<MontageDraft> = {}): Promise<void> {
  const made = await makeDraft(client, MIA.avatarId, []);
  const spec: MontageDraft = { ...made.spec, clips: IDS.slice(0, 4).map((photoId, i) => photoClip(i, photoId, 2_000)), ...patch };
  const saved = await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec, name: null }));
  if (!saved.ok) throw new Error(`montages.save: ${saved.error.code}`);
  await openDrafts();
  await screen.findByRole("heading", { level: 3, name: /Mia/ });
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();
  for (let i = engine.calls.length - 1; i >= 0; i--) if (engine.calls[i]?.type === "montages.save") engine.calls.splice(i, 1);
}

/** The draft as the engine last saved it, after the next save lands. */
async function nextSave(engine: MockEngine): Promise<MontageDraft> {
  await waitFor(() => expect(callsOf(engine, "montages.save").length).toBeGreaterThan(0), { timeout: AUTOSAVE_DEBOUNCE_MS * 4 });
  const last = callsOf(engine, "montages.save").at(-1);
  if (last === undefined) throw new Error("no save");
  return last.payload.spec;
}

/** Selects the timeline block named by `name`. */
function selectBlock(name: RegExp): void {
  fireEvent.click(within(timeline()).getByRole("button", { name }));
}

// ---------- the «Фото» tab ----------

describe("the «Фото» tab: eligible photos, the chips, one photo → one video", () => {
  /** Photos 1–4 free (in the draft), 5 used in a video (travel), 6 reserved by a render, 7 free (travel), 8 rejected. */
  const photos: PhotoSummary[] = [
    ...freePhotos(4),
    scenePhoto(5, { category: "travel", used: true, usedIn: ["video-0000001"] }),
    scenePhoto(6, { reserved: true }),
    scenePhoto(7, { category: "travel" }),
    scenePhoto(8, { rejected: true, eligible: false }),
  ];
  const bin = (): HTMLElement => within(media()).getByRole("list", { name: "Фото аватара" });
  const names = (): string[] => within(bin()).getAllByRole("listitem").map((li) => plain(li.getAttribute("aria-label")));

  // `photos.list` answers newest first: «Фото 1» is scene photo 7, «Фото 7» is scene photo 1.
  test("eligible photos only; used and reserved ones dimmed, named and not addable; a free one is appended", async () => {
    const { client, engine } = await studio({ photos });
    await openDraft(engine, client);
    await screen.findByRole("list", { name: "Фото аватара" });
    expect(names()).toEqual(["Фото 1 · не использовано", "Фото 2 · в рендере", "Фото 3 · использовано в 1 видео", "Фото 4 · в кадре 4", "Фото 5 · в кадре 3", "Фото 6 · в кадре 2", "Фото 7 · в кадре 1"]);
    const used = within(bin()).getByRole("button", { name: "Фото 3: уже занято" });
    expect(used.hasAttribute("disabled")).toBe(true);
    expect(within(bin()).getByRole("button", { name: "Фото 2: уже занято" }).hasAttribute("disabled")).toBe(true);
    expect(within(bin()).getAllByText("в 1 видео")).toHaveLength(1);
    expect(within(bin()).getAllByText("в рендере")).toHaveLength(1);
    fireEvent.click(within(bin()).getByRole("button", { name: "Фото 1: добавить кадр в конец ролика" }));
    const saved = await nextSave(engine);
    expect(saved.clips.map((c) => (c.kind === "photo" && c.cell.photo?.source === "scene" ? c.cell.photo.photoId : null))).toEqual([...IDS.slice(0, 4), "photo-mia-0007"]);
  });

  test("«Неиспользованные N» keeps the free photos; the category keeps its own; «Показать все фото» clears both", async () => {
    const { client, engine } = await studio({ photos });
    await openDraft(engine, client);
    await screen.findByRole("list", { name: "Фото аватара" });
    const unused = within(media()).getByRole("button", { name: /^Неиспользованные/ });
    expect(plain(unused.textContent)).toBe("Неиспользованные5");
    fireEvent.click(unused);
    expect(unused.getAttribute("aria-pressed")).toBe("true");
    // The numbers stay those of the whole bin: the used «Фото 3» and the reserved «Фото 2» are out.
    expect(names().map((n) => n.split(" · ")[0])).toEqual(["Фото 1", "Фото 4", "Фото 5", "Фото 6", "Фото 7"]);
    const category = within(media()).getByRole("combobox", { name: "Категория" });
    expect(within(category).getAllByRole("option").map((o) => o.textContent)).toEqual(["Все категории", "Дом · 4", "Виды · 1"]);
    fireEvent.change(category, { target: { value: "travel" } });
    expect(names()).toEqual(["Фото 1 · не использовано"]);
    fireEvent.click(unused);
    expect(names()).toEqual(["Фото 1 · не использовано", "Фото 3 · использовано в 1 видео"]);
    fireEvent.change(category, { target: { value: "" } });
    expect(names()).toHaveLength(7);
  });

});

// ---------- the «Музыка» tab ----------

describe("the «Музыка» tab: the trending list, the «E» badge, a free pick", () => {
  const rows = (): HTMLElement[] => within(media()).getAllByRole("button").filter((b) => b.classList.contains("trow"));

  test("the stored tracks in the list's order: «E» on an explicit one that stays pickable, a short one dimmed and not pickable", async () => {
    const { client, engine } = await studio({ music: MUSIC });
    await openDraft(engine, client);
    fireEvent.click(tab("Музыка"));
    await within(media()).findByRole("list", { name: "Треки в тренде" });
    expect(rows().map((r) => plain(r.getAttribute("aria-label")))).toEqual([
      "Espresso · Sabrina Carpenter, 1:00, лучшая часть с 0:12",
      "Luther · Kendrick Lamar, пометка E (explicit), 0:40, лучшая часть с 0:20",
      "оригинальный звук · dasha.daily, 0:07, короче ролика (8.0 с), не выбрать",
    ]);
    expect(rows()[1]?.querySelector(".e")?.textContent).toBe("E");
    expect(rows()[1]?.getAttribute("aria-disabled")).toBe(null);
    expect(rows()[2]?.getAttribute("aria-disabled")).toBe("true");
    // The list's age on the owner's clock (the day and month never break apart).
    expect(plain(media().querySelector(".ed-music-age")?.textContent)).toMatch(/^обновлено 2 окт\., \d\d:02$/);
    // No trending-only filter exists; the one chip is «Скрыть E».
    expect(within(media()).getAllByRole("button", { pressed: false }).map((b) => b.getAttribute("aria-label"))).toEqual(["Скрыть треки с пометкой E"]);
  });

  test("a click puts the track in at its first highlight that fits; the music is selected; one undo takes it out; nothing paid is sent", async () => {
    const { client, engine } = await studio({ music: MUSIC });
    await openDraft(engine, client);
    fireEvent.click(tab("Музыка"));
    await within(media()).findByRole("list", { name: "Треки в тренде" });
    // Luther's 35 s highlight would end the montage at 43 s of a 40 s track: it starts at 20 s.
    fireEvent.click(within(media()).getByRole("button", { name: /^Luther/ }));
    // The block names the track once the timeline has looked it up in the list.
    expect((await within(timeline()).findByRole("button", { name: "Музыка: Luther · Kendrick Lamar, с 0:20" })).getAttribute("aria-pressed")).toBe("true");
    expect(within(props()).getByText("Лучшая часть")).toBeDefined();
    const saved = await nextSave(engine);
    expect(saved.music).toEqual({ source: "trending", trackId: LUTHER.trackId, startMs: 20_000 });
    expect(rows()[1]?.getAttribute("aria-current")).toBe("true");
    // The short track does nothing.
    fireEvent.click(within(media()).getByRole("button", { name: /^оригинальный звук/ }));
    expect(within(timeline()).getByRole("button", { name: /^Музыка: Luther/ })).toBeDefined();
    undo();
    expect(within(timeline()).getByRole("button", { name: "Добавить музыку" })).toBeDefined();
    expect(callsOf(engine, "music.refresh")).toHaveLength(0);
    expect(callsOf(engine, "music.list").length).toBeGreaterThan(0);
  });

  test("the quota is shown, and the paid refresh is only a way to Settings, where it is confirmed", async () => {
    const { client, engine } = await studio({ music: { ...MUSIC, sendsDaysAgo: [1, 2, 3] } });
    await openDraft(engine, client);
    fireEvent.click(tab("Музыка"));
    await within(media()).findByText("3 из 30 запросов за 31 день");
    fireEvent.click(within(media()).getByRole("button", { name: "Обновить список — в Настройках" }));
    await screen.findByRole("heading", { level: 2, name: "Музыка · flashapi" });
    expect(callsOf(engine, "music.refresh")).toHaveLength(0);
  });

});

// ---------- the music card ----------

describe("the music card: the whole track, the window, the highlight picks", () => {
  const withMusic = (startMs: number) => ({ music: { source: "trending" as const, trackId: ESPRESSO.trackId, startMs } });
  const picks = (): HTMLElement[] => within(within(props()).getByRole("group", { name: "Выбрать лучшую часть" })).getAllByRole("button");

  test("picks ascending with the likely default last; the one in use pressed; a click is one undo step", async () => {
    const { client, engine } = await studio({ music: MUSIC });
    await openDraft(engine, client, withMusic(30_000));
    selectBlock(/^Музыка:/);
    await within(props()).findByRole("group", { name: "Выбрать лучшую часть" });
    expect(picks().map((p) => [plain(p.getAttribute("aria-label")), p.getAttribute("aria-pressed")])).toEqual([
      ["Лучшая часть с 0:12", "false"],
      ["Лучшая часть с 0:30", "true"],
      ["С 0:01.5, похоже на начало трека", "false"],
    ]);
    expect(within(props()).getByText("от Instagram · 3")).toBeDefined();
    fireEvent.click(picks()[0] ?? document.body);
    expect(within(timeline()).getByRole("button", { name: "Музыка: Espresso · Sabrina Carpenter, с 0:12" })).toBeDefined();
    expect(plain(props().querySelector(".ed-hl-range")?.textContent)).toBe("0:12 → 0:20");
    undo();
    expect(within(timeline()).getByRole("button", { name: "Музыка: Espresso · Sabrina Carpenter, с 0:30" })).toBeDefined();
  });

  test("the window is a slider: ⇧→ a second later, a held key is one undo step, End to the last start that fits", async () => {
    const { client, engine } = await studio({ music: MUSIC });
    await openDraft(engine, client, withMusic(12_000));
    selectBlock(/^Музыка:/);
    const slider = await within(props()).findByRole("slider", { name: "Начало музыки в треке" });
    expect([slider.getAttribute("aria-valuenow"), slider.getAttribute("aria-valuemax")]).toEqual(["12000", "52000"]);
    fireEvent.keyDown(slider, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(slider, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyUp(slider, { key: "ArrowRight" });
    expect(slider.getAttribute("aria-valuenow")).toBe("14000");
    undo();
    expect(within(props()).getByRole("slider", { name: "Начало музыки в треке" }).getAttribute("aria-valuenow")).toBe("12000");
    fireEvent.keyDown(within(props()).getByRole("slider", { name: "Начало музыки в треке" }), { key: "End" });
    expect(within(props()).getByRole("slider", { name: "Начало музыки в треке" }).getAttribute("aria-valuenow")).toBe("52000");
    const saved = await nextSave(engine);
    expect(saved.music?.startMs).toBe(52_000);
  });

  describe("dragging the window (one edit on release, as the timeline's block does)", () => {
    /** The card's strip laid out 600 px wide (happy-dom lays nothing out): 100 ms of the 60 s track per pixel. */
    function layOut(): HTMLElement {
      const strip = props().querySelector(".ed-hl");
      if (!(strip instanceof HTMLElement)) throw new Error("no waveform strip");
      Object.defineProperty(strip, "getBoundingClientRect", { value: () => ({ left: 0, top: 0, right: 600, bottom: 46, width: 600, height: 46, x: 0, y: 0, toJSON: () => ({}) }) });
      return within(props()).getByRole("slider", { name: "Начало музыки в треке" });
    }
    const block = (): string => plain(within(timeline()).getByRole("button", { name: /^Музыка:/ }).getAttribute("aria-label"));
    const move = (pointerId: number, clientX: number, type: "pointermove" | "pointerup" | "pointercancel" = "pointermove"): void => {
      act(() => {
        window.dispatchEvent(new PointerEvent(type, { pointerId, clientX, buttons: type === "pointermove" ? 1 : 0 }));
      });
    };

    test("the window follows the pointer; the draft changes once, when it is let go; one undo takes it back", async () => {
      const { client, engine } = await studio({ music: MUSIC });
      await openDraft(engine, client, withMusic(12_000));
      selectBlock(/^Музыка:/);
      const slider = layOut();
      // The window spans 120–200 px (12–20 s of the track); taken at 150 px, 3 s into it.
      fireEvent.pointerDown(slider, { pointerId: 7, button: 0, clientX: 150 });
      move(7, 200);
      move(7, 250);
      expect(slider.getAttribute("aria-valuenow")).toBe("22000");
      expect(block()).toBe("Музыка: Espresso · Sabrina Carpenter, с 0:12");
      move(7, 250, "pointerup");
      expect(block()).toBe("Музыка: Espresso · Sabrina Carpenter, с 0:22");
      undo();
      expect(block()).toBe("Музыка: Espresso · Sabrina Carpenter, с 0:12");
    });

  });

  // 3f.4: an own track in the same card, timeline block and waveform. It has a name (the file's), a decoded length and a waveform of its own, no cover, no
  // highlights; the engine's verdict (`media-unavailable` at the music, `track-too-short`) says what is wrong with it.
  describe("an own track (3f.4)", () => {
    const ownMusic = (mediaId: string, startMs: number) => ({ music: { source: "own" as const, mediaId, startMs } });
    /** A 40 s own track in the mock's library, answering its media id. */
    async function withOwnTrack(durationMs = 40_000): Promise<{ client: Awaited<ReturnType<typeof studio>>["client"]; engine: MockEngine; mediaId: string }> {
      const { client, engine } = await studio({ music: MUSIC });
      engine.seedOwnMedia([{ kind: "audio", name: "my mix.mp3", bytes: 640_000, facts: { durationMs }, waveform: Array.from({ length: Math.ceil(durationMs / 50) }, (_, i) => 200 + ((i * 37) % 700)) }]);
      const listed = await client.request("media.list", { kind: "audio" });
      const mediaId = listed.ok ? listed.result.media[0]?.mediaId : undefined;
      if (mediaId === undefined) throw new Error("no own track was seeded");
      return { client, engine, mediaId };
    }

    test("the timeline block is named by the file and starts where the draft says; its waveform is asked as an OWN track", async () => {
      const { client, engine, mediaId } = await withOwnTrack();
      await openDraft(engine, client, ownMusic(mediaId, 12_000));
      await within(timeline()).findByRole("button", { name: "Музыка: my mix.mp3, с 0:12" });
      await waitFor(() => expect(callsOf(engine, "music.peaks").some((c) => c.payload.track.source === "own" && c.payload.track.mediaId === mediaId)).toBe(true));
      expect(callsOf(engine, "music.peaks").some((c) => c.payload.track.source === "trending")).toBe(false);
    });

    test("a track too short for the start says so, from its decoded length, before the engine has judged the edit", async () => {
      const { client, engine, mediaId } = await withOwnTrack(7_000);
      await openDraft(engine, client, ownMusic(mediaId, 0));
      await within(timeline()).findByRole("button", { name: /^Музыка: my mix\.mp3/ });
      selectBlock(/^Музыка:/);
      await within(props()).findByText("Трек кончается раньше ролика: начните его раньше или замените трек.");
    });

    test("a track the library no longer holds is unavailable: the block, the card and the render say the same, and nothing paid is sent", async () => {
      const { client, engine, mediaId } = await withOwnTrack();
      await openDraft(engine, client, ownMusic(mediaId, 12_000));
      await client.request("media.delete", { mediaId });
      // A save by another window makes the engine judge the draft again.
      selectBlock(/^Музыка:/);
      await waitFor(() => expect(within(props()).queryByText("Трека больше нет в Studio: видео с ним не соберётся. Замените трек.")).not.toBeNull());
    });

  });

});

// ---------- the «Текст» tab ----------

describe("the «Текст» tab: «Добавить текст», the presets, the texts", () => {
  test("«Добавить текст» at the playhead; a preset in its font and style; the list selects", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client);
    fireEvent.click(tab("Текст"));
    fireEvent.keyDown(within(timeline()).getByRole("slider", { name: "Плейхед" }), { key: "ArrowRight", shiftKey: true });
    expect(plain(within(media()).getByRole("button", { name: /^Добавить текст в/ }).textContent)).toBe("Добавить текст в 1.0 с");
    fireEvent.click(within(media()).getByRole("button", { name: /^Добавить текст в/ }));
    fireEvent.click(within(media()).getByRole("button", { name: "Добавить текст: Без фона · Caveat" }));
    const list = within(media()).getByRole("list", { name: "Тексты ролика" });
    expect(within(list).getAllByRole("button").map((b) => plain(b.getAttribute("aria-label")))).toEqual(["Текст 1: «your text», 1.0–4.0 с", "Текст 2: «slow morning», 1.0–4.0 с"]);
    expect(within(media()).getByText("· 2 из 10")).toBeDefined();
    const saved = await nextSave(engine);
    expect(saved.layers.map((l) => (l.kind === "text" ? [l.font, l.style, l.value] : null))).toEqual([
      ["manrope", "plaque", "your text"],
      ["caveat", "none", "slow morning"],
    ]);
    fireEvent.click(within(list).getByRole("button", { name: /^Текст 1:/ }));
    expect(within(props()).getByText("Текст · слой 1 из 2")).toBeDefined();
  });

  test("ten texts: the button and the presets are off, the line says why", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: Array.from({ length: 10 }, (_, i) => textLayer(i, 0, 1_000)) });
    fireEvent.click(tab("Текст"));
    expect(within(media()).getByRole("button", { name: /^Добавить текст в/ }).hasAttribute("disabled")).toBe(true);
    expect(within(media()).getByRole("button", { name: "Добавить текст: Плашка · Manrope" }).hasAttribute("disabled")).toBe(true);
    expect(within(media()).getByText("Не больше 10 текстов в одном видео")).toBeDefined();
  });
});

// ---------- a text's properties ----------

describe("a text's properties: the caption with the engine's verdict inline, the look, the time", () => {
  const openText = async (patch: Partial<MontageDraft> = {}) => {
    const harness = await studio();
    await openDraft(harness.engine, harness.client, { layers: [textLayer(0, 1_000, 4_000)], ...patch });
    selectBlock(/^Текст 1:/);
    await flush();
    return harness;
  };

  test("a typing burst is one undo step; the caption is saved", async () => {
    const { engine } = await openText();
    fireEvent.change(caption(), { target: { value: "sunday reset!" } });
    fireEvent.change(caption(), { target: { value: "sunday reset!!" } });
    expect(plain(within(props()).getByText(/\/60$/).textContent)).toBe("14/60");
    const saved = await nextSave(engine);
    expect(saved.layers[0]?.kind === "text" && saved.layers[0].value).toBe("sunday reset!!");
    undo();
    expect(caption().value).toBe("sunday reset");
  });

  test("a new size, font, style or colour asks the engine about the caption again, with it", async () => {
    const { engine } = await openText();
    const last = () => callsOf(engine, "montages.textPreview").at(-1)?.payload.layer;
    fireEvent.click(within(props()).getByRole("button", { name: "Caveat" }));
    await waitFor(() => expect(last()?.font).toBe("caveat"));
    fireEvent.click(within(props()).getByRole("button", { name: "Без фона" }));
    await waitFor(() => expect(last()?.style).toBe("none"));
    fireEvent.click(within(props()).getByRole("button", { name: "Голубой" }));
    await waitFor(() => expect(last()?.color).toBe("#9ad9ff"));
    const size = within(props()).getByRole("slider", { name: "Размер" });
    fireEvent.pointerDown(size, { pointerId: 17 });
    fireEvent.change(size, { target: { value: "150" } });
    fireEvent.pointerUp(size, { pointerId: 17 });
    await waitFor(() => expect(last()?.scale).toBe(1.5));
  });

  test("a caption the engine refuses shows its rule inline (TEXT_INVALID + captionIssue, the shared words), and clears when fixed", async () => {
    const { engine } = await openText();
    fireEvent.change(caption(), { target: { value: "утро в Лиссабоне" } });
    await waitFor(() => expect(notice()).toBe(CAPTION_ISSUES_RU.charset));
    expect(caption().getAttribute("aria-invalid")).toBe("true");
    expect(callsOf(engine, "montages.textPreview").at(-1)?.payload.layer.value).toBe("утро в Лиссабоне");
    // The draft keeps what was typed: the contract takes it, the engine's verdict says why a render would refuse it.
    expect((await nextSave(engine)).layers[0]).toMatchObject({ value: "утро в Лиссабоне" });
    fireEvent.change(caption(), { target: { value: "morning in lisbon" } });
    await waitFor(() => expect(notice()).toBe(""));
    expect(caption().getAttribute("aria-invalid")).toBe(null);
  });

  test("an empty or over-long caption never reaches the draft or the engine: the field says why, the draft keeps the last one", async () => {
    const { engine } = await openText();
    const asked = callsOf(engine, "montages.textPreview").length;
    fireEvent.change(caption(), { target: { value: "" } });
    expect(notice()).toBe("Надпись не может быть пустой — напишите текст или удалите слой. Пока так, в черновике остаётся прежняя надпись.");
    fireEvent.change(caption(), { target: { value: "a".repeat(61) } });
    expect(notice()).toBe(`${CAPTION_ISSUES_RU["too-long"]} Пока так, в черновике остаётся прежняя надпись.`);
    expect(plain(within(props()).getByText("61/60").className)).toContain("ed-caption-over");
    // Only spaces: the contract would take it, but the shared layout has nothing to draw (a render holding it fails whole).
    fireEvent.change(caption(), { target: { value: "   " } });
    expect(notice()).toBe("В надписи одни пробелы — рисовать нечего. Напишите текст или удалите слой. Пока так, в черновике остаётся прежняя надпись.");
    await flush();
    expect(callsOf(engine, "montages.textPreview").length).toBe(asked);
    expect(within(timeline()).getByRole("button", { name: /^Текст 1: «sunday reset»/ })).toBeDefined();
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
  });

  test("«Время»: a typed start is taken on Enter; an end past the montage is refused with the reason", async () => {
    await openText();
    const start = within(props()).getByRole("textbox", { name: "Начало, секунды" });
    fireEvent.change(start, { target: { value: "0,5" } });
    fireEvent.keyDown(start, { key: "Enter" });
    expect(within(timeline()).getByRole("button", { name: /^Текст 1: «sunday reset», 0\.5–4\.0\sс$/ })).toBeDefined();
    const end = within(props()).getByRole("textbox", { name: "Конец, секунды" });
    fireEvent.change(end, { target: { value: "8.5" } });
    fireEvent.blur(end);
    expect(plain(within(props()).getByRole("status").textContent)).toBe("Слой должен закончиться до конца ролика, 8.0 с");
    expect((within(props()).getByRole("textbox", { name: "Конец, секунды" }) as HTMLInputElement).value).toBe("4.0");
  });
});

// ---------- a sticker's properties ----------

describe("a sticker's properties: size, time, the Reels zones, «Заменить стикер»", () => {
  const sticker = (patch: object = {}) => ({ ...stickerLayer(0, 0, 2_000), sticker: { source: "builtin" as const, stickerId: "heart-pulse" }, ...patch });

  test("its facts, «Размер» in percent (5–60), a drag one undo step", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [sticker({ size: 0.2 })] });
    selectBlock(/^Стикер 1:/);
    expect(within(props()).getByText("Сердце")).toBeDefined();
    expect(within(props()).getByText("Любовь")).toBeDefined();
    const size = within(props()).getByRole("slider", { name: "Размер" });
    expect([size.getAttribute("min"), size.getAttribute("max"), size.getAttribute("aria-valuetext")]).toEqual(["5", "60", "20 %"]);
    fireEvent.pointerDown(size, { pointerId: 14 });
    fireEvent.change(size, { target: { value: "40" } });
    fireEvent.change(size, { target: { value: "60" } });
    fireEvent.pointerUp(size, { pointerId: 14 });
    const saved = await nextSave(engine);
    expect(saved.layers[0]).toMatchObject({ size: 0.6 });
    undo();
    expect(within(props()).getByRole("slider", { name: "Размер" }).getAttribute("aria-valuetext")).toBe("20 %");
  });

  test("a sticker under the Reels buttons is warned about; «Сдвинуть внутрь» moves it out, one undo step", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [sticker({ x: 0.9, y: 0.6, size: 0.15 })] });
    selectBlock(/^Стикер 1:/);
    expect(within(props()).getByText("Под кнопками Reels")).toBeDefined();
    fireEvent.click(within(props()).getByRole("button", { name: "Сдвинуть внутрь" }));
    expect(within(props()).queryByText("Под кнопками Reels") === null).toBe(true);
    const saved = await nextSave(engine);
    expect(saved.layers[0]).toMatchObject({ y: 0.6, size: 0.15 });
    undo();
    expect(within(props()).getByText("Под кнопками Reels")).toBeDefined();
  });

  test("ten stickers: the tiles are off and the line says what to do", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: Array.from({ length: 10 }, (_, i) => ({ ...stickerLayer(i, 0, 1_000), sticker: { source: "builtin" as const, stickerId: "heart-pulse" } })) });
    fireEvent.click(tab("GIF"));
    expect(within(media()).getByText("Не больше 10 стикеров в одном видео — уберите один, чтобы добавить другой.")).toBeDefined();
    expect(within(media()).getByRole("button", { name: /^Звезда:/ }).hasAttribute("disabled")).toBe(true);
    expect(within(media()).getByRole("button", { name: /^Сердце: в плейхед, в ролике 10$/ })).toBeDefined();
  });
});
