import { encodePhotoCursor } from "../../../shared/engine";
import { defaultSpec, estimateBytesUpper } from "../../../shared/montage";
import { STICKER_MANIFEST } from "../../../shared/stickers";
import { AUTOPILOT_SCENARIOS } from "./scenarios.autopilot";
import { IMAGE_MODEL_SCENARIOS } from "./scenarios.imageModels";
import type { Control, RigOptions, World } from "./rigs";
import { PARITY_DECODED_APART, parityListTracks } from "./tracks";
import type { Answer, Transcript } from "./transcript";

// The scenarios of the parity suite (Stage 3, 3d.1b). Each is one story told through the engine's own commands; the suite
// plays it against the mock and against the real engine, and the two transcripts must be equal (parity.test.ts). A scenario
// never reads an engine's internals and never sleeps: it sends commands and moves time with `advance` and `settle`.

export interface Scenario {
  readonly name: string;
  /** What the rig is started with, when the scenario needs more than the default. */
  readonly rig?: RigOptions;
  /**
   * Stage 4 (S4.1): the real engine does not serve these commands yet (`until` names the task that will), so the story cannot match line for line. The mock's transcript is
   * still bound to the golden; for the real engine the harness checks that each command named here is answered with the engine's one refusal, INTERNAL
   * «<command> is not implemented yet», and nothing else. A story whose commands are all served is not pending.
   */
  readonly pending?: {
    readonly until: string;
    readonly commands: readonly string[];
    /**
     * S4.6a: the commands of `commands` the real engine serves already, while the mock is not complete (S4.8) and the story still cannot match line for line. The harness
     * holds the real engine to the opposite there: each must be answered with anything but «not implemented yet» (testing/pending.ts `servedProblems`).
     */
    readonly served?: readonly string[];
  };
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

// An own sticker is judged against the library since 3f.5 (media-unavailable when it holds none: this id is held by nobody); a text layer and a
// built-in sticker render since 3b.6. Two older scenarios below keep this layer and their names ("not yet supported"): their transcripts changed by
// exactly the lines that recorded `not-yet-supported` for it, the behaviour 3f.5 lifted.
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

const BASE_SCENARIOS: readonly Scenario[] = [
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
    name: "a file name's number is never refilled: the video rendered after the first one is deleted gets _003, not _001",
    async run(t, w) {
      const first = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      await t.call("videos.render", { montageId: first });
      await t.settle();
      const one = newestVideoId(await t.call("videos.list", { avatarId: w.avatarId }));
      const second = await draft(t, w, [photo(w, 3), photo(w, 4)]);
      await t.call("videos.render", { montageId: second });
      await t.settle();
      await t.call("videos.delete", { videoId: one, mode: "video" });
      const third = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      await t.call("videos.render", { montageId: third });
      await t.settle();
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
    // 3f.4 lifted N9 for an own track, so the two answers this story gets for it changed from `not-yet-supported` to `media-unavailable` (the library holds
    // no such media): the ONLY golden lines of an older story that were edited. The name stays, because it is the golden's key; the new stories are `own music: ...`.
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
    // The older scenario writes the other layer LAST, where nothing needs protecting. Here its picture is the OLDEST of all when the
    // bound is crossed, and only being its layer's newest keeps it.
    name: "text preview: a layer's newest picture is kept even when it is the oldest of all, and the older ones of the dragged layer go instead",
    async run(t, w, control) {
      const other = previewIdOf(await t.call("montages.textPreview", { avatarId: w.avatarId, layer: textLayer({ layerId: "layer-00000002", value: "other" }) }));
      const ids: string[] = [];
      await t.quiet(async () => {
        for (let i = 0; i < 64; i++) ids.push(previewIdOf(await t.call("montages.textPreview", { avatarId: w.avatarId, layer: textLayer({ value: `a${i}` }) })));
      });
      t.note("65 pictures: the oldest is the other layer's, which is its newest, so the dragged layer's first one goes");
      await served(t, control, other);
      await served(t, control, ids[0] ?? "");
      await served(t, control, ids[1] ?? "");
      t.note("the dragged layer goes on: its own older ones go, the other layer's picture stays");
      for (let i = 0; i < 3; i++) await t.quiet(async () => void (await t.call("montages.textPreview", { avatarId: w.avatarId, layer: textLayer({ value: `b${i}` }) })));
      await served(t, control, other);
      await served(t, control, ids[1] ?? "");
      await served(t, control, ids[3] ?? "");
      await served(t, control, ids[4] ?? "");
    },
  },
  {
    name: "text preview: past four times the bound a caller inventing layers loses the oldest picture, even a layer's newest",
    async run(t, w, control) {
      const ids: string[] = [];
      await t.quiet(async () => {
        for (let i = 0; i <= 256; i++) {
          ids.push(previewIdOf(await t.call("montages.textPreview", { avatarId: w.avatarId, layer: textLayer({ layerId: `layer-${String(i).padStart(8, "0")}`, value: "x" }) })));
        }
      });
      t.note("257 layers, one picture each: all of them are a layer's newest, and the bound is 256");
      await served(t, control, ids[0] ?? "");
      await served(t, control, ids[1] ?? "");
      await served(t, control, ids[256] ?? "");
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
  // ---------- 3d.3b verify: the proven length of a track ----------
  {
    name: "music: a track whose decode proved a shorter length than the list claimed is listed, read and judged by the proven length",
    async run(t, w, control) {
      await control.musicTracks("decoded-apart");
      const track = parityListTracks()[PARITY_DECODED_APART.index];
      if (track === undefined) throw new Error("the parity list has no such track");
      const provenMs = track.durationMs - PARITY_DECODED_APART.shortByMs;
      const ref = { source: "trending", trackId: track.trackId };
      await t.call("music.list", {});
      t.note("the waveform across the proven end: silence after it");
      await t.call("music.peaks", { track: ref, startMs: provenMs - 800, durationMs: 1_600, bars: 16 });
      const montageId = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      const stored = objectAt(montageOf(await t.call("montages.get", { montageId })), "spec");
      // One 4.0 s clip: a montage the proven 6.13 s holds from a start of 2.13 s.
      const clips = clipsOf(stored, 4_000);
      const music = (startMs: number) => ({ source: "trending", trackId: track.trackId, startMs });
      t.note("the last start the proven length holds");
      await t.call("montages.save", { montageId, spec: { ...stored, clips, music: music(provenMs - 4_000) }, name: null });
      await t.call("montages.get", { montageId });
      t.note("one ms later: too short, though the list's claim would hold it");
      await t.call("montages.save", { montageId, spec: { ...stored, clips, music: music(provenMs - 4_000 + 1) }, name: null });
      await t.call("montages.get", { montageId });
    },
  },
  // ---------- 3e.2: the Photos screen ----------
  {
    name: "videos.get: one video by id as the list shows it, with the title its draft had when it was rendered and its first clip; a rename later does not reach it; an unknown id is NOT_FOUND",
    async run(t, w) {
      const created = await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 1), photo(w, 3)] });
      const montageId = montageIdOf(created);
      await t.call("montages.save", { montageId, spec: specOf(created), name: "утро дома" });
      const { videoId } = renderedOf(await t.call("videos.render", { montageId }));
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("videos.get", { videoId });
      t.note("the draft renamed after the render: the video keeps the name it was rendered under");
      await t.call("montages.save", { montageId, spec: specOf(created), name: "вечер" });
      await t.call("videos.get", { videoId });
      t.note("the draft deleted: the video names no draft, and keeps its title");
      await t.call("montages.delete", { montageId });
      await t.call("videos.get", { videoId });
      await t.call("videos.get", { videoId: "video-0000ffff" });
    },
  },
  {
    name: "usage recoveries on a sound avatar change nothing: no record is moved, the marks are read as they stand, nothing is announced; an unknown avatar is NOT_FOUND",
    async run(t, w) {
      await t.call("photos.setRejected", { avatarId: w.avatarId, photoId: photo(w, 2), rejected: true });
      await t.call("videos.quarantineRecords", { avatarId: w.avatarId });
      await t.call("photos.rebuildRejected", { avatarId: w.avatarId });
      t.note("a repeat is the same");
      await t.call("videos.quarantineRecords", { avatarId: w.avatarId });
      await t.call("photos.rebuildRejected", { avatarId: w.avatarId });
      await t.call("videos.quarantineRecords", { avatarId: "avatar-nobody-0001" });
      await t.call("photos.rebuildRejected", { avatarId: "avatar-nobody-0001" });
    },
  },
  // ---------- 3e.2 review ----------
  {
    name: "avatars.list: every avatar of the grid with its counts and a sound usage (a usage that is not ok would be written); a reject mark moves the unused count",
    async run(t, w) {
      await t.call("avatars.list", {});
      await t.call("photos.setRejected", { avatarId: w.avatarId, photoId: photo(w, 2), rejected: true });
      await t.call("avatars.list", {});
    },
  },
  {
    name: "videos.get of a video rendered with a stored trending track: its music names the track (K13), as the list does",
    async run(t, w, control) {
      await control.musicTracks();
      const track = parityListTracks()[0];
      if (track === undefined) throw new Error("the parity list has no track");
      const montageId = await draft(t, w, [photo(w, 1), photo(w, 3)]);
      const stored = objectAt(montageOf(await t.call("montages.get", { montageId })), "spec");
      await t.call("montages.save", { montageId, spec: { ...stored, music: { source: "trending", trackId: track.trackId, startMs: 0 } }, name: "с музыкой" });
      const { videoId } = renderedOf(await t.call("videos.render", { montageId }));
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("videos.get", { videoId });
    },
  },
];

// ---------- 3f.1: the own-media import boundary ----------

/** Appended after the 3d.1b scenarios: the golden transcripts above are append-only. */
const OWN_MEDIA_SCENARIOS: readonly Scenario[] = [
  {
    name: "own media: a cancelled dialog changes nothing, and a pick lists each file by name with the reason the boundary gave it",
    async run(t, _w, control) {
      t.note("the dialog is cancelled");
      await control.mediaDialog("cancel");
      await t.call("media.pickImport", { kind: "photo" });
      t.note("seven files at once: a photo no importer takes yet, a script, a folder, an empty file, one over the cap, a HEIC, one that is gone");
      await control.mediaDialog("mixed");
      await t.call("media.pickImport", { kind: "photo" });
      t.note("a pick is used once: the next dialog is a cancel");
      await t.call("media.pickImport", { kind: "photo" });
      t.note("the window cannot name a file");
      await t.call("media.pickImport", { kind: "photo", path: "/etc/passwd" });
    },
  },
];

// ---------- 3f.1b: own media as records, and the import job ----------

/** The job ids a `media.pickImport` answered. */
function pickedJobIds(answer: Answer): string[] {
  const ids = resultOf(answer).jobIds;
  if (!Array.isArray(ids)) throw new Error("expected job ids");
  return ids.map((id: unknown) => {
    if (typeof id !== "string") throw new Error("expected a job id");
    return id;
  });
}

/** The media ids `media.list` answered, newest first. */
function listedMediaIds(answer: Answer): string[] {
  const media = resultOf(answer).media;
  if (!Array.isArray(media)) throw new Error("expected media");
  return media.map((item: unknown) => {
    if (typeof item !== "object" || item === null) throw new Error("expected a media record");
    return stringAt(Object.fromEntries(Object.entries(item)), "mediaId");
  });
}

/** Appended after the 3f.1 scenario: the golden transcripts above are append-only. */
const OWN_MEDIA_RECORD_SCENARIOS: readonly Scenario[] = [
  {
    name: "own media: an import is a job that ends in a record, a cancelled one stores nothing, and a record is listed and deleted",
    rig: { ownMedia: true },
    async run(t, _w, control) {
      t.note("nothing is stored yet");
      await t.call("media.list", {});
      t.note("a photo is picked: its job starts, and is held before its first byte, so the answer comes with the job running");
      control.holdImports(true);
      await control.mediaDialog("good");
      await t.call("media.pickImport", { kind: "photo" });
      t.note("the job goes on: the copy, the record, media.changed, then job.done");
      control.holdImports(false);
      await t.settle();
      const listed = await t.call("media.list", {});
      await t.call("media.list", { kind: "video" });
      t.note("an own photo is no avatar's photo (invariant 24): the avatars' photo and unused counts are what they were");
      await t.call("avatars.list", {});
      t.note("a second photo is picked and the owner cancels its job before its copy starts: no record, only job.cancelled");
      control.holdImports(true);
      await control.mediaDialog("good");
      const [second] = pickedJobIds(await t.call("media.pickImport", { kind: "photo" }));
      if (second === undefined) throw new Error("the second pick started no job");
      await t.call("media.cancelImport", { jobId: second });
      control.holdImports(false);
      await t.settle();
      await t.call("media.list", {});
      t.note("a job that is over is answered as it ended; one that never was is not found");
      await t.call("media.cancelImport", { jobId: second });
      await t.call("media.cancelImport", { jobId: "job-00000404" });
      t.note("delete: the record goes and media.changed says so; the same id again is not found");
      const [mediaId] = listedMediaIds(listed);
      if (mediaId === undefined) throw new Error("nothing was listed");
      await t.call("media.delete", { mediaId });
      await t.call("media.delete", { mediaId });
      await t.call("media.list", {});
      await t.call("avatars.list", {});
    },
  },
  {
    name: "own media: a second import waits queued behind the first, is cancelled in its queue, and the first still ends in its record",
    rig: { ownMedia: true },
    async run(t, _w, control) {
      t.note("the first photo's job runs (held before its first byte); the second finds the turn taken and waits queued");
      control.holdImports(true);
      await control.mediaDialog("good");
      await t.call("media.pickImport", { kind: "photo" });
      await control.mediaDialog("good");
      const [queued] = pickedJobIds(await t.call("media.pickImport", { kind: "photo" }));
      if (queued === undefined) throw new Error("the second pick started no job");
      t.note("a window that resyncs sees the first running and the second queued");
      await t.call("engine.snapshot", {});
      t.note("the owner cancels the queued one: it ends in its queue, and its cancel is answered before its end is told");
      await t.call("media.cancelImport", { jobId: queued });
      await t.advance("end");
      t.note("the first goes on and ends in its record; the cancelled one stored nothing");
      control.holdImports(false);
      await t.settle();
      await t.call("media.list", {});
      await t.call("engine.snapshot", {});
    },
  },
  {
    name: "own media: without an importer a good photo is refused and nothing is stored",
    async run(t, _w, control) {
      await control.mediaDialog("good");
      await t.call("media.pickImport", { kind: "photo" });
      await t.call("media.list", {});
    },
  },
];

// ---------- 3f.2: own photos in a draft and a render ----------

/** A spec of two 2 s photo clips, each an own photo of `mediaId`: the shortest a spec may be (4 s). */
function ownPhotoSpec(avatarId: string, mediaId: string): Record<string, unknown> {
  return {
    schemaVersion: 1,
    avatarId,
    layers: [],
    music: null,
    seed: 7,
    clips: [1, 2].map((n) => ({ clipId: `clip-000000${n}`, kind: "photo", cell: { photo: { source: "own", mediaId }, focus: null }, motion: "static", durationMs: 2_000, transitionIn: "cut" })),
  };
}

/** Imports the one good photo and answers its media id. */
async function importedPhotoId(t: Transcript, control: Control): Promise<string> {
  await control.mediaDialog("good");
  await t.call("media.pickImport", { kind: "photo" });
  await t.settle();
  const [mediaId] = listedMediaIds(await t.call("media.list", {}));
  if (mediaId === undefined) throw new Error("the photo was not stored");
  return mediaId;
}

/** Appended after the 3f.1b scenarios: the golden transcripts above are append-only. */
const OWN_PHOTO_SCENARIOS: readonly Scenario[] = [
  {
    name: "own photos: a render holds its media against media.delete until it ends, and a deleted media is media-unavailable in the draft, the render and the focus",
    rig: { ownMedia: true },
    async run(t, w, control) {
      const mediaId = await importedPhotoId(t, control);
      t.note("a draft with the own photo in both cells: the engine finds nothing wrong, and the detector sees no face in it");
      const montageId = montageIdOf(await t.call("montages.create", { avatarId: w.avatarId, photoIds: [] }));
      await t.call("montages.save", { montageId, spec: ownPhotoSpec(w.avatarId, mediaId), name: "Свои фото" });
      await t.call("montages.get", { montageId });
      await t.call("montages.list", { avatarId: w.avatarId });
      await t.call("montages.focus", { avatarId: w.avatarId, photo: { source: "own", mediaId } });
      t.note("the render is queued: the media is held, so deleting it is refused and it stays listed");
      await t.call("videos.render", { montageId });
      await t.call("media.delete", { mediaId });
      await t.call("media.list", {});
      t.note("the render ends: the same delete goes through");
      await t.settle();
      await t.call("media.delete", { mediaId });
      await t.call("media.list", {});
      t.note("the draft still names the media: it reads unavailable at each cell, a render of it is refused for that, and so is its focus");
      await t.call("montages.get", { montageId });
      await t.call("montages.list", { avatarId: w.avatarId });
      await t.call("videos.render", { montageId });
      await t.call("montages.focus", { avatarId: w.avatarId, photo: { source: "own", mediaId } });
    },
  },
  {
    name: "own photos: a render that fails lets its media go, and a spec that names a media nobody holds is refused before the export folder is asked",
    rig: { ownMedia: true },
    async run(t, w, control) {
      const mediaId = await importedPhotoId(t, control);
      t.note("the first render's ffmpeg fails: while it runs the media is held, and when it has failed the delete goes through");
      control.failNextRender("encode");
      await t.call("videos.render", { spec: ownPhotoSpec(w.avatarId, mediaId) });
      await t.call("media.delete", { mediaId });
      await t.settle();
      await t.call("media.delete", { mediaId });
      t.note("a media that is not there, in a spec that is otherwise good");
      await t.call("videos.render", { spec: ownPhotoSpec(w.avatarId, "media-00000404") });
      t.note("a spec with a structural issue is refused for that alone, whatever its media");
      await t.call("videos.render", { spec: { ...ownPhotoSpec(w.avatarId, "media-00000404"), clips: [{ ...(clipsOf(ownPhotoSpec(w.avatarId, "media-00000404"), 1_000)[0] ?? {}) }] } });
      t.note("an own video clip is judged like any own media: one nobody holds is media-unavailable");
      await t.call("videos.render", {
        spec: { schemaVersion: 1, avatarId: w.avatarId, layers: [], music: null, seed: 7, clips: [{ clipId: "clip-0000001", kind: "video", mediaId: "media-00000404", trimStartMs: 0, focus: null, durationMs: 4_000, transitionIn: "cut" }] },
      });
    },
  },
  {
    name: "own photos: the photo importer refuses a picture inside its job, and the job fails with its reason",
    rig: { ownMedia: true },
    async run(t, _w, control) {
      t.note("the boundary takes the file (its bytes are a photo's); the importer turns it away: one progress step at the total, then job.failed");
      await control.mediaDialog("tiny");
      await t.call("media.pickImport", { kind: "photo" });
      await t.settle();
      t.note("nothing is stored, and the failed job is in a window's snapshot");
      await t.call("media.list", {});
      await t.call("engine.snapshot", {});
      t.note("the next photo takes its turn as if nothing happened");
      await control.mediaDialog("good");
      await t.call("media.pickImport", { kind: "photo" });
      await t.settle();
      await t.call("media.list", {});
    },
  },
];

// ---------- 3f.3a: own video, and an importer that refuses after the copy ----------

/** Appended after the 3f.1b scenarios: the golden transcripts above are append-only. */
const OWN_VIDEO_SCENARIOS: readonly Scenario[] = [
  {
    name: "own media: a video is a job that ends in a record with the facts of its mezzanine, and one the importer refuses after its copy ends failed with its reason and stores nothing",
    rig: { ownMedia: true },
    async run(t, _w, control) {
      t.note("a clip is picked: its job starts, held before its first byte so the answer comes with the job running");
      control.holdImports(true);
      await control.mediaDialog("video");
      await t.call("media.pickImport", { kind: "video" });
      t.note("the job goes on: the copy, the importer, the record, media.changed, then job.done; the record has the facts of the mezzanine");
      control.holdImports(false);
      await t.settle();
      await t.call("media.list", { kind: "video" });
      t.note("a clip the importer cannot read is picked: its copy is made to the total, then the importer refuses it and the job ends failed with the reason");
      control.holdImports(true);
      await control.mediaDialog("badVideo");
      await t.call("media.pickImport", { kind: "video" });
      control.holdImports(false);
      await t.settle();
      t.note("nothing was stored for it: the list is what it was, and a window that resyncs sees the failed import beside the finished one");
      await t.call("media.list", {});
      await t.call("engine.snapshot", {});
    },
  },
];

// ---------- 3f.5: own stickers in a draft and a render ----------

/** An own sticker as a layer of the editor's spec. */
const ownStickerOf = (mediaId: string): Record<string, unknown> => ({ layerId: "layer-00000001", kind: "sticker", startMs: 0, endMs: 1_000, sticker: { source: "own", mediaId }, x: 0.5, y: 0.5, size: 0.2 });

/** Imports the one good sticker and answers its media id. */
async function importedStickerId(t: Transcript, control: Control): Promise<string> {
  await control.mediaDialog("sticker");
  await t.call("media.pickImport", { kind: "sticker" });
  await t.settle();
  const [mediaId] = listedMediaIds(await t.call("media.list", { kind: "sticker" }));
  if (mediaId === undefined) throw new Error("the sticker was not stored");
  return mediaId;
}

/** Appended after the 3f.2 scenarios: the golden transcripts above are append-only. (`media.stickerBytes` is main's alone, so it has no engine answer to hold.) */
const OWN_STICKER_SCENARIOS: readonly Scenario[] = [
  {
    name: "own stickers: a render holds its sticker against media.delete until it ends, and a deleted sticker is media-unavailable in the draft and the render",
    rig: { ownMedia: true },
    async run(t, w, control) {
      const mediaId = await importedStickerId(t, control);
      t.note("a draft with the own sticker in a layer: the engine finds nothing wrong");
      const created = await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 1), photo(w, 2)] });
      const montageId = montageIdOf(created);
      const stored = objectAt({ spec: specOf(created) }, "spec");
      await t.call("montages.save", { montageId, spec: { ...stored, layers: [ownStickerOf(mediaId)] }, name: "Свой стикер" });
      await t.call("montages.get", { montageId });
      await t.call("montages.list", { avatarId: w.avatarId });
      t.note("the render is queued: the sticker is held, so deleting it is refused and it stays listed");
      await t.call("videos.render", { montageId });
      await t.call("media.delete", { mediaId });
      await t.call("media.list", { kind: "sticker" });
      t.note("the render ends: the same delete goes through");
      await t.settle();
      await t.call("media.delete", { mediaId });
      await t.call("media.list", {});
      t.note("the draft still names the sticker: it reads unavailable at its layer, and a render of it is refused for that");
      await t.call("montages.get", { montageId });
      await t.call("montages.list", { avatarId: w.avatarId });
      await t.call("videos.render", { montageId });
    },
  },
  {
    name: "own stickers: a render that fails lets its sticker go, a media held as another kind is no sticker, and a spec that names a sticker nobody holds is refused before the export folder is asked",
    rig: { ownMedia: true },
    async run(t, w, control) {
      const mediaId = await importedStickerId(t, control);
      const created = await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 1), photo(w, 2)] });
      const stored = objectAt({ spec: specOf(created) }, "spec");
      t.note("the first render's ffmpeg fails: while it runs the sticker is held, and when it has failed the delete goes through");
      control.failNextRender("encode");
      await t.call("videos.render", { spec: { ...stored, layers: [ownStickerOf(mediaId)] } });
      await t.call("media.delete", { mediaId });
      await t.settle();
      await t.call("media.delete", { mediaId });
      t.note("a sticker that is not there, in a spec that is otherwise good");
      await t.call("videos.render", { spec: { ...stored, layers: [ownStickerOf("media-00000404")] } });
      t.note("an own PHOTO is not a sticker");
      const photoId = await importedPhotoId(t, control);
      await t.call("videos.render", { spec: { ...stored, layers: [ownStickerOf(photoId)] } });
      t.note("a spec with a structural issue is refused for that alone, whatever its sticker");
      await t.call("videos.render", { spec: { ...stored, clips: clipsOf(stored, 1_000), layers: [ownStickerOf("media-00000404")] } });
    },
  },
  {
    name: "own stickers: the sticker importer refuses a file inside its job with its reason, and the next sticker takes its turn",
    rig: { ownMedia: true },
    async run(t, _w, control) {
      t.note("the boundary takes the file (its bytes are a PNG's, and a PNG may be a sticker); the importer turns it away: one progress step at the total, then job.failed");
      await control.mediaDialog("stillSticker");
      await t.call("media.pickImport", { kind: "sticker" });
      await t.settle();
      t.note("nothing is stored, and the failed job is in a window's snapshot");
      await t.call("media.list", { kind: "sticker" });
      await t.call("engine.snapshot", {});
      t.note("the next sticker is stored as if nothing happened, with the canvas, the loop and the delays on the 30 fps grid");
      await control.mediaDialog("sticker");
      await t.call("media.pickImport", { kind: "sticker" });
      await t.settle();
      await t.call("media.list", { kind: "sticker" });
    },
  },
  {
    name: "own stickers: media.list by id answers the records named, of the kind asked, and nothing for an id nobody holds",
    rig: { ownMedia: true },
    async run(t, _w, control) {
      const mediaId = await importedStickerId(t, control);
      t.note("the sticker by its id, with an id nobody holds beside it");
      await t.call("media.list", { kind: "sticker", mediaIds: [mediaId, "media-00000404"] });
      t.note("the same id asked as a photo, and no ids at all");
      await t.call("media.list", { kind: "photo", mediaIds: [mediaId] });
      await t.call("media.list", { mediaIds: [] });
    },
  },
];

// ---------- 3f.4: an own track as the music ----------

/** A montage of two scene photos (2 s each) with the own track `mediaId` as its music, from `startMs`. */
function ownTrackSpec(w: World, mediaId: string, startMs: number): Record<string, unknown> {
  return {
    schemaVersion: 1,
    avatarId: w.avatarId,
    layers: [],
    music: { source: "own", mediaId, startMs },
    seed: 7,
    clips: [1, 2].map((n) => ({ clipId: `clip-000000${n}`, kind: "photo", cell: { photo: { source: "scene", photoId: photo(w, n) }, focus: null }, motion: "static", durationMs: 2_000, transitionIn: "cut" })),
  };
}

/** Imports the one good track (12 s) and answers its media id. */
async function importedTrackId(t: Transcript, control: Control): Promise<string> {
  await control.mediaDialog("track");
  await t.call("media.pickImport", { kind: "audio" });
  await t.settle();
  const [mediaId] = listedMediaIds(await t.call("media.list", { kind: "audio" }));
  if (mediaId === undefined) throw new Error("the track was not stored");
  return mediaId;
}

/** Appended after the 3f.2 scenarios: the golden transcripts above are append-only. */
const OWN_MUSIC_SCENARIOS: readonly Scenario[] = [
  {
    name: "own music: a draft judges its track by the library and its length, music.peaks windows the waveform, a render holds the track until it ends, and a deleted track is media-unavailable everywhere",
    rig: { ownMedia: true },
    async run(t, w, control) {
      const mediaId = await importedTrackId(t, control);
      t.note("the track's waveform: the whole of it, a window from the middle, and a window past the end (silence there)");
      await t.call("music.peaks", { track: { source: "own", mediaId }, startMs: 0, durationMs: 12_000, bars: 24 });
      await t.call("music.peaks", { track: { source: "own", mediaId }, startMs: 3_000, durationMs: 1_500, bars: 16 });
      await t.call("music.peaks", { track: { source: "own", mediaId }, startMs: 20_000, durationMs: 1_000, bars: 16 });
      t.note("a draft with the track from the start: the engine finds nothing wrong");
      const montageId = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      await t.call("montages.save", { montageId, spec: ownTrackSpec(w, mediaId, 0), name: "With music" });
      await t.call("montages.get", { montageId });
      await t.call("montages.list", { avatarId: w.avatarId });
      t.note("one millisecond too late for its length (the montage is 4 s of a 12 s track), and exactly the last start that fits");
      await t.call("montages.save", { montageId, spec: ownTrackSpec(w, mediaId, 8_001), name: "With music" });
      await t.call("montages.get", { montageId });
      await t.call("montages.save", { montageId, spec: ownTrackSpec(w, mediaId, 8_000), name: "With music" });
      await t.call("montages.get", { montageId });
      t.note("the render is queued: the track is held, so deleting it is refused and it stays listed");
      await t.call("videos.render", { montageId });
      await t.call("media.delete", { mediaId });
      await t.call("media.list", {});
      t.note("the render ends: the same delete goes through, and the waveform goes with the track");
      await t.settle();
      await t.call("media.delete", { mediaId });
      await t.call("media.list", {});
      await t.call("music.peaks", { track: { source: "own", mediaId }, startMs: 0, durationMs: 4_000, bars: 16 });
      t.note("the draft still names the track: it reads unavailable, and a render of it is refused for that");
      await t.call("montages.get", { montageId });
      await t.call("montages.list", { avatarId: w.avatarId });
      await t.call("videos.render", { montageId });
    },
  },
  {
    name: "own music: a render that fails lets its track go, and a spec naming a track nobody holds, or one too short, is refused before the export folder is asked",
    rig: { ownMedia: true },
    async run(t, w, control) {
      const mediaId = await importedTrackId(t, control);
      t.note("the first render's ffmpeg fails: while it runs the track is held, and when it has failed the delete goes through");
      control.failNextRender("encode");
      await t.call("videos.render", { spec: ownTrackSpec(w, mediaId, 0) });
      await t.call("media.delete", { mediaId });
      await t.settle();
      await t.call("media.delete", { mediaId });
      t.note("a track that is not there, in a spec that is otherwise good");
      await t.call("videos.render", { spec: ownTrackSpec(w, "media-00000404", 0) });
      t.note("a track that is there but too short for its start");
      const second = await importedTrackId(t, control);
      await t.call("videos.render", { spec: ownTrackSpec(w, second, 9_000) });
      t.note("a spec with a structural issue is refused for that alone, whatever its track");
      await t.call("videos.render", { spec: { ...ownTrackSpec(w, "media-00000404", 0), clips: [] } });
      t.note("a photo is not a track: its id as the music is media-unavailable");
      await control.mediaDialog("good");
      await t.call("media.pickImport", { kind: "photo" });
      await t.settle();
      const [photoId] = listedMediaIds(await t.call("media.list", { kind: "photo" }));
      await t.call("videos.render", { spec: ownTrackSpec(w, photoId ?? "", 0) });
    },
  },
  {
    name: "own music: the music importer refuses a track inside its job as too-long, and the job fails with its reason",
    rig: { ownMedia: true },
    async run(t, _w, control) {
      t.note("the boundary takes the file (its bytes are an mp3's); the importer turns it away: one progress step at the total, then job.failed");
      await control.mediaDialog("long-track");
      await t.call("media.pickImport", { kind: "audio" });
      await t.settle();
      t.note("nothing is stored, and the failed job is in a window's snapshot");
      await t.call("media.list", { kind: "audio" });
      await t.call("engine.snapshot", {});
      t.note("the next track takes its turn as if nothing happened");
      await control.mediaDialog("track");
      await t.call("media.pickImport", { kind: "audio" });
      await t.settle();
      await t.call("media.list", { kind: "audio" });
    },
  },
];

// ---------- 3f.3b: own video clips in a draft and a render ----------

/** An own photo of the editor's spec as a photo clip. */
const ownPhotoClipOf = (n: number, mediaId: string, durationMs: number): Record<string, unknown> => ({ clipId: `clip-000000${n}`, kind: "photo", cell: { photo: { source: "own", mediaId }, focus: null }, motion: "static", durationMs, transitionIn: "cut" });

/** An own video clip of the editor's spec. */
const videoClipOf = (n: number, mediaId: string, trimStartMs: number, durationMs: number): Record<string, unknown> => ({ clipId: `clip-000000${n}`, kind: "video", mediaId, trimStartMs, focus: null, durationMs, transitionIn: "cut" });

/** A spec of a 2 s scene-photo clip and a 2 s own video clip of `mediaId` from `trimStartMs`: 4 s, the shortest a spec may be. */
function ownVideoSpec(w: World, mediaId: string, trimStartMs: number): Record<string, unknown> {
  const scenePhotoClip = { clipId: "clip-0000001", kind: "photo", cell: { photo: { source: "scene", photoId: photo(w, 1) }, focus: null }, motion: "static", durationMs: 2_000, transitionIn: "cut" };
  return { schemaVersion: 1, avatarId: w.avatarId, layers: [], music: null, seed: 7, clips: [scenePhotoClip, videoClipOf(2, mediaId, trimStartMs, 2_000)] };
}

/** Imports the one good video and answers its media id (its mezzanine is 6.4 s long, 1080 x 1920). */
async function importedVideoId(t: Transcript, control: Control): Promise<string> {
  await control.mediaDialog("video");
  await t.call("media.pickImport", { kind: "video" });
  await t.settle();
  const [mediaId] = listedMediaIds(await t.call("media.list", { kind: "video" }));
  if (mediaId === undefined) throw new Error("the video was not stored");
  return mediaId;
}

/** Appended after the 3f.4 scenarios: the golden transcripts above are append-only. */
const OWN_VIDEO_CLIP_SCENARIOS: readonly Scenario[] = [
  {
    name: "own video clips: a render holds its video against media.delete until it ends, and a deleted video is media-unavailable in the draft and the render",
    rig: { ownMedia: true },
    async run(t, w, control) {
      const mediaId = await importedVideoId(t, control);
      t.note("a draft with the own video as its second clip: the engine finds nothing wrong");
      const montageId = montageIdOf(await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 1)] }));
      await t.call("montages.save", { montageId, spec: ownVideoSpec(w, mediaId, 1_000), name: "Своё видео" });
      await t.call("montages.get", { montageId });
      await t.call("montages.list", { avatarId: w.avatarId });
      t.note("the render is queued: the video is held, so deleting it is refused and it stays listed");
      await t.call("videos.render", { montageId });
      await t.call("media.delete", { mediaId });
      await t.call("media.list", { kind: "video" });
      t.note("the render ends: the same delete goes through");
      await t.settle();
      await t.call("media.delete", { mediaId });
      await t.call("media.list", {});
      t.note("the draft still names the video: it reads unavailable at its clip, and a render of it is refused for that");
      await t.call("montages.get", { montageId });
      await t.call("montages.list", { avatarId: w.avatarId });
      await t.call("videos.render", { montageId });
    },
  },
  {
    name: "own video clips: a clip that asks past the end of its video is video-too-short in the draft and the render, and one that ends exactly at its end is rendered",
    rig: { ownMedia: true },
    async run(t, w, control) {
      const mediaId = await importedVideoId(t, control);
      const montageId = montageIdOf(await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 1)] }));
      t.note("the mezzanine is 6.4 s: a 2 s clip from 4.5 s ends 0.1 s past it, in the draft and in the render, and no render is queued");
      await t.call("montages.save", { montageId, spec: ownVideoSpec(w, mediaId, 4_500), name: "Слишком далеко" });
      await t.call("montages.get", { montageId });
      await t.call("videos.render", { montageId });
      await t.call("engine.snapshot", {});
      t.note("from 4.4 s the clip ends exactly at the end of the video: nothing is wrong, and the render is queued and ends");
      await t.call("montages.save", { montageId, spec: ownVideoSpec(w, mediaId, 4_400), name: "Ровно до конца" });
      await t.call("montages.get", { montageId });
      await t.call("videos.render", { montageId });
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
    },
  },
  {
    name: "own video clips: a render that fails lets its video go, a media held as another kind is no video, and the issues of a spec come in the order photos, videos, stickers, music",
    rig: { ownMedia: true },
    async run(t, w, control) {
      const mediaId = await importedVideoId(t, control);
      t.note("the first render's ffmpeg fails: while it runs the video is held, and when it has failed the delete goes through");
      control.failNextRender("encode");
      await t.call("videos.render", { spec: ownVideoSpec(w, mediaId, 0) });
      await t.call("media.delete", { mediaId });
      await t.settle();
      await t.call("media.delete", { mediaId });
      t.note("a video that is not there, in a spec that is otherwise good");
      await t.call("videos.render", { spec: ownVideoSpec(w, "media-00000404", 0) });
      t.note("an own PHOTO is not a video");
      const photoId = await importedPhotoId(t, control);
      await t.call("videos.render", { spec: ownVideoSpec(w, photoId, 0) });
      t.note("a spec that names a photo, a video, a sticker and a track nobody holds: one issue each, photos first, then videos, then stickers, then the music");
      await t.call("videos.render", {
        spec: {
          schemaVersion: 1,
          avatarId: w.avatarId,
          layers: [ownStickerOf("media-00000406")],
          music: { source: "own", mediaId: "media-00000407", startMs: 0 },
          seed: 7,
          clips: [ownPhotoClipOf(1, "media-00000405", 2_000), videoClipOf(2, "media-00000404", 0, 2_000)],
        },
      });
      t.note("a spec with a structural issue is refused for that alone, whatever its video");
      await t.call("videos.render", { spec: { ...ownVideoSpec(w, "media-00000404", 0), clips: [videoClipOf(1, "media-00000404", 0, 1_000)] } });
    },
  },
];

/** Every scenario, in the order the golden transcripts were made: new ones are appended, never inserted. */
// ---------- 3f.6: the import's prepare stage ----------

/** Appended after the 3f.3b scenarios: the golden transcripts above are append-only. */
const OWN_IMPORT_STAGE_SCENARIOS: readonly Scenario[] = [
  {
    name: "own media: an import has two stages, the copy in bytes and then the importer's own work in its own units, which says what the probe judged and never reaches its total before the record",
    rig: { ownMedia: true },
    async run(t, _w, control) {
      t.note("a clip whose importer reports its work is picked, held before its first byte so the answer comes with the job running");
      control.holdImports(true);
      await control.mediaDialog("preparedVideo");
      await t.call("media.pickImport", { kind: "video" });
      t.note("the job goes on: the copy to its total, then the prepare from zero of its own total (with what the probe judged), its steps, the record, media.changed, job.done");
      control.holdImports(false);
      await t.settle();
      await t.call("media.list", { kind: "video" });
      await t.call("engine.snapshot", {});
    },
  },
];

// ---------- Stage 3 close: the caption check at render start ----------

/** A text layer of the editor's spec. */
const textLayerOf = (layerId: string, value: string): Record<string, unknown> => ({ layerId, kind: "text", startMs: 0, endMs: 1_000, value, font: "manrope", style: "none", color: "#ffffff", x: 0.5, y: 0.5, scale: 1 });

/** Appended after the 3f.6 scenarios: the golden transcripts above are append-only. */
const CAPTION_CHECK_SCENARIOS: readonly Scenario[] = [
  {
    name: "captions: a draft whose caption breaks the caption rules reports caption-invalid at that layer, and a render of it is refused at once with the same issue",
    async run(t, w) {
      const montageId = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      const stored = objectAt(montageOf(await t.call("montages.get", { montageId })), "spec");
      // "Privet" in Cyrillic (outside the charset), a good caption, a third line: two bad layers around a good one.
      const cyrillic = String.fromCodePoint(0x41f, 0x440, 0x438, 0x432, 0x435, 0x442);
      t.note("a good caption is no issue");
      await t.call("montages.save", { montageId, spec: { ...stored, layers: [textLayerOf("layer-00000001", "Hello")] }, name: null });
      await t.call("montages.get", { montageId });
      t.note("two bad captions around a good one: an issue at each bad layer, in layer order, and the render is refused with them before anything is queued");
      await t.call("montages.save", { montageId, spec: { ...stored, layers: [textLayerOf("layer-00000001", cyrillic), textLayerOf("layer-00000002", "Hello"), textLayerOf("layer-00000003", "a\nb\nc")] }, name: null });
      await t.call("montages.get", { montageId });
      await t.call("videos.render", { montageId });
      t.note("a spec given to the render directly is refused the same way");
      await t.call("videos.render", { spec: { ...stored, layers: [textLayerOf("layer-00000001", cyrillic)] } });
      t.note("a sticker the set lacks, a bad caption (the earlier layer) and a track the store lacks: the order of the issues is stickers, captions, track, for get and for render");
      const goneSticker = { layerId: "layer-00000002", kind: "sticker", startMs: 0, endMs: 1_000, sticker: { source: "builtin", stickerId: "no-such-sticker" }, x: 0.5, y: 0.5, size: 0.2 };
      const mixed = { ...stored, layers: [textLayerOf("layer-00000001", "a\nb\nc"), goneSticker], music: { source: "trending", trackId: "4199287736976977", startMs: 0 } };
      await t.call("montages.save", { montageId, spec: mixed, name: null });
      await t.call("montages.get", { montageId });
      await t.call("videos.render", { montageId });
      t.note("the caption is fixed: no issue, and the render is queued");
      await t.call("montages.save", { montageId, spec: { ...stored, layers: [textLayerOf("layer-00000001", "Hello")] }, name: null });
      await t.call("montages.get", { montageId });
      await t.call("videos.render", { montageId });
      await t.settle();
    },
  },
];

/**
 * K16: an avatar whose photo usage cannot be trusted. Its draft is made empty and saved with two photos (a refused `montages.create` makes
 * none), then every command that judges its photos is asked: both engines refuse them all, with the reason told apart.
 */
function usageUnknownScenario(name: string, usage: NonNullable<RigOptions["usage"]>): Scenario {
  return {
    name,
    rig: { usage },
    async run(t, w) {
      await t.call("avatars.list", {});
      await t.call("photos.list", { avatarId: w.avatarId });
      t.note("a pick of photos is refused; an empty one is not");
      await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(w, 1), photo(w, 2)] });
      const montageId = await draft(t, w, []);
      await t.call("montages.save", { montageId, spec: defaultSpec(w.avatarId, [photo(w, 1), photo(w, 2)], 7), name: null });
      t.note("the draft's photos all read photo-unavailable, and a render refuses them");
      await t.call("montages.get", { montageId });
      await t.call("videos.render", { montageId });
      await t.call("engine.snapshot", {});
      t.note("a focus asks for the photo, not its usage: refused only where no photo is eligible (unreadable marks)");
      await t.call("montages.focus", { avatarId: w.avatarId, photo: { source: "scene", photoId: photo(w, 1) } });
    },
  };
}

/** A draft of only own files, for an avatar whose photo usage cannot be trusted: it names no scene photo, so only a newer record refuses its render. */
function ownOnlyUsageScenario(name: string, usage: NonNullable<RigOptions["usage"]>): Scenario {
  return {
    name,
    rig: { ownMedia: true, usage },
    async run(t, w, control) {
      const mediaId = await importedPhotoId(t, control);
      const montageId = montageIdOf(await t.call("montages.create", { avatarId: w.avatarId, photoIds: [] }));
      await t.call("montages.save", { montageId, spec: ownPhotoSpec(w.avatarId, mediaId), name: "Свои фото" });
      t.note("no scene photo is named, so nothing in the draft reads unavailable");
      await t.call("montages.get", { montageId });
      await t.call("videos.render", { montageId });
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
    },
  };
}

const USAGE_UNKNOWN_SCENARIOS: readonly Scenario[] = [
  ownOnlyUsageScenario("only own files, a record that cannot be read: the draft is judged clean and its render goes through", "record-unreadable"),
  ownOnlyUsageScenario("only own files, a record from a newer Studio: the render is LIBRARY_TOO_NEW", "library-too-new"),
  usageUnknownScenario("an avatar with a record that cannot be read: its photos are refused for a pick, a draft and a render (the log needs repair)", "record-unreadable"),
  usageUnknownScenario("an avatar with a record from a newer Studio: a pick and a render are LIBRARY_TOO_NEW, and a draft's photos are unavailable", "library-too-new"),
  usageUnknownScenario("an avatar whose reject marks cannot be read: no photo is eligible, and a pick, a draft and a render refuse them", "rejects-unreadable"),
];

// ---------- the shortest clip: 100 ms (one time step, 3 frames) ----------

/** A montage of two scene photos with the given clip lengths: a Ken Burns photo and a collage of two, so both render paths run at the short length. */
function shortClipSpec(w: World, firstMs: number, secondMs: number): Record<string, unknown> {
  const cell = (n: number) => ({ photo: { source: "scene", photoId: photo(w, n) }, focus: null });
  return {
    schemaVersion: 1,
    avatarId: w.avatarId,
    layers: [],
    music: null,
    seed: 7,
    clips: [
      { clipId: "clip-0000001", kind: "photo", cell: cell(1), motion: "kenburns", durationMs: firstMs, transitionIn: "cut" },
      { clipId: "clip-0000002", kind: "collage", layout: "collage2", cells: [cell(2), cell(3)], motion: "pan", stagger: true, durationMs: secondMs, transitionIn: "cut" },
    ],
  };
}

/** Appended after the scenarios above: the golden transcripts are append-only. */
const MIN_CLIP_SCENARIOS: readonly Scenario[] = [
  {
    name: "a clip of 100 ms, the shortest: it is saved, judged clean and rendered to the montage's full length; 90 ms and 0 are refused",
    async run(t, w) {
      const montageId = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      t.note("a clip under 100 ms is refused by the contract, and the draft keeps what it had");
      await t.call("montages.save", { montageId, spec: shortClipSpec(w, 90, 3_910), name: null });
      await t.call("montages.save", { montageId, spec: shortClipSpec(w, 0, 4_000), name: null });
      t.note("a clip of exactly 100 ms in a 4 s montage is saved, has no issue, and its render is queued and done");
      await t.call("montages.save", { montageId, spec: shortClipSpec(w, 100, 3_900), name: "Short first clip" });
      await t.call("montages.get", { montageId });
      await t.call("videos.render", { montageId });
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
    },
  },
];

// «Удалить аватар» (2026-10-05). The delete itself is main's (the system Trash), so only what the ENGINE answers is played here: the preview's counts and its
// refusals. The move, the engine's prepare and finish, and the mock's `avatars.delete` have their own tests.
const AVATAR_DELETE_SCENARIOS: readonly Scenario[] = [
  {
    name: "delete an avatar: the preview counts what would go, and is refused while the avatar has a render",
    async run(t, w) {
      await t.call("avatars.deletePreview", { avatarId: w.otherAvatarId });
      await t.call("avatars.deletePreview", { avatarId: w.archivedAvatarId });
      await t.call("avatars.deletePreview", { avatarId: "avatar-nobody-1" });
      const montageId = await draft(t, w, [photo(w, 1), photo(w, 2)]);
      await t.call("avatars.deletePreview", { avatarId: w.avatarId });
      await t.call("videos.render", { montageId });
      t.note("a render of the avatar is queued: the preview is refused, and another avatar's is not");
      await t.call("avatars.deletePreview", { avatarId: w.avatarId });
      await t.call("avatars.deletePreview", { avatarId: w.otherAvatarId });
      await t.settle();
      await t.call("avatars.deletePreview", { avatarId: w.avatarId });
    },
  },
];

// CS.2: the owner's own scene categories. Only the free commands are played here (the parity rig scripts no chat, so a create and a regenerate have their own
// engine and mock tests): what the library lists, a rename and a removal with every refusal, a delete, the forgetting of an interrupted call, and a run that
// names a category the library does not hold. The price (`categories.estimate`) differs by design: the mock's prices are «live», the engine's offline ones the table.
const CATEGORY_SCENARIOS: readonly Scenario[] = [
  {
    name: "custom categories: the library lists its category, the unreadable file and the interrupted create; a rename, a removal and a delete, with their refusals",
    rig: { categories: true },
    async run(t) {
      t.note("the list: one category, one file nobody can read, one create a closed Studio left, nothing in flight");
      await t.call("categories.list", {});
      t.note("a rename is free and announced; a name another category holds and a blank one are refused");
      await t.call("categories.update", { categoryId: "cat-parity-0001", name: "  Кофейни у Сены " });
      await t.call("categories.update", { categoryId: "cat-parity-0001", name: " " });
      await t.call("categories.update", { categoryId: "cat-nobody-here", name: "Другое имя" });
      t.note("an outfit goes by its text; one that is not there, and a place when the pool is at its minimum, are refused");
      await t.call("categories.update", { categoryId: "cat-parity-0001", removeOutfits: ["a red scarf and a coat"] });
      await t.call("categories.update", { categoryId: "cat-parity-0001", removeOutfits: ["a hat nobody has"] });
      await t.call("categories.update", { categoryId: "cat-parity-0001", removeOutfits: ["a black midi dress"] });
      await t.call("categories.update", { categoryId: "cat-parity-0001", removeLocations: ["a flower stall"] });
      await t.call("categories.update", { categoryId: "cat-parity-0001" });
      await t.call("categories.list", {});
      t.note("the interrupted create is forgotten once; the second time there is nothing to forget");
      await t.call("categories.dismissInterrupted", { jobId: "job-parity-0001" });
      await t.call("categories.dismissInterrupted", { jobId: "job-parity-0001" });
      t.note("a delete announces the removal; a second delete finds nothing");
      await t.call("categories.delete", { categoryId: "cat-parity-0001" });
      await t.call("categories.delete", { categoryId: "cat-parity-0001" });
      await t.call("categories.list", {});
    },
  },
  {
    name: "custom categories: a refusal names its reason, so the sheet can tell a taken name from a missing item and from the pool's minimum",
    rig: { categories: true, secondCategory: true },
    async run(t) {
      t.note("a rename to the name the other category holds (any letter case, edge spaces); the category's own name in another case is no clash");
      await t.call("categories.update", { categoryId: "cat-parity-0002", name: " кофейни ПАРИЖА " });
      t.note("an item the category does not hold, and a removal that would take the pool below its minimum");
      await t.call("categories.update", { categoryId: "cat-parity-0002", removeLocations: ["a place nobody has"] });
      await t.call("categories.update", { categoryId: "cat-parity-0002", removeOutfits: ["a hat nobody has"] });
      await t.call("categories.update", { categoryId: "cat-parity-0002", removeLocations: ["a flower stall"] });
      t.note("a refusal that is no category's own (a blank name, caught by the contract) names no reason");
      await t.call("categories.update", { categoryId: "cat-parity-0002", name: " " });
    },
  },
  {
    name: "custom categories: the angles of a category are set, replaced and cleared by a free update, together with a rename, and a refused removal leaves them as they were",
    rig: { categories: true },
    async run(t) {
      t.note("a category made before the angles existed has none; setting them is free and announced");
      await t.call("categories.update", { categoryId: "cat-parity-0001", poses: ["back"] });
      await t.call("categories.list", {});
      t.note("they are replaced as a whole, together with a rename in one write");
      await t.call("categories.update", { categoryId: "cat-parity-0001", name: "Вид сзади", poses: ["profile", "back"] });
      t.note("a removal the pool cannot take refuses the whole update: the angles stay as they were");
      await t.call("categories.update", { categoryId: "cat-parity-0001", poses: ["front"], removeLocations: ["a flower stall"] });
      await t.call("categories.list", {});
      t.note("null clears them; the contract turns away an empty list, a repeat and a word outside the vocabulary; an unknown category is not found");
      await t.call("categories.update", { categoryId: "cat-parity-0001", poses: null });
      await t.call("categories.update", { categoryId: "cat-parity-0001", poses: [] });
      await t.call("categories.update", { categoryId: "cat-parity-0001", poses: ["back", "back"] });
      await t.call("categories.update", { categoryId: "cat-parity-0001", poses: ["sideways"] });
      await t.call("categories.update", { categoryId: "cat-nobody-here", poses: ["back"] });
      await t.call("categories.list", {});
    },
  },
  {
    name: "custom categories: a run names a category the library does not hold, and is refused before any price",
    rig: { categories: true },
    async run(t, w) {
      const poses = { profile: false, back: false };
      t.note("an estimate and a start name a category nobody made (one the library holds is not played: its price is worded differently by design)");
      await t.call("runs.estimate", { avatarId: w.avatarId, count: 4, categories: ["home", "cat-nobody-here"], poses });
      await t.call("runs.start", { avatarId: w.avatarId, count: 4, categories: ["cat-nobody-here"], poses, acceptedWorstMicros: 10_000_000 });
    },
  },
];

// CS.4a: the scene sets. Only the free commands are played here (the parity rig scripts no chat, so a compose and a «Дописать» have their own tests, and the
// estimates differ by design: the mock's prices are «live», the engine's offline ones the table). What is pinned: the order of checks, every refusal's
// code, the view of a set that a closed Studio left half-written, each reason a text is turned away, one revision per edit, and the events.
const SCENE_SET_SCENARIOS: readonly Scenario[] = [
  {
    name: "scene sets: the open set a closed Studio left, free edits and their refusals",
    rig: { sceneSets: true },
    async run(t, w) {
      t.note("the avatar's set: one scene written, two waiting, the compose a closed Studio did not finish; one set file nobody can read");
      await t.call("scenes.get", { avatarId: w.avatarId });
      await t.call("scenes.get", { avatarId: "avatar-nobody-404" });
      t.note("a text the assembler's own rule would refuse, and the bounds, are results that change nothing");
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 1, op: { op: "text", sceneId: 1, text: "She walks the beach in a bikini." } });
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 1, op: { op: "text", sceneId: 1, text: "   " } });
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 1, op: { op: "text", sceneId: 1, text: "one\ntwo" } });
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 1, op: { op: "text", sceneId: 1, text: "A teenage girl smiles." } });
      t.note("a text typed into a waiting scene makes it written; the same revision again is stale");
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 1, op: { op: "text", sceneId: 2, text: "She reads on the sofa." } });
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 1, op: { op: "remove", sceneIds: [3] } });
      t.note("one change removes many scenes, and restores them; a scene the set lacks refuses the whole change");
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 2, op: { op: "remove", sceneIds: [2, 3] } });
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 3, op: { op: "remove", sceneIds: [1, 99] } });
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 3, op: { op: "text", sceneId: 3, text: "Typed on a removed scene." } });
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 3, op: { op: "restore", sceneIds: [2, 3] } });
      await t.call("scenes.get", { avatarId: w.avatarId });
    },
  },
  {
    name: "scene sets: one open set, an empty set is free, a discard and a cancel with their refusals",
    rig: { sceneSets: true },
    async run(t, w) {
      const request = { avatarId: w.avatarId, count: 0, categories: [], poses: { profile: false, back: false }, acceptedWorstMicros: 0 };
      t.note("the avatar already has an open set: a second compose, even an empty one, is refused");
      await t.call("scenes.compose", request);
      t.note("an unknown set is NOT_FOUND for every command that names one; a cancel of a set that does not run is ok");
      await t.call("scenes.edit", { sceneSetId: "set-nobody-0404", revision: 1, op: { op: "remove", sceneIds: [1] } });
      await t.call("scenes.cancel", { sceneSetId: "set-nobody-0404" });
      await t.call("scenes.discard", { sceneSetId: "set-nobody-0404" });
      await t.call("scenes.cancel", { sceneSetId: "set-parity-0001" });
      t.note("a discard frees the avatar: an empty set is then free, and is the one the avatar has");
      await t.call("scenes.discard", { sceneSetId: "set-parity-0001" });
      await t.call("scenes.get", { avatarId: w.avatarId });
      await t.call("scenes.compose", request);
      await t.call("scenes.get", { avatarId: w.avatarId });
    },
  },
  // CS.4b: the review writes. A rewrite, an idea write and their resume are paid and have their own tests (the parity rig scripts no chat, and the estimates
  // differ by design); what is pinned here is what a closed Studio left of them: the markers on the scenes and the list of interrupted idea writes, every
  // free refusal of a write's target in the engine's order, and the dismissal of a marker, by scene and by write.
  {
    name: "scene sets, review writes: what a closed Studio left, the refusals of a write's target, and letting an interrupted write go",
    rig: { reviewWrites: true },
    async run(t, w) {
      t.note("a set of three planned scenes and an own one: scene 2 carries a rewrite a dropped connection interrupted, and an idea write for two more scenes waits");
      await t.call("scenes.get", { avatarId: w.avatarId });
      t.note("a rewrite names scenes the set has, not removed, of one kind; a redraw is for planned scenes; a resume names an unresolved write");
      await t.call("scenes.estimateWrite", { sceneSetId: "set-parity-0001", target: { kind: "rewrite", sceneIds: [99], redraw: false } });
      await t.call("scenes.estimateWrite", { sceneSetId: "set-parity-0001", target: { kind: "rewrite", sceneIds: [1, 4], redraw: false } });
      await t.call("scenes.estimateWrite", { sceneSetId: "set-parity-0001", target: { kind: "rewrite", sceneIds: [4], redraw: true } });
      await t.call("scenes.estimateWrite", { sceneSetId: "set-parity-0001", target: { kind: "resume", write: 9 } });
      await t.call("scenes.estimateWrite", { sceneSetId: "set-nobody-0404", target: { kind: "rewrite", sceneIds: [1], redraw: false } });
      t.note("a removed scene is not rewritten");
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 1, op: { op: "remove", sceneIds: [3] } });
      await t.call("scenes.estimateWrite", { sceneSetId: "set-parity-0001", target: { kind: "rewrite", sceneIds: [3], redraw: false } });
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 2, op: { op: "restore", sceneIds: [3] } });
      t.note("a hand edit works on an own scene as on any, and the same word rule turns it away");
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 3, op: { op: "text", sceneId: 4, text: "She walks the balcony in a bikini." } });
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 3, op: { op: "text", sceneId: 4, text: "She waves from the balcony." } });
      t.note("«Оставить как есть»: a scene without an interrupted write, a scene the set lacks and a write nobody has are refused; the right ones go, one by one");
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 4, op: { op: "dismissInterrupted", sceneIds: [1] } });
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 4, op: { op: "dismissInterrupted", sceneIds: [99] } });
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 4, op: { op: "dismissInterrupted", write: 9 } });
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 4, op: { op: "dismissInterrupted", sceneIds: [2] } });
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 5, op: { op: "dismissInterrupted", sceneIds: [2] } });
      t.note("«Не нужно»: an idea write is dismissed by its number, and a dismissed write is no longer there to dismiss or resume");
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 5, op: { op: "dismissInterrupted", write: 3 } });
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 6, op: { op: "dismissInterrupted", write: 3 } });
      await t.call("scenes.estimateWrite", { sceneSetId: "set-parity-0001", target: { kind: "resume", write: 3 } });
      await t.call("scenes.get", { avatarId: w.avatarId });
    },
  },
];

// CS.5: a run from a scene set. Only the refusals are played (the estimates differ by design, and a start that goes through draws images, which this rig does not
// script): the order of the checks, every refusal's code, the price refusal that follows them, and the events a refused start must not send.
const SCENE_RUN_SCENARIOS: readonly Scenario[] = [
  {
    name: "scene set runs: every refusal comes free and in order, and no run is made",
    rig: { sceneSets: true },
    async run(t, w) {
      t.note("an unknown set, and a revision that moved, are refused before anything else is looked at");
      await t.call("runs.estimateFromScenes", { sceneSetId: "set-nobody-0404", revision: 1 });
      await t.call("runs.estimateFromScenes", { sceneSetId: "set-parity-0001", revision: 9 });
      await t.call("runs.startFromScenes", { sceneSetId: "set-nobody-0404", revision: 1, acceptedWorstMicros: 10_000_000 });
      await t.call("runs.startFromScenes", { sceneSetId: "set-parity-0001", revision: 9, acceptedWorstMicros: 10_000_000 });
      t.note("two of the three scenes still wait for their sentence: an active scene with no text is refused, however much the owner accepted");
      await t.call("runs.estimateFromScenes", { sceneSetId: "set-parity-0001", revision: 1 });
      await t.call("runs.startFromScenes", { sceneSetId: "set-parity-0001", revision: 1, acceptedWorstMicros: 10_000_000 });
      t.note("removing the waiting scenes is one free edit; the scene with text left is what a start would draw (its price and gates are played by the engine's and the mock's own suites)");
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 1, op: { op: "remove", sceneIds: [2, 3] } });
      t.note("with every scene removed there is nothing to draw");
      await t.call("scenes.edit", { sceneSetId: "set-parity-0001", revision: 2, op: { op: "remove", sceneIds: [1] } });
      await t.call("runs.estimateFromScenes", { sceneSetId: "set-parity-0001", revision: 3 });
      await t.call("runs.startFromScenes", { sceneSetId: "set-parity-0001", revision: 3, acceptedWorstMicros: 10_000_000 });
      t.note("none of it made a run or used the set");
      await t.call("runs.list", {});
      await t.call("scenes.get", { avatarId: w.avatarId });
    },
  },
];

// S4.P2: photos.list pages by a cursor. The rig's library is far under one page (500), so what is compared here is the position rule itself on both
// engines: the photos strictly after a cursor, newest first, from a live photo, from one that is gone, and from the last; and a forged cursor refused.
// (A cursor-less call on a bigger library, the page boundaries 500/501/1001 and paging under adds are the engine's and the mock's own suites'.)
const PHOTO_CURSOR_SCENARIOS: readonly Scenario[] = [
  {
    name: "photos list pages by cursor: a position, a gone photo, the last one, a forged value",
    async run(t, w) {
      const first = resultOf(await t.call("photos.list", { avatarId: w.avatarId }));
      const listed = first.photos;
      if (!Array.isArray(listed) || listed.length < 12) throw new Error("the world has fewer photos than the scenario pages");
      const at = (n: number): { createdAt: string; photoId: string } => {
        const found: unknown = listed[n];
        const record = objectAt({ found }, "found");
        return { createdAt: stringAt(record, "createdAt"), photoId: stringAt(record, "photoId") };
      };
      t.note("from the tenth photo of the list: the ones older than it, in order");
      await t.call("photos.list", { avatarId: w.avatarId, cursor: encodePhotoCursor(at(9).createdAt, at(9).photoId) });
      t.note("from a photo that is not in the library, at the time of the fifth (its id sorts before every real one, so a tie at that time is never taken in): the same position rule, nothing to find");
      await t.call("photos.list", { avatarId: w.avatarId, cursor: encodePhotoCursor(at(4).createdAt, "-") });
      t.note("from the oldest photo: an empty last page");
      const last = at(listed.length - 1);
      await t.call("photos.list", { avatarId: w.avatarId, cursor: encodePhotoCursor(last.createdAt, last.photoId) });
      t.note("a value that is not a cursor is refused, and the list still answers");
      await t.call("photos.list", { avatarId: w.avatarId, cursor: "forged" });
      await t.call("photos.list", { avatarId: w.avatarId });
    },
  },
];

export const SCENARIOS: readonly Scenario[] = [...BASE_SCENARIOS, ...OWN_MEDIA_SCENARIOS, ...OWN_MEDIA_RECORD_SCENARIOS, ...OWN_PHOTO_SCENARIOS, ...OWN_VIDEO_SCENARIOS, ...OWN_STICKER_SCENARIOS, ...OWN_MUSIC_SCENARIOS, ...OWN_VIDEO_CLIP_SCENARIOS, ...OWN_IMPORT_STAGE_SCENARIOS, ...CAPTION_CHECK_SCENARIOS, ...USAGE_UNKNOWN_SCENARIOS, ...MIN_CLIP_SCENARIOS, ...AVATAR_DELETE_SCENARIOS, ...IMAGE_MODEL_SCENARIOS, ...CATEGORY_SCENARIOS, ...SCENE_SET_SCENARIOS, ...SCENE_RUN_SCENARIOS, ...PHOTO_CURSOR_SCENARIOS, ...AUTOPILOT_SCENARIOS];

/** A spec's clips, from an answer, each made `durationMs` long. */
function clipsOf(spec: Record<string, unknown>, durationMs: number): Record<string, unknown>[] {
  const clips = spec.clips;
  if (!Array.isArray(clips)) throw new Error("expected clips");
  return clips.map((clip: unknown) => ({ ...objectAt({ clip }, "clip"), durationMs }));
}

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
