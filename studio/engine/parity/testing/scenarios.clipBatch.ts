import type { MockClipScript } from "../../../renderer/engine/mockClips";
import type { ClipWorld } from "./clipWorld";
import type { Control, World } from "./rigs";
import type { Scenario } from "./scenarios";
import type { Answer, Transcript } from "./transcript";

// Stage 5, 5b.2, S5.WB3 (APPENDED; the golden is append-only): the batch «Оживить выбранные» told against both engines, on the rig the clip stories use (the fake provider, the short timing set) with `batch` more
// ordinary frames for Lia. A story plays one script per member (`ClipControl.nextBatch`), waits on EVENTS (a phase of a member's job, the batch's end), never on a sleep or a count of settles, and tells the
// queue per member (`Transcript.members`): which phases each went through and how each ended. The waits between members depend on whether the money is alone at that moment; they are held by the engine's and
// the mock's own suites, on a clock they control (transcript.ts, INTENTIONAL_DIFFERENCES).
//
// The restart is not a parity story (the real rig plays no crash restart): engine.clipBatch.restart.test.ts and mockEngine.clipBatch.run.test.ts hold it on the same journal lines.

type Telling = Transcript;

const STD_5 = 850_000;
const KLING_ONLY_5 = 504_000;
const BUDGET = 10_000_000;
const MIN = 60_000;

const RIG = { clips: { batch: 4, budgetMicros: BUDGET } } as const;

function clipsOf(world: World): ClipWorld {
  if (world.clipWorld === undefined) throw new Error("the rig has no clip world: the story needs `rig: { clips: ... }`");
  return world.clipWorld;
}

function resultOf(answer: Answer): Record<string, unknown> {
  if (!answer.ok) throw new Error(`the story expected ok, got ${answer.error.code}`);
  return answer.result;
}

/** The answer of a `clips.createBatch`: the batch's id and its members' job ids, in the pick order. */
function batchAnswer(answer: Answer): { batchId: string; jobIds: string[] } {
  const result = resultOf(answer);
  const jobIds = Array.isArray(result.jobIds) ? result.jobIds.filter((id): id is string => typeof id === "string") : [];
  if (typeof result.batchId !== "string") throw new Error("expected a batch id");
  return { batchId: result.batchId, jobIds };
}

/** Ordinary frames of Lia, in a fixed order: her one `plain` photo, then the rig's extra ones. */
function frames(w: ClipWorld, n: number): string[] {
  return [w.photos.plain, ...(w.batch ?? [])].slice(0, n);
}

interface Batch {
  photoIds: readonly string[];
  motionIds?: Readonly<Record<number, string>>;
  quality?: "std" | "pro";
  seconds?: 5 | 10;
  fallback?: "auto" | "none";
  acceptedWorstMicros?: number;
}

function createPayload(w: ClipWorld, batch: Batch) {
  return {
    avatarId: w.avatarId,
    items: batch.photoIds.map((photoId, i) => ({ photoId, motionId: batch.motionIds?.[i] ?? "g-blink" })),
    quality: batch.quality ?? "std",
    seconds: batch.seconds ?? 5,
    fallback: batch.fallback ?? "auto",
    acceptedWorstMicros: batch.acceptedWorstMicros ?? batch.photoIds.length * STD_5,
  };
}

/**
 * A `clips.create` that breaks the first rule it meets after the unit (the master is no gallery photo), so it is refused IN_FLIGHT while a batch or a clip holds the unit and by its own fault, free, once the unit
 * is free. Since part C (S5.WC3) it may also answer `motion-busy` while a vision or translator call runs; the transcript reads that as «not held» (a part C call and a clip unit exclude each other), and no parity story runs a part C call. (Not a `clips.createBatch`: since WB2d a batch is also refused while a clip's money stays open, an uncertain member's reserve for one, which says nothing of the unit.)
 */
function probe(w: ClipWorld): unknown {
  return { avatarId: w.avatarId, photoId: w.masterPhotoId, motionId: "g-blink", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: STD_5 };
}

function posts(t: Telling, control: Control): void {
  t.note(`the POSTs that left: ${control.clips.posts().join(", ") || "none"}`);
}

async function list(t: Telling, w: ClipWorld): Promise<void> {
  await t.call("clips.list", { avatarId: w.avatarId });
}

/** Creates a batch, lets it run to its end, and tells its queue and its clips. */
async function runBatch(t: Telling, w: ClipWorld, control: Control, scripts: readonly MockClipScript[], batch: Batch): Promise<{ batchId: string; jobIds: string[] }> {
  control.clips.nextBatch(scripts);
  const started = batchAnswer(await t.call("clips.createBatch", createPayload(w, batch)));
  await t.untilBatchEnds(probe(w));
  t.members();
  posts(t, control);
  await list(t, w);
  return started;
}

export const CLIP_BATCH_SCENARIOS: readonly Scenario[] = [
  {
    name: "clip batch: the sheet tells each photo and the sums, the month's room and what fits; a photo that cannot be made is told with its reason",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      const [a, b, c] = frames(w, 3);
      t.note("three ordinary frames, one of «Смелая», the master, a landscape frame and a photo the library does not have");
      await t.call("clips.batchOptions", { avatarId: w.avatarId, photoIds: [a, b, c, w.photos.bold, w.masterPhotoId, w.photos.landscape, "photo-nobody-0001"] });
      t.note("only «Смелая» frames: Kling's alone, so the worst case and the worst case without a fallback are one figure");
      await t.call("clips.batchOptions", { avatarId: w.avatarId, photoIds: [w.photos.bold] });
      t.note("no photo of the batch can be made: no sum, and nothing fits");
      await t.call("clips.batchOptions", { avatarId: w.avatarId, photoIds: [w.masterPhotoId, w.photos.landscape] });
      t.note("an avatar the library does not have");
      await t.call("clips.batchOptions", { avatarId: "avatar-nobody-0001", photoIds: [a] });
      t.note("a listing that lacks a price, once the price cache (10 minutes) has run out");
      control.clips.prices("missing");
      control.clips.passTime(11 * MIN);
      await t.call("clips.batchOptions", { avatarId: w.avatarId, photoIds: [a, b] });
    },
  },
  {
    name: "clip batch: every refusal of a create is free and comes in the engine's order, with the item's own reason and its place",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      const [a, b, c] = frames(w, 3);
      t.note("an avatar the library does not have");
      await t.call("clips.createBatch", { ...createPayload(w, { photoIds: [a] }), avatarId: "avatar-nobody-0001" });
      t.note("the item's own reason, the lowest item first: a photo the library does not have, the master, an age that was not verified, a landscape frame, a damaged file, a frame the gate marked");
      await t.call("clips.createBatch", createPayload(w, { photoIds: [a, "photo-nobody-0001", w.photos.aged] }));
      await t.call("clips.createBatch", createPayload(w, { photoIds: [a, b, w.masterPhotoId] }));
      await t.call("clips.createBatch", createPayload(w, { photoIds: [a, w.photos.aged] }));
      await t.call("clips.createBatch", createPayload(w, { photoIds: [w.photos.landscape, a] }));
      await t.call("clips.createBatch", createPayload(w, { photoIds: [a, w.photos.unreadable] }));
      await t.call("clips.createBatch", createPayload(w, { photoIds: [w.photos.hidden, a] }));
      await t.call("clips.createBatch", createPayload(w, { photoIds: [a, w.photos.unknown] }));
      t.note("a motion the sheet did not list, told before the refused photo of a later item");
      await t.call("clips.createBatch", createPayload(w, { photoIds: [a, b, w.photos.aged], motionIds: { 1: "g-hips" } }));
      t.note("the sum is one micro-dollar below the batch's worst case: the owner must see the price again");
      await t.call("clips.createBatch", createPayload(w, { photoIds: [a, b, c], acceptedWorstMicros: 3 * STD_5 - 1 }));
      t.note("a «Смелая» member is Kling's alone: the sum is the sum of the shares");
      await t.call("clips.createBatch", createPayload(w, { photoIds: [a, w.photos.bold], acceptedWorstMicros: STD_5 + KLING_ONLY_5 - 1 }));
      t.note("a listing that lacks a price, once the price cache (10 minutes) has run out");
      control.clips.prices("missing");
      control.clips.passTime(11 * MIN);
      await t.call("clips.createBatch", createPayload(w, { photoIds: [a, b] }));
      t.note("a payload the contract refuses: a photo twice");
      await t.call("clips.createBatch", createPayload(w, { photoIds: [a, a] }));
      t.note("none of it spent or started anything");
      await list(t, w);
      posts(t, control);
    },
  },
  {
    name: "clip batch: the month holds a batch whole or not at all: one micro-dollar short is refused free, the exact room is taken, and a batch without a fallback fits where one with it does not",
    rig: { clips: { batch: 4, budgetMicros: 3 * STD_5 - 1 } },
    async run(t, world, control) {
      const w = clipsOf(world);
      const photoIds = frames(w, 3);
      t.note("2 549 999 µ$ of room: three clips with Grok behind them need 2 550 000, on Kling alone 1 512 000");
      await t.call("clips.batchOptions", { avatarId: w.avatarId, photoIds });
      await t.call("clips.createBatch", createPayload(w, { photoIds }));
      t.note("nothing was held: a second batch is taken at once, without a fallback");
      await runBatch(t, w, control, [], { photoIds, fallback: "none", acceptedWorstMicros: 3 * KLING_ONLY_5 });
      await t.untilMoney("the holds of the completed clips to end", (status) => status.reconcileAvailableAt === undefined);
      await t.call("money.status", {});
    },
  },
  {
    name: "clip batch: a clean batch is made one clip at a time, each member a record with its place in the batch, and the money settled exactly",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      const photoIds = frames(w, 3);
      t.note("the sheet is free; the owner accepts the sum");
      await t.call("clips.batchOptions", { avatarId: w.avatarId, photoIds });
      const { batchId } = await runBatch(t, w, control, [], { photoIds });
      t.note("the batch is over: a cancel finds nothing queued, and an unknown batch is not found");
      await t.call("clips.cancelBatch", { avatarId: w.avatarId, batchId });
      await t.call("clips.cancelBatch", { avatarId: w.avatarId, batchId: "batch-nobody-0001" });
      t.note("the video bills when it completes: the reconcile waits for the holds, and then there is nothing open to close");
      await t.untilMoney("the holds of the completed clips to end", (status) => status.reconcileAvailableAt === undefined);
      await t.call("money.status", {});
      control.clips.passTime(130_000);
      await t.call("money.reconcile", {});
    },
  },
  {
    name: "clip batch: one clip money unit at a time: a single clip or a second batch is refused while a batch holds the unit, and a batch is refused during a single clip",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      const [a, b, c] = frames(w, 3);
      control.clips.hold(true);
      const { jobIds } = batchAnswer(await t.call("clips.createBatch", createPayload(w, { photoIds: [a, b] })));
      await t.untilPhase(jobIds[0] ?? "", "rendering");
      t.note("the first member is out and the second waits: the unit is held through the whole queue");
      const single = { avatarId: w.avatarId, photoId: c, motionId: "g-blink", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: STD_5 };
      await t.call("clips.create", single);
      await t.call("clips.createBatch", createPayload(w, { photoIds: [c] }));
      await t.call("money.reconcile", {});
      control.clips.hold(false);
      await t.untilBatchEnds(probe(w));
      t.members();
      t.note("the last member's money is closed: a single clip is taken, and a batch is refused during it");
      const created = await t.call("clips.create", single);
      await t.call("clips.createBatch", createPayload(w, { photoIds: [a] }));
      const jobId = resultOf(created).jobId;
      if (typeof jobId !== "string") throw new Error("expected a job id");
      await t.untilJobEnds(jobId);
      posts(t, control);
    },
  },
  {
    name: "clip batch: a member refused for free is made on Grok before the next member's turn, and the batch goes on",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      await runBatch(t, w, control, [{ first: "refused-free" }, "ok", "ok"], { photoIds: frames(w, 3) });
    },
  },
  {
    name: "clip batch: a member refused at the submit by moderation is made on Grok too, and Grok's own refusal ends the member free (refused-both)",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      await runBatch(t, w, control, ["refused-submit", { first: "refused-free", then: "refused-free" }, "ok"], { photoIds: frames(w, 3) });
    },
  },
  {
    name: "clip batch: a «Смелая» member is Kling's alone: a refusal ends it free, with no Grok, and the batch goes on",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      const [a] = frames(w, 1);
      await runBatch(t, w, control, [{ first: "refused-free" }, "ok"], { photoIds: [w.photos.bold, a], acceptedWorstMicros: KLING_ONLY_5 + STD_5 });
    },
  },
  {
    name: "clip batch: a price that rose before a member's turn stops the queue, free: the member before it is untouched, and nothing is held",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      const photoIds = frames(w, 3);
      control.clips.holdSubmit(true);
      control.clips.nextBatch([]);
      const { jobIds } = batchAnswer(await t.call("clips.createBatch", createPayload(w, { photoIds })));
      await t.untilPhase(jobIds[0] ?? "", "submitting");
      t.note("the listing's Kling rate more than doubles, and the owner is away longer than the price cache lives");
      control.clips.klingRate(200_000);
      control.clips.passTime(11 * MIN);
      control.clips.holdSubmit(false);
      await t.untilBatchEnds(probe(w));
      t.members();
      posts(t, control);
      await list(t, w);
    },
  },
  {
    name: "clip batch: a price that cannot be read at a member's turn stops the queue, free (price-unavailable)",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      const photoIds = frames(w, 3);
      control.clips.holdSubmit(true);
      const { jobIds } = batchAnswer(await t.call("clips.createBatch", createPayload(w, { photoIds })));
      await t.untilPhase(jobIds[0] ?? "", "submitting");
      t.note("the listing reads and lacks a price, and the price cache has run out");
      control.clips.prices("missing");
      control.clips.passTime(11 * MIN);
      control.clips.holdSubmit(false);
      await t.untilBatchEnds(probe(w));
      t.members();
      posts(t, control);
      await list(t, w);
    },
  },
  {
    name: "clip batch: a cancel in the middle cancels the queue for free and says how many; the member in flight finishes, and a cancel of the batch that ended finds nothing",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      control.clips.hold(true);
      const { batchId, jobIds } = batchAnswer(await t.call("clips.createBatch", createPayload(w, { photoIds: frames(w, 4) })));
      await t.untilPhase(jobIds[0] ?? "", "rendering");
      t.note("the first member is out; the owner cancels the rest, and a member in flight cannot be cancelled");
      await t.call("avatars.cancel", { jobId: jobIds[0] });
      await t.call("clips.cancelBatch", { avatarId: w.avatarId, batchId });
      await t.call("clips.cancelBatch", { avatarId: w.avatarId, batchId });
      control.clips.hold(false);
      await t.untilBatchEnds(probe(w));
      t.members();
      await t.call("clips.cancelBatch", { avatarId: w.avatarId, batchId });
      posts(t, control);
      await list(t, w);
    },
  },
  {
    name: "clip batch: one queued member is cancelled alone, free, and the others go on",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      control.clips.hold(true);
      const { jobIds } = batchAnswer(await t.call("clips.createBatch", createPayload(w, { photoIds: frames(w, 3) })));
      await t.untilPhase(jobIds[0] ?? "", "rendering");
      await t.call("avatars.cancel", { jobId: jobIds[1] });
      control.clips.hold(false);
      await t.untilBatchEnds(probe(w));
      t.members();
      posts(t, control);
      await list(t, w);
    },
  },
  {
    name: "clip batch: a cancel is final: the 429 of the member being submitted, after the cancel, requeues nothing and sends nothing more",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      control.clips.holdSubmit(true);
      control.clips.nextBatch(["rate-limited", "ok", "ok"]);
      const { batchId, jobIds } = batchAnswer(await t.call("clips.createBatch", createPayload(w, { photoIds: frames(w, 3) })));
      await t.untilPhase(jobIds[0] ?? "", "submitting");
      t.note("the first member's POST is out and unanswered; the owner cancels the queue; then the provider answers 429");
      await t.call("clips.cancelBatch", { avatarId: w.avatarId, batchId });
      control.clips.holdSubmit(false);
      await t.untilBatchEnds(probe(w));
      t.members();
      posts(t, control);
      await list(t, w);
    },
  },
  {
    name: "clip batch: a 429 at the submit is free and requeues the member once at the tail as a new job; the first keeps its free record",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      await runBatch(t, w, control, ["ok", "rate-limited", "ok", "ok"], { photoIds: frames(w, 3) });
    },
  },
  {
    name: "clip batch: a second 429 for the same photo is final: two POSTs for it, and the batch ends",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      await runBatch(t, w, control, ["ok", "rate-limited", "rate-limited"], { photoIds: frames(w, 2) });
    },
  },
  {
    name: "clip batch: a photo removed from the gallery, or damaged, before its turn ends its member, free; the batch goes on",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      const batchPhotos = w.batch ?? [];
      control.clips.hold(true);
      const photoIds = [w.photos.plain, batchPhotos[0] ?? "", batchPhotos[1] ?? "", batchPhotos[2] ?? ""];
      const { jobIds } = batchAnswer(await t.call("clips.createBatch", createPayload(w, { photoIds })));
      await t.untilPhase(jobIds[0] ?? "", "rendering");
      t.note("the owner deletes the second photo and damages the third while the first member is out");
      await control.clips.removePhoto(photoIds[1] ?? "");
      await control.clips.damagePhoto(photoIds[2] ?? "");
      control.clips.hold(false);
      await t.untilBatchEnds(probe(w));
      t.members();
      posts(t, control);
      await list(t, w);
    },
  },
  {
    name: "clip batch: a rejected key (401 on a member) fails the later members fast and free, with no POST for them",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      await runBatch(t, w, control, ["key-invalid"], { photoIds: frames(w, 3) });
      t.note("the stored key is marked rejected: the next batch is refused for the key");
      await t.call("clips.createBatch", createPayload(w, { photoIds: frames(w, 1) }));
    },
  },
  {
    name: "clip batch: an uncertain submit ends the queue (money-uncertain): the member's reserve stays open at its worst, and nothing else is spent",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      control.clips.nextBatch(["uncertain"]);
      await t.call("clips.createBatch", createPayload(w, { photoIds: frames(w, 3) }));
      await t.untilBatchEnds(probe(w));
      t.note("the clip ended; its attempt may still bill: the money says so, and the reconcile waits");
      await t.call("money.status", {});
      await t.call("money.reconcile", {});
      t.members();
      posts(t, control);
      await list(t, w);
    },
  },
  {
    name: "price cache: a single clip reads the book the sheet read, within 10 minutes, whatever the listing says now; once the cache has run out the new price is PRICE_CHANGED",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      const single = { avatarId: w.avatarId, photoId: w.photos.plain, motionId: "g-blink", model: "kling", quality: "std", seconds: 5, fallback: "auto", acceptedWorstMicros: STD_5 };
      await t.call("clips.options", { avatarId: w.avatarId, photoId: w.photos.plain });
      t.note("the listing's Kling rate more than doubles; the cache still holds the book the sheet read");
      control.clips.klingRate(200_000);
      const created = await t.call("clips.create", single);
      const jobId = resultOf(created).jobId;
      if (typeof jobId !== "string") throw new Error("expected a job id");
      await t.untilJobEnds(jobId);
      t.note("the owner is away longer than the cache lives: the engine reads the listing again");
      control.clips.passTime(11 * MIN);
      await t.call("clips.create", single);
      await t.call("clips.options", { avatarId: w.avatarId, photoId: w.photos.plain });
      posts(t, control);
    },
  },
  {
    name: "price cache: a single clip's sheet and a batch's sheet are one book: the listing that moved is seen by both at once, or by neither",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      await t.call("clips.options", { avatarId: w.avatarId, photoId: w.photos.plain });
      control.clips.klingRate(200_000);
      t.note("within the cache's life the batch's sheet is priced by the book the single clip's sheet read");
      await t.call("clips.batchOptions", { avatarId: w.avatarId, photoIds: [w.photos.plain] });
      control.clips.passTime(11 * MIN);
      t.note("past it the new rate is read by the batch's sheet and the single clip's alike");
      await t.call("clips.batchOptions", { avatarId: w.avatarId, photoIds: [w.photos.plain] });
      await t.call("clips.options", { avatarId: w.avatarId, photoId: w.photos.plain });
    },
  },
  {
    name: "clip batch: a member that never comes goes late and ends the queue (money-uncertain) before the later members are spent",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      await runBatch(t, w, control, ["late"], { photoIds: frames(w, 3) });
    },
  },
  // 5b.2, S5.WB2c (APPENDED): the batch's own summary, written by the engine. The «Клипы» header reads it, never the records: a clip the owner deleted is not a member that was dropped unshot, and its cost
  // stays in the batch's total. The restart here is a quit and a new start with no clip in flight (`ClipControl.restart`), so no recovery runs; the crash restart stays in the engines' own suites.
  {
    name: "clip batch: the engine's summary of a batch tells each member and its money; a batch clip the owner deletes, then a restart, leave it as it was",
    rig: RIG,
    async run(t, world, control) {
      const w = clipsOf(world);
      const { jobIds } = await runBatch(t, w, control, [], { photoIds: frames(w, 3) });
      t.note("the batch's own summary: three clips made at $0.42 each, the batch $1.26, billed");
      await t.callBatches(w.avatarId);
      t.note("the owner deletes the second clip: it leaves the list, and its member stays made, its cost in the batch's total");
      await t.call("clips.delete", { avatarId: w.avatarId, clipId: jobIds[1] });
      await t.callBatches(w.avatarId);
      t.note("Studio is quit and opened again: the summary is as it was, and no member reads as not made");
      await control.clips.restart();
      await t.callBatches(w.avatarId);
    },
  },
];
