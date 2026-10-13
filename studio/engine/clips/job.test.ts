import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { CLIP_JOB_STEPS, JobProgress, type ClipFace, type ClipMotionChoice, type ClipRequest } from "../../shared/engine";
import { tempDirFor } from "../../testing/tempDir";
import { isTempName } from "../library/durableFs";
import { JobRegistry, type ClipPhaseUpdate } from "../jobs";
import type { ReserveRefusal } from "../money/budget";
import { VIDEO_TIERS } from "../money/prices";
import { JPEG } from "../openrouter/testing/fakes";
import type { VideoRequest } from "../openrouter/types";
import type { AttemptPlan, AttemptSummary, ClipRunDeps, ClipRunInput, ClipRunResult, LateAttempt, LateResult } from "./attempt";
import type { ClipDownload } from "./download";
import { frameFactsOf, type FrameFacts } from "./frameFacts";
import { runClipJob, type ClipJobDeps, type ClipJobInput, type ClipJobOutcome } from "./job";
import { clipJournalPath } from "./journal";
import { motionChoicesOf } from "./motion";
import { ClipRecord } from "./schemas";
import { PRICES } from "./testing/attemptRig";
import { planlessPhoto } from "./testing/frameFixtures";
import { SHORT_CLIP_TIMINGS } from "./timings";
import type { ClipColour, ValidClip } from "./validate";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V4a1 (plan s5b1 §5.1, §5.3, §5.10, I5.53): the create chain of one clip, with its money state machine scripted (V3b's `runClip` is tested on its own) and its media
// played by fakes (V4b's are tested on their own). What is pinned here is the chain: the phases in order, the first frame before any money, the money closed exactly once and before the
// download, the poster drawn under a fresh temp name, the face check given the clip's own colour and a real log, and the record as the commit, with the journal gone after it.

const dir = tempDirFor({ beforeEach, afterEach }, "studio-clip-job-");
const CLIP = "clip-00000001";
const AVATAR = "avatar-0001";
const AT = "2026-10-13T12:00:00.000Z";
const SUBMITTED = "2026-10-13T12:00:05.000Z";
const COLOUR: ClipColour = { matrix: 1, fullRange: false, dynamicRange: "sdr" };
const VALID: ValidClip = { colour: COLOUR, width: 720, height: 1280, durationMs: 5_041, fps: 24, hasAudio: false, bytes: 1234 };
const SHA = "e".repeat(64);
const FACE: ClipFace = { verdict: "match", p75: 0.71, frames: 11 };

function facts(overrides: Partial<FrameFacts> = {}): FrameFacts {
  const result = frameFactsOf(planlessPhoto("home", { faceCos: 0.7 }), null);
  if (result.kind !== "gallery") throw new Error("expected a gallery photo");
  return { ...result.facts, capture: "selfie", face: "yes", faceRole: "judged", ...overrides };
}

function motionOf(f: FrameFacts): ClipMotionChoice {
  const motion = motionChoicesOf(f)[0];
  if (motion === undefined) throw new Error("no motion for these facts");
  return motion;
}

function input(overrides: Partial<ClipJobInput> = {}): ClipJobInput {
  const f = overrides.facts ?? facts();
  const request: ClipRequest = { model: "kling", quality: "std", seconds: 5, fallback: "auto" };
  return {
    clipId: CLIP,
    avatarId: AVATAR,
    photoId: f.photoId,
    photo: JPEG,
    facts: f,
    motion: motionOf(f),
    request,
    acceptedWorstMicros: 850_000,
    prices: PRICES,
    mode: "auto",
    boldClips: "kling-only",
    clipsDir: dir(),
    createdAt: AT,
    ...overrides,
  };
}

const KLING_ATTEMPT: AttemptSummary = { attemptId: `${CLIP}:video#1`, model: "kling", providerJobId: "job-kling", outcome: "completed", providerCostMicros: 420_000, costSource: "usage" };
const COMPLETED: ClipRunResult = {
  kind: "completed",
  attempts: [KLING_ATTEMPT],
  attemptId: KLING_ATTEMPT.attemptId,
  model: "kling",
  providerJobId: "job-kling",
  providerCostMicros: 420_000,
  costSource: "usage",
  fallbackUsed: false,
  aboveWorst: null,
};

interface World {
  deps: ClipJobDeps;
  readonly order: string[];
  readonly phases: ClipPhaseUpdate[];
  readonly logs: string[];
  readonly bodies: VideoRequest[];
  readonly firstFrames: { model: string; quality: string }[];
  posterOutPaths: string[];
  faceOptions: { colour: unknown; role: unknown; log: unknown; masterEmbedding: unknown }[];
  moneyClosed: number;
  notices: ReserveRefusal[];
}

interface Script {
  /** What the money state machine ends with; it plays the phases of an accepted Kling attempt first unless told otherwise. */
  result?: ClipRunResult;
  /** Called with the run's deps and input before it answers: a test plays phases or builds bodies here. */
  during?: (deps: ClipRunDeps, input: ClipRunInput) => Promise<void> | void;
  download?: ClipDownload;
  late?: LateResult;
  firstFrame?: Awaited<ReturnType<NonNullable<NonNullable<ClipJobDeps["media"]>["makeFirstFrame"]>>>;
  embedding?: Float32Array | null;
}

function world(script: Script = {}): World {
  const w: World = {
    order: [],
    phases: [],
    logs: [],
    bodies: [],
    firstFrames: [],
    posterOutPaths: [],
    faceOptions: [],
    moneyClosed: 0,
    notices: [],
    deps: undefined as unknown as ClipJobDeps,
  };
  const deps: ClipJobDeps = {
    attempt: {
      budget: {} as ClipRunDeps["budget"],
      client: {} as ClipRunDeps["client"],
      holds: { hold: () => {}, release: () => {} },
      timings: SHORT_CLIP_TIMINGS,
      now: () => Date.parse(AT),
      sleep: async () => {},
    },
    download: { downloadVideo: async () => ({ kind: "failed", cause: "network", httpStatus: null, detail: "unused" }) },
    faceGate: { check: async () => ({ kind: "no-face" }) as never },
    masterEmbedding: async () => {
      w.order.push("embedding");
      return script.embedding === undefined ? new Float32Array([0.1, 0.2]) : script.embedding;
    },
    onPhase: (update) => {
      w.phases.push(update);
      w.order.push(`phase:${update.phase}`);
    },
    onMoneyClosed: () => {
      w.moneyClosed++;
      w.order.push("money-closed");
    },
    onMoneyNotice: (refusal) => void w.notices.push(refusal),
    log: (line) => void w.logs.push(line),
    run: async (runDeps, runInput) => {
      w.order.push("run");
      await runDeps.journal.requested({ clipId: runInput.clipId, photoId: runInput.photoId, request: runInput.request, motion: runInput.motion, acceptedWorstMicros: runInput.acceptedWorstMicros, at: AT });
      if (script.during !== undefined) await script.during(runDeps, runInput);
      else {
        runDeps.onPhase?.({ phase: "submitting", model: "kling" });
        runDeps.onPhase?.({ phase: "rendering", model: "kling", submittedAt: SUBMITTED });
      }
      return script.result ?? COMPLETED;
    },
    awaitLate: async () => script.late ?? { kind: "failed", reason: "late" },
    media: {
      makeFirstFrame: async (options) => {
        w.order.push(`first-frame:${options.model}:${options.quality}`);
        w.firstFrames.push({ model: options.model, quality: options.quality });
        return script.firstFrame ?? { ok: true, jpeg: JPEG, width: 720, height: 1280 };
      },
      downloadClip: async (options) => {
        w.order.push("download");
        const answer = script.download ?? { kind: "saved", path: join(options.clipsDir, `${options.clipId}.mp4`), sha256: SHA, clip: VALID };
        if (answer.kind === "saved") await writeFile(answer.path, "mp4 bytes");
        return answer;
      },
      makePoster: async (options) => {
        w.order.push("poster");
        w.posterOutPaths.push(options.outPath);
        if (existsSync(options.outPath)) throw new Error("ffmpeg never overwrites: the poster's temp name must be fresh");
        options.log("a poster line");
        await writeFile(options.outPath, "jpeg bytes");
      },
      checkClipFace: async (options) => {
        w.order.push("face");
        w.faceOptions.push({ colour: options.colour, role: options.role, log: options.log, masterEmbedding: options.masterEmbedding });
        options.log("a face line");
        return options.role === "judged" ? FACE : { verdict: "skipped", frames: 0, why: options.role };
      },
    },
  };
  w.deps = deps;
  return w;
}

async function run(w: World, overrides: Partial<ClipJobInput> = {}, signal: AbortSignal = new AbortController().signal): Promise<ClipJobOutcome> {
  return runClipJob(w.deps, input(overrides), signal);
}

function recordOf(outcome: ClipJobOutcome): ClipRecord {
  if (outcome.kind !== "recorded") throw new Error(`expected a record, got ${outcome.kind}`);
  return outcome.record;
}

async function onDisk(): Promise<ClipRecord> {
  return ClipRecord.parse(JSON.parse(await readFile(join(dir(), `${CLIP}.json`), "utf8")));
}

describe("runClipJob: a clip that completes", () => {
  test("goes preparing → the attempt's phases → downloading → checking → saving, every step within the total", async () => {
    const w = world();
    await run(w);

    expect(w.phases.map((p) => p.phase)).toEqual(["preparing", "submitting", "rendering", "downloading", "checking", "saving"]);
    const registry = new JobRegistry();
    registry.startClip("job-00000099", { avatarId: AVATAR, clipId: CLIP });
    for (const update of w.phases) {
      const progress = registry.clipPhase("job-00000099", update);
      expect(JobProgress.safeParse(progress).success).toBe(true);
      expect(progress?.done ?? 99).toBeLessThanOrEqual(CLIP_JOB_STEPS);
    }
    expect(w.phases.map((p) => p.done ?? 0)).toEqual([0, 0, 0, 1, 2, 3]);
  });

  test("commits a ready record: the provider's file, the poster, the face, its attempts; the journal is gone", async () => {
    const w = world();
    const record = recordOf(await run(w));

    expect(record).toEqual(await onDisk());
    expect(record).toMatchObject({
      id: CLIP,
      avatarId: AVATAR,
      createdAt: AT,
      seen: false,
      recovered: false,
      exports: [],
      request: { model: "kling", quality: "std", seconds: 5, fallback: "auto" },
      provider: { model: "kling-std", attempts: [{ attemptId: `${CLIP}:video#1`, providerJobId: "job-kling", outcome: "completed", providerCostMicros: 420_000, costSource: "usage" }] },
      outcome: { status: "ready", file: `${CLIP}.mp4`, posterFile: `${CLIP}.poster.jpg`, width: 720, height: 1280, durationMs: 5_041, fps: 24, bytes: 1234, sha256: SHA, face: FACE },
    });
    expect((await readdir(dir())).sort()).toEqual([`${CLIP}.json`, `${CLIP}.mp4`, `${CLIP}.poster.jpg`]);
    expect(existsSync(clipJournalPath(dir(), CLIP))).toBe(false);
  });

  test("closes the money exactly once, when the attempts end and before the download", async () => {
    const w = world();
    await run(w);
    expect(w.moneyClosed).toBe(1);
    expect(w.order.indexOf("money-closed")).toBeGreaterThan(w.order.indexOf("run"));
    expect(w.order.indexOf("money-closed")).toBeLessThan(w.order.indexOf("download"));
  });

  test("draws the poster under a fresh temp name in the clips folder and renames it, even over a stale poster", async () => {
    const w = world();
    await writeFile(join(dir(), `${CLIP}.poster.jpg`), "stale");
    await run(w);

    expect(w.posterOutPaths).toHaveLength(1);
    const temp = w.posterOutPaths[0] ?? "";
    expect(isTempName(basename(temp))).toBe(true);
    expect(join(temp, "..")).toBe(join(dir()));
    expect(await readFile(join(dir(), `${CLIP}.poster.jpg`), "utf8")).toBe("jpeg bytes");
    expect((await readdir(dir())).filter((name) => isTempName(name))).toEqual([]);
  });

  test("gives the face check the clip's own colour, the photo's role, the master embedding and a log that reaches the engine's", async () => {
    const w = world();
    await run(w);

    expect(w.faceOptions).toHaveLength(1);
    expect(w.faceOptions[0]).toMatchObject({ colour: COLOUR, role: "judged", masterEmbedding: new Float32Array([0.1, 0.2]) });
    expect(w.logs).toContain("a face line");
    expect(w.logs).toContain("a poster line");
  });

  test("takes the master embedding of a judged photo in preparing, before any money", async () => {
    const w = world();
    await run(w);
    expect(w.order.indexOf("embedding")).toBeGreaterThan(-1);
    expect(w.order.indexOf("embedding")).toBeLessThan(w.order.indexOf("run"));
  });

  test("a photo whose face was never judged takes no embedding, and its clip says why", async () => {
    const w = world();
    const record = recordOf(await run(w, { facts: facts({ faceRole: "hidden", face: "no", capture: "mirror-hidden" }) }));
    expect(w.order).not.toContain("embedding");
    expect(record.outcome).toMatchObject({ status: "ready", face: { verdict: "skipped", frames: 0, why: "hidden" } });
  });

  test("a judged photo whose master cannot be embedded keeps its clip, unchecked (`worker`), and the check is never run against nothing", async () => {
    const w = world({ embedding: null });
    const record = recordOf(await run(w));
    expect(w.order).not.toContain("face");
    expect(record.outcome).toMatchObject({ status: "ready", face: { verdict: "skipped", frames: 0, why: "worker" } });
  });

  test("with no face gate the clip is kept, unchecked (`worker`)", async () => {
    const w = world();
    const record = recordOf(await runClipJob({ ...w.deps, faceGate: null }, input(), new AbortController().signal));
    expect(w.order).not.toContain("embedding");
    expect(record.outcome).toMatchObject({ status: "ready", face: { verdict: "skipped", why: "worker" } });
  });

  test("a Grok fallback is recorded as Grok, with both attempts", async () => {
    const grok: AttemptSummary = { attemptId: `${CLIP}:video#2`, model: "grok", providerJobId: "job-grok", outcome: "completed", providerCostMicros: 710_000, costSource: "usage" };
    const kling: AttemptSummary = { attemptId: `${CLIP}:video#1`, model: "kling", providerJobId: "job-kling", outcome: "refused", costSource: "proof" };
    const w = world({ result: { ...COMPLETED, attempts: [kling, grok], attemptId: grok.attemptId, model: "grok", providerJobId: "job-grok", providerCostMicros: 710_000, fallbackUsed: true } });
    const record = recordOf(await run(w));
    expect(record.provider).toEqual({
      model: "grok",
      attempts: [
        { attemptId: `${CLIP}:video#1`, providerJobId: "job-kling", outcome: "refused", costSource: "proof" },
        { attemptId: `${CLIP}:video#2`, providerJobId: "job-grok", outcome: "completed", providerCostMicros: 710_000, costSource: "usage" },
      ],
    });
  });
});

describe("runClipJob: the request bodies", () => {
  async function bodiesFor(request: ClipRequest, plans: AttemptPlan[]): Promise<{ w: World; bodies: VideoRequest[] }> {
    const bodies: VideoRequest[] = [];
    const w = world({
      during: async (_deps, runInput) => {
        for (const plan of plans) bodies.push(await runInput.buildRequest(plan));
      },
    });
    await run(w, { request, acceptedWorstMicros: 1_550_000 });
    return { w, bodies };
  }

  const plan = (n: 1 | 2, model: "kling" | "grok", tier: "std" | "pro" | "grok"): AttemptPlan => ({
    n,
    attemptId: `${CLIP}:video#${n}`,
    model,
    tier,
    modelId: VIDEO_TIERS[tier].model,
    resolution: VIDEO_TIERS[tier].resolution,
    seconds: 5,
    reserveMicros: 1,
  });

  test("Kling's body says no audio; Grok's carries no audio flag at all; both are 9:16 with the first frame as a JPEG data URL", async () => {
    const { bodies } = await bodiesFor({ model: "kling", quality: "std", seconds: 5, fallback: "auto" }, [plan(1, "kling", "std"), plan(2, "grok", "grok")]);
    expect(bodies[0]).toMatchObject({ model: VIDEO_TIERS.std.model, resolution: "720p", aspect_ratio: "9:16", generate_audio: false, duration: 5 });
    expect(bodies[1]).toMatchObject({ model: VIDEO_TIERS.grok.model, resolution: "720p", aspect_ratio: "9:16", duration: 5 });
    expect(bodies[1]).not.toHaveProperty("generate_audio");
    for (const body of bodies) expect(body.frame_images[0]?.image_url.url.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(bodies[0]?.prompt.endsWith("She is an adult woman.")).toBe(true);
  });

  test("a pro clip that may fall back makes Grok's own 720p first frame in preparing, before any money", async () => {
    const { w } = await bodiesFor({ model: "kling", quality: "pro", seconds: 5, fallback: "auto" }, [plan(1, "kling", "pro"), plan(2, "grok", "grok")]);
    expect(w.firstFrames).toEqual([
      { model: "kling", quality: "pro" },
      { model: "grok", quality: "pro" },
    ]);
    expect(w.order.indexOf("first-frame:grok:pro")).toBeLessThan(w.order.indexOf("run"));
  });

  test("a std clip, or one that cannot fall back, makes one first frame only", async () => {
    const std = await bodiesFor({ model: "kling", quality: "std", seconds: 5, fallback: "auto" }, []);
    expect(std.w.firstFrames).toHaveLength(1);
    const none = await bodiesFor({ model: "kling", quality: "pro", seconds: 5, fallback: "none" }, []);
    expect(none.w.firstFrames).toHaveLength(1);
  });
});

describe("runClipJob: a clip that fails", () => {
  test("records a refused clip with its attempts, and no file", async () => {
    const refused: AttemptSummary = { attemptId: `${CLIP}:video#1`, model: "kling", providerJobId: "job-kling", outcome: "refused", costSource: "proof" };
    const w = world({ result: { kind: "failed", reason: "refused-free", attempts: [refused], model: "kling", cost: "free", grokOffer: false, aboveWorst: null } });
    const record = recordOf(await run(w, { request: { model: "kling", quality: "std", seconds: 5, fallback: "none" }, acceptedWorstMicros: 504_000 }));

    expect(record).toEqual(await onDisk());
    expect(record.outcome).toEqual({ status: "failed", reason: "refused-free" });
    expect(record.provider).toEqual({ model: "kling-std", attempts: [{ attemptId: `${CLIP}:video#1`, providerJobId: "job-kling", outcome: "refused", costSource: "proof" }] });
    expect(await readdir(dir())).toEqual([`${CLIP}.json`]);
    expect(w.order).not.toContain("download");
    expect(w.moneyClosed).toBe(1);
  });

  test("a download that failed is a paid failure that can be fetched again until the submit + 60 min", async () => {
    const w = world({ download: { kind: "failed", reason: "download-failed", detail: "network" } });
    const record = recordOf(await run(w));
    const until = new Date(Date.parse(SUBMITTED) + SHORT_CLIP_TIMINGS.lateGiveUpMs).toISOString();
    expect(record.outcome).toEqual({ status: "failed", reason: "download-failed", retryDownloadUntil: until });
    expect(record.provider.attempts[0]).toMatchObject({ outcome: "completed", costSource: "usage" });
  });

  test("an invalid file and a full disk can be fetched again too; a file that is gone cannot", async () => {
    for (const reason of ["invalid-file", "disk-full"] as const) {
      const record = recordOf(await run(world({ download: { kind: "failed", reason, detail: "x" } })));
      expect(record.outcome).toMatchObject({ status: "failed", reason, retryDownloadUntil: expect.any(String) });
    }
    const gone = recordOf(await run(world({ download: { kind: "failed", reason: "download-expired", detail: "410" } })));
    expect(gone.outcome).toEqual({ status: "failed", reason: "download-expired" });
  });

  test("a poster that cannot be drawn makes the paid file `invalid-file`, and leaves neither the file nor a temp", async () => {
    const w = world();
    const failing: ClipJobDeps = { ...w.deps, media: { ...w.deps.media, makePoster: async () => Promise.reject(new Error("ffmpeg could not decode the frame")) } };
    const outcome = await runClipJob(failing, input(), new AbortController().signal);
    expect(recordOf(outcome).outcome).toMatchObject({ status: "failed", reason: "invalid-file", retryDownloadUntil: expect.any(String) });
    expect(await readdir(dir())).toEqual([`${CLIP}.json`]);
  });
});

describe("runClipJob: a late clip", () => {
  const late: LateAttempt = { attemptId: `${CLIP}:video#1`, model: "kling", providerJobId: "job-kling", submittedAtMs: Date.parse(SUBMITTED), giveUpAtMs: Date.parse(SUBMITTED) + 3_600 };
  const lateAttempt: AttemptSummary = { attemptId: `${CLIP}:video#1`, model: "kling", providerJobId: "job-kling", outcome: "late", costSource: "none" };

  test("that arrives is downloaded and recorded ready, its attempt completed with no cost of the ledger's", async () => {
    const w = world({ result: { kind: "late", attempts: [lateAttempt], late }, late: { kind: "completed", providerCostMicros: 420_000 } });
    const record = recordOf(await run(w));
    expect(record.outcome).toMatchObject({ status: "ready" });
    expect(record.provider.attempts).toEqual([{ attemptId: `${CLIP}:video#1`, providerJobId: "job-kling", outcome: "completed", providerCostMicros: 420_000, costSource: "none" }]);
    expect(w.moneyClosed).toBe(1);
    expect(w.order.indexOf("money-closed")).toBeLessThan(w.order.indexOf("download"));
  });

  test("that never arrives is recorded failed `late`", async () => {
    const w = world({ result: { kind: "late", attempts: [lateAttempt], late }, late: { kind: "failed", reason: "late" } });
    const record = recordOf(await run(w));
    expect(record.outcome).toEqual({ status: "failed", reason: "late" });
    expect(record.provider.attempts).toEqual([{ attemptId: `${CLIP}:video#1`, providerJobId: "job-kling", outcome: "late", costSource: "none" }]);
  });

  test("that is stopped by a shutdown writes no record and keeps the journal for the restart", async () => {
    const w = world({ result: { kind: "late", attempts: [lateAttempt], late }, late: { kind: "interrupted" } });
    expect(await run(w)).toEqual({ kind: "interrupted" });
    expect(await readdir(dir())).toEqual([`${CLIP}.journal.jsonl`]);
  });
});

describe("runClipJob: nothing reserved, cancelled, stopped", () => {
  const budgetRefusal: ReserveRefusal = { ok: false, reason: "BUDGET_EXCEEDED", limitMicros: 1, committedMicros: 1, worstMicros: 1 };
  const reconcileRefusal: ReserveRefusal = { ok: false, reason: "RECONCILE_REQUIRED", openAttempts: 1, torn: false };

  test("the first reserve refused: no record, the journal removed, the job refused with the budget's own code", async () => {
    const w = world({ result: { kind: "not-reserved", refusal: budgetRefusal, afterFreeRefusal: false, attempts: [] } });
    const outcome = await run(w);
    expect(outcome).toMatchObject({ kind: "refused", error: { code: "BUDGET_EXCEEDED" } });
    expect(await readdir(dir())).toEqual([]);
    expect(w.moneyClosed).toBe(1);
  });

  test("Grok's reserve refused by RECONCILE_REQUIRED behind a free Kling ends `refused-free` and announces the money", async () => {
    const refused: AttemptSummary = { attemptId: `${CLIP}:video#1`, model: "kling", providerJobId: "job-kling", outcome: "refused", costSource: "proof" };
    const w = world({ result: { kind: "not-reserved", refusal: reconcileRefusal, afterFreeRefusal: true, attempts: [refused] } });
    const record = recordOf(await run(w));
    expect(record.outcome).toEqual({ status: "failed", reason: "refused-free" });
    expect(record.provider.model).toBe("kling-std");
    expect(w.notices).toEqual([reconcileRefusal]);
  });

  test("cancelled in preparing: the money state machine never runs, nothing is written", async () => {
    const controller = new AbortController();
    const w = world();
    const outcome = runClipJob({ ...w.deps, media: { ...w.deps.media, makeFirstFrame: async () => {
      controller.abort();
      return { ok: true, jpeg: JPEG, width: 720, height: 1280 };
    } } }, input(), controller.signal);
    expect(await outcome).toEqual({ kind: "cancelled" });
    expect(w.order).not.toContain("run");
    expect(await readdir(dir())).toEqual([]);
    expect(w.moneyClosed).toBe(1);
  });

  test("cancelled by the attempt before its POST: the journal it wrote is removed, no record", async () => {
    const w = world({ result: { kind: "cancelled", attempts: [] } });
    expect(await run(w)).toEqual({ kind: "cancelled" });
    expect(await readdir(dir())).toEqual([]);
  });

  test("stopped after the POST: no record, the journal stays for the restart", async () => {
    const w = world({ result: { kind: "interrupted", attempts: [] } });
    expect(await run(w)).toEqual({ kind: "interrupted" });
    expect(await readdir(dir())).toEqual([`${CLIP}.journal.jsonl`]);
  });

  test("a photo the first frame cannot use is refused with its clip reason, before any money and with nothing written", async () => {
    for (const reason of ["photo-unreadable", "not-vertical"] as const) {
      const w = world({ firstFrame: { ok: false, reason } });
      const outcome = await run(w);
      expect(outcome).toMatchObject({ kind: "refused", error: { code: "VALIDATION", clipReason: reason } });
      expect(w.order).not.toContain("run");
      expect(await readdir(dir())).toEqual([]);
    }
  });

  test("the proof phase hands its window on, and the next phase does not carry it", async () => {
    const w = world({
      during: (deps) => {
        deps.onPhase?.({ phase: "submitting", model: "kling" });
        deps.onPhase?.({ phase: "rendering", model: "kling", submittedAt: SUBMITTED });
        deps.onPhase?.({ phase: "proving", model: "kling", proveUntil: AT, content: true });
        deps.onPhase?.({ phase: "submitting", model: "grok" });
        deps.onPhase?.({ phase: "rendering", model: "grok", submittedAt: SUBMITTED });
      },
      result: { ...COMPLETED, model: "grok", fallbackUsed: true },
    });
    await run(w);
    const proving = w.phases.find((p) => p.phase === "proving");
    expect(proving).toMatchObject({ model: "kling", proveUntil: AT });
    for (const phase of w.phases.filter((p) => p.phase !== "proving")) expect(phase).not.toHaveProperty("proveUntil");
  });
});
