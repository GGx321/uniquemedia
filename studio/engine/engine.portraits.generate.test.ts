import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventMessage, PortraitsResult, type ErrorCode, type JobState } from "../shared/engine";
import { referencePortraitPrompt } from "./avatars/prompts";
import { NoFaceInReferenceError } from "./face/noFaceError";
import { isPortraitPhoto } from "./library/portraits";
import { manifestTraits } from "./avatars/records";
import type { EngineDeps } from "./engine";
import { openLibrary } from "./library";
import { samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { chatBody, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import {
  ageReply,
  command,
  engineSettings,
  failed,
  GOOD,
  jobEnd,
  ledgerLines,
  MODERATION,
  network,
  OFFLINE,
  ok,
  portraitPng,
  portraitReply,
  startEngine,
  TRAITS,
  until,
  useEngineDir,
  writeLedger,
  type Network,
} from "./testing/engineHarness";
import { fakeGate, match, seedImportedAvatar, type GateRig } from "./testing/portraitKit";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, S5.3c: `avatars.generatePortraits` and the `avatar.portraits` job, against a real engine over a real library in a temp dir, a fake OpenRouter and a scripted face gate. The
// batch is paid (5 × an image with one reference), claims the avatar like a run does, and every refusal before the first image is free.

const dir = useEngineDir("studio-engine-portraits-gen-");

/** grok-imagine-image-quality is $0.05 at 1K, plus $0.01 for the one reference; the age check's ceiling is $0.00525. */
const MODEL = "x-ai/grok-imagine-image-quality";
const SLOT_WORST = 60_000;
const AGE_WORST = 5_250;
const BATCH_OFF = 5 * SLOT_WORST;
const BATCH_ON = 5 * (SLOT_WORST + AGE_WORST);

function settings(patch: Partial<Parameters<typeof engineSettings>[1]> = {}) {
  return engineSettings(dir(), { imageModel: MODEL, imageQuality: null, imageAgeCheck: "off", concurrency: { network: 1 }, ...patch });
}

interface StartOpts {
  gate?: GateRig | null;
  settings?: ReturnType<typeof settings>;
  net?: Network;
  key?: string | null;
  deps?: Partial<EngineDeps>;
}

async function started(opts: StartOpts = {}) {
  const rig = opts.gate === undefined ? fakeGate() : opts.gate;
  const net = opts.net ?? network({ image: (_call, n) => portraitReply(n) });
  const result = await startEngine(dir(), {
    net,
    ...(opts.key === undefined ? {} : { key: opts.key }),
    init: { settings: opts.settings ?? settings() },
    deps: { ...(rig === null ? {} : { portraitFaceGate: rig.gate }), ...opts.deps },
  });
  return { ...result, net, rig };
}

const generate = (avatarId: string, acceptedWorstMicros: number = BATCH_OFF) => command("avatars.generatePortraits", { avatarId, acceptedWorstMicros });

function jobIdOf(response: Parameters<typeof ok>[0]): string {
  const answer = ok(response);
  if (answer.type !== "avatars.generatePortraits") throw new Error(`expected a generatePortraits answer, got ${answer.type}`);
  return answer.result.jobId;
}

async function snapshotJobs(engine: Awaited<ReturnType<typeof started>>["engine"]): Promise<JobState[]> {
  const answer = ok(await engine.handle(command("engine.snapshot")));
  if (answer.type !== "engine.snapshot") throw new Error("wrong type");
  return answer.result.jobs;
}

/** The result of a `job.done` event for the job. */
function resultOf(end: EventMessage) {
  if (end.type !== "job.done" || end.payload.result.kind !== "avatar.portraits") throw new Error(`expected a portraits job.done, got ${end.type}`);
  expect(PortraitsResult.safeParse(end.payload.result).success).toBe(true);
  return end.payload.result;
}

// ---------- the batch ----------

describe("avatars.generatePortraits: the batch", () => {
  test("answers the job id at once; five images, each 9:16 with the imported photo as its one reference and the portrait prompt", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const { engine, net, events } = await started();

    const jobId = jobIdOf(await engine.handle(generate(avatarId)));
    await jobEnd(events, jobId);

    const bodies = net.imageCalls().map((c) => c.json());
    expect(bodies).toHaveLength(5);
    const prompt = referencePortraitPrompt({ age: 25, text: GOOD });
    for (const body of bodies) {
      expect(body).toMatchObject({ model: MODEL, prompt, aspect_ratio: "9:16", resolution: "1K", input_references: [{ type: "image_url", image_url: { url: expect.stringMatching(/^data:image\/jpeg;base64,/) } }] });
    }
  });

  test("the snapshot lists the running job while the images are in flight", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const { engine, net, events } = await started({ net: network({ image: () => ({ hang: true }) }) });

    const jobId = jobIdOf(await engine.handle(generate(avatarId)));
    await until(() => net.imageCalls().length === 1, "the first image request");

    expect(await snapshotJobs(engine)).toEqual([{ kind: "avatar.portraits", jobId, avatarId, status: "running", done: 0, total: 5 }]);
    ok(await engine.handle(command("avatars.cancel", { jobId })));
    await jobEnd(events, jobId);
  });

  test("ranks every image against the imported photo's embedding, and stores only the likenesses of 0.55 and over, best first in the result", async () => {
    const { avatarId, sourceId } = await seedImportedAvatar(dir());
    const rig = fakeGate({
      verdicts: [match(0.76), match(0.72), match(0.61), { kind: "mismatch", similarity: 0.48, faces: 1, headRatio: 0.3 }, { kind: "no-face", faces: 0 }],
      embed: async () => Float32Array.of(7, 8, 9),
    });
    const { engine, events } = await started({ gate: rig });

    const jobId = jobIdOf(await engine.handle(generate(avatarId)));
    const result = resultOf(await jobEnd(events, jobId));

    expect(rig.checked.map((c) => Array.from(c.embedding))).toEqual(Array.from({ length: 5 }, () => [7, 8, 9]));
    const stored = engine.library?.photosByAvatar(avatarId).filter(isPortraitPhoto) ?? [];
    expect(stored.map((p) => [p.source.kind === "generated" ? p.source.slot : null, p.qa.faceCos]).sort()).toEqual([["portrait-1", 0.76], ["portrait-2", 0.72], ["portrait-3", 0.61]]);
    expect(result.candidates.map((c) => c.likeness)).toEqual([0.76, 0.72, 0.61]);
    expect(result.candidates.every((c) => c.avatarId === avatarId && stored.some((p) => p.id === c.photoId))).toBe(true);
    expect(result.failedSlots).toEqual([{ slot: 4, reason: "unlike", likeness: 0.48 }, { slot: 5, reason: "no-face" }]);
    // The imported photo is still the master, and nothing but the three portraits was added.
    expect(engine.library?.getAvatar(avatarId)?.masterPhotoId).toBe(sourceId);
    expect(engine.library?.photosByAvatar(avatarId)).toHaveLength(4);
  });

  test("a likeness of exactly 0.55 is stored and 0.5499 is not", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const rig = fakeGate({ verdicts: [match(0.55), { kind: "mismatch", similarity: 0.5499, faces: 1, headRatio: 0.3 }, { kind: "multiple-faces", faces: 2 }, match(0.56), match(0.57)] });
    const { engine, events } = await started({ gate: rig });

    const result = resultOf(await jobEnd(events, jobIdOf(await engine.handle(generate(avatarId)))));

    expect(result.candidates.map((c) => c.likeness)).toEqual([0.57, 0.56, 0.55]);
    expect(result.failedSlots).toEqual([{ slot: 2, reason: "unlike", likeness: 0.5499 }, { slot: 3, reason: "multiple-faces" }]);
  });

  test("a moderation refusal of one image is free and not retried; the others go on", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const net = network({ image: (_call, n) => (n === 5 ? MODERATION : portraitReply(n)) });
    const { engine, events } = await started({ net });

    const result = resultOf(await jobEnd(events, jobIdOf(await engine.handle(generate(avatarId)))));

    expect(net.imageCalls()).toHaveLength(5);
    expect(result.candidates).toHaveLength(4);
    expect(result.failedSlots).toMatchObject([{ slot: 5, reason: "failed", error: { code: "MODERATION_REFUSED" }, reserveLeftOpen: false }]);
  });

  test("emits job.progress per slot AFTER the slot's portrait is stored, then money.changed and job.done", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const log: unknown[] = [];
    const seen: { done: number; stored: number }[] = [];
    const engineRef: { current: Awaited<ReturnType<typeof started>>["engine"] | null } = { current: null };
    const { engine } = await started({
      deps: {
        post: (message) => {
          log.push(message);
          const parsed = EventMessage.safeParse(message);
          if (parsed.success && parsed.data.type === "job.progress") {
            // B1: a window re-reading `avatars.portraits` on this progress must see the portrait the slot just stored.
            seen.push({ done: parsed.data.payload.done, stored: engineRef.current?.library?.photosByAvatar(avatarId).filter(isPortraitPhoto).length ?? -1 });
          }
        },
      },
    });
    engineRef.current = engine;
    const events = () => log.flatMap((m) => (EventMessage.safeParse(m).success ? [EventMessage.parse(m)] : []));
    const before = events().length;

    const jobId = jobIdOf(await engine.handle(generate(avatarId)));
    await jobEnd(events, jobId);

    expect(seen).toEqual([1, 2, 3, 4, 5].map((n) => ({ done: n, stored: n })));
    expect(events().slice(before).map((e) => e.type)).toEqual(["job.progress", "job.progress", "job.progress", "job.progress", "job.progress", "money.changed", "job.done"]);
    expect(events().filter((e) => e.type === "job.progress").map((e) => e.payload)).toEqual([1, 2, 3, 4, 5].map((done) => ({ kind: "avatar.portraits", jobId, avatarId, done, total: 5 })));
  });

  test("reserves every attempt in the job's own scope under its own ids, capped at the batch's worst case; the cap goes when the job ends", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    let probe: unknown = null;
    const engineRef: { current: Awaited<ReturnType<typeof started>>["engine"] | null } = { current: null };
    const net = network({
      image: async (_call, n) => {
        if (n === 1) {
          const jobId = String(ledgerLines(dir())[0]?.jobId);
          probe = await engineRef.current?.budget?.tryReserve({ attemptId: "probe#1", jobId, scope: { avatarJobId: jobId }, model: "x-ai/grok-4.3", worstMicros: BATCH_OFF });
        }
        return portraitReply(n);
      },
    });
    const { engine, events } = await started({ net });
    engineRef.current = engine;

    const jobId = jobIdOf(await engine.handle(generate(avatarId)));
    await jobEnd(events, jobId);

    // Probed while the first image's reserve (60,000 µ$) was open in the job's scope.
    expect(probe).toMatchObject({ ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: BATCH_OFF, committedMicros: SLOT_WORST });
    const reserves = ledgerLines(dir()).filter((l) => l.type === "reserve");
    expect(reserves.map((r) => r.attemptId)).toEqual([1, 2, 3, 4, 5].map((n) => `${jobId}:portrait-${n}#1`));
    expect(reserves.every((r) => r.jobId === jobId && r.worstMicros === SLOT_WORST && JSON.stringify(r.scope) === JSON.stringify({ avatarJobId: jobId }))).toBe(true);
    expect(await engine.budget?.tryReserve({ attemptId: "late#1", jobId, scope: { avatarJobId: jobId }, model: "x-ai/grok-4.3", worstMicros: 1 })).toMatchObject({ ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: 0 });
  });

  test("the cap is set before the first reserve and money.changed follows its removal", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const { engine, events } = await started();

    const jobId = jobIdOf(await engine.handle(generate(avatarId)));
    await jobEnd(events, jobId);

    expect(events().filter((e) => e.type === "money.changed").at(-1)).toMatchObject({ payload: { status: { spentMicros: 5 * 40_000, unsettledCount: 0 } } });
  });

  test("with the age check on, an image that ranked out pays no age check and the others do", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const rig = fakeGate({ verdicts: [match(0.7), { kind: "mismatch", similarity: 0.3, faces: 1, headRatio: 0.3 }, match(0.7), { kind: "no-face", faces: 0 }, match(0.7)] });
    const { engine, net, events } = await started({ gate: rig, settings: settings({ imageAgeCheck: "on" }) });

    const jobId = jobIdOf(await engine.handle(generate(avatarId, BATCH_ON)));
    const result = resultOf(await jobEnd(events, jobId));

    expect(net.ageCalls()).toHaveLength(3);
    expect(result.candidates).toHaveLength(3);
    const stored = engine.library?.photosByAvatar(avatarId).filter(isPortraitPhoto) ?? [];
    expect(stored.every((p) => p.qa.age?.adult === true)).toBe(true);
    const ageReserves = ledgerLines(dir()).filter((l) => l.type === "reserve" && String(l.attemptId).endsWith(":age#1"));
    expect(ageReserves.map((l) => l.attemptId)).toEqual([`${jobId}:portrait-1:age#1`, `${jobId}:portrait-3:age#1`, `${jobId}:portrait-5:age#1`]);
  });

  test("an image the age check rejects is not stored and is reported", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const net = network({ image: (_call, n) => portraitReply(n), age: (_call, n) => ageReply(n !== 2) });
    const { engine, events } = await started({ net, settings: settings({ imageAgeCheck: "on" }) });

    const result = resultOf(await jobEnd(events, jobIdOf(await engine.handle(generate(avatarId, BATCH_ON)))));

    expect(result.candidates).toHaveLength(4);
    expect(result.failedSlots).toEqual([{ slot: 2, reason: "age-rejected" }]);
    expect(engine.library?.photosByAvatar(avatarId).filter(isPortraitPhoto)).toHaveLength(4);
  });

  test("when every image ranks out the job is done with no candidate, and the paid attempts are reported", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const rig = fakeGate({ check: async () => ({ kind: "mismatch", similarity: 0.3, faces: 1, headRatio: 0.3 }) });
    const { engine, events } = await started({ gate: rig });

    const result = resultOf(await jobEnd(events, jobIdOf(await engine.handle(generate(avatarId)))));

    expect(result.candidates).toEqual([]);
    expect(result.failedSlots).toHaveLength(5);
    expect(engine.library?.photosByAvatar(avatarId)).toHaveLength(1);
  });

  test("when every image is refused before any verdict the job fails with the first error, and nothing is spent", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const { engine, events } = await started({ net: network({ image: () => MODERATION }) });

    const jobId = jobIdOf(await engine.handle(generate(avatarId)));
    const end = await jobEnd(events, jobId);

    expect(end).toMatchObject({ type: "job.failed", payload: { kind: "avatar.portraits", jobId, avatarId, error: { code: "MODERATION_REFUSED" } } });
    expect(events().filter((e) => e.type === "money.changed").at(-1)).toMatchObject({ payload: { status: { spentMicros: 0, unsettledCount: 0 } } });
  });

  test("a face gate that throws fails the job fatally: INTERNAL, no further image is requested", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const rig = fakeGate({ verdicts: [match(0.7), new Error("the worker died")] });
    const { engine, net, events } = await started({ gate: rig });

    const jobId = jobIdOf(await engine.handle(generate(avatarId)));
    const end = await jobEnd(events, jobId);

    expect(end).toMatchObject({ type: "job.failed", payload: { kind: "avatar.portraits", jobId, error: { code: "INTERNAL" } } });
    expect(net.imageCalls()).toHaveLength(2);
    // The portrait stored before the failure stays, and is listed.
    const list = ok(await engine.handle(command("avatars.portraits", { avatarId })));
    expect(list.type === "avatars.portraits" && list.result.candidates).toHaveLength(1);
  });

  test("a 401 fails the job with AUTH_INVALID and marks the key rejected; no slot starts after it", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const { engine, net, events } = await started({ net: network({ image: () => ({ status: 401, body: { error: { message: "invalid key" } } }) }) });

    const jobId = jobIdOf(await engine.handle(generate(avatarId)));
    const end = await jobEnd(events, jobId);

    expect(end).toMatchObject({ type: "job.failed", payload: { error: { code: "AUTH_INVALID" } } });
    expect(net.imageCalls()).toHaveLength(1);
    expect(failed(await engine.handle(generate(avatarId))).error.code).toBe("AUTH_INVALID");
  });

  test("a cancel aborts the requests in flight: job.cancelled, the reserves stay open until a reconcile, and the stored portraits stay", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const net = network({ image: (_call, n) => (n === 1 ? portraitReply(1) : { hang: true }) });
    const { engine, events } = await started({ net });

    const jobId = jobIdOf(await engine.handle(generate(avatarId)));
    await until(() => net.imageCalls().length === 2, "the second image request");
    ok(await engine.handle(command("avatars.cancel", { jobId })));
    const end = await jobEnd(events, jobId);

    expect(end).toMatchObject({ type: "job.cancelled", payload: { kind: "avatar.portraits", jobId, avatarId } });
    expect(net.imageCalls()).toHaveLength(2);
    expect(events().filter((e) => e.type === "money.changed").at(-1)).toMatchObject({ payload: { status: { unsettledCount: 1, reconcileNeeded: true } } });
    expect(engine.library?.photosByAvatar(avatarId).filter(isPortraitPhoto)).toHaveLength(1);
    expect(await snapshotJobs(engine)).toEqual([{ kind: "avatar.portraits", jobId, avatarId, status: "cancelled", done: 1, total: 5 }]);
  });
});

// ---------- refused before anything is spent ----------

describe("avatars.generatePortraits: checked before anything is spent", () => {
  /** Runs `ask` against a fresh engine and asserts the refusal is free: no request, no ledger line, no job, nothing left claimed. */
  async function refusedWith(code: ErrorCode, avatarOf: () => Promise<string>, opts: StartOpts & { accepted?: number; retry?: boolean } = {}) {
    const avatarId = await avatarOf();
    const { engine, net, rig } = await started(opts);
    const ledgerBefore = ledgerLines(dir());

    const refused = failed(await engine.handle(generate(avatarId, opts.accepted)));

    expect(refused.error.code).toBe(code);
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
    expect(ledgerLines(dir())).toEqual(ledgerBefore);
    expect(await snapshotJobs(engine)).toEqual([]);
    // Nothing stays claimed: a retry meets the same refusal, never IN_FLIGHT.
    if (opts.retry !== false) expect(failed(await engine.handle(generate(avatarId, opts.accepted))).error.code).toBe(code);
    return { engine, net, rig, avatarId, refused };
  }

  const imported = async () => (await seedImportedAvatar(dir())).avatarId;

  test("without a key: AUTH_INVALID", async () => {
    await refusedWith("AUTH_INVALID", imported, { key: null });
  });

  test("after a restart with open reserves: RECONCILE_REQUIRED", async () => {
    await writeLedger(dir(), [{ type: "reserve", attemptId: "old#1", jobId: "job-old", scope: { avatarJobId: "job-old" }, model: "x-ai/grok-4.3", worstMicros: 5_000, at: "2026-09-24T11:00:00.000Z" }]);
    await refusedWith("RECONCILE_REQUIRED", imported);
  });

  test("without a library: LIBRARY_UNAVAILABLE", async () => {
    const { engine } = await started({ settings: settings({ libraryPath: join(dir(), "missing") }) });

    expect(failed(await engine.handle(generate("avatar-00000001"))).error.code).toBe("LIBRARY_UNAVAILABLE");
  });

  test("an unknown id is NOT_FOUND", async () => {
    const { engine } = await started();

    expect(failed(await engine.handle(generate("avatar-nobody"))).error.code).toBe("NOT_FOUND");
  });

  test("an archived avatar is NOT_FOUND: only an active avatar gets portraits", async () => {
    await refusedWith("NOT_FOUND", async () => (await seedImportedAvatar(dir(), { status: "archived" })).avatarId);
  });

  test("a stored descriptor that fails today's rules: DESCRIPTOR_INVALID, before any price is fetched", async () => {
    await refusedWith("DESCRIPTOR_INVALID", async () => (await seedImportedAvatar(dir(), { descriptor: "a young woman with hazel eyes" })).avatarId);
  });

  test("an avatar with no imported photo: VALIDATION not-imported", async () => {
    const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds("wiz") });
    const mia = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
    const master = await library.addPhoto(mia.id, portraitPng(1), samplePhotoMeta({ width: 60, height: 80 }));
    await library.updateAvatar(mia.id, { status: "active", masterPhotoId: master.id });

    const { refused } = await refusedWith("VALIDATION", async () => mia.id);

    expect(refused.error.portraitReason).toBe("not-imported");
  });

  test("ten pending portraits leave room for a batch of five; eleven do not (15 is the limit)", async () => {
    const ten = await seedImportedAvatar(dir(), { portraits: Array.from({ length: 10 }, () => 0.7) });
    const eleven = await seedImportedAvatar(dir(), { portraits: Array.from({ length: 11 }, () => 0.7) });
    const { engine, events } = await started({ net: network({ image: () => ({ hang: true }) }) });

    const refused = failed(await engine.handle(generate(eleven.avatarId)));
    expect(refused.error).toMatchObject({ code: "VALIDATION", portraitReason: "too-many-candidates" });
    const jobId = jobIdOf(await engine.handle(generate(ten.avatarId)));

    ok(await engine.handle(command("avatars.cancel", { jobId })));
    await jobEnd(events, jobId);
  });

  test("no face gate wired: FACE_GATE_UNAVAILABLE", async () => {
    await refusedWith("FACE_GATE_UNAVAILABLE", imported, { gate: null });
  });

  test("a face gate that broke after the start: FACE_GATE_UNAVAILABLE", async () => {
    await refusedWith("FACE_GATE_UNAVAILABLE", imported, { gate: fakeGate({ broken: () => true }) });
  });

  test("a model whose endpoints list no price for a reference image: PRICE_UNAVAILABLE", async () => {
    const flux = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), "imageModels", "fixtures", "endpoints", "black-forest-labs_flux-3-image.json"), "utf8"));
    const net = network({ prices: (call) => (call.url.endsWith("black-forest-labs/flux-3-image/endpoints") ? { status: 200, body: flux } : OFFLINE) });
    await refusedWith("PRICE_UNAVAILABLE", imported, { net, settings: settings({ imageModel: "black-forest-labs/flux-3-image" }) });
  });

  test("accepted exactly at the batch's worst case it starts; one micro-dollar below: PRICE_CHANGED", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const { engine, events } = await started();

    expect(failed(await engine.handle(generate(avatarId, BATCH_OFF - 1))).error.code).toBe("PRICE_CHANGED");
    const jobId = jobIdOf(await engine.handle(generate(avatarId, BATCH_OFF)));
    await jobEnd(events, jobId);
  });

  test("the accepted worst is the age check's too when it is on: $0.30 is not enough then", async () => {
    await refusedWith("PRICE_CHANGED", imported, { settings: settings({ imageAgeCheck: "on" }), accepted: BATCH_OFF });
  });

  test("a monthly budget without room for the batch's worst case: BUDGET_EXCEEDED", async () => {
    await refusedWith("BUDGET_EXCEEDED", imported, { settings: settings({ monthlyBudgetMicros: BATCH_OFF - 1 }) });
  });

  test("a portrait master whose source photo is gone: INTERNAL, free, and the batch is never drawn from the portrait", async () => {
    const seeded = await seedImportedAvatar(dir(), { portraits: [0.76], master: 0 });
    const photos = join(dir(), "library", "avatars", seeded.avatarId, "photos");
    await rm(join(photos, `${seeded.sourceId}.json`));
    const { refused, rig } = await refusedWith("INTERNAL", async () => seeded.avatarId);

    expect(refused.error.detail).toContain("source photo");
    expect(refused.error.portraitReason).toBe("source-unavailable");
    expect(rig?.embedded).toEqual([]);
  });

  test("a source photo with no face: MASTER_FACE_UNUSABLE, tried once and free", async () => {
    const rig = fakeGate({
      embed: async () => {
        throw new NoFaceInReferenceError();
      },
    });
    const { rig: used } = await refusedWith("MASTER_FACE_UNUSABLE", imported, { gate: rig, retry: false });

    expect(used?.embedded).toHaveLength(1);
  });

  // A broken embedding would make every similarity NaN: all five images would be paid and ranked out. It is found for free instead.
  for (const [name, vector] of [["not finite", Float32Array.of(1, Number.NaN, 3)], ["infinite", Float32Array.of(1, Number.POSITIVE_INFINITY, 3)], ["all zero", Float32Array.of(0, 0, 0)], ["empty", new Float32Array(0)]] as const) {
    test(`a source embedding that is ${name} is MASTER_FACE_UNUSABLE, free, with no image request`, async () => {
      const rig = fakeGate({ embed: async () => vector });
      const { refused } = await refusedWith("MASTER_FACE_UNUSABLE", imported, { gate: rig });

      expect(refused.error.detail).toContain("embedding");
    });
  }

  test("the source's embedding is computed from the original, and a decoder failure retries once on the JPEG reference", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const rig = fakeGate({ embed: async (_bytes, call) => (call === 1 ? Promise.reject(new Error("unsupported colour space")) : Float32Array.of(1, 2, 3)) });
    const { engine, events } = await started({ gate: rig });

    await jobEnd(events, jobIdOf(await engine.handle(generate(avatarId))));

    expect(rig.embedded).toHaveLength(2);
    expect(Array.from(rig.embedded[0]?.subarray(0, 4) ?? [])).toEqual([0x89, 0x50, 0x4e, 0x47]);
    expect(Array.from(rig.embedded[1]?.subarray(0, 3) ?? [])).toEqual([0xff, 0xd8, 0xff]);
    expect(rig.checked).toHaveLength(5);
  });

  test("a decoder that fails on both tries is INTERNAL, not a face problem, and free", async () => {
    const rig = fakeGate({ embed: async () => Promise.reject(new Error("decoder crashed")) });
    const { refused } = await refusedWith("INTERNAL", imported, { gate: rig, retry: false });

    expect(refused.error.detail).toContain("source photo");
    expect(rig.embedded).toHaveLength(2);
  });
});

// ---------- claims and locks ----------

describe("avatars.generatePortraits: the claim", () => {
  async function running() {
    const seeded = await seedImportedAvatar(dir(), { portraits: [0.7] });
    const net = network({ image: () => ({ hang: true }) });
    const s = await started({ net });
    const jobId = jobIdOf(await s.engine.handle(generate(seeded.avatarId)));
    await until(() => net.imageCalls().length === 1, "the first image request");
    return { ...s, ...seeded, jobId, finish: async () => {
      ok(await s.engine.handle(command("avatars.cancel", { jobId })));
      await jobEnd(s.events, jobId);
    } };
  }

  test("a second batch, a pick, a discard, an archive and a check meet IN_FLIGHT while the job runs", async () => {
    const r = await running();

    expect(failed(await r.engine.handle(generate(r.avatarId))).error.code).toBe("IN_FLIGHT");
    expect(failed(await r.engine.handle(command("avatars.pickPortrait", { avatarId: r.avatarId, photoId: r.portraitIds[0] ?? "" }))).error.code).toBe("IN_FLIGHT");
    expect(failed(await r.engine.handle(command("avatars.discardPortraits", { avatarId: r.avatarId }))).error.code).toBe("IN_FLIGHT");
    expect(failed(await r.engine.handle(command("avatars.archive", { avatarId: r.avatarId }))).error.code).toBe("IN_FLIGHT");
    expect(failed(await r.engine.handle(command("avatars.checkDescriptor", { avatarId: r.avatarId, acceptedWorstMicros: 1_000_000 }))).error.code).toBe("IN_FLIGHT");
    expect(failed(await r.engine.handle(command("avatars.rewriteDescriptor", { avatarId: r.avatarId, acceptedWorstMicros: 1_000_000 }))).error.code).toBe("IN_FLIGHT");
    await r.finish();
  });

  test("a delete meets IN_FLIGHT while the job runs", async () => {
    const r = await running();

    await r.engine.receive({ kind: "control", type: "avatar.deletePrepare", callId: "call-0000d001", avatarId: r.avatarId, token: "token-00000001" });

    expect(r.posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-0000d001", error: { code: "IN_FLIGHT" } });
    await r.finish();
  });

  test("a photo run meets IN_FLIGHT while the job runs, and the job meets it while a run holds the avatar", async () => {
    const seeded = await seedImportedAvatar(dir());
    const writer = (call: FetchCall): Reply => {
      const messages = Array.isArray(call.json().messages) ? (call.json().messages as { role: string; content: unknown }[]) : [];
      const user = messages.find((m) => m.role === "user");
      const text = typeof user?.content === "string" ? user.content : "";
      const slots = (JSON.parse(text.slice(text.indexOf("["), text.lastIndexOf("]") + 1)) as { slotIndex: number }[]).map((s) => s.slotIndex);
      const scenes = slots.map((slotIndex) => ({ slotIndex, sentence: `A friend catches her mid-laugh at the kitchen counter in the morning light (${slotIndex}).` }));
      return { status: 200, body: chatBody(JSON.stringify({ scenes }), { cost: 0.0112 }) };
    };
    const net = network({ image: () => ({ hang: true }), descriptors: Array.from({ length: 8 }, () => writer) });
    const { engine, events } = await started({ net, deps: { qaGates: [{ name: "face", paid: false, check: async () => ({ verdict: "pass" as const }) }] } });
    const startRun = () => command("runs.start", { avatarId: seeded.avatarId, count: 4, categories: ["home"], poses: { profile: false, back: false }, acceptedWorstMicros: 10_000_000 });

    const jobId = jobIdOf(await engine.handle(generate(seeded.avatarId)));
    await until(() => net.imageCalls().length === 1, "the first image request");
    expect(failed(await engine.handle(startRun())).error.code).toBe("IN_FLIGHT");
    ok(await engine.handle(command("avatars.cancel", { jobId })));
    await jobEnd(events, jobId);

    const run = ok(await engine.handle(startRun()));
    await until(() => net.imageCalls().length === 2, "the run's first image request");
    expect(failed(await engine.handle(generate(seeded.avatarId))).error.code).toBe("IN_FLIGHT");
    if (run.type !== "runs.start") throw new Error("expected a run");
    ok(await engine.handle(command("runs.cancel", { runId: run.result.runId })));
    await jobEnd(events, run.result.jobId);
  });

  test("editing the descriptor and the body stays allowed while the job runs: the prompt took the text at the start", async () => {
    const r = await running();

    ok(await r.engine.handle(command("avatars.editDescriptor", { avatarId: r.avatarId, text: `${GOOD.slice(0, -1)} and cheeks.`, expectedText: GOOD })));
    ok(await r.engine.handle(command("avatars.setBody", { avatarId: r.avatarId, body: { height: "tall" } })));
    ok(await r.engine.handle(command("avatars.dismissBodyProposal", { avatarId: r.avatarId })));
    await r.finish();
  });

  test("a library switch is refused with IN_FLIGHT while the job runs, and allowed once it ended", async () => {
    const r = await running();
    await mkdir(join(dir(), "other"));
    const open = (callId: string) => ({ kind: "control", type: "library.open", callId, path: join(dir(), "other") });

    await r.engine.receive(open("call-00000001"));
    expect(r.posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "IN_FLIGHT" } });
    await r.finish();

    await r.engine.receive(open("call-00000002"));
    expect(r.posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000002" });
  });

  test("a retried command never starts a second paid batch: two at once make one job and five requests", async () => {
    const { avatarId } = await seedImportedAvatar(dir());
    const net = network({ image: () => ({ hang: true }) });
    const { engine, events } = await started({ net });

    const [first, second] = await Promise.all([engine.handle(generate(avatarId)), engine.handle(generate(avatarId))]);
    const answers = [first, second];
    const jobIds = answers.flatMap((a) => (a.ok && a.type === "avatars.generatePortraits" ? [a.result.jobId] : []));
    await until(() => net.imageCalls().length >= 1, "the first image request");

    expect(jobIds).toHaveLength(1);
    expect(answers.flatMap((a) => (a.ok ? [] : [a.error.code]))).toEqual(["IN_FLIGHT"]);
    expect((await snapshotJobs(engine)).filter((j) => j.kind === "avatar.portraits")).toHaveLength(1);
    expect(net.imageCalls()).toHaveLength(1);
    ok(await engine.handle(command("avatars.cancel", { jobId: jobIds[0] ?? "" })));
    await jobEnd(events, jobIds[0] ?? "");
  });

  for (const how of ["done", "failed", "cancelled"] as const) {
    test(`the claim and the paid-command count are released when the job ends ${how}`, async () => {
      const { avatarId } = await seedImportedAvatar(dir());
      const image = how === "cancelled" ? () => ({ hang: true as const }) : how === "failed" ? () => ({ status: 401, body: { error: { message: "invalid key" } } }) : (_c: unknown, n: number) => portraitReply(n);
      const net = network({ image });
      const { engine, events, posted } = await started({ net });
      await mkdir(join(dir(), "other"));

      const jobId = jobIdOf(await engine.handle(generate(avatarId)));
      if (how === "cancelled") {
        await until(() => net.imageCalls().length === 1, "the first image request");
        ok(await engine.handle(command("avatars.cancel", { jobId })));
      }
      await jobEnd(events, jobId);

      // Free again: a discard (an edit-class claim) is taken, and a library switch (the paid-command count) is not refused.
      expect(ok(await engine.handle(command("avatars.discardPortraits", { avatarId }))).type).toBe("avatars.discardPortraits");
      await engine.receive({ kind: "control", type: "library.open", callId: "call-00000001", path: join(dir(), "other") });
      expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000001" });
    });
  }

  test("a pick is counted as a small write: a library switch and a delete's prepare are refused while it commits", async () => {
    const { avatarId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.76, 0.7] });
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let entered = false;
    const { engine, posted } = await started({
      deps: {
        library: {
          testHooks: {
            beforeRename: async (path) => {
              if (path.endsWith("avatar.json")) {
                entered = true;
                await held;
              }
            },
          },
        },
      },
    });
    await mkdir(join(dir(), "other"));

    const picking = engine.handle(command("avatars.pickPortrait", { avatarId, photoId: portraitIds[0] ?? "" }));
    await until(() => entered, "the pick's manifest write");
    await engine.receive({ kind: "control", type: "library.open", callId: "call-00000001", path: join(dir(), "other") });
    expect(posted.at(-1)).toMatchObject({ callId: "call-00000001", error: { code: "IN_FLIGHT" } });
    await engine.receive({ kind: "control", type: "avatar.deletePrepare", callId: "call-00000002", avatarId, token: "token-00000002" });
    expect(posted.at(-1)).toMatchObject({ callId: "call-00000002", error: { code: "IN_FLIGHT" } });
    release();

    ok(await picking);
  });
});

// ---------- restart ----------

describe("avatars.generatePortraits: after a restart", () => {
  test("the open reserves a crashed batch left wait for a reconcile: a new batch is refused RECONCILE_REQUIRED, and the stored portraits are listed", async () => {
    const { avatarId, portraitIds } = await seedImportedAvatar(dir(), { portraits: [0.7] });
    await writeLedger(dir(), [
      { type: "reserve", attemptId: "job-old:portrait-2#1", jobId: "job-old", scope: { avatarJobId: "job-old" }, model: MODEL, worstMicros: SLOT_WORST, at: "2026-09-24T11:00:00.000Z" },
    ]);
    const { engine } = await started();

    expect(failed(await engine.handle(generate(avatarId))).error.code).toBe("RECONCILE_REQUIRED");
    const list = ok(await engine.handle(command("avatars.portraits", { avatarId })));
    expect(list.type === "avatars.portraits" && list.result.candidates.map((c) => c.photoId)).toEqual([portraitIds[0]]);
  });
});
