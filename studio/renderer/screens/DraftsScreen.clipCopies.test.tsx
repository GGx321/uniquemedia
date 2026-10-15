import { describe, expect, test } from "bun:test";
import { act, screen, within } from "@testing-library/react";
import type { EventMessage, MontageDraft } from "../../shared/engine";
import { createPayload } from "../engine/mockEngine.clips.testkit";
import { freePhotos } from "../engine/mockEngine.testkit";
import { NBSP } from "../lib/format";
import { flush } from "../testing";
import { asAnotherWindow, makeDraft, MIA, openDrafts, studio } from "./montage/screenKit";
import { photoClip } from "./montage/testkit";

// 5b.2 (S5.WAR N1): the engine tells a draft's clip copy whose frame is no longer free at the clip (`["clips", i]`, Q-F = 1), and a draft that was
// rendered holds its copy's frame in its OWN video. «Черновики» reads where each flagged copy comes from (its photo, by the media list), so a rendered
// draft says «✓ уже N видео из этого черновика» and not a false «фото недоступно»; a draft whose copy's frame went into ANOTHER draft's video, with no
// video of its own, is still flagged. While a copy's origin cannot be read, its flag is not one the owner can fix, so it does not outrank the count.

const PHOTOS = freePhotos(10);
const P = (n: number): string => `photo-mia-${String(n).padStart(4, "0")}`;

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

/** A draft named `name` holding `clips`, saved as another window would: its id. */
async function saveDraft(h: Harness, name: string, clips: MontageDraft["clips"]): Promise<string> {
  const made = await makeDraft(h.client, MIA.avatarId, []);
  const saved = await asAnotherWindow(() => h.client.request("montages.save", { montageId: made.montageId, spec: { ...made.spec, clips }, name }));
  if (!saved.ok) throw new Error(`montages.save: ${saved.error.code}`);
  return made.montageId;
}

/** The draft rendered to its end, as another window would. */
async function render(h: Harness, montageId: string): Promise<void> {
  const reply = await asAnotherWindow(() => h.client.request("videos.render", { montageId }));
  if (!reply.ok) throw new Error(`videos.render: ${reply.error.code}`);
  runJob(h, reply.result.jobId);
  await flush();
}

const card = (name: string): HTMLElement => {
  const found = screen.queryAllByRole("article").find((c) => within(c).queryByRole("heading", { level: 3, name }) !== null);
  if (found === undefined) throw new Error(`no draft card «${name}»`);
  return found;
};

const noteOf = (name: string): string => card(name).querySelector(".draft-note")?.textContent ?? "";

describe("«Черновики»: a draft's clip copy whose frame is not free (S5.WAR N1)", () => {
  test("a rendered draft with a copy counts its video: «✓ уже 1 видео из этого черновика», no «фото недоступно»", async () => {
    const h = await clipsStudio();
    const copy = await makeCopy(h, await makeClip(h, P(5)));
    const montageId = await saveDraft(h, "утро дома", [photoClip(0, P(2)), photoClip(1, P(4)), copyClip(2, copy)]);
    await render(h, montageId);
    await openDrafts();
    await flush();
    const own = card("Mia · «утро дома»");
    expect(noteOf("Mia · «утро дома»")).toBe(`✓ уже 1${NBSP}видео из этого черновика`);
    expect(own.textContent?.includes("фото недоступно")).toBe(false);
    expect(own.className.includes("draft-card-warn")).toBe(false);
  });

  test("a draft whose copy's frame went into ANOTHER draft's video, with no video of its own, is flagged at the copy's kadr", async () => {
    const h = await clipsStudio();
    const copy = await makeCopy(h, await makeClip(h, P(5)));
    await saveDraft(h, "вечер", [photoClip(0, P(6)), copyClip(1, copy)]);
    await render(h, await saveDraft(h, "утро", [photoClip(0, P(5)), photoClip(1, P(8))]));
    await openDrafts();
    await flush();
    const flagged = card("Mia · «вечер»");
    expect(noteOf("Mia · «вечер»")).toBe("Кадр 2: фото уже в другом видео — замените его, иначе рендер недоступен");
    expect(flagged.className).toContain("draft-card-warn");
    expect(noteOf("Mia · «утро»")).toBe(`✓ уже 1${NBSP}видео из этого черновика`);
  });

  test("the copies' origins cannot be read: the rendered draft still counts its video, and the other draft is still flagged", async () => {
    const h = await clipsStudio();
    const copy = await makeCopy(h, await makeClip(h, P(5)));
    await render(h, await saveDraft(h, "утро дома", [photoClip(0, P(2)), photoClip(1, P(4)), copyClip(2, copy)]));
    await saveDraft(h, "вечер", [photoClip(0, P(6)), copyClip(1, copy)]);
    h.engine.failNext("media.list", { code: "INTERNAL", detail: "the media list could not be read" });
    await openDrafts();
    await flush();
    expect(noteOf("Mia · «утро дома»")).toBe(`✓ уже 1${NBSP}видео из этого черновика`);
    expect(card("Mia · «вечер»").className).toContain("draft-card-warn");
    expect(noteOf("Mia · «вечер»").startsWith("Кадр 2: ")).toBe(true);
  });
});
