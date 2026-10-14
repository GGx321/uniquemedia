import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { ClipBatchOptions, ResponseMessage, clipBatchExpectedMicros, clipBatchWorstMicros, type ClipPrices, type EngineError } from "../shared/engine";
import { batchOf, batchOptions, createBatch, clipJob, jobsOf, plainPhotos, seedBatchAvatar } from "./clips/testing/batchKit";
import { clipNetwork, clipsDir, command, jobEnd, listing, phasesOf, startClipEngine, until, type ClipEngine } from "./clips/testing/engineClipKit";
import { ledgerLines, useEngineDir, writeLedger } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.2, S5.WB2 (plan s5b2 §5.2.1, I5.62; WB1's review items): `clips.batchOptions` and `clips.createBatch` in the real engine. Every refusal of `clips.createBatch` is free, comes before any
// reserve or journal, and leaves nothing behind: no month hold, no cap, no job, no claimed unit.

setDefaultTimeout(60_000);

const dir = useEngineDir("studio-engine-clip-batch-create-");
const libraryDir = () => join(dir(), "library");
const BUDGET = 10_000_000;
/** The 2026-10-10 listing, std 5 s: a Kling reserve 504 000, Grok's 850 000, an expected bill 420 000. */
const STD5_PRICES: ClipPrices = { std: { perSecondMicros: 84_000, perInputImageMicros: 0 }, pro: { perSecondMicros: 112_000, perInputImageMicros: 0 }, grok: { perSecondMicros: 140_000, perInputImageMicros: 10_000 } };

function refusal(response: ResponseMessage): EngineError {
  expect(ResponseMessage.safeParse(response).success).toBe(true);
  if (response.ok) throw new Error(`expected a refusal, got ${JSON.stringify(response.result)}`);
  return response.error;
}

function optionsOf(response: ResponseMessage): ClipBatchOptions {
  if (!response.ok || response.type !== "clips.batchOptions") throw new Error(`expected clips.batchOptions, got ${JSON.stringify(response)}`);
  return response.result;
}

async function started(opts: Parameters<typeof startClipEngine>[1] = {}): Promise<ClipEngine> {
  return startClipEngine(dir(), { monthlyBudgetMicros: BUDGET, ...opts });
}

/** Nothing of a batch was left behind: no ledger line, no hold, no cap (the month's room is whole), no job, no file in the clips folder, and the unit is free. */
async function nothingLeft(engine: ClipEngine, avatarId: string): Promise<void> {
  expect(ledgerLines(dir())).toEqual([]);
  expect(engine.engine.budget?.status().heldMicros).toBe(0);
  expect(engine.engine.monthRoom()?.freeMicros).toBe(BUDGET);
  expect((await jobsOf(engine)).filter((job) => job.kind === "clip")).toEqual([]);
  const folder = clipsDir(libraryDir(), avatarId);
  expect(existsSync(folder) ? await readdir(folder) : []).toEqual([]);
  expect(await engine.engine.handle(command("money.reconcile"))).not.toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
}

describe("clips.batchOptions", () => {
  test("answers each photo's own options, the four sums by the one formula, and the month's room", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started();
    const answer = optionsOf(await batchOptions(engine, avatarId, photoIds));

    expect(ClipBatchOptions.safeParse(answer).success).toBe(true);
    expect(answer.items.map((item) => item.photoId)).toEqual(photoIds);
    expect(answer.items.every((item) => item.suitable)).toBe(true);
    const members = [{ bold: false }, { bold: false }, { bold: false }];
    const parts = { quality: "std" as const, seconds: 5 as const, mode: "auto" as const, boldClips: "kling-only" as const, prices: STD5_PRICES };
    expect(answer.sums.std5).toEqual({
      expected: clipBatchExpectedMicros(members, { ...parts, fallback: "auto" }),
      worst: clipBatchWorstMicros(members, { ...parts, fallback: "auto" }),
      worstNoFallback: clipBatchWorstMicros(members, { ...parts, fallback: "none" }),
    });
    // The figures themselves, once, so the formula is not the only witness: 3 x (420 000 expected | 850 000 worst with Grok | 504 000 worst on Kling alone).
    expect(answer.sums.std5).toEqual({ expected: 1_260_000, worst: 2_550_000, worstNoFallback: 1_512_000 });
    expect(answer.monthRoomMicros).toBe(BUDGET);
  });

  test("counts only the photos that can be made, and says why the others cannot", async () => {
    const { avatarId, photoIds, masterId } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const engine = await started();
    const answer = optionsOf(await batchOptions(engine, avatarId, [photoIds[0] ?? "", masterId, "photo-nope-0001", photoIds[1] ?? ""]));

    expect(answer.items.map((item) => (item.suitable ? "ok" : item.reason))).toEqual(["ok", "not-a-gallery-photo", "not-a-gallery-photo", "ok"]);
    expect(answer.sums.std5).toEqual({ expected: 840_000, worst: 1_700_000, worstNoFallback: 1_008_000 });
  });

  test("says the month takes the batch with its fallback, without it, or not at all, from the one room figure", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const roomy = optionsOf(await batchOptions(await started({ monthlyBudgetMicros: 3_000_000 }), avatarId, photoIds));
    expect(roomy.monthRoomMicros).toBe(3_000_000);
    expect(roomy.monthFits.std5).toBe("with-fallback");

    const tight = optionsOf(await batchOptions(await started({ monthlyBudgetMicros: 2_000_000 }), avatarId, photoIds));
    expect(tight.monthFits).toEqual({ std5: "without-fallback", pro5: "none", std10: "none", pro10: "none" });

    const empty = optionsOf(await batchOptions(await started({ monthlyBudgetMicros: 1_000_000 }), avatarId, photoIds));
    expect(empty.monthFits).toEqual({ std5: "none", pro5: "none", std10: "none", pro10: "none" });
    for (const answer of [roomy, tight, empty]) expect(ClipBatchOptions.safeParse(answer).success).toBe(true);
  });

  test("the boundary: a room exactly the sum fits, one micro-dollar less does not (with the fallback, and without it)", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    // With Grok behind them the three need 2 550 000; on Kling alone, 1 512 000.
    const exactWith = optionsOf(await batchOptions(await started({ monthlyBudgetMicros: 2_550_000 }), avatarId, photoIds));
    expect(exactWith.monthFits.std5).toBe("with-fallback");
    const oneLess = optionsOf(await batchOptions(await started({ monthlyBudgetMicros: 2_550_000 - 1 }), avatarId, photoIds));
    expect(oneLess.monthFits.std5).toBe("without-fallback");
    const exactWithout = optionsOf(await batchOptions(await started({ monthlyBudgetMicros: 1_512_000 }), avatarId, photoIds));
    expect(exactWithout.monthFits.std5).toBe("without-fallback");
    const none = optionsOf(await batchOptions(await started({ monthlyBudgetMicros: 1_512_000 - 1 }), avatarId, photoIds));
    expect(none.monthFits.std5).toBe("none");
    for (const answer of [exactWith, oneLess, exactWithout, none]) expect(ClipBatchOptions.safeParse(answer).success).toBe(true);
  });

  test("never says with-fallback for a batch of «Смелая» frames, which are Kling's alone", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), [{ category: "nightwear" }, { category: "nightwear" }]);
    const answer = optionsOf(await batchOptions(await started(), avatarId, photoIds));

    expect(answer.sums.std5.worst).toBe(answer.sums.std5.worstNoFallback);
    expect(answer.sums.std5.worst).toBe(1_008_000);
    expect(answer.monthFits.std5).toBe("without-fallback");
    expect(ClipBatchOptions.safeParse(answer).success).toBe(true);
  });

  test("reads the room net of what a running batch holds and has reserved, and the answer passes the contract's own refines", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(4));
    const engine = await started({ net: clipNetwork({ klingBy: (n) => (n === 1 ? { held: true } : undefined) }), monthlyBudgetMicros: 3_000_000 });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 2) }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");

    const answer = optionsOf(await batchOptions(engine, avatarId, photoIds.slice(2)));

    // 3 000 000 - the first member's open Kling reserve 504 000 - the second member's hold 850 000.
    expect(answer.monthRoomMicros).toBe(3_000_000 - 504_000 - 850_000);
    expect(ClipBatchOptions.safeParse(answer).success).toBe(true);
    // Two more frames would need 1 700 000 with Grok behind them, and the room is 1 646 000: Kling alone fits.
    expect(answer.monthFits.std5).toBe("without-fallback");
    engine.net.releaseNth("kling", 1);
    for (const id of jobIds) await jobEnd(engine, id);
  });

  test("reads the month ONCE, after its last await, and derives every figure from that read (never two reads a hold could slip between)", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(4));
    const engine = await started({ monthlyBudgetMicros: 3_000_000 });
    const budget = engine.engine.budget;
    if (budget === null) throw new Error("no budget");
    const read = budget.status.bind(budget);
    let reads = 0;
    budget.status = () => {
      reads++;
      return read();
    };

    const answer = optionsOf(await batchOptions(engine, avatarId, photoIds));

    expect(reads).toBe(1);
    expect(answer.monthRoomMicros).toBe(3_000_000);
    expect(ClipBatchOptions.safeParse(answer).success).toBe(true);
    // Each photo's own sheet is derived from the same figure as the batch's.
    expect(answer.items.every((item) => item.suitable && item.monthFits.std5 === "with-fallback")).toBe(true);
  });

  test("is free: no ledger line, no hold, no job", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const engine = await started();
    optionsOf(await batchOptions(engine, avatarId, photoIds));
    await nothingLeft(engine, avatarId);
  });

  test("NOT_FOUND for an avatar the library does not have", async () => {
    const { photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(1));
    const engine = await started();
    expect(refusal(await batchOptions(engine, "avatar-nope-0001", photoIds)).code).toBe("NOT_FOUND");
  });

  test("PRICE_UNAVAILABLE with `priceScope: \"video\"` for a listing that reads and lacks a price", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(1));
    const engine = await started({ net: clipNetwork({ listing: listing({ grok: {} }) }) });
    expect(refusal(await batchOptions(engine, avatarId, photoIds))).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "video" });
  });
});

describe("clips.createBatch refuses, free and in order", () => {
  test("AUTH_INVALID without a key", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const engine = await started({ key: null });
    expect(refusal(await createBatch(engine, { avatarId, photoIds })).code).toBe("AUTH_INVALID");
    await nothingLeft(engine, avatarId);
  });

  test("RECONCILE_REQUIRED while an earlier process's reserve is open", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    await writeLedger(dir(), [{ type: "reserve", attemptId: "old-0001", jobId: "old-0001", scope: { avatarJobId: "old-0001" }, model: "x-ai/grok-4.3", worstMicros: 1000, at: "2026-09-24T11:00:00.000Z" }]);
    const engine = await started();
    expect(refusal(await createBatch(engine, { avatarId, photoIds })).code).toBe("RECONCILE_REQUIRED");
    expect(engine.engine.budget?.status().heldMicros).toBe(0);
  });

  test("NOT_FOUND means the avatar and nothing else", async () => {
    const { photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const engine = await started();
    expect(refusal(await createBatch(engine, { avatarId: "avatar-nope-0001", photoIds })).code).toBe("NOT_FOUND");
  });

  test("a photo that is missing, or another avatar's, is VALIDATION `not-a-gallery-photo` at its own path, never NOT_FOUND, and nothing is held or capped", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const other = await seedBatchAvatar(libraryDir(), plainPhotos(1));
    const engine = await started();

    const missing = refusal(await createBatch(engine, { avatarId, photoIds: [photoIds[0] ?? "", "photo-nope-0001"] }));
    expect(missing).toMatchObject({ code: "VALIDATION", clipReason: "not-a-gallery-photo", path: ["items", 1] });
    const foreign = refusal(await createBatch(engine, { avatarId, photoIds: [other.photoIds[0] ?? "", photoIds[1] ?? ""] }));
    expect(foreign).toMatchObject({ code: "VALIDATION", clipReason: "not-a-gallery-photo", path: ["items", 0] });
    await nothingLeft(engine, avatarId);
  });

  test("an item's own reason comes with its path, the lowest item first, and nothing is held or capped", async () => {
    const { avatarId, photoIds, masterId } = await seedBatchAvatar(libraryDir(), [{}, {}, { qa: { faceCos: 0.7, age: { adult: false, confidence: 0.9 } } }]);
    const engine = await started();

    const both = refusal(await createBatch(engine, { avatarId, photoIds: [photoIds[0] ?? "", masterId, photoIds[2] ?? ""] }));
    expect(both).toMatchObject({ code: "VALIDATION", clipReason: "not-a-gallery-photo", path: ["items", 1] });
    const age = refusal(await createBatch(engine, { avatarId, photoIds }));
    expect(age).toMatchObject({ code: "VALIDATION", clipReason: "age-unverified", path: ["items", 2] });
    const motion = refusal(await createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 2), motionIds: { 1: "g-hips" } }));
    expect(motion).toMatchObject({ code: "VALIDATION", clipReason: "unknown-motion", path: ["items", 1] });
    await nothingLeft(engine, avatarId);
  });

  test("`bold-off` is the item's own reason too, while «Смелая» is off", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), [{}, { category: "nightwear" }]);
    const engine = await started({ deps: { clipSwitches: { boldClips: "off" } } });
    expect(refusal(await createBatch(engine, { avatarId, photoIds }))).toMatchObject({ code: "VALIDATION", clipReason: "bold-off", path: ["items", 1] });
    await nothingLeft(engine, avatarId);
  });

  test("PRICE_UNAVAILABLE `video` for a listing that lacks a price", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const engine = await started({ net: clipNetwork({ listing: listing({ grok: {} }) }) });
    expect(refusal(await createBatch(engine, { avatarId, photoIds }))).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "video" });
    await nothingLeft(engine, avatarId);
  });

  test("PRICE_CHANGED when the sum is above what the owner accepted by one micro-dollar, with nothing held or capped; the exact sum is accepted", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started();
    expect(refusal(await createBatch(engine, { avatarId, photoIds, acceptedWorstMicros: 2_550_000 - 1 })).code).toBe("PRICE_CHANGED");
    await nothingLeft(engine, avatarId);

    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds, acceptedWorstMicros: 2_550_000 }));
    for (const id of jobIds) await jobEnd(engine, id);
  });

  test("BUDGET_EXCEEDED from the month hold when the sum does not fit, with nothing held or capped", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ monthlyBudgetMicros: 2_550_000 - 1 });
    expect(refusal(await createBatch(engine, { avatarId, photoIds })).code).toBe("BUDGET_EXCEEDED");
    expect(ledgerLines(dir())).toEqual([]);
    expect(engine.engine.budget?.status().heldMicros).toBe(0);
    expect(engine.engine.monthRoom()?.freeMicros).toBe(2_550_000 - 1);
    expect((await jobsOf(engine)).filter((job) => job.kind === "clip")).toEqual([]);
    // The unit came back: a batch that fits is taken at once.
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds: photoIds.slice(0, 2), acceptedWorstMicros: 1_700_000 }));
    expect(jobIds).toHaveLength(2);
    for (const id of jobIds) await jobEnd(engine, id);
  });

  test("a month room exactly the sum is accepted (the boundary: one micro-dollar less is BUDGET_EXCEEDED, above)", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ monthlyBudgetMicros: 2_550_000 });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    expect(jobIds).toHaveLength(3);
    for (const id of jobIds) expect((await jobEnd(engine, id)).type).toBe("job.done");
  });

  test("every refusal gives the unit back, so the next batch is taken", async () => {
    const { avatarId, photoIds, masterId } = await seedBatchAvatar(libraryDir(), plainPhotos(2));
    const engine = await started();
    for (let round = 0; round < 3; round++) expect((await createBatch(engine, { avatarId, photoIds: [masterId] })).ok).toBe(false);
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    for (const id of jobIds) expect((await jobEnd(engine, id)).type).toBe("job.done");
  });
});

describe("clips.createBatch accepts", () => {
  test("answers the batch id and one job id per item in pick order; the first member runs and the rest wait `queued` with the trio", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ net: clipNetwork({ klingBy: (n) => (n === 1 ? { held: true } : undefined) }) });
    const { batchId, jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    expect(jobIds).toHaveLength(3);
    expect(new Set(jobIds).size).toBe(3);

    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");
    const states = await Promise.all(jobIds.map((id) => clipJob(engine, id)));
    expect(states.map((s) => [s?.phase, s?.batchId, s?.batchIndex, s?.batchSize, s?.photoId])).toEqual([
      ["rendering", batchId, 1, 3, photoIds[0]],
      ["queued", batchId, 2, 3, photoIds[1]],
      ["queued", batchId, 3, 3, photoIds[2]],
    ]);
    expect(states[1]).toMatchObject({ status: "running", done: 0, waitReason: "turn", acceptedWorstMicros: 850_000, request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" } });
    // The queued members were announced before they ever ran.
    expect(phasesOf(engine, jobIds[1] ?? "")[0]).toBe("queued");
    expect(engine.net.posts()).toHaveLength(1);

    engine.net.releaseNth("kling", 1);
    for (const id of jobIds) expect((await jobEnd(engine, id)).type).toBe("job.done");
  });

  test("a member's share is its worst case under the batch's book: a cap each, a month hold each, and the first reserve takes its hold", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), plainPhotos(3));
    const engine = await started({ net: clipNetwork({ klingBy: (n) => (n === 1 ? { held: true } : undefined) }) });
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");

    const status = engine.engine.budget?.status();
    // The first member reserved Kling's 504 000 (its hold went with the reserve); the other two hold their 850 000 shares.
    expect(status?.openReserveMicros).toBe(504_000);
    expect(status?.heldMicros).toBe(2 * 850_000);
    // Live caps: the running member may still spend 850 000 - 504 000 more; the queued ones' caps equal their holds.
    expect(engine.engine.monthRoom()?.freeMicros).toBe(BUDGET - 504_000 - 2 * 850_000 - (850_000 - 504_000));
    engine.net.releaseNth("kling", 1);
    for (const id of jobIds) await jobEnd(engine, id);
  });

  test("a «Смелая» member's share is Kling's alone, and the batch's sum is the sum of the shares", async () => {
    const { avatarId, photoIds } = await seedBatchAvatar(libraryDir(), [{}, { category: "nightwear" }]);
    const engine = await started({ net: clipNetwork({ klingBy: (n) => (n === 1 ? { held: true } : undefined) }) });
    // 850 000 for the plain frame (Grok behind Kling) + 504 000 for the frame of «Смелая».
    expect(refusal(await createBatch(engine, { avatarId, photoIds, acceptedWorstMicros: 850_000 + 504_000 - 1 })).code).toBe("PRICE_CHANGED");
    const { jobIds } = batchOf(await createBatch(engine, { avatarId, photoIds, acceptedWorstMicros: 850_000 + 504_000 }));
    await until(() => phasesOf(engine, jobIds[0] ?? "").includes("rendering"), "member 1 rendering");

    expect((await clipJob(engine, jobIds[1] ?? ""))?.acceptedWorstMicros).toBe(504_000);
    expect((await clipJob(engine, jobIds[1] ?? ""))?.request).toMatchObject({ fallback: "none" });
    expect(engine.engine.budget?.status().heldMicros).toBe(504_000);
    engine.net.releaseNth("kling", 1);
    for (const id of jobIds) await jobEnd(engine, id);
  });
});
