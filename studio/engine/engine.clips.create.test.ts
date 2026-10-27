import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { ClipOptions, ResponseMessage, type EngineError } from "../shared/engine";
import { PRICE_FETCH_TIMEOUT_MS } from "./money/prices";
import { CLIP_PLAN_READ_TIMEOUT_MS, COMMAND_DEADLINE_MS } from "./control";
import { LIVE_LIBRARY_IDENTITY_TIMEOUT_MS } from "./videos/timeouts";
import { readPlanWithin } from "./clips/service";
import {
  clipNetwork,
  clipsDir,
  create,
  jobEnd,
  jobIdOf,
  listing,
  options,
  optionsOf,
  photoJpeg,
  seedClipAvatar,
  startClipEngine,
  type ClipEngine,
} from "./clips/testing/engineClipKit";
import { ledgerLines, useEngineDir, writeLedger } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4a1 (plan s5b1 §5.2, §5.9, I5.47, I5.50, I5.57): `clips.options` and `clips.create` in the real engine. Every refusal of `clips.create` is free and comes before any
// reserve or journal, in the contract's order: one at a time, the key, the ledger, the library, the avatar and photo, the clip's own reasons, the price, the accepted worst, the month.

setDefaultTimeout(60_000);

const dir = useEngineDir("studio-engine-clips-create-");
const libraryDir = () => join(dir(), "library");

function refusal(response: ResponseMessage): EngineError {
  expect(ResponseMessage.safeParse(response).success).toBe(true);
  if (response.ok) throw new Error(`expected a refusal, got ${JSON.stringify(response.result)}`);
  return response.error;
}

/** Nothing of a clip was written: no ledger line, no journal, no record. */
async function nothingWritten(avatarId: string): Promise<void> {
  expect(ledgerLines(dir())).toEqual([]);
  const folder = clipsDir(libraryDir(), avatarId);
  expect(existsSync(folder) ? await readdir(folder) : []).toEqual([]);
}

async function started(opts: Parameters<typeof startClipEngine>[1] = {}): Promise<ClipEngine> {
  return startClipEngine(dir(), opts);
}

describe("clips.create refuses, free and in order", () => {
  test("AUTH_INVALID without a key", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await started({ key: null });
    expect(refusal(await create(engine, { avatarId, photoId })).code).toBe("AUTH_INVALID");
    await nothingWritten(avatarId);
  });

  test("RECONCILE_REQUIRED while an earlier process's reserve is open", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    await writeLedger(dir(), [{ type: "reserve", attemptId: "old-0001", jobId: "old-0001", scope: { avatarJobId: "old-0001" }, model: "x-ai/grok-4.3", worstMicros: 1000, at: "2026-09-24T11:00:00.000Z" }]);
    const engine = await started();
    expect(refusal(await create(engine, { avatarId, photoId })).code).toBe("RECONCILE_REQUIRED");
  });

  test("NOT_FOUND for an avatar or a photo the library does not have, or another avatar's photo", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const other = await seedClipAvatar(libraryDir());
    const engine = await started();
    expect(refusal(await create(engine, { avatarId: "avatar-nope-0001", photoId })).code).toBe("NOT_FOUND");
    expect(refusal(await create(engine, { avatarId, photoId: "photo-nope-0001" })).code).toBe("NOT_FOUND");
    expect(refusal(await create(engine, { avatarId, photoId: other.photoId })).code).toBe("NOT_FOUND");
    await nothingWritten(avatarId);
  });

  test("VALIDATION `not-a-gallery-photo` for the master portrait", async () => {
    const { avatarId, masterId } = await seedClipAvatar(libraryDir());
    const engine = await started();
    expect(refusal(await create(engine, { avatarId, photoId: masterId }))).toMatchObject({ code: "VALIDATION", clipReason: "not-a-gallery-photo" });
    await nothingWritten(avatarId);
  });

  test("VALIDATION `age-unverified` for a photo the age check did not call adult", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir(), { qa: { faceCos: 0.7, age: { adult: false, confidence: 0.9 } } });
    const engine = await started();
    expect(refusal(await create(engine, { avatarId, photoId }))).toMatchObject({ code: "VALIDATION", clipReason: "age-unverified" });
    await nothingWritten(avatarId);
  });

  test("VALIDATION `photo-unreadable` for a photo whose file no longer matches its sidecar", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await started();
    const file = engine.engine.library?.photoFilePath(photoId);
    if (file === undefined) throw new Error("no photo file");
    await writeFile(file, "not the photo any more");
    expect(refusal(await create(engine, { avatarId, photoId }))).toMatchObject({ code: "VALIDATION", clipReason: "photo-unreadable" });
    await nothingWritten(avatarId);
  });

  test("VALIDATION `not-vertical` for a landscape photo", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir(), { photo: await photoJpeg(1280, 720), width: 1280, height: 720 });
    const engine = await started();
    expect(refusal(await create(engine, { avatarId, photoId }))).toMatchObject({ code: "VALIDATION", clipReason: "not-vertical" });
    await nothingWritten(avatarId);
  });

  test("VALIDATION `bold-off` for a frame of «Смелая» while BOLD_CLIPS is off", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir(), { category: "nightwear" });
    const engine = await started({ deps: { clipSwitches: { boldClips: "off" } } });
    expect(refusal(await create(engine, { avatarId, photoId, fallback: "none", acceptedWorstMicros: 504_000 }))).toMatchObject({ code: "VALIDATION", clipReason: "bold-off" });
    await nothingWritten(avatarId);
  });

  test("VALIDATION `no-motion` for a frame with no bank moment whose face is not known to show", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir(), { qa: {} });
    const engine = await started();
    expect(refusal(await create(engine, { avatarId, photoId }))).toMatchObject({ code: "VALIDATION", clipReason: "no-motion" });
    await nothingWritten(avatarId);
  });

  test("VALIDATION `unknown-motion` for a motion the sheet did not list for this photo", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await started();
    expect(refusal(await create(engine, { avatarId, photoId, motionId: "g-hips" }))).toMatchObject({ code: "VALIDATION", clipReason: "unknown-motion" });
    expect(refusal(await create(engine, { avatarId, photoId, motionId: "scene" }))).toMatchObject({ code: "VALIDATION", clipReason: "unknown-motion" });
    await nothingWritten(avatarId);
  });

  test("VALIDATION `grok-not-offered` for a Grok clip in mode auto, and for a frame of «Смелая» in mode offer", async () => {
    const plain = await seedClipAvatar(libraryDir());
    const bold = await seedClipAvatar(libraryDir(), { category: "nightwear" });
    const auto = await started();
    expect(refusal(await create(auto, { avatarId: plain.avatarId, photoId: plain.photoId, model: "grok", fallback: "none" }))).toMatchObject({ code: "VALIDATION", clipReason: "grok-not-offered" });
    await auto.engine.shutdown();
    const offer = await started({ deps: { clipSwitches: { mode: "offer" } } });
    expect(refusal(await create(offer, { avatarId: bold.avatarId, photoId: bold.photoId, model: "grok", fallback: "none" }))).toMatchObject({ code: "VALIDATION", clipReason: "grok-not-offered" });
    await nothingWritten(plain.avatarId);
  });

  test("a Grok clip in mode offer on an ordinary photo is accepted", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await started({ deps: { clipSwitches: { mode: "offer" } } });
    const jobId = jobIdOf(await create(engine, { avatarId, photoId, model: "grok", fallback: "none", acceptedWorstMicros: 850_000 }));
    expect((await jobEnd(engine, jobId)).type).toBe("job.done");
    expect(engine.net.posts("grok")).toHaveLength(1);
    expect(engine.net.posts("kling")).toHaveLength(0);
  });

  test("PRICE_UNAVAILABLE with `priceScope: \"video\"` for a listing that reads and lacks a needed price", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const net = clipNetwork({ listing: listing({ pro: { image_to_video_duration_seconds_720p: "0.112" } }) });
    const engine = await started({ net });
    expect(refusal(await create(engine, { avatarId, photoId }))).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "video" });
    await nothingWritten(avatarId);
  });

  test("PRICE_CHANGED when the live price is above the accepted worst; a lower one passes", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const raised = await started({ net: clipNetwork({ listing: listing({ grok: { cents_per_image_input: "1", cents_per_video_output_second_720p: "15" } }) }) });
    expect(refusal(await create(raised, { avatarId, photoId, acceptedWorstMicros: 850_000 })).code).toBe("PRICE_CHANGED");
    await nothingWritten(avatarId);
    await raised.engine.shutdown();

    const lowered = await started({ net: clipNetwork({ listing: listing({ grok: { cents_per_image_input: "1", cents_per_video_output_second_720p: "13" } }) }) });
    const jobId = jobIdOf(await create(lowered, { avatarId, photoId, acceptedWorstMicros: 850_000 }));
    expect((await jobEnd(lowered, jobId)).type).toBe("job.done");
  });

  test("BUDGET_EXCEEDED when the month has no room for the clip's worst case", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await started({ monthlyBudgetMicros: 849_999 });
    expect(refusal(await create(engine, { avatarId, photoId })).code).toBe("BUDGET_EXCEEDED");
    await nothingWritten(avatarId);
  });

  test("the order: a key refusal comes before the photo's own reason, and the photo's before the price", async () => {
    const { avatarId, masterId } = await seedClipAvatar(libraryDir());
    const keyless = await started({ key: null, net: clipNetwork({ listing: listing({ pro: {} }) }) });
    expect(refusal(await create(keyless, { avatarId, photoId: masterId })).code).toBe("AUTH_INVALID");
    await keyless.engine.shutdown();
    const keyed = await started({ net: clipNetwork({ listing: listing({ pro: {} }) }) });
    expect(refusal(await create(keyed, { avatarId, photoId: masterId }))).toMatchObject({ code: "VALIDATION", clipReason: "not-a-gallery-photo" });
  });
});

describe("clips.options", () => {
  test("a gallery photo is suitable: its motions, the six prices, the engine's mode and the month's fit, free", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await started();
    const answer = optionsOf(await options(engine, avatarId, photoId));
    expect(ClipOptions.safeParse(answer).success).toBe(true);
    if (!answer.suitable) throw new Error("expected a suitable photo");
    expect(answer.motions.map((m) => m.id)).toEqual(["g-blink", "g-tilt", "g-breath"]);
    expect(answer).toMatchObject({ fallback: "auto", bold: false });
    expect(answer.prices.std5).toMatchObject({ expectedMicros: 420_000, worstMicros: 850_000, prices: "live" });
    expect(answer.prices.pro10).toMatchObject({ expectedMicros: 1_120_000, worstMicros: 1_550_000 });
    expect(answer.noFallbackPrices.std5).toMatchObject({ worstMicros: 504_000 });
    expect(answer.prices.grok5).toMatchObject({ expectedMicros: 710_000, worstMicros: 850_000 });
    expect(answer.monthFits).toEqual({ std5: "with-fallback", pro5: "with-fallback", std10: "with-fallback", pro10: "with-fallback" });
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("a frame of «Смелая» under kling-only has no fallback: its worst is Kling's alone", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir(), { category: "nightwear" });
    const engine = await started();
    const answer = optionsOf(await options(engine, avatarId, photoId));
    if (!answer.suitable) throw new Error("expected a suitable photo");
    expect(answer).toMatchObject({ fallback: "none", bold: true });
    expect(answer.prices.std5.worstMicros).toBe(504_000);
    expect(answer.monthFits.std5).toBe("without-fallback");
  });

  // 5a.4 (S5.BA6, I5.79, QB-5): the money follows the photo's own route. A routed photo of the five is Kling's alone (its reserve 504 000, no fallback); the same category stored before 5a.4 keeps 850 000.
  test("a routed «Дом» photo with no plan has no fallback: its worst is Kling's alone", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir(), { category: "home", route: "seedream" });
    const engine = await started();
    const answer = optionsOf(await options(engine, avatarId, photoId));
    if (!answer.suitable) throw new Error("expected a suitable photo");
    expect(answer).toMatchObject({ fallback: "none", bold: true });
    expect(answer.prices.std5.worstMicros).toBe(504_000);
    expect(answer.monthFits.std5).toBe("without-fallback");
  });

  test("an old «Дом» photo with no route keeps its fallback and its 850 000 worst", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir(), { category: "home" });
    const engine = await started();
    const answer = optionsOf(await options(engine, avatarId, photoId));
    if (!answer.suitable) throw new Error("expected a suitable photo");
    expect(answer).toMatchObject({ fallback: "auto", bold: false });
    expect(answer.prices.std5.worstMicros).toBe(850_000);
  });

  test("an unsuitable photo is an answer with its reason, not an error", async () => {
    const { avatarId, masterId } = await seedClipAvatar(libraryDir());
    const hidden = await seedClipAvatar(libraryDir(), { qa: {} });
    const landscape = await seedClipAvatar(libraryDir(), { photo: await photoJpeg(1280, 720), width: 1280, height: 720 });
    const engine = await started();
    expect(optionsOf(await options(engine, avatarId, masterId))).toEqual({ suitable: false, photoId: masterId, reason: "not-a-gallery-photo" });
    expect(optionsOf(await options(engine, hidden.avatarId, hidden.photoId))).toEqual({ suitable: false, photoId: hidden.photoId, reason: "no-motion" });
    expect(optionsOf(await options(engine, landscape.avatarId, landscape.photoId))).toEqual({ suitable: false, photoId: landscape.photoId, reason: "not-vertical" });
  });

  test("PRICE_UNAVAILABLE `video` for a listing that reads and lacks a price; NOT_FOUND for an unknown photo", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await started({ net: clipNetwork({ listing: listing({ grok: {} }) }) });
    expect(refusal(await options(engine, avatarId, photoId))).toMatchObject({ code: "PRICE_UNAVAILABLE", priceScope: "video" });
    expect(refusal(await options(engine, avatarId, "photo-nope-0001")).code).toBe("NOT_FOUND");
  });

  test("an unreadable listing prices from the dated table", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await started({ net: clipNetwork({ listing: "offline" }) });
    const answer = optionsOf(await options(engine, avatarId, photoId));
    if (!answer.suitable) throw new Error("expected a suitable photo");
    expect(answer.prices.std5).toMatchObject({ worstMicros: 850_000, prices: "fallback", pricesAsOf: "2026-10-10" });
  });
});

describe("the month: clips.options and clips.create read one figure (I5.47)", () => {
  // Spent + open + held against the monthly budget: the std 5 s option needs 850 000 with Grok behind Kling, 504 000 without.
  test.each([
    [850_000, "with-fallback", "accepted"],
    [849_999, "without-fallback", "BUDGET_EXCEEDED"],
    [504_000, "without-fallback", "BUDGET_EXCEEDED"],
    [503_999, "none", "BUDGET_EXCEEDED"],
  ] as const)("a monthly budget of %d µ$: the sheet says %s and the create with Grok behind is %s", async (budget, fit, verdict) => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await started({ monthlyBudgetMicros: budget });
    const answer = optionsOf(await options(engine, avatarId, photoId));
    if (!answer.suitable) throw new Error("expected a suitable photo");
    expect(answer.monthFits.std5).toBe(fit);
    const response = await create(engine, { avatarId, photoId, acceptedWorstMicros: 850_000 });
    if (verdict === "accepted") expect(response.ok).toBe(true);
    else expect(refusal(response).code).toBe(verdict);
  });

  test.each([
    [504_000, "accepted"],
    [503_999, "BUDGET_EXCEEDED"],
  ] as const)("a monthly budget of %d µ$: the create without a fallback is %s, as the sheet's `without-fallback` says", async (budget, verdict) => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await started({ monthlyBudgetMicros: budget });
    const response = await create(engine, { avatarId, photoId, fallback: "none", acceptedWorstMicros: 504_000 });
    if (verdict === "accepted") expect(response.ok).toBe(true);
    else expect(refusal(response).code).toBe(verdict);
  });
});

describe("a frame of «Смелая» under kling-only", () => {
  test("a payload with fallback auto runs as none: Kling's worst is the accepted one, and a free refusal ends there with no Grok", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir(), { category: "nightwear" });
    const net = clipNetwork({ kling: { terminal: { status: "failed", error: "task failed with status: FAIL, message: Failure to pass the risk control system" } } });
    const engine = await started({ net });
    const jobId = jobIdOf(await create(engine, { avatarId, photoId, fallback: "auto", acceptedWorstMicros: 504_000 }));
    expect((await jobEnd(engine, jobId)).type).toBe("job.done");

    expect(net.posts("kling")).toHaveLength(1);
    expect(net.posts("grok")).toHaveLength(0);
    const lines = ledgerLines(dir());
    expect(lines.filter((l) => l.type === "reserve").map((l) => [l.attemptId, l.worstMicros])).toEqual([[`${jobId}:video#1`, 504_000]]);
    expect(lines.filter((l) => l.type === "settle").map((l) => [l.attemptId, l.costMicros, l.estimated])).toEqual([[`${jobId}:video#1`, 0, false]]);
    for (const line of lines) for (const value of Object.values(line)) if (typeof value === "number") expect(Number.isInteger(value)).toBe(true);
  });
});

describe("the run plan read", () => {
  test("is bounded by CLIP_PLAN_READ_TIMEOUT_MS (5 s), which fits inside clips.create's deadline", () => {
    expect(CLIP_PLAN_READ_TIMEOUT_MS).toBe(5_000);
    expect(COMMAND_DEADLINE_MS["clips.create"]).toBeGreaterThanOrEqual(PRICE_FETCH_TIMEOUT_MS + LIVE_LIBRARY_IDENTITY_TIMEOUT_MS + CLIP_PLAN_READ_TIMEOUT_MS);
  });

  test("has one definition, in control.ts beside the deadline it is a share of: the clip service reads that one", async () => {
    const service = await readFile(join(import.meta.dir, "clips", "service.ts"), "utf8");
    expect(service).not.toMatch(/CLIP_PLAN_READ_TIMEOUT_MS\s*=/);
    expect(service).toMatch(/import \{[^}]*\bCLIP_PLAN_READ_TIMEOUT_MS\b[^}]*\} from "\.\.\/control"/);
  });

  test("a read that does not answer in time rejects, so the photo has no plan; a read that answers is passed on", async () => {
    await expect(readPlanWithin(() => new Promise<never>(() => {}), 20)).rejects.toThrow();
    expect(await readPlanWithin(async () => "the plan", 1_000)).toBe("the plan");
  });
});
