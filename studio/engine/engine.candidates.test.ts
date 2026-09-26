import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { chmod, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Snapshot, type ErrorCode, type EventMessage } from "../shared/engine";
import { __setFfmpegPathOverrideForTests, ffmpegPath } from "../node/ffmpegBinary";
import { manifestTraits } from "./avatars/records";
import type { EngineInit } from "./control";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta } from "./library/testing/helpers";
import { imageBody } from "./openrouter/testing/fakes";
import { RAW_KEEP_BYTES_IMAGE } from "./rawStore";
import {
  ageReply,
  AGE_WORST,
  command,
  engineSettings,
  failed,
  fileBytes,
  filesUnder,
  generate,
  GOOD,
  IMAGE_WORST,
  jobEnd,
  jobIdOf,
  KEY,
  ledgerLines,
  MODERATION,
  network,
  NEXT_BATCH,
  OFFLINE,
  ok,
  portraitPng,
  portraitReply,
  seedDraft,
  startEngine,
  tempWritesDuring,
  TRAITS,
  until,
  useEngineDir,
  writeLedger,
} from "./testing/engineHarness";

// T6a part 2b: the candidate job, its registry and events, cancel, pick and
// archive, against a real ledger and library in a temp dir, the bundled
// ffmpeg, and a fake OpenRouter. Nothing reaches the network.

const dir = useEngineDir("studio-engine-candidates-");

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function jobEvents(events: EventMessage[], jobId: string): EventMessage[] {
  return events.filter((e) => ("jobId" in e.payload && e.payload.jobId === jobId) || e.type === "draft.changed" || e.type === "money.changed");
}

async function snapshot(engine: Awaited<ReturnType<typeof startEngine>>["engine"]) {
  const answer = ok(await engine.handle(command("engine.snapshot")));
  if (answer.type !== "engine.snapshot") throw new Error("wrong type");
  expect(Snapshot.safeParse(answer.result).success).toBe(true);
  return answer.result;
}

/** One slot at a time, so the n-th image and the n-th age check belong to slot n. */
function sequentialInit(): { settings: ReturnType<typeof engineSettings> } {
  return { settings: engineSettings(dir(), { concurrency: { network: 1 } }) };
}

// ---------- the job ----------

describe("avatars.generateCandidates", () => {
  test("answers the job id at once; four portraits pass the age check and become the draft's candidates", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, events } = await startEngine(dir());

    const jobId = jobIdOf(await engine.handle(generate(draftId)));
    const end = await jobEnd(events, jobId);

    const photos = engine.library?.photosByAvatar(draftId) ?? [];
    expect(photos).toHaveLength(4);
    expect(photos.every((p) => p.qa.age?.adult === true)).toBe(true);
    expect(end).toMatchObject({
      type: "job.done",
      payload: { jobId, result: { kind: "avatar.candidates", avatarId: draftId, rejectedByAgeCheck: 0 } },
    });
    if (end.type !== "job.done") throw new Error("expected job.done");
    expect(end.payload.result.kind === "avatar.candidates" ? end.payload.result.candidates.map((c) => c.photoId).sort() : []).toEqual(photos.map((p) => p.id).sort());
    expect((await snapshot(engine)).drafts[0]?.candidates.map((c) => c.photoId).sort()).toEqual(photos.map((p) => p.id).sort());
  });

  test("a batch writes nothing to the system temp folder: no unverified image is ever on disk outside the library", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, events } = await startEngine(dir());

    const written = await tempWritesDuring(dir(), async () => {
      const end = await jobEnd(events, jobIdOf(await engine.handle(generate(draftId))));
      expect(end.type).toBe("job.done");
    });

    expect(written).toEqual([]);
    expect(engine.library?.photosByAvatar(draftId)).toHaveLength(4);
  });

  test("the answer comes while the images are still in flight, and the snapshot lists the running job", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, net, events } = await startEngine(dir(), { net: network({ image: () => ({ hang: true }) }) });

    const jobId = jobIdOf(await engine.handle(generate(draftId)));
    await until(() => net.imageCalls().length === 4, "four image requests");

    expect((await snapshot(engine)).jobs).toEqual([{ kind: "avatar.candidates", jobId, avatarId: draftId, status: "running", done: 0, total: 4 }]);
    ok(await engine.handle(command("avatars.cancel", { jobId })));
    await jobEnd(events, jobId);
  });

  test("emits job.progress per slot and draft.changed per stored candidate, then money.changed and job.done", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, events } = await startEngine(dir(), { init: sequentialInit() });
    const before = events().length;

    const jobId = jobIdOf(await engine.handle(generate(draftId)));
    await jobEnd(events, jobId);

    const emitted = jobEvents(events().slice(before), jobId);
    expect(emitted.map((e) => e.type)).toEqual([
      "draft.changed", "job.progress", "draft.changed", "job.progress", "draft.changed", "job.progress", "draft.changed", "job.progress", "money.changed", "job.done",
    ]);
    expect(emitted.filter((e) => e.type === "job.progress").map((e) => e.payload)).toEqual([1, 2, 3, 4].map((done) => ({ jobId, done, total: 4 })));
    expect(emitted.flatMap((e) => (e.type === "draft.changed" ? [e.payload.draft.candidates.length] : []))).toEqual([1, 2, 3, 4]);
    expect(emitted.find((e) => e.type === "draft.changed")).toMatchObject({ payload: { draft: { avatarId: draftId, traits: TRAITS, estimate: NEXT_BATCH } } });
    expect(emitted.find((e) => e.type === "money.changed")).toMatchObject({ payload: { status: { spentMicros: 4 * (40_000 + 1_400), unsettledCount: 0 } } });
    const seqs = events().map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  test("reserves every attempt in the job's own scope, capped at the batch's worst case; the cap goes when the job ends", async () => {
    const { draftId } = await seedDraft(dir());
    let probe: unknown = null;
    let engineRef: Awaited<ReturnType<typeof startEngine>>["engine"] | null = null;
    const net = network({
      image: async (_call, n) => {
        if (n === 1) {
          const jobId = String(ledgerLines(dir())[0]?.jobId);
          probe = await engineRef?.budget?.tryReserve({ attemptId: "probe#1", jobId, scope: { avatarJobId: jobId }, model: "x-ai/grok-4.3", worstMicros: NEXT_BATCH.worstMicros });
        }
        return portraitReply(n);
      },
    });
    const { engine, events } = await startEngine(dir(), { net, init: sequentialInit() });
    engineRef = engine;

    const jobId = jobIdOf(await engine.handle(generate(draftId)));
    await jobEnd(events, jobId);

    // Probed while the first image's reserve (40,000 µ$) was open and its age check held (5,000 µ$) in the job's scope.
    expect(probe).toMatchObject({ ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: NEXT_BATCH.worstMicros, committedMicros: IMAGE_WORST + AGE_WORST });
    const reserves = ledgerLines(dir()).filter((l) => l.type === "reserve");
    expect(reserves).toHaveLength(8);
    expect(reserves.every((r) => r.jobId === jobId && JSON.stringify(r.scope) === JSON.stringify({ avatarJobId: jobId }))).toBe(true);
    expect(reserves.reduce((sum, r) => sum + Number(r.worstMicros), 0)).toBe(4 * (IMAGE_WORST + AGE_WORST));
    expect(await engine.budget?.tryReserve({ attemptId: "late#1", jobId, scope: { avatarJobId: jobId }, model: "x-ai/grok-4.3", worstMicros: 1 })).toMatchObject({
      ok: false,
      reason: "RUN_CAP_EXCEEDED",
      limitMicros: 0,
    });
  });

  test("an image the age check rejects never enters the library: not on disk, not in the draft, not in the result", async () => {
    const { draftId } = await seedDraft(dir());
    const net = network({ age: (_call, n) => (n === 2 ? ageReply(false, 0.97) : ageReply(true)) });
    const { engine, events } = await startEngine(dir(), { net, init: sequentialInit() });

    const jobId = jobIdOf(await engine.handle(generate(draftId)));
    const end = await jobEnd(events, jobId);

    expect(end).toMatchObject({ type: "job.done", payload: { result: { rejectedByAgeCheck: 1, failedSlots: [{ slot: 2, reason: "age-rejected" }] } } });
    if (end.type !== "job.done" || end.payload.result.kind !== "avatar.candidates") throw new Error("expected job.done");
    expect(end.payload.result.candidates).toHaveLength(3);
    const stored = engine.library?.photosByAvatar(draftId) ?? [];
    expect(stored.map((p) => p.sha256).sort()).toEqual([1, 3, 4].map((v) => sha256(portraitPng(v))).sort());
    // The rejected image is nowhere: not in the library's files, not in userData.
    const rejected = sha256(portraitPng(2));
    for (const root of [join(dir(), "library"), join(dir(), "userData")]) {
      for (const file of await filesUnder(root)) {
        expect(sha256(await fileBytes(join(root, file)))).not.toBe(rejected);
      }
    }
    expect((await snapshot(engine)).drafts[0]?.candidates).toHaveLength(3);
  });

  test("a batch of fewer than four explains itself: job.done names each slot that gave nothing, and which left a reserve to reconcile", async () => {
    const { draftId } = await seedDraft(dir());
    const net = network({ image: (_call, n) => (n === 1 ? { reject: new TypeError("fetch failed") } : n === 3 ? MODERATION : portraitReply(n)) });
    const { engine, events } = await startEngine(dir(), { net, init: sequentialInit() });

    const end = await jobEnd(events, jobIdOf(await engine.handle(generate(draftId))));

    expect(end).toMatchObject({
      type: "job.done",
      payload: {
        result: {
          rejectedByAgeCheck: 0,
          failedSlots: [
            { slot: 1, reason: "failed", error: { code: "NETWORK" }, reserveLeftOpen: true },
            { slot: 3, reason: "failed", error: { code: "MODERATION_REFUSED" }, reserveLeftOpen: false },
          ],
        },
      },
    });
    expect(events().filter((e) => e.type === "money.changed").at(-1)).toMatchObject({ payload: { status: { reconcileNeeded: true, unsettledCount: 1 } } });
  });

  test("4 more: a second batch for the same draft adds four more candidates", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, events } = await startEngine(dir());

    await jobEnd(events, jobIdOf(await engine.handle(generate(draftId))));
    await jobEnd(events, jobIdOf(await engine.handle(generate(draftId))));

    expect(engine.library?.photosByAvatar(draftId)).toHaveLength(8);
    expect((await snapshot(engine)).jobs.map((j) => j.status)).toEqual(["done", "done"]);
  });

  test("a second batch for a draft while one runs is refused with IN_FLIGHT; another draft may start its own", async () => {
    const { draftId } = await seedDraft(dir());
    const { library } = await openLibrary(join(dir(), "library"));
    const other = await library.createAvatar({ name: "Draft", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
    const { engine, net, events } = await startEngine(dir(), { net: network({ image: () => ({ hang: true }) }) });

    const first = jobIdOf(await engine.handle(generate(draftId)));
    expect(failed(await engine.handle(generate(draftId))).error.code).toBe("IN_FLIGHT");
    const second = jobIdOf(await engine.handle(generate(other.id)));
    await until(() => net.imageCalls().length === 8, "eight image requests");

    for (const jobId of [first, second]) ok(await engine.handle(command("avatars.cancel", { jobId })));
    await jobEnd(events, first);
    await jobEnd(events, second);
  });

  test("the month's room counts what a running batch has reserved and holds: a second batch without room beside it is refused", async () => {
    const { draftId } = await seedDraft(dir());
    const { library } = await openLibrary(join(dir(), "library"));
    const other = await library.createAvatar({ name: "Draft", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
    // The first batch in flight: four images reserved (160,000 µ$) and their four age checks held (20,000 µ$).
    const monthly = 2 * NEXT_BATCH.worstMicros - 1;
    const net = network({ image: () => ({ hang: true }) });
    const { engine, events } = await startEngine(dir(), { net, init: { settings: engineSettings(dir(), { monthlyBudgetMicros: monthly }) } });
    const first = jobIdOf(await engine.handle(generate(draftId)));
    await until(() => net.imageCalls().length === 4, "four image requests");

    expect(failed(await engine.handle(generate(other.id))).error.code).toBe("BUDGET_EXCEEDED");
    expect(net.imageCalls()).toHaveLength(4);

    ok(await engine.handle(command("avatars.cancel", { jobId: first })));
    await jobEnd(events, first);
  });

  test("a library switch is refused with IN_FLIGHT while a job runs, and allowed once it ended", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, net, posted, events } = await startEngine(dir(), { net: network({ image: () => ({ hang: true }) }) });
    await mkdir(join(dir(), "other"));
    const open = (callId: string) => ({ kind: "control", type: "library.open", callId, path: join(dir(), "other") });

    const jobId = jobIdOf(await engine.handle(generate(draftId)));
    await until(() => net.imageCalls().length === 4, "four image requests");
    await engine.receive(open("call-00000001"));
    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "IN_FLIGHT" } });

    ok(await engine.handle(command("avatars.cancel", { jobId })));
    await jobEnd(events, jobId);
    await engine.receive(open("call-00000002"));
    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000002" });
  });

  test("library.confirm is refused with IN_FLIGHT while a job runs, and allowed once it ended", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, net, posted, events } = await startEngine(dir(), { net: network({ image: () => ({ hang: true }) }) });
    await mkdir(join(dir(), "other"));
    const confirm = (callId: string) => ({ kind: "control", type: "library.confirm", callId, path: join(dir(), "other") });
    // Staged first, while nothing is busy yet: confirm itself has no await
    // left to race, so what matters here is that "other" is staged.
    await engine.receive({ kind: "control", type: "library.open", callId: "call-open-0001", path: join(dir(), "other") });

    const jobId = jobIdOf(await engine.handle(generate(draftId)));
    await until(() => net.imageCalls().length === 4, "four image requests");
    await engine.receive(confirm("call-00000001"));
    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "IN_FLIGHT" } });
    expect(engine.library?.root).toBe(join(dir(), "library"));

    ok(await engine.handle(command("avatars.cancel", { jobId })));
    await jobEnd(events, jobId);
    // An IN_FLIGHT refusal drops the staged entry (main always opens again before it retries confirm).
    await engine.receive({ kind: "control", type: "library.open", callId: "call-open-0002", path: join(dir(), "other") });
    await engine.receive(confirm("call-00000002"));
    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000002" });
    expect(engine.library?.root).toBe(join(dir(), "other"));
  });

  test("a 401 fails the job with AUTH_INVALID and marks the key rejected; no slot starts after it", async () => {
    const { draftId } = await seedDraft(dir());
    const net = network({ image: () => ({ status: 401, body: { error: { message: "No auth credentials found" } } }) });
    const { engine, events } = await startEngine(dir(), { net, init: sequentialInit() });

    const jobId = jobIdOf(await engine.handle(generate(draftId)));
    const end = await jobEnd(events, jobId);

    expect(end).toMatchObject({ type: "job.failed", payload: { jobId, error: { code: "AUTH_INVALID" } } });
    expect(net.imageCalls()).toHaveLength(1);
    expect(events().some((e) => e.type === "settings.changed" && e.payload.settings.apiKey.rejected)).toBe(true);
    expect((await snapshot(engine)).jobs).toMatchObject([{ jobId, status: "failed", error: { code: "AUTH_INVALID" } }]);
  });

  test("an image in a format the client does not take: the job fails, and its bytes are kept nowhere, userData/raw included", async () => {
    const { draftId } = await seedDraft(dir());
    const r = spawnSync(ffmpegPath(), ["-f", "lavfi", "-i", "mandelbrot=size=60x80", "-frames:v", "1", "-f", "gif", "pipe:1"]);
    const gif = new Uint8Array(r.stdout);
    const net = network({ image: () => ({ status: 200, body: imageBody(gif, { cost: 0.04 }) }) });
    const { engine, events } = await startEngine(dir(), { net, init: sequentialInit() });

    const end = await jobEnd(events, jobIdOf(await engine.handle(generate(draftId))));

    expect(end).toMatchObject({ type: "job.failed", payload: { error: { code: "INTERNAL" } } });
    const saved = await filesUnder(join(dir(), "userData", "raw"));
    expect(saved).toHaveLength(1);
    const text = new TextDecoder().decode(await fileBytes(join(dir(), "userData", "raw", saved[0] ?? "")));
    expect(text).toContain(`"sha256":"${sha256(gif)}"`);
    expect(text).not.toContain(Buffer.from(gif).toString("base64").slice(0, 24));
  });

  test("an unusable image body with array-of-number image data (redaction only catches strings) is capped tight on disk: the image attempt's own small keepBytes, not the chat default", async () => {
    const { draftId } = await seedDraft(dir());
    const bytes = Array.from({ length: 50_000 }, (_, i) => i % 256);
    const net = network({ image: () => ({ status: 200, body: JSON.stringify({ data: [{ bytes }] }) }) });
    const { engine, events } = await startEngine(dir(), { net, init: sequentialInit() });

    const end = await jobEnd(events, jobIdOf(await engine.handle(generate(draftId))));

    expect(end).toMatchObject({ type: "job.failed", payload: { error: { code: "INTERNAL" } } });
    const saved = await filesUnder(join(dir(), "userData", "raw"));
    expect(saved).toHaveLength(1);
    const text = new TextDecoder().decode(await fileBytes(join(dir(), "userData", "raw", saved[0] ?? "")));
    // Far below the chat/descriptor default (RAW_PREFIX_BYTES + 4096): the
    // image attempt's own small cap applied, not the larger default.
    expect(Buffer.byteLength(text, "utf8")).toBeLessThan(RAW_KEEP_BYTES_IMAGE + 500);
  });

  test("every image refused by moderation: the job fails with MODERATION_REFUSED and nothing is spent", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, events } = await startEngine(dir(), { net: network({ image: () => MODERATION }) });

    const end = await jobEnd(events, jobIdOf(await engine.handle(generate(draftId))));

    expect(end).toMatchObject({ type: "job.failed", payload: { error: { code: "MODERATION_REFUSED" } } });
    expect(ledgerLines(dir()).filter((l) => l.type === "settle").map((l) => l.costMicros)).toEqual([0, 0, 0, 0]);
  });

  test("a missing ffmpeg is a slot error, not a crash: no age check is paid, nothing is stored, and the engine goes on", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, net, events } = await startEngine(dir());
    __setFfmpegPathOverrideForTests(join(dir(), "no-such-ffmpeg"));
    try {
      const end = await jobEnd(events, jobIdOf(await engine.handle(generate(draftId))));

      expect(end).toMatchObject({ type: "job.failed", payload: { error: { code: "INTERNAL", detail: expect.stringContaining("age check") } } });
      expect(net.ageCalls()).toHaveLength(0);
      expect(engine.library?.photosByAvatar(draftId)).toEqual([]);
    } finally {
      __setFfmpegPathOverrideForTests(undefined);
    }
    expect((await snapshot(engine)).drafts).toHaveLength(1);
  });
});

describe("avatars.generateCandidates: checked before anything is spent", () => {
  async function refusedWith(code: ErrorCode, setup: { key?: string | null; init?: Partial<EngineInit>; accepted?: number; draftId?: string } = {}) {
    const seeded = await seedDraft(dir());
    const { engine, net } = await startEngine(dir(), { key: setup.key, init: setup.init });
    const ledgerBefore = ledgerLines(dir());
    const refused = failed(await engine.handle(generate(setup.draftId ?? seeded.draftId, setup.accepted)));
    expect(refused.error.code).toBe(code);
    expect(net.paidCalls()).toHaveLength(0);
    expect(ledgerLines(dir())).toEqual(ledgerBefore);
    expect((await snapshot(engine)).jobs).toEqual([]);
    return { engine, seeded };
  }

  test("without a key: AUTH_INVALID", async () => {
    await refusedWith("AUTH_INVALID", { key: null });
  });

  test("with a key OpenRouter rejected: AUTH_INVALID", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, net } = await startEngine(dir());
    engine.markKeyRejected(KEY);

    expect(failed(await engine.handle(generate(draftId))).error.code).toBe("AUTH_INVALID");
    expect(net.paidCalls()).toHaveLength(0);
  });

  test("after a restart with open reserves: RECONCILE_REQUIRED (invariant 4)", async () => {
    await writeLedger(dir(), [
      { type: "reserve", attemptId: "old#1", jobId: "job-old", scope: { avatarJobId: "job-old" }, model: "x-ai/grok-4.3", worstMicros: 5_000, at: "2026-09-24T11:00:00.000Z" },
    ]);
    await refusedWith("RECONCILE_REQUIRED");
  });

  test("a ledger that cannot be read: its cause", async () => {
    await mkdir(join(dir(), "userData", "ledger.jsonl"), { recursive: true });
    await refusedWith("LEDGER_UNREADABLE");
  });

  test("without a library: LIBRARY_UNAVAILABLE", async () => {
    await refusedWith("LIBRARY_UNAVAILABLE", { init: { settings: engineSettings(dir(), { libraryPath: join(dir(), "missing") }) } });
  });

  test("an unknown id and a saved avatar: NOT_FOUND", async () => {
    const { engine, seeded } = await refusedWith("NOT_FOUND", { draftId: "nobody-00000000" });
    expect(failed(await engine.handle(generate(seeded.avatarId))).error.code).toBe("NOT_FOUND");
  });

  test("a draft whose stored descriptor fails today's rules: DESCRIPTOR_INVALID, not INTERNAL (mandatory 3c)", async () => {
    const { draftId } = await seedDraft(dir(), { descriptor: "25-year-old European woman with a youthful smile." });
    const { engine, net } = await startEngine(dir());

    const refused = failed(await engine.handle(generate(draftId)));

    expect(refused.error).toMatchObject({ code: "DESCRIPTOR_INVALID", detail: expect.stringContaining("descriptor") });
    expect(net.paidCalls()).toHaveLength(0);
    expect(ledgerLines(dir())).toEqual([]);
  });

  test("accepted exactly at the batch's worst case it starts; one micro-dollar below: PRICE_CHANGED", async () => {
    const { engine, seeded } = await refusedWith("PRICE_CHANGED", { accepted: NEXT_BATCH.worstMicros - 1 });

    jobIdOf(await engine.handle(generate(seeded.draftId, NEXT_BATCH.worstMicros)));
  });

  test("a monthly budget without room for the batch's worst case: BUDGET_EXCEEDED", async () => {
    await refusedWith("BUDGET_EXCEEDED", { init: { settings: engineSettings(dir(), { monthlyBudgetMicros: NEXT_BATCH.worstMicros - 1 }) } });
  });

  test("the checks run in the order the UI expects: key, ledger, library, draft, descriptor, price, month", async () => {
    await writeLedger(dir(), [
      { type: "reserve", attemptId: "old#1", jobId: "job-old", scope: { avatarJobId: "job-old" }, model: "x-ai/grok-4.3", worstMicros: 5_000, at: "2026-09-24T11:00:00.000Z" },
    ]);
    const { draftId } = await seedDraft(dir(), { descriptor: "25-year-old European woman with a youthful smile." });
    const cheap = engineSettings(dir(), { monthlyBudgetMicros: 1 });
    const noKey = await startEngine(dir(), { key: null, init: { settings: { ...cheap, libraryPath: join(dir(), "missing") } } });
    expect(failed(await noKey.engine.handle(generate(draftId, 1))).error.code).toBe("AUTH_INVALID");
    const noLedger = await startEngine(dir(), { init: { settings: { ...cheap, libraryPath: join(dir(), "missing") } } });
    expect(failed(await noLedger.engine.handle(generate(draftId, 1))).error.code).toBe("RECONCILE_REQUIRED");
  });

  test("…then library before draft, draft before descriptor, descriptor before price, price before the month", async () => {
    const stale = await seedDraft(dir(), { descriptor: "25-year-old European woman with a youthful smile." });
    const good = await seedDraft(dir());
    const cheap = engineSettings(dir(), { monthlyBudgetMicros: 1 });
    const noLibrary = await startEngine(dir(), { init: { settings: { ...cheap, libraryPath: join(dir(), "missing") } } });
    expect(failed(await noLibrary.engine.handle(generate("nobody-00000000", 1))).error.code).toBe("LIBRARY_UNAVAILABLE");
    const { engine, net } = await startEngine(dir(), { init: { settings: cheap } });
    expect(failed(await engine.handle(generate("nobody-00000000", 1))).error.code).toBe("NOT_FOUND");
    expect(failed(await engine.handle(generate(stale.draftId, 1))).error.code).toBe("DESCRIPTOR_INVALID");
    expect(failed(await engine.handle(generate(good.draftId, 1))).error.code).toBe("PRICE_CHANGED");
    expect(failed(await engine.handle(generate(good.draftId))).error.code).toBe("BUDGET_EXCEEDED");
    expect(net.paidCalls()).toHaveLength(0);
  });
});

// ---------- reconcile while a paid job runs ----------

describe("money.reconcile while a paid job runs", () => {
  test("is refused with IN_FLIGHT even when no request is out at that moment (the job is between its steps)", async () => {
    const { draftId } = await seedDraft(dir());
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const { engine, net, events } = await startEngine(dir(), { net: network({ prices: async () => (await held, OFFLINE) }) });

    const generating = engine.handle(generate(draftId));
    await until(() => net.calls.length > 0, "the price fetch");
    expect(engine.budget?.inFlightCount()).toBe(0);

    expect(failed(await engine.handle(command("money.reconcile"))).error.code).toBe("IN_FLIGHT");

    release();
    await jobEnd(events, jobIdOf(await generating));
    const after = await engine.handle(command("money.reconcile"));
    expect(after.ok ? "answered" : after.error.code).not.toBe("IN_FLIGHT");
  });
});

// ---------- cancel ----------

describe("avatars.cancel", () => {
  test("aborts the requests in flight and starts no new slot; the aborted attempts stay open at their worst case until a reconcile", async () => {
    const { draftId } = await seedDraft(dir());
    const net = network({ image: () => ({ hang: true }) });
    const { engine, events } = await startEngine(dir(), { net, init: { settings: engineSettings(dir(), { concurrency: { network: 2 } }) } });
    const jobId = jobIdOf(await engine.handle(generate(draftId)));
    await until(() => net.imageCalls().length === 2, "two image requests");
    const before = events().length;

    expect(ok(await engine.handle(command("avatars.cancel", { jobId }))).result).toEqual({ jobId });
    await jobEnd(events, jobId);

    expect(net.imageCalls()).toHaveLength(2);
    expect(net.imageCalls().every((c) => c.signal.aborted)).toBe(true);
    expect(ledgerLines(dir()).map((l) => [l.type, l.worstMicros])).toEqual([["reserve", IMAGE_WORST], ["reserve", IMAGE_WORST]]);
    const emitted = jobEvents(events().slice(before), jobId);
    expect(emitted.map((e) => e.type)).toEqual(["money.changed", "job.cancelled"]);
    expect(emitted[0]).toMatchObject({ payload: { status: { unsettledMicros: 2 * IMAGE_WORST, unsettledCount: 2, reconcileNeeded: true, reconcileReasons: ["open-reserves"] } } });
    expect((await snapshot(engine)).jobs).toEqual([{ kind: "avatar.candidates", jobId, avatarId: draftId, status: "cancelled", done: 0, total: 4 }]);
    expect(engine.library?.photosByAvatar(draftId)).toEqual([]);
  });

  test("is idempotent: a cancel of a cancelled or a finished job answers ok and changes nothing", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, events } = await startEngine(dir());
    const jobId = jobIdOf(await engine.handle(generate(draftId)));
    await jobEnd(events, jobId);
    const count = events().length;

    ok(await engine.handle(command("avatars.cancel", { jobId })));
    ok(await engine.handle(command("avatars.cancel", { jobId })));

    expect(events()).toHaveLength(count);
    expect((await snapshot(engine)).jobs).toMatchObject([{ jobId, status: "done" }]);
  });

  test("an unknown job: NOT_FOUND", async () => {
    const { engine } = await startEngine(dir());

    expect(failed(await engine.handle(command("avatars.cancel", { jobId: "job-unknown-0" }))).error.code).toBe("NOT_FOUND");
  });

  test("after a cancel the draft can get a new batch: this engine's own open reserves do not block it", async () => {
    const { draftId } = await seedDraft(dir());
    let hang = true;
    const net = network({ image: (_call, n) => (hang ? { hang: true } : portraitReply(n)) });
    const { engine, events } = await startEngine(dir(), { net });
    const cancelled = jobIdOf(await engine.handle(generate(draftId)));
    await until(() => net.imageCalls().length === 4, "four image requests");
    ok(await engine.handle(command("avatars.cancel", { jobId: cancelled })));
    await jobEnd(events, cancelled);
    hang = false;

    const end = await jobEnd(events, jobIdOf(await engine.handle(generate(draftId))));

    expect(end.type).toBe("job.done");
  });
});

// ---------- restart ----------

describe("after a restart", () => {
  test("there are no avatar jobs, and the reserves the old engine left open wait for a reconcile (invariant 4)", async () => {
    const { draftId } = await seedDraft(dir());
    const oldNet = network({ image: () => ({ hang: true }) });
    const old = await startEngine(dir(), { net: oldNet });
    const oldJob = jobIdOf(await old.engine.handle(generate(draftId)));
    await until(() => oldNet.imageCalls().length === 4, "four image requests");

    const fresh = await startEngine(dir(), { bootId: "boot-0000-bbbb" });
    const state = await snapshot(fresh.engine);

    expect(state.jobs).toEqual([]);
    expect(state.money).toMatchObject({ reconcileNeeded: true, reconcileReasons: ["open-reserves"], unsettledCount: 4 });
    expect(failed(await fresh.engine.handle(generate(draftId))).error.code).toBe("RECONCILE_REQUIRED");
    expect(fresh.net.paidCalls()).toHaveLength(0);

    ok(await old.engine.handle(command("avatars.cancel", { jobId: oldJob })));
    await jobEnd(old.events, oldJob);
  });
});

// ---------- pick ----------

async function draftWithCandidates() {
  const seeded = await seedDraft(dir());
  const started = await startEngine(dir());
  const jobId = jobIdOf(await started.engine.handle(generate(seeded.draftId)));
  await jobEnd(started.events, jobId);
  const candidates = started.engine.library?.photosByAvatar(seeded.draftId) ?? [];
  expect(candidates).toHaveLength(4);
  return { ...seeded, ...started, candidates };
}

function pick(avatarId: string, photoId: string, name = "Lena"): unknown {
  return command("avatars.pick", { avatarId, photoId, name });
}

describe("avatars.pick", () => {
  test("makes the draft an active avatar with the picked candidate as its master and the given name; avatar.changed; the draft is gone", async () => {
    const { engine, events, draftId, candidates } = await draftWithCandidates();
    const chosen = candidates[2]?.id ?? "";
    const before = events().length;

    const answer = ok(await engine.handle(pick(draftId, chosen, "  Lena  ")));

    const avatar = { avatarId: draftId, name: "Lena", descriptor: { age: 25, text: GOOD }, masterPhotoId: chosen, status: "active", photoCount: 1 };
    expect(answer.result).toMatchObject({ avatar });
    expect(events().slice(before).map((e) => e.type)).toEqual(["avatar.changed"]);
    expect(events().at(-1)).toMatchObject({ payload: { avatar } });
    const state = await snapshot(engine);
    expect(state.drafts).toEqual([]);
    expect(state.avatars.find((a) => a.avatarId === draftId)).toMatchObject(avatar);
    expect(engine.library?.getAvatar(draftId)).toMatchObject({ status: "active", name: "Lena", masterPhotoId: chosen });
  });

  test("the other candidates are deleted: different people never become photos or references of the avatar (invariant 9)", async () => {
    const { engine, draftId, candidates } = await draftWithCandidates();
    const chosen = candidates[0];
    if (chosen === undefined) throw new Error("expected a candidate");

    ok(await engine.handle(pick(draftId, chosen.id)));

    expect(engine.library?.photosByAvatar(draftId)).toEqual([chosen]);
    expect(engine.library?.referencePhoto(draftId)?.photo).toEqual(chosen);
    expect(await filesUnder(join(dir(), "library", "avatars", draftId, "photos"))).toEqual([chosen.file, `${chosen.id}.json`].sort());
    const reopened = await openLibrary(join(dir(), "library"));
    expect(reopened.library.photosByAvatar(draftId).map((p) => p.id)).toEqual([chosen.id]);
    expect(reopened.report.quarantined).toEqual([]);
  });

  test.skipIf(process.platform === "win32")("a pick whose manifest cannot be written answers INTERNAL, and every paid candidate stays", async () => {
    const { engine, draftId, candidates } = await draftWithCandidates();
    const avatarDir = join(dir(), "library", "avatars", draftId);
    await chmod(avatarDir, 0o555);
    try {
      expect(failed(await engine.handle(pick(draftId, candidates[0]?.id ?? ""))).error.code).toBe("INTERNAL");
    } finally {
      await chmod(avatarDir, 0o755);
    }

    expect(engine.library?.getAvatar(draftId)?.status).toBe("draft");
    expect(engine.library?.photosByAvatar(draftId)).toEqual(candidates);
    expect(await filesUnder(join(avatarDir, "photos"))).toEqual(candidates.flatMap((c) => [c.file, `${c.id}.json`]).sort());
  });

  test("after a crash in the middle of deleting a candidate (its sidecar gone, its image left) the draft can still be picked", async () => {
    const { draftId, candidates } = await draftWithCandidates();
    const [kept, dropped] = candidates;
    if (kept === undefined || dropped === undefined) throw new Error("expected candidates");
    await rm(join(dir(), "library", "avatars", draftId, "photos", `${dropped.id}.json`));

    const restarted = await startEngine(dir(), { bootId: "boot-0000-cccc" });
    expect((await snapshot(restarted.engine)).drafts[0]?.candidates).toHaveLength(candidates.length - 1);
    ok(await restarted.engine.handle(pick(draftId, kept.id)));

    expect(restarted.engine.library?.photosByAvatar(draftId)).toEqual([kept]);
    expect(await filesUnder(join(dir(), "library", "quarantine"))).toEqual(expect.arrayContaining([expect.stringContaining(dropped.file)]));
  });

  test("refuses a photo that is not one of the draft's age-checked candidates, and changes nothing", async () => {
    const { engine, events, draftId, masterId, candidates } = await draftWithCandidates();
    const unchecked = await engine.library?.addPhoto(draftId, PNG_1X1, samplePhotoMeta());
    const count = events().length;

    expect(failed(await engine.handle(pick(draftId, masterId))).error.code).toBe("NOT_FOUND");
    expect(failed(await engine.handle(pick(draftId, unchecked?.id ?? ""))).error.code).toBe("NOT_FOUND");
    expect(failed(await engine.handle(pick(draftId, "photo-unknown-0"))).error.code).toBe("NOT_FOUND");

    expect(events()).toHaveLength(count);
    expect(engine.library?.getAvatar(draftId)?.status).toBe("draft");
    expect(engine.library?.photosByAvatar(draftId)).toHaveLength(candidates.length + 1);
  });

  test("refuses while a candidate job runs for the draft: IN_FLIGHT", async () => {
    const { draftId } = await seedDraft(dir());
    const { library } = await openLibrary(join(dir(), "library"));
    const candidate = await library.addPhoto(draftId, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
    const net = network({ image: () => ({ hang: true }) });
    const { engine, events } = await startEngine(dir(), { net });
    const jobId = jobIdOf(await engine.handle(generate(draftId)));

    expect(failed(await engine.handle(pick(draftId, candidate.id))).error.code).toBe("IN_FLIGHT");

    ok(await engine.handle(command("avatars.cancel", { jobId })));
    await jobEnd(events, jobId);
    ok(await engine.handle(pick(draftId, candidate.id)));
  });

  test("a saved avatar or an unknown id: NOT_FOUND", async () => {
    const { avatarId, masterId } = await seedDraft(dir());
    const { engine } = await startEngine(dir());

    expect(failed(await engine.handle(pick(avatarId, masterId))).error.code).toBe("NOT_FOUND");
    expect(failed(await engine.handle(pick("nobody-00000000", masterId))).error.code).toBe("NOT_FOUND");
  });

  test("without a library: LIBRARY_UNAVAILABLE", async () => {
    const { engine } = await startEngine(dir(), { init: { settings: engineSettings(dir(), { libraryPath: join(dir(), "missing") }) } });

    expect(failed(await engine.handle(pick("draft-00000001", "photo-00000001"))).error.code).toBe("LIBRARY_UNAVAILABLE");
  });
});

// ---------- archive ----------

describe("avatars.archive", () => {
  test("archives a saved avatar: avatar.changed, and it is listed as archived", async () => {
    const { avatarId, masterId } = await seedDraft(dir());
    const { engine, events } = await startEngine(dir());
    const before = events().length;

    const answer = ok(await engine.handle(command("avatars.archive", { avatarId })));

    expect(answer.result).toMatchObject({ avatar: { avatarId, status: "archived", masterPhotoId: masterId } });
    expect(events().slice(before)).toMatchObject([{ type: "avatar.changed", payload: { avatar: { avatarId, status: "archived" } } }]);
    expect((await snapshot(engine)).avatars).toMatchObject([{ avatarId, status: "archived" }]);
    expect(engine.library?.getAvatar(avatarId)?.status).toBe("archived");
  });

  test("an archived avatar archived again is answered as it is, without an event", async () => {
    const { avatarId } = await seedDraft(dir());
    const { engine, events } = await startEngine(dir());
    ok(await engine.handle(command("avatars.archive", { avatarId })));
    const count = events().length;

    expect(ok(await engine.handle(command("avatars.archive", { avatarId }))).result).toMatchObject({ avatar: { avatarId, status: "archived" } });
    expect(events()).toHaveLength(count);
  });

  test("a draft or an unknown id: NOT_FOUND", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine } = await startEngine(dir());

    expect(failed(await engine.handle(command("avatars.archive", { avatarId: draftId }))).error.code).toBe("NOT_FOUND");
    expect(failed(await engine.handle(command("avatars.archive", { avatarId: "nobody-00000000" }))).error.code).toBe("NOT_FOUND");
  });

  test("refused while a job runs for it: IN_FLIGHT", async () => {
    const { draftId } = await seedDraft(dir());
    const { engine, events } = await startEngine(dir(), { net: network({ image: () => ({ hang: true }) }) });
    const jobId = jobIdOf(await engine.handle(generate(draftId)));

    expect(failed(await engine.handle(command("avatars.archive", { avatarId: draftId }))).error.code).toBe("IN_FLIGHT");

    ok(await engine.handle(command("avatars.cancel", { jobId })));
    await jobEnd(events, jobId);
  });

  test("without a library: LIBRARY_UNAVAILABLE", async () => {
    const { engine } = await startEngine(dir(), { init: { settings: engineSettings(dir(), { libraryPath: join(dir(), "missing") }) } });

    expect(failed(await engine.handle(command("avatars.archive", { avatarId: "avatar-00000001" }))).error.code).toBe("LIBRARY_UNAVAILABLE");
  });
});
