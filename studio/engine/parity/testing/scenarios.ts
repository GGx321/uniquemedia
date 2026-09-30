import { estimateBytesUpper } from "../../../shared/montage";
import type { Control, RigOptions, World } from "./rigs";
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

const textLayer = { layerId: "layer-0001", kind: "text", startMs: 0, endMs: 1_000, value: "Hi", font: "manrope", style: "none", color: "#ffffff", x: 0.5, y: 0.5, scale: 1 };

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
      await t.call("montages.save", { montageId: layered, spec: { ...objectAt(stored, "spec"), layers: [textLayer] }, name: null });
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
];

/** `estimateBytesUpper` of the clips of the draft a `montages.create` answered: what a render of it asks the export folder to have twice over. */
function upperBytesOf(answer: Answer): number {
  const clips = objectAt(montageOf(answer), "spec").clips;
  if (!Array.isArray(clips)) throw new Error("expected clips");
  return estimateBytesUpper(clips.map((clip: unknown) => ({ durationMs: Number(objectAt({ clip }, "clip").durationMs) })));
}
