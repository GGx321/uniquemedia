import { estimateBytesUpper } from "../../../shared/montage";
import { STICKER_MANIFEST } from "../../../shared/stickers";
import type { Control, RigOptions, World } from "./rigs";
import { parityListTracks } from "./tracks";
import type { Answer, Transcript } from "./transcript";

// The scenarios of the parity suite (Stage 3, 3d.1b). Each is one story told through the engine's own commands; the suite
// plays it against the mock and against the real engine, and the two transcripts must be equal (parity.test.ts). A scenario
// never reads an engine's internals and never sleeps: it sends commands and moves time with `advance` and `settle`.

export interface Scenario {
  readonly name: string;
  /** What the rig is started with, when the scenario needs more than the default. */
  readonly rig?: RigOptions;
  run(t: Transcript, world: World, control: Control): Promise<void>;
}

// ---------- reading answers ----------

function resultOf(answer: Answer): Record<string, unknown> {
  if (!answer.ok) throw new Error(`the scenario expected ok, got ${answer.error.code}`);
  return answer.result;
}

function objectAt(value: unknown, key: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null) throw new Error(`expected an object with ${key}`);
  const found: unknown = Object.entries(value).find(([k]) => k === key)?.[1];
  if (typeof found !== "object" || found === null) throw new Error(`expected an object at ${key}`);
  return Object.fromEntries(Object.entries(found));
}

function stringAt(record: Record<string, unknown>, key: string): string {
  const found = record[key];
  if (typeof found !== "string") throw new Error(`expected a string at ${key}`);
  return found;
}

/** The montage a `montages.create` or `montages.save` answered. */
const montageOf = (answer: Answer): Record<string, unknown> => objectAt(resultOf(answer), "montage");
const montageIdOf = (answer: Answer): string => stringAt(montageOf(answer), "montageId");
const specOf = (answer: Answer): unknown => montageOf(answer).spec;

/** What a `videos.render` answered. */
function renderedOf(answer: Answer): { jobId: string; videoId: string } {
  const result = resultOf(answer);
  return { jobId: stringAt(result, "jobId"), videoId: stringAt(result, "videoId") };
}

/** The first video `videos.list` answered (the newest). */
function newestVideoId(answer: Answer): string {
  const videos = resultOf(answer).videos;
  if (!Array.isArray(videos) || videos.length === 0) throw new Error("expected a video");
  const first: unknown = videos[0];
  if (typeof first !== "object" || first === null) throw new Error("expected a video record");
  return stringAt(Object.fromEntries(Object.entries(first)), "videoId");
}

// An own sticker is the one layer N9 still refuses (3f brings own media); a text layer and a built-in sticker render since 3b.6.
const ownStickerLayer = { layerId: "layer-0001", kind: "sticker", startMs: 0, endMs: 1_000, sticker: { source: "own", mediaId: "media-0000001" }, x: 0.5, y: 0.5, size: 0.2 };

/** A draft of `photoIds`, made and named. */
async function draft(t: Transcript, w: World, photoIds: readonly string[]): Promise<string> {
  return montageIdOf(await t.call("montages.create", { avatarId: w.avatarId, photoIds }));
}

const photo = (w: World, n: number): string => {
  const id = w.photoIds[n - 1];
  if (id === undefined) throw new Error(`the world has no photo ${n}`);
  return id;
};

export const SCENARIOS: readonly Scenario[] = [
  {
    name: "create, save, render, progress, done, list",
    async run(t, w) {
      const created = await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 1), photo(w, 2)] });
      const montageId = montageIdOf(created);
      await t.call("montages.save", { montageId, spec: specOf(created), name: "Кафе и город" });
      await t.call("montages.get", { montageId });
      await t.call("videos.render", { montageId });
      await t.advance("progress");
      await t.advance("saving");
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("photos.list", { avatarId: w.avatarId });
      await t.call("montages.list", { avatarId: w.avatarId });
    },
  },
  {
    name: "the kind of a video and its file names: photo, collage and mix, counted",
    async run(t, w) {
      const slides = await draft(t, w, [photo(w, 1), photo(w, 2), photo(w, 3), photo(w, 4), photo(w, 5)]);
      const single = await draft(t, w, [photo(w, 6)]);
      const collage = await draft(t, w, [photo(w, 7), photo(w, 8)]);
      for (const montageId of [slides, single, collage]) await t.call("videos.render", { montageId });
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
    },
  },
  {
    name: "cancel: a queued render ends at once and the running one goes on",
    async run(t, w) {
      const first = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      const second = await draft(t, w, [photo(w, 3), photo(w, 4)]);
      await t.call("videos.render", { montageId: first });
      const queued = renderedOf(await t.call("videos.render", { montageId: second }));
      await t.call("videos.cancel", { jobId: queued.jobId });
      await t.call("photos.list", { avatarId: w.avatarId });
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
    },
  },
  {
    name: "cancel: a running render ends when its work stops, and the next one starts",
    async run(t, w) {
      const first = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      const second = await draft(t, w, [photo(w, 3), photo(w, 4)]);
      const running = renderedOf(await t.call("videos.render", { montageId: first }));
      await t.call("videos.render", { montageId: second });
      await t.advance("progress");
      await t.call("videos.cancel", { jobId: running.jobId });
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("photos.list", { avatarId: w.avatarId });
    },
  },
  {
    name: "cancel: past the point of no return the cancel is ignored and the render is done",
    async run(t, w) {
      const montageId = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      const { jobId } = renderedOf(await t.call("videos.render", { montageId }));
      await t.advance("saving");
      await t.call("videos.cancel", { jobId });
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
    },
  },
  {
    name: "cancel: a job that ended, and a job nobody knows",
    async run(t, w) {
      const montageId = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      const { jobId } = renderedOf(await t.call("videos.render", { montageId }));
      await t.settle();
      await t.call("videos.cancel", { jobId });
      await t.call("videos.cancel", { jobId: "job-nobody-0009" });
    },
  },
  {
    name: "delete while queued: the draft of a queued render is deleted, and the video keeps no draft",
    async run(t, w) {
      const first = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      const second = await draft(t, w, [photo(w, 3), photo(w, 4)]);
      await t.call("videos.render", { montageId: first });
      await t.call("videos.render", { montageId: second });
      await t.call("montages.delete", { montageId: second });
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("montages.list", { avatarId: w.avatarId });
    },
  },
  {
    name: "delete while queued: a video is deleted while a render waits behind a running one",
    async run(t, w) {
      const first = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      await t.call("videos.render", { montageId: first });
      await t.settle();
      const videoId = newestVideoId(await t.call("videos.list", { avatarId: w.avatarId }));
      const second = await draft(t, w, [photo(w, 3), photo(w, 4)]);
      const third = await draft(t, w, [photo(w, 5), photo(w, 6)]);
      await t.call("videos.render", { montageId: second });
      await t.call("videos.render", { montageId: third });
      await t.call("videos.delete", { videoId, mode: "video" });
      await t.call("photos.list", { avatarId: w.avatarId });
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
    },
  },
  {
    name: "the draft is deleted during its render: montageId is null",
    async run(t, w) {
      const montageId = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      await t.call("videos.render", { montageId });
      await t.advance("progress");
      await t.call("montages.delete", { montageId });
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("montages.get", { montageId });
    },
  },
  {
    name: "one photo, one video: reserved and used photos are refused, and deleting the video frees them",
    async run(t, w) {
      const first = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      const single = await draft(t, w, [photo(w, 1)]);
      const overlap = await draft(t, w, [photo(w, 2), photo(w, 3)]);
      await t.call("videos.render", { montageId: first });
      t.note("the photos are held by the queued render");
      await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 4), photo(w, 1)] });
      await t.call("videos.render", { montageId: single });
      await t.call("montages.get", { montageId: single });
      await t.call("photos.list", { avatarId: w.avatarId });
      await t.settle();
      t.note("the photos are in a video");
      await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 2), photo(w, 4), photo(w, 1)] });
      await t.call("videos.render", { montageId: overlap });
      await t.call("montages.get", { montageId: overlap });
      await t.call("photos.list", { avatarId: w.avatarId });
      const videoId = newestVideoId(await t.call("videos.list", { avatarId: w.avatarId }));
      await t.call("videos.delete", { videoId, mode: "video" });
      await t.call("photos.list", { avatarId: w.avatarId });
      await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 1), photo(w, 2)] });
    },
  },
  {
    name: "the refusals of videos.render come in the engine's order",
    async run(t, w) {
      const empty = await draft(t, w, []);
      const layered = await draft(t, w, [photo(w, 1)]);
      const created = await t.call("montages.get", { montageId: layered });
      const stored = montageOf(created);
      await t.call("montages.save", { montageId: layered, spec: { ...objectAt(stored, "spec"), layers: [ownStickerLayer] }, name: null });
      const taken = await draft(t, w, [photo(w, 2)]);
      const same = await draft(t, w, [photo(w, 2)]);
      await t.call("videos.render", { montageId: taken });
      await t.call("videos.render", { montageId: "montage-nobody-0009" });
      await t.call("videos.render", { montageId: empty });
      await t.call("videos.render", { montageId: layered });
      await t.call("videos.render", { montageId: same });
      await t.call("videos.render", { spec: objectAt(stored, "spec") });
      await t.settle();
    },
  },
  {
    name: "export.status: announced when a check finds a change, and a render is refused while the folder is away",
    async run(t, w, control) {
      const montageId = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      await t.call("videos.render", { montageId });
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
      await control.exportFolder("away");
      t.note("the folder is away: nothing has checked yet");
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("videos.list", { avatarId: w.avatarId });
      const second = await draft(t, w, [photo(w, 3)]);
      await t.call("videos.render", { montageId: second });
      const videoId = newestVideoId(await t.call("videos.list", { avatarId: w.avatarId }));
      await t.call("videos.delete", { videoId, mode: "video" });
      await t.call("videos.delete", { videoId: "video-nobody-0009", mode: "video" });
      await control.exportFolder("back");
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("videos.render", { montageId: second });
      await t.settle();
    },
  },
  {
    name: "the export folder is changed: the old videos are elsewhere, and «Удалить» refuses while «Удалить запись» frees the photos",
    async run(t, w, control) {
      const first = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      await t.call("videos.render", { montageId: first });
      await t.settle();
      await control.exportFolder("elsewhere");
      const listed = await t.call("videos.list", { avatarId: w.avatarId });
      const videoId = newestVideoId(listed);
      await t.call("videos.delete", { videoId, mode: "video" });
      await t.call("videos.delete", { videoId, mode: "record" });
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("photos.list", { avatarId: w.avatarId });
      const second = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      await t.call("videos.render", { montageId: second });
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
    },
  },
  {
    name: "«Удалить запись» leaves the file, and «Удалить» takes it",
    async run(t, w) {
      const first = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      await t.call("videos.render", { montageId: first });
      await t.settle();
      const one = newestVideoId(await t.call("videos.list", { avatarId: w.avatarId }));
      await t.call("videos.delete", { videoId: one, mode: "record" });
      const second = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      await t.call("videos.render", { montageId: second });
      await t.settle();
      const two = newestVideoId(await t.call("videos.list", { avatarId: w.avatarId }));
      await t.call("videos.delete", { videoId: two, mode: "video" });
      await t.call("videos.delete", { videoId: two, mode: "video" });
      await t.call("videos.list", { avatarId: w.avatarId });
    },
  },
  {
    name: "a full queue refuses the next render and reserves nothing",
    async run(t, w) {
      const drafts: string[] = [];
      await t.quiet(async () => {
        for (let n = 1; n <= 21; n++) drafts.push(await draft(t, w, [photo(w, n)]));
        for (const montageId of drafts.slice(0, 20)) await t.call("videos.render", { montageId });
      });
      await t.call("videos.render", { montageId: drafts[20] });
      await t.call("photos.list", { avatarId: w.avatarId });
      await t.settle();
      await t.call("videos.render", { montageId: drafts[20] });
    },
  },
  {
    name: "a render whose ffmpeg fails ends failed: no video, and the photos are free again",
    async run(t, w, control) {
      const montageId = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      await t.call("videos.render", { montageId });
      control.failNextRender();
      await t.advance("progress");
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("photos.list", { avatarId: w.avatarId });
    },
  },
  {
    name: "montages.create: what it refuses, and what it stores",
    async run(t, w) {
      await t.call("montages.create", { avatarId: "avatar-nobody-0009", photoIds: [] });
      await t.call("montages.create", { avatarId: w.archivedAvatarId, photoIds: [] });
      await t.call("montages.create", { avatarId: w.avatarId, photoIds: w.photoIds.slice(0, 21) });
      await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 1), photo(w, 1)] });
      await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 1), "photo-nobody-0009", w.otherPhotoIds[0]] });
      await t.call("montages.create", { avatarId: w.avatarId, photoIds: [] });
      await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 1)] });
      await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 2), photo(w, 3), photo(w, 4)] });
      await t.call("montages.create", { avatarId: w.avatarId, photoIds: w.photoIds.slice(0, 6) });
      await t.call("montages.create", { avatarId: w.avatarId, photoIds: w.photoIds.slice(0, 20) });
    },
  },
  {
    name: "montages.get, save, delete and list: the refusals and the answers",
    async run(t, w) {
      const mine = await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 1)] });
      const montageId = montageIdOf(mine);
      const hers = await t.call("montages.create", { avatarId: w.otherAvatarId, photoIds: [] });
      await t.call("montages.get", { montageId: "montage-nobody-0009" });
      await t.call("montages.save", { montageId: "montage-nobody-0009", spec: specOf(mine), name: null });
      await t.call("montages.save", { montageId, spec: specOf(hers), name: null });
      await t.call("photos.setRejected", { avatarId: w.avatarId, photoId: photo(w, 1), rejected: true });
      await t.call("montages.save", { montageId, spec: specOf(mine), name: "Кафе" });
      await t.call("montages.get", { montageId });
      await t.call("montages.list", { avatarId: "avatar-nobody-0009" });
      await t.call("montages.list", {});
      await t.call("montages.list", { avatarId: w.otherAvatarId });
      await t.call("montages.delete", { montageId });
      await t.call("montages.delete", { montageId });
      await t.call("montages.save", { montageId, spec: specOf(mine), name: null });
      await t.call("montages.list", {});
    },
  },
  {
    name: "montages.focus: judged, unjudged, refused",
    async run(t, w) {
      const scene = (photoId: string) => ({ source: "scene", photoId });
      await t.call("montages.focus", { avatarId: w.avatarId, photo: scene(photo(w, 1)) });
      await t.call("montages.focus", { avatarId: w.avatarId, photo: scene(photo(w, 2)) });
      await t.call("montages.focus", { avatarId: w.avatarId, photo: { source: "own", mediaId: "media-own-0001" } });
      await t.call("montages.focus", { avatarId: w.avatarId, photo: scene("photo-nobody-0009") });
      await t.call("montages.focus", { avatarId: w.avatarId, photo: scene(w.otherPhotoIds[0] ?? "") });
      await t.call("montages.focus", { avatarId: w.archivedAvatarId, photo: scene(photo(w, 1)) });
      await t.call("montages.focus", { avatarId: "avatar-nobody-0009", photo: scene(photo(w, 1)) });
      await t.call("photos.setRejected", { avatarId: w.avatarId, photoId: photo(w, 3), rejected: true });
      await t.call("montages.focus", { avatarId: w.avatarId, photo: scene(photo(w, 3)) });
      const first = await draft(t, w, [photo(w, 1)]);
      await t.call("videos.render", { montageId: first });
      await t.settle();
      await t.call("montages.focus", { avatarId: w.avatarId, photo: scene(photo(w, 1)) });
    },
  },
  {
    name: "engine.snapshot: what a window resyncs from, while queued, saving, done, cancelled and failed",
    async run(t, w, control) {
      const snapshot = () => t.call("engine.snapshot", {});
      const [a, b, c, d, e, f] = [await draft(t, w, [photo(w, 1), photo(w, 2)]), await draft(t, w, [photo(w, 3), photo(w, 4)]), await draft(t, w, [photo(w, 5), photo(w, 6)]), await draft(t, w, [photo(w, 7), photo(w, 8)]), await draft(t, w, [photo(w, 9), photo(w, 10)]), await draft(t, w, [photo(w, 11), photo(w, 12)])];
      t.note("one running, one queued");
      await t.call("videos.render", { montageId: a });
      await t.call("videos.render", { montageId: b });
      await snapshot();
      t.note("the first is saving");
      await t.advance("saving");
      await snapshot();
      t.note("both done");
      await t.settle();
      await snapshot();
      t.note("one cancelled while queued, one while running");
      const running = renderedOf(await t.call("videos.render", { montageId: c }));
      const queued = renderedOf(await t.call("videos.render", { montageId: d }));
      await t.call("videos.cancel", { jobId: queued.jobId });
      await t.call("videos.cancel", { jobId: running.jobId });
      await t.settle();
      await snapshot();
      t.note("one failed");
      control.failNextRender();
      await t.call("videos.render", { montageId: e });
      await t.advance("progress");
      await t.settle();
      await snapshot();
      t.note("a draft deleted during its render: the job keeps the draft it came from, the video keeps none");
      await t.call("videos.render", { montageId: f });
      await t.call("montages.delete", { montageId: f });
      await t.settle();
      await snapshot();
      await t.call("videos.list", { avatarId: w.avatarId });
      t.note("the folder is away: the next check moves the status");
      await control.exportFolder("away");
      await snapshot();
      await t.call("videos.list", { avatarId: w.avatarId });
      await snapshot();
    },
  },
  {
    name: "engine.snapshot: the latest 50 finished renders are kept, the running one too",
    async run(t, w) {
      const [first, second] = [await draft(t, w, [photo(w, 1)]), await draft(t, w, [photo(w, 2)])];
      await t.call("videos.render", { montageId: first });
      await t.quiet(async () => {
        for (let n = 0; n < 55; n++) {
          const queued = renderedOf(await t.call("videos.render", { montageId: second }));
          await t.call("videos.cancel", { jobId: queued.jobId });
        }
      });
      await t.call("engine.snapshot", {});
    },
  },
  {
    name: "export folder: why a render is refused, and what every window is told",
    async run(t, w, control) {
      const created = await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 1), photo(w, 2)] });
      const [first, second] = [montageIdOf(created), await draft(t, w, [photo(w, 3), photo(w, 4)])];
      const upper = upperBytesOf(created);
      t.note("not enough room is refused for this render only: twice the size, less one byte");
      control.freeSpace(2 * upper - 1);
      await t.call("videos.render", { montageId: first });
      await t.call("engine.snapshot", {});
      t.note("twice the size exactly is enough");
      control.freeSpace(2 * upper);
      await t.call("videos.render", { montageId: first });
      await t.settle();
      control.freeSpace(null);
      t.note("the volume takes no write: refused, and every window is told");
      control.exportWritable(false);
      await t.call("videos.render", { montageId: second });
      await t.call("engine.snapshot", {});
      control.exportWritable(true);
      await t.call("videos.list", { avatarId: w.avatarId });
      t.note("a file where the folder should be");
      await control.exportFolder("file");
      await t.call("videos.render", { montageId: second });
      await control.exportFolder("back");
      await t.call("videos.render", { montageId: second });
      await t.settle();
      await t.call("engine.snapshot", {});
    },
  },
  {
    name: "export folder: a cancelled dialog changes nothing, another folder leaves the videos elsewhere, and choosing the first again brings them back",
    async run(t, w, control) {
      await t.call("videos.render", { montageId: await draft(t, w, [photo(w, 1), photo(w, 2)]) });
      await t.settle();
      await t.call("videos.render", { montageId: await draft(t, w, [photo(w, 3), photo(w, 4)]) });
      await t.settle();
      t.note("the dialog is cancelled");
      await control.exportDialog("cancel");
      await t.call("settings.setExportPath", {});
      await t.call("videos.list", { avatarId: w.avatarId });
      t.note("another folder: a marker of its own, both videos are elsewhere");
      await control.exportDialog("fresh");
      await t.call("settings.setExportPath", {});
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("engine.snapshot", {});
      t.note("a video made in the new folder");
      await t.call("videos.render", { montageId: await draft(t, w, [photo(w, 5), photo(w, 6)]) });
      await t.settle();
      t.note("the first folder again: its two videos resolve, the third is elsewhere");
      await control.exportDialog("first");
      await t.call("settings.setExportPath", {});
      await t.call("videos.list", { avatarId: w.avatarId });
    },
  },
  {
    name: "export folder: a folder the owner moved is the same folder, and every video resolves in it",
    async run(t, w, control) {
      await t.call("videos.render", { montageId: await draft(t, w, [photo(w, 1), photo(w, 2)]) });
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
      t.note("the owner moved the folder and points Settings at it");
      await control.exportDialog("moved");
      await t.call("settings.setExportPath", {});
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("engine.snapshot", {});
    },
  },
  {
    name: "export folder: a pick that cannot be the folder is refused with its reason, and nothing changes",
    async run(t, w, control) {
      const refuse = async (answer: "missing" | "file" | "damaged" | "insideLibrary", note: string): Promise<void> => {
        t.note(note);
        await control.exportDialog(answer);
        await t.call("settings.setExportPath", {});
      };
      await refuse("missing", "a folder that is not there");
      await refuse("file", "a file where a folder should be");
      await refuse("insideLibrary", "a folder inside the library");
      await refuse("damaged", "a damaged marker, while no video exists: the owner may delete the file");
      t.note("the volume takes no write");
      control.exportWritable(false);
      await control.exportDialog("fresh");
      await t.call("settings.setExportPath", {});
      control.exportWritable(true);
      await t.call("videos.render", { montageId: await draft(t, w, [photo(w, 1), photo(w, 2)]) });
      t.note("a render is queued: the folder cannot be changed under it");
      await control.exportDialog("fresh");
      await t.call("settings.setExportPath", {});
      await t.settle();
      await refuse("damaged", "a damaged marker, now that a video exists: the text that never advises deleting the file");
      await t.call("engine.snapshot", {});
      await t.call("videos.list", { avatarId: w.avatarId });
    },
  },
  {
    name: "export.check: a folder that went away shows up without a render attempt, and so does its return",
    async run(t, w, control) {
      await t.call("export.check", {});
      await control.exportFolder("away");
      t.note("the folder is away: only the check finds out, and tells the windows once");
      await t.call("export.check", {});
      await t.call("export.check", {});
      await t.call("engine.snapshot", {});
      await control.exportFolder("back");
      await t.call("export.check", {});
      t.note("a marker that became unreadable, with no video and with one");
      await control.exportMarker("damaged");
      await t.call("export.check", {});
      await control.exportMarker("intact");
      await t.call("export.check", {});
      await t.call("videos.render", { montageId: await draft(t, w, [photo(w, 1), photo(w, 2)]) });
      await t.settle();
      await control.exportMarker("damaged");
      await t.call("export.check", {});
      await t.call("videos.render", { montageId: await draft(t, w, [photo(w, 3), photo(w, 4)]) });
      await control.exportMarker("intact");
      await t.call("export.check", {});
    },
  },
  {
    name: "an editor's autosave burst: saves sent together answer in order, each echo before its answer, the latest wins",
    async run(t, w) {
      const created = await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 1)] });
      const montageId = montageIdOf(created);
      const spec = specOf(created);
      const save = (name: string) => ({ type: "montages.save", payload: { montageId, spec, name } });
      await t.burst([save("auto 1"), save("auto 2"), save("auto 3")]);
      await t.call("montages.get", { montageId });
      t.note("saves around a delete: the save after it finds nothing");
      await t.burst([save("auto 4"), { type: "montages.delete", payload: { montageId } }, save("auto 5")]);
      await t.call("montages.list", { avatarId: w.avatarId });
      t.note("a render sent right behind a save renders what that save stored");
      const target = montageIdOf(await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 2), photo(w, 3)] }));
      const other = specOf(await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 4)] }));
      await t.burst([{ type: "montages.save", payload: { montageId: target, spec: other, name: "one photo" } }, { type: "videos.render", payload: { montageId: target } }]);
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("photos.list", { avatarId: w.avatarId });
    },
  },
  {
    name: "a render whose commit fails in the saving phase ends failed: the saving step was seen, no video lands",
    async run(t, w, control) {
      const montageId = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      await t.call("videos.render", { montageId });
      control.failNextRender("saving");
      await t.advance("saving");
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("photos.list", { avatarId: w.avatarId });
    },
  },
  {
    // 3d.6: a waiting render and a starting one are both announced at zero; the window tells them apart by `queued`, which only the
    // first carries. The transcript does not write the flag (it would rewrite the older stories), so this one writes it as notes.
    name: "queued: a render that waits for a slot is announced queued, the first one and every start are not",
    async run(t, w) {
      const ids = [await draft(t, w, [photo(w, 1), photo(w, 2)]), await draft(t, w, [photo(w, 3), photo(w, 4)]), await draft(t, w, [photo(w, 5), photo(w, 6)])];
      for (const montageId of ids) await t.call("videos.render", { montageId });
      t.note(`announced queued: ${t.announcedQueued().join(", ")}`);
      await t.settle();
      t.note(`announced queued after every start: ${t.announcedQueued().join(", ")}`);
      await t.call("engine.snapshot", {});
    },
  },
  {
    name: "two renders at once: both run, the third waits, and a slot freed by a cancel starts it",
    rig: { renderConcurrency: 2 },
    async run(t, w) {
      const ids = [await draft(t, w, [photo(w, 1), photo(w, 2)]), await draft(t, w, [photo(w, 3), photo(w, 4)]), await draft(t, w, [photo(w, 5), photo(w, 6)])];
      const jobs: string[] = [];
      for (const montageId of ids) jobs.push(renderedOf(await t.call("videos.render", { montageId })).jobId);
      await t.call("engine.snapshot", {});
      for (const jobId of jobs) {
        await t.call("videos.cancel", { jobId });
        await t.advance("end");
        await t.call("engine.snapshot", {});
      }
    },
  },
  {
    name: "music: a trending track the store does not hold is track-unavailable for get and for render, and an own track is still not yet supported",
    async run(t, w) {
      const trending = { source: "trending", trackId: "4199287736976977", startMs: 1_500 };
      const own = { source: "own", mediaId: "media-0000001", startMs: 0 };
      const withTrack = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      const withOwn = await draft(t, w, [photo(w, 3), photo(w, 4)]);
      const stored = objectAt(montageOf(await t.call("montages.get", { montageId: withTrack })), "spec");
      await t.call("montages.save", { montageId: withTrack, spec: { ...stored, music: trending }, name: null });
      await t.call("montages.get", { montageId: withTrack });
      await t.call("videos.render", { montageId: withTrack });
      await t.call("videos.render", { spec: { ...stored, music: trending } });
      await t.call("montages.save", { montageId: withOwn, spec: { ...objectAt(montageOf(await t.call("montages.get", { montageId: withOwn })), "spec"), music: own }, name: null });
      await t.call("montages.get", { montageId: withOwn });
      await t.call("videos.render", { montageId: withOwn });
      await t.call("engine.snapshot", {});
    },
  },
  {
    name: "music: with an unavailable photo too, get lists the photo before the track, and render refuses the track first",
    async run(t, w) {
      const trending = { source: "trending", trackId: "4199287736976977", startMs: 0 };
      const taken = await draft(t, w, [photo(w, 2)]);
      const clash = await draft(t, w, [photo(w, 2)]);
      await t.call("videos.render", { montageId: taken });
      const stored = objectAt(montageOf(await t.call("montages.get", { montageId: clash })), "spec");
      await t.call("montages.save", { montageId: clash, spec: { ...stored, music: trending }, name: null });
      await t.call("montages.get", { montageId: clash });
      await t.call("videos.render", { montageId: clash });
      await t.settle();
    },
  },
  {
    name: "music: a damaged quota log refuses a refresh at no cost, its recovery closes the quota for 31 days, and an unreadable log cannot be recovered",
    async run(t, _w, control) {
      await t.call("music.status", {});
      await t.call("music.refresh", { confirm: true });
      await control.musicKey();
      await control.musicQuotaLog("corrupt");
      await t.call("music.status", {});
      await t.call("music.refresh", { confirm: true });
      await t.call("music.recoverQuotaLog", { confirm: true });
      await t.call("music.refresh", { confirm: true });
      await t.call("music.recoverQuotaLog", { confirm: true });
      await control.musicQuotaLog("unreadable");
      await t.call("music.status", {});
      await t.call("music.refresh", { confirm: true });
      await t.call("music.recoverQuotaLog", { confirm: true });
    },
  },
  {
    // Only a log that counted a request leaves the marker (a send, a result, a recovered log; round-2 verify): here a recovery
    // makes it one, since no story of the suite sends a request.
    name: "music: a quota log that counted requests, deleted with the music folder, reads missing, a re-entered key does not start a fresh count, and its recovery closes the quota for 31 days",
    async run(t, _w, control) {
      await control.musicKey();
      await control.musicQuotaLog("corrupt");
      await t.call("music.recoverQuotaLog", { confirm: true });
      await control.musicQuotaLog("deleted");
      await t.call("music.status", {});
      await t.call("music.refresh", { confirm: true });
      await control.musicKey();
      await t.call("music.status", {});
      await t.call("music.refresh", { confirm: true });
      await t.call("music.recoverQuotaLog", { confirm: true });
      await t.call("music.refresh", { confirm: true });
    },
  },
  // ---------- 3d.1b: text previews, the music list and its peaks, stickers ----------
  {
    name: "text preview: a drawn caption answers an id and a box inside the frame, each answer is a new id, and the id is served",
    async run(t, w, control) {
      const first = previewIdOf(await t.call("montages.textPreview", { avatarId: w.avatarId, layer: textLayer() }));
      const second = previewIdOf(await t.call("montages.textPreview", { avatarId: w.avatarId, layer: textLayer({ value: "two\r\nlines", style: "outline", color: "#9ad9ff", font: "caveat", scale: 1.5 }) }));
      await served(t, control, first);
      await served(t, control, second);
      t.note("the avatar is accepted and never read: an archived one, and one nobody knows");
      await t.call("montages.textPreview", { avatarId: w.archivedAvatarId, layer: textLayer() });
      await t.call("montages.textPreview", { avatarId: "avatar-nobody-0009", layer: textLayer() });
      t.note("an emoji the font draws is a picture, not an issue");
      await t.call("montages.textPreview", { avatarId: w.avatarId, layer: textLayer({ value: "hi \u{2728}" }) });
    },
  },
  {
    name: "text preview: the caption rules name the first rule broken, a caption with nothing to draw is RENDER_FAILED, and a payload that breaks the contract is VALIDATION",
    async run(t, w, control) {
      const ask = (over: Record<string, unknown>) => t.call("montages.textPreview", { avatarId: w.avatarId, layer: textLayer(over) });
      await ask({ value: "привет" });
      await ask({ value: "a\nb\nc" });
      await ask({ value: "a\r\nb\r\nc" });
      await ask({ value: "\u{1F1FA}" });
      await ask({ value: "\u{2764}\u{FE0E}" });
      await ask({ value: "привет\na\nb" });
      await ask({ value: "\u{00A9} 2026" });
      t.note("no picture to draw: a caption of spaces, and one of line breaks");
      await ask({ value: "   " });
      await ask({ value: "\n\n" });
      t.note("the contract refuses it before anything is drawn");
      await ask({ color: "white" });
      await ask({ scale: 2.5 });
      await ask({ font: "comic" });
      t.note("a refused caption leaves no picture, and the next one is drawn as if nothing happened");
      await served(t, control, previewIdOf(await ask({})));
    },
  },
  {
    name: "text preview: a queued preview of the same layer is superseded at once, a drawing that runs is never cancelled, other layers are untouched",
    async run(t, w, control) {
      const ask = (layerId: string, value: string) => t.start("montages.textPreview", { avatarId: w.avatarId, layer: textLayer({ layerId, value }) });
      control.holdText(true);
      ask("layer-00000001", "first");
      await t.quiesce();
      t.note("one drawing runs; the second of the layer waits, and the third replaces it");
      ask("layer-00000001", "second");
      await t.quiesce();
      ask("layer-00000001", "third");
      await t.quiesce();
      await t.untilAnswered(1);
      t.note("another layer waits behind them, and is replaced by its own newer one");
      ask("layer-00000002", "other");
      await t.quiesce();
      ask("layer-00000002", "other again");
      await t.quiesce();
      await t.untilAnswered(2);
      t.note("the lane lets go one drawing at a time, in the order asked");
      control.releaseText();
      await t.untilAnswered(3);
      control.releaseText();
      await t.untilAnswered(4);
      control.releaseText();
      await t.untilAnswered(5);
      control.holdText(false);
    },
  },
  {
    name: "text preview: a refused caption holds the lane like a drawing, so the one waiting behind it is still replaced by a newer one",
    async run(t, w, control) {
      const ask = (value: string) => t.start("montages.textPreview", { avatarId: w.avatarId, layer: textLayer({ value }) });
      control.holdText(true);
      ask("привет");
      await t.quiesce();
      ask("waiting");
      await t.quiesce();
      ask("newest");
      await t.quiesce();
      await t.untilAnswered(1);
      control.releaseText();
      await t.untilAnswered(2);
      control.releaseText();
      await t.untilAnswered(3);
      control.holdText(false);
    },
  },
  {
    name: "text preview: past 64 pictures the oldest that is not a layer's newest goes first, so each layer's newest stays served",
    async run(t, w, control) {
      const ids: string[] = [];
      await t.quiet(async () => {
        for (let i = 0; i < 64; i++) ids.push(previewIdOf(await t.call("montages.textPreview", { avatarId: w.avatarId, layer: textLayer({ value: `a${i}` }) })));
      });
      const other = previewIdOf(await t.call("montages.textPreview", { avatarId: w.avatarId, layer: textLayer({ layerId: "layer-00000002", value: "other" }) }));
      t.note("one over the bound: the first picture of the first layer is gone, and the second is not");
      await served(t, control, ids[0] ?? "");
      await served(t, control, ids[1] ?? "");
      await served(t, control, ids[63] ?? "");
      await served(t, control, other);
      t.note("the first layer is dragged on: its own older pictures go, the other layer's newest stays");
      for (let i = 0; i < 3; i++) await t.quiet(async () => void (await t.call("montages.textPreview", { avatarId: w.avatarId, layer: textLayer({ value: `b${i}` }) })));
      await served(t, control, ids[1] ?? "");
      await served(t, control, ids[2] ?? "");
      await served(t, control, ids[3] ?? "");
      await served(t, control, ids[4] ?? "");
      await served(t, control, other);
    },
  },
  {
    name: "music list and peaks: with nothing stored the list is empty and no track is found, own or trending, and a payload that breaks the contract is VALIDATION",
    async run(t) {
      await t.call("music.list", {});
      await t.call("music.peaks", { track: { source: "trending", trackId: "4199287736976977" }, startMs: 0, durationMs: 4_000, bars: 16 });
      await t.call("music.peaks", { track: { source: "own", mediaId: "media-0000001" }, startMs: 0, durationMs: 4_000, bars: 16 });
      await t.call("music.peaks", { track: { source: "trending", trackId: "4199287736976977" }, startMs: 0, durationMs: 4_000, bars: 15 });
      await t.call("music.peaks", { track: { source: "trending", trackId: "4199287736976977" }, startMs: 0, durationMs: 4_000, bars: 257 });
      await t.call("music.peaks", { track: { source: "trending", trackId: "4199287736976977" }, startMs: 0, durationMs: 0, bars: 16 });
      await t.call("music.status", {});
    },
  },
  {
    name: "music list and peaks: the stored tracks in list order, highlights ascending with the 1500 default last, and the waveform windows of each",
    async run(t, _w, control) {
      await control.musicTracks();
      await t.call("music.list", {});
      await t.call("music.status", {});
      const tracks = parityListTracks();
      for (const [i, track] of tracks.entries()) {
        const ref = { source: "trending", trackId: track.trackId };
        t.note(`track ${i + 1}: the whole length in 72 bars, a window from the middle, one past the end, and the limits of the bars`);
        await t.call("music.peaks", { track: ref, startMs: 0, durationMs: track.durationMs, bars: 72 });
        await t.call("music.peaks", { track: ref, startMs: 1_000, durationMs: 800, bars: 16 });
        await t.call("music.peaks", { track: ref, startMs: track.durationMs + 5_000, durationMs: 800, bars: 16 });
        await t.call("music.peaks", { track: ref, startMs: 0, durationMs: 1, bars: 256 });
      }
      t.note("a track the store does not hold, and an own one");
      await t.call("music.peaks", { track: { source: "trending", trackId: "4199287736976977" }, startMs: 0, durationMs: 4_000, bars: 16 });
      await t.call("music.peaks", { track: { source: "own", mediaId: "media-0000001" }, startMs: 0, durationMs: 4_000, bars: 16 });
    },
  },
  {
    name: "music list and peaks: free and independent of the key and the quota log",
    async run(t, _w, control) {
      await control.musicTracks();
      const track = parityListTracks()[0];
      if (track === undefined) throw new Error("the parity list has no track");
      const peaks = { track: { source: "trending", trackId: track.trackId }, startMs: 0, durationMs: 2_000, bars: 16 };
      t.note("no key");
      await t.call("music.list", {});
      await t.call("music.peaks", peaks);
      t.note("a stored key, and a log that cannot be trusted");
      await control.musicKey();
      await control.musicQuotaLog("corrupt");
      await t.call("music.status", {});
      await t.call("music.list", {});
      await t.call("music.peaks", peaks);
      t.note("a log that cannot be read");
      await control.musicQuotaLog("unreadable");
      await t.call("music.status", {});
      await t.call("music.list", {});
      await t.call("music.peaks", peaks);
    },
  },
  {
    name: "music: a stored trending track is judged against its length by get, and a track the store does not hold is track-unavailable",
    async run(t, w, control) {
      await control.musicTracks();
      const track = parityListTracks()[0];
      if (track === undefined) throw new Error("the parity list has no track");
      const montageId = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      const stored = objectAt(montageOf(await t.call("montages.get", { montageId })), "spec");
      const music = (trackId: string, startMs: number) => ({ source: "trending", trackId, startMs });
      t.note("held, and long enough");
      await t.call("montages.save", { montageId, spec: { ...stored, music: music(track.trackId, 0) }, name: null });
      await t.call("montages.get", { montageId });
      t.note("held, and one start too late for its length");
      await t.call("montages.save", { montageId, spec: { ...stored, music: music(track.trackId, track.durationMs - 1) }, name: null });
      await t.call("montages.get", { montageId });
      t.note("not held");
      await t.call("montages.save", { montageId, spec: { ...stored, music: music("4199287736976977", 0) }, name: null });
      await t.call("montages.get", { montageId });
    },
  },
  {
    name: "stickers: a built-in sticker of the set is no issue, one it lacks is sticker-unavailable at its layer, an own sticker is not yet supported, and the issues come photos, stickers, track",
    async run(t, w) {
      const known = STICKER_MANIFEST[0]?.id;
      if (known === undefined) throw new Error("the sticker manifest is empty");
      const sticker = (layerId: string, stickerId: string) => ({ layerId, kind: "sticker", startMs: 0, endMs: 1_000, sticker: { source: "builtin", stickerId }, x: 0.5, y: 0.5, size: 0.2 });
      const montageId = await draft(t, w, [photo(w, 1)]);
      const stored = objectAt(montageOf(await t.call("montages.get", { montageId })), "spec");
      t.note("a sticker of the set");
      await t.call("montages.save", { montageId, spec: { ...stored, layers: [sticker("layer-00000001", known)] }, name: null });
      await t.call("montages.get", { montageId });
      t.note("a sticker the set does not have, between two that it has");
      await t.call("montages.save", { montageId, spec: { ...stored, layers: [sticker("layer-00000001", known), sticker("layer-00000002", "no-such-sticker"), sticker("layer-00000003", known)] }, name: null });
      await t.call("montages.get", { montageId });
      await t.call("videos.render", { montageId });
      t.note("an own sticker is not judged against the set");
      await t.call("montages.save", { montageId, spec: { ...stored, layers: [ownStickerLayer, sticker("layer-00000002", "no-such-sticker")] }, name: null });
      await t.call("montages.get", { montageId });
      t.note("a photo that is taken, a sticker the set lacks and a track the store lacks: the order of the issues");
      const taken = await draft(t, w, [photo(w, 2)]);
      const clash = await draft(t, w, [photo(w, 2)]);
      await t.call("videos.render", { montageId: taken });
      const clashSpec = objectAt(montageOf(await t.call("montages.get", { montageId: clash })), "spec");
      await t.call("montages.save", { montageId: clash, spec: { ...clashSpec, layers: [sticker("layer-00000001", "no-such-sticker")], music: { source: "trending", trackId: "4199287736976977", startMs: 0 } }, name: null });
      await t.call("montages.get", { montageId: clash });
      await t.settle();
    },
  },
];

// ---------- 3d.1b: what the scenarios above share ----------

/** A text layer as the editor makes one, with what a scenario says changed. */
function textLayer(over: Record<string, unknown> = {}): Record<string, unknown> {
  return { kind: "text", layerId: "layer-00000001", startMs: 0, endMs: 3_000, value: "sunday reset", font: "manrope", style: "plaque", color: "#ffffff", x: 0.5, y: 0.195, scale: 1, ...over };
}

/** The `previewId` a `montages.textPreview` answered. */
const previewIdOf = (answer: Answer): string => stringAt(resultOf(answer), "previewId");

/** Writes whether a preview id is still served, under the alias the transcript knows it by. */
async function served(t: Transcript, control: Control, previewId: string): Promise<void> {
  t.note(`${String(t.norm.value(previewId, "previewId"))} is served: ${await control.previewServed(previewId)}`);
}

/** `estimateBytesUpper` of the clips of the draft a `montages.create` answered: what a render of it asks the export folder to have twice over. */
function upperBytesOf(answer: Answer): number {
  const clips = objectAt(montageOf(answer), "spec").clips;
  if (!Array.isArray(clips)) throw new Error("expected clips");
  return estimateBytesUpper(clips.map((clip: unknown) => ({ durationMs: Number(objectAt({ clip }, "clip").durationMs) })));
}
