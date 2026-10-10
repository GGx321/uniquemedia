import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Estimate, ResponseMessage } from "../shared/engine";
import { IMPORT_DESCRIBE_MAX_SIDE } from "./avatars/importStaging";
import { openLibrary } from "./library";
import { PNG_1X1 } from "./library/testing/helpers";
import { chatBody, type FetchCall, type Reply } from "./openrouter/testing/fakes";
import {
  checkCalls,
  checkReply,
  command,
  engineSettings,
  failed,
  filesUnder,
  GOOD,
  ledgerLines,
  network,
  NOW,
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
// The vision describe job writes both typed traits and the descriptor in one
// strict JSON answer. Owner decision 2026-10-05 (personal-use app): an import
// makes no age check and asks for no AI-persona confirmation.

const dir = useEngineDir("studio-engine-import-");

/** The import job's price at the dated fallback table (plan.test.ts pins the same numbers). */
const IMPORT_ESTIMATE: Estimate = { expectedMicros: 7_250, worstMicros: 62_500, prices: "fallback", pricesAsOf: "2026-09-24" };
const DESCRIBE_WORST = 18_750;

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
  return command("avatars.importAvatar", { stagingId, name, acceptedWorstMicros, ...extra });
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

  // Since the age check left the import, the one staged JPEG is the describe call's: exactly one downscale, at IMPORT_DESCRIBE_MAX_SIDE.
  test("a valid photo is downscaled exactly once, at the describe call's side", async () => {
    const sides: number[] = [];
    const started = await startEngine(dir(), {
      net: network(),
      deps: {
        downscaleImportPhoto: (_bytes, maxSide) => {
          sides.push(maxSide);
          return Promise.resolve(Uint8Array.from([0xff, 0xd8, 0xff]));
        },
      },
    });

    await started.engine.receive({ kind: "control", type: "import.stagePhoto", callId: "call-00000020", bytes: portraitPng() });

    expect(replyFor(started.posted, "call-00000020")?.stage).toBeDefined();
    expect(sides).toEqual([IMPORT_DESCRIBE_MAX_SIDE]);
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

// Owner decision 2026-10-05: the refused-imports list is gone. A library an
// older build wrote may still hold its `refused-imports.json`; it is neither
// read nor rewritten, and a photo it names stages and imports like any other.
describe("import.stagePhoto: a legacy refused-imports.json no longer refuses anything", () => {
  test("a photo whose sha256 an old refused-imports.json lists stages and imports, and the file is left as it was", async () => {
    const bytes = portraitPng(3);
    const net = network({ descriptors: [describeReply()] });
    const started = await startEngine(dir(), { net });
    const legacyPath = join(dir(), "library", "refused-imports.json");
    const legacy = JSON.stringify({ schemaVersion: 1, sha256: [createHash("sha256").update(bytes).digest("hex")] });
    await writeFile(legacyPath, legacy);

    const stagingId = await stageOn(started, bytes);
    const worst = await estimateWorst(started.engine, stagingId);
    const response = await started.engine.handle(importCommand(stagingId, "Zoe", worst));

    expect(ok(response).ok).toBe(true);
    expect(await readFile(legacyPath, "utf8")).toBe(legacy);
  });
});

describe("avatars.estimateImport", () => {
  test("NOT_FOUND without a staged photo", async () => {
    const { engine } = await startEngine(dir(), { net: network() });
    const response = await engine.handle(command("avatars.estimateImport", { stagingId: "no-such-stage" }));
    expect(failed(response).error.code).toBe("NOT_FOUND");
  });

  test("prices up to two describe attempts and up to two checks of the avatar it saves (S5.0c)", async () => {
    const { engine, stagingId } = await startWithStagedPhoto(network());
    const response = await engine.handle(command("avatars.estimateImport", { stagingId }));
    expect(ok(response).result).toEqual(IMPORT_ESTIMATE);
  });
});

describe("avatars.importAvatar: happy path", () => {
  test("the describe call succeeds: a new active avatar with the imported photo as its master", async () => {
    const net = network({ descriptors: [describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const response = await engine.handle(importCommand(stagingId, "Zoe", worst));

    const answer = ok(response);
    if (answer.type !== "avatars.importAvatar") throw new Error("wrong type");
    expect(answer.result.avatar).toMatchObject({ name: "Zoe", status: "active", photoCount: 0, descriptor: { age: 25, text: GOOD } });

    const { library } = await openLibrary(join(dir(), "library"));
    const manifest = library.getAvatar(answer.result.avatar.avatarId);
    expect(manifest?.status).toBe("active");
    const photo = manifest?.masterPhotoId ? library.getPhoto(manifest.masterPhotoId) : undefined;
    expect(photo?.source.kind).toBe("imported");
  });

  test("the sidecar of an imported photo records neither an age verdict nor an AI-persona confirmation", async () => {
    const net = network({ descriptors: [describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const answer = ok(await engine.handle(importCommand(stagingId, "Zoe", worst)));
    if (answer.type !== "avatars.importAvatar") throw new Error("wrong type");

    const { library } = await openLibrary(join(dir(), "library"));
    const masterId = library.getAvatar(answer.result.avatar.avatarId)?.masterPhotoId;
    const photo = masterId ? library.getPhoto(masterId) : undefined;
    expect(photo?.qa.age).toBeUndefined();
    expect(photo?.source).toEqual({ kind: "imported", importedAt: expect.any(String) as unknown as string });
  });

  test.each([["on" as const], ["off" as const]])("an import sends no age check and reserves no age money, with settings.imageAgeCheck %s", async (imageAgeCheck) => {
    const net = network({ descriptors: [describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net, undefined, { init: { settings: engineSettings(dir(), { imageAgeCheck }) } });
    const worst = await estimateWorst(engine, stagingId);

    expect(ok(await engine.handle(importCommand(stagingId, "Nia", worst))).ok).toBe(true);

    expect(net.ageCalls()).toHaveLength(0);
    // S5.0c (deliberate re-pin): the import also checks the avatar it saved, so its check's reserve follows the describe's; neither is an age money.
    const reserves = ledgerLines(dir()).filter((l) => l.type === "reserve");
    expect(reserves).toHaveLength(2);
    expect(reserves[0]).toMatchObject({ worstMicros: DESCRIBE_WORST });
    expect(reserves.map((r) => String(r.attemptId).split(":").at(-1))).toEqual(["describe#1", "check#1"]);
  });

  test("attempt ids: <importId>:describe#N, never an :age one", async () => {
    const net = network({ descriptors: [describeReply({ ethnicity: "martian" }), describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    await engine.handle(importCommand(stagingId, "Ada", worst));

    const ids = ledgerLines(dir())
      .filter((l) => l.type === "reserve")
      .map((l) => String(l.attemptId));
    expect(ids.some((id) => /:age$/.test(id))).toBe(false);
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

  // Strict on purpose: the renderer ships inside the same app bundle as the engine, so no older renderer can be talking to this engine,
  // and a strict object keeps an unknown key a loud VALIDATION like every other command's payload.
  test("a payload still carrying the removed confirmedAiPersona is VALIDATION at the contract level, and nothing is sent", async () => {
    const net = network();
    const { engine, stagingId } = await startWithStagedPhoto(net);

    const response = await engine.handle(
      command("avatars.importAvatar", { stagingId, name: "Zoe", confirmedAiPersona: true, acceptedWorstMicros: IMPORT_ESTIMATE.worstMicros }),
    );

    expect(failed(response).error.code).toBe("VALIDATION");
    expect(net.calls.filter((c) => c.method === "POST")).toHaveLength(0);
  });

  test("a payload without any confirmation is accepted: stagingId, name and the accepted worst case are enough", async () => {
    const net = network({ descriptors: [describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);

    const response = await engine.handle(command("avatars.importAvatar", { stagingId, name: "Zoe", acceptedWorstMicros: IMPORT_ESTIMATE.worstMicros }));

    expect(ok(response).ok).toBe(true);
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
    const net = network({ descriptors: [describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);
    expect(ok(await engine.handle(importCommand(stagingId, "Zoe", worst))).ok).toBe(true);
    const callsBefore = net.calls.length;

    const second = await engine.handle(importCommand(stagingId, "Mia", worst));

    expect(failed(second).error.code).toBe("NOT_FOUND");
    expect(net.calls).toHaveLength(callsBefore);
  });

  test("importing the same stagingId again after a failed import is NOT_FOUND, with no new request", async () => {
    const net = network({ descriptors: [describeReply({ people: 2 })] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);
    expect(failed(await engine.handle(importCommand(stagingId, "Zoe", worst))).error.code).toBe("IMPORT_SUBJECT_INVALID");
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
    const net = network({ prices: async () => (await held, OFFLINE), descriptors: [describeReply()] });
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
    const net = network({ prices: async () => (await held, OFFLINE), descriptors: [describeReply()] });
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

describe("avatars.importAvatar: a 401 marks the key rejected (H1 guard 5)", () => {
  test("a 401 from the describe call answers AUTH_INVALID and marks the key rejected", async () => {
    const net = network({ descriptors: [{ status: 401, body: { error: { message: "No auth credentials found" } } }] });
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
      const net = network({ descriptors: [describeReply()] });
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

describe("avatars.importAvatar: the description gate", () => {
  test("a rejected first answer is asked once more; a good second answer succeeds", async () => {
    const net = network({ descriptors: [describeReply({ ethnicity: "martian" }), describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const response = await engine.handle(importCommand(stagingId, "Zoe", worst));

    expect(ok(response).ok).toBe(true);
    expect(describeCalls(net)).toHaveLength(2);
  });

  test("rejected twice fails the import; nothing is stored, both describe attempts are settled", async () => {
    const net = network({
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
    expect(lines.filter((l) => l.type === "reserve")).toHaveLength(2);
    expect(lines.filter((l) => l.type === "settle")).toHaveLength(2);
    const firstDescribeReserve = lines.find((l) => l.type === "reserve" && String(l.attemptId).endsWith(":describe#1"));
    expect(firstDescribeReserve).toMatchObject({ worstMicros: DESCRIBE_WORST });
  });
});

// T6c review round 2, M5: "women only, exactly one person" — the photo does
// not change between attempts, so a group photo (or one with a child in it)
// or the wrong gender fails at once, with no second describe attempt.
describe("avatars.importAvatar: the subject check (M5, exactly one woman)", () => {
  test("a group photo (people: 2) fails at once with IMPORT_SUBJECT_INVALID; nothing stored, one settled describe attempt", async () => {
    const net = network({ descriptors: [describeReply({ people: 2 })] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const response = await engine.handle(importCommand(stagingId, "Zoe", worst));

    expect(failed(response).error.code).toBe("IMPORT_SUBJECT_INVALID");
    expect(describeCalls(net)).toHaveLength(1);
    const listing = ok(await engine.handle(command("avatars.list")));
    if (listing.type !== "avatars.list") throw new Error("wrong type");
    expect(listing.result.avatars).toHaveLength(0);

    const lines = ledgerLines(dir());
    expect(lines.filter((l) => l.type === "reserve")).toHaveLength(1); // one describe, never a second
    expect(lines.filter((l) => l.type === "settle")).toHaveLength(1);
  });

  test("exactly one person who is not a woman fails at once with IMPORT_SUBJECT_INVALID", async () => {
    const net = network({ descriptors: [describeReply({ woman: false })] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const response = await engine.handle(importCommand(stagingId, "Zoe", worst));

    expect(failed(response).error.code).toBe("IMPORT_SUBJECT_INVALID");
    expect(describeCalls(net)).toHaveLength(1);
  });
});

describe("avatars.importAvatar: the cap is cleared afterward", () => {
  test("two imports in a row, in the same engine, both succeed: no leftover cap from the first blocks the second", async () => {
    const net = network({ descriptors: [describeReply(), describeReply({ ethnicity: "latina" })] });
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
    const net = network({ descriptors: [describeReply()] });
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

// ---------- Stage 5, S5.0c: the descriptor check of the avatar the import saves ----------

// The avatar is saved first (`createImportedAvatar`); then, in the same command, the check compares the stored descriptor with the staged photo. It runs in the import's own scope,
// under the import's own cap, which therefore must outlive the describe call and be cleared (and the money announced) only after the check (r2.1 · N3): a scope without a cap
// reserves nothing, and a check placed after that would be refused and silently give null. A refusal, a timeout or an unreadable answer gives `descriptorCheck: null` and never
// undoes the paid import.

const CHECK_ATTEMPT_WORST = 12_500;
const FIXED_HAIR = "25-year-old European woman, light olive skin, hazel eyes, long straight platinum hair with bangs, athletic build, light freckles across the nose.";
const HAIR_MISMATCH = {
  aspects: {
    hair: { state: "mismatch", descriptor: "волнистые каштановые", photo: "прямые платиновые с чёлкой" },
    eyes: { state: "ok", descriptor: "", photo: "" },
    marks: { state: "ok", descriptor: "", photo: "" },
    body: { state: "not-visible", descriptor: "", photo: "" },
  },
  descriptor: FIXED_HAIR,
};

/** The image of a request, as the data URL the wire carries. */
function imageOf(call: FetchCall | undefined): string | undefined {
  return /data:image\/jpeg;base64,[A-Za-z0-9+/=]+/.exec(JSON.stringify(call?.json()))?.[0];
}

/** The avatar folders of the library on disk now. */
async function savedAvatars(): Promise<string[]> {
  return readdir(join(dir(), "library", "avatars")).catch(() => []);
}

function importResult(response: ResponseMessage) {
  const answer = ok(response);
  if (answer.type !== "avatars.importAvatar") throw new Error("wrong type");
  return answer.result;
}

describe("avatars.importAvatar: the descriptor check of the avatar it saves (S5.0c)", () => {
  // N3, the happy path: a check that is refused by a missing cap would give null and every other test below would still pass.
  test("N3: the check reserves under the import's scope at <importId>:check#1, within the cap the import registered, and returns a non-null check", async () => {
    const net = network({ descriptors: [describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const result = importResult(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    expect(result.descriptorCheck).toEqual({
      matches: true,
      aspects: { hair: { state: "ok" }, eyes: { state: "ok" }, marks: { state: "ok" }, body: { state: "not-visible" } },
      proposal: null,
      checkedText: GOOD,
    });
    const reserves = ledgerLines(dir()).filter((l) => l.type === "reserve") as { attemptId: string; jobId: string; scope: { avatarJobId: string }; worstMicros: number }[];
    const importId = reserves[0]?.jobId;
    if (importId === undefined) throw new Error("no reserve was written");
    expect(reserves.map((r) => r.attemptId)).toEqual([`${importId}:describe#1`, `${importId}:check#1`]);
    for (const reserve of reserves) expect(reserve.scope).toEqual({ avatarJobId: importId });
    expect(reserves[1]?.worstMicros).toBe(CHECK_ATTEMPT_WORST);
    expect(reserves.reduce((sum, r) => sum + r.worstMicros, 0)).toBeLessThanOrEqual(worst);
  });

  test("the avatar is saved before the check is asked", async () => {
    const asked: { saved: string[] | null } = { saved: null };
    const net = network({
      descriptors: [describeReply()],
      check: async () => {
        asked.saved = await savedAvatars();
        return checkReply();
      },
    });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const result = importResult(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    expect(asked.saved).toEqual([result.avatar.avatarId]);
  });

  test("the check judges the descriptor the describe call wrote, against the same staged photo", async () => {
    const net = network({ descriptors: [describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    ok(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    const describeImage = imageOf(describeCalls(net)[0]);
    expect(describeImage).toBeDefined();
    expect(imageOf(checkCalls(net)[0])).toBe(describeImage);
    expect(JSON.stringify(checkCalls(net)[0]?.json())).toContain(GOOD);
  });

  test("the name the owner typed never reaches the check's prompt", async () => {
    const net = network({ descriptors: [describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    ok(await engine.handle(importCommand(stagingId, "Zoyechka", worst)));

    expect(JSON.stringify(checkCalls(net)[0]?.json())).not.toContain("Zoyechka");
  });

  test("the money is announced only after the check, not between the describe and the check", async () => {
    const asked: { money: number | null; eventsOf: () => { type: string }[] } = { money: null, eventsOf: () => [] };
    const net = network({
      descriptors: [describeReply()],
      check: () => {
        asked.money = asked.eventsOf().filter((e) => e.type === "money.changed").length;
        return checkReply();
      },
    });
    const { engine, stagingId, events } = await startWithStagedPhoto(net);
    asked.eventsOf = events;
    const before = events().filter((e) => e.type === "money.changed").length;
    const worst = await estimateWorst(engine, stagingId);

    ok(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    expect(asked.money).toBe(before);
    expect(events().filter((e) => e.type === "money.changed").length).toBeGreaterThan(before);
  });

  test("a mismatch comes back with its proposal, and the saved descriptor is still the one the describe call wrote", async () => {
    const net = network({ descriptors: [describeReply()], check: () => checkReply(HAIR_MISMATCH) });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const result = importResult(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    expect(result.descriptorCheck).toMatchObject({ matches: false, proposal: FIXED_HAIR, checkedText: GOOD });
    expect(result.avatar.descriptor.text).toBe(GOOD);
    const { library } = await openLibrary(join(dir(), "library"));
    expect(library.getAvatar(result.avatar.avatarId)?.descriptor).toBe(GOOD);
  });

  test("a refused check gives descriptorCheck null; the avatar is kept and the describe attempt is settled", async () => {
    const net = network({ descriptors: [describeReply()], check: () => ({ status: 400, body: { error: { message: "xAI blocked this request through content moderation." } } }) });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const result = importResult(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    expect(result.descriptorCheck).toBeNull();
    expect(result.avatar).toMatchObject({ name: "Zoe", status: "active" });
    expect(await savedAvatars()).toEqual([result.avatar.avatarId]);
    const lines = ledgerLines(dir());
    expect(lines.filter((l) => l.type === "settle").map((l) => l.costMicros)).toEqual([2_100, 0]);
  });

  test("an answer unreadable twice gives null; the avatar is kept and both check attempts are settled", async () => {
    const net = network({ descriptors: [describeReply()], check: () => ({ status: 200, body: chatBody("nope", { cost: 0.002 }) }) });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const result = importResult(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    expect(result.descriptorCheck).toBeNull();
    expect(checkCalls(net)).toHaveLength(2);
    expect(ledgerLines(dir()).filter((l) => l.type === "settle")).toHaveLength(3);
    expect(await savedAvatars()).toEqual([result.avatar.avatarId]);
  });

  test("a check that gets no answer within its own timeout gives null; the avatar is kept and the check's reserve stays open at its worst case", async () => {
    const net = network({ descriptors: [describeReply()], check: () => ({ hang: true }) });
    const { engine, stagingId } = await startWithStagedPhoto(net, undefined, { deps: { descriptorCheckTimeoutMs: 50 } });
    const worst = await estimateWorst(engine, stagingId);

    const result = importResult(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    expect(result.descriptorCheck).toBeNull();
    expect(await savedAvatars()).toEqual([result.avatar.avatarId]);
    const lines = ledgerLines(dir());
    const open = lines.filter((l) => l.type === "reserve" && !lines.some((s) => s.type === "settle" && s.attemptId === l.attemptId));
    expect(open.map((l) => [String(l.attemptId).split(":").at(-1), l.worstMicros])).toEqual([["check#1", CHECK_ATTEMPT_WORST]]);
  });

  test("a 401 on the check gives null and marks the key rejected; the avatar is kept", async () => {
    const net = network({ descriptors: [describeReply()], check: () => ({ status: 401, body: { error: { message: "No auth credentials found" } } }) });
    const { engine, stagingId, events } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const result = importResult(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    expect(result.descriptorCheck).toBeNull();
    expect(events().some((e) => e.type === "settings.changed" && JSON.stringify(e.payload).includes('"rejected":true'))).toBe(true);
    expect(await savedAvatars()).toEqual([result.avatar.avatarId]);
  });

  test("while the check runs the new avatar is claimed: an edit of its descriptor and an archive are IN_FLIGHT, and an edit is allowed once the import returns", async () => {
    const seen: { attempt: (() => Promise<ResponseMessage[]>) | null; answers: ResponseMessage[] } = { attempt: null, answers: [] };
    const net = network({
      descriptors: [describeReply()],
      check: async () => {
        seen.answers = (await seen.attempt?.()) ?? [];
        return checkReply();
      },
    });
    const { engine, stagingId, events } = await startWithStagedPhoto(net);
    seen.attempt = async () => {
      const changed = events().find((e) => e.type === "avatar.changed");
      const avatarId = changed?.type === "avatar.changed" ? changed.payload.avatar.avatarId : "avatar-not-announced";
      return [
        await engine.handle(command("avatars.editDescriptor", { avatarId, text: FIXED_HAIR, expectedText: GOOD })),
        await engine.handle(command("avatars.archive", { avatarId })),
      ];
    };
    const worst = await estimateWorst(engine, stagingId);

    const result = importResult(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    expect(seen.answers.map((a) => (a.ok ? "ok" : a.error.code))).toEqual(["IN_FLIGHT", "IN_FLIGHT"]);
    const { avatarId } = result.avatar;
    ok(await engine.handle(command("avatars.editDescriptor", { avatarId, text: FIXED_HAIR, expectedText: GOOD })));
    expect((await openLibrary(join(dir(), "library"))).library.getAvatar(avatarId)?.descriptor).toBe(FIXED_HAIR);
  });

  test("a describe that fails sends no check", async () => {
    const net = network({ descriptors: [describeReply({ people: 2 })] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    expect(failed(await engine.handle(importCommand(stagingId, "Zoe", worst))).error.code).toBe("IMPORT_SUBJECT_INVALID");

    expect(checkCalls(net)).toHaveLength(0);
  });

  test.skipIf(process.platform === "win32")("a library write that fails sends no check: nothing was saved to check", async () => {
    const net = network({ descriptors: [describeReply()] });
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
    expect(checkCalls(net)).toHaveLength(0);
  });

  test("the previous import's worst case, without the check, is PRICE_CHANGED now: the click accepted a price that includes it", async () => {
    const net = network();
    const { engine, stagingId } = await startWithStagedPhoto(net);

    expect(failed(await engine.handle(importCommand(stagingId, "Zoe", 2 * DESCRIBE_WORST))).error.code).toBe("PRICE_CHANGED");
    expect(net.paidCalls()).toHaveLength(0);
  });

  test("after the check the import's scope is capped at 0 again: a stray reserve in it is refused", async () => {
    const net = network({ descriptors: [describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);
    ok(await engine.handle(importCommand(stagingId, "Zoe", worst)));
    const budget = engine.budget;
    if (budget === null) throw new Error("expected a budget");
    const reserve = ledgerLines(dir()).find((l) => l.type === "reserve") as { scope: { avatarJobId: string } } | undefined;
    if (reserve === undefined) throw new Error("expected a reserve line");

    const stray = await budget.tryReserve({ attemptId: "stray-0002", jobId: "stray-job", scope: reserve.scope, model: "x-ai/grok-4.3", worstMicros: 1 });

    expect(stray).toMatchObject({ ok: false, reason: "RUN_CAP_EXCEEDED", limitMicros: 0 });
  });
});

// Stage 5, S5.2b: the body the photo showed is kept on the avatar as a proposal (never as traits), in the same atomic write as the avatar. The owner saves it with `avatars.setBody`
// or drops it with `avatars.dismissBodyProposal` (S5.2a); until then it comes back with the avatar, whenever it is listed.
describe("avatars.importAvatar: the body proposal (S5.2b)", () => {
  const UNKNOWN = { height: "unknown", bust: "unknown", figure: "unknown", legLength: "unknown", legShape: "unknown", bottomSize: "unknown", bottomShape: "unknown", bodyMarks: [] };
  const SHOWN = { ...UNKNOWN, height: "tall", bust: "full", bodyMarks: ["mole-back"] };
  const AT = new Date(NOW).toISOString();

  function manifestOf(avatarId: string): { traits: Record<string, unknown>; bodyProposal?: unknown } {
    return JSON.parse(readFileSync(join(dir(), "library", "avatars", avatarId, "avatar.json"), "utf8")) as { traits: Record<string, unknown>; bodyProposal?: unknown };
  }

  test("what the photo showed comes back on the avatar as a proposal: values, a seen mark per key, and when it was read", async () => {
    const net = network({ descriptors: [describeReply(SHOWN)] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const result = importResult(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    expect(result.avatar.bodyProposal).toEqual({
      values: { height: "tall", bust: "full", bodyMarks: ["mole-back"] },
      seen: { height: "photo", bust: "photo", figure: "not-visible", legLength: "not-visible", legShape: "not-visible", bottomSize: "not-visible", bottomShape: "not-visible", bodyMarks: "photo" },
      at: AT,
    });
  });

  test("it is stored in the avatar's own write: the manifest already holds it when the check is asked", async () => {
    const seen: { manifest: { traits: Record<string, unknown>; bodyProposal?: unknown } | null } = { manifest: null };
    const net = network({
      descriptors: [describeReply(SHOWN)],
      check: async () => {
        const [avatarId] = await savedAvatars();
        seen.manifest = avatarId === undefined ? null : manifestOf(avatarId);
        return checkReply();
      },
    });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    ok(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    expect(seen.manifest?.bodyProposal).toMatchObject({ values: { height: "tall", bust: "full", bodyMarks: ["mole-back"] }, at: AT });
  });

  test("nothing becomes a trait: the stored traits and the summary carry no body key", async () => {
    const net = network({ descriptors: [describeReply(SHOWN)] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const result = importResult(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    const traits = manifestOf(result.avatar.avatarId).traits;
    for (const key of ["height", "bust", "figure", "legLength", "legShape", "bottomSize", "bottomShape", "bodyMarks"]) expect(key in traits).toBe(false);
    expect(result.avatar.body).toBeUndefined();
    expect(result.avatar.descriptor.body).toBeUndefined();
  });

  test("a photo that shows no body stores no proposal at all", async () => {
    const net = network({ descriptors: [describeReply(UNKNOWN)] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const result = importResult(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    expect(result.avatar.bodyProposal).toBeUndefined();
    expect("bodyProposal" in manifestOf(result.avatar.avatarId)).toBe(false);
  });

  test("an answer from before the body keys existed stores no proposal either", async () => {
    const net = network({ descriptors: [describeReply()] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    const result = importResult(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    expect(result.avatar.bodyProposal).toBeUndefined();
  });

  test("«Позже» keeps it: the avatar list shows the same proposal until it is saved or dismissed", async () => {
    const net = network({ descriptors: [describeReply(SHOWN)] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);
    const imported = importResult(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    const listed = ok(await engine.handle(command("avatars.list", {})));
    if (listed.type !== "avatars.list") throw new Error("wrong type");

    expect(listed.result.avatars.find((a) => a.avatarId === imported.avatar.avatarId)?.bodyProposal).toEqual(imported.avatar.bodyProposal);
  });

  test("the check of the new avatar is asked without a body phrase: the proposal is not a trait", async () => {
    const net = network({ descriptors: [describeReply(SHOWN)] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    ok(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    expect(JSON.stringify(checkCalls(net)[0]?.json())).not.toContain("Body phrase");
  });

  test("the describe request asks for the body keys and nothing the owner typed", async () => {
    const net = network({ descriptors: [describeReply(SHOWN)] });
    const { engine, stagingId } = await startWithStagedPhoto(net);
    const worst = await estimateWorst(engine, stagingId);

    ok(await engine.handle(importCommand(stagingId, "Zoe", worst)));

    const body = JSON.stringify(describeCalls(net)[0]?.json());
    expect(body).toContain("bodyMarks");
    expect(body).not.toContain("Zoe");
  });
});
