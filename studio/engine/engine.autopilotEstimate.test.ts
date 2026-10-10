import { describe, expect, setDefaultTimeout, test } from "bun:test";
import { lstat, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { LaunchPreview, type LaunchDraftInput, type PickedFileIdentity } from "../shared/engine";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { EngineReply } from "./control";
import { IDLE_STEPS } from "./autopilot/steps";
import { manifestTraits } from "./avatars/records";
import { NODE_EXPORT_ROOT_FS } from "./exportRoot";
import { openLibrary } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import { pickedIdentityOf } from "./media/identity";
import type { FlashapiFetch } from "./music/client";
import type { AutopilotTrends } from "./music/autopilotCandidates";
import type { QuotaLine } from "./music/quotaLedger";
import type { MusicListSink } from "./music/service";
import type { TrendingCandidate } from "./music/trackStore";
import { PersistingTestSink } from "./music/testing/testSink";
import { fakeFetch, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import { command, engineSettings, GOOD, jobEnd, KEY, NOW, ok, startEngine, TRAITS, useEngineDir } from "./testing/engineHarness";
useNativeGlobals();

// S4.10 fix B: the engine's launch estimate fills the figures the plan card shows — the music (from the SAME candidate collection the free steps choose from, the quota log and a dry
// run of the auto-refresh rule), the OpenRouter balance and the free bytes of the export volume — and stays free and side-effect-free. The mock filled all of these; the real
// engine answered stubs, so the owner saw «Подходящей музыки нет» with 30 trends stored. Real engine, real library, quota log and music folder in a temp dir; the network is a double.

setDefaultTimeout(30_000);

const dir = useEngineDir("studio-engine-autopilot-estimate-");
const musicDir = () => join(dir(), "userData", "music");
const HOUR = 3600 * 1000;
const MUSIC_KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";

const TRACK_FACTS = { width: null, height: null, durationMs: 12_000, sourceFps: null, hdrToSdr: false, loopFrames: null, delayFrames: null } as const;
const m4aBytes = (): Uint8Array => Uint8Array.from([0, 0, 0, 32, ...Buffer.from("ftypM4A "), ...new Array<number>(20).fill(0)]);

const trend = (trackId: string, over: Partial<TrendingCandidate> = {}): TrendingCandidate => ({
  source: "trending",
  trackId,
  durationMs: 30_000,
  highlights: [{ ms: 4_000, likelyDefault: false }],
  explicit: false,
  inList: true,
  ...over,
});
const trends = (n: number, over: Partial<TrendingCandidate> = {}): TrendingCandidate[] => Array.from({ length: n }, (_, i) => trend(`trend-${i}`, over));

const CREDITS: Reply = { status: 200, body: { data: { total_credits: 20, total_usage: 1.2345 } } };
function openRouter(reply: Reply | "hang" = CREDITS) {
  const net = fakeFetch(
    Array.from({ length: 64 }, () => (call: FetchCall): Reply => {
      if (call.url.endsWith("/credits") && reply !== "hang") return reply;
      return { reject: new TypeError("fetch failed") };
    }),
  );
  // Only the balance's read hangs; the price book is asked as it always is.
  const fetch: typeof net.fetch = (url, init) => (reply === "hang" && String(url).endsWith("/credits") ? new Promise<never>(() => undefined) : net.fetch(url, init));
  return { fetch, calls: net.calls };
}

let seeded = 0;
async function seedAvatar(): Promise<string> {
  const { library } = await openLibrary(join(dir(), "library"), { now: steppingClock(), newId: sequentialIds(`seed${++seeded}`) });
  const avatar = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: GOOD });
  const master = await library.addPhoto(avatar.id, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
  await library.updateAvatar(avatar.id, { status: "active", masterPhotoId: master.id });
  return avatar.id;
}

const draftOf = (avatarId: string): LaunchDraftInput => ({
  avatarIds: [avatarId],
  videosPerAvatar: 2,
  mix: { single: 0, collage: 0, slides: 100 },
  categories: ["home"],
  poses: { profile: false, back: false },
  library: false,
  generate: true,
  sceneReview: false,
  stickers: false,
});

interface BootOptions {
  trends?: TrendingCandidate[];
  key?: string | null;
  musicKey?: boolean;
  sink?: MusicListSink;
  freeBytes?: () => Promise<number | null>;
  readMs?: number;
  openRouter?: Reply | "hang";
  musicFetch?: FlashapiFetch;
}

async function boot(options: BootOptions = {}) {
  await mkdir(join(dir(), "export"), { recursive: true });
  // The avatar goes into the library BEFORE the engine opens it.
  const avatarId = await seedAvatar();
  const net = openRouter(options.openRouter);
  const flashapi: string[] = [];
  const trendsNow = options.trends ?? [];
  const source: AutopilotTrends = { storedTrends: () => trendsNow, labelOf: () => null };
  const started = await startEngine(dir(), {
    key: options.key === undefined ? KEY : options.key,
    init: { settings: engineSettings(dir(), { imageAgeCheck: "off" }), musicDir: musicDir() },
    deps: {
      launchSteps: IDLE_STEPS,
      fetch: net.fetch,
      musicTrends: source,
      musicSink: options.sink ?? new PersistingTestSink(),
      musicFetch:
        options.musicFetch ??
        ((url) => {
          flashapi.push(String(url));
          return Promise.reject(new Error("the estimate sends nothing to flashapi"));
        }),
      mediaImporters: { audio: async () => ({ ok: true, facts: TRACK_FACTS }) },
      exportRootFs: { ...NODE_EXPORT_ROOT_FS, freeBytes: options.freeBytes ?? (() => Promise.resolve(250_000_000_000)) },
      ...(options.readMs === undefined ? {} : { autopilotReadMs: options.readMs }),
    },
  });
  if (options.musicKey !== false) await started.engine.applyControl({ kind: "control", type: "musicKey.set", key: MUSIC_KEY, origin: "user" });
  await started.engine.settled();
  return { ...started, avatarId, openRouterCalls: net.calls, flashapi };
}

type Booted = Awaited<ReturnType<typeof boot>>;

async function previewOf(started: Booted, avatarId: string, draft: LaunchDraftInput = draftOf(avatarId)): Promise<LaunchPreview> {
  const answer = ok(await started.engine.handle(command("autopilot.estimate", { draft })));
  if (answer.type !== "autopilot.estimate") throw new Error("not an estimate");
  return LaunchPreview.parse(answer.result.preview);
}

let calls = 0;
/** Imports an own track through the engine, flags it «для автопилота» when asked, and answers its id. */
async function ownTrack(started: Booted, name: string, flagged: boolean): Promise<string> {
  const pickedDir = join(dir(), "picked");
  await mkdir(pickedDir, { recursive: true });
  const path = join(pickedDir, `${++calls}-${name}`);
  await writeFile(path, m4aBytes());
  const expected: PickedFileIdentity = pickedIdentityOf(await lstat(path, { bigint: true }));
  const callId = `call-${String(++calls).padStart(8, "0")}`;
  await started.engine.receive({ kind: "control", type: "media.import", callId, pick: "audio", path, name, expected });
  const reply = started.posted.map((m) => EngineReply.safeParse(m)).find((r) => r.success && r.data.callId === callId);
  if (reply === undefined || !reply.success || reply.data.mediaJobId === undefined) throw new Error("the import was not started");
  await started.engine.mediaSettled();
  expect((await jobEnd(started.events, reply.data.mediaJobId)).type).toBe("job.done");
  const listed = ok(await started.engine.handle(command("media.list", { kind: "audio" }))).result as { media: { mediaId: string; name: string }[] };
  const found = listed.media.find((media) => media.name === name);
  if (found === undefined) throw new Error("nothing was stored");
  if (flagged) ok(await started.engine.handle(command("media.setForAutopilot", { mediaId: found.mediaId, on: true })));
  return found.mediaId;
}

async function seedQuota(lines: readonly QuotaLine[]): Promise<void> {
  await mkdir(musicDir(), { recursive: true });
  await writeFile(join(musicDir(), "quota.jsonl"), lines.map((l) => `${JSON.stringify(l)}\n`).join(""));
}
/** `n` sends, an hour apart, the newest 100 h ago: out of the way of the 72 h rules, inside the 31 days. */
const oldSends = (n: number): QuotaLine[] => Array.from({ length: n }, (_, i) => ({ v: 1, kind: "send", id: `seed-${i}`, at: NOW - 100 * HOUR - (n - i) * HOUR, key: "0000" }));

/** A sink that stores nothing and reports the list's age. */
const sinkAt = (listFetchedAt: number): MusicListSink => ({
  persistent: true,
  accept: () => Promise.reject(new Error("an estimate stores no list")),
  summary: () => ({ listFetchedAt, trackCount: 0, bytesOnDisk: 0 }),
  list: () => [],
  peaks: () => Promise.resolve(null),
});

describe("the estimate's music: counted from the same collection the free steps choose from", () => {
  test("30 saved trends are 30 candidates, none of them own or explicit", async () => {
    const started = await boot({ trends: trends(30) });
    const preview = await previewOf(started, started.avatarId);
    expect(preview.music).toMatchObject({ candidates: 30, ownFlagged: 0, explicitSkipped: 0 });
  });

  test("an explicit trend is left out and counted as skipped", async () => {
    const started = await boot({ trends: [...trends(3), trend("rude", { explicit: true }), trend("rude-old", { explicit: true, inList: false })] });
    const preview = await previewOf(started, started.avatarId);
    expect(preview.music).toMatchObject({ candidates: 3, explicitSkipped: 2 });
  });

  test("a trend kept from an earlier list (not in the current one) is a candidate too", async () => {
    const started = await boot({ trends: [trend("now"), trend("kept", { inList: false })] });
    expect((await previewOf(started, started.avatarId)).music.candidates).toBe(2);
  });

  test("an own track flagged for the autopilot is a candidate and counted as flagged", async () => {
    const started = await boot({ trends: trends(2) });
    await ownTrack(started, "flagged.m4a", true);
    expect((await previewOf(started, started.avatarId)).music).toMatchObject({ candidates: 3, ownFlagged: 1 });
  });

  test("an own track the owner did not flag is not a candidate", async () => {
    const started = await boot({ trends: trends(2) });
    await ownTrack(started, "plain.m4a", false);
    expect((await previewOf(started, started.avatarId)).music).toMatchObject({ candidates: 2, ownFlagged: 0 });
  });

  test("an engine with no saved trends and no flagged track has no candidate", async () => {
    const started = await boot();
    expect((await previewOf(started, started.avatarId)).music).toMatchObject({ candidates: 0, ownFlagged: 0, explicitSkipped: 0 });
  });
});

describe("the estimate's quota and auto-refresh word", () => {
  test("quotaRemaining is the 30 less the sends in the quota log", async () => {
    await seedQuota(oldSends(4));
    const started = await boot({ trends: trends(3) });
    expect((await previewOf(started, started.avatarId)).music.quotaRemaining).toBe(26);
  });

  test("quotaRemaining is 30 when no request was ever sent", async () => {
    const started = await boot({ trends: trends(3) });
    expect((await previewOf(started, started.avatarId)).music.quotaRemaining).toBe(30);
  });

  test("quotaRemaining is null when the quota log cannot be read", async () => {
    await mkdir(musicDir(), { recursive: true });
    await writeFile(join(musicDir(), "quota.jsonl"), "not json\n");
    const started = await boot({ trends: trends(3) });
    expect((await previewOf(started, started.avatarId)).music.quotaRemaining).toBeNull();
  });

  test("autoRefresh is no-key when no music key is stored", async () => {
    const started = await boot({ trends: trends(3), musicKey: false });
    expect((await previewOf(started, started.avatarId)).music.autoRefresh).toBe("no-key");
  });

  test("autoRefresh is will with a key, few candidates and room in the quota", async () => {
    const started = await boot({ trends: trends(3) });
    expect((await previewOf(started, started.avatarId)).music.autoRefresh).toBe("will");
  });

  test("autoRefresh is not-needed with a key, a fresh list and 10 candidates", async () => {
    const started = await boot({ trends: trends(10), sink: sinkAt(NOW - HOUR) });
    expect((await previewOf(started, started.avatarId)).music.autoRefresh).toBe("not-needed");
  });

  test("autoRefresh is will when the list is 72 h old, though the candidates are enough", async () => {
    const started = await boot({ trends: trends(10), sink: sinkAt(NOW - 72 * HOUR) });
    expect((await previewOf(started, started.avatarId)).music.autoRefresh).toBe("will");
  });

  test("autoRefresh is no-quota at 10 requests left and will at 11", async () => {
    await seedQuota(oldSends(20));
    const started = await boot({ trends: trends(3) });
    const { avatarId } = started;
    expect((await previewOf(started, avatarId)).music).toMatchObject({ autoRefresh: "no-quota", quotaRemaining: 10 });
  });

  test("autoRefresh is will at 11 requests left", async () => {
    await seedQuota(oldSends(19));
    const started = await boot({ trends: trends(3) });
    expect((await previewOf(started, started.avatarId)).music).toMatchObject({ autoRefresh: "will", quotaRemaining: 11 });
  });

  test("autoRefresh is no-quota when 10 automatic refreshes were sent in the window", async () => {
    await mkdir(musicDir(), { recursive: true });
    const lines = Array.from({ length: 10 }, (_, i) => JSON.stringify({ id: `auto-${i}`, at: NOW - 4 * 24 * HOUR - i * 2 * HOUR }));
    await writeFile(join(musicDir(), "auto-sends.jsonl"), lines.map((l) => `${l}\n`).join(""));
    const started = await boot({ trends: trends(3) });
    expect((await previewOf(started, started.avatarId)).music.autoRefresh).toBe("no-quota");
  });
});

describe("the estimate's balance", () => {
  test("is the OpenRouter balance with the time it was read", async () => {
    const started = await boot();
    expect((await previewOf(started, started.avatarId)).balance).toEqual({ micros: 18_765_500, asOf: new Date(NOW).toISOString() });
  });

  test("is null without an OpenRouter key", async () => {
    const started = await boot({ key: null });
    expect((await previewOf(started, started.avatarId)).balance).toBeNull();
  });

  test("is null when the read fails", async () => {
    const started = await boot({ openRouter: { reject: new TypeError("fetch failed") } });
    expect((await previewOf(started, started.avatarId)).balance).toBeNull();
  });

  test("is null, and the estimate still answers, when the read does not answer within its bound", async () => {
    const started = await boot({ openRouter: "hang", readMs: 50 });
    const began = performance.now();
    const preview = await previewOf(started, started.avatarId);
    expect([preview.balance, performance.now() - began < 5_000]).toEqual([null, true]);
  });
});

describe("the estimate's free bytes", () => {
  test("are the free bytes of the export volume", async () => {
    const started = await boot({ freeBytes: () => Promise.resolve(123_456_789) });
    expect((await previewOf(started, started.avatarId)).disk.freeBytes).toBe(123_456_789);
  });

  test("are null when the volume does not say", async () => {
    const started = await boot({ freeBytes: () => Promise.resolve(null) });
    expect((await previewOf(started, started.avatarId)).disk.freeBytes).toBeNull();
  });

  test("are null when the check fails", async () => {
    const started = await boot({ freeBytes: () => Promise.reject(new Error("EIO")) });
    expect((await previewOf(started, started.avatarId)).disk.freeBytes).toBeNull();
  });

  test("are null, and the estimate still answers, when the volume does not answer within the bound", async () => {
    const started = await boot({ freeBytes: () => new Promise<never>(() => undefined), readMs: 50 });
    expect((await previewOf(started, started.avatarId)).disk.freeBytes).toBeNull();
  });
});

describe("the estimate is free and changes nothing", () => {
  /** Every file under the music folder, the ledger and the launch folder, by name and text. */
  async function filesOf(root: string): Promise<Record<string, string>> {
    const out: Record<string, string> = {};
    const walk = async (folder: string): Promise<void> => {
      for (const entry of await readdir(folder, { withFileTypes: true }).catch(() => [])) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) await walk(path);
        else out[path.slice(root.length)] = await readFile(path, "utf8").catch(() => "(unreadable)");
      }
    };
    await walk(root);
    return out;
  }

  test("writes no file under userData, the music folder or the library's launch folder", async () => {
    await seedQuota(oldSends(3));
    const started = await boot({ trends: trends(3) });
    const { avatarId } = started;
    await previewOf(started, avatarId);
    const before = await filesOf(dir());
    await previewOf(started, avatarId);
    await previewOf(started, avatarId, { ...draftOf(avatarId), library: true });
    expect(await filesOf(dir())).toEqual(before);
  });

  test("sends nothing to flashapi", async () => {
    const started = await boot({ trends: trends(3) });
    await previewOf(started, started.avatarId);
    expect(started.flashapi).toEqual([]);
  });

  test("sends no paid request: OpenRouter is only read (the price list and the balance), never written to", async () => {
    const started = await boot({ trends: trends(3) });
    await previewOf(started, started.avatarId);
    expect(started.openRouterCalls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  test("reads the balance once for the estimate", async () => {
    const started = await boot({ trends: trends(3) });
    await previewOf(started, started.avatarId);
    expect(started.openRouterCalls.filter((c) => c.url.endsWith("/credits"))).toHaveLength(1);
  });

  test("starts no launch and writes no ledger line", async () => {
    const started = await boot({ trends: trends(3) });
    await previewOf(started, started.avatarId);
    const listed = ok(await started.engine.handle(command("autopilot.list", {}))).result as { launches: unknown[] };
    expect(listed.launches).toEqual([]);
    expect(await readFile(join(dir(), "userData", "ledger.jsonl"), "utf8").catch(() => "")).toBe("");
  });
});
