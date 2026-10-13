import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ClipFace, ClipRequest } from "../../shared/engine";
import type { UnsequencedEvent } from "../../shared/engine/events";
import { tempDirFor } from "../../testing/tempDir";
import { EngineFailure } from "../engineFailure";
import { JobRegistry } from "../jobs";
import type { GenerationResult, VideoDownloadResult, VideoPollResult } from "../openrouter/types";
import type { ClipDownload } from "./download";
import type { ClipFaceRole } from "./faceRole";
import { clipJournalPath, type ClipJournal } from "./journal";
import { recoverClips, sweepClipsDir, type ClipRecoveryHost, type RecoveryLibrary, type RecoveryMedia } from "./recover";
import type { ClipJournalLine } from "./schemas";
import { clipRecordPath, journalOf, readClipRecord, writeClipRecord } from "./store";
import { REAL_CLIP_TIMINGS } from "./timings";
import type { ValidClip } from "./validate";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V6 (plan s5b1 §5.12, I5.48, I5.49): what a restart does with the clips folder, row by row of the recovery table. The ledger is handed over as a read-only view with no
// write on it, so a recovery that wanted to write a line could not; the engine-level test pins the ledger file byte for byte on top of that. The network is a fake that counts its calls, the
// media steps are fakes, time is a clock the fake sleep moves.

const dir = tempDirFor({ beforeEach, afterEach }, "studio-clip-recover-");
const MIN = 60_000;
const T0 = Date.parse("2026-10-13T12:00:00.000Z");
const AVATAR = "avatar-0001-aaaa";
const CLIP = "clip-00000001";
const OTHER = "clip-00000002";
const PHOTO = "photo-00000001";
const KLING = `${CLIP}:video#1`;
const GROK = `${CLIP}:video#2`;
const iso = (ms: number): string => new Date(ms).toISOString();
const clipsDir = (): string => join(dir(), "avatars", AVATAR, "clips");
const SHA = "a".repeat(64);
const VALID: ValidClip = { colour: { matrix: 1, fullRange: false, dynamicRange: "sdr" }, width: 720, height: 1280, durationMs: 5_041, fps: 24, hasAudio: false, bytes: 3 };
const FACE: ClipFace = { verdict: "match", p75: 0.71, frames: 11 };

const REQUEST: ClipRequest = { model: "kling", quality: "std", seconds: 5, fallback: "auto" };
const MOTION = { source: "code", label: "Моргает и улыбается", text: "she slowly blinks and gives a small smile" } as const;

const library: RecoveryLibrary = { listAvatars: () => [{ id: AVATAR }], avatarDirPath: (avatarId) => join(dir(), "avatars", avatarId) };

async function writeLines(clipId: string, lines: ClipJournalLine[]): Promise<void> {
  await mkdir(clipsDir(), { recursive: true });
  const journal: ClipJournal = journalOf(clipsDir(), clipId);
  for (const line of lines) {
    const { type, ...rest } = line;
    if (type === "requested") await journal.requested(rest as Omit<Extract<ClipJournalLine, { type: "requested" }>, "type">);
    else if (type === "submitted") await journal.submitted(rest as Omit<Extract<ClipJournalLine, { type: "submitted" }>, "type">);
    else if (type === "ended") await journal.ended(rest as Omit<Extract<ClipJournalLine, { type: "ended" }>, "type">);
    else await journal.downloaded(rest as Omit<Extract<ClipJournalLine, { type: "downloaded" }>, "type">);
  }
}

const requested = (clipId = CLIP, atMs = T0): ClipJournalLine => ({ type: "requested", clipId, photoId: PHOTO, request: REQUEST, motion: MOTION, acceptedWorstMicros: 850_000, at: iso(atMs) });
const submitted = (attemptId: string, atMs: number, model: "kling" | "grok" = "kling"): ClipJournalLine => ({ type: "submitted", attemptId, model, providerJobId: `job-${attemptId.slice(-1)}`, at: iso(atMs) });
const ended = (attemptId: string, atMs: number, status: "completed" | "refused" | "failed", costSource: "usage" | "proof" | "none" = "proof"): ClipJournalLine => ({ type: "ended", attemptId, status, costSource, at: iso(atMs) });

const status = (s: Extract<VideoPollResult, { kind: "status" }>["status"], extra: Partial<Extract<VideoPollResult, { kind: "status" }>> = {}): VideoPollResult => ({
  kind: "status",
  status: s,
  rawStatus: s,
  usageCostMicros: null,
  error: null,
  contentFailure: false,
  generationId: null,
  ...extra,
});

interface Options {
  /** The clock when the recovery starts. */
  now?: number;
  reserves?: { attemptId: string; at: string }[];
  /** The answer to the n-th poll (from 1) of a job. */
  poll?: (providerJobId: string, n: number) => VideoPollResult;
  /** Called on every key request; throw an `EngineFailure` to say there is no key yet. */
  key?: (n: number) => void;
  download?: () => ClipDownload;
  role?: ClipFaceRole | null;
  gate?: boolean;
  embedding?: Float32Array | null;
  /** The clips already running in this process. */
  active?: string[];
  /** Runs after a clip's lock is taken and before the work: a test deletes or records the clip here, as a concurrent command would have between the scan and the act. */
  beforeLocked?: (clipId: string) => Promise<void>;
  /** The library is still the live one (default yes). */
  current?: boolean;
  /** Attempts this process reserved itself. */
  own?: string[];
  /** Holds the registry already has (an earlier open of a library, or the ledger-only start). */
  held?: Record<string, number>;
  /** Called by `isActive` (it answers `active`): lets a test change the world in the middle of step 1. */
  onIsActive?: (clipId: string) => void;
  generation?: GenerationResult;
}

function rig(options: Options = {}) {
  const clock = { now: options.now ?? T0 + 5 * MIN };
  const events: UnsequencedEvent[] = [];
  const held = new Map<string, number>(Object.entries(options.held ?? {}));
  const calls = { locked: [] as string[], poll: [] as string[], download: [] as string[], generation: [] as string[], sleeps: [] as number[], keys: 0, face: [] as { role: ClipFaceRole; colour: unknown; masterEmbedding: Float32Array }[], posters: [] as { colour: unknown; outPath: string }[], embeds: 0 };
  const pollCount = new Map<string, number>();
  const active = new Set(options.active ?? []);
  const stop = new AbortController();
  const jobs = new JobRegistry();
  let ids = 0;
  const media: RecoveryMedia = {
    downloadClip: async (o) => {
      calls.download.push(o.providerJobId);
      if (options.download !== undefined) return options.download();
      const path = join(o.clipsDir, `${o.clipId}.mp4`);
      await writeFile(path, "mp4");
      return { kind: "saved", path, sha256: SHA, clip: VALID };
    },
    makePoster: async (o) => {
      calls.posters.push({ colour: o.colour, outPath: o.outPath });
      await writeFile(o.outPath, "jpg");
    },
    checkClipFace: async (o) => {
      calls.face.push({ role: o.role, colour: o.colour, masterEmbedding: o.masterEmbedding });
      return FACE;
    },
    validateClipFile: async () => ({ ok: true, clip: VALID }),
  };
  const host: ClipRecoveryHost = {
    clock: () => clock.now,
    newId: () => `job-id-${String(++ids).padStart(4, "0")}`,
    timings: REAL_CLIP_TIMINGS,
    holds: { hold: (attemptId, until) => void held.set(attemptId, until), untilOf: (attemptId) => held.get(attemptId) },
    withClipLock: async (clipId, work) => {
      calls.locked.push(clipId);
      await options.beforeLocked?.(clipId);
      return work();
    },
    isCurrent: () => options.current !== false,
    isOwn: (attemptId) => options.own?.includes(attemptId) ?? false,
    signal: stop.signal,
    ledger: () => ({ openReserves: () => options.reserves ?? [], reserveOf: (id) => (options.reserves ?? []).find((r) => r.attemptId === id) }),
    jobs,
    emit: (event) => void events.push(event),
    work: {
      enter: (clipId) => {
        if (active.has(clipId)) return null;
        active.add(clipId);
        return () => void active.delete(clipId);
      },
      anyActive: () => active.size > 0,
      isActive: (clipId) => {
        options.onIsActive?.(clipId);
        return active.has(clipId);
      },
    },
    usableKey: () => {
      options.key?.(++calls.keys);
      return "sk-test";
    },
    openRouter: () => ({
      pollVideo: async (id) => {
        calls.poll.push(id);
        const n = (pollCount.get(id) ?? 0) + 1;
        pollCount.set(id, n);
        return options.poll?.(id, n) ?? status("completed", { usageCostMicros: 420_000, generationId: id });
      },
      downloadVideo: async (): Promise<VideoDownloadResult> => ({ kind: "failed", cause: "network", httpStatus: null, detail: "not used: the media step is a fake" }),
      fetchGeneration: async (id) => {
        calls.generation.push(id);
        return options.generation ?? { kind: "not-found" };
      },
    }),
    sleep: async (ms) => {
      calls.sleeps.push(ms);
      clock.now += ms;
    },
    faceGate: () => (options.gate === false ? null : { check: async () => ({ kind: "no-face" }) as never, isBroken: () => false }),
    faceRoleOf: async () => (options.role === undefined ? "judged" : options.role),
    masterEmbedding: async () => {
      calls.embeds++;
      return options.embedding === undefined ? new Float32Array([0.1, 0.2]) : options.embedding;
    },
    media,
    log: () => undefined,
  };
  const types = (): string[] => events.map((e) => e.type);
  return { host, clock, events, held, calls, active, stop, jobs, types };
}

async function recover(r: ReturnType<typeof rig>): Promise<void> {
  const { jobs } = await recoverClips(r.host, library);
  await Promise.all(jobs);
}

async function recordOf(clipId = CLIP) {
  const read = await readClipRecord(clipsDir(), clipId);
  if (read.kind !== "record") throw new Error(`expected a record, got ${read.kind}`);
  return read.record;
}

const names = async (): Promise<string[]> => (await readdir(clipsDir())).sort();

describe("a journal with only `requested`", () => {
  test("becomes a failed `lost` record, recovered, with no network call and the journal gone", async () => {
    await writeLines(CLIP, [requested()]);
    const r = rig();
    await recover(r);
    const record = await recordOf();
    expect(record).toMatchObject({ id: CLIP, avatarId: AVATAR, sourcePhotoId: PHOTO, recovered: true, outcome: { status: "failed", reason: "lost" } });
    expect(r.calls).toMatchObject({ poll: [], download: [], generation: [] });
    expect(existsSync(clipJournalPath(clipsDir(), CLIP))).toBe(false);
  });

  test("takes the clip's own request, motion and creation time from the journal", async () => {
    await writeLines(CLIP, [requested(CLIP, T0 - 7 * MIN)]);
    await recover(rig());
    expect(await recordOf()).toMatchObject({ createdAt: iso(T0 - 7 * MIN), request: REQUEST, motion: MOTION, seen: false, exports: [] });
  });

  test("is a registered `clip` job in the phase `recovering` that ends with job.done", async () => {
    await writeLines(CLIP, [requested()]);
    const r = rig();
    const { jobs } = await recoverClips(r.host, library);
    expect(jobs).toHaveLength(1);
    expect(r.jobs.hasLiveJobFor(AVATAR)).toBe(true);
    const running = r.jobs.states().find((s) => s.kind === "clip");
    expect(running).toMatchObject({ kind: "clip", avatarId: AVATAR, clipId: CLIP, status: "running" });
    await Promise.all(jobs);
    expect(r.jobs.hasLiveJobFor(AVATAR)).toBe(false);
    expect(r.types()).toContain("job.done");
    expect(r.active.size).toBe(0);
  });

  test("with a reserve in the ledger and no `submitted` line holds that reserve 20 min from its `at`, and still records `lost`", async () => {
    await writeLines(CLIP, [requested()]);
    const reserveAt = T0 + 1_000;
    const r = rig({ reserves: [{ attemptId: KLING, at: iso(reserveAt) }] });
    await recover(r);
    expect(r.held.get(KLING)).toBe(reserveAt + 20 * MIN);
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "lost" });
  });

  test("with no reserve in the ledger holds nothing", async () => {
    await writeLines(CLIP, [requested()]);
    const r = rig();
    await recover(r);
    expect(r.held.size).toBe(0);
  });
});

describe("a submitted attempt with no `ended` line", () => {
  test("whose job completed is downloaded, validated, given a poster and a face check, and recorded ready and recovered", async () => {
    const submittedAt = T0 + 1_000;
    await writeLines(CLIP, [requested(), submitted(KLING, submittedAt)]);
    const r = rig({ role: "hidden" });
    await recover(r);
    const record = await recordOf();
    expect(record).toMatchObject({
      recovered: true,
      provider: { model: "kling-std", attempts: [{ attemptId: KLING, providerJobId: "job-1", outcome: "completed", providerCostMicros: 420_000, costSource: "none" }] },
      outcome: { status: "ready", file: `${CLIP}.mp4`, posterFile: `${CLIP}.poster.jpg`, width: 720, height: 1280, sha256: SHA, face: FACE },
    });
    expect(r.calls.poll).toEqual(["job-1"]);
    expect(r.calls.download).toEqual(["job-1"]);
    expect(await names()).toEqual([`${CLIP}.json`, `${CLIP}.mp4`, `${CLIP}.poster.jpg`]);
  });

  test("polls at once, without waiting a minute first", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig();
    await recover(r);
    expect(r.calls.sleeps).toEqual([]);
  });

  test("holds the attempt 2 min from its terminal status, and writes an `ended` line to the journal first", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({ now: T0 + 5 * MIN });
    await recover(r);
    expect(r.held.get(KLING)).toBe(T0 + 5 * MIN + 2 * MIN);
  });

  test("starts from the submit + 60 min hold, which the terminal status replaces", async () => {
    const submittedAt = T0 + 1_000;
    await writeLines(CLIP, [requested(), submitted(KLING, submittedAt)]);
    const heldAtStart: number[] = [];
    const r = rig({
      poll: () => {
        heldAtStart.push(r.held.get(KLING) ?? -1);
        return status("completed", { usageCostMicros: 420_000, generationId: "job-1" });
      },
    });
    await recover(r);
    expect(heldAtStart).toEqual([submittedAt + 60 * MIN]);
    expect(r.held.get(KLING)).toBe(T0 + 5 * MIN + 2 * MIN);
  });

  test("keeps the provider's number as information only, from the poll's usage", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    await recover(rig({ poll: () => status("completed", { usageCostMicros: 420_000, generationId: "job-1" }) }));
    expect((await recordOf()).provider.attempts[0]).toMatchObject({ providerCostMicros: 420_000, costSource: "none" });
  });

  test("reads /generation once when the poll carries no usage, and records what it finds", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({ poll: () => status("completed", { generationId: "job-1" }), generation: { kind: "found", totalCostMicros: 420_000, finishReason: "stop" } });
    await recover(r);
    expect(r.calls.generation).toEqual(["job-1"]);
    expect((await recordOf()).provider.attempts[0]).toMatchObject({ providerCostMicros: 420_000 });
  });

  test("leaves the provider's number out when neither the poll nor /generation has one", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    await recover(rig({ poll: () => status("completed", { generationId: "job-1" }) }));
    expect((await recordOf()).provider.attempts[0]).not.toHaveProperty("providerCostMicros");
  });

  test("whose job is still running is polled every minute until it completes", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({ poll: (id, n) => (n < 3 ? status("in_progress") : status("completed", { usageCostMicros: 420_000, generationId: id })) });
    await recover(r);
    expect(r.calls.poll).toHaveLength(3);
    expect(r.calls.sleeps).toEqual([REAL_CLIP_TIMINGS.latePollMs, REAL_CLIP_TIMINGS.latePollMs]);
    expect((await recordOf()).outcome.status).toBe("ready");
  });

  test("whose job never ends is given up on at 60 min after the submit, as `late`", async () => {
    const submittedAt = T0 + 1_000;
    await writeLines(CLIP, [requested(), submitted(KLING, submittedAt)]);
    const r = rig({ now: submittedAt + 50 * MIN, poll: () => status("in_progress") });
    await recover(r);
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "late" });
    expect(r.clock.now).toBeGreaterThanOrEqual(submittedAt + 60 * MIN);
    expect(r.clock.now).toBeLessThanOrEqual(submittedAt + 60 * MIN + REAL_CLIP_TIMINGS.latePollMs);
  });

  test("an unreadable poll is tried again, never taken for an end", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({
      poll: (id, n): VideoPollResult => (n === 1 ? { kind: "unreadable", cause: "network", httpStatus: null, detail: "x" } : status("completed", { usageCostMicros: 420_000, generationId: id })),
    });
    await recover(r);
    expect(r.calls.poll).toHaveLength(2);
    expect((await recordOf()).outcome.status).toBe("ready");
  });

  test("that is already 60 min old is not polled at all: `late`", async () => {
    const submittedAt = T0 + 1_000;
    await writeLines(CLIP, [requested(), submitted(KLING, submittedAt)]);
    const r = rig({ now: submittedAt + 60 * MIN });
    await recover(r);
    expect(r.calls.poll).toEqual([]);
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "late" });
  });

  test("that is already 60 min old holds nothing, since its time has passed", async () => {
    const submittedAt = T0 + 1_000;
    await writeLines(CLIP, [requested(), submitted(KLING, submittedAt)]);
    const r = rig({ now: submittedAt + 60 * MIN });
    await recover(r);
    expect(r.held.size).toBe(0);
  });

  test("whose job failed for a content reason is recorded `refused-unknown` (its cost is not proven), held 2 min", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({ poll: () => status("failed", { contentFailure: true, error: "risk control" }) });
    await recover(r);
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "refused-unknown" });
    expect((await recordOf()).provider.attempts[0]).toMatchObject({ outcome: "refused", costSource: "none" });
    expect(r.held.get(KLING)).toBe(T0 + 5 * MIN + 2 * MIN);
    expect(r.calls.download).toEqual([]);
  });

  test.each([
    ["failed", "failed"],
    ["cancelled", "cancelled"],
    ["expired", "expired"],
  ] as const)("whose job is %s is recorded `provider-error` with the attempt as %s", async (providerStatus, outcome) => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    await recover(rig({ poll: () => status(providerStatus) }));
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "provider-error" });
    expect((await recordOf()).provider.attempts[0]).toMatchObject({ outcome });
  });

  test("writes the terminal status to the journal before it downloads, so a crash in between keeps what was learned", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    let lines: ClipJournalLine[] = [];
    const r = rig({
      download: () => {
        throw new Error("replaced below");
      },
    });
    const reading: ClipRecoveryHost = {
      ...r.host,
      media: {
        ...r.host.media,
        downloadClip: async (o) => {
          lines = await journalOf(clipsDir(), CLIP).read();
          const path = join(o.clipsDir, `${o.clipId}.mp4`);
          await writeFile(path, "mp4");
          return { kind: "saved", path, sha256: SHA, clip: VALID };
        },
      },
    };
    const { jobs } = await recoverClips(reading, library);
    await Promise.all(jobs);
    expect(lines.at(-1)).toMatchObject({ type: "ended", attemptId: KLING, status: "completed", providerCostMicros: 420_000, costSource: "none", at: iso(T0 + 5 * MIN) });
  });

  test("a Grok attempt behind a free Kling is polled by Grok's own job, and the record names Grok", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000), ended(KLING, T0 + 90_000, "refused", "proof"), submitted(GROK, T0 + 200_000, "grok")]);
    const r = rig({ reserves: [{ attemptId: KLING, at: iso(T0) }, { attemptId: GROK, at: iso(T0 + 150_000) }] });
    await recover(r);
    expect(r.calls.poll).toEqual(["job-2"]);
    const record = await recordOf();
    expect(record.provider.model).toBe("grok");
    expect(record.provider.attempts.map((a) => [a.attemptId, a.outcome])).toEqual([
      [KLING, "refused"],
      [GROK, "completed"],
    ]);
  });
});

describe("an attempt that ended `completed` in an earlier process", () => {
  test("is downloaded again, with no poll", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000), ended(KLING, T0 + 90_000, "completed", "usage")]);
    const r = rig();
    await recover(r);
    expect(r.calls.poll).toEqual([]);
    expect(r.calls.download).toEqual(["job-1"]);
    expect(await recordOf()).toMatchObject({ recovered: true, outcome: { status: "ready" } });
  });

  test("is `download-expired` after 60 min, with no network call", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000), ended(KLING, T0 + 90_000, "completed", "usage")]);
    const r = rig({ now: T0 + 1_000 + 60 * MIN });
    await recover(r);
    expect(r.calls.download).toEqual([]);
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "download-expired" });
  });
});

describe("a download that fails after a completed status", () => {
  test("is recorded `download-failed` with a free retry until the submit + 60 min", async () => {
    const submittedAt = T0 + 1_000;
    await writeLines(CLIP, [requested(), submitted(KLING, submittedAt)]);
    await recover(rig({ download: () => ({ kind: "failed", reason: "download-failed", detail: "network" }) }));
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "download-failed", retryDownloadUntil: iso(submittedAt + 60 * MIN) });
  });

  test("that the provider says is gone is `download-expired`, with no retry", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    await recover(rig({ download: () => ({ kind: "failed", reason: "download-expired", detail: "410" }) }));
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "download-expired" });
  });

  test("that throws (the disk) is recorded `download-failed` too, with the same free retry", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({
      download: () => {
        throw new Error("EIO");
      },
    });
    await recover(r);
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "download-failed", retryDownloadUntil: iso(T0 + 1_000 + 60 * MIN) });
  });
});

describe("a clip whose face check cannot run", () => {
  test("is kept with the verdict `skipped` for a judged photo when the master's embedding cannot be taken", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({ role: "judged", embedding: null });
    await recover(r);
    expect((await recordOf()).outcome).toMatchObject({ status: "ready", face: { verdict: "skipped", frames: 0, why: "worker" } });
    expect(r.calls.face).toEqual([]);
  });

  test("is kept with the verdict `skipped` for a judged photo when the engine has no face gate", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({ role: "judged", gate: false });
    await recover(r);
    expect((await recordOf()).outcome).toMatchObject({ status: "ready", face: { verdict: "skipped", why: "worker" } });
  });

  test("is `skipped` with the verdict `worker` when the photo's role cannot be known (the photo is gone)", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({ role: null });
    await recover(r);
    expect((await recordOf()).outcome).toMatchObject({ status: "ready", face: { verdict: "skipped", why: "worker" } });
    expect(r.calls.face).toEqual([]);
  });

  test("gets the clip's own colour and the master's embedding when the photo was judged", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({ role: "judged" });
    await recover(r);
    expect(r.calls.face).toHaveLength(1);
    expect(r.calls.face[0]).toMatchObject({ role: "judged", colour: VALID.colour });
    expect(Array.from(r.calls.face[0]?.masterEmbedding ?? [])).toEqual([Math.fround(0.1), Math.fround(0.2)]);
  });

  test("does not take the master's embedding for a photo that was never judged", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({ role: "profile" });
    await recover(r);
    expect(r.calls.embeds).toBe(0);
    expect(r.calls.face[0]?.role).toBe("profile");
  });
});

describe("a journal next to a record", () => {
  test("is removed, and no job runs", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    await writeClipRecord(clipsDir(), {
      schemaVersion: 1,
      id: CLIP,
      avatarId: AVATAR,
      sourcePhotoId: PHOTO,
      createdAt: iso(T0),
      seen: false,
      motion: MOTION,
      request: REQUEST,
      provider: { model: "kling-std", attempts: [] },
      recovered: false,
      exports: [],
      outcome: { status: "failed", reason: "refused-free" },
    });
    const before = await readFile(clipRecordPath(clipsDir(), CLIP), "utf8");
    const r = rig();
    const { jobs } = await recoverClips(r.host, library);
    expect(jobs).toHaveLength(0);
    expect(existsSync(clipJournalPath(clipsDir(), CLIP))).toBe(false);
    expect(await readFile(clipRecordPath(clipsDir(), CLIP), "utf8")).toBe(before);
    expect(r.calls.poll).toEqual([]);
  });

  test("is left alone when the record next to it does not read: nothing is overwritten", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    await writeFile(clipRecordPath(clipsDir(), CLIP), "{ not json");
    const r = rig();
    const { jobs } = await recoverClips(r.host, library);
    expect(jobs).toHaveLength(0);
    expect(await readFile(clipRecordPath(clipsDir(), CLIP), "utf8")).toBe("{ not json");
    expect(existsSync(clipJournalPath(clipsDir(), CLIP))).toBe(true);
  });
});

describe("a journal without a `requested` line", () => {
  test("starts no job and is kept: there is nothing to rebuild a record from", async () => {
    await writeLines(CLIP, [submitted(KLING, T0 + 1_000)]);
    const r = rig();
    const { jobs } = await recoverClips(r.host, library);
    expect(jobs).toHaveLength(0);
    expect(existsSync(clipJournalPath(clipsDir(), CLIP))).toBe(true);
  });

  test("still holds the attempt it names: the money does not forget it", async () => {
    await writeLines(CLIP, [submitted(KLING, T0 + 1_000)]);
    const r = rig();
    await recoverClips(r.host, library);
    expect(r.held.get(KLING)).toBe(T0 + 1_000 + 60 * MIN);
  });
});

describe("the holds of a restart", () => {
  test("hold each attempt by its own latest fact: Kling by its `ended` line, Grok by its reserve", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000), ended(KLING, T0 + 4 * MIN, "refused", "proof")]);
    const grokReservedAt = T0 + 4 * MIN + 10_000;
    const r = rig({
      now: T0 + 5 * MIN,
      reserves: [
        { attemptId: KLING, at: iso(T0) },
        { attemptId: GROK, at: iso(grokReservedAt) },
      ],
    });
    await recoverClips(r.host, library);
    expect(r.held.get(KLING)).toBe(T0 + 4 * MIN + 2 * MIN);
    expect(r.held.get(GROK)).toBe(grokReservedAt + 20 * MIN);
  });

  test("ignore a reserve that belongs to no clip", async () => {
    const r = rig({ reserves: [{ attemptId: "photo-run-0001:slot-1#1", at: iso(T0) }] });
    await mkdir(clipsDir(), { recursive: true });
    await recoverClips(r.host, library);
    expect(r.held.size).toBe(0);
  });

  test("hold an open reserve of a clip with no journal in view 60 min from its `at`: nothing says how far the render got", async () => {
    await mkdir(clipsDir(), { recursive: true });
    const r = rig({ reserves: [{ attemptId: `${OTHER}:video#1`, at: iso(T0) }] });
    await recoverClips(r.host, library);
    expect(r.held.get(`${OTHER}:video#1`)).toBe(T0 + 60 * MIN);
  });

  test("hold a reserve of a clip whose journal is in view by the journal's rules, not the 60 min of a clip with none", async () => {
    await writeLines(CLIP, [requested()]);
    const r = rig({ reserves: [{ attemptId: KLING, at: iso(T0) }] });
    await recoverClips(r.host, library);
    expect(r.held.get(KLING)).toBe(T0 + 20 * MIN);
  });

  test("leave out a reserve this process made itself: its own hold is the registry's", async () => {
    await mkdir(clipsDir(), { recursive: true });
    const r = rig({ reserves: [{ attemptId: `${OTHER}:video#1`, at: iso(T0) }], own: [`${OTHER}:video#1`] });
    await recoverClips(r.host, library);
    expect(r.held.size).toBe(0);
  });

  test("never shorten a hold the registry already has: a later open of a library only extends", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000), ended(KLING, T0 + 4 * MIN, "refused", "proof")]);
    const longer = T0 + 60 * MIN;
    const r = rig({ now: T0 + 5 * MIN, reserves: [{ attemptId: KLING, at: iso(T0) }], held: { [KLING]: longer } });
    await recoverClips(r.host, library);
    expect(r.held.get(KLING)).toBe(longer);
  });

  test("extend a hold the registry has when the journal asks for more", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const shorter = T0 + 10 * MIN;
    let atFirstPoll: number | undefined;
    const r: ReturnType<typeof rig> = rig({
      now: T0 + 5 * MIN,
      reserves: [{ attemptId: KLING, at: iso(T0) }],
      held: { [KLING]: shorter },
      poll: () => {
        atFirstPoll = r.held.get(KLING);
        return status("failed");
      },
    });
    await recover(r);
    expect(atFirstPoll).toBe(T0 + 1_000 + 60 * MIN);
  });

  test("leave an attempt out once its time has passed", async () => {
    const r = rig({ now: T0 + 60 * MIN, reserves: [{ attemptId: KLING, at: iso(T0) }] });
    await mkdir(clipsDir(), { recursive: true });
    await recoverClips(r.host, library);
    expect(r.held.size).toBe(0);
  });
});

describe("the recovery job", () => {
  test("starts no second job on a journal that already has one", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({ active: [CLIP] });
    const { jobs } = await recoverClips(r.host, library);
    expect(jobs).toHaveLength(0);
    expect(existsSync(clipJournalPath(clipsDir(), CLIP))).toBe(true);
  });

  test("waits for a key that has not arrived yet, and goes on once it has", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({
      key: (n) => {
        if (n < 3) throw new EngineFailure({ code: "AUTH_INVALID", detail: "no OpenRouter API key is stored" });
      },
    });
    await recover(r);
    expect(r.calls.keys).toBe(3);
    expect((await recordOf()).outcome.status).toBe("ready");
  });

  test("looks for a key every 2 s, not every poll interval: the key is a local value main sends a moment after the start", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({
      key: (n) => {
        if (n < 2) throw new EngineFailure({ code: "AUTH_INVALID", detail: "no OpenRouter API key is stored" });
      },
    });
    await recover(r);
    expect(r.calls.sleeps).toEqual([2_000]);
  });

  test("gives up on a key that never comes at the 60 min mark: `late`", async () => {
    const submittedAt = T0 + 1_000;
    await writeLines(CLIP, [requested(), submitted(KLING, submittedAt)]);
    const r = rig({
      key: () => {
        throw new EngineFailure({ code: "AUTH_INVALID", detail: "no OpenRouter API key is stored" });
      },
    });
    await recover(r);
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "late" });
    expect(r.calls.poll).toEqual([]);
  });

  test("needs no key for a clip it only has to close (`requested` only)", async () => {
    await writeLines(CLIP, [requested()]);
    const r = rig({
      key: () => {
        throw new EngineFailure({ code: "AUTH_INVALID", detail: "no OpenRouter API key is stored" });
      },
    });
    await recover(r);
    expect(r.calls.keys).toBe(0);
    expect((await recordOf()).outcome).toMatchObject({ reason: "lost" });
  });

  test("stops when the engine stops: no record, the journal stays for the next start, and the job ends cancelled", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({ poll: () => status("in_progress") });
    const stoppingHost: ClipRecoveryHost = {
      ...r.host,
      sleep: async (ms, signal) => {
        r.calls.sleeps.push(ms);
        r.stop.abort();
        if (!signal.aborted) throw new Error("the job must hand its stop signal to the sleep");
      },
    };
    const { jobs } = await recoverClips(stoppingHost, library);
    await Promise.all(jobs);
    expect(existsSync(clipRecordPath(clipsDir(), CLIP))).toBe(false);
    expect(existsSync(clipJournalPath(clipsDir(), CLIP))).toBe(true);
    expect(r.types()).toContain("job.cancelled");
  });

  test("announces its phases as job.progress: `recovering` (then again with the model and the submit time), `downloading`, `checking`, `saving`", async () => {
    const submittedAt = T0 + 1_000;
    await writeLines(CLIP, [requested(), submitted(KLING, submittedAt)]);
    const r = rig();
    await recover(r);
    const progress = r.events.flatMap((e) => (e.type === "job.progress" && e.payload.kind === "clip" ? [e.payload] : []));
    expect(progress.map((p) => p.phase)).toEqual(["recovering", "recovering", "downloading", "checking", "saving"]);
    expect(progress[0]?.model).toBeUndefined();
    expect(progress[1]).toMatchObject({ model: "kling", submittedAt: iso(submittedAt) });
    expect(progress.map((p) => p.done)).toEqual([0, 0, 1, 2, 3]);
  });
});

describe("a ready clip whose poster is missing", () => {
  async function readyRecord(): Promise<void> {
    await mkdir(clipsDir(), { recursive: true });
    await writeFile(join(clipsDir(), `${CLIP}.mp4`), "mp4");
    await writeClipRecord(clipsDir(), {
      schemaVersion: 1,
      id: CLIP,
      avatarId: AVATAR,
      sourcePhotoId: PHOTO,
      createdAt: iso(T0),
      seen: true,
      motion: MOTION,
      request: REQUEST,
      provider: { model: "kling-std", attempts: [] },
      recovered: false,
      exports: [],
      outcome: { status: "ready", file: `${CLIP}.mp4`, posterFile: `${CLIP}.poster.jpg`, width: 720, height: 1280, durationMs: 5_041, fps: 24, bytes: 3, sha256: SHA, face: FACE },
    });
  }

  test("gets its poster drawn again from the kept mp4, with the clip's own colour, and the record is not rewritten", async () => {
    await readyRecord();
    const before = await readFile(clipRecordPath(clipsDir(), CLIP), "utf8");
    const r = rig();
    await recover(r);
    expect(existsSync(join(clipsDir(), `${CLIP}.poster.jpg`))).toBe(true);
    expect(r.calls.posters).toHaveLength(1);
    expect(r.calls.posters[0]?.colour).toEqual(VALID.colour);
    expect(await readFile(clipRecordPath(clipsDir(), CLIP), "utf8")).toBe(before);
  });

  test("draws it under a temp name and renames it, leaving no temp file", async () => {
    await readyRecord();
    const r = rig();
    await recover(r);
    expect(r.calls.posters[0]?.outPath).not.toBe(join(clipsDir(), `${CLIP}.poster.jpg`));
    expect((await names()).filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  test("is a registered job that ends with job.done, so the window lists it again", async () => {
    await readyRecord();
    const r = rig();
    await recover(r);
    expect(r.types()).toEqual(expect.arrayContaining(["job.done"]));
  });

  test("keeps the clip and tries again at the next start when the poster cannot be drawn", async () => {
    await readyRecord();
    const r = rig();
    const failing: ClipRecoveryHost = {
      ...r.host,
      media: {
        ...r.host.media,
        makePoster: async () => {
          throw new Error("ffmpeg failed");
        },
      },
    };
    const { jobs } = await recoverClips(failing, library);
    await Promise.all(jobs);
    expect(existsSync(join(clipsDir(), `${CLIP}.mp4`))).toBe(true);
    expect(existsSync(join(clipsDir(), `${CLIP}.poster.jpg`))).toBe(false);
    expect((await recordOf()).outcome.status).toBe("ready");
  });

  test("is left alone when its poster is there", async () => {
    await readyRecord();
    await writeFile(join(clipsDir(), `${CLIP}.poster.jpg`), "jpg");
    const r = rig();
    const { jobs } = await recoverClips(r.host, library);
    expect(jobs).toHaveLength(0);
    expect(r.calls.posters).toEqual([]);
  });

  test("takes the clip's lock to draw it again", async () => {
    await readyRecord();
    const r = rig();
    await recover(r);
    expect(r.calls.locked).toEqual([CLIP]);
  });

  test("is not drawn again when the library stops being the live one while the clip's lock is waited for", async () => {
    await readyRecord();
    const options: Options = {};
    options.beforeLocked = async () => void (options.current = false);
    const r = rig(options);
    const { jobs } = await recoverClips(r.host, library);
    expect(jobs).toHaveLength(0);
    expect(r.calls.posters).toEqual([]);
  });

  test("is not drawn again when the clip is deleted between the scan and the act: no job, no poster", async () => {
    await readyRecord();
    const r = rig({
      beforeLocked: async () => {
        await rm(clipRecordPath(clipsDir(), CLIP));
        await rm(join(clipsDir(), `${CLIP}.mp4`));
      },
    });
    const { jobs } = await recoverClips(r.host, library);
    await Promise.all(jobs);
    expect(jobs).toHaveLength(0);
    expect(r.calls.posters).toEqual([]);
    expect(await names()).toEqual([]);
  });

  test("is left alone when its mp4 is gone too: there is nothing to draw it from", async () => {
    await readyRecord();
    await writeFile(join(clipsDir(), "gone.txt"), "x");
    await import("node:fs/promises").then((fs) => fs.rm(join(clipsDir(), `${CLIP}.mp4`)));
    const r = rig();
    const { jobs } = await recoverClips(r.host, library);
    await Promise.all(jobs);
    expect(r.calls.posters).toEqual([]);
  });
});

describe("the sweep of the clips folder", () => {
  test("removes the temp files and temp folders a crash left, and only those", async () => {
    await mkdir(join(clipsDir(), ".frames-0a1b2c3d4e5f.tmp"), { recursive: true });
    await writeFile(join(clipsDir(), ".frames-0a1b2c3d4e5f.tmp", "000.jpg"), "x");
    await writeFile(join(clipsDir(), ".0a1b2c3d4e5f.in.tmp"), "x");
    await writeFile(join(clipsDir(), ".0a1b2c3d4e5f.crop.png.tmp"), "x");
    await writeFile(join(clipsDir(), `.${CLIP}.0a1b2c3d4e5f.tmp`), "x");
    await writeFile(join(clipsDir(), "notes.txt"), "keep");
    await sweepClipsDir(clipsDir(), { sweepTemps: true, isActive: () => false });
    expect(await names()).toEqual(["notes.txt"]);
  });

  test("never sweeps a temp while a clip job of this process is live", async () => {
    await mkdir(join(clipsDir(), ".frames-0a1b2c3d4e5f.tmp"), { recursive: true });
    await writeFile(join(clipsDir(), ".0a1b2c3d4e5f.in.tmp"), "x");
    const r = rig({ active: [OTHER] });
    await mkdir(clipsDir(), { recursive: true });
    await recoverClips(r.host, library);
    expect(await names()).toEqual([".0a1b2c3d4e5f.in.tmp", ".frames-0a1b2c3d4e5f.tmp"]);
  });

  test("sweeps the temps of a library nothing is running on", async () => {
    await mkdir(join(clipsDir(), ".frames-0a1b2c3d4e5f.tmp"), { recursive: true });
    await writeFile(join(clipsDir(), ".0a1b2c3d4e5f.in.tmp"), "x");
    await recoverClips(rig().host, library);
    expect(await names()).toEqual([]);
  });

  test("removes an mp4 and a poster that have neither a record nor a journal (a crash in the middle of a delete)", async () => {
    await mkdir(clipsDir(), { recursive: true });
    await writeFile(join(clipsDir(), `${OTHER}.mp4`), "x");
    await writeFile(join(clipsDir(), `${OTHER}.poster.jpg`), "x");
    await recoverClips(rig().host, library);
    expect(await names()).toEqual([]);
  });

  test("keeps the files of a clip a live job of this process is working on", async () => {
    await mkdir(clipsDir(), { recursive: true });
    await writeFile(join(clipsDir(), `${OTHER}.mp4`), "x");
    const r = rig({ active: [OTHER] });
    await recoverClips(r.host, library);
    expect(await names()).toEqual([`${OTHER}.mp4`]);
  });

  test("keeps a record, an mp4 and a poster that belong together", async () => {
    await mkdir(clipsDir(), { recursive: true });
    await writeFile(join(clipsDir(), `${CLIP}.mp4`), "mp4");
    await writeFile(join(clipsDir(), `${CLIP}.poster.jpg`), "jpg");
    await writeClipRecord(clipsDir(), {
      schemaVersion: 1,
      id: CLIP,
      avatarId: AVATAR,
      sourcePhotoId: PHOTO,
      createdAt: iso(T0),
      seen: true,
      motion: MOTION,
      request: REQUEST,
      provider: { model: "kling-std", attempts: [] },
      recovered: false,
      exports: [],
      outcome: { status: "ready", file: `${CLIP}.mp4`, posterFile: `${CLIP}.poster.jpg`, width: 720, height: 1280, durationMs: 5_041, fps: 24, bytes: 3, sha256: SHA, face: FACE },
    });
    await recoverClips(rig().host, library);
    expect(await names()).toEqual([`${CLIP}.json`, `${CLIP}.mp4`, `${CLIP}.poster.jpg`]);
  });

  test("does nothing for an avatar that has no clips folder", async () => {
    const r = rig();
    const { jobs } = await recoverClips(r.host, library);
    expect(jobs).toHaveLength(0);
    expect(existsSync(clipsDir())).toBe(false);
  });
});

describe("a clip whose file was already fetched and checked when the process stopped", () => {
  const MP4_SHA = createHash("sha256").update("mp4").digest("hex");
  const downloadedLine = (sha256 = MP4_SHA, bytes = 3): ClipJournalLine => ({ type: "downloaded", sha256, bytes, at: iso(T0 + 100_000) });
  const lines = (downloaded: ClipJournalLine): ClipJournalLine[] => [requested(), submitted(KLING, T0 + 1_000), ended(KLING, T0 + 90_000, "completed", "usage"), downloaded];
  const LONG_AFTER = T0 + 1_000 + 90 * MIN;

  async function mp4(content = "mp4"): Promise<void> {
    await mkdir(clipsDir(), { recursive: true });
    await writeFile(join(clipsDir(), `${CLIP}.mp4`), content);
  }

  test("is recorded ready from the kept file with no network call, even more than 60 min after the submit", async () => {
    await writeLines(CLIP, lines(downloadedLine()));
    await mp4();
    const r = rig({ now: LONG_AFTER, role: "hidden" });
    await recover(r);
    expect(await recordOf()).toMatchObject({ recovered: true, outcome: { status: "ready", sha256: MP4_SHA, bytes: 3, face: FACE } });
    expect(r.calls).toMatchObject({ poll: [], download: [], generation: [], keys: 0 });
    expect(r.calls.posters).toHaveLength(1);
    expect(existsSync(join(clipsDir(), `${CLIP}.poster.jpg`))).toBe(true);
    expect(existsSync(clipJournalPath(clipsDir(), CLIP))).toBe(false);
  });

  test("is recorded ready from the kept file within the 60 min too, without fetching it again", async () => {
    await writeLines(CLIP, lines(downloadedLine()));
    await mp4();
    const r = rig({ now: T0 + 10 * MIN });
    await recover(r);
    expect((await recordOf()).outcome.status).toBe("ready");
    expect(r.calls.download).toEqual([]);
  });

  test("is `download-expired` after 60 min when the kept file's hash is not the journal's", async () => {
    await writeLines(CLIP, lines(downloadedLine()));
    await mp4("not the clip");
    const r = rig({ now: LONG_AFTER });
    await recover(r);
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "download-expired" });
    expect(r.calls.download).toEqual([]);
  });

  test("is `download-expired` after 60 min when the kept file's size is not the journal's", async () => {
    await writeLines(CLIP, lines(downloadedLine(MP4_SHA, 999)));
    await mp4();
    await recover(rig({ now: LONG_AFTER }));
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "download-expired" });
  });

  test("is `download-expired` after 60 min when the kept file is gone", async () => {
    await writeLines(CLIP, lines(downloadedLine()));
    await recover(rig({ now: LONG_AFTER }));
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "download-expired" });
  });

  test("is fetched again within the 60 min when the kept file does not match", async () => {
    await writeLines(CLIP, lines(downloadedLine()));
    await mp4("not the clip");
    const r = rig({ now: T0 + 10 * MIN });
    await recover(r);
    expect(r.calls.download).toEqual(["job-1"]);
    expect((await recordOf()).outcome.status).toBe("ready");
  });

  test("falls back to the 60 min rule when the kept file no longer validates", async () => {
    await writeLines(CLIP, lines(downloadedLine()));
    await mp4();
    const r = rig({ now: LONG_AFTER });
    const refusing: ClipRecoveryHost = { ...r.host, media: { ...r.host.media, validateClipFile: async () => ({ ok: false, reason: "not-h264", detail: "x" }) } };
    const { jobs } = await recoverClips(refusing, library);
    await Promise.all(jobs);
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "download-expired" });
  });
});

describe("a kept file that cannot be judged now", () => {
  const MP4_SHA = createHash("sha256").update("mp4").digest("hex");
  const lines: ClipJournalLine[] = [requested(), submitted(KLING, T0 + 1_000), ended(KLING, T0 + 90_000, "completed", "usage"), { type: "downloaded", sha256: MP4_SHA, bytes: 3, at: iso(T0 + 100_000) }];

  test("keeps the journal and records nothing when validating it fails for a reason that is not the file's (EBUSY, EMFILE)", async () => {
    await writeLines(CLIP, lines);
    await writeFile(join(clipsDir(), `${CLIP}.mp4`), "mp4");
    const r = rig({ now: T0 + 1_000 + 90 * MIN });
    const busy: ClipRecoveryHost = {
      ...r.host,
      media: {
        ...r.host.media,
        validateClipFile: async () => {
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        },
      },
    };
    const { jobs } = await recoverClips(busy, library);
    await Promise.all(jobs);
    expect(existsSync(clipRecordPath(clipsDir(), CLIP))).toBe(false);
    expect(existsSync(clipJournalPath(clipsDir(), CLIP))).toBe(true);
    expect(r.types()).toContain("job.failed");
  });

  test("still decides `download-expired` when the file is plainly not there", async () => {
    await writeLines(CLIP, lines);
    const r = rig({ now: T0 + 1_000 + 90 * MIN });
    await recover(r);
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "download-expired" });
  });
});

describe("a stop right after the paid file was renamed into place", () => {
  test("leaves `downloaded` in the journal beside the mp4, so the next start finishes it from disk", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig();
    const stopping: ClipRecoveryHost = {
      ...r.host,
      media: {
        ...r.host.media,
        downloadClip: async (o) => {
          const path = join(o.clipsDir, `${o.clipId}.mp4`);
          await writeFile(path, "mp4");
          r.stop.abort();
          return { kind: "saved", path, sha256: SHA, clip: VALID };
        },
      },
    };
    const { jobs } = await recoverClips(stopping, library);
    await Promise.all(jobs);
    const journal = await journalOf(clipsDir(), CLIP).read();
    expect(journal.at(-1)).toMatchObject({ type: "downloaded", sha256: SHA });
    expect(existsSync(clipRecordPath(clipsDir(), CLIP))).toBe(false);
    expect(r.types()).toContain("job.cancelled");
  });
});

describe("the order of a recovery's steps", () => {
  test("decides whether temps may be swept right before the sweep, not before the folders are read", async () => {
    await writeLines(CLIP, [requested()]);
    await writeFile(join(clipsDir(), ".0a1b2c3d4e5f.in.tmp"), "x");
    // A `clips.create` that arrives while the folders are being read starts its job, and its first frame's temp is already on disk.
    const r: ReturnType<typeof rig> = rig({ onIsActive: () => void r.active.add(OTHER) });
    await recoverClips(r.host, library);
    expect(existsSync(join(clipsDir(), ".0a1b2c3d4e5f.in.tmp"))).toBe(true);
  });

  test("starts no job once the library is no longer the live one", async () => {
    await writeLines(CLIP, [requested()]);
    const r = rig({ current: false });
    const { jobs } = await recoverClips(r.host, library);
    expect(jobs).toHaveLength(0);
    expect(existsSync(clipJournalPath(clipsDir(), CLIP))).toBe(true);
  });
});

describe("a recovery and a concurrent delete or record of the same clip", () => {
  test("takes the clip's lock to act on it", async () => {
    await writeLines(CLIP, [requested()]);
    const r = rig();
    await recover(r);
    expect(r.calls.locked).toEqual([CLIP]);
  });

  test("resurrects nothing when the clip is deleted between the scan and the act: no job, no record", async () => {
    await writeLines(CLIP, [requested(), submitted(KLING, T0 + 1_000)]);
    const r = rig({ beforeLocked: async () => void (await rm(clipJournalPath(clipsDir(), CLIP))) });
    const { jobs } = await recoverClips(r.host, library);
    expect(jobs).toHaveLength(0);
    expect(existsSync(clipRecordPath(clipsDir(), CLIP))).toBe(false);
    expect(r.calls.poll).toEqual([]);
  });

  test("starts no job when the library stops being the live one while the clip's lock is waited for", async () => {
    await writeLines(CLIP, [requested()]);
    const options: Options = {};
    // The records' lock may be held by a delete for as long as the disk takes: a library switch can land in that wait.
    options.beforeLocked = async () => void (options.current = false);
    const r = rig(options);
    const { jobs } = await recoverClips(r.host, library);
    expect(jobs).toHaveLength(0);
    expect(existsSync(clipJournalPath(clipsDir(), CLIP))).toBe(true);
    expect(existsSync(clipRecordPath(clipsDir(), CLIP))).toBe(false);
  });

  test("an I/O error under one clip's lock costs that clip its recovery this time, not the others theirs", async () => {
    await writeLines(CLIP, [requested(CLIP)]);
    await writeLines(OTHER, [requested(OTHER)]);
    const logs: string[] = [];
    const r = rig({
      beforeLocked: async (clipId) => {
        if (clipId === CLIP) throw Object.assign(new Error("emfile"), { code: "EMFILE" });
      },
    });
    const { jobs } = await recoverClips({ ...r.host, log: (line) => void logs.push(line) }, library);
    await Promise.all(jobs);
    expect((await recordOf(OTHER)).outcome).toMatchObject({ reason: "lost" });
    expect(existsSync(clipJournalPath(clipsDir(), CLIP))).toBe(true);
    expect(logs.some((line) => line.includes(CLIP))).toBe(true);
  });

  test("starts no job when a record appeared between the scan and the act, and drops the stale journal", async () => {
    await writeLines(CLIP, [requested()]);
    const r = rig({
      beforeLocked: async () => {
        await writeClipRecord(clipsDir(), {
          schemaVersion: 1,
          id: CLIP,
          avatarId: AVATAR,
          sourcePhotoId: PHOTO,
          createdAt: iso(T0),
          seen: false,
          motion: MOTION,
          request: REQUEST,
          provider: { model: "kling-std", attempts: [] },
          recovered: false,
          exports: [],
          outcome: { status: "failed", reason: "refused-free" },
        });
      },
    });
    const { jobs } = await recoverClips(r.host, library);
    expect(jobs).toHaveLength(0);
    expect(existsSync(clipJournalPath(clipsDir(), CLIP))).toBe(false);
    expect((await recordOf()).outcome).toEqual({ status: "failed", reason: "refused-free" });
  });
});

describe("a poster that is missing", () => {
  test("is not drawn again for a failed record that has an mp4 beside it", async () => {
    await mkdir(clipsDir(), { recursive: true });
    await writeFile(join(clipsDir(), `${CLIP}.mp4`), "mp4");
    await writeClipRecord(clipsDir(), {
      schemaVersion: 1,
      id: CLIP,
      avatarId: AVATAR,
      sourcePhotoId: PHOTO,
      createdAt: iso(T0),
      seen: false,
      motion: MOTION,
      request: REQUEST,
      provider: { model: "kling-std", attempts: [] },
      recovered: false,
      exports: [],
      outcome: { status: "failed", reason: "download-failed" },
    });
    const r = rig();
    const { jobs } = await recoverClips(r.host, library);
    expect(jobs).toHaveLength(0);
    expect(r.calls.posters).toEqual([]);
  });
});
