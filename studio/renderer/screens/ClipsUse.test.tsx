import { describe, expect, test } from "bun:test";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { EventMessage, MontageDraft } from "../../shared/engine";
import { createPayload } from "../engine/mockEngine.clips.testkit";
import { freePhotos } from "../engine/mockEngine.testkit";
import { NBSP } from "../lib/format";
import { callsOf, describeElement, flush, focusedLabel } from "../testing";
import { asAnotherWindow, makeDraft, MIA, studio } from "./montage/screenKit";
import { photoClip } from "./montage/testkit";

// 5b.2 part A (S5.WA4; plan §6 41e, 44b; mockups 41e and 44b, README §S5.WAD, WAD re-review N4): the avatar's «Клипы» screen tells a clip's use
// (`ClipSummary.use`, Q-F = 1). A clip whose frame is in a finished video wears «в видео», whichever way the video holds it (the title tells which).
// «Удалить клип?» says a finished video keeps its picture when it holds THIS clip, and names the drafts holding its copy. A render holding the copy refuses
// the delete `in-use`: the dialog stays, says so as an alert, the focus goes to «Отмена», and «Удалить» stays (a try after the render is harmless).

const PHOTOS = freePhotos(10);
const P = (n: number): string => `photo-mia-${String(n).padStart(4, "0")}`;
const nb = (text: string): string => text.replace(/ — /g, `${NBSP}— `);

type Harness = Awaited<ReturnType<typeof studio>> & { events: EventMessage[] };

async function clipsStudio(): Promise<Harness> {
  const h = await studio({ photos: PHOTOS });
  const events: EventMessage[] = [];
  h.client.subscribe((e) => events.push(e));
  return { ...h, events };
}

const ended = (h: Harness, jobId: string): boolean => h.events.some((e) => (e.type === "job.done" || e.type === "job.failed" || e.type === "job.cancelled") && e.payload.jobId === jobId);

function runJob(h: Harness, jobId: string): void {
  act(() => {
    for (let i = 0; i < 3_000 && !ended(h, jobId); i++) if (!h.scheduler.next()) break;
  });
}

async function makeClip(h: Harness, photoId: string, motionId = "g-blink"): Promise<string> {
  const reply = await asAnotherWindow(() => h.client.request("clips.create", createPayload({ photoId, motionId })));
  if (!reply.ok) throw new Error(`clips.create: ${reply.error.code}`);
  runJob(h, reply.result.jobId);
  await flush();
  return reply.result.jobId;
}

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
const specOf = (clips: MontageDraft["clips"]): MontageDraft => ({ schemaVersion: 1, avatarId: MIA.avatarId, layers: [], music: null, seed: 7, clips });

/** A render of `clips` (as another window would start it): its job id. */
async function startRender(h: Harness, clips: MontageDraft["clips"]): Promise<string> {
  const reply = await asAnotherWindow(() => h.client.request("videos.render", { spec: specOf(clips) }));
  if (!reply.ok) throw new Error(`videos.render: ${reply.error.code}`);
  return reply.result.jobId;
}

/** A draft named `name` holding `clips`, saved as another window would. */
async function saveDraft(h: Harness, name: string, clips: MontageDraft["clips"]): Promise<void> {
  const made = await makeDraft(h.client, MIA.avatarId, []);
  const saved = await asAnotherWindow(() => h.client.request("montages.save", { montageId: made.montageId, spec: { ...made.spec, clips }, name }));
  if (!saved.ok) throw new Error(`montages.save: ${saved.error.code}`);
}

/** Mia's screen on its «Клипы» tab. */
async function openClips(): Promise<void> {
  fireEvent.click(await screen.findByRole("button", { name: "Mia" }));
  await screen.findByRole("heading", { level: 1, name: "Mia" });
  await flush();
  fireEvent.click(screen.getByRole("tab", { name: /^Клипы/ }));
  await flush();
  await flush();
}

/** A ready tile by its motion; a used one's name goes on with why (S5.WAR L8). */
const tile = (name: string): HTMLElement => screen.getByRole("article", { name: (accessible) => accessible === `Клип: ${name}` || accessible.startsWith(`Клип: ${name} · `) });
const viewer = (): HTMLElement => screen.getByRole("dialog", { name: /^Клип \d+ из \d+$/ });
const ask = (): HTMLElement => screen.getByRole("alertdialog", { name: "Удалить клип?" });

async function askDelete(name: string): Promise<HTMLElement> {
  fireEvent.click(within(tile(name)).getByRole("button", { name: `Открыть клип «${name}», 0:05` }));
  await flush();
  await flush();
  fireEvent.click(within(viewer()).getByRole("button", { name: "Удалить" }));
  await flush();
  return ask();
}

/** The dialog's lines under 44's text (44b), in order. */
const notes = (dialog: HTMLElement): string[] => Array.from(dialog.querySelectorAll(".del-note")).map((note) => note.textContent ?? "");

const describedBy = (dialog: HTMLElement): string =>
  (dialog.getAttribute("aria-describedby") ?? "")
    .split(" ")
    .map((id) => document.getElementById(id)?.textContent ?? "")
    .join(" | ");

describe("41e: «в видео» on the «Клипы» tile", () => {
  test("a clip whose frame is in a finished video, through the clip or through its photo: one badge, the title tells which", async () => {
    const h = await clipsStudio();
    const used = await makeClip(h, P(5));
    await makeClip(h, P(5), "g-tilt");
    await makeClip(h, P(7), "g-breath");
    const copy = await makeCopy(h, used);
    runJob(h, await startRender(h, [photoClip(0, P(6)), copyClip(1, copy)]));
    await openClips();
    const byClip = tile("Моргает и улыбается").querySelector(".clip-used");
    const byPhoto = tile("Наклоняет голову").querySelector(".clip-used");
    expect(byClip?.textContent).toBe("в видео");
    expect(byClip?.getAttribute("title")).toBe("Этот клип уже в готовом видео — второй раз не ставится");
    expect(byPhoto?.textContent).toBe("в видео");
    expect(byPhoto?.getAttribute("title")).toBe("Это фото или другой его клип уже в готовом видео — кадр второй раз не ставится");
    expect(tile("Медленный вдох").querySelector(".clip-used") === null).toBe(true);
    // S5.WAR L8: the badge's reason is in the tile's name too (its title alone is the pointer's).
    expect(tile("Моргает и улыбается").getAttribute("aria-label")).toBe("Клип: Моргает и улыбается · Этот клип уже в готовом видео — второй раз не ставится");
    expect(tile("Наклоняет голову").getAttribute("aria-label")).toBe("Клип: Наклоняет голову · Это фото или другой его клип уже в готовом видео — кадр второй раз не ставится");
    expect(tile("Медленный вдох").getAttribute("aria-label")).toBe("Клип: Медленный вдох");
  });
});

describe("44b: «Удалить клип?» says what holds the clip", () => {
  test("a finished video holds this clip: «Клип есть в готовом видео — видео не изменится.», described by the dialog", async () => {
    const h = await clipsStudio();
    const used = await makeClip(h, P(5));
    const copy = await makeCopy(h, used);
    runJob(h, await startRender(h, [photoClip(0, P(6)), copyClip(1, copy)]));
    await openClips();
    const dialog = await askDelete("Моргает и улыбается");
    expect(notes(dialog)).toEqual([nb("Клип есть в готовом видео — видео не изменится.")]);
    expect(describedBy(dialog)).toContain(nb("Клип есть в готовом видео — видео не изменится."));
  });

  test("its photo is in a video, not the clip: the dialog says nothing of videos", async () => {
    const h = await clipsStudio();
    await makeClip(h, P(5), "g-tilt");
    runJob(h, await startRender(h, [photoClip(0, P(6)), photoClip(1, P(5))]));
    await openClips();
    const dialog = await askDelete("Наклоняет голову");
    expect(dialog.querySelectorAll(".del-note")).toHaveLength(0);
  });

  test("one draft holds its copy: named, with its kadr, and described by the dialog", async () => {
    const h = await clipsStudio();
    const clip = await makeClip(h, P(5));
    const copy = await makeCopy(h, clip);
    await saveDraft(h, "утро дома", [photoClip(0, P(2)), photoClip(1, P(4)), copyClip(2, copy)]);
    await openClips();
    const dialog = await askDelete("Моргает и улыбается");
    expect(notes(dialog)).toEqual([nb("В черновике «утро дома» он в кадре 3 — кадр будет помечен, пока его не замените.")]);
    expect(describedBy(dialog)).toContain("В черновике «утро дома»");
  });

  test("several drafts: «В 2 черновиках он стоит кадром — кадры будут помечены, пока их не замените.»", async () => {
    const h = await clipsStudio();
    const clip = await makeClip(h, P(5));
    const copy = await makeCopy(h, clip);
    await saveDraft(h, "утро дома", [photoClip(0, P(2)), copyClip(1, copy)]);
    await saveDraft(h, "вечер", [copyClip(0, copy), photoClip(1, P(4))]);
    await openClips();
    const dialog = await askDelete("Моргает и улыбается");
    expect(notes(dialog)).toEqual([nb(`В 2${NBSP}черновиках он стоит кадром — кадры будут помечены, пока их не замените.`)]);
  });

  test("#in-render: after «Удалить», a render holding the copy is said as an alert; the focus goes to «Отмена»; «Удалить» stays", async () => {
    const h = await clipsStudio();
    const clip = await makeClip(h, P(5));
    const copy = await makeCopy(h, clip);
    await startRender(h, [photoClip(0, P(6)), copyClip(1, copy)]);
    await openClips();
    const dialog = await askDelete("Моргает и улыбается");
    expect(within(dialog).queryByRole("alert") === null).toBe(true);
    fireEvent.click(within(dialog).getByRole("button", { name: "Удалить" }));
    await flush();
    await flush();
    expect(callsOf(h.engine, "clips.delete")).toHaveLength(1);
    const still = ask();
    const alert = within(still).getByRole("alert");
    expect(alert.textContent).toBe(nb("Клип сейчас в рендере — удалите его, когда рендер закончится."));
    expect(describedBy(still)).not.toContain("в рендере");
    expect(focusedLabel()).toBe(describeElement(within(still).getByRole("button", { name: "Отмена" })));
    const remove = within(still).getByRole("button", { name: "Удалить" });
    expect(remove.hasAttribute("disabled")).toBe(false);
    expect(remove.getAttribute("aria-disabled")).toBeNull();
    // S5.WAR L7: a second «Удалить» refused the same way is said again: a new alert, the focus on «Отмена» again.
    remove.focus();
    fireEvent.click(remove);
    await flush();
    await flush();
    expect(callsOf(h.engine, "clips.delete")).toHaveLength(2);
    const again = within(ask()).getByRole("alert");
    expect(again === alert).toBe(false);
    expect(again.textContent).toBe(nb("Клип сейчас в рендере — удалите его, когда рендер закончится."));
    expect(focusedLabel()).toBe(describeElement(within(ask()).getByRole("button", { name: "Отмена" })));
    // The viewer is still there behind it, the clip with it.
    expect(viewer()).toBeDefined();
  });
});
