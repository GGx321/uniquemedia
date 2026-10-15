import { describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { CLIP_REASONS_RU, type EventMessage, mediaReasonRu, type MontageDraft } from "../../shared/engine";
import { App } from "../App";
import { createPayload } from "../engine/mockEngine.clips.testkit";
import { freePhotos } from "../engine/mockEngine.testkit";
import { NBSP } from "../lib/format";
import { callsOf, flush } from "../testing";
import { asAnotherWindow, makeDraft, MIA, openDrafts, studio } from "./montage/screenKit";
import { photoClip } from "./montage/testkit";

// 5b.2 part A (S5.WA4; plan §5.1, I5.59, I5.60, Q-F = 1; mockups 57–57f, README §S5.WAD): the editor's «Клипы» tab against the mock engine, which answers
// what the engine answers (S5.WA3). The draft avatar's ready clips; a click places the clip's own copy as an own video, made first by an import job when
// there is none («Готовим для монтажа…», from the job list); a photo and its clips are one frame; «Мои» never lists a copy; a selected copy is «клип».

/** Mia's photos 1–10, newest first in the lists: photo 10 is «Фото 1», photo 9 «Фото 2», photo 7 «Фото 4», photo 5 «Фото 6». Odd ones can be animated. */
const PHOTOS = freePhotos(10);
const P = (n: number): string => `photo-mia-${String(n).padStart(4, "0")}`;
const nb = (text: string): string => text.replace(/ — /g, `${NBSP}— `);
const plain = (text: string | null | undefined): string => (text ?? "").replace(/ /g, " ");

type Harness = Awaited<ReturnType<typeof studio>> & { events: EventMessage[] };

async function clipsStudio(): Promise<Harness> {
  const h = await studio({ photos: PHOTOS });
  const events: EventMessage[] = [];
  h.client.subscribe((e) => events.push(e));
  return { ...h, events };
}

const ended = (h: Harness, jobId: string): boolean => h.events.some((e) => (e.type === "job.done" || e.type === "job.failed" || e.type === "job.cancelled") && e.payload.jobId === jobId);

/** Runs the mock's clock until the job has ended, and no further. */
function runJob(h: Harness, jobId: string): void {
  act(() => {
    for (let i = 0; i < 3_000 && !ended(h, jobId); i++) if (!h.scheduler.next()) break;
  });
}

/** The import job of a clip's copy this window or another started (from the events: its ref carries the clip's origin). */
function importJobOf(h: Harness, clipId: string): string {
  for (const e of h.events) {
    if (e.type === "job.progress" && e.payload.kind === "import" && e.payload.origin?.clipId === clipId) return e.payload.jobId;
  }
  throw new Error(`no import job of ${clipId}`);
}

/** A ready clip of `photoId`, made as another window would (the sheet), its job played to its end. */
async function makeClip(h: Harness, photoId: string, motionId = "g-blink"): Promise<string> {
  const reply = await asAnotherWindow(() => h.client.request("clips.create", createPayload({ photoId, motionId })));
  if (!reply.ok) throw new Error(`clips.create: ${reply.error.code}`);
  runJob(h, reply.result.jobId);
  await flush();
  return reply.result.jobId;
}

/** A clip's copy made as another window would: its media id. */
async function makeCopy(h: Harness, clipId: string): Promise<string> {
  const reply = await asAnotherWindow(() => h.client.request("media.importClip", { avatarId: MIA.avatarId, clipId }));
  if (!reply.ok) throw new Error(`media.importClip: ${reply.error.code}`);
  if ("mediaId" in reply.result) return reply.result.mediaId;
  const jobId = reply.result.jobId;
  runJob(h, jobId);
  await flush();
  const done = h.events.find((e) => e.type === "job.done" && e.payload.jobId === jobId);
  if (done?.type !== "job.done" || done.payload.result.kind !== "import") throw new Error("the copy was not made");
  return done.payload.result.mediaId;
}

const copyClip = (index: number, mediaId: string): MontageDraft["clips"][number] => ({ clipId: `clip-${String(index + 1).padStart(3, "0")}`, durationMs: 2_000, transitionIn: "cut", kind: "video", mediaId, trimStartMs: 0, focus: null });

/** A draft «утро дома» of `clips`, saved as another window would; opened on `tab`. */
async function openEditor(h: Harness, clips: MontageDraft["clips"], tab = "Клипы"): Promise<void> {
  const made = await makeDraft(h.client, MIA.avatarId, []);
  const saved = await asAnotherWindow(() => h.client.request("montages.save", { montageId: made.montageId, spec: { ...made.spec, clips }, name: "утро дома" }));
  if (!saved.ok) throw new Error(`montages.save: ${saved.error.code}`);
  await openDrafts();
  await screen.findByRole("heading", { level: 3, name: /Mia/ });
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();
  fireEvent.click(within(media()).getByRole("tab", { name: tab }));
  await flush();
}

const media = (): HTMLElement => screen.getByRole("complementary", { name: "Медиа" });
const timeline = (): HTMLElement => screen.getByRole("region", { name: "Таймлайн" });
const props = (): HTMLElement => screen.getByRole("complementary", { name: "Свойства" });
const clipList = (): HTMLElement => within(media()).getByRole("list", { name: "Клипы аватара" });
const tiles = (): string[] => within(clipList()).getAllByRole("listitem").map((li) => plain(li.getAttribute("aria-label")));
const tileOf = (clipId: string): HTMLElement => {
  const li = clipList().querySelector<HTMLElement>(`li[data-clip-id="${clipId}"]`);
  if (li === null) throw new Error(`no tile ${clipId}`);
  return li;
};
const pickOf = (clipId: string): HTMLElement => {
  const button = tileOf(clipId).querySelector<HTMLElement>("button.edc-pick");
  if (button === null) throw new Error(`no button ${clipId}`);
  return button;
};
const kadrs = (): string[] =>
  within(within(timeline()).getByRole("list", { name: "Кадры" }))
    .getAllByRole("button")
    .flatMap((b) => {
      const label = b.getAttribute("aria-label") ?? "";
      return label.startsWith("Кадр ") ? [plain(label)] : [];
    });

describe("57: the «Клипы» tab", () => {
  test("six tabs, «Клипы» after «Фото»; the avatar's ready clips newest first, with their length, motion and «Фото N»; no delete", async () => {
    const h = await clipsStudio();
    const a = await makeClip(h, P(9));
    const b = await makeClip(h, P(7), "g-tilt");
    await openEditor(h, [photoClip(0, P(2)), photoClip(1, P(4))]);
    expect(within(media()).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Фото", "Клипы", "Мои", "Музыка", "GIF", "Текст"]);
    expect(within(media()).getByRole("tab", { name: "Клипы" }).getAttribute("aria-selected")).toBe("true");
    expect(tiles()).toEqual(["Клип «Наклоняет голову», 0:05, Фото 4 · не использован", "Клип «Моргает и улыбается», 0:05, Фото 2 · не использован"]);
    expect(plain(pickOf(b).getAttribute("aria-label"))).toBe("Клип «Наклоняет голову», 0:05: добавить кадр в конец ролика");
    expect(plain(pickOf(a).getAttribute("title"))).toBe("Клик — видео с начала, до 2 с, в конец ролика");
    expect(plain(tileOf(a).querySelector(".clip-len")?.textContent)).toBe("0:05");
    expect(plain(tileOf(a).querySelector(".edc-src")?.textContent)).toBe("Фото 2");
    expect(plain(media().querySelector(".ed-bin-hint")?.textContent)).toBe("Клик — кадр в конец ролика. Перетащите на «Кадры», чтобы вставить между кадрами.");
    expect(within(media()).getByText("Mia").getAttribute("title")).toBe("Аватар черновика не меняется");
    expect(within(media()).queryAllByRole("button", { name: /Удалить/ })).toEqual([]);
  });

  test("no room left of the 15 s: the hint says so of a clip (WAD re-review N5), and a free clip cannot be added", async () => {
    const h = await clipsStudio();
    const clip = await makeClip(h, P(7), "g-tilt");
    await openEditor(h, [photoClip(0, P(2), 7_500), photoClip(1, P(4), 7_500)]);
    const hint = media().querySelector(".ed-bin-hint");
    expect(hint?.textContent).toBe("В ролике уже 15 с: на новый кадр нет места. Укоротите кадр, чтобы добавить клип.");
    expect(hint?.classList.contains("ed-bin-hint-full")).toBe(true);
    expect(plain(pickOf(clip).getAttribute("aria-label"))).toBe("Клип «Наклоняет голову», 0:05: кадров больше не добавить");
    expect(pickOf(clip).hasAttribute("disabled")).toBe(true);
    expect(pickOf(clip).getAttribute("draggable")).toBe("false");
  });

  test("57d: no clips yet — the empty card", async () => {
    const h = await clipsStudio();
    await openEditor(h, [photoClip(0, P(2))]);
    expect(within(media()).getByText("Клипов пока нет.")).toBeDefined();
    expect(media().querySelector(".edc-empty .faint")?.textContent).toBe(nb("Оживите фото — они появятся здесь."));
  });
});

describe("57a: a click makes the clip's copy and places it", () => {
  test("no copy yet: «Готовим для монтажа…» on the tile (focusable, aria-disabled and busy), then the copy is the last kadr, «▶ клип»", async () => {
    const h = await clipsStudio();
    const b = await makeClip(h, P(7), "g-tilt");
    await openEditor(h, [photoClip(0, P(2)), photoClip(1, P(4))]);
    fireEvent.click(pickOf(b));
    await flush();
    expect(callsOf(h.engine, "media.importClip").map((c) => c.payload)).toEqual([{ avatarId: MIA.avatarId, clipId: b }]);
    expect(tiles()).toEqual(["Клип «Наклоняет голову», 0:05, Фото 4 · Готовим для монтажа…"]);
    const pick = pickOf(b);
    expect(pick.getAttribute("aria-disabled")).toBe("true");
    expect(pick.getAttribute("aria-busy")).toBe("true");
    expect(pick.hasAttribute("disabled")).toBe(false);
    expect(within(tileOf(b)).getByRole("status").textContent).toBe("Готовим для монтажа…");
    // A second click while it is made asks nothing again.
    fireEvent.click(pick);
    await flush();
    expect(callsOf(h.engine, "media.importClip")).toHaveLength(1);

    runJob(h, importJobOf(h, b));
    await flush();
    expect(kadrs()).toEqual(["Кадр 1: 1 фото, 2.0 с", "Кадр 2: 1 фото, 2.0 с", "Кадр 3: клип «Наклоняет голову», 2.0 с"]);
    expect(timeline().querySelector(".ed-clip-on .ed-ctag-top")?.textContent).toBe("▶ клип");
    expect(tiles()).toEqual(["Клип «Наклоняет голову», 0:05, Фото 4 · в кадре 3"]);
    expect(plain(pickOf(b).getAttribute("aria-label"))).toBe("Клип «Наклоняет голову», 0:05: выбрать кадр 3");
    expect(tileOf(b).querySelector(".ed-bin-slot")?.textContent).toBe("3");
  });

  test("a click on a placed clip selects its kadr; a clip whose copy exists is placed at once, with no job", async () => {
    const h = await clipsStudio();
    const b = await makeClip(h, P(7), "g-tilt");
    const copy = await makeCopy(h, b);
    await openEditor(h, [photoClip(0, P(2)), photoClip(1, P(4))]);
    fireEvent.click(pickOf(b));
    await flush();
    // The live copy came back with the answer: placed at once.
    expect(kadrs().at(-1)).toBe("Кадр 3: клип «Наклоняет голову», 2.0 с");
    const imports = h.events.filter((e) => e.type === "job.progress" && e.payload.kind === "import").length;
    // Selected: another click selects it again and asks nothing.
    fireEvent.click(within(timeline()).getByRole("button", { name: /^Кадр 1:/ }));
    await flush();
    fireEvent.click(pickOf(b));
    await flush();
    expect(callsOf(h.engine, "media.importClip")).toHaveLength(2);
    expect(within(timeline()).getByRole("button", { name: /^Кадр 3: клип «Наклоняет голову», 2\.0\sс$/ }).getAttribute("aria-pressed")).toBe("true");
    expect(h.events.filter((e) => e.type === "job.progress" && e.payload.kind === "import").length).toBe(imports);
    expect(copy).toMatch(/^media-/);
  });

  test("57a #drop: a clip let go on «Кадры» shows «Готовим для монтажа…» where it goes, and goes there when its copy is made", async () => {
    const h = await clipsStudio();
    const b = await makeClip(h, P(7), "g-tilt");
    await openEditor(h, [photoClip(0, P(2)), photoClip(1, P(4))]);
    const lane = timeline().querySelector(".ed-lane-clips");
    if (lane === null) throw new Error("no clip lane");
    fireEvent.dragStart(pickOf(b));
    fireEvent.dragOver(lane, { clientX: 0 });
    fireEvent.drop(lane, { clientX: 0 });
    await flush();
    expect(plain(timeline().querySelector(".edc-drop")?.textContent)).toBe("Готовим для монтажа…");
    runJob(h, importJobOf(h, b));
    await flush();
    expect(timeline().querySelector(".edc-drop")).toBeNull();
    expect(kadrs()[0]).toBe("Кадр 1: клип «Наклоняет голову», 2.0 с");
  });

  test("the preparing tile comes back from the job list after a window reload", async () => {
    const h = await clipsStudio();
    const b = await makeClip(h, P(7), "g-tilt");
    await openEditor(h, [photoClip(0, P(2)), photoClip(1, P(4))]);
    fireEvent.click(pickOf(b));
    await flush();
    // The window reloads: a new App over the same engine; the import is still on its way.
    cleanup();
    render(<App client={h.client} />);
    await screen.findByRole("heading", { level: 2, name: MIA.name });
    await openDrafts();
    fireEvent.click(await screen.findByRole("button", { name: "Открыть" }));
    await screen.findByRole("region", { name: "Таймлайн" });
    await flush();
    fireEvent.click(within(media()).getByRole("tab", { name: "Клипы" }));
    await flush();
    expect(tiles()).toEqual(["Клип «Наклоняет голову», 0:05, Фото 4 · Готовим для монтажа…"]);
  });
});

describe("57b: a frame taken (Q-F = 1)", () => {
  test("the clip's photo in the draft, a sibling's copy in the draft: dimmed, «уже занято», titled", async () => {
    const h = await clipsStudio();
    const a = await makeClip(h, P(9));
    const b = await makeClip(h, P(7), "g-tilt");
    const c = await makeClip(h, P(7), "g-breath");
    const copy = await makeCopy(h, b);
    await openEditor(h, [photoClip(0, P(9)), photoClip(1, P(4)), copyClip(2, copy)]);
    expect(tiles()).toEqual([
      "Клип «Медленный вдох», 0:05, Фото 4 · клип этого фото уже в ролике",
      "Клип «Наклоняет голову», 0:05, Фото 4 · в кадре 3",
      "Клип «Моргает и улыбается», 0:05, Фото 2 · это фото уже в ролике",
    ]);
    expect(plain(pickOf(c).getAttribute("aria-label"))).toBe("Клип «Медленный вдох», 0:05: уже занято");
    expect(pickOf(c).hasAttribute("disabled")).toBe(true);
    expect(pickOf(c).getAttribute("title")).toBe("Клип этого фото уже в ролике");
    expect(pickOf(a).getAttribute("title")).toBe("Это фото уже в ролике");
    expect(tileOf(c).querySelector(".edc-band")?.textContent).toBe("клип этого фото уже в ролике");
    fireEvent.click(pickOf(a));
    await flush();
    expect(callsOf(h.engine, "media.importClip").filter((call) => call.payload.clipId === a)).toEqual([]);
  });

  test("in a finished video: «в видео», titled by how the video holds the frame; a rejected photo's clip: «фото отклонено»", async () => {
    const h = await clipsStudio();
    const used = await makeClip(h, P(5));
    const sibling = await makeClip(h, P(5), "g-tilt");
    const rejected = await makeClip(h, P(3), "g-breath");
    const copy = await makeCopy(h, used);
    const rendered = await asAnotherWindow(() => h.client.request("videos.render", { spec: { schemaVersion: 1, avatarId: MIA.avatarId, layers: [], music: null, seed: 7, clips: [photoClip(0, P(6)), copyClip(1, copy)] } }));
    if (!rendered.ok) throw new Error(`videos.render: ${rendered.error.code}`);
    runJob(h, rendered.result.jobId);
    await asAnotherWindow(() => h.client.request("photos.setRejected", { avatarId: MIA.avatarId, photoId: P(3), rejected: true }));
    await openEditor(h, [photoClip(0, P(2)), photoClip(1, P(4))]);
    // The rejected photo has no number in the bin: its clip is called by the photo's category.
    expect(tiles()).toEqual(["Клип «Медленный вдох», 0:05, Дом · фото отклонено", "Клип «Наклоняет голову», 0:05, Фото 6 · в видео", "Клип «Моргает и улыбается», 0:05, Фото 6 · в видео"]);
    expect(pickOf(used).getAttribute("title")).toBe("Этот клип уже в готовом видео — второй раз не ставится");
    expect(pickOf(sibling).getAttribute("title")).toBe("Фото этого клипа или другой клип из него уже в готовом видео — второй раз не ставится");
    expect(pickOf(rejected).getAttribute("title")).toBe("Фото этого клипа отклонено — в монтаж не ставится");
    expect(tileOf(used).querySelector(".edc-state")?.textContent).toBe("в видео");
    expect(tileOf(rejected).querySelector(".edc-state")?.textContent).toBe("фото отклонено");
  });
});

describe("57b: a frame held by a render", () => {
  test("a render that holds the clip's photo: «в рендере», dimmed, «уже занято»", async () => {
    const h = await clipsStudio();
    const clip = await makeClip(h, P(5));
    const rendering = await asAnotherWindow(() => h.client.request("videos.render", { spec: { schemaVersion: 1, avatarId: MIA.avatarId, layers: [], music: null, seed: 7, clips: [photoClip(0, P(5)), photoClip(1, P(6))] } }));
    if (!rendering.ok) throw new Error(`videos.render: ${rendering.error.code}`);
    await openEditor(h, [photoClip(0, P(2)), photoClip(1, P(4))]);
    expect(tiles()).toEqual(["Клип «Моргает и улыбается», 0:05, Фото 6 · в рендере"]);
    expect(tileOf(clip).querySelector(".edc-state")?.textContent).toBe("в рендере");
    expect(plain(pickOf(clip).getAttribute("aria-label"))).toBe("Клип «Моргает и улыбается», 0:05: уже занято");
    expect(pickOf(clip).hasAttribute("title")).toBe(false);
  });
});

describe("57c: a refused preparation, one text per reason", () => {
  test("NOT_FOUND (the clip went in another window): no card, and the tile goes with the list read again", async () => {
    const h = await clipsStudio();
    const clip = await makeClip(h, P(7), "g-tilt");
    await openEditor(h, [photoClip(0, P(2)), photoClip(1, P(4))]);
    // Another window deletes the clip; this tab has not read its list since.
    await asAnotherWindow(() => h.client.request("clips.delete", { avatarId: MIA.avatarId, clipId: clip }));
    fireEvent.click(pickOf(clip));
    await flush();
    await flush();
    expect(within(media()).queryByRole("alert")).toBeNull();
    expect(within(media()).getByText("Клипов пока нет.")).toBeDefined();
  });

  test("an importer failure: the card over the tiles, the tile marked and pressable; ✕ closes the card", async () => {
    const h = await clipsStudio();
    const b = await makeClip(h, P(7), "g-tilt");
    await openEditor(h, [photoClip(0, P(2)), photoClip(1, P(4))]);
    h.engine.failNextClipImport("codec");
    fireEvent.click(pickOf(b));
    await flush();
    runJob(h, importJobOf(h, b));
    await flush();
    const card = within(media()).getByRole("alert");
    expect(plain(card.textContent)).toBe(`Клип «Наклоняет голову»${plain(nb("Не удалось подготовить клип — файл в Studio цел. Попробуйте ещё раз."))}`);
    expect(card.textContent).toContain(`клип${NBSP}— файл`);
    expect(tileOf(b).classList.contains("edc-tile-failed")).toBe(true);
    expect(pickOf(b).hasAttribute("disabled")).toBe(false);
    expect(kadrs()).toHaveLength(2);
    fireEvent.click(within(card).getByRole("button", { name: "Закрыть: Клип «Наклоняет голову»" }));
    await flush();
    expect(within(media()).queryByRole("alert")).toBeNull();
    // «Мои» never shows a clip import's failure.
    fireEvent.click(within(media()).getByRole("tab", { name: "Мои" }));
    await flush();
    expect(within(media()).queryByRole("alert")).toBeNull();
  });

  test("a full disk: the video's no-space text; the tile pressable again", async () => {
    const h = await clipsStudio();
    const b = await makeClip(h, P(7), "g-tilt");
    await openEditor(h, [photoClip(0, P(2)), photoClip(1, P(4))]);
    h.engine.refuseNextClipImport("no-space");
    fireEvent.click(pickOf(b));
    await flush();
    expect(within(media()).getByRole("alert").textContent).toContain(nb(mediaReasonRu("no-space", "video")));
    expect(pickOf(b).hasAttribute("disabled")).toBe(false);
  });

  test("a damaged file: the contract's text; the tile no longer pressable, even once the card is closed", async () => {
    const h = await clipsStudio();
    const b = await makeClip(h, P(7), "g-tilt");
    await openEditor(h, [photoClip(0, P(2)), photoClip(1, P(4))]);
    h.engine.damageClipFile(b);
    fireEvent.click(pickOf(b));
    await flush();
    expect(within(media()).getByRole("alert").textContent).toContain(nb(CLIP_REASONS_RU["file-damaged"]));
    expect(pickOf(b).hasAttribute("disabled")).toBe(true);
    expect(plain(pickOf(b).getAttribute("aria-label"))).toBe("Клип «Наклоняет голову», 0:05: не подготовить");
    expect(pickOf(b).getAttribute("title")).toBe(CLIP_REASONS_RU["file-damaged"]);
    fireEvent.click(within(media()).getByRole("button", { name: "Закрыть: Клип «Наклоняет голову»" }));
    await flush();
    expect(pickOf(b).hasAttribute("disabled")).toBe(true);
    expect(tiles()).toEqual(["Клип «Наклоняет голову», 0:05, Фото 4 · файл повреждён"]);
  });
});

describe("57e, 57f: the copy in the draft", () => {
  test("57e: in «Фото» the photo of a clip in the draft is dimmed «клип этого фото уже в ролике» and cannot be added", async () => {
    const h = await clipsStudio();
    const b = await makeClip(h, P(7), "g-tilt");
    const copy = await makeCopy(h, b);
    await openEditor(h, [photoClip(0, P(2)), copyClip(1, copy)], "Фото");
    const bin = within(media()).getByRole("list", { name: "Фото аватара" });
    const photo4 = within(bin).getByRole("button", { name: "Фото 4: уже занято" });
    expect(photo4.hasAttribute("disabled")).toBe(true);
    expect(photo4.getAttribute("title")).toBe("Клип этого фото уже в ролике");
    expect(photo4.closest("li")?.getAttribute("aria-label")).toBe("Фото 4 · клип этого фото уже в ролике");
    expect(photo4.closest("li")?.querySelector(".edc-band")?.textContent).toBe("клип этого фото уже в ролике");
  });

  test("57f: a selected copy is «клип» — its motion and photo, never the copy's file name; it is neither split nor duplicated", async () => {
    const h = await clipsStudio();
    const b = await makeClip(h, P(7), "g-tilt");
    const copy = await makeCopy(h, b);
    await openEditor(h, [photoClip(0, P(2)), photoClip(1, P(4)), copyClip(2, copy)]);
    fireEvent.click(within(timeline()).getByRole("button", { name: /^Кадр 3: клип «Наклоняет голову», 2\.0\sс$/ }));
    await flush();
    expect(plain(props().querySelector(".ed-props-sub")?.textContent)).toBe("клип · 4.0–6.0 с");
    expect(props().querySelector(".ed-video-name")?.textContent).toBe("Наклоняет голову");
    expect(props().querySelector(".edc-card-src")?.textContent).toBe("Фото 4");
    expect(props().querySelector(".ed-video-tags .tag")?.textContent).toBe("клип");
    expect(within(props()).queryByText("свой файл")).toBeNull();
    const duplicate = within(props()).getByRole("button", { name: "Дублировать" });
    expect(duplicate.hasAttribute("disabled")).toBe(true);
    expect(duplicate.getAttribute("title")).toBe("Клип не копируется: одно фото — один раз в ролике");
    expect(within(timeline()).getByRole("button", { name: "Разрезать по плейхеду" }).getAttribute("title")).toBe("Клип не режется: одно фото — один раз в ролике");
    expect(within(timeline()).getByRole("button", { name: "Дублировать выбранное" }).getAttribute("title")).toBe("Клип не копируется: одно фото — один раз в ролике");
    expect(screen.getByRole("button", { name: "Кадр 3: клип" })).toBeDefined();
    // The selected copy fills the 9:16 frame: its pill says «клип» where an own video's says «видео».
    expect(screen.getByRole("region", { name: "Превью" }).querySelector(".pv-video-pill")?.textContent).toBe("клип 9:16 · весь кадр");
    // The copy's own file name («Клип <дата> <время>.mp4») is nowhere: not in the text, not in a name.
    expect(document.body.textContent?.includes(".mp4")).toBe(false);
    expect(document.body.textContent?.includes("Клип 20")).toBe(false);
    expect(Array.from(document.querySelectorAll("[aria-label]")).some((el) => (el.getAttribute("aria-label") ?? "").includes(".mp4"))).toBe(false);
  });
});

describe("«Мои» never lists a clip's copy", () => {
  test("neither the copy nor a copy being made: the library reads empty", async () => {
    const h = await clipsStudio();
    const b = await makeClip(h, P(7), "g-tilt");
    await makeCopy(h, b);
    const c = await makeClip(h, P(9));
    await openEditor(h, [photoClip(0, P(2)), photoClip(1, P(4))]);
    fireEvent.click(pickOf(c));
    await flush();
    fireEvent.click(within(media()).getByRole("tab", { name: "Мои" }));
    await flush();
    expect(within(media()).getByText("Своих файлов пока нет")).toBeDefined();
    expect(within(media()).queryByRole("status")).toBeNull();
  });
});
