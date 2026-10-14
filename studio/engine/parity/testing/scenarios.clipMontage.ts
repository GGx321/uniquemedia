import type { ClipWorld } from "./clipWorld";
import type { Control, World } from "./rigs";
import type { Scenario } from "./scenarios";
import type { Answer, Transcript } from "./transcript";

// Stage 5, 5b.2, S5.WA3 (APPENDED; the golden is append-only): «Клипы в монтаже» told against both engines. A ready clip becomes the editor's own video as its own copy (`media.importClip`); a montage
// that holds a copy renders; a photo and every clip made from it are ONE frame. The rig is the clips rig with `ownMedia`: the real rig plays the video provider by the fake (the clip is a real small mp4),
// the video importer by the rig's stand-in (which says what the real one would of a 5 s 720 x 1280 clip at 24 fps), and the render by the rig's fake ffmpeg: NO ffmpeg renders in parity. The real render of
// copies is the engine smoke's (scripts/clipSmoke.ts). The mock plays the same facts from the clip's own record.
//
// A story waits on what it is about: the end of a job (`untilJobEnds`). It never counts settles and never sleeps, so a slow machine tells the same story.

type Telling = Transcript;

const STD_5 = 850_000;
const KLING_ONLY_5 = 504_000;

function clipsOf(world: World): ClipWorld {
  if (world.clipWorld === undefined) throw new Error("the rig has no clip world: the story needs `rig: { clips: true, ownMedia: true }`");
  return world.clipWorld;
}

function resultOf(answer: Answer): Record<string, unknown> {
  if (!answer.ok) throw new Error(`the story expected ok, got ${answer.error.code}`);
  return answer.result;
}

function stringOf(answer: Answer, key: string): string {
  const value = resultOf(answer)[key];
  if (typeof value !== "string") throw new Error(`expected a ${key}`);
  return value;
}

/** A clip of `photoId` (the frame with a likeness by default), played to the end of its job: the clip's id (a clip's id is its create job's). */
async function makeClip(t: Telling, w: ClipWorld, control: Control, photoId: string = w.photos.plain, script: "ok" | "refused-free" = "ok"): Promise<string> {
  control.clips.next(script);
  // The frame of «Смелая» has no fallback: its worst is Kling's alone.
  const bold = photoId === w.photos.bold || script === "refused-free";
  const jobId = stringOf(
    await t.call("clips.create", { avatarId: w.avatarId, photoId, motionId: "g-blink", model: "kling", quality: "std", seconds: 5, fallback: bold ? "none" : "auto", acceptedWorstMicros: bold ? KLING_ONLY_5 : STD_5 }),
    "jobId",
  );
  await t.untilJobEnds(jobId);
  return jobId;
}

/** Imports the clip's copy and waits for the end of its job: the copy's media id. */
async function importCopy(t: Telling, w: ClipWorld, clipId: string): Promise<string> {
  const jobId = stringOf(await t.call("media.importClip", { avatarId: w.avatarId, clipId }), "jobId");
  await t.untilJobEnds(jobId);
  const listed = resultOf(await t.call("media.list", { kind: "video" })).media;
  const copy = (Array.isArray(listed) ? listed : []).map((item) => (typeof item === "object" && item !== null ? Object.fromEntries(Object.entries(item)) : {})).find((item) => typeof item.origin === "object" && item.origin !== null && "clipId" in item.origin && item.origin.clipId === clipId);
  if (copy === undefined || typeof copy.mediaId !== "string") throw new Error("the copy was not stored");
  return copy.mediaId;
}

/**
 * A photo's state (used, in which videos, reserved, rejected, eligible), read through a mark that already is what it is asked for: it changes nothing and answers the photo as `photos.list` shows it, without the
 * order of the whole list (the rigs seed the clip world's photos in their own order).
 */
async function photoState(t: Telling, w: ClipWorld, photoId: string, rejected: boolean): Promise<void> {
  await t.call("photos.setRejected", { avatarId: w.avatarId, photoId, rejected });
}

const sceneClip = (n: number, photoId: string, durationMs = 2_000) => ({ clipId: `clip-000000${n}`, kind: "photo", cell: { photo: { source: "scene", photoId }, focus: null }, motion: "static", durationMs, transitionIn: "cut" });
const copyClip = (n: number, mediaId: string, durationMs = 2_000) => ({ clipId: `clip-000000${n}`, kind: "video", mediaId, trimStartMs: 0, focus: null, durationMs, transitionIn: "cut" });
const specOf = (avatarId: string, clips: readonly Record<string, unknown>[]) => ({ schemaVersion: 1, avatarId, layers: [], music: null, seed: 7, clips });

export const CLIP_MONTAGE_SCENARIOS: readonly Scenario[] = [
  {
    name: "clips in the montage: a ready clip becomes the editor's own video as its own copy, one per clip, and the refusals come in the engine's order",
    rig: { clips: true, ownMedia: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      t.note("an ordinary clip, then its copy: the import job names the clip, its record says where it comes from");
      const clipId = await makeClip(t, w, control);
      const jobId = stringOf(await t.call("media.importClip", { avatarId: w.avatarId, clipId }), "jobId");
      await t.untilJobEnds(jobId);
      await t.call("media.list", { kind: "video" });
      t.note("a second import answers the copy that lives, with no job");
      await t.call("media.importClip", { avatarId: w.avatarId, clipId });
      t.note("an avatar the library does not have, a clip it does not have, and a clip of another avatar");
      await t.call("media.importClip", { avatarId: "avatar-nobody-0001", clipId });
      await t.call("media.importClip", { avatarId: w.avatarId, clipId: "clip-nobody-0001" });
      await t.call("media.importClip", { avatarId: world.avatarId, clipId });
      t.note("a clip that did not come out has no file to prepare");
      const failed = await makeClip(t, w, control, w.photos.plain, "refused-free");
      await t.call("media.importClip", { avatarId: w.avatarId, clipId: failed });
      t.note("a clip whose file in Studio is not the one its record names");
      const damaged = await makeClip(t, w, control, w.photos.bold);
      await control.clips.damageFile(damaged);
      await t.call("media.importClip", { avatarId: w.avatarId, clipId: damaged });
    },
  },
  {
    name: "clips in the montage: the clip is held while its copy is made: a delete, an export, a second import and an avatar delete wait",
    rig: { clips: true, ownMedia: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      const clipId = await makeClip(t, w, control);
      control.holdImports(true);
      const jobId = stringOf(await t.call("media.importClip", { avatarId: w.avatarId, clipId }), "jobId");
      t.note("while the copy is made: a second import, a delete, an export and the avatar's delete are all told to wait");
      await t.call("media.importClip", { avatarId: w.avatarId, clipId });
      await t.call("clips.delete", { avatarId: w.avatarId, clipId });
      await t.call("clips.export", { avatarId: w.avatarId, clipId });
      await t.call("avatars.deletePreview", { avatarId: w.avatarId });
      control.holdImports(false);
      await t.untilJobEnds(jobId);
      t.note("when the job has ended the clip is free again");
      await t.call("avatars.deletePreview", { avatarId: w.avatarId });
      await t.call("clips.delete", { avatarId: w.avatarId, clipId });
      await t.call("media.list", { kind: "video" });
    },
  },
  {
    name: "clips in the montage: a montage that holds a copy renders, its frame is used, and the clip and its siblings say how they are used",
    rig: { clips: true, ownMedia: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      const clipId = await makeClip(t, w, control);
      const sibling = await makeClip(t, w, control);
      const copy = await importCopy(t, w, clipId);
      t.note("nothing uses the clip yet");
      await t.call("clips.get", { avatarId: w.avatarId, clipId });
      t.note("a draft that holds the copy: the clip says how many drafts, and which one");
      const draft = resultOf(await t.call("montages.create", { avatarId: w.avatarId, photoIds: [] })).montage;
      const montageId = typeof draft === "object" && draft !== null && "montageId" in draft && typeof draft.montageId === "string" ? draft.montageId : "";
      const spec = specOf(w.avatarId, [sceneClip(1, w.photos.landscape), copyClip(2, copy)]);
      await t.call("montages.save", { montageId, spec, name: "Лето" });
      await t.call("clips.get", { avatarId: w.avatarId, clipId });
      t.note("the render: the frame of the clip is used as a scene photo is, and the video counts the photos it shows");
      await t.call("videos.render", { montageId });
      await t.settle();
      await t.call("videos.list", { avatarId: w.avatarId });
      await photoState(t, w, w.photos.plain, false);
      await photoState(t, w, w.photos.landscape, false);
      t.note("the clip is in a video and in a draft; its sibling (the same photo) is used through the photo");
      await t.call("clips.get", { avatarId: w.avatarId, clipId });
      await t.call("clips.get", { avatarId: w.avatarId, clipId: sibling });
      t.note("a clip that is gone and a copy that is gone keep the frame used");
      await t.call("clips.delete", { avatarId: w.avatarId, clipId });
      await t.call("media.list", { kind: "video" });
      await photoState(t, w, w.photos.plain, false);
    },
  },
  {
    name: "clips in the montage: a photo and its clips are one frame: a frame twice in a spec, a foreign copy, a used frame, a held frame and a rejected one are each refused at the clip",
    rig: { clips: true, ownMedia: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      const first = await makeClip(t, w, control);
      const second = await makeClip(t, w, control);
      const bold = await makeClip(t, w, control, w.photos.bold);
      const a = await importCopy(t, w, first);
      const b = await importCopy(t, w, second);
      const c = await importCopy(t, w, bold);
      t.note("a photo and a clip of it, the same copy twice, and two clips of one photo: `frame-repeated` at the second place");
      await t.call("videos.render", { spec: specOf(w.avatarId, [sceneClip(1, w.photos.plain), copyClip(2, a)]) });
      await t.call("videos.render", { spec: specOf(w.avatarId, [copyClip(1, a), copyClip(2, a)]) });
      await t.call("videos.render", { spec: specOf(w.avatarId, [copyClip(1, a), copyClip(2, b)]) });
      t.note("a copy of another avatar's clip: `frame-foreign`");
      await t.call("videos.render", { spec: specOf(world.avatarId, [copyClip(1, a, 4_000)]) });
      t.note("a render that holds the photo, and another that holds a copy of its clip, collide at the clip");
      await t.call("videos.render", { spec: specOf(w.avatarId, [sceneClip(1, w.photos.plain), sceneClip(2, w.photos.hidden)]) });
      await t.call("videos.render", { spec: specOf(w.avatarId, [sceneClip(1, w.photos.landscape), copyClip(2, a)]) });
      await t.settle();
      t.note("the photo is in a video now: the copy of its other clip is refused at the clip, as in a video");
      await t.call("videos.render", { spec: specOf(w.avatarId, [sceneClip(1, w.photos.landscape), copyClip(2, b)]) });
      t.note("a copy whose photo is rejected is refused like a rejected scene photo");
      await t.call("photos.setRejected", { avatarId: w.avatarId, photoId: w.photos.bold, rejected: true });
      await t.call("videos.render", { spec: specOf(w.avatarId, [sceneClip(1, w.photos.landscape), copyClip(2, c)]) });
    },
  },
  {
    name: "clips in the montage: a video that holds a copy keeps its clip's frame used, a delete-and-reject rejects it, and a clip delete waits for a render that holds the copy",
    rig: { clips: true, ownMedia: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      const clipId = await makeClip(t, w, control);
      const bold = await makeClip(t, w, control, w.photos.bold);
      const copy = await importCopy(t, w, clipId);
      await importCopy(t, w, bold);
      t.note("a render that holds the copy: the clip's delete and the avatar's delete wait for it");
      const render = resultOf(await t.call("videos.render", { spec: specOf(w.avatarId, [sceneClip(1, w.photos.landscape), copyClip(2, copy)]) }));
      await t.call("clips.delete", { avatarId: w.avatarId, clipId });
      await t.call("avatars.deletePreview", { avatarId: w.avatarId });
      await t.call("media.list", { kind: "video" });
      await t.settle();
      t.note("when it has ended the video uses the frame");
      await photoState(t, w, w.photos.plain, false);
      await photoState(t, w, w.photos.landscape, false);
      t.note("delete-and-reject rejects the scene photo and then the photo of the clip");
      await t.call("videos.delete", { videoId: String(render.videoId), mode: "video", rejectPhotos: true });
      await photoState(t, w, w.photos.plain, true);
      await photoState(t, w, w.photos.landscape, true);
      t.note("a clip with no render on its copy is deleted with its copy");
      await t.call("clips.delete", { avatarId: w.avatarId, clipId: bold });
      await t.call("media.list", { kind: "video" });
    },
  },
];
