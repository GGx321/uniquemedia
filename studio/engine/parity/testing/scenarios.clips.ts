import type { MockClipScript } from "../../../renderer/engine/mockClips";
import type { ClipWorld } from "./clipWorld";
import type { Control, World } from "./rigs";
import type { Scenario } from "./scenarios";
import type { Answer, Transcript } from "./transcript";

// Stage 5, 5b.1, S5.V7 (APPENDED; the golden is append-only): «Оживить» told against both engines. A rig with `clips` seeds Lia and a photo of each kind the clip rules tell apart; the real rig plays
// the video provider by a fake that answers each ATTEMPT of a clip by the outcome the story scripts (the same names the mock plays), on the short timing set (`clipTimings("short")`); the mock
// plays the same short set. Money is written as facts (the sums are integer micro-dollars from the same prices; the day and the clock are never written), and the POSTs that left are written as a
// note: «at most one per attempt» is the money story.
//
// A story waits on what it is about: the end of a job (`untilJobEnds`), a phase (`untilPhase`), the end of a hold (`untilMoney`). It never counts settles and never sleeps, so a slow machine tells the
// same story. The restart is not a parity story (the real rig plays no crash restart): it lives in clips/recover.test.ts and mockEngine.clips.restart.test.ts, on the same journal lines.

type Telling = Transcript;

const STD_5 = 850_000;
const KLING_ONLY_5 = 504_000;

function clipsOf(world: World): ClipWorld {
  if (world.clipWorld === undefined) throw new Error("the rig has no clip world: the story needs `rig: { clips: true }`");
  return world.clipWorld;
}

function resultOf(answer: Answer): Record<string, unknown> {
  if (!answer.ok) throw new Error(`the story expected ok, got ${answer.error.code}`);
  return answer.result;
}

function jobIdOf(answer: Answer): string {
  const jobId = resultOf(answer).jobId;
  if (typeof jobId !== "string") throw new Error("expected a job id");
  return jobId;
}

interface Request {
  photoId: string;
  motionId?: string;
  model?: "kling" | "grok";
  quality?: "std" | "pro";
  seconds?: 5 | 10;
  fallback?: "auto" | "none";
  acceptedWorstMicros?: number;
}

function createPayload(w: ClipWorld, request: Request) {
  return {
    avatarId: w.avatarId,
    motionId: "g-blink",
    model: "kling",
    quality: "std",
    seconds: 5,
    fallback: "auto",
    acceptedWorstMicros: STD_5,
    ...request,
  };
}

/** Arms a script, creates a clip, and waits for the end of its job; returns the job's id. */
async function makeClip(t: Telling, w: ClipWorld, control: Control, script: MockClipScript | null, request: Request): Promise<string> {
  if (script !== null) control.clips.next(script);
  const jobId = jobIdOf(await t.call("clips.create", createPayload(w, request)));
  await t.untilJobEnds(jobId);
  return jobId;
}

function posts(t: Telling, control: Control): void {
  t.note(`the POSTs that left: ${control.clips.posts().join(", ") || "none"}`);
}

/** What an export reported, as a fact both engines are bound to: it began at the start, only went forward, and said more than once (its frame counts are not compared). */
function exported(t: Telling, jobId: string): void {
  const progress = t.exportProgress(jobId);
  t.note(`the export reported its progress: began at the start ${progress.began}, only forward ${progress.forward}, more than once ${progress.steps > 1}`);
}

async function list(t: Telling, w: ClipWorld): Promise<void> {
  await t.call("clips.list", { avatarId: w.avatarId });
}

export const CLIP_SCENARIOS: readonly Scenario[] = [
  {
    name: "clips: the sheet tells each photo apart: motions and six prices for a frame with a likeness, no fallback for «Смелая», and a reason for a photo that cannot be brought to life",
    rig: { clips: true },
    async run(t, world) {
      const w = clipsOf(world);
      t.note("an ordinary frame with a likeness: three code motions, the engine's mode, and the month's fit");
      await t.call("clips.options", { avatarId: w.avatarId, photoId: w.photos.plain });
      t.note("a frame of «Смелая»: the worst is Kling's alone (the fallback is none)");
      await t.call("clips.options", { avatarId: w.avatarId, photoId: w.photos.bold });
      t.note("a frame whose face is not known to show, one the gate marked, one the age check refused, a landscape one, one whose file is damaged, and the master");
      for (const kind of ["unknown", "hidden", "aged", "landscape", "unreadable"] as const) await t.call("clips.options", { avatarId: w.avatarId, photoId: w.photos[kind] });
      await t.call("clips.options", { avatarId: w.avatarId, photoId: w.masterPhotoId });
      t.note("a photo the library does not have, and a photo of another avatar");
      await t.call("clips.options", { avatarId: w.avatarId, photoId: "photo-nobody-0001" });
      await t.call("clips.options", { avatarId: w.avatarId, photoId: world.photoIds[0] });
      await t.call("clips.options", { avatarId: "avatar-nobody-0001", photoId: w.photos.plain });
    },
  },
  {
    name: "clips: in mode offer the sheet's worst is Kling's alone and no month fits with a fallback",
    rig: { clips: { mode: "offer" } },
    async run(t, world) {
      const w = clipsOf(world);
      await t.call("clips.options", { avatarId: w.avatarId, photoId: w.photos.plain });
    },
  },
  {
    name: "clips: a frame of «Смелая» is not suitable while BOLD_CLIPS is off",
    rig: { clips: { boldClips: "off" } },
    async run(t, world) {
      const w = clipsOf(world);
      await t.call("clips.options", { avatarId: w.avatarId, photoId: w.photos.bold });
      await t.call("clips.create", createPayload(w, { photoId: w.photos.bold, fallback: "none", acceptedWorstMicros: KLING_ONLY_5 }));
    },
  },
  {
    name: "clips: the month's fit follows the budget, and a create the month cannot take is refused with the figure the sheet showed",
    rig: { clips: { budgetMicros: 849_999 } },
    async run(t, world) {
      const w = clipsOf(world);
      t.note("849 999 µ$ of room: Kling alone fits ($0.504), Kling with Grok behind it ($0.85) does not");
      await t.call("clips.options", { avatarId: w.avatarId, photoId: w.photos.plain });
      await t.call("clips.create", createPayload(w, { photoId: w.photos.plain }));
      t.note("without a fallback it fits");
      const jobId = jobIdOf(await t.call("clips.create", createPayload(w, { photoId: w.photos.plain, fallback: "none", acceptedWorstMicros: KLING_ONLY_5 })));
      await t.untilJobEnds(jobId);
      await list(t, w);
    },
  },
  {
    name: "clips: every refusal of a create is free and comes in the engine's order",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      t.note("a photo or an avatar the library does not have, and another avatar's photo");
      await t.call("clips.create", createPayload(w, { photoId: "photo-nobody-0001" }));
      await t.call("clips.create", { ...createPayload(w, { photoId: w.photos.plain }), avatarId: "avatar-nobody-0001" });
      await t.call("clips.create", createPayload(w, { photoId: world.photoIds[0] ?? "" }));
      t.note("the photo's own reason, one by one");
      for (const kind of ["unknown", "hidden", "aged", "landscape", "unreadable"] as const) await t.call("clips.create", createPayload(w, { photoId: w.photos[kind] }));
      await t.call("clips.create", createPayload(w, { photoId: w.masterPhotoId }));
      t.note("a motion the sheet did not list, and a Grok clip in mode auto");
      await t.call("clips.create", createPayload(w, { photoId: w.photos.plain, motionId: "g-hips" }));
      await t.call("clips.create", createPayload(w, { photoId: w.photos.plain, motionId: "scene" }));
      await t.call("clips.create", createPayload(w, { photoId: w.photos.plain, model: "grok", fallback: "none" }));
      t.note("a price below the worst case: the owner must see the price again");
      await t.call("clips.create", createPayload(w, { photoId: w.photos.plain, acceptedWorstMicros: STD_5 - 1 }));
      t.note("a payload the contract refuses");
      await t.call("clips.create", { ...createPayload(w, { photoId: w.photos.plain }), reveal: true });
      t.note("none of it spent or started anything");
      await list(t, w);
      posts(t, control);
    },
  },
  {
    name: "clips: a listing without Grok's price stops the sheet and the create, and an unreadable listing prices from the dated table",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      control.clips.prices("missing");
      t.note("the listing reads and lacks Grok's price: nothing is guessed");
      await t.call("clips.options", { avatarId: w.avatarId, photoId: w.photos.plain });
      await t.call("clips.create", createPayload(w, { photoId: w.photos.plain }));
      t.note("the listing cannot be read: the table of 2026-10-10 stands in");
      control.clips.prices("fallback");
      await t.call("clips.options", { avatarId: w.avatarId, photoId: w.photos.plain });
      posts(t, control);
    },
  },
  {
    name: "clips: a clip is made: the phases in order, the record ready with its figures, the money settled exactly, and «новый» until it is seen",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      const jobId = await makeClip(t, w, control, null, { photoId: w.photos.plain });
      posts(t, control);
      await list(t, w);
      await t.call("clips.get", { avatarId: w.avatarId, clipId: jobId });
      await t.call("clips.markSeen", { avatarId: w.avatarId, clipId: jobId });
      await t.call("clips.get", { avatarId: w.avatarId, clipId: jobId });
      t.note("the video bills when it completes: the reconcile waits for the hold, and then there is nothing open to close");
      await t.untilMoney("the hold of a completed clip to end", (status) => status.reconcileAvailableAt === undefined);
      await t.call("money.status", {});
      control.clips.passTime(130_000);
      await t.call("money.reconcile", {});
    },
  },
  {
    name: "clips: a pro clip of 10 s is a 1080 x 1920 file of 10 s, billed at its own figure",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      await makeClip(t, w, control, null, { photoId: w.photos.plain, quality: "pro", seconds: 10, acceptedWorstMicros: 1_550_000, motionId: "g-tilt" });
      await list(t, w);
    },
  },
  {
    name: "clips: a face check marks and never decides: a mismatch, too few frames with one face, and a broken worker all keep the clip",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      for (const face of ["mismatch", "few-faces", "worker"] as const) {
        t.note(`the face check says ${face}`);
        await makeClip(t, w, control, { face }, { photoId: w.photos.plain });
      }
      await list(t, w);
    },
  },
  {
    name: "clips: in mode auto a content refusal proven free is followed by Grok by itself, whether Kling refused at the submit or at the poll",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      t.note("a moderation 4xx at the submit: no job exists, nothing is billed, Grok runs");
      await makeClip(t, w, control, "refused-submit", { photoId: w.photos.plain });
      posts(t, control);
      t.note("a content failure at the poll, proven free by /generation's 404 twice and a quiet account: `proving` only there, then Grok");
      await makeClip(t, w, control, "refused-free", { photoId: w.photos.plain });
      posts(t, control);
      await list(t, w);
    },
  },
  {
    name: "clips: Kling and Grok both refuse, both free: the clip ends `refused-both`, and nothing is billed",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      await makeClip(t, w, control, { first: "refused-free", then: "refused-free" }, { photoId: w.photos.plain });
      posts(t, control);
      await list(t, w);
    },
  },
  {
    name: "clips: a refusal that is not proven free stops the clip: billed by /generation, or settled at the worst when the account's usage rose or the check could not count; never Grok",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      t.note("/generation bills the refused job");
      await makeClip(t, w, control, "refused-paid", { photoId: w.photos.plain });
      t.note("the account's usage rose while the job was out");
      await makeClip(t, w, control, "refused-unknown", { photoId: w.photos.plain });
      t.note("the net-usage check could not count (/credits unreadable): NOT free, the worst, no automatic Grok");
      await makeClip(t, w, control, "refused-uncounted", { photoId: w.photos.plain });
      posts(t, control);
      await list(t, w);
    },
  },
  {
    name: "clips: a failure that is not a content refusal goes through the same proof and never to Grok: free, billed, or the worst",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      for (const script of ["provider-error", "provider-error-paid", "provider-error-unknown"] as const) await makeClip(t, w, control, script, { photoId: w.photos.plain });
      posts(t, control);
      await list(t, w);
    },
  },
  {
    name: "clips: a refusal at the submit that is not a content one is free and has its own reason; no Grok",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      for (const script of ["rate-limited", "bad-request", "no-credits"] as const) await makeClip(t, w, control, script, { photoId: w.photos.plain });
      posts(t, control);
      await list(t, w);
      t.note("a 401 marks the stored key rejected: the next create is refused for the key");
      await makeClip(t, w, control, "key-invalid", { photoId: w.photos.plain });
      await t.call("clips.create", createPayload(w, { photoId: w.photos.plain }));
    },
  },
  {
    name: "clips: a frame of «Смелая» runs on Kling alone: a refusal ends free with no Grok, and a choice of no fallback does the same",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      t.note("a frame of «Смелая»: the payload says auto and the clip runs as none");
      await makeClip(t, w, control, "refused-free", { photoId: w.photos.bold, acceptedWorstMicros: KLING_ONLY_5 });
      t.note("an ordinary frame with no fallback chosen");
      await makeClip(t, w, control, "refused-free", { photoId: w.photos.plain, fallback: "none", acceptedWorstMicros: KLING_ONLY_5 });
      posts(t, control);
      await list(t, w);
    },
  },
  {
    name: "clips: in mode offer a refusal proven free offers Grok as a new click at its own price; nothing runs by itself, and the Grok clip never falls back",
    rig: { clips: { mode: "offer" } },
    async run(t, world, control) {
      const w = clipsOf(world);
      await makeClip(t, w, control, "refused-free", { photoId: w.photos.plain, acceptedWorstMicros: KLING_ONLY_5 });
      posts(t, control);
      await list(t, w);
      t.note("the owner takes the offer: a Grok create at its own worst case");
      await makeClip(t, w, control, null, { photoId: w.photos.plain, model: "grok", fallback: "none" });
      t.note("a Grok clip that is refused ends free, with no offer of its own");
      await makeClip(t, w, control, "refused-free", { photoId: w.photos.plain, model: "grok", fallback: "none" });
      t.note("a frame of «Смелая» is never offered Grok");
      await t.call("clips.create", createPayload(w, { photoId: w.photos.bold, model: "grok", fallback: "none" }));
      posts(t, control);
      await list(t, w);
    },
  },
  {
    name: "clips: one paid clip at a time, and no cancel once the POST has left",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      control.clips.hold(true);
      const jobId = jobIdOf(await t.call("clips.create", createPayload(w, { photoId: w.photos.plain })));
      await t.untilPhase(jobId, "rendering");
      t.note("the render is out: a second create is refused whatever else is wrong with it, a cancel is refused, and the reconcile waits");
      await t.call("clips.create", createPayload(w, { photoId: w.photos.plain }));
      await t.call("clips.create", createPayload(w, { photoId: w.masterPhotoId, acceptedWorstMicros: 1 }));
      await t.call("avatars.cancel", { jobId });
      await t.call("money.reconcile", {});
      control.clips.hold(false);
      await t.untilJobEnds(jobId);
      posts(t, control);
      await list(t, w);
    },
  },
  {
    name: "clips: a submit with no answer ends the clip at once with its reserve open, held for the reconcile; the hold ends, and the owner's reconcile settles it at the worst",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      const jobId = await makeClip(t, w, control, "uncertain", { photoId: w.photos.plain });
      t.note("the clip ended; its attempt may still bill: the money says so, and the reconcile waits");
      await t.call("money.status", {});
      await t.call("money.reconcile", {});
      await t.call("clips.get", { avatarId: w.avatarId, clipId: jobId });
      t.note("the hold ends (nothing is written to the ledger by it): the same reserve is now a reason to reconcile");
      await t.untilMoney("the hold of an uncertain submit to end", (status) => status.reconcileAvailableAt === undefined && status.reconcileNeeded === true);
      await t.call("money.status", {});
      control.clips.passTime(130_000);
      await t.call("money.reconcile", {});
      await t.call("clips.get", { avatarId: w.avatarId, clipId: jobId });
      posts(t, control);
    },
  },
  {
    name: "clips: a clip that does not come in its lifetime goes `late`: the job stays live, the reserve is open, and a late file is fetched without a ledger line",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      control.clips.next("late-ok");
      const jobId = jobIdOf(await t.call("clips.create", createPayload(w, { photoId: w.photos.plain })));
      await t.untilPhase(jobId, "late");
      t.note("the clip has not come: no record yet, the reserve is open and held");
      await list(t, w);
      control.clips.arrive();
      await t.untilJobEnds(jobId);
      t.note("it came: ready, its cost the open reserve until the reconcile, the provider's number for information");
      await list(t, w);
      await t.untilMoney("the late clip's hold to end", (status) => status.reconcileAvailableAt === undefined);
      control.clips.passTime(130_000);
      await t.call("money.reconcile", {});
      await list(t, w);
    },
  },
  {
    name: "clips: a clip that never comes ends `late` with its reserve open",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      await makeClip(t, w, control, "late", { photoId: w.photos.plain });
      await list(t, w);
    },
  },
  {
    name: "clips: a paid clip whose file could not be fetched is fetched again for free, and an expired or failed retry leaves the record as it was",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      const clipId = await makeClip(t, w, control, "download-failed", { photoId: w.photos.plain });
      await list(t, w);
      t.note("the provider does not have the file yet: the retry fails and the clip stays as it was");
      control.clips.fileBack(false);
      const failed = jobIdOf(await t.call("clips.retryDownload", { avatarId: w.avatarId, clipId }));
      await t.untilJobEnds(failed);
      await t.call("clips.get", { avatarId: w.avatarId, clipId });
      t.note("the file is back: the same record becomes ready, the money untouched");
      control.clips.fileBack(true);
      const fetched = jobIdOf(await t.call("clips.retryDownload", { avatarId: w.avatarId, clipId }));
      await t.untilJobEnds(fetched);
      await t.call("clips.get", { avatarId: w.avatarId, clipId });
      t.note("a clip that is ready has no file to fetch");
      await t.call("clips.retryDownload", { avatarId: w.avatarId, clipId });
      posts(t, control);
    },
  },
  {
    name: "clips: a file that is not a video is a paid failure too, and the clip can be fetched again",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      const clipId = await makeClip(t, w, control, "invalid-file", { photoId: w.photos.plain });
      await t.call("clips.get", { avatarId: w.avatarId, clipId });
      control.clips.fileBack(true);
      await t.untilJobEnds(jobIdOf(await t.call("clips.retryDownload", { avatarId: w.avatarId, clipId })));
      await t.call("clips.get", { avatarId: w.avatarId, clipId });
    },
  },
  {
    name: "clips: a clip is deleted with its record, and a second delete finds nothing",
    rig: { clips: true },
    async run(t, world, control) {
      const w = clipsOf(world);
      const clipId = await makeClip(t, w, control, null, { photoId: w.photos.plain });
      await t.call("clips.delete", { avatarId: w.avatarId, clipId });
      await list(t, w);
      await t.call("clips.delete", { avatarId: w.avatarId, clipId });
      await t.call("clips.get", { avatarId: w.avatarId, clipId });
      await t.call("clips.markSeen", { avatarId: w.avatarId, clipId });
    },
  },
  {
    name: "clips: «Сохранить в папку» is an export job with progress that names its copy `<date>_clip_<NNN>.mp4`; clips.get then shows the copy present, and a second export is the next number",
    rig: { clips: { exportFps: "duplicate" } },
    async run(t, world, control) {
      const w = clipsOf(world);
      const clipId = await makeClip(t, w, control, null, { photoId: w.photos.plain });
      const first = jobIdOf(await t.call("clips.export", { avatarId: w.avatarId, clipId }));
      await t.untilJobEnds(first);
      exported(t, first);
      await t.call("clips.get", { avatarId: w.avatarId, clipId });
      const second = jobIdOf(await t.call("clips.export", { avatarId: w.avatarId, clipId }));
      await t.untilJobEnds(second);
      exported(t, second);
      await t.call("clips.get", { avatarId: w.avatarId, clipId });
      t.note("a clip that failed has no file to save");
      const failed = await makeClip(t, w, control, "rate-limited", { photoId: w.photos.plain });
      await t.call("clips.export", { avatarId: w.avatarId, clipId: failed });
      await t.call("clips.export", { avatarId: w.avatarId, clipId: "job-nobody-0001" });
    },
  },
  {
    name: "clips: the export folder decides the export: unplugged, or too small for the clip",
    rig: { clips: { exportFps: "duplicate" } },
    async run(t, world, control) {
      const w = clipsOf(world);
      const clipId = await makeClip(t, w, control, null, { photoId: w.photos.plain });
      t.note("the folder is gone");
      await control.exportFolder("away");
      await t.call("clips.export", { avatarId: w.avatarId, clipId });
      await control.exportFolder("back");
      t.note("the volume has too little room (twice the expected size and the margin is asked)");
      control.freeSpace(100 * 1024 * 1024);
      await t.call("clips.export", { avatarId: w.avatarId, clipId });
      control.freeSpace(null);
      t.note("room again: the export goes through");
      const jobId = jobIdOf(await t.call("clips.export", { avatarId: w.avatarId, clipId }));
      await t.untilJobEnds(jobId);
      await t.call("clips.get", { avatarId: w.avatarId, clipId });
    },
  },
  {
    name: "clips: exports are saved one at a time in the order asked, and a pick of another export folder is refused while any of them is queued or running",
    rig: { clips: { exportFps: "duplicate" } },
    async run(t, world, control) {
      const w = clipsOf(world);
      const clips: string[] = [];
      for (let i = 0; i < 3; i++) clips.push(await makeClip(t, w, control, null, { photoId: w.photos.plain }));
      const jobs: string[] = [];
      for (const clipId of clips) jobs.push(jobIdOf(await t.call("clips.export", { avatarId: w.avatarId, clipId })));
      t.note("three exports are out: one runs, the others wait their turn; the folder cannot be changed under them, and the same clip is not saved twice at once");
      await control.exportDialog("fresh");
      await t.call("settings.setExportPath", {});
      await t.call("clips.export", { avatarId: w.avatarId, clipId: clips[0] ?? "" });
      for (const jobId of jobs) await t.untilJobEnds(jobId);
      t.note("the copies are numbered in the order asked");
      for (const clipId of clips) await t.call("clips.get", { avatarId: w.avatarId, clipId });
    },
  },
];
