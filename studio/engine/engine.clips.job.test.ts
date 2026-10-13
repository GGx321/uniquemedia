import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { CLIP_JOB_STEPS, JobProgress, type EventMessage } from "../shared/engine";
import { ClipRecord } from "./clips/schemas";
import {
  clipNetwork,
  clipsDir,
  command,
  create,
  jobEnd,
  jobIdOf,
  phasesOf,
  seedClipAvatar,
  startClipEngine,
  until,
} from "./clips/testing/engineClipKit";
import { ledgerLines, useEngineDir } from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4a1 (plan s5b1 §5.1, I5.45, I5.50, I5.53): a clip job in the real engine, over a fake OpenRouter. create → job → phases → settle → record; one paid clip at a time;
// a cancel before the POST is free, one after it is refused and the job goes on; the job's events carry its phases in order, and its end carries its clip.

setDefaultTimeout(60_000);

const dir = useEngineDir("studio-engine-clips-job-");
const libraryDir = () => join(dir(), "library");

const RISK_CONTROL = "task failed with status: FAIL, message: Failure to pass the risk control system";

function progressOf(events: EventMessage[], jobId: string) {
  return events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" && e.payload.jobId === jobId ? [e.payload] : []));
}

describe("a clip from create to record", () => {
  test("phases in order with done within total; the reserve and its settle in integer micros; the record committed; job.done carries the clip", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir());
    const jobId = jobIdOf(await create(engine, { avatarId, photoId }));
    const end = await jobEnd(engine, jobId);

    expect(end).toMatchObject({ type: "job.done", payload: { jobId, result: { kind: "clip", avatarId, clipId: jobId } } });
    expect(phasesOf(engine, jobId)).toEqual(["preparing", "submitting", "rendering", "downloading", "checking", "saving"]);
    for (const progress of progressOf(engine.events(), jobId)) {
      expect(JobProgress.safeParse(progress).success).toBe(true);
      expect(progress.done).toBeLessThanOrEqual(CLIP_JOB_STEPS);
    }
    expect(progressOf(engine.events(), jobId).find((p) => p.phase === "rendering")).toMatchObject({ model: "kling", submittedAt: expect.any(String) });

    const lines = ledgerLines(dir()).map(({ at: _at, ...line }) => line);
    expect(lines).toEqual([
      { type: "reserve", attemptId: `${jobId}:video#1`, jobId, scope: { avatarJobId: jobId }, model: "kwaivgi/kling-v3.0-std", worstMicros: 504_000 },
      { type: "settle", attemptId: `${jobId}:video#1`, costMicros: 420_000, estimated: false },
    ]);

    const folder = clipsDir(libraryDir(), avatarId);
    expect((await readdir(folder)).sort()).toEqual([`${jobId}.json`, `${jobId}.mp4`, `${jobId}.poster.jpg`]);
    const record = ClipRecord.parse(JSON.parse(await readFile(join(folder, `${jobId}.json`), "utf8")));
    expect(record).toMatchObject({
      id: jobId,
      avatarId,
      sourcePhotoId: photoId,
      request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
      motion: { source: "code", label: "Моргает и улыбается" },
      provider: { model: "kling-std", attempts: [{ attemptId: `${jobId}:video#1`, outcome: "completed", providerCostMicros: 420_000, costSource: "usage" }] },
      outcome: { status: "ready", width: 720, height: 1280, face: { verdict: "skipped", why: "worker" } },
    });
  });

  test("money.changed follows the settle", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir());
    const jobId = jobIdOf(await create(engine, { avatarId, photoId }));
    await jobEnd(engine, jobId);
    const statuses = engine.events().flatMap((e) => (e.type === "money.changed" && e.payload.status.ledger === "open" ? [e.payload.status] : []));
    expect(statuses.some((s) => s.spentMicros === 420_000 && s.unsettledMicros === 0)).toBe(true);
  });

  test("the snapshot lists the running job in its phase, and the finished one as done", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { held: true } }) });
    const jobId = jobIdOf(await create(engine, { avatarId, photoId }));
    await until(() => phasesOf(engine, jobId).includes("rendering"), "rendering");
    const running = await engine.engine.handle(command("engine.snapshot"));
    if (!running.ok || running.type !== "engine.snapshot") throw new Error("no snapshot");
    expect(running.result.jobs).toEqual([expect.objectContaining({ kind: "clip", jobId, status: "running", phase: "rendering", model: "kling" })]);
    engine.net.release("kling");
    await jobEnd(engine, jobId);
  });
});

describe("one paid clip at a time (I5.50)", () => {
  test("two creates with no await between them make exactly one job; the other is IN_FLIGHT `one-at-a-time`, free", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { held: true } }) });
    const [first, second] = await Promise.all([create(engine, { avatarId, photoId }), create(engine, { avatarId, photoId })]);
    expect(first.ok).toBe(true);
    expect(second).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "one-at-a-time" } });
    const jobId = jobIdOf(first);
    engine.net.release("kling");
    await jobEnd(engine, jobId);
    expect(engine.net.posts()).toHaveLength(1);
  });

  test("once the first clip's money closes, a new one is allowed while its download still runs", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const net = clipNetwork({ kling: { content: "held" } });
    const engine = await startClipEngine(dir(), { net });
    const first = jobIdOf(await create(engine, { avatarId, photoId }));
    await until(() => phasesOf(engine, first).includes("downloading"), "the first clip's download");

    const second = await create(engine, { avatarId, photoId });
    expect(second.ok).toBe(true);
    net.releaseContent("kling");
    await jobEnd(engine, first);
    await jobEnd(engine, jobIdOf(second));
  });

  test("an earlier clip's end never gives back a later clip's slot", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const net = clipNetwork({ kling: { content: "held" }, grok: { held: true } });
    const engine = await startClipEngine(dir(), { net, deps: { clipSwitches: { mode: "offer" } } });
    const first = jobIdOf(await create(engine, { avatarId, photoId, acceptedWorstMicros: 504_000 }));
    await until(() => phasesOf(engine, first).includes("downloading"), "the first clip's download");
    // The second clip (the Grok offer) holds the slot in `rendering` while the first one's file is still being fetched.
    const second = jobIdOf(await create(engine, { avatarId, photoId, model: "grok", fallback: "none", acceptedWorstMicros: 850_000 }));
    await until(() => phasesOf(engine, second).includes("rendering"), "the second clip's POST");

    net.releaseContent("kling");
    await jobEnd(engine, first);
    expect(await create(engine, { avatarId, photoId, acceptedWorstMicros: 504_000 })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "one-at-a-time" } });
    expect(await engine.engine.handle(command("money.reconcile"))).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });

    net.release("grok");
    await jobEnd(engine, second);
    expect(await engine.engine.handle(command("money.reconcile"))).toMatchObject({ ok: true, type: "money.reconcile" });
  });

  test("the paid count is balanced on every outcome: a refusal, a cancel and a free refusal", async () => {
    const { avatarId, photoId, masterId } = await seedClipAvatar(libraryDir());
    const net = clipNetwork({ kling: { terminal: { status: "failed", error: RISK_CONTROL } } });
    const engine = await startClipEngine(dir(), { net, deps: { clipSwitches: { mode: "offer" } } });
    const notInFlight = async (): Promise<void> => {
      const answer = await engine.engine.handle(command("money.reconcile"));
      expect(answer).not.toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    };
    expect((await create(engine, { avatarId, photoId: masterId })).ok).toBe(false);
    await notInFlight();
    const cancelled = jobIdOf(await create(engine, { avatarId, photoId, acceptedWorstMicros: 504_000 }));
    await engine.engine.handle(command("avatars.cancel", { jobId: cancelled }));
    await jobEnd(engine, cancelled);
    await notInFlight();
    const refused = jobIdOf(await create(engine, { avatarId, photoId, acceptedWorstMicros: 504_000 }));
    await jobEnd(engine, refused);
    await notInFlight();
  });

  test("a refused create gives the slot back: the next create runs", async () => {
    const { avatarId, photoId, masterId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir());
    expect((await create(engine, { avatarId, photoId: masterId })).ok).toBe(false);
    const jobId = jobIdOf(await create(engine, { avatarId, photoId }));
    expect((await jobEnd(engine, jobId)).type).toBe("job.done");
  });
});

describe("cancel through avatars.cancel", () => {
  test("in `preparing`: cancelled, free, no record and no reserve", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir());
    const jobId = jobIdOf(await create(engine, { avatarId, photoId }));
    const answer = await engine.engine.handle(command("avatars.cancel", { jobId }));
    expect(answer).toMatchObject({ ok: true, result: { jobId } });

    expect(await jobEnd(engine, jobId)).toMatchObject({ type: "job.cancelled", payload: { kind: "clip", jobId, avatarId, clipId: jobId } });
    expect(engine.net.posts()).toHaveLength(0);
    expect(ledgerLines(dir()).filter((l) => l.type === "reserve")).toEqual([]);
    expect(await readdir(clipsDir(libraryDir(), avatarId))).toEqual([]);
  });

  test("after the POST: IN_FLIGHT `submitted`, and the job goes on to its record", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { held: true } }) });
    const jobId = jobIdOf(await create(engine, { avatarId, photoId }));
    await until(() => phasesOf(engine, jobId).includes("rendering"), "rendering");

    expect(await engine.engine.handle(command("avatars.cancel", { jobId }))).toMatchObject({ ok: false, error: { code: "IN_FLIGHT", clipReason: "submitted" } });
    engine.net.release("kling");
    expect((await jobEnd(engine, jobId)).type).toBe("job.done");
  });
});

describe("the clip's cap (I5.46, §5.9)", () => {
  test("is the worst case while the money is open, and is gone when it closes", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { held: true } }) });
    const budget = 10_000_000;
    const jobId = jobIdOf(await create(engine, { avatarId, photoId, acceptedWorstMicros: 900_000 }));
    await until(() => phasesOf(engine, jobId).includes("rendering"), "rendering");
    // The month's room with live caps: min(accepted 900 000, worst 850 000) is held by the running clip, Kling's 504 000 of it reserved.
    expect(engine.engine.monthRoom()?.freeMicros).toBe(budget - 850_000);
    engine.net.release("kling");
    await jobEnd(engine, jobId);
    expect(engine.engine.monthRoom()?.freeMicros).toBe(budget - 420_000);
  });
});

describe("a free refusal in mode auto runs Grok behind Kling", () => {
  test("Kling refused at the poll, proven free: Grok is reserved only after Kling's settle at 0, and makes the clip", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const net = clipNetwork({ kling: { terminal: { status: "failed", error: RISK_CONTROL } }, grok: { terminal: { status: "completed", cost: 0.71 } } });
    const engine = await startClipEngine(dir(), { net });
    const jobId = jobIdOf(await create(engine, { avatarId, photoId }));
    expect((await jobEnd(engine, jobId)).type).toBe("job.done");

    const lines = ledgerLines(dir()).map(({ at: _at, ...line }) => line);
    expect(lines.map((l) => [l.type, l.attemptId, l.type === "reserve" ? l.worstMicros : l.costMicros])).toEqual([
      ["reserve", `${jobId}:video#1`, 504_000],
      ["settle", `${jobId}:video#1`, 0],
      ["reserve", `${jobId}:video#2`, 850_000],
      ["settle", `${jobId}:video#2`, 710_000],
    ]);
    expect(phasesOf(engine, jobId)).toEqual(["preparing", "submitting", "rendering", "proving", "submitting", "rendering", "downloading", "checking", "saving"]);
    const record = ClipRecord.parse(JSON.parse(await readFile(join(clipsDir(libraryDir(), avatarId), `${jobId}.json`), "utf8")));
    expect(record.provider.model).toBe("grok");
  });
});

describe("the face of a judged photo", () => {
  test("is checked on the clip's own frames against the master embedded at the job's start (the portrait gate of the engine)", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const embedded: number[] = [];
    let checks = 0;
    const gate = {
      embed: async (bytes: Uint8Array) => {
        embedded.push(bytes.length);
        return new Float32Array([0.6, 0.8]);
      },
      check: async (input: { masterEmbedding: Float32Array }) => {
        checks++;
        expect([...input.masterEmbedding]).toEqual([0.6000000238418579, 0.800000011920929]);
        return { kind: "match" as const, similarity: 0.8, faces: 1, headRatio: 0.3 };
      },
      isBroken: () => false,
    };
    const engine = await startClipEngine(dir(), { deps: { portraitFaceGate: gate } });
    const jobId = jobIdOf(await create(engine, { avatarId, photoId }));
    expect((await jobEnd(engine, jobId)).type).toBe("job.done");

    expect(embedded).toHaveLength(1);
    expect(checks).toBeGreaterThanOrEqual(10);
    const record = ClipRecord.parse(JSON.parse(await readFile(join(clipsDir(libraryDir(), avatarId), `${jobId}.json`), "utf8")));
    expect(record.outcome).toMatchObject({ status: "ready", face: { verdict: "match", p75: 0.8, frames: checks } });
  });
});

describe("a 401 at the POST", () => {
  test("ends the clip `key-invalid`, free, and marks the key rejected", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const engine = await startClipEngine(dir(), { net: clipNetwork({ kling: { submit: { status: 401, body: { error: { code: 401, message: "No auth credentials found" } } } } }) });
    const jobId = jobIdOf(await create(engine, { avatarId, photoId }));
    expect((await jobEnd(engine, jobId)).type).toBe("job.done");

    const record = ClipRecord.parse(JSON.parse(await readFile(join(clipsDir(libraryDir(), avatarId), `${jobId}.json`), "utf8")));
    expect(record.outcome).toEqual({ status: "failed", reason: "key-invalid" });
    expect(ledgerLines(dir()).filter((l) => l.type === "settle").map((l) => l.costMicros)).toEqual([0]);
    const settings = await engine.engine.handle(command("settings.get"));
    expect(settings).toMatchObject({ ok: true, result: { apiKey: { rejected: true } } });
  });
});

describe("EngineDeps.clipTimings", () => {
  test("reaches the clip: the short set ends a held uncertain submit in about a second, the real set holds it 20 minutes", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const short = await startClipEngine(dir(), { net: clipNetwork({ kling: { submit: { status: 502 } } }) });
    const jobId = jobIdOf(await create(short, { avatarId, photoId }));
    await jobEnd(short, jobId);
    const status = await short.engine.handle(command("money.status"));
    if (!status.ok || status.type !== "money.status" || status.result.ledger !== "open") throw new Error("no status");
    const at = Date.parse(String(ledgerLines(dir()).find((l) => l.type === "reserve")?.at));
    expect(Date.parse(status.result.reconcileAvailableAt ?? "")).toBe(at + 1_200);
    await short.engine.shutdown();
  });

  test("absent, the engine runs the real set", async () => {
    const { avatarId, photoId } = await seedClipAvatar(libraryDir());
    const real = await startClipEngine(dir(), { net: clipNetwork({ kling: { submit: { status: 502 } } }), timings: null });
    const jobId = jobIdOf(await create(real, { avatarId, photoId }));
    await jobEnd(real, jobId);
    const status = await real.engine.handle(command("money.status"));
    if (!status.ok || status.type !== "money.status" || status.result.ledger !== "open") throw new Error("no status");
    const at = Date.parse(String(ledgerLines(dir()).find((l) => l.type === "reserve")?.at));
    expect(Date.parse(status.result.reconcileAvailableAt ?? "")).toBe(at + 20 * 60_000);
    await real.engine.shutdown();
  });
});
