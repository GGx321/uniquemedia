import type { Scenario } from "./scenarios";
import type { World } from "./rigs";
import type { Answer } from "./transcript";

// The batch autopilot, told through its commands (Stage 4, S4.1; plan §9 and §18). The real engine answers every one of them «not implemented yet» until its orchestrator lands
// (S4.6), so the stories that need it served are PENDING (`Scenario.pending`): the mock's transcript is bound to the golden, and the real engine is only held to its one refusal.
// What the contract itself refuses is refused by both engines and is compared line for line NOW.
//
// A pending story is written so that it can run against a real engine that refuses everything AND so that it can later run against one that serves it: it passes its own plan
// seed (the preview echoes it), accepts a worst case that is plainly enough (`ENOUGH`) or plainly not (`NOT_ENOUGH`) instead of the preview's own figure (the mock's prices and the
// engine's are different tables), and takes a placeholder for an id when the command that would have given it was refused.

const SEED = 4_242;
/** An accepted worst case far above any plan of these stories, and one below any plan that spends: the exact boundary is held by the mock's and the engine's own unit tests. */
const ENOUGH = 10_000_000;
const NOT_ENOUGH = 0;
/** What a pending story uses for a launch id when the real engine refused the command that would have given it. */
const NO_LAUNCH = "launch-00000000";

const settingsOf = (w: World, over: Record<string, unknown> = {}) => ({
  avatarIds: [w.avatarId],
  videosPerAvatar: 4,
  mix: { single: 50, collage: 25, slides: 25 },
  categories: ["home"],
  poses: { profile: false, back: false },
  library: true,
  generate: true,
  sceneReview: false,
  stickers: false,
  ...over,
});
const draftOf = (w: World, over: Record<string, unknown> = {}) => ({ ...settingsOf(w, over), planSeed: SEED });

function record(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? Object.fromEntries(Object.entries(value)) : null;
}

/** The launch an answer carries, or null when the answer is an error. */
function launchOf(answer: Answer): Record<string, unknown> | null {
  return answer.ok ? record(answer.result.launch) : null;
}

const launchIdOf = (answer: Answer): string => {
  const id = launchOf(answer)?.launchId;
  return typeof id === "string" ? id : NO_LAUNCH;
};

/** The avatar row of a launch that waits for its review: its set and the revision the owner saw. */
function reviewRowOf(answer: Answer): { avatarId: string; sceneSetId: string; revision: number } | null {
  const rows = launchOf(answer)?.avatars;
  if (!Array.isArray(rows)) return null;
  for (const row of rows) {
    const r = record(row);
    if (r?.phase === "awaiting-review" && typeof r.avatarId === "string" && typeof r.sceneSetId === "string" && typeof r.setRevision === "number") {
      return { avatarId: r.avatarId, sceneSetId: r.sceneSetId, revision: r.setRevision };
    }
  }
  return null;
}

/** Renders one video from two photos and answers its id (the story's first video in the list). */
async function renderedVideoOf(t: Parameters<Scenario["run"]>[0], w: World): Promise<string> {
  const photo = (n: number): string => w.photoIds[n - 1] ?? "";
  const created = await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(1), photo(2)] });
  const montageId = created.ok ? String(record(created.result.montage)?.montageId ?? "") : "";
  await t.call("videos.render", { montageId });
  await t.advance("progress");
  await t.advance("saving");
  await t.settle();
  const listed = await t.call("videos.list", { avatarId: w.avatarId });
  const first = listed.ok && Array.isArray(listed.result.videos) ? record(listed.result.videos[0]) : null;
  return typeof first?.videoId === "string" ? first.videoId : "video-00000001";
}

const PARITY_NOW: Scenario[] = [
  {
    name: "autopilot: what the contract refuses is refused by both engines before any lookup, and a name or a path is never an entry",
    async run(t, w) {
      const settings = settingsOf(w);
      const draft = draftOf(w);
      t.note("a draft the contract refuses: a mix that does not sum to 100, no avatar, too many videos, a category twice");
      await t.call("autopilot.estimate", { draft: { ...settings, mix: { single: 60, collage: 25, slides: 25 } } });
      await t.call("autopilot.estimate", { draft: { ...settings, avatarIds: [] } });
      await t.call("autopilot.estimate", { draft: { ...settings, videosPerAvatar: 51 } });
      await t.call("autopilot.estimate", { draft: { ...settings, categories: ["home", "home"] } });
      t.note("the start needs the preview's plan seed, and amounts are whole, non-negative micro-dollars within the launch bound");
      await t.call("autopilot.start", { draft: settings, acceptedWorstMicros: ENOUGH });
      await t.call("autopilot.start", { draft, acceptedWorstMicros: 1.5 });
      await t.call("autopilot.start", { draft, acceptedWorstMicros: -1 });
      await t.call("autopilot.start", { draft, acceptedWorstMicros: 10_000_000_001 });
      await t.call("autopilot.resume", { launchId: NO_LAUNCH, acceptedRemainingMicros: -1 });
      await t.call("autopilot.resume", { launchId: NO_LAUNCH });
      t.note("an entry is an opaque id: a path, a name and a key of another shape are refused");
      await t.call("autopilot.removeUnreadable", { entryId: "../../etc/passwd" });
      await t.call("autopilot.removeUnreadable", { entryId: "launch-0a1b2c3d4e5f.json" });
      await t.call("autopilot.removeUnreadable", { name: "launch-0a1b2c3d4e5f.json" });
      t.note("a launch is named by an id of its own shape; a revision starts at 1");
      await t.call("autopilot.pause", { launchId: "../launch" });
      await t.call("autopilot.stop", { launchId: "run-0a1b2c3d4e5f" });
      await t.call("autopilot.get", { launchId: "launch-x" });
      await t.call("autopilot.continueAfterReview", { launchId: NO_LAUNCH, avatarId: w.avatarId, sceneSetId: "set-parity-0001", revision: 0 });
      t.note("the flags added to commands that exist");
      await t.call("videos.delete", { videoId: "video-00000001", mode: "video", rejectPhotos: false });
      await t.call("videos.setPublished", { videoId: "video-00000001", published: "yes" });
      await t.call("media.setForAutopilot", { mediaId: "media-00000001", on: 1 });
    },
  },
  {
    name: "videos: the owner's «Опубликовано» mark is set and cleared, and «Удалить видео и отклонить фото» rejects the photos before the video goes",
    async run(t, w) {
      const videoId = await renderedVideoOf(t, w);
      t.note("clearing a video that was never marked changes and announces nothing");
      await t.call("videos.setPublished", { videoId, published: false });
      t.note("the owner's mark, set and cleared and set again; asking for the mark it already has changes and announces nothing; an unknown video");
      await t.call("videos.setPublished", { videoId, published: true });
      await t.call("videos.setPublished", { videoId, published: true });
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("videos.setPublished", { videoId, published: false });
      await t.call("videos.list", { avatarId: w.avatarId });
      await t.call("videos.setPublished", { videoId, published: true });
      await t.call("videos.setPublished", { videoId: "video-nobody-0404", published: true });
      t.note("«Удалить видео и отклонить фото» on an unknown video rejects nothing");
      await t.call("videos.delete", { videoId: "video-nobody-0404", mode: "video", rejectPhotos: true });
      await t.call("photos.list", { avatarId: w.avatarId });
      t.note("the video's photos are rejected, then the video goes; a published video is deleted like any other");
      await t.call("videos.delete", { videoId, mode: "video", rejectPhotos: true });
      await t.call("photos.list", { avatarId: w.avatarId });
      await t.call("videos.list", { avatarId: w.avatarId });
    },
  },
];

const AUTOPILOT_COMMANDS = ["autopilot.estimate", "autopilot.start", "autopilot.pause", "autopilot.resume", "autopilot.stop", "autopilot.continueAfterReview", "autopilot.list", "autopilot.get", "autopilot.removeUnreadable"];
/** The orchestrator's commands a story uses: the real engine answers them «not implemented yet» until S4.6. */
const orchestrator = (...used: string[]): { until: string; commands: readonly string[] } => ({ until: "S4.6", commands: AUTOPILOT_COMMANDS.filter((c) => used.includes(c)) });

/** The media ids a `media.list` answer holds, newest first. */
function mediaIdsOf(answer: Answer): string[] {
  const media = answer.ok ? answer.result.media : null;
  return Array.isArray(media) ? media.flatMap((item) => (typeof record(item)?.mediaId === "string" ? [String(record(item)?.mediaId)] : [])) : [];
}

/** Served by S4.5d: both engines answer the owner's «для автопилота» flag on an own track the same, line for line. */
const TRACK_FLAG: Scenario[] = [
  {
    name: "autopilot: an own track is flagged for the autopilot and unflagged, the list says so, and a media that is not an own track is refused",
    rig: { ownMedia: true },
    async run(t, _w, control) {
      await control.mediaDialog("track");
      await t.call("media.pickImport", { kind: "audio" });
      await t.settle();
      const [track = "media-00000000"] = mediaIdsOf(await t.call("media.list", { kind: "audio" }));
      t.note("the flag is set, shown by media.list, set again (nothing changes) and cleared; a track never flagged says nothing");
      await t.call("media.setForAutopilot", { mediaId: track, on: true });
      await t.call("media.list", { kind: "audio" });
      await t.call("media.setForAutopilot", { mediaId: track, on: true });
      await t.call("media.setForAutopilot", { mediaId: track, on: false });
      await t.call("media.list", { kind: "audio" });
      t.note("an id the library does not hold, and a photo, are not own tracks");
      await t.call("media.setForAutopilot", { mediaId: "media-nobody-0404", on: true });
      await control.mediaDialog("good");
      await t.call("media.pickImport", { kind: "photo" });
      await t.settle();
      const [photo = "media-00000000"] = mediaIdsOf(await t.call("media.list", { kind: "photo" }));
      await t.call("media.setForAutopilot", { mediaId: photo, on: true });
      t.note("a flagged track that is deleted is gone; flagging it again is NOT_FOUND");
      await t.call("media.setForAutopilot", { mediaId: track, on: true });
      await t.call("media.delete", { mediaId: track });
      await t.call("media.setForAutopilot", { mediaId: track, on: true });
      await t.call("media.list", { kind: "audio" });
    },
  },
];

const PENDING: Scenario[] = [
  {
    name: "autopilot (pending the orchestrator): the preview plans per avatar, library first, and names what blocks it",
    pending: orchestrator("autopilot.estimate"),
    async run(t, w) {
      t.note("the plan: shapes by largest remainder, the library's photos first and the rest new");
      await t.call("autopilot.estimate", { draft: draftOf(w) });
      t.note("without the library every photo is new; without generation the videos the library cannot fill are dropped");
      await t.call("autopilot.estimate", { draft: draftOf(w, { library: false }) });
      await t.call("autopilot.estimate", { draft: draftOf(w, { generate: false }) });
      t.note("a blocker is an answer, not an error: nothing to make; more than 100 new photos for one avatar");
      await t.call("autopilot.estimate", { draft: draftOf(w, { library: false, generate: false }) });
      await t.call("autopilot.estimate", { draft: draftOf(w, { videosPerAvatar: 50, mix: { single: 0, collage: 0, slides: 100 }, library: false }) });
      t.note("an avatar that is not saved and active is not found");
      await t.call("autopilot.estimate", { draft: draftOf(w, { avatarIds: [w.archivedAvatarId] }) });
      await t.call("autopilot.estimate", { draft: draftOf(w, { avatarIds: ["avatar-nobody-0404"] }) });
    },
  },
  {
    name: "autopilot (pending the orchestrator): a start below the engine's worst case is PRICE_CHANGED and free, and one launch is unfinished at a time",
    pending: orchestrator("autopilot.estimate", "autopilot.start", "autopilot.stop"),
    async run(t, w) {
      const draft = draftOf(w, { library: false });
      t.note("an accepted worst case below the plan's: refused, nothing written");
      await t.call("autopilot.start", { draft, acceptedWorstMicros: NOT_ENOUGH });
      t.note("one that covers it starts the launch");
      const launch = launchIdOf(await t.call("autopilot.start", { draft, acceptedWorstMicros: ENOUGH }));
      t.note("a second launch while one is unfinished");
      await t.call("autopilot.start", { draft, acceptedWorstMicros: ENOUGH });
      await t.call("autopilot.estimate", { draft });
      await t.call("autopilot.stop", { launchId: launch });
    },
  },
  {
    name: "autopilot (pending the orchestrator): pause, resume with the remaining worst case, and stop move a launch, and a wrong state is refused",
    pending: orchestrator("autopilot.start", "autopilot.pause", "autopilot.resume", "autopilot.stop", "autopilot.get", "autopilot.list"),
    async run(t, w) {
      const launch = launchIdOf(await t.call("autopilot.start", { draft: draftOf(w, { library: false }), acceptedWorstMicros: ENOUGH }));
      t.note("a launch that runs cannot be resumed");
      await t.call("autopilot.resume", { launchId: launch, acceptedRemainingMicros: ENOUGH });
      await t.call("autopilot.pause", { launchId: launch });
      await t.call("autopilot.pause", { launchId: launch });
      t.note("«Продолжить · до $R»: a sum below the remaining worst case is refused, one that covers it resumes");
      await t.call("autopilot.resume", { launchId: launch, acceptedRemainingMicros: NOT_ENOUGH });
      await t.call("autopilot.resume", { launchId: launch, acceptedRemainingMicros: ENOUGH });
      await t.call("autopilot.stop", { launchId: launch });
      t.note("a stopped launch is over");
      await t.call("autopilot.stop", { launchId: launch });
      await t.call("autopilot.pause", { launchId: launch });
      await t.call("autopilot.get", { launchId: launch });
      await t.call("autopilot.list", {});
    },
  },
  {
    name: "autopilot (pending the orchestrator): the review hand-off draws now, or records the approval while the launch is paused",
    pending: orchestrator("autopilot.start", "autopilot.pause", "autopilot.resume", "autopilot.stop", "autopilot.continueAfterReview"),
    async run(t, w) {
      const started = await t.call("autopilot.start", { draft: draftOf(w, { library: false, sceneReview: true }), acceptedWorstMicros: ENOUGH });
      const launch = launchIdOf(started);
      const row = reviewRowOf(started) ?? { avatarId: w.avatarId, sceneSetId: "set-parity-0001", revision: 1 };
      const call = (over: Record<string, unknown> = {}) => t.call("autopilot.continueAfterReview", { launchId: launch, ...row, ...over });
      t.note("a revision that moved, and a set that is not the one waiting");
      await call({ revision: row.revision + 1 });
      await call({ sceneSetId: "set-parity-9999" });
      t.note("while the launch is paused the approval is only recorded; «Продолжить» starts the draw");
      await t.call("autopilot.pause", { launchId: launch });
      await call();
      await t.call("autopilot.resume", { launchId: launch, acceptedRemainingMicros: ENOUGH });
      t.note("an approval is given once");
      await call();
      await t.call("autopilot.stop", { launchId: launch });
    },
  },
  {
    name: "autopilot (pending the orchestrator): a launch is listed and read, and an unreadable entry that nobody holds is NOT_FOUND",
    pending: orchestrator("autopilot.start", "autopilot.stop", "autopilot.list", "autopilot.get", "autopilot.removeUnreadable"),
    async run(t, w) {
      await t.call("autopilot.list", {});
      await t.call("autopilot.removeUnreadable", { entryId: "0123456789abcdef" });
      const launch = launchIdOf(await t.call("autopilot.start", { draft: draftOf(w, { library: false }), acceptedWorstMicros: ENOUGH }));
      await t.call("autopilot.get", { launchId: launch });
      await t.call("autopilot.get", { launchId: "launch-nobody0404" });
      await t.call("autopilot.list", {});
      await t.call("autopilot.stop", { launchId: launch });
      await t.call("autopilot.list", {});
    },
  },
  {
    name: "autopilot (pending the marks): a video is marked published, an own track for the autopilot, and a delete rejects the photos first",
    // Every command of this story is served since S4.5c and S4.5d, so it is compared engine against mock like any story.
    async run(t, w) {
      const photo = (n: number): string => w.photoIds[n - 1] ?? "";
      const created = await t.call("montages.create", { avatarId: w.avatarId, photoIds: [photo(1), photo(2)] });
      const montageId = created.ok ? String(record(created.result.montage)?.montageId ?? "") : "";
      await t.call("videos.render", { montageId });
      await t.advance("progress");
      await t.advance("saving");
      await t.settle();
      const listed = await t.call("videos.list", { avatarId: w.avatarId });
      const first = listed.ok && Array.isArray(listed.result.videos) ? record(listed.result.videos[0]) : null;
      const videoId = typeof first?.videoId === "string" ? first.videoId : "video-00000001";
      t.note("the owner's mark, set and cleared; an unknown video");
      await t.call("videos.setPublished", { videoId, published: true });
      await t.call("videos.setPublished", { videoId, published: false });
      await t.call("videos.setPublished", { videoId: "video-nobody-0404", published: true });
      t.note("an own track the library does not hold");
      await t.call("media.setForAutopilot", { mediaId: "media-nobody-0404", on: true });
      t.note("«Удалить видео и отклонить фото»: the video's photos are rejected, then the video goes");
      await t.call("videos.delete", { videoId, mode: "video", rejectPhotos: true });
      await t.call("photos.list", { avatarId: w.avatarId });
      await t.call("videos.list", { avatarId: w.avatarId });
    },
  },
];

export const AUTOPILOT_SCENARIOS: readonly Scenario[] = [...PARITY_NOW, ...TRACK_FLAG, ...PENDING];
