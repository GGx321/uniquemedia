import { describe, expect, test } from "bun:test";
import { chmod, mkdir, readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { ErrorCode, Estimate, ResponseMessage } from "../shared/engine";
import { openLibrary } from "./library";
import { PNG_1X1 } from "./library/testing/helpers";
import { chatBody, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import {
  ageReply,
  command,
  engineSettings,
  failed,
  filesUnder,
  GOOD,
  ledgerLines,
  MODERATION,
  network,
  ok,
  OFFLINE,
  portraitPng,
  schemaName,
  startEngine,
  useEngineDir,
  type Network,
} from "./testing/engineHarness";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// T6c: importing an existing avatar from one photo the owner already has.
// The one-time image age check (mandatory, whatever settings.imageAgeCheck
// says) runs first; only a clear pass reaches the vision describe job, which
// writes both typed traits and the descriptor in one strict JSON answer.

const dir = useEngineDir("studio-engine-import-");

/** The import job's price at the dated fallback table (plan.test.ts pins the same numbers). */
const IMPORT_ESTIMATE: Estimate = { expectedMicros: 5_535, worstMicros: 37_750, prices: "fallback", pricesAsOf: "2026-09-24" };
const AGE_WORST = 5_250;
const DESCRIBE_WORST = 16_250;

function describeReply(overrides: Record<string, unknown> = {}, cost = 0.0021): Reply {
  const answer = {
    people: 1,
    woman: true,
    age: 25,
    ethnicity: "european",
    skinTone: "light-olive",
    hairColor: "chestnut",
    hairLength: "shoulder",
    hairTexture: "wavy",
    eyeColor: "hazel",
    build: "athletic",
    marks: ["freckles"],
    descriptor: GOOD,
    ...overrides,
  };
  return { status: 200, body: chatBody(JSON.stringify(answer), { cost }) };
}

interface StageReply {
  error?: { code: string; detail?: string };
  stage?: { stagingId: string; width: number; height: number };
}

/** A minimal PNG (signature + a bare IHDR) declaring `width`×`height` — no real pixel data, since the free size check only reads the header. */
function pngWithSize(width: number, height: number): Uint8Array {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([..."IHDR"].map((c) => c.charCodeAt(0)), 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
}

/** The reply matching `callId` among everything the engine has posted so far. */
function replyFor(posted: unknown[], callId: string): StageReply | undefined {
  const found = posted.find(
    (m) => typeof m === "object" && m !== null && "kind" in m && m.kind === "control" && "type" in m && m.type === "reply" && "callId" in m && m.callId === callId,
  );
  return found as StageReply | undefined;
}

let stageCounter = 0;

/** Stages `bytes` through the control channel of an already-started engine, and returns its stagingId. */
async function stageOn(started: Awaited<ReturnType<typeof startEngine>>, bytes: Uint8Array = portraitPng()): Promise<string> {
  const callId = `stage-${String(++stageCounter).padStart(4, "0")}`;
  await started.engine.receive({ kind: "control", type: "import.stagePhoto", callId, bytes });
  const reply = replyFor(started.posted, callId);
  if (reply?.stage === undefined) throw new Error(`staging failed: ${JSON.stringify(reply)}`);
  return reply.stage.stagingId;
}

/** Starts an engine, stages `bytes` through the control channel, and returns its stagingId. */
async function startWithStagedPhoto(net: Network, bytes: Uint8Array = portraitPng(), opts: Parameters<typeof startEngine>[1] = {}) {
  const started = await startEngine(dir(), { net, ...opts });
  const stagingId = await stageOn(started, bytes);
  return { ...started, stagingId };
}

async function estimateWorst(engine: Awaited<ReturnType<typeof startEngine>>["engine"], stagingId: string): Promise<number> {
  const response = ok(await engine.handle(command("avatars.estimateImport", { stagingId })));
  if (response.type !== "avatars.estimateImport") throw new Error("wrong type");
  return response.result.worstMicros;
}

function importCommand(stagingId: string, name: string, acceptedWorstMicros: number, extra: Record<string, unknown> = {}): unknown {
  return command("avatars.importAvatar", { stagingId, name, confirmedAiPersona: true, acceptedWorstMicros, ...extra });
}

/** The vision describe calls, distinct from a plain new-avatar descriptor call: its own JSON schema name. */
function describeCalls(net: Network): FetchCall[] {
  return net.calls.filter((c) => c.url.endsWith("/chat/completions") && schemaName(c) === "import_describe");
}

describe("import.stagePhoto (main → engine control channel)", () => {
  test("a valid still photo stages: the reply carries a fresh stagingId and its pixel size", async () => {
    const started = await startEngine(dir(), { net: network() });
    // H3: a realistic-sized fixture, not a degenerate 1×1 PNG — ffmpeg's real
    // downscale exits non-zero on a 1×1 input on Windows CI (exit 5/116).
    await started.engine.receive({ kind: "control", type: "import.stagePhoto", callId: "call-00000001", bytes: portraitPng() });

    expect(replyFor(started.posted, "call-00000001")).toMatchObject({ stage: { stagingId: expect.any(String) as unknown as string, width: 60, height: 80 } });
  });

  test("rejects bytes that are not a known image, without staging anything", async () => {
    const started = await startEngine(dir(), { net: network() });
    await started.engine.receive({ kind: "control", type: "import.stagePhoto", callId: "call-00000002", bytes: Uint8Array.from([1, 2, 3]) });

    const reply = replyFor(started.posted, "call-00000002");
    expect(reply?.error?.code).toBe("VALIDATION");
    expect(reply?.stage).toBeUndefined();
  });

  test("rejects a downscale failure (e.g. an oversized image) with VALIDATION, and stages nothing", async () => {
    const started = await startEngine(dir(), {
      net: network(),
      deps: { downscaleImportPhoto: () => Promise.reject(new Error("the decoder refused: too many pixels")) },
    });
    await started.engine.receive({ kind: "control", type: "import.stagePhoto", callId: "call-00000003", bytes: PNG_1X1 });

    const reply = replyFor(started.posted, "call-00000003");
    expect(reply?.error?.code).toBe("VALIDATION");
    expect(reply?.error?.detail).toContain("too many pixels");
    expect(reply?.stage).toBeUndefined();
  });

  // M4: the pixel cap is checked for free, by the header's own declared
  // size, before ffmpeg is ever spawned — never only once a downscale
  // attempt eventually fails the expensive way.
  test("rejects an image above MAX_SOURCE_PIXELS for free: the downscaler is never even called", async () => {
    const started = await startEngine(dir(), {
      net: network(),
      deps: {
        downscaleImportPhoto: () => {
          throw new Error("unreachable: the pixel cap must refuse this before any downscale is attempted");
        },
      },
    });
    const oversized = pngWithSize(5_000, 4_000); // 20_000_000 > MAX_SOURCE_PIXELS (16_777_216)
    await started.engine.receive({ kind: "control", type: "import.stagePhoto", callId: "call-00000010", bytes: oversized });

    const reply = replyFor(started.posted, "call-00000010");
    expect(reply?.error?.code).toBe("VALIDATION");
    expect(reply?.error?.detail).toContain("pixels");
    expect(reply?.stage).toBeUndefined();
  });

  // M4: bounded even when the downscaler itself hangs and never checks its
  // own signal — the same untilAborted backstop #preflightDownscale already
  // uses for its own (possibly uncooperative) preflight function.
  test("a hung downscale is bounded by the timeout, not left forever: VALIDATION, stages nothing", async () => {
    const started = await startEngine(dir(), {
      net: network(),
      deps: {
        downscaleImportPhoto: () => new Promise<Uint8Array>(() => {}), // never resolves, never checks its own signal
        importDownscaleTimeoutMs: 20,
      },
    });
    await started.engine.receive({ kind: "control", type: "import.stagePhoto", callId: "call-00000011", bytes: portraitPng() });

    const reply = replyFor(started.posted, "call-00000011");
    expect(reply?.error?.code).toBe("VALIDATION");
    expect(reply?.stage).toBeUndefined();
  });

  test("a downscale failure with an unusually long message never exceeds SafeText's 500-char cap (L4)", async () => {
    const started = await startEngine(dir(), {
      net: network(),
      deps: { downscaleImportPhoto: () => Promise.reject(new Error("x".repeat(600))) },
    });
    await started.engine.receive({ kind: "control", type: "import.stagePhoto", callId: "call-00000099", bytes: PNG_1X1 });

    const reply = replyFor(started.posted, "call-00000099");
    expect(reply?.error?.code).toBe("VALIDATION");
    expect(reply?.error?.detail?.length).toBeLessThanOrEqual(500);
  });

  test("an animated image never stages, so there is nothing to import", async () => {
    const started = await startEngine(dir(), { net: network() });
    const header = [..."RIFF"].map((c) => c.charCodeAt(0)).concat([0x16, 0, 0, 0], [..."WEBPVP8X"].map((c) => c.charCodeAt(0)));
    const vp8x = [10, 0, 0, 0, 0x02, 0, 0, 0, 29, 0, 0, 39, 0, 0]; // animation flag set
    const animated = Uint8Array.from([...header, ...vp8x]);
    await started.engine.receive({ kind: "control", type: "import.stagePhoto", callId: "call-00000004", bytes: animated });

    const reply = replyFor(started.posted, "call-00000004");
    expect(reply?.error).toMatchObject({ code: "VALIDATION" });
    expect(reply?.stage).toBeUndefined();
  });

  test("a fresh stage replaces an earlier one: only the newest stagingId can be estimated or imported", async () => {
    const started = await startEngine(dir(), { net: network() });
    await started.engine.receive({ kind: "control", type: "import.stagePhoto", callId: "call-00000005", bytes: portraitPng(1) });
    const first = replyFor(started.posted, "call-00000005")?.stage?.stagingId;
    await started.engine.receive({ kind: "control", type: "import.stagePhoto", callId: "call-00000006", bytes: portraitPng(2) });
    const second = replyFor(started.posted, "call-00000006")?.stage?.stagingId;
    expect(first).not.toBe(second);
    expect(first).toBeDefined();
    expect(second).toBeDefined();

    const estimateOld = await started.engine.handle(command("avatars.estimateImport", { stagingId: first }));
    expect(failed(estimateOld).error.code).toBe("NOT_FOUND");
    const estimateNew = await started.engine.handle(command("avatars.estimateImport", { stagingId: second }));
    expect(ok(estimateNew).ok).toBe(true);
  });
});

// T6c review round 2, H2: the mandatory one-time image age check must not be
// re-rollable by simply re-picking the exact same file — a fresh pick gets a
// fresh stagingId, but the underlying bytes (and so the sha256 the library
// keys refusals by) are the same. Staging refuses a known-refused photo for
// free, before anything is downscaled or paid for.
describe("import.stagePhoto (H2): a photo already refused by the age check cannot be re-rolled by re-picking it", () => {
  test("re-picking the exact same refused photo is refused for free, with no new request and nothing downscaled again", async () => {
    const bytes = portraitPng(3);
    const net = network({ age: () => ageReply(false, 0.95) });
    const started = await startWithStagedPhoto(net, bytes);
    const worst = await estimateWorst(started.engine, started.stagingId);
    expect(failed(await started.engine.handle(importCommand(started.stagingId, "Zoe", worst))).error.code).toBe("AGE_CHECK_FAILED");
    const callsBefore = net.calls.length;

    await started.engine.receive({ kind: "control", type: "import.stagePhoto", callId: "call-refused-0001", bytes });

    const reply = replyFor(started.posted, "call-refused-0001");
    expect(reply?.error).toMatchObject({ code: "AGE_CHECK_FAILED" });
    expect(reply?.error?.detail).toContain("already refused");
    expect(reply?.stage).toBeUndefined();
    expect(net.calls).toHaveLength(callsBefore);
  });

  test("a different photo (different bytes) is unaffected by another photo's refusal", async () => {
    const net = network({ age: () => ageReply(false, 0.95) });
    const started = await startWithStagedPhoto(net, portraitPng(3));
    const worst = await estimateWorst(started.engine, started.stagingId);
    expect(failed(await started.engine.handle(importCommand(started.stagingId, "Zoe", worst))).error.code).toBe("AGE_CHECK_FAILED");

    await started.engine.receive({ kind: "control", type: "import.stagePhoto", callId: "call-other-0001", bytes: portraitPng(4) });

    const reply = replyFor(started.posted, "call-other-0001");
    expect(reply?.stage).toBeDefined();
  });

  test("a refusal for another reason (not the age check itself, e.g. a network error) is never recorded: the same photo can be re-picked", async () => {
    const bytes = portraitPng(3);
    const net = network({ age: () => OFFLINE });
    const started = await startWithStagedPhoto(net, bytes);
    const worst = await estimateWorst(started.engine, started.stagingId);
    expect(failed(await started.engine.handle(importCommand(started.stagingId, "Zoe", worst))).error.code).toBe("NETWORK");

    await started.engine.receive({ kind: "control", type: "import.stagePhoto", callId: "call-retry-0001", bytes });

    const reply = replyFor(started.posted, "call-retry-0001");
    expect(reply?.stage).toBeDefined();
  });

  // Round 3, L2: the free staging-time check alone is not enough — B is
  // staged from the exact same bytes as X *before* X's own age check has
  // resolved (so B's own stage-time check still sees "not refused yet").
  // Once X resolves and records the refusal, B's own import must not pay
  // for another age check on the very same bytes: the refused list is
  // re-checked for free right before B would otherwise spend anything.
  test("a race: B (staged from the same bytes while X's age check is still pending) never pays once X's refusal lands", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const bytes = portraitPng(5);
    const net = network({ age: async () => (await held, ageReply(false, 0.95)) });
    const started = await startWithStagedPhoto(net, bytes);
    const worstA = await estimateWorst(started.engine, started.stagingId);

    // X's own import: reaches its (gated) age-check request, then suspends.
    const importingX = started.engine.handle(importCommand(started.stagingId, "Zoe", worstA));

    // B: the exact same bytes, re-picked while X is still in flight — its
    // own stage-time check passes, since X has not refused yet.
    const stagingB = await stageOn(started, bytes);

    release();
    expect(failed(await importingX).error.code).toBe("AGE_CHECK_FAILED");
    const callsBeforeB = net.calls.length;

    const worstB = await estimateWorst(started.engine, stagingB);
    const responseB = await started.engine.handle(importCommand(stagingB, "Zoe", worstB));

    const failure = failed(responseB);
    expect(failure.error.code).toBe("AGE_CHECK_FAILED");
    expect(failure.error.detail).toContain("already refused");
    expect(net.calls).toHaveLength(callsBeforeB); // B never sent its own age-check request
  });
});

describe("avatars.estimateImport", () => {
  test("NOT_FOUND without a staged photo", async () => {
    const { engine } = await startEngine(dir(), { net: network() });
    const response = await engine.handle(command("avatars.estimateImport", { stagingId: "no-such-stage" }));
    expect(failed(response).error.code).toBe("NOT_FOUND");
  });

  test("prices one mandatory age check plus up to two describe attempts", async () => {
    const { engine, stagingId } = await startWithStagedPhoto(network());
    const response = await engine.handle(command("avatars.estimateImport", { stagingId }));
    expect(ok(response).result).toEqual(IMPORT_ESTIMATE);
  });
});

describe("avatars.importAvatar: happy path", () => {
  test("the age check passes, the describe call succeeds: a new active avatar with the imported photo as its master", async () => {
    const net = network({ age: () => ageReply(true, 0.93), descriptors: [describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const response = await engine.handle(importCommand(stagingId, "Zoe", worst));

    const answer = ok(response);
    if (answer.type !== "avatars.importAvatar") throw new Error("wrong type");
    expect(answer.result.avatar).toMatchObject({ name: "Zoe", status: "active", photoCount: 1, descriptor: { age: 25, text: GOOD } });

    const { library } = await openLibrary(join(dir(), "library"));
    const manifest = library.getAvatar(answer.result.avatar.avatarId);
    expect(manifest?.status).toBe("active");
    const photo = manifest?.masterPhotoId ? library.getPhoto(manifest.masterPhotoId) : undefined;
    expect(photo?.source.kind).toBe("imported");
    expect(photo?.qa.age).toEqual({ adult: true, confidence: 0.93 });
    // L11: the owner's AI-persona confirmation is recorded in the sidecar, not just checked at the contract boundary.
    expect(photo?.source).toMatchObject({ confirmedAiPersona: true });
  });

  test("the one-time age check runs even with settings.imageAgeCheck off: it is mandatory for import regardless", async () => {
    const net = network({ age: () => ageReply(true, 0.93), descriptors: [describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net, undefined, { init: { settings: engineSettings(dir(), { imageAgeCheck: "off" }) } });
    const worst = await estimateWorst(engine, stagingId);

    await engine.handle(importCommand(stagingId, "Nia", worst));

    expect(net.ageCalls()).toHaveLength(1);
  });

  test("attempt ids: <importId>:age and <importId>:describe#N", async () => {
    const net = network({ age: () => ageReply(true, 0.93), descriptors: [describeReply({ ethnicity: "martian" }), describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    await engine.handle(importCommand(stagingId, "Ada", worst));

    const ids = ledgerLines(dir())
      .filter((l) => l.type === "reserve")
      .map((l) => String(l.attemptId));
    expect(ids.some((id) => /:age$/.test(id))).toBe(true);
    expect(ids.some((id) => id.endsWith(":describe#1"))).toBe(true);
    expect(ids.some((id) => id.endsWith(":describe#2"))).toBe(true);
  });
});

describe("avatars.importAvatar: money gates before any spend", () => {
  test("no key stored: AUTH_INVALID, no request sent", async () => {
    const net = network();
    const { engine, stagingId } = await startWithStagedPhoto(net, undefined, { key: null });

    const response = await engine.handle(importCommand(stagingId, "Zoe", IMPORT_ESTIMATE.worstMicros));

    expect(failed(response).error.code).toBe("AUTH_INVALID");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("no staged photo: NOT_FOUND, before the key or the price are even checked", async () => {
    const net = network();
    const { engine } = await startEngine(dir(), { net });
    const response = await engine.handle(importCommand("never-staged", "Zoe", IMPORT_ESTIMATE.worstMicros));
    expect(failed(response).error.code).toBe("NOT_FOUND");
  });

  test("PRICE_CHANGED when the accepted worst case is below the current one", async () => {
    const net = network();
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const response = await engine.handle(importCommand(stagingId, "Zoe", IMPORT_ESTIMATE.worstMicros - 1));
    expect(failed(response).error.code).toBe("PRICE_CHANGED");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("BUDGET_EXCEEDED when the month has no room for the job's worst case", async () => {
    const net = network();
    const { engine, stagingId } = await startWithStagedPhoto(net, undefined, {
      init: { settings: engineSettings(dir(), { monthlyBudgetMicros: IMPORT_ESTIMATE.worstMicros - 1 }) },
    });
    const response = await engine.handle(importCommand(stagingId, "Zoe", IMPORT_ESTIMATE.worstMicros));
    expect(failed(response).error.code).toBe("BUDGET_EXCEEDED");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("a missing library: LIBRARY_UNAVAILABLE, before the staged photo is consumed", async () => {
    const net = network();
    const { engine, stagingId } = await startWithStagedPhoto(net);
    await engine.receive({
      kind: "control",
      type: "settings.update",
      settings: engineSettings(dir(), { libraryPath: join(dir(), "does-not-exist") }),
    });

    const response = await engine.handle(importCommand(stagingId, "Zoe", IMPORT_ESTIMATE.worstMicros));

    expect(failed(response).error.code).toBe("LIBRARY_UNAVAILABLE");
    // The stage survives a refusal that never got to consume it.
    const retry = await engine.handle(command("avatars.estimateImport", { stagingId }));
    expect(ok(retry).ok).toBe(true);
  });

  test("confirmedAiPersona missing or false never reaches the engine's logic: VALIDATION at the contract level", async () => {
    const net = network();
    const { engine, stagingId } = await startWithStagedPhoto(net);

    const withFalse = await engine.handle(command("avatars.importAvatar", { stagingId, name: "Zoe", confirmedAiPersona: false, acceptedWorstMicros: IMPORT_ESTIMATE.worstMicros }));
    expect(failed(withFalse).error.code).toBe("VALIDATION");

    const withoutIt = await engine.handle(command("avatars.importAvatar", { stagingId, name: "Zoe", acceptedWorstMicros: IMPORT_ESTIMATE.worstMicros }));
    expect(failed(withoutIt).error.code).toBe("VALIDATION");

    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });
});

describe("avatars.importAvatar: a library switch clears the staged photo (L5)", () => {
  test("switching to a different, valid library clears it: a fresh pick is required", async () => {
    const net = network();
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const other = join(dir(), "other");
    await mkdir(other);

    await engine.receive({ kind: "control", type: "settings.update", settings: engineSettings(dir(), { libraryPath: other }) });

    const response = await engine.handle(command("avatars.estimateImport", { stagingId }));
    expect(failed(response).error.code).toBe("NOT_FOUND");
  });

  test("switching into LIBRARY_UNAVAILABLE does not: nothing was adopted, so there is nothing to be stale against", async () => {
    const net = network();
    const { engine, stagingId } = await startWithStagedPhoto(net);

    await engine.receive({
      kind: "control",
      type: "settings.update",
      settings: engineSettings(dir(), { libraryPath: join(dir(), "does-not-exist") }),
    });

    const response = await engine.handle(command("avatars.estimateImport", { stagingId }));
    expect(ok(response).ok).toBe(true);
  });

  // Round 3, L1: settings.update is not the only switch path — library.open
  // (stage) then library.confirm (adopt) is the two-step path main's own
  // folder picker takes, and it clears #importStaging at its own call site
  // (engine.ts, the library.confirm case), separate from #applySettings's.
  test("switching via library.open + library.confirm (not settings.update) also clears it", async () => {
    const net = network();
    const started = await startWithStagedPhoto(net);
    const other = join(dir(), "confirmed-other");
    await mkdir(other);

    await started.engine.receive({ kind: "control", type: "library.open", callId: "call-lib-open-0001", path: other });
    await started.engine.receive({ kind: "control", type: "library.confirm", callId: "call-lib-confirm-0001", path: other });

    const response = await started.engine.handle(command("avatars.estimateImport", { stagingId: started.stagingId }));
    expect(failed(response).error.code).toBe("NOT_FOUND");
  });
});

// T6c review round 2, H1: importAvatar's own guards were reachable only
// through the whole engine and had no direct test — each one here is a guard
// that a regression could quietly delete without any test noticing.
describe("avatars.importAvatar: the staged photo is single-use and never stale (H1 guards 1 and 3)", () => {
  test("importing the same stagingId again after success is NOT_FOUND, with no new request", async () => {
    const net = network({ age: () => ageReply(true, 0.93), descriptors: [describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);
    expect(ok(await engine.handle(importCommand(stagingId, "Zoe", worst))).ok).toBe(true);
    const callsBefore = net.calls.length;

    const second = await engine.handle(importCommand(stagingId, "Mia", worst));

    expect(failed(second).error.code).toBe("NOT_FOUND");
    expect(net.calls).toHaveLength(callsBefore);
  });

  test("importing the same stagingId again after AGE_CHECK_FAILED is NOT_FOUND, with no new request", async () => {
    const net = network({ age: () => ageReply(false, 0.95) });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);
    expect(failed(await engine.handle(importCommand(stagingId, "Zoe", worst))).error.code).toBe("AGE_CHECK_FAILED");
    const callsBefore = net.calls.length;

    const second = await engine.handle(importCommand(stagingId, "Zoe", worst));

    expect(failed(second).error.code).toBe("NOT_FOUND");
    expect(net.calls).toHaveLength(callsBefore);
  });

  test("a stale stagingId is NOT_FOUND, even while a later stage still sits in the one slot", async () => {
    const net = network();
    const started = await startEngine(dir(), { net });
    const stale = await stageOn(started, portraitPng(1));
    const fresh = await stageOn(started, portraitPng(2)); // replaces the slot; stale no longer names anything live

    const response = await started.engine.handle(importCommand(stale, "Zoe", IMPORT_ESTIMATE.worstMicros));

    expect(failed(response).error.code).toBe("NOT_FOUND");
    // The live one is untouched by the refused, stale attempt.
    expect(ok(await started.engine.handle(command("avatars.estimateImport", { stagingId: fresh }))).ok).toBe(true);
  });

  test("L1: a later stage that lands while an earlier import is finishing survives its single-use clear", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const net = network({ prices: async () => (await held, OFFLINE), age: () => ageReply(true, 0.93), descriptors: [describeReply()] });
    const started = await startWithStagedPhoto(net, portraitPng(1));

    // No sleep needed: #importAvatar reads #importStaging and passes its
    // checks synchronously, before its own first (gated) price fetch.
    const importing = started.engine.handle(importCommand(started.stagingId, "Zoe", IMPORT_ESTIMATE.worstMicros));
    const later = await stageOn(started, portraitPng(2));
    release();
    expect(ok(await importing).ok).toBe(true);

    // The import consumed its OWN staged photo, not the one that replaced it mid-flight.
    expect(ok(await started.engine.handle(command("avatars.estimateImport", { stagingId: later }))).ok).toBe(true);
  });
});

describe("avatars.importAvatar: a second import while one is being written is refused with IN_FLIGHT (H1 guard 2)", () => {
  test("a concurrent import is refused with IN_FLIGHT; the first still finishes normally", async () => {
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => (release = resolve));
    const net = network({ prices: async () => (await held, OFFLINE), age: () => ageReply(true, 0.93), descriptors: [describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);

    // No sleep needed (same pattern as createDraft/rewriteDescriptor's own
    // IN_FLIGHT tests): #importing is set synchronously in the
    // avatars.importAvatar dispatch case, before #importAvatar's own first
    // (gated) price fetch.
    const first = engine.handle(importCommand(stagingId, "Zoe", IMPORT_ESTIMATE.worstMicros));
    const second = failed(await engine.handle(importCommand(stagingId, "Zoe", IMPORT_ESTIMATE.worstMicros)));
    expect(second.error.code).toBe("IN_FLIGHT");
    release();
    expect(ok(await first).ok).toBe(true);
  });
});

describe("avatars.importAvatar: the age check's own non-ok paths never reach the describe call (H1 guard 4)", () => {
  interface Case {
    name: string;
    age: () => Reply;
    code: ErrorCode;
  }

  const cases: Case[] = [
    { name: "a confidence below the age check's own threshold", age: () => ageReply(true, 0.5), code: "AGE_CHECK_FAILED" },
    { name: "an answer that is not the JSON asked for (unreadable)", age: () => ({ status: 200, body: chatBody("The person is an adult.", { cost: 0.0014 }) }), code: "AGE_CHECK_FAILED" },
    { name: "an empty answer (EMPTY_CONTENT)", age: () => ({ status: 200, body: chatBody(null, { cost: 0.0014 }) }), code: "AGE_CHECK_FAILED" },
    { name: "a moderation refusal", age: () => MODERATION, code: "AGE_CHECK_FAILED" },
    { name: "a network error before any response", age: () => OFFLINE, code: "NETWORK" },
    {
      name: "a charge above the worst case",
      age: () => ({ status: 200, body: chatBody(JSON.stringify({ adult: true, confidence: 0.95, reason: "An adult." }), { cost: 6 }) }),
      code: "SETTLE_ABOVE_WORST",
    },
  ];

  test.each(cases.map((c): [string, Case] => [c.name, c]))("%s", async (_label, c) => {
    const net = network({ age: c.age });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const response = await engine.handle(importCommand(stagingId, "Zoe", worst));

    expect(failed(response).error.code).toBe(c.code);
    expect(describeCalls(net)).toHaveLength(0);
    const listing = ok(await engine.handle(command("avatars.list")));
    if (listing.type !== "avatars.list") throw new Error("wrong type");
    expect(listing.result.avatars).toHaveLength(0);
  });
});

describe("avatars.importAvatar: a 401 marks the key rejected (H1 guard 5)", () => {
  test("a 401 from the age check answers AUTH_INVALID and marks the key rejected", async () => {
    const net = network({ age: () => ({ status: 401, body: { error: { message: "No auth credentials found" } } }) });
    const { engine, stagingId, events } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const response = await engine.handle(importCommand(stagingId, "Zoe", worst));

    expect(failed(response).error.code).toBe("AUTH_INVALID");
    expect(events().at(-1)).toMatchObject({ type: "settings.changed", payload: { settings: { apiKey: { rejected: true } } } });
  });

  test("a 401 from the describe call (after the age check settled) also marks the key rejected", async () => {
    const net = network({ age: () => ageReply(true, 0.93), descriptors: [{ status: 401, body: { error: { message: "No auth credentials found" } } }] });
    const { engine, stagingId, events } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const response = await engine.handle(importCommand(stagingId, "Zoe", worst));

    expect(failed(response).error.code).toBe("AUTH_INVALID");
    expect(events().at(-1)).toMatchObject({ type: "settings.changed", payload: { settings: { apiKey: { rejected: true } } } });
  });
});

// Round 3, L7: renamed to say what this actually proves — the engine's own
// handling of a write failure (INTERNAL, nothing listed, the paid
// description kept in raw/), not the write's atomicity itself. Atomicity
// (one rename, nothing partial) is library.avatars.test.ts's own job, proven
// there with the beforeRename test hook, not by chmod here.
describe("avatars.importAvatar: a failing library write answers INTERNAL and keeps the paid work (H1 guard 6)", () => {
  test.skipIf(process.platform === "win32")(
    "the avatars folder cannot be written: INTERNAL, no avatar listed, the paid description is kept in raw/",
    async () => {
      const net = network({ age: () => ageReply(true, 0.93), descriptors: [describeReply()] });
      const { engine, stagingId } = await startWithStagedPhoto(net);
      const worst = await estimateWorst(engine, stagingId);
      const avatarsDir = join(dir(), "library", "avatars");

      await chmod(avatarsDir, 0o555);
      let response: ResponseMessage;
      try {
        response = await engine.handle(importCommand(stagingId, "Zoe", worst));
      } finally {
        await chmod(avatarsDir, 0o755);
      }

      expect(failed(response).error.code).toBe("INTERNAL");
      const listing = ok(await engine.handle(command("avatars.list")));
      if (listing.type !== "avatars.list") throw new Error("wrong type");
      expect(listing.result.avatars).toHaveLength(0);
      expect(await filesUnder(avatarsDir)).toEqual([]);

      const rawDir = join(dir(), "userData", "raw");
      const rawFiles = await readdir(rawDir);
      expect(rawFiles).toHaveLength(1);
      const rawFile = rawFiles[0];
      if (rawFile === undefined) throw new Error("expected a kept raw file");
      const kept = JSON.parse(await readFile(join(rawDir, rawFile), "utf8")) as { traits: unknown; descriptor: { text: string } };
      expect(kept.descriptor).toMatchObject({ text: GOOD });
    },
  );
});

// Round 3, L3: recordRefusedImport itself can fail (disk full, a read-only
// library folder) — that must never turn a genuine AGE_CHECK_FAILED verdict
// into an unrelated INTERNAL, and it must never be swallowed silently either.
describe("avatars.importAvatar: recording the refusal can itself fail, without losing the refusal (L3)", () => {
  test.skipIf(process.platform === "win32")(
    "a read-only library folder: still AGE_CHECK_FAILED, with a note that the refusal could not be remembered",
    async () => {
      const net = network({ age: () => ageReply(false, 0.95) });
      const { engine, stagingId } = await startWithStagedPhoto(net);
      const worst = await estimateWorst(engine, stagingId);
      const libraryRoot = join(dir(), "library");

      await chmod(libraryRoot, 0o555);
      let response: ResponseMessage;
      try {
        response = await engine.handle(importCommand(stagingId, "Zoe", worst));
      } finally {
        await chmod(libraryRoot, 0o755);
      }

      const failure = failed(response);
      expect(failure.error.code).toBe("AGE_CHECK_FAILED");
      expect(failure.error.detail).toContain("could not be remembered");
    },
  );
});

describe("avatars.importAvatar: the one-time age check", () => {
  test("a refusal stores nothing and settles: no avatar, the age attempt is reserved and settled", async () => {
    const net = network({ age: () => ageReply(false, 0.95) });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const response = await engine.handle(importCommand(stagingId, "Zoe", worst));

    expect(failed(response).error.code).toBe("AGE_CHECK_FAILED");
    expect(describeCalls(net)).toHaveLength(0);
    const listing = ok(await engine.handle(command("avatars.list")));
    if (listing.type !== "avatars.list") throw new Error("wrong type");
    expect(listing.result.avatars).toHaveLength(0);

    const lines = ledgerLines(dir());
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatchObject({ type: "reserve", worstMicros: AGE_WORST });
    expect(lines[1]).toMatchObject({ type: "settle" });
  });
});

describe("avatars.importAvatar: the description gate", () => {
  test("a rejected first answer is asked once more; a good second answer succeeds", async () => {
    const net = network({ age: () => ageReply(true, 0.93), descriptors: [describeReply({ ethnicity: "martian" }), describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const response = await engine.handle(importCommand(stagingId, "Zoe", worst));

    expect(ok(response).ok).toBe(true);
    expect(describeCalls(net)).toHaveLength(2);
  });

  test("rejected twice fails the import; nothing is stored, every attempt (age + 2 describe) is settled", async () => {
    const net = network({
      age: () => ageReply(true, 0.93),
      descriptors: [describeReply({ ethnicity: "martian" }), describeReply({ descriptor: "not anchored at all" })],
    });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const response = await engine.handle(importCommand(stagingId, "Zoe", worst));

    expect(failed(response).error.code).toBe("INTERNAL");
    const listing = ok(await engine.handle(command("avatars.list")));
    if (listing.type !== "avatars.list") throw new Error("wrong type");
    expect(listing.result.avatars).toHaveLength(0);

    const lines = ledgerLines(dir());
    expect(lines.filter((l) => l.type === "reserve")).toHaveLength(3);
    expect(lines.filter((l) => l.type === "settle")).toHaveLength(3);
    const firstDescribeReserve = lines.find((l) => l.type === "reserve" && String(l.attemptId).endsWith(":describe#1"));
    expect(firstDescribeReserve).toMatchObject({ worstMicros: DESCRIBE_WORST });
  });
});

// T6c review round 2, M5: "women only, exactly one person" — the photo does
// not change between attempts, so a group photo (or one with a child in it)
// or the wrong gender fails at once, with no second describe attempt.
describe("avatars.importAvatar: the subject check (M5, exactly one woman)", () => {
  test("a group photo (people: 2) fails at once with IMPORT_SUBJECT_INVALID; nothing stored, one settled describe attempt", async () => {
    const net = network({ age: () => ageReply(true, 0.93), descriptors: [describeReply({ people: 2 })] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const response = await engine.handle(importCommand(stagingId, "Zoe", worst));

    expect(failed(response).error.code).toBe("IMPORT_SUBJECT_INVALID");
    expect(describeCalls(net)).toHaveLength(1);
    const listing = ok(await engine.handle(command("avatars.list")));
    if (listing.type !== "avatars.list") throw new Error("wrong type");
    expect(listing.result.avatars).toHaveLength(0);

    const lines = ledgerLines(dir());
    expect(lines.filter((l) => l.type === "reserve")).toHaveLength(2); // age + one describe, never a second
    expect(lines.filter((l) => l.type === "settle")).toHaveLength(2);
  });

  test("exactly one person who is not a woman fails at once with IMPORT_SUBJECT_INVALID", async () => {
    const net = network({ age: () => ageReply(true, 0.93), descriptors: [describeReply({ woman: false })] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const response = await engine.handle(importCommand(stagingId, "Zoe", worst));

    expect(failed(response).error.code).toBe("IMPORT_SUBJECT_INVALID");
    expect(describeCalls(net)).toHaveLength(1);
  });
});

describe("avatars.importAvatar: the cap is cleared afterward", () => {
  test("two imports in a row, in the same engine, both succeed: no leftover cap from the first blocks the second", async () => {
    const net = network({ age: () => ageReply(true, 0.93), descriptors: [describeReply(), describeReply({ ethnicity: "latina" })] });
    const started = await startEngine(dir(), { net });

    for (const name of ["Zoe", "Mia"]) {
      const stagingId = await stageOn(started);
      const worst = await estimateWorst(started.engine, stagingId);
      const response = await started.engine.handle(importCommand(stagingId, name, worst));
      expect(ok(response).ok).toBe(true);
    }

    const listing = ok(await started.engine.handle(command("avatars.list")));
    if (listing.type !== "avatars.list") throw new Error("wrong type");
    expect(listing.result.avatars).toHaveLength(2);
  });

  // L2: the test above passes even without #caps.delete — each import gets
  // its own fresh scope, so a leftover cap from the first can never be read
  // by the second's own (freshly set) one. What #caps.delete actually
  // guards is a stray reserve in the FIRST job's OWN scope, after it ended:
  // undeleted, its leftover cap (the whole job's worst case) would still
  // authorize spending nothing should be authorizing there any more; deleted,
  // capOf() falls back to a 0 cap and refuses it.
  test("after an import ends, its own scope is capped at 0: a stray reserve in it is refused, not allowed by a leftover cap", async () => {
    const net = network({ age: () => ageReply(true, 0.93), descriptors: [describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);
    expect(ok(await engine.handle(importCommand(stagingId, "Zoe", worst))).ok).toBe(true);

    const reserveLine = ledgerLines(dir()).find((l) => l.type === "reserve") as { scope: { avatarJobId: string } } | undefined;
    if (reserveLine === undefined) throw new Error("expected a reserve line");
    const budget = engine.budget;
    if (budget === null) throw new Error("expected a budget");

    const stray = await budget.tryReserve({
      attemptId: "stray-0001",
      jobId: "stray-job",
      scope: reserveLine.scope,
      model: "x-ai/grok-4.3",
      worstMicros: 1,
    });

    expect(stray).toMatchObject({ ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: 0 });
  });
});
