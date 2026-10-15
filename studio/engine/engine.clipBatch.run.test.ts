import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClipSummary, type EventMessage } from "../shared/engine";
import { EngineReply } from "./control";
import { openLibrary } from "./library";
import { sequentialIds, steppingClock } from "./library/testing/helpers";
import { IDLE_STEPS } from "./autopilot/steps";
import { JobRegistry } from "./jobs";
import { batchOf, cancelBatch, createBatch, clipJob, jobsOf, mostOpenClipReserves, plainPhotos, seedBatchAvatar } from "./clips/testing/batchKit";
import { clipNetwork, clipsDir, command, create, jobEnd, jobIdOf, listing, phasesOf, startClipEngine, until, type ClipEngine, type VideoScript } from "./clips/testing/engineClipKit";
import { ClipRecord } from "./clips/schemas";
import { SHORT_CLIP_TIMINGS } from "./clips/timings";
import { ledgerLines, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WB2 (plan s5b2 §5.2.2, I5.61-I5.63; §8 «engine B1»): a batch in the real engine, with a fake OpenRouter. The scheduler's own decisions are pinned in clips/batch.test.ts over fake ports;
// what is pinned here is the integration: the ledger a batch writes, the one money unit across the whole engine, the turn against the real price cache and the real library, every stop with the real
// money state machine under it, the 429 requeue, the cancels, and that no hold and no cap outlives the batch on any path.

setDefaultTimeout(60_000);

const dir = useEngineDir("studio-engine-clip-batch-run-");
const libraryDir = () => join(dir(), "library");
const BUDGET = 10_000_000;
const RISK_CONTROL = "task failed with status: FAIL, message: Failure to pass the risk control system";
const MIN = 60_000;

async function started(opts: Parameters<typeof startClipEngine>[1] = {}): Promise<ClipEngine> {
  return startClipEngine(dir(), { monthlyBudgetMicros: BUDGET, deps: { launchSteps: IDLE_STEPS }, ...opts });
}

async function reply(engine: ClipEngine, call: unknown): Promise<EngineReply> {
  await engine.engine.receive(call);
  return EngineReply.parse(engine.posted.at(-1));
}

/** The end of each job, in the order asked; waits for all of them. */
async function endsOf(engine: ClipEngine, jobIds: readonly string[]): Promise<EventMessage[]> {
  const ends: EventMessage[] = [];
  for (const id of jobIds) ends.push(await jobEnd(engine, id));
  return ends;
}

/** The reason a cancelled member's end event gives, or undefined for any other end. */
function detailOf(end: EventMessage | undefined): string | undefined {
  return end?.type === "job.cancelled" && end.payload.kind === "clip" ? end.payload.detail : undefined;
}

const typesOf = (ends: readonly EventMessage[]): string[] => ends.map((end) => end.type);

/** The job a 429 requeued: the one announced for this place in the batch that is not one of the first jobs. Waits until it is announced. */
async function retryOf(engine: ClipEngine, firstJobIds: readonly string[], batchIndex: number): Promise<string> {
  const find = (): string | undefined =>
    engine.events().flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.batchIndex === batchIndex && !firstJobIds.includes(e.payload.jobId) ? [e.payload.jobId] : []))[0];
  await until(() => find() !== undefined, `the retry of member ${batchIndex}`);
  const id = find();
  if (id === undefined) throw new Error("unreachable");
  return id;
}

async function recordOf(avatarId: string, clipId: string): Promise<ClipRecord> {
  return ClipRecord.parse(JSON.parse(await readFile(join(clipsDir(libraryDir(), avatarId), `${clipId}.json`), "utf8")));
}

/** No hold and no cap outlives a batch: the budget holds nothing, and the month's room is the budget less what was spent and what is still open. */
function expectNothingHeld(engine: ClipEngine, openMicros = 0): void {
  const status = engine.engine.budget?.status();
  expect(status?.heldMicros).toBe(0);
  const spent = status?.spentThisMonthMicros ?? 0;
  expect(engine.engine.monthRoom()?.freeMicros).toBe(BUDGET - spent - openMicros);
}

const settledTotal = (): number =>
  ledgerLines(dir())
    .filter((line) => line.type === "settle")
    .reduce((sum, line) => sum + Number(line.costMicros), 0);

const firstHeld = (n: number): VideoScript | undefined => (n === 1 ? { held: true } : undefined);

describe("a batch's money, one member at a time", () => {
  test("writes one reserve and one settle per member, in the pick order, never two members between their reserve and their settle", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started();
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    expect(typesOf(await endsOf(engine, jobIds))).toEqual(["job.done", "job.done", "job.done"]);

    const lines = ledgerLines(dir());
    expect(lines.map((l) => [l.type, l.attemptId])).toEqual(jobIds.flatMap((id) => [["reserve", `${id}:video#1`], ["settle", `${id}:video#1`]]));
    expect(mostOpenClipReserves(lines)).toBe(1);
    expect(engine.net.posts("kling")).toHaveLength(3);
    expect(engine.net.posts("grok")).toHaveLength(0);
    expectNothingHeld(engine);
  });

  test("every member's reserve is its own Kling reserve and settles at the bill, in its own scope", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const engine = await started();
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await endsOf(engine, jobIds);

    const lines = ledgerLines(dir());
    for (const id of jobIds) {
      expect(lines.find((l) => l.type === "reserve" && l.attemptId === `${id}:video#1`)).toMatchObject({ jobId: id, scope: { avatarJobId: id }, worstMicros: 504_000 });
      expect(lines.find((l) => l.type === "settle" && l.attemptId === `${id}:video#1`)).toMatchObject({ costMicros: 420_000, estimated: false });
    }
  });

  test("a member's record carries the batch trio, and the clips list tells it", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started();
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await endsOf(engine, jobIds);

    for (const [i, id] of jobIds.entries()) expect(await recordOf(avatarId, id)).toMatchObject({ batchId, batchIndex: i + 1, batchSize: 3, sourcePhotoId: photoIds[i] });
    const listed = await engine.engine.handle(command("clips.list", { avatarId }));
    if (!listed.ok || listed.type !== "clips.list") throw new Error("no list");
    expect(listed.result.clips.every((clip) => ClipSummary.safeParse(clip).success)).toBe(true);
    expect(listed.result.clips.map((clip) => [clip.batchId, clip.batchIndex, clip.batchSize]).sort()).toEqual([[batchId, 1, 3], [batchId, 2, 3], [batchId, 3, 3]]);
  });

  test("a member refused for free runs Grok inline, before the next member's turn", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const net = clipNetwork({ klingBy: (n) => (n === 1 ? { terminal: { status: "failed", error: RISK_CONTROL } } : undefined) });
    const engine = await started({ net });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    expect(typesOf(await endsOf(engine, jobIds))).toEqual(["job.done", "job.done"]);

    const lines = ledgerLines(dir());
    expect(lines.map((l) => [l.type, l.attemptId, l.type === "reserve" ? l.worstMicros : l.costMicros])).toEqual([
      ["reserve", `${jobIds[0]}:video#1`, 504_000],
      ["settle", `${jobIds[0]}:video#1`, 0],
      ["reserve", `${jobIds[0]}:video#2`, 850_000],
      ["settle", `${jobIds[0]}:video#2`, 420_000],
      ["reserve", `${jobIds[1]}:video#1`, 504_000],
      ["settle", `${jobIds[1]}:video#1`, 420_000],
    ]);
    expect(mostOpenClipReserves(lines)).toBe(1);
    expectNothingHeld(engine);
  });

  test("a frame of «Смелая» is never sent to Grok: its refusal ends the member free", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), [{ category: "nightwear" }, {}]);
    const net = clipNetwork({ klingBy: (n) => (n === 1 ? { terminal: { status: "failed", error: RISK_CONTROL } } : undefined) });
    const engine = await started({ net });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await endsOf(engine, jobIds);

    expect(engine.net.posts("grok")).toHaveLength(0);
    expect((await recordOf(avatarId, jobIds[0] ?? "")).outcome).toMatchObject({ status: "failed", reason: "refused-free" });
    expect(settledTotal()).toBe(420_000);
    expectNothingHeld(engine);
  });

  test("the paid count holds the reconcile at IN_FLIGHT while members are queued, and lets it go when the batch ends", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const engine = await started({ net: clipNetwork({ klingBy: firstHeld }) });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");

    expect(await engine.engine.handle(command("money.reconcile"))).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    engine.net.releaseNth("kling", 1);
    await endsOf(engine, jobIds);
    expect(await engine.engine.handle(command("money.reconcile"))).not.toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
  });
});

describe("the wait for the money to be alone (I5.62)", () => {
  /** The terminal hold of a refusal outlasts the test, and the alone-wait is long enough to be seen but short enough to wait out. */
  const SLOW_HOLD: typeof SHORT_CLIP_TIMINGS = { ...SHORT_CLIP_TIMINGS, holdTerminalMs: 5_000, aloneWaitMs: 400 };
  const alone = (engine: ClipEngine, jobId: string): boolean => engine.events().some((e) => e.type === "job.progress" && e.payload.kind === "clip" && e.payload.jobId === jobId && e.payload.waitReason === "alone");

  test("there is none after a completed clip settled exactly: the next member goes at once, and no `alone` is told", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ timings: SLOW_HOLD });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await endsOf(engine, jobIds);

    for (const id of jobIds) expect(alone(engine, id)).toBe(false);
    expect(engine.net.posts("kling")).toHaveLength(3);
  });

  test("after a refused sibling the next member waits for the money to be alone, up to the bound, then submits; the reconcile stays held meanwhile", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const net = clipNetwork({ klingBy: (n) => (n === 1 ? { terminal: { status: "failed", error: RISK_CONTROL } } : undefined) });
    const engine = await started({ net, timings: SLOW_HOLD });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds, fallback: "none", acceptedWorstMicros: 2 * 504_000 }));

    await until(() => alone(engine, jobIds[1] ?? ""), "member 2 waiting for the money to be alone");
    const told = Date.now();
    expect(engine.net.posts("kling")).toHaveLength(1);
    expect(await engine.engine.handle(command("money.reconcile"))).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect(await clipJob(engine, jobIds[1] ?? "")).toMatchObject({ phase: "queued", waitReason: "alone", batchIndex: 2 });

    await until(() => engine.net.posts("kling").length === 2, "member 2's POST");
    expect(Date.now() - told).toBeGreaterThanOrEqual(SLOW_HOLD.aloneWaitMs - 60);
    expect(typesOf(await endsOf(engine, jobIds))).toEqual(["job.done", "job.done"]);
    expect((await recordOf(avatarId, jobIds[0] ?? "")).outcome).toMatchObject({ status: "failed", reason: "refused-free" });
    expectNothingHeld(engine);
  });
});

describe("one clip money unit across the whole engine (I5.61)", () => {
  test("a single clip is refused `batch-running` while a batch holds the unit, and a batch is refused `one-at-a-time` during a single clip", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ net: clipNetwork({ klingBy: firstHeld }) });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 2) }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");

    expect(await create(engine, { avatarId, photoId: photoIds[2] ?? "" })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "batch-running" } });
    expect(await createBatch(engine, { avatarId, photoIds: photoIds.slice(2) })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "batch-running" } });
    engine.net.releaseNth("kling", 1);
    await endsOf(engine, jobIds);

    const single = jobIdOf(await create(engine, { avatarId, photoId: photoIds[2] ?? "" }));
    expect(await createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 1) })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "one-at-a-time" } });
    await jobEnd(engine, single);
  });

  test("two creates with no await between them make one unit: the other is refused, free, whichever kind it is", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(4));
    const engine = await started();

    const [a, b] = await Promise.all([createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 2) }), createBatch(engine, { avatarId, photoIds: photoIds.slice(2) })]);
    expect([a.ok, b.ok].sort()).toEqual([false, true]);
    const winner = batchOf(a.ok ? a : b);
    await endsOf(engine, winner.jobIds);

    const [c, d] = await Promise.all([create(engine, { avatarId, photoId: photoIds[0] ?? "" }), createBatch(engine, { avatarId, photoIds: photoIds.slice(1, 3) })]);
    expect([c.ok, d.ok].sort()).toEqual([false, true]);
    const second = c.ok ? [jobIdOf(c)] : batchOf(d).jobIds;
    await endsOf(engine, second);
    expect(mostOpenClipReserves(ledgerLines(dir()))).toBe(1);
  });

  test("the unit is held through the whole queue: the single «Оживить» is refused until the last member's money closes, then allowed while its file is still being fetched", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const net = clipNetwork({ kling: { content: "held" } });
    const engine = await started({ net });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 1) }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("downloading"), "the member's download");

    // The money is closed (the file is being fetched): the unit is free again, as it is for a single clip.
    const single = jobIdOf(await create(engine, { avatarId, photoId: photoIds[1] ?? "" }));
    net.releaseContent("kling");
    await endsOf(engine, [...jobIds, single]);
  });

  test("a library switch and an avatar delete wait for a batch, queued members included", async () => {
    const other = join(dir(), "other");
    await mkdir(other, { recursive: true });
    await openLibrary(other, { now: steppingClock(), newId: sequentialIds("other") });
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const engine = await started({ net: clipNetwork({ klingBy: firstHeld }) });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");

    const switched = await reply(engine, { kind: "control", type: "library.open", callId: "call-00000009", path: other });
    expect(switched.error?.code).toBe("IN_FLIGHT");
    expect(switched.error?.detail).toContain("clip");
    const deleted = await reply(engine, { kind: "control", type: "avatar.deletePrepare", callId: "call-00000010", avatarId, token: "token-00000001" });
    expect(deleted.error?.code).toBe("IN_FLIGHT");
    engine.net.releaseNth("kling", 1);
    await endsOf(engine, jobIds);
    expect((await reply(engine, { kind: "control", type: "avatar.deletePrepare", callId: "call-00000011", avatarId, token: "token-00000002" })).error).toBeUndefined();
  });

  test("a batch never claims its avatar: the descriptor can be edited meanwhile", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const engine = await started({ net: clipNetwork({ klingBy: firstHeld }) });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");

    const edited = await engine.engine.handle(command("avatars.editDescriptor", { avatarId, text: "25-year-old European woman, light olive skin, hazel eyes, a small mole on the left cheek.", expectedText: "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair, athletic build, light freckles across the nose." }));
    expect(edited.ok).toBe(true);
    engine.net.releaseNth("kling", 1);
    await endsOf(engine, jobIds);
  });
});

describe("the turn: the photo", () => {
  test("a photo removed from the gallery before its turn ends its member `photo-gone`, free; the batch goes on and no hold or cap is left", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ net: clipNetwork({ klingBy: firstHeld }) });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    await engine.engine.library?.deletePhoto(avatarId, photoIds[1] ?? "");
    engine.net.releaseNth("kling", 1);

    const ends = await endsOf(engine, jobIds);
    expect(typesOf(ends)).toEqual(["job.done", "job.cancelled", "job.done"]);
    expect(detailOf(ends[1])).toBe("photo-gone");
    expect(ledgerLines(dir()).some((l) => String(l.attemptId).startsWith(jobIds[1] ?? "-"))).toBe(false);
    expect(engine.net.posts("kling")).toHaveLength(2);
    expectNothingHeld(engine);
  });

  test("a photo whose file is damaged before its turn ends its member `photo-unreadable`, free; the batch goes on", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ net: clipNetwork({ klingBy: firstHeld }) });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    const file = engine.engine.library?.photoFilePath(photoIds[1] ?? "");
    if (file === undefined) throw new Error("no photo file");
    await writeFile(file, "not the photo any more");
    engine.net.releaseNth("kling", 1);

    const ends = await endsOf(engine, jobIds);
    expect(typesOf(ends)).toEqual(["job.done", "job.cancelled", "job.done"]);
    expect(detailOf(ends[1])).toBe("photo-unreadable");
    expect(engine.net.posts("kling")).toHaveLength(2);
    expectNothingHeld(engine);
  });
});

describe("the turn: the price, read again", () => {
  /** A listing whose Kling std price the test moves; the engine's cache expires after 10 minutes, which `clocks.skew` passes at once. */
  function movingPrice(): { net: ReturnType<typeof clipNetwork>; set: (perSecond: string) => void; drop: (grok: boolean) => void } {
    const state = { perSecond: "0.084", noGrok: false };
    const net = clipNetwork({
      klingBy: firstHeld,
      listing: () => listing({ std: { image_to_video_duration_seconds_720p: state.perSecond, image_to_video_duration_seconds_1080p: state.perSecond }, ...(state.noGrok ? { grok: {} } : {}) }),
    });
    return { net, set: (perSecond) => void (state.perSecond = perSecond), drop: (noGrok) => void (state.noGrok = noGrok) };
  }

  test("a price whose worst case is above a member's share ends it and the queue `price-changed`, free; the member before it is untouched; no hold or cap is left", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const price = movingPrice();
    const engine = await started({ net: price.net });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    price.set("0.2");
    engine.clocks.skew(11 * MIN);
    engine.net.releaseNth("kling", 1);

    const ends = await endsOf(engine, jobIds);
    expect(typesOf(ends)).toEqual(["job.done", "job.cancelled", "job.cancelled"]);
    expect([detailOf(ends[1]), detailOf(ends[2])]).toEqual(["price-changed", "price-changed"]);
    expect(engine.net.posts("kling")).toHaveLength(1);
    expect(ledgerLines(dir()).map((l) => l.type)).toEqual(["reserve", "settle"]);
    expectNothingHeld(engine);
  });

  test("a price that fell goes ahead, and the member reserves at the lower price (its share is only the cap)", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const price = movingPrice();
    const engine = await started({ net: price.net });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    price.set("0.05");
    engine.clocks.skew(11 * MIN);
    engine.net.releaseNth("kling", 1);

    expect(typesOf(await endsOf(engine, jobIds))).toEqual(["job.done", "job.done"]);
    const reserves = ledgerLines(dir()).filter((l) => l.type === "reserve");
    expect(reserves.map((l) => l.worstMicros)).toEqual([504_000, 300_000]);
    expectNothingHeld(engine);
  });

  test("a price that cannot be read ends the queue `price-unavailable`, free, with no hold or cap left", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const price = movingPrice();
    const engine = await started({ net: price.net });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    price.drop(true);
    engine.clocks.skew(11 * MIN);
    engine.net.releaseNth("kling", 1);

    const ends = await endsOf(engine, jobIds);
    expect(typesOf(ends)).toEqual(["job.done", "job.cancelled", "job.cancelled"]);
    expect([detailOf(ends[1]), detailOf(ends[2])]).toEqual(["price-unavailable", "price-unavailable"]);
    expect(engine.net.posts("kling")).toHaveLength(1);
    expectNothingHeld(engine);
  });
});

describe("the stops (I5.62): the rest is cancelled for free, every hold released, every cap cleared", () => {
  test("a bill above a member's reserve halts the ledger: the member is delivered, the queue ends `ledger-stopped`", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const net = clipNetwork({ klingBy: (n) => (n === 1 ? { terminal: { status: "completed", cost: 0.6 } } : undefined) });
    const engine = await started({ net });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));

    const ends = await endsOf(engine, jobIds);
    expect(typesOf(ends)).toEqual(["job.done", "job.cancelled", "job.cancelled"]);
    expect([detailOf(ends[1]), detailOf(ends[2])]).toEqual(["ledger-stopped", "ledger-stopped"]);
    expect((await recordOf(avatarId, jobIds[0] ?? "")).outcome.status).toBe("ready");
    expect(engine.net.posts("kling")).toHaveLength(1);
    expect(engine.engine.budget?.status().state).toBe("halted");
    expect(engine.engine.budget?.status().heldMicros).toBe(0);
  });

  test("an uncertain submit ends the queue `money-uncertain`: the member's reserve stays open at worst, nothing else is spent", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const net = clipNetwork({ klingBy: (n) => (n === 1 ? { submit: { status: 502 } } : undefined) });
    const engine = await started({ net });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));

    const ends = await endsOf(engine, jobIds);
    expect(typesOf(ends)).toEqual(["job.done", "job.cancelled", "job.cancelled"]);
    expect([detailOf(ends[1]), detailOf(ends[2])]).toEqual(["money-uncertain", "money-uncertain"]);
    expect((await recordOf(avatarId, jobIds[0] ?? "")).outcome).toMatchObject({ status: "failed", reason: "submit-uncertain" });
    expect(ledgerLines(dir()).map((l) => l.type)).toEqual(["reserve"]);
    expect(engine.net.posts("kling")).toHaveLength(1);
    expectNothingHeld(engine, 504_000);
  });

  test("a clip that outlives its lifetime goes `late` and ends the queue `money-uncertain` before the later members are spent", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ net: clipNetwork({ klingBy: firstHeld }) });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));

    const ends = await endsOf(engine, jobIds.slice(1));
    expect(typesOf(ends)).toEqual(["job.cancelled", "job.cancelled"]);
    expect([detailOf(ends[0]), detailOf(ends[1])]).toEqual(["money-uncertain", "money-uncertain"]);
    expect(phasesOf(engine, jobIds[0] ?? "")).toContain("late");
    expect(engine.net.posts("kling")).toHaveLength(1);
    expect(ledgerLines(dir()).map((l) => l.type)).toEqual(["reserve"]);
    engine.net.releaseNth("kling", 1);
    await jobEnd(engine, jobIds[0] ?? "");
    expectNothingHeld(engine, 504_000);
  });
});

describe("a 429 at the submit (L11)", () => {
  const rateLimited: VideoScript = { submit: { status: 429, body: { error: { code: 429, message: "Rate limit exceeded" } } } };

  test("requeues the member once at the tail as a new job: the first keeps its free `rate-limited` record, the new one is made", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const net = clipNetwork({ klingBy: (n) => (n === 2 ? rateLimited : undefined) });
    const engine = await started({ net });
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await endsOf(engine, jobIds);

    // The retry is a new job under a new id, queued while the first one still had its record to write.
    const retry = await retryOf(engine, jobIds, 2);
    await jobEnd(engine, retry);

    expect(await recordOf(avatarId, jobIds[1] ?? "")).toMatchObject({ batchId, batchIndex: 2, batchSize: 3, outcome: { status: "failed", reason: "rate-limited" } });
    expect(await recordOf(avatarId, retry ?? "")).toMatchObject({ batchId, batchIndex: 2, batchSize: 3, sourcePhotoId: photoIds[1], outcome: { status: "ready" } });
    // m1, m2 (429, free), m3, then m2's retry: four POSTs, the retry last, one reserve open at a time.
    const lines = ledgerLines(dir());
    expect(lines.filter((l) => l.type === "reserve").map((l) => l.attemptId)).toEqual([`${jobIds[0]}:video#1`, `${jobIds[1]}:video#1`, `${jobIds[2]}:video#1`, `${retry}:video#1`]);
    expect(lines.find((l) => l.type === "settle" && l.attemptId === `${jobIds[1]}:video#1`)?.costMicros).toBe(0);
    expect(mostOpenClipReserves(lines)).toBe(1);
    expectNothingHeld(engine);
  });

  test("the first record's window can see a retry is pending: a job with its place exists before the first member's job ends", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(1));
    const net = clipNetwork({ klingBy: (n) => (n === 1 ? rateLimited : undefined) });
    const engine = await started({ net });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await jobEnd(engine, jobIds[0] ?? "");

    // By the time the first member's job.done was announced, the retry's queued announcement is already in the event stream: it waits for its turn (S5.WB2c), and its turn, inside the pause, then tells the pause.
    const events = engine.events();
    const doneAt = events.findIndex((e) => e.type === "job.done" && e.payload.result.kind === "clip" && e.payload.jobId === jobIds[0]);
    const queuedAt = events.findIndex((e) => e.type === "job.progress" && e.payload.kind === "clip" && e.payload.phase === "queued" && e.payload.batchIndex === 1 && e.payload.jobId !== jobIds[0] && e.payload.waitReason === "turn");
    expect(doneAt).toBeGreaterThan(-1);
    expect(queuedAt).toBeGreaterThan(-1);
    expect(queuedAt).toBeLessThan(doneAt);
    await jobEnd(engine, await retryOf(engine, jobIds, 1));
  });

  test("a second 429 for the same photo is final: two POSTs for it, and the batch ends", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    // m1 completes, m2 gets a 429, and so does its retry.
    const net = clipNetwork({ klingBy: (n) => (n === 2 || n === 3 ? rateLimited : undefined) });
    const engine = await started({ net });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await endsOf(engine, jobIds);
    const retry = await retryOf(engine, jobIds, 2);
    await jobEnd(engine, retry);

    expect(engine.net.posts("kling")).toHaveLength(3);
    expect(await recordOf(avatarId, retry)).toMatchObject({ outcome: { status: "failed", reason: "rate-limited" } });
    expectNothingHeld(engine);
    // The unit is free again.
    const next = batchOf(await createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 1) }));
    expect(next.jobIds).toHaveLength(1);
    await endsOf(engine, next.jobIds);
  });

  test("waits out the pause: the retry's POST comes no sooner than the pause after the 429", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(1));
    const net = clipNetwork({ klingBy: (n) => (n === 1 ? rateLimited : undefined) });
    const engine = await started({ net });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    const before = Date.now();
    await jobEnd(engine, jobIds[0] ?? "");
    const retry = await retryOf(engine, jobIds, 1);
    await until(() => engine.net.posts("kling").length === 2, "the retry's POST");
    expect(Date.now() - before).toBeGreaterThanOrEqual(SHORT_CLIP_TIMINGS.rateLimitPauseMs - 10);
    await jobEnd(engine, retry);
  });
});

describe("cancel (I5.63)", () => {
  test("`clips.cancelBatch` cancels the queued members, free, and says how many; the member in flight is never cancelled", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(4));
    const engine = await started({ net: clipNetwork({ klingBy: firstHeld }) });
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");

    expect(await cancelBatch(engine, avatarId, batchId)).toMatchObject({ ok: true, result: { cancelled: 3 } });
    const cancelled = await endsOf(engine, jobIds.slice(1));
    expect(typesOf(cancelled)).toEqual(["job.cancelled", "job.cancelled", "job.cancelled"]);
    expect(cancelled.map(detailOf)).toEqual(["cancelled", "cancelled", "cancelled"]);
    expect(await cancelBatch(engine, avatarId, batchId)).toMatchObject({ ok: true, result: { cancelled: 0 } });
    engine.net.releaseNth("kling", 1);
    expect((await jobEnd(engine, jobIds[0] ?? "")).type).toBe("job.done");

    expect(engine.net.posts("kling")).toHaveLength(1);
    expectNothingHeld(engine);
    // The unit came back with the last money.
    const next = batchOf(await createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 1) }));
    expect(next.jobIds).toHaveLength(1);
    await endsOf(engine, next.jobIds);
  });

  test("`clips.cancelBatch` after the batch ended answers 0; an unknown batch, or another avatar's, is NOT_FOUND", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(1));
    const other = await seedBatchAvatar(libraryDir(), plainPhotos(1));
    const engine = await started();
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await endsOf(engine, jobIds);

    expect(await cancelBatch(engine, avatarId, batchId)).toMatchObject({ ok: true, result: { cancelled: 0 } });
    expect(await cancelBatch(engine, avatarId, "batch-nope-0001")).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
    expect(await cancelBatch(engine, other.avatarId, batchId)).toMatchObject({ ok: false, error: { code: "NOT_FOUND" } });
  });

  test("`avatars.cancel` on one queued member cancels it alone, free; the member in flight is IN_FLIGHT `submitted` and the others go on", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ net: clipNetwork({ klingBy: firstHeld }) });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");

    expect(await engine.engine.handle(command("avatars.cancel", { jobId: jobIds[0] }))).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "submitted" } });
    expect(await engine.engine.handle(command("avatars.cancel", { jobId: jobIds[1] }))).toMatchObject({ ok: true, result: { jobId: jobIds[1] } });
    engine.net.releaseNth("kling", 1);

    const ends = await endsOf(engine, jobIds);
    expect(typesOf(ends)).toEqual(["job.done", "job.cancelled", "job.done"]);
    expect(detailOf(ends[1])).toBe("cancelled");
    expect(engine.net.posts("kling")).toHaveLength(2);
    expectNothingHeld(engine);
  });

  test("a cancelled member's queued job is listed cancelled with its reason, and its hold is back in the month", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const engine = await started({ net: clipNetwork({ klingBy: firstHeld }) });
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    expect(engine.engine.budget?.status().heldMicros).toBe(850_000);

    await cancelBatch(engine, avatarId, batchId);

    expect(engine.engine.budget?.status().heldMicros).toBe(0);
    expect(await clipJob(engine, jobIds[1] ?? "")).toMatchObject({ status: "cancelled", detail: "cancelled", batchIndex: 2 });
    engine.net.releaseNth("kling", 1);
    await jobEnd(engine, jobIds[0] ?? "");
  });
});

describe("round 2: a cancel is final, a rejected key stops the spending, a failed start leaves nothing", () => {
  const rateLimited: VideoScript = { submit: { status: 429, body: { error: { code: 429, message: "Rate limit exceeded" } } } };

  test("`clips.cancelBatch` while the member in flight is being submitted, then its 429: no new job and exactly one POST", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    let engine: ClipEngine | null = null;
    let batchId = "";
    let cancelled: unknown = null;
    let fired = false;
    const net = clipNetwork({
      klingBy: (n) => (n === 1 ? rateLimited : undefined),
      usage: () => {
        // The first /credits read is member 1's baseline, in `submitting`: the owner presses «Отменить оставшиеся» now.
        const announced = engine?.events().flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.batchId !== undefined ? [e.payload.batchId] : []))[0];
        if (!fired && engine !== null && announced !== undefined) {
          fired = true;
          batchId = announced;
          void cancelBatch(engine, avatarId, announced).then((r) => (cancelled = r));
        }
        return 5;
      },
    });
    engine = await started({ net });
    const created = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => cancelled !== null, "the cancel answer");
    await endsOf(engine, created.jobIds);
    // Time for a requeued member to run past the pause, if one wrongly existed.
    await new Promise((resolve) => setTimeout(resolve, SHORT_CLIP_TIMINGS.rateLimitPauseMs * 6));

    expect(engine.net.posts("kling")).toHaveLength(1);
    expect(ledgerLines(dir()).filter((l) => l.type === "reserve")).toHaveLength(1);
    expect(engine.events().some((e) => e.type === "job.progress" && e.payload.kind === "clip" && !created.jobIds.includes(e.payload.jobId))).toBe(false);
    expectNothingHeld(engine);
  });

  test("a rejected key (401 on a member) fails the later members fast and free: no POST for them, nothing held", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const net = clipNetwork({ klingBy: (n) => (n === 1 ? { submit: { status: 401, body: { error: { code: 401, message: "No auth credentials found" } } } } : undefined) });
    const engine = await started({ net });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));

    const ends = await endsOf(engine, jobIds);
    expect(typesOf(ends)).toEqual(["job.done", "job.failed", "job.failed"]);
    for (const end of ends.slice(1)) expect(end).toMatchObject({ payload: { error: { code: "AUTH_INVALID" } } });
    expect(engine.net.posts("kling")).toHaveLength(1);
    expectNothingHeld(engine);
  });

  test("a start that fails after the jobs were registered leaves no queued job, no hold, no cap, and gives the unit back", async () => {
    class FailingProgress extends JobRegistry {
      override progress(): never {
        throw new Error("boom");
      }
    }
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const engine = await started({ deps: { jobs: new FailingProgress(), launchSteps: IDLE_STEPS } });

    expect(await createBatch(engine, { avatarId, photoIds })).toMatchObject({ ok: false });
    expect((await jobsOf(engine)).filter((j) => j.kind === "clip" && j.status === "running")).toEqual([]);
    expectNothingHeld(engine);
    expect(await engine.engine.handle(command("money.reconcile"))).not.toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    expect(engine.net.posts("kling")).toHaveLength(0);
  });
});
