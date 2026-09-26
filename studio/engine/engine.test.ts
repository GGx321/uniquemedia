import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, readdir, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventMessage, ResponseMessage, type AvatarTraits, type EngineNotice } from "../shared/engine";
import { manifestTraits } from "./avatars/records";
import type { EngineInit } from "./control";
import { deliver, Engine, engineErrorFrom, exitIfStartFails, resolveOpenRouterBaseUrl, type EngineDeps } from "./engine";
import { openLibrary, type Library } from "./library";
import { PNG_1X1, samplePhotoMeta, sequentialIds, steppingClock } from "./library/testing/helpers";
import type { ReserveHandle, ReserveResult } from "./money/budget";
import { Ledger, type LedgerLine } from "./money/ledger";
import { MoneyError } from "./money/errors";
import { fakeFetch, type Step } from "./openrouter/testing/fakes";
import type { OpenRouterFetch } from "./openrouter/types";
import { descriptorReply, GOOD as HARNESS_GOOD, network, NEW_AVATAR as HARNESS_NEW_AVATAR, OFFLINE, TRAITS as HARNESS_TRAITS } from "./testing/engineHarness";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const TEN_MIN_AGO = new Date(NOW - 10 * 60_000).toISOString();
const BOOT_ID = "boot-0000-aaaa";
const KEY = "sk-or-v1-0123456789abcdef-wxyz";
const CREDITS_URL = "https://openrouter.ai/api/v1/credits";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-engine-"));
  await mkdir(join(dir, "library"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function init(overrides: Partial<EngineInit> = {}): EngineInit {
  return {
    kind: "control",
    type: "init",
    ledgerPath: join(dir, "ledger.jsonl"),
    defaultLibraryPath: join(dir, "userData", "library"),
    rawDir: join(dir, "userData", "raw"),
    settings: {
      monthlyBudgetMicros: 10_000_000,
      libraryPath: join(dir, "library"),
      imageModel: "x-ai/grok-imagine-image-2.0",
      textModel: "x-ai/grok-4.3",
      concurrency: { network: 6 },
    },
    encryptionAvailable: true,
    notices: [],
    ...overrides,
  };
}

/** Engine tests never reach the network: a request that no test scripted fails the test. */
const NO_NETWORK: OpenRouterFetch = async (url) => {
  throw new Error(`unexpected network call to ${url}`);
};

async function startEngine(overrides: Partial<EngineInit> = {}, deps: Partial<EngineDeps> = {}) {
  const posted: unknown[] = [];
  let n = 0;
  let mono = 0;
  const engine = await Engine.start(init(overrides), {
    bootId: BOOT_ID,
    clock: () => NOW,
    monotonic: () => mono,
    newId: () => `id-${String(++n).padStart(8, "0")}`,
    post: (message) => posted.push(message),
    fetch: NO_NETWORK,
    ...deps,
  });
  return {
    engine,
    posted,
    /** Moves the monotonic clock: time the engine has had its ledger open. */
    advanceMono: (ms: number) => (mono += ms),
    /** The events posted so far, parsed with the contract. */
    events: () => posted.filter((m) => typeof m === "object" && m !== null && "kind" in m && m.kind === "event").map((m) => EventMessage.parse(m)),
  };
}

let commandSeq = 0;
function command(type: string, payload: unknown = {}): unknown {
  return { v: 1, id: `cmd-${String(++commandSeq).padStart(8, "0")}`, kind: "command", type, payload };
}

/** The response must satisfy the T0 contract as main will parse it. */
function ok(response: ResponseMessage): Extract<ResponseMessage, { ok: true }> {
  expect(ResponseMessage.safeParse(response).success).toBe(true);
  if (!response.ok) throw new Error(`expected ok, got ${response.error.code}: ${response.error.detail ?? ""}`);
  return response;
}

function handleOf(result: ReserveResult): ReserveHandle {
  if (!result.ok) throw new Error(`expected a reservation, got ${result.reason}`);
  return result.handle;
}

async function writeLedger(lines: LedgerLine[]): Promise<void> {
  const ledger = await Ledger.open(join(dir, "ledger.jsonl"));
  for (const line of lines) await ledger.append(line);
}

function reserveLine(attemptId: string, worstMicros: number, at = TEN_MIN_AGO): LedgerLine {
  return { type: "reserve", attemptId, jobId: "job-0001", scope: { avatarJobId: "job-0001" }, model: "x-ai/grok-imagine-image-2.0", worstMicros, at };
}

function settleLine(attemptId: string, costMicros: number, at = TEN_MIN_AGO): LedgerLine {
  return { type: "settle", attemptId, costMicros, estimated: false, at };
}

describe("Engine command dispatch", () => {
  test("engine.snapshot carries the bootId, settings, money status and no notices", async () => {
    const { engine } = await startEngine();
    const response = ok(await engine.handle(command("engine.snapshot")));
    if (response.type !== "engine.snapshot") throw new Error("wrong type");
    expect(response.result.bootId).toBe(BOOT_ID);
    expect(response.result.lastSeq).toBe(0);
    expect(response.result.settings.libraryPath).toBe(join(dir, "library"));
    expect(response.result.money).toEqual({
      ledger: "open",
      month: "2026-09",
      spentMicros: 0,
      monthlyBudgetMicros: 10_000_000,
      unsettledMicros: 0,
      unsettledCount: 0,
      reconcileNeeded: false,
      reconcileReasons: [],
      halt: null,
    });
    expect(response.result.avatars).toEqual([]);
    expect(response.result.notices).toEqual([]);
  });

  test("a garbage message gets a VALIDATION error response that keeps a readable id", async () => {
    const { engine } = await startEngine();
    const response = await engine.handle({ v: 1, id: "cmd-bad-0001", kind: "command", type: "engine.snapshot", payload: { x: 1 } });
    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({ ok: false, id: "cmd-bad-0001", error: { code: "VALIDATION" } });
    expect(await engine.handle("not an object")).toMatchObject({ ok: false, id: null, error: { code: "VALIDATION" } });
  });

  test("a main-only key command is refused, and the key in it is never echoed", async () => {
    const { engine } = await startEngine();
    const response = await engine.handle(command("settings.setApiKey", { key: KEY }));
    expect(response).toMatchObject({ ok: false, error: { code: "VALIDATION" } });
    expect(JSON.stringify(response)).not.toContain(KEY);
    const settings = ok(await engine.handle(command("settings.get")));
    if (settings.type !== "settings.get") throw new Error("wrong type");
    expect(settings.result.apiKey.stored).toBe(false);
  });

  test("commands without a handler yet answer INTERNAL 'not implemented'", async () => {
    const { engine } = await startEngine();
    // photos.list is a 2b placeholder.
    const response = await engine.handle(command("photos.list", { avatarId: "avatar-0001" }));
    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({
      ok: false,
      type: "photos.list",
      error: { code: "INTERNAL", detail: "photos.list is not implemented yet" },
    });
  });

  test("engine.events answers gap for another bootId and an empty list for this one", async () => {
    const { engine } = await startEngine();
    const other = ok(await engine.handle(command("engine.events", { afterSeq: 0, bootId: "earlier-boot-0001" })));
    expect(other).toMatchObject({ result: { gap: true } });
    const same = ok(await engine.handle(command("engine.events", { afterSeq: 0, bootId: BOOT_ID })));
    expect(same).toMatchObject({ result: { gap: false, events: [] } });
  });

  test("receive posts the response of a command through post", async () => {
    const { engine, posted } = await startEngine();
    await engine.receive(command("settings.get"));
    expect(posted).toHaveLength(1);
    expect(posted[0]).toMatchObject({ kind: "response", type: "settings.get", ok: true });
  });
});

describe("API key control messages", () => {
  test("apiKey.set makes settings report the last four chars and announces them with settings.changed, never the key", async () => {
    const { engine, posted, events } = await startEngine();
    await engine.receive({ kind: "control", type: "apiKey.set", key: KEY });
    expect(engine.apiKey).toBe(KEY);
    expect(events()).toMatchObject([{ type: "settings.changed", payload: { settings: { apiKey: { stored: true, last4: "wxyz", rejected: false } } } }]);
    expect(JSON.stringify(posted)).not.toContain(KEY);

    const response = ok(await engine.handle(command("settings.get")));
    if (response.type !== "settings.get") throw new Error("wrong type");
    expect(response.result.apiKey).toEqual({ stored: true, last4: "wxyz", encryptionAvailable: true, rejected: false });
    expect(JSON.stringify(response)).not.toContain(KEY);
  });

  test("apiKey.clear forgets the key and announces it with settings.changed", async () => {
    const { engine, events } = await startEngine();
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    engine.applyControl({ kind: "control", type: "apiKey.clear" });
    expect(engine.apiKey).toBeNull();
    expect(events().at(-1)).toMatchObject({ type: "settings.changed", payload: { settings: { apiKey: { stored: false, last4: null } } } });
    const response = ok(await engine.handle(command("settings.get")));
    if (response.type !== "settings.get") throw new Error("wrong type");
    expect(response.result.apiKey).toEqual({ stored: false, last4: null, encryptionAvailable: true, rejected: false });
  });

  test("an invalid control message changes nothing and posts nothing", async () => {
    const { engine, posted } = await startEngine();
    await engine.receive({ kind: "control", type: "apiKey.set", key: "short" });
    await engine.receive({ kind: "control", type: "settings.dump" });
    expect(engine.apiKey).toBeNull();
    expect(posted).toEqual([]);
  });

  test("encryptionAvailable from init is reported in the key status", async () => {
    const { engine } = await startEngine({ encryptionAvailable: false });
    const response = ok(await engine.handle(command("settings.get")));
    if (response.type !== "settings.get") throw new Error("wrong type");
    expect(response.result.apiKey.encryptionAvailable).toBe(false);
  });
});

describe("money status over the ledger", () => {
  test("counts this month's settles and flags reserves left open by an earlier process", async () => {
    await writeLedger([reserveLine("att-0001", 55_000), settleLine("att-0001", 50_000), reserveLine("att-0002", 55_000)]);

    const { engine } = await startEngine();
    const response = ok(await engine.handle(command("money.status")));
    expect(response).toMatchObject({
      type: "money.status",
      result: {
        ledger: "open",
        month: "2026-09",
        spentMicros: 50_000,
        unsettledMicros: 55_000,
        unsettledCount: 1,
        reconcileNeeded: true,
        reconcileReasons: ["open-reserves"],
        halt: null,
      },
    });
  });

  test("a torn last line needs a reconcile", async () => {
    await writeFile(join(dir, "ledger.jsonl"), '{"type":"reserve","attem');
    const { engine } = await startEngine();
    const response = ok(await engine.handle(command("money.status")));
    expect(response).toMatchObject({ result: { reconcileNeeded: true, reconcileReasons: ["torn-ledger-line"], halt: null } });
  });

  test("a settle above its worst case halts paid calls, and the status names the attempts", async () => {
    await writeLedger([reserveLine("att-0001", 50_000), settleLine("att-0001", 60_000)]);
    const { engine } = await startEngine();
    const response = ok(await engine.handle(command("money.status")));
    expect(response).toMatchObject({
      result: { ledger: "open", spentMicros: 60_000, reconcileNeeded: false, halt: { cause: "SETTLE_ABOVE_WORST", attemptIds: ["att-0001"] } },
    });
  });

  test("a corrupt ledger: status and snapshot say LEDGER_CORRUPT without amounts, and the engine keeps serving", async () => {
    await writeFile(join(dir, "ledger.jsonl"), "garbage line\n{}\n");
    const { engine, posted } = await startEngine();

    expect(posted).toEqual([]);
    const status = ok(await engine.handle(command("money.status")));
    expect(status).toMatchObject({
      result: { ledger: "unavailable", month: "2026-09", monthlyBudgetMicros: 10_000_000, reconcileNeeded: false, halt: { cause: "LEDGER_CORRUPT" } },
    });
    expect(status.result).not.toHaveProperty("spentMicros");
    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    expect(snapshot).toMatchObject({ result: { money: { ledger: "unavailable", halt: { cause: "LEDGER_CORRUPT" } } } });
    ok(await engine.handle(command("settings.get")));
  });

  test("a ledger file that cannot be read says LEDGER_UNREADABLE", async () => {
    await mkdir(join(dir, "ledger.jsonl"));
    const { engine } = await startEngine();
    const status = ok(await engine.handle(command("money.status")));
    expect(status).toMatchObject({ result: { ledger: "unavailable", halt: { cause: "LEDGER_UNREADABLE" } } });
  });

  test("a failed ledger write halts paid calls: the status says LEDGER_WRITE_FAILED", async () => {
    const { engine } = await startEngine({ ledgerPath: join(dir, "money", "ledger.jsonl") });
    await writeFile(join(dir, "money"), "a file where the ledger's folder should be");
    const budget = engine.budget;
    if (budget === null) throw new Error("expected a budget");
    expect(await budget.tryReserve({ attemptId: "att-0001", jobId: "job-0001", scope: { avatarJobId: "job-0001" }, model: "x-ai/grok-4.3", worstMicros: 0 }).catch((e: unknown) => e)).toBeInstanceOf(Error);

    const status = ok(await engine.handle(command("money.status")));
    expect(status).toMatchObject({ result: { ledger: "open", halt: { cause: "LEDGER_WRITE_FAILED" } } });
  });
});

describe("deliver (the utilityProcess entry hands every message through it)", () => {
  test("a message the engine fails on is logged without its content, and the failure goes no further", async () => {
    const lines: string[] = [];
    const failing = { receive: async () => Promise.reject(new Error(`could not handle ${KEY}`)) };

    await deliver(Promise.resolve(failing), { kind: "control", type: "apiKey.set", key: KEY }, (line) => lines.push(line));

    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("could not be handled");
    expect(lines.join("\n")).not.toContain(KEY);
  });

  test("a message for an engine that failed to start is dropped quietly: exitIfStartFails reports the failure once", async () => {
    const lines: string[] = [];
    const failed: Promise<{ receive: (message: unknown) => Promise<void> }> = Promise.reject(new Error("start failed"));

    await deliver(failed, { kind: "command" }, (line) => lines.push(line));

    expect(lines).toEqual([]);
  });

  test("an engine that fails to start ends the process with 1, logging the error's kind only, so main restarts it", async () => {
    const lines: string[] = [];
    const exits: number[] = [];

    exitIfStartFails(Promise.reject(new Error(`could not start with ${KEY}`)), (code) => exits.push(code), (line) => lines.push(line));
    await Bun.sleep(0);

    expect(exits).toEqual([1]);
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).not.toContain(KEY);
  });

  test("an engine that started never ends the process", async () => {
    const exits: number[] = [];
    const { engine } = await startEngine();
    exitIfStartFails(Promise.resolve(engine), (code) => exits.push(code), () => {});
    await Bun.sleep(0);
    expect(exits).toEqual([]);
  });

  test("a message the engine handles is not logged", async () => {
    const lines: string[] = [];
    const { engine } = await startEngine();
    await deliver(Promise.resolve(engine), command("settings.get"), (line) => lines.push(line));
    expect(lines).toEqual([]);
  });
});

describe("engineErrorFrom", () => {
  test("keeps fatal money codes, maps a torn ledger to RECONCILE_REQUIRED and anything else to INTERNAL", () => {
    expect(engineErrorFrom(new MoneyError("LEDGER_WRITE_FAILED", "x", { fatal: true })).code).toBe("LEDGER_WRITE_FAILED");
    expect(engineErrorFrom(new MoneyError("LEDGER_TORN", "x")).code).toBe("RECONCILE_REQUIRED");
    expect(engineErrorFrom(new MoneyError("ATTEMPT_CLOSED", "x")).code).toBe("INTERNAL");
    expect(engineErrorFrom("boom")).toEqual({ code: "INTERNAL", detail: "unexpected engine error" });
  });

  test("clips a long detail to the contract's 500 chars", () => {
    const error = engineErrorFrom(new Error("x".repeat(2000)));
    expect(error.detail?.length).toBe(500);
  });
});

describe("a key OpenRouter rejected (401)", () => {
  test("markKeyRejected marks the key rejected in settings and the snapshot and emits settings.changed once, not engine.error", async () => {
    const { engine, posted, events } = await startEngine();
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    const before = events().length;
    engine.markKeyRejected(KEY);
    engine.markKeyRejected(KEY);

    const emitted = events().slice(before);
    expect(emitted).toMatchObject([{ type: "settings.changed", payload: { settings: { apiKey: { stored: true, last4: "wxyz", rejected: true } } } }]);
    expect(events().some((e) => e.type === "engine.error")).toBe(false);
    expect(JSON.stringify(posted)).not.toContain(KEY);

    const settings = ok(await engine.handle(command("settings.get")));
    expect(settings).toMatchObject({ result: { apiKey: { stored: true, last4: "wxyz", rejected: true } } });
    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    expect(snapshot).toMatchObject({ result: { lastSeq: 2, settings: { apiKey: { rejected: true } } } });
  });

  test("a new key clears the rejection", async () => {
    const { engine } = await startEngine();
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    engine.markKeyRejected(KEY);
    engine.applyControl({ kind: "control", type: "apiKey.set", key: "sk-or-v1-rotated-key-9876" });
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: { apiKey: { last4: "9876", rejected: false } } });
  });

  test("a 401 for a key that was replaced meanwhile leaves the new key alone", async () => {
    const { engine, events } = await startEngine();
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    engine.applyControl({ kind: "control", type: "apiKey.set", key: "sk-or-v1-rotated-key-9876" });
    const before = events().length;

    engine.markKeyRejected(KEY);

    expect(events().length).toBe(before);
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: { apiKey: { last4: "9876", rejected: false } } });
  });

  test("without a key there is nothing to reject", async () => {
    const { engine, posted } = await startEngine();
    engine.markKeyRejected(KEY);
    expect(posted).toEqual([]);
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: { apiKey: { stored: false, rejected: false } } });
  });
});

describe("settings.update from main", () => {
  test("replaces the settings the engine reports and announces them with settings.changed", async () => {
    const { engine, events } = await startEngine();
    const next = { ...init().settings, textModel: "x-ai/grok-5", concurrency: { network: 3 } };
    await engine.receive({ kind: "control", type: "settings.update", settings: next });
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: next });
    expect(events()).toMatchObject([{ type: "settings.changed", payload: { settings: next } }]);
  });

  test("a new monthly budget applies to money.status", async () => {
    const { engine } = await startEngine();
    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, monthlyBudgetMicros: 25_000_000 } });
    expect(ok(await engine.handle(command("money.status")))).toMatchObject({ result: { monthlyBudgetMicros: 25_000_000 } });
  });

  test("a new monthly budget applies at once while a reserve is in flight, and that reserve stays the engine's own", async () => {
    const { engine } = await startEngine();
    const budget = engine.budget;
    if (budget === null) throw new Error("expected a budget");
    const handle = handleOf(
      await budget.tryReserve({ attemptId: "att-0001", jobId: "job-0001", scope: { avatarJobId: "job-0001" }, model: "x-ai/grok-4.3", worstMicros: 0 }),
    );

    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, monthlyBudgetMicros: 25_000_000 } });

    expect(ok(await engine.handle(command("money.status")))).toMatchObject({
      result: { monthlyBudgetMicros: 25_000_000, unsettledCount: 1, reconcileNeeded: false, halt: null },
    });
    await budget.settle(handle, { costMicros: 0, estimated: false });
    expect(ok(await engine.handle(command("money.status")))).toMatchObject({ result: { unsettledCount: 0, reconcileNeeded: false } });
  });

  test("an invalid update changes nothing and announces nothing", async () => {
    const { engine, posted } = await startEngine();
    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, monthlyBudgetMicros: -1 } });
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: { monthlyBudgetMicros: 10_000_000 } });
    expect(posted.filter((m) => typeof m === "object" && m !== null && "kind" in m && m.kind === "event")).toEqual([]);
  });

  test("a momentarily unreadable volume does not drop the live library when the same path is re-sent", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    let volumeDown = false;
    const folderFs = {
      stat: async (path: string) => {
        if (volumeDown && path === join(dir, "library")) throw Object.assign(new Error("EIO: i/o error, stat"), { code: "EIO" });
        return stat(path, { bigint: true });
      },
      realpath: (path: string) => realpath(path),
    };
    const { engine } = await startEngine({}, { folderFs });
    const live = engine.library;
    expect(live?.root).toBe(join(dir, "library"));

    volumeDown = true;
    // The same libraryPath re-sent (e.g. an unrelated settings.setBudget), while the volume cannot be stat'ed right now.
    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, monthlyBudgetMicros: 20_000_000 } });

    expect(engine.library).toBe(live);
    expect(await snapshotIds(engine)).toEqual({ avatars: [saved.avatarId], drafts: [saved.draftId] });
    expect(ok(await engine.handle(command("money.status")))).toMatchObject({ result: { monthlyBudgetMicros: 20_000_000 } });
  });
});

describe("OpenRouter base URL (invariant 13)", () => {
  const DEFAULT = "https://openrouter.ai/api/v1";

  test("a normal build ignores an override and uses OpenRouter", () => {
    expect(resolveOpenRouterBaseUrl(undefined, false)).toBe(DEFAULT);
    expect(resolveOpenRouterBaseUrl("http://127.0.0.1:9999/api/v1", false)).toBe(DEFAULT);
  });

  test("only an E2E build accepts the override", () => {
    expect(resolveOpenRouterBaseUrl("http://127.0.0.1:9999/api/v1", true)).toBe("http://127.0.0.1:9999/api/v1");
    expect(resolveOpenRouterBaseUrl(undefined, true)).toBe(DEFAULT);
  });

  test("the engine under test (not an E2E build) keeps OpenRouter even when init asks for another URL", async () => {
    const { engine } = await startEngine({ openRouterBaseUrl: "http://127.0.0.1:9999/api/v1" });
    expect(engine.openRouterBaseUrl).toBe(DEFAULT);
  });
});

describe("notices from main", () => {
  const RESET: EngineNotice = { noticeId: "notice-0001", code: "settings-reset", detail: "settings.json was corrupt; the defaults are in use", at: "2026-09-24T11:00:00.000Z", count: 1 };
  const RESTART: EngineNotice = { noticeId: "notice-0002", code: "engine-restarted", detail: "the engine exited unexpectedly (code 9)", at: "2026-09-24T11:59:00.000Z", count: 1 };

  test("notices from init are pending in the snapshot, oldest first", async () => {
    const { engine } = await startEngine({ notices: [RESET, RESTART] });
    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { notices: [RESET, RESTART] } });
  });

  test("each notice from init is emitted once as engine.notice in the engine's own stream, never as engine.error", async () => {
    const { events } = await startEngine({ notices: [RESET, RESTART] });
    expect(events()).toEqual([
      expect.objectContaining({ type: "engine.notice", seq: 1, bootId: BOOT_ID, payload: { notice: RESET } }),
      expect.objectContaining({ type: "engine.notice", seq: 2, bootId: BOOT_ID, payload: { notice: RESTART } }),
    ]);
  });

  test("a notice repeated in init is kept once", async () => {
    const { engine, events } = await startEngine({ notices: [RESET, RESET] });
    expect(events()).toHaveLength(1);
    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { notices: [RESET] } });
  });

  test("the old notice control message is not accepted", async () => {
    const { engine, posted } = await startEngine();
    await engine.receive({ kind: "control", type: "notice", error: { code: "INTERNAL", detail: "settings.json was reset" } });
    expect(posted).toEqual([]);
  });
});

// ---------- the library ----------

const TRAITS: AvatarTraits = {
  age: 25,
  ethnicity: "european",
  skinTone: "light-olive",
  hairColor: "chestnut",
  hairLength: "shoulder",
  hairTexture: "wavy",
  eyeColor: "hazel",
  build: "athletic",
  marks: ["freckles"],
  vibe: "coffee, travel, books",
};
const DESCRIPTOR = "25-year-old European woman, light olive skin, hazel eyes, shoulder-length wavy chestnut hair.";

/** A library at `path` with one saved avatar (and its master photo) and one draft with one candidate. */
async function seedLibrary(path: string, prefix: string): Promise<{ library: Library; avatarId: string; draftId: string; candidateId: string }> {
  await mkdir(path, { recursive: true });
  const { library } = await openLibrary(path, { now: steppingClock(), newId: sequentialIds(prefix) });
  const saved = await library.createAvatar({ name: "Mia", age: 25, traits: manifestTraits(TRAITS), descriptor: DESCRIPTOR });
  const master = await library.addPhoto(saved.id, PNG_1X1, samplePhotoMeta());
  await library.updateAvatar(saved.id, { status: "active", masterPhotoId: master.id });
  const draft = await library.createAvatar({ name: "Draft", age: 25, traits: manifestTraits(TRAITS), descriptor: DESCRIPTOR });
  const candidate = await library.addPhoto(draft.id, PNG_1X1, samplePhotoMeta());
  return { library, avatarId: saved.id, draftId: draft.id, candidateId: candidate.id };
}

async function snapshotIds(engine: Engine): Promise<{ avatars: string[]; drafts: string[] }> {
  const response = ok(await engine.handle(command("engine.snapshot")));
  if (response.type !== "engine.snapshot") throw new Error("wrong type");
  return { avatars: response.result.avatars.map((a) => a.avatarId), drafts: response.result.drafts.map((d) => d.avatarId) };
}

function libraryOpen(path: string, callId = "call-00000001") {
  return { kind: "control", type: "library.open", callId, path };
}

describe("the library the settings name", () => {
  test("is opened at start: the snapshot lists its saved avatars and its drafts with their candidates", async () => {
    const seeded = await seedLibrary(join(dir, "library"), "saved");
    const { engine } = await startEngine();

    const response = ok(await engine.handle(command("engine.snapshot")));
    if (response.type !== "engine.snapshot") throw new Error("wrong type");
    expect(response.result.avatars).toMatchObject([{ avatarId: seeded.avatarId, name: "Mia", status: "active", photoCount: 1 }]);
    expect(response.result.drafts).toEqual([
      {
        avatarId: seeded.draftId,
        traits: TRAITS,
        descriptor: { age: 25, text: DESCRIPTOR },
        candidates: [{ avatarId: seeded.draftId, photoId: seeded.candidateId }],
        estimate: null,
      },
    ]);
    expect(response.result.jobs).toEqual([]);
    expect(engine.library?.root).toBe(join(dir, "library"));
  });

  test("that cannot be opened at start leaves the engine without a library: it serves with empty lists", async () => {
    const { engine } = await startEngine({ settings: { ...init().settings, libraryPath: join(dir, "missing") } });
    expect(engine.library).toBeNull();
    expect(await snapshotIds(engine)).toEqual({ avatars: [], drafts: [] });
  });

  test("the default folder (userData/library) is created on first run and opened as the library", async () => {
    const path = join(dir, "userData", "library");
    const { engine } = await startEngine({ settings: { ...init().settings, libraryPath: path } });

    expect(engine.library?.root).toBe(path);
    expect(await readdir(path)).toContain("library.json");
  });

  test("a missing folder the user chose is never created: it may be a volume that is not mounted", async () => {
    const chosen = join(dir, "volume", "library");
    const { engine } = await startEngine({ settings: { ...init().settings, libraryPath: chosen } });

    expect(engine.library).toBeNull();
    expect(existsSync(join(dir, "volume"))).toBe(false);
    expect(existsSync(join(dir, "userData", "library"))).toBe(false);
  });

  test("avatars.list answers the saved avatars of the open library", async () => {
    const seeded = await seedLibrary(join(dir, "library"), "saved");
    const { engine } = await startEngine();
    const response = ok(await engine.handle(command("avatars.list")));
    expect(response).toMatchObject({ type: "avatars.list", result: { avatars: [{ avatarId: seeded.avatarId }], unreadableAvatars: [] } });
  });

  test("an avatar record whose traits do not fit the contract is counted in the snapshot and avatars.list, not silently dropped", async () => {
    const seeded = await seedLibrary(join(dir, "library"), "saved");
    const { library } = await openLibrary(join(dir, "library"), { newId: sequentialIds("early") });
    const early = await library.createAvatar({ name: "Early", age: 25, traits: { hair: "chestnut" }, descriptor: DESCRIPTOR });
    const { engine } = await startEngine();

    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({
      result: {
        avatars: [{ avatarId: seeded.avatarId }],
        drafts: [{ avatarId: seeded.draftId }],
        unreadableAvatars: [{ avatarId: early.id, reason: "contract-mismatch" }],
        unreadableTotal: 1,
      },
    });
    expect(ok(await engine.handle(command("avatars.list")))).toMatchObject({
      result: { unreadableAvatars: [{ avatarId: early.id, reason: "contract-mismatch" }], unreadableTotal: 1 },
    });
  });

  test("unreadableTotal (L1) counts every unreadable avatar, manifest-unreadable and skipped alike", async () => {
    const seeded = await seedLibrary(join(dir, "library"), "saved");
    const { library } = await openLibrary(join(dir, "library"), { newId: sequentialIds("early") });
    await library.createAvatar({ name: "Early", age: 25, traits: { hair: "chestnut" }, descriptor: DESCRIPTOR });
    await mkdir(join(dir, "library", "avatars", "broken0000000a"), { recursive: true });
    await writeFile(join(dir, "library", "avatars", "broken0000000a", "avatar.json"), "not json");
    const { engine } = await startEngine();

    const list = ok(await engine.handle(command("avatars.list")));
    expect(list).toMatchObject({ result: { unreadableTotal: 2 } });
    if (list.type !== "avatars.list") throw new Error("wrong type");
    expect(list.result.unreadableTotal).toBe(list.result.unreadableAvatars.length);
    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { unreadableTotal: 2, avatars: [{ avatarId: seeded.avatarId }] } });
  });

  test("a saved avatar whose stored descriptor no longer fits today's rules is listed as unreadable with reason descriptor-invalid, never echoing the descriptor", async () => {
    const { library } = await openLibrary(join(dir, "library"), { newId: sequentialIds("bad") });
    const bad = await library.createAvatar({ name: "Bad", age: 25, traits: manifestTraits(TRAITS), descriptor: "a young woman with hazel eyes" });
    const photo = await library.addPhoto(bad.id, PNG_1X1, samplePhotoMeta());
    await library.updateAvatar(bad.id, { status: "active", masterPhotoId: photo.id });
    const { engine } = await startEngine();

    const response = ok(await engine.handle(command("avatars.list")));
    expect(response).toMatchObject({ result: { avatars: [], unreadableAvatars: [{ avatarId: bad.id, reason: "descriptor-invalid" }] } });
    expect(JSON.stringify(response)).not.toContain("young woman");
  });

  test("an avatar manifest that cannot be parsed is listed as unreadable with reason manifest-unreadable and its folder's id", async () => {
    const seeded = await seedLibrary(join(dir, "library"), "saved");
    await mkdir(join(dir, "library", "avatars", "broken0000000a"), { recursive: true });
    await writeFile(join(dir, "library", "avatars", "broken0000000a", "avatar.json"), "not json");
    const { engine } = await startEngine();

    const response = ok(await engine.handle(command("avatars.list")));
    expect(response).toMatchObject({
      result: {
        avatars: [{ avatarId: seeded.avatarId }],
        unreadableAvatars: [{ avatarId: "broken0000000a", reason: "manifest-unreadable" }],
      },
    });
    expect(JSON.stringify(response)).not.toContain("not json");
  });

  test("avatars.list without a library answers an empty list", async () => {
    const { engine } = await startEngine({ settings: { ...init().settings, libraryPath: join(dir, "missing") } });
    expect(ok(await engine.handle(command("avatars.list")))).toMatchObject({ result: { avatars: [], unreadableAvatars: [] } });
  });
});

describe("library.open from main", () => {
  test("an empty folder becomes the library and the engine replies ok", async () => {
    const { engine, posted } = await startEngine();
    const folder = join(dir, "new-library");
    await mkdir(folder);
    await engine.receive(libraryOpen(folder));
    expect(posted).toEqual([{ kind: "control", type: "reply", callId: "call-00000001" }]);
    expect(await readdir(folder)).toContain("library.json");
  });

  test("a folder that cannot hold a library gets a VALIDATION reply and nothing is created", async () => {
    const { engine, posted } = await startEngine();
    const folder = join(dir, "photos-of-something-else");
    await mkdir(folder);
    await writeFile(join(folder, "holiday.jpg"), "x");
    await engine.receive(libraryOpen(folder, "call-00000002"));
    expect(posted).toMatchObject([{ kind: "control", type: "reply", callId: "call-00000002", error: { code: "VALIDATION" } }]);
    expect(await readdir(folder)).toEqual(["holiday.jpg"]);
  });

  test("a missing folder gets an error reply", async () => {
    const { engine, posted } = await startEngine();
    await engine.receive(libraryOpen(join(dir, "nope")));
    expect(posted).toMatchObject([{ kind: "control", type: "reply", callId: "call-00000001", error: {} }]);
  });

  test("a malformed call is ignored", async () => {
    const { engine, posted } = await startEngine();
    await engine.receive({ kind: "control", type: "library.open", callId: "x", path: "relative" });
    expect(posted).toEqual([]);
  });

  test("picking the folder of the open library again does not reopen it, so its in-progress writes are never quarantined", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    const { engine, posted } = await startEngine();
    // An image whose sidecar is still being written by the library in use.
    const inProgress = join(dir, "library", "avatars", saved.avatarId, "photos", "writing-0001.png");
    await writeFile(inProgress, PNG_1X1);

    await engine.receive(libraryOpen(join(dir, "library")));

    expect(posted).toEqual([{ kind: "control", type: "reply", callId: "call-00000001" }]);
    expect(await readdir(join(dir, "library", "avatars", saved.avatarId, "photos"))).toContain("writing-0001.png");
  });

  test("the same folder spelled with a trailing slash is the open library: it is not reopened and stays the same library", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    const { engine, posted } = await startEngine();
    const live = engine.library;
    const inProgress = join(dir, "library", "avatars", saved.avatarId, "photos", "writing-0001.png");
    await writeFile(inProgress, PNG_1X1);

    await engine.receive(libraryOpen(`${join(dir, "library")}/`));
    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, libraryPath: `${join(dir, "library")}/` } });

    expect(posted.at(-2)).toEqual({ kind: "control", type: "reply", callId: "call-00000001" });
    expect(engine.library).toBe(live);
    expect(await readdir(join(dir, "library", "avatars", saved.avatarId, "photos"))).toContain("writing-0001.png");
  });

  test("the open library reached through a symlink is not reopened", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    await symlink(join(dir, "library"), join(dir, "link"));
    const { engine } = await startEngine();
    const live = engine.library;
    await writeFile(join(dir, "library", "avatars", saved.avatarId, "photos", "writing-0001.png"), PNG_1X1);

    await engine.receive(libraryOpen(join(dir, "link")));
    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, libraryPath: join(dir, "link") } });

    expect(engine.library).toBe(live);
    expect(await readdir(join(dir, "library", "avatars", saved.avatarId, "photos"))).toContain("writing-0001.png");
  });

  test("on a volume without file ids another folder is never taken for the open library", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    const holiday = join(dir, "holiday-photos");
    await mkdir(holiday);
    await writeFile(join(holiday, "beach.jpg"), "x");
    // Every folder there stats as dev 0, ino 0 (some SMB/WebDAV redirectors, FUSE).
    const folderFs = {
      stat: async (path: string) => {
        const info = await stat(path, { bigint: true });
        return { isDirectory: () => info.isDirectory(), dev: 0n, ino: 0n };
      },
      realpath: (path: string) => realpath(path),
    };
    const { engine, posted } = await startEngine({}, { folderFs });
    expect(await snapshotIds(engine)).toEqual({ avatars: [saved.avatarId], drafts: [saved.draftId] });

    await engine.receive(libraryOpen(holiday));
    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "VALIDATION" } });
    expect(await readdir(holiday)).toEqual(["beach.jpg"]);

    // Even if main saved that folder anyway, the engine does not stay on the old library.
    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, libraryPath: holiday } });
    expect(engine.library).toBeNull();
  });

  test("on a volume whose driver cannot give a canonical path the library opens at start, and picking it again is the same folder", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    const folderFs = {
      stat: async (path: string) => stat(path, { bigint: true }),
      realpath: async (): Promise<string> => Promise.reject(Object.assign(new Error("EISDIR: illegal operation on a directory, realpath"), { code: "EISDIR" })),
    };
    const { engine, posted } = await startEngine({}, { folderFs });
    const live = engine.library;
    expect(live?.root).toBe(join(dir, "library"));
    await writeFile(join(dir, "library", "avatars", saved.avatarId, "photos", "writing-0001.png"), PNG_1X1);

    await engine.receive(libraryOpen(join(dir, "library")));
    await engine.receive({ kind: "control", type: "settings.update", settings: init().settings });

    expect(posted.at(-2)).toEqual({ kind: "control", type: "reply", callId: "call-00000001" });
    expect(engine.library).toBe(live);
    expect(await readdir(join(dir, "library", "avatars", saved.avatarId, "photos"))).toContain("writing-0001.png");
  });

  test("a folder the engine cannot identify is refused before it is touched: no survey that is then thrown away", async () => {
    const other = join(dir, "other");
    await mkdir(other);
    const folderFs = {
      stat: async (path: string) =>
        path === other ? Promise.reject(Object.assign(new Error("EACCES: permission denied, stat"), { code: "EACCES" })) : stat(path, { bigint: true }),
      realpath: (path: string) => realpath(path),
    };
    const { engine, posted } = await startEngine({}, { folderFs });

    await engine.receive(libraryOpen(other));

    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: {} });
    expect(await readdir(other)).toEqual([]);
  });

  test("two opens of one folder at once (main gave up, the user picked it again) share one open", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    const other = await seedLibrary(join(dir, "other"), "other");
    // Left by a crash: an image without its sidecar, which the open moves to quarantine.
    await writeFile(join(dir, "other", "avatars", other.avatarId, "photos", "orphan-0001.png"), PNG_1X1);
    const { engine, posted } = await startEngine();

    await Promise.all([engine.receive(libraryOpen(join(dir, "other"), "call-00000001")), engine.receive(libraryOpen(join(dir, "other"), "call-00000002"))]);

    expect(posted).toContainEqual({ kind: "control", type: "reply", callId: "call-00000001" });
    expect(posted).toContainEqual({ kind: "control", type: "reply", callId: "call-00000002" });
    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, libraryPath: join(dir, "other") } });
    expect(await snapshotIds(engine)).toEqual({ avatars: [other.avatarId], drafts: [other.draftId] });
  });

  test("a library switch is refused with IN_FLIGHT while a paid request is in flight", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    const { engine, posted } = await startEngine();
    const budget = engine.budget;
    if (budget === null) throw new Error("expected a budget");
    await budget.tryReserve({ attemptId: "att-0001", jobId: "job-0001", scope: { avatarJobId: "job-0001" }, model: "x-ai/grok-4.3", worstMicros: 0 });

    await engine.receive(libraryOpen(join(dir, "other")));

    expect(posted).toMatchObject([{ kind: "control", type: "reply", callId: "call-00000001", error: { code: "IN_FLIGHT" } }]);
    expect(engine.library?.root).toBe(join(dir, "library"));
  });

  test("the engine started without its folder takes it once the user picks the same folder again", async () => {
    await rm(join(dir, "library"), { recursive: true });
    const { engine, posted } = await startEngine();
    expect(engine.library).toBeNull();
    await mkdir(join(dir, "library"));

    await engine.receive(libraryOpen(join(dir, "library")));
    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000001" });
    // Main saves the path, which it already had, and confirms it.
    await engine.receive({ kind: "control", type: "settings.update", settings: init().settings });

    expect(engine.library?.root).toBe(join(dir, "library"));
  });

  test("an opened folder is only staged: the engine stays on the saved library until main confirms the new one", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    const { engine } = await startEngine();

    await engine.receive(libraryOpen(join(dir, "other")));

    expect(engine.library?.root).toBe(join(dir, "library"));
    expect(await snapshotIds(engine)).toEqual({ avatars: [saved.avatarId], drafts: [saved.draftId] });
  });

  test("the settings update that confirms the folder switches the engine to it", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    const other = await seedLibrary(join(dir, "other"), "other");
    const { engine } = await startEngine();
    await engine.receive(libraryOpen(join(dir, "other")));

    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, libraryPath: join(dir, "other") } });

    expect(engine.library?.root).toBe(join(dir, "other"));
    expect(await snapshotIds(engine)).toEqual({ avatars: [other.avatarId], drafts: [other.draftId] });
  });

  test("a folder main gave up on (its 30 s deadline passed, so it saved nothing) is never taken, whatever settings update follows", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    const { engine } = await startEngine();

    // Main's call timed out: it did not persist the folder, so its next update still names the saved library.
    await engine.receive(libraryOpen(join(dir, "other")));
    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, monthlyBudgetMicros: 20_000_000 } });

    expect(engine.library?.root).toBe(join(dir, "library"));
    expect(await snapshotIds(engine)).toEqual({ avatars: [saved.avatarId], drafts: [saved.draftId] });
  });

  test("a confirmed folder the engine has not staged is opened and taken: the saved settings decide", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    const other = await seedLibrary(join(dir, "other"), "other");
    const { engine } = await startEngine();

    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, libraryPath: join(dir, "other") } });

    expect(engine.library?.root).toBe(join(dir, "other"));
    expect(await snapshotIds(engine)).toEqual({ avatars: [other.avatarId], drafts: [other.draftId] });
  });

  test("a confirmed folder that cannot be opened leaves the engine without a library rather than on the old one", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    const { engine } = await startEngine();

    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, libraryPath: join(dir, "missing") } });

    expect(engine.library).toBeNull();
    expect(await snapshotIds(engine)).toEqual({ avatars: [], drafts: [] });
  });
});

describe("library.confirm from main", () => {
  function libraryConfirm(path: string, callId = "call-00000001") {
    return { kind: "control", type: "library.confirm", callId, path };
  }

  test("confirms a previously staged folder: the engine switches, and settings.changed carries the new path", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    const other = await seedLibrary(join(dir, "other"), "other");
    const { engine, posted, events } = await startEngine();
    await engine.receive(libraryOpen(join(dir, "other")));

    await engine.receive(libraryConfirm(join(dir, "other"), "call-00000002"));

    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000002" });
    expect(engine.library?.root).toBe(join(dir, "other"));
    expect(await snapshotIds(engine)).toEqual({ avatars: [other.avatarId], drafts: [other.draftId] });
    expect(events().at(-1)).toMatchObject({ type: "settings.changed", payload: { settings: { libraryPath: join(dir, "other") } } });
  });

  test("propagates a quarantined manifest's unreadable entry from the staged survey into the confirmed, live library (L11)", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    await mkdir(join(dir, "other", "avatars", "broken0000000a"), { recursive: true });
    await writeFile(join(dir, "other", "avatars", "broken0000000a", "avatar.json"), "not json");
    const { engine } = await startEngine();
    await engine.receive(libraryOpen(join(dir, "other")));

    await engine.receive(libraryConfirm(join(dir, "other"), "call-00000002"));

    const list = ok(await engine.handle(command("avatars.list")));
    expect(list).toMatchObject({ result: { unreadableAvatars: [{ avatarId: "broken0000000a", reason: "manifest-unreadable" }] } });
  });

  // A folder nothing staged used to be opened fresh here, which is exactly
  // the TOCTOU the fix closes (a survey after the busy check, with no
  // re-check once it resolves). Refused with VALIDATION instead, never
  // surveyed at all; main must send library.open again (control.ts's comment).
  test("a folder never staged is refused with VALIDATION; the live library is untouched", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    const { engine, posted } = await startEngine();

    await engine.receive(libraryConfirm(join(dir, "other")));

    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "VALIDATION", detail: "the folder is not staged; open it again" } });
    expect(engine.library?.root).toBe(join(dir, "library"));
    expect(await snapshotIds(engine)).toEqual({ avatars: [saved.avatarId], drafts: [saved.draftId] });
  });

  test("a path that was never even a real folder is refused the same way, VALIDATION, never surveyed", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    const { engine, posted } = await startEngine();

    await engine.receive(libraryConfirm(join(dir, "missing")));

    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "VALIDATION" } });
    expect(engine.library?.root).toBe(join(dir, "library"));
  });

  test("confirming the already-live folder is a harmless no-op", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    const { engine, posted } = await startEngine();
    const live = engine.library;

    await engine.receive(libraryConfirm(join(dir, "library")));

    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000001" });
    expect(engine.library).toBe(live);
    expect(await snapshotIds(engine)).toEqual({ avatars: [saved.avatarId], drafts: [saved.draftId] });
  });

  test("the live folder opened under another spelling (a symlink alias) stages that spelling too: it can be confirmed, and confirmed again on a later retry", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    await symlink(join(dir, "library"), join(dir, "alias"));
    const { engine, posted } = await startEngine();
    const live = engine.library;

    await engine.receive(libraryOpen(join(dir, "alias"), "call-00000001"));
    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000001" });
    await engine.receive(libraryConfirm(join(dir, "alias"), "call-00000002"));

    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000002" });
    expect(engine.library).toBe(live); // the same instance, adopted as-is, never re-surveyed
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: { libraryPath: join(dir, "alias") } });
    // No generation bump: the folder's identity did not change, only its spelling.
    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { librarySwitchGeneration: 0 } });

    // Retrying the exact same open+confirm sequence (the user reopens Settings and re-picks it) still works, not VALIDATION forever.
    await engine.receive(libraryOpen(join(dir, "alias"), "call-00000003"));
    await engine.receive(libraryConfirm(join(dir, "alias"), "call-00000004"));
    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000004" });
  });

  test("a stale staged entry left by an earlier IN_FLIGHT refusal is dropped, not adopted later, when the live folder is re-opened under its own spelling", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    await symlink(join(dir, "other"), join(dir, "other-alias"));
    const { engine, posted } = await startEngine();
    const budget = engine.budget;
    if (budget === null) throw new Error("expected a budget");

    // Staged, then the confirm is refused IN_FLIGHT: the stale entry it leaves must not resurface later.
    await engine.receive(libraryOpen(join(dir, "other"), "call-00000001"));
    const h = await budget.tryReserve({ attemptId: "att-0001", jobId: "job-0001", scope: { avatarJobId: "job-0001" }, model: "x-ai/grok-4.3", worstMicros: 0 });
    await engine.receive(libraryConfirm(join(dir, "other"), "call-00000002"));
    expect(posted.at(-1)).toMatchObject({ error: { code: "IN_FLIGHT" } });
    if (!h.ok) throw new Error("expected a reservation");
    await budget.settle(h.handle, { costMicros: 0, estimated: false });

    // The switch actually happens via another spelling of the same folder.
    await engine.receive(libraryOpen(join(dir, "other-alias"), "call-00000003"));
    await engine.receive(libraryConfirm(join(dir, "other-alias"), "call-00000004"));
    const live = engine.library;
    expect(live?.root).toBe(join(dir, "other-alias"));

    // Later, re-opening the live folder under its original spelling ("other") is a no-op that stages the CURRENT instance under that string (round-2 fix), so the stale one from call-00000001 can never be adopted.
    await engine.receive(libraryOpen(join(dir, "other"), "call-00000005"));
    await engine.receive(libraryConfirm(join(dir, "other"), "call-00000006"));

    expect(posted.at(-1)).toEqual({ kind: "control", type: "reply", callId: "call-00000006" });
    expect(engine.library).toBe(live); // the same instance throughout, never swapped for a stale one
    expect(engine.library?.root).toBe(join(dir, "other-alias")); // unchanged: adopted as-is, no re-open
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: { libraryPath: join(dir, "other") } }); // only the reported spelling moved
    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { librarySwitchGeneration: 1 } }); // bumped once, not again for a same-identity spelling change
  });

  test("a malformed confirm call is ignored", async () => {
    const { engine, posted } = await startEngine();
    await engine.receive({ kind: "control", type: "library.confirm", callId: "x", path: "relative" });
    expect(posted).toEqual([]);
  });

  test("refused with IN_FLIGHT while a paid request is in flight; the live library stays", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    const { engine, posted } = await startEngine();
    // Staged first, while nothing is busy yet: confirm's own check has no
    // await left to race, so what matters is that "other" was staged.
    await engine.receive(libraryOpen(join(dir, "other")));
    const budget = engine.budget;
    if (budget === null) throw new Error("expected a budget");
    await budget.tryReserve({ attemptId: "att-0001", jobId: "job-0001", scope: { avatarJobId: "job-0001" }, model: "x-ai/grok-4.3", worstMicros: 0 });

    await engine.receive(libraryConfirm(join(dir, "other"), "call-00000002"));

    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000002", error: { code: "IN_FLIGHT" } });
    expect(engine.library?.root).toBe(join(dir, "library"));
    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { settings: { libraryPath: join(dir, "library") } } });
  });

  test("refused with IN_FLIGHT while a pick is in flight; the live library and its avatars stay", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    const { engine, posted } = await startEngine();
    // Staged first, while nothing is busy yet.
    await engine.receive(libraryOpen(join(dir, "other")));
    const pickable = await engine.library?.addPhoto(saved.draftId, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
    if (pickable === undefined) throw new Error("expected the engine's library to be open");

    // #claimAvatar marks the pick busy synchronously, before its own first
    // await: by the time this call returns control, confirm (which has no
    // await of its own left once staged) deterministically sees it in flight.
    const picking = engine.handle(command("avatars.pick", { avatarId: saved.draftId, photoId: pickable.id, name: "Zoe" }));
    await engine.receive(libraryConfirm(join(dir, "other"), "call-00000002"));

    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000002", error: { code: "IN_FLIGHT" } });
    expect(engine.library?.root).toBe(join(dir, "library"));
    ok(await picking);
  });

  test("refused with IN_FLIGHT while an archive is in flight", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    const { engine, posted } = await startEngine();
    await engine.receive(libraryOpen(join(dir, "other")));

    const archiving = engine.handle(command("avatars.archive", { avatarId: saved.avatarId }));
    await engine.receive(libraryConfirm(join(dir, "other"), "call-00000002"));

    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000002", error: { code: "IN_FLIGHT" } });
    expect(engine.library?.root).toBe(join(dir, "library"));
    ok(await archiving);
  });

  test("library.open itself is also refused with IN_FLIGHT while a pick is in flight", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    const otherInfo = await stat(join(dir, "other"), { bigint: true });
    const otherReal = await realpath(join(dir, "other"));
    const folderFs = {
      stat: async (path: string) => (path === join(dir, "other") ? otherInfo : stat(path, { bigint: true })),
      realpath: async (path: string) => (path === join(dir, "other") ? otherReal : realpath(path)),
    };
    const { engine, posted } = await startEngine({}, { folderFs });
    const pickable = await engine.library?.addPhoto(saved.draftId, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
    if (pickable === undefined) throw new Error("expected the engine's library to be open");

    const picking = engine.handle(command("avatars.pick", { avatarId: saved.draftId, photoId: pickable.id, name: "Zoe" }));
    await engine.receive(libraryOpen(join(dir, "other")));

    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000001", error: { code: "IN_FLIGHT" } });
    ok(await picking);
  });
});

describe("the library-switch generation", () => {
  test("starts at 0 and is carried in the snapshot", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    const { engine } = await startEngine();
    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { librarySwitchGeneration: 0 } });
  });

  test("a confirmed switch to another folder bumps it and settings.changed carries the new value", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    const { engine, events } = await startEngine();
    await engine.receive(libraryOpen(join(dir, "other")));

    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, libraryPath: join(dir, "other") } });

    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { librarySwitchGeneration: 1 } });
    expect(events().at(-1)).toMatchObject({ type: "settings.changed", payload: { librarySwitchGeneration: 1 } });
  });

  test("a switch to a folder that cannot be opened (LIBRARY_UNAVAILABLE) bumps it too: the windows must still resync to see the library is gone", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    const { engine } = await startEngine();

    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, libraryPath: join(dir, "missing") } });

    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { librarySwitchGeneration: 1 } });
  });

  test("a settings update that keeps the same folder (e.g. only the budget changed) does not bump it", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    const { engine } = await startEngine();

    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, monthlyBudgetMicros: 20_000_000 } });

    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { librarySwitchGeneration: 0 } });
  });

  test("with no library at all, a budget-only update leaves the generation unchanged", async () => {
    await rm(join(dir, "library"), { recursive: true });
    const { engine } = await startEngine();
    expect(engine.library).toBeNull();

    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, monthlyBudgetMicros: 20_000_000 } });

    expect(engine.library).toBeNull();
    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { librarySwitchGeneration: 0, money: { monthlyBudgetMicros: 20_000_000 } } });
  });

  test("a folder that is only staged (not yet confirmed) does not bump it", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    const { engine } = await startEngine();

    await engine.receive(libraryOpen(join(dir, "other")));

    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { librarySwitchGeneration: 0 } });
  });

  test("a momentarily unreadable volume that keeps the live library does not bump it either", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    let volumeDown = false;
    const folderFs = {
      stat: async (path: string) => {
        if (volumeDown && path === join(dir, "library")) throw Object.assign(new Error("EIO: i/o error, stat"), { code: "EIO" });
        return stat(path, { bigint: true });
      },
      realpath: (path: string) => realpath(path),
    };
    const { engine } = await startEngine({}, { folderFs });
    volumeDown = true;

    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, monthlyBudgetMicros: 20_000_000 } });

    expect(ok(await engine.handle(command("engine.snapshot")))).toMatchObject({ result: { librarySwitchGeneration: 0 } });
  });
});

describe("a confirm for an unstaged folder never surveys it or races paid work", () => {
  test("a confirm for a folder nothing staged never surveys it and never races a paid command: it refuses synchronously, and the draft stays in the live library", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    const other = join(dir, "other");
    let otherStats = 0;
    const folderFs = {
      stat: async (path: string) => {
        if (path === other) otherStats++;
        return stat(path, { bigint: true });
      },
      realpath: (path: string) => realpath(path),
    };
    let releasePrices: () => void = () => {};
    const pricesHeld = new Promise<void>((r) => (releasePrices = r));
    const net = network({ prices: async () => (await pricesHeld, OFFLINE), descriptors: [descriptorReply(HARNESS_GOOD)] });
    const { engine, posted } = await startEngine({}, { folderFs, fetch: net.fetch });
    await engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    const oldLibrary = engine.library;
    if (oldLibrary === null) throw new Error("expected a library");

    // Nothing staged (e.g. an intervening settings.update or an engine restart dropped it).
    // No sleep needed: #paidCommands++ (engine.ts's avatars.createDraft case)
    // runs synchronously, before createDraft's first await, so it is already
    // set by the time this call returns control.
    const creating = engine.handle(command("avatars.createDraft", { traits: HARNESS_TRAITS, acceptedWorstMicros: HARNESS_NEW_AVATAR.worstMicros }));
    await engine.receive({ kind: "control", type: "library.confirm", callId: "call-00000009", path: other });

    // Refused for the exact path string, without ever surveying "other": no TOCTOU window opened at all.
    expect(posted.find((m) => typeof m === "object" && m !== null && "callId" in m && m.callId === "call-00000009")).toMatchObject({
      kind: "control",
      type: "reply",
      callId: "call-00000009",
      error: { code: "VALIDATION" },
    });
    expect(otherStats).toBe(0);
    expect(engine.library).toBe(oldLibrary);

    releasePrices();
    const created = ok(await creating);
    if (created.type !== "avatars.createDraft") throw new Error("wrong type");
    const draftId = created.result.draft.avatarId;
    // The paid draft landed in the one library that was ever live.
    expect(oldLibrary.getAvatar(draftId)).toBeDefined();
    expect(engine.library?.getAvatar(draftId)).toBeDefined();
    expect((await snapshotIds(engine)).drafts).toContain(draftId);
  });
});

describe("#applySettings' own busy recheck, field ordering and races between two updates", () => {
  test("settings.get and the snapshot never report the new libraryPath before the switch actually lands", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    let reached: () => void = () => {};
    const atGate = new Promise<void>((r) => (reached = r));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const folderFs = {
      stat: async (path: string) => {
        if (path === join(dir, "other")) {
          reached();
          await gate;
        }
        return stat(path, { bigint: true });
      },
      realpath: (path: string) => realpath(path),
    };
    const { engine } = await startEngine({}, { folderFs });

    const updating = engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, libraryPath: join(dir, "other") } });
    await atGate; // inside folderIdentity's stat for "other", well before #live could switch

    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: { libraryPath: join(dir, "library") } });
    expect(engine.library?.root).toBe(join(dir, "library"));

    release();
    await updating;

    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: { libraryPath: join(dir, "other") } });
    expect(engine.library?.root).toBe(join(dir, "other"));
  });

  test("paid work that starts while settings.update surveys the new folder makes the switch refused with IN_FLIGHT, rolled back", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    let reached: () => void = () => {};
    const atGate = new Promise<void>((r) => (reached = r));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const folderFs = {
      stat: async (path: string) => {
        if (path === join(dir, "other")) {
          reached();
          await gate;
        }
        return stat(path, { bigint: true });
      },
      realpath: (path: string) => realpath(path),
    };
    const { engine, posted } = await startEngine({}, { folderFs });
    const budget = engine.budget;
    if (budget === null) throw new Error("expected a budget");

    const updating = engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, libraryPath: join(dir, "other") } });
    await atGate;
    // Paid work starts in the window after #applySettings' folderIdentity await, before its busy recheck runs.
    await budget.tryReserve({ attemptId: "att-0001", jobId: "job-0001", scope: { avatarJobId: "job-0001" }, model: "x-ai/grok-4.3", worstMicros: 0 });
    release();
    await updating;

    expect(engine.library?.root).toBe(join(dir, "library"));
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: { libraryPath: join(dir, "library") } });
    // The engine is still visibly busy: a further switch attempt also sees it.
    await engine.receive(libraryOpen(join(dir, "other"), "call-00000099"));
    expect(posted.at(-1)).toMatchObject({ kind: "control", type: "reply", callId: "call-00000099", error: { code: "IN_FLIGHT" } });
  });

  test("settings.update with a different libraryPath while already busy still applies the non-library fields, refuses the switch, and settings.changed carries the engine's actual path", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    const { engine, events } = await startEngine();
    const budget = engine.budget;
    if (budget === null) throw new Error("expected a budget");
    await budget.tryReserve({ attemptId: "att-0001", jobId: "job-0001", scope: { avatarJobId: "job-0001" }, model: "x-ai/grok-4.3", worstMicros: 0 });

    await engine.receive({
      kind: "control",
      type: "settings.update",
      settings: { ...init().settings, libraryPath: join(dir, "other"), monthlyBudgetMicros: 20_000_000 },
    });

    expect(engine.library?.root).toBe(join(dir, "library"));
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({
      result: { libraryPath: join(dir, "library"), monthlyBudgetMicros: 20_000_000 },
    });
    expect(events().at(-1)).toMatchObject({
      type: "settings.changed",
      payload: { settings: { libraryPath: join(dir, "library"), monthlyBudgetMicros: 20_000_000 } },
    });
  });

  // library.confirm never calls #applySettings at all (it is fully
  // synchronous, staged-only), so the "switch not applied because a later
  // call raced in" case is impossible to reach through it. It remains
  // reachable only through two overlapping settings.update control messages
  // (main's own channel, which has no reply to carry an error on): the later
  // one must win outright, never leaving a half-applied mix behind.
  test("a later settings.update racing in during an earlier one's survey wins outright; the earlier one is superseded, not half-applied", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    let reached: () => void = () => {};
    const atGate = new Promise<void>((r) => (reached = r));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const folderFs = {
      stat: async (path: string) => {
        if (path === join(dir, "other")) {
          reached();
          await gate;
        }
        return stat(path, { bigint: true });
      },
      realpath: (path: string) => realpath(path),
    };
    const { engine } = await startEngine({}, { folderFs });

    const first = engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, libraryPath: join(dir, "other") } });
    await atGate; // the first update is paused inside folderIdentity(other)
    // A second, later update arrives and completes fully before the first resumes.
    await engine.receive({
      kind: "control",
      type: "settings.update",
      settings: { ...init().settings, libraryPath: join(dir, "library"), monthlyBudgetMicros: 30_000_000 },
    });
    release();
    await first;

    // The second (later) update's intent wins outright; the first's stale
    // switch to "other" never lands on top of it, half-applied or otherwise.
    expect(engine.library?.root).toBe(join(dir, "library"));
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({
      result: { libraryPath: join(dir, "library"), monthlyBudgetMicros: 30_000_000 },
    });
  });

  test("a library.confirm landing while an unrelated settings.update is still surveying is not rolled back once that update resumes", async () => {
    await seedLibrary(join(dir, "library"), "saved");
    await seedLibrary(join(dir, "other"), "other");
    const third = await seedLibrary(join(dir, "third"), "third");
    let reached: () => void = () => {};
    const atGate = new Promise<void>((r) => (reached = r));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const folderFs = {
      stat: async (path: string) => {
        if (path === join(dir, "other")) {
          reached();
          await gate;
        }
        return stat(path, { bigint: true });
      },
      realpath: (path: string) => realpath(path),
    };
    const { engine } = await startEngine({}, { folderFs });

    const updating = engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, libraryPath: join(dir, "other") } });
    await atGate; // the settings.update is paused inside folderIdentity(other), before it can commit

    // An unrelated library.confirm, for a folder staged earlier, lands and
    // commits synchronously while the update above is still paused.
    await engine.receive(libraryOpen(join(dir, "third"), "call-00000001"));
    await engine.receive({ kind: "control", type: "library.confirm", callId: "call-00000002", path: join(dir, "third") });
    expect(engine.library?.root).toBe(join(dir, "third"));

    release();
    await updating;

    // The confirm's switch stands: the settings.update, superseded by it
    // (#pendingLibraryPath, set by confirm too), must not roll it back to
    // "other" or to the original "library".
    expect(engine.library?.root).toBe(join(dir, "third"));
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: { libraryPath: join(dir, "third") } });
    expect(await snapshotIds(engine)).toEqual({ avatars: [third.avatarId], drafts: [third.draftId] });
  });
});

describe("a genuine settings.update switch blocks new paid work, pick and archive for its whole survey", () => {
  /**
   * A folderFs whose stat() of `target`, once armed, reports a different
   * device id (as a volume remounted at the same path would) and, on its
   * SECOND call for `target`, pauses at a gate: the first call is
   * #applySettings' own folderIdentity (which decides a switch is needed);
   * the second is #open's, inside #openOrNull, after the busy check.
   */
  function remountGate(target: string) {
    let armed = false;
    let hits = 0;
    let reached: () => void = () => {};
    const atGate = new Promise<void>((r) => (reached = r));
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    const folderFs = {
      stat: async (path: string) => {
        const real = await stat(path, { bigint: true });
        if (path !== target || !armed) return real;
        if (++hits === 2) {
          reached();
          await gate;
        }
        return { isDirectory: () => true, dev: real.dev + 1000n, ino: real.ino };
      },
      realpath: (path: string) => realpath(path),
    };
    return { folderFs, arm: () => (armed = true), atGate, release };
  }

  test("createDraft is refused with IN_FLIGHT while the survey runs; the new library never gets an orphaned draft", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    const g = remountGate(join(dir, "library"));
    const { engine } = await startEngine({}, { folderFs: g.folderFs });
    await engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    const before = engine.library;
    if (before === null) throw new Error("expected a library");

    g.arm();
    const updating = engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, monthlyBudgetMicros: 20_000_000 } });
    await g.atGate; // past #applySettings' busy check, inside its survey (#openOrNull)

    const refused = await engine.handle(command("avatars.createDraft", { traits: HARNESS_TRAITS, acceptedWorstMicros: HARNESS_NEW_AVATAR.worstMicros }));
    expect(refused).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });

    g.release();
    await updating;
    expect(engine.library).not.toBe(before); // the remount is a genuine switch (a new device id)
    expect(await snapshotIds(engine)).toEqual({ avatars: [saved.avatarId], drafts: [saved.draftId] }); // nothing orphaned
  });

  test("generateCandidates is refused with IN_FLIGHT while the survey runs", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    const g = remountGate(join(dir, "library"));
    const { engine } = await startEngine({}, { folderFs: g.folderFs });
    await engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });

    g.arm();
    const updating = engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, monthlyBudgetMicros: 20_000_000 } });
    await g.atGate;

    const refused = await engine.handle(command("avatars.generateCandidates", { avatarId: saved.draftId, acceptedWorstMicros: 1 }));
    expect(refused).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });

    g.release();
    await updating;
  });

  test("pick is refused with IN_FLIGHT while the survey runs; retried after the switch it succeeds", async () => {
    const saved = await seedLibrary(join(dir, "library"), "saved");
    const g = remountGate(join(dir, "library"));
    const { engine } = await startEngine({}, { folderFs: g.folderFs });
    const pickable = await engine.library?.addPhoto(saved.draftId, PNG_1X1, samplePhotoMeta({ qa: { age: { adult: true, confidence: 0.95 } } }));
    if (pickable === undefined) throw new Error("expected the engine's library to be open");

    g.arm();
    const updating = engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, monthlyBudgetMicros: 20_000_000 } });
    await g.atGate;

    const refused = await engine.handle(command("avatars.pick", { avatarId: saved.draftId, photoId: pickable.id, name: "Zoe" }));
    expect(refused).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });

    g.release();
    await updating;
    const retried = ok(await engine.handle(command("avatars.pick", { avatarId: saved.draftId, photoId: pickable.id, name: "Zoe" })));
    expect(retried).toMatchObject({ result: { avatar: { name: "Zoe" } } });
  });
});

// ---------- money.reconcile ----------

function credits(totalUsageUsd: number): Step {
  return { status: 200, body: { data: { total_credits: 25, total_usage: totalUsageUsd } } };
}

describe("money.reconcile", () => {
  test("without a key it answers AUTH_INVALID and sends nothing", async () => {
    const { engine } = await startEngine();
    const response = await engine.handle(command("money.reconcile"));
    expect(response).toMatchObject({ ok: false, type: "money.reconcile", error: { code: "AUTH_INVALID" } });
  });

  test("with a key OpenRouter already rejected it answers AUTH_INVALID and sends nothing", async () => {
    const { engine } = await startEngine();
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    engine.markKeyRejected(KEY);
    expect(await engine.handle(command("money.reconcile"))).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
  });

  test("on a ledger that could not be read it answers the ledger's cause and sends nothing", async () => {
    await writeFile(join(dir, "ledger.jsonl"), "garbage line\n{}\n");
    const { engine } = await startEngine();
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    expect(await engine.handle(command("money.reconcile"))).toMatchObject({ ok: false, error: { code: "LEDGER_CORRUPT" } });
  });

  test("on a ledger file that could not be read it answers LEDGER_UNREADABLE, its own code", async () => {
    await mkdir(join(dir, "ledger.jsonl"));
    const { engine } = await startEngine();
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    expect(await engine.handle(command("money.reconcile"))).toMatchObject({ ok: false, error: { code: "LEDGER_UNREADABLE" } });
  });

  test("a ledger write that fails in the middle of a reconcile answers LEDGER_WRITE_FAILED and announces the halt", async () => {
    await writeLedger([reserveLine("att-0001", 55_000)]);
    const net = fakeFetch([credits(1.5)]);
    const { engine, events, advanceMono } = await startEngine({}, { fetch: net.fetch });
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    advanceMono(5 * 60_000);
    await chmod(join(dir, "ledger.jsonl"), 0o444);
    const before = events().length;

    const response = await engine.handle(command("money.reconcile"));

    expect(net.calls).toHaveLength(1);
    expect(response).toMatchObject({ ok: false, error: { code: "LEDGER_WRITE_FAILED" } });
    expect(events().slice(before)).toMatchObject([{ type: "money.changed", payload: { status: { ledger: "open", halt: { cause: "LEDGER_WRITE_FAILED" } } } }]);
  });

  test("the first reconcile reads /credits with the key, closes open reserves at their worst case, records the baseline and emits money.changed", async () => {
    await writeLedger([reserveLine("att-0001", 55_000), settleLine("att-0001", 50_000), reserveLine("att-0002", 55_000)]);
    const net = fakeFetch([credits(1.5)]);
    const { engine, events, advanceMono } = await startEngine({}, { fetch: net.fetch });
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    advanceMono(5 * 60_000);
    const before = events().length;

    const response = ok(await engine.handle(command("money.reconcile")));

    expect(net.calls.map((c) => [c.method, c.url, c.headers.Authorization])).toEqual([["GET", CREDITS_URL, `Bearer ${KEY}`]]);
    expect(response).toMatchObject({
      type: "money.reconcile",
      result: {
        status: "done",
        creditsDeltaMicros: null,
        deltaUnavailable: "no-baseline",
        ledgerDeltaMicros: 105_000,
        mismatch: null,
        closedReserves: 1,
        aboveWorstAttempts: [],
        tornLineMoved: false,
        warnings: [],
      },
    });
    expect(JSON.stringify(response)).not.toContain(KEY);
    expect(events().slice(before)).toMatchObject([
      { type: "money.changed", payload: { status: { ledger: "open", spentMicros: 105_000, unsettledCount: 0, reconcileNeeded: false } } },
    ]);
  });

  test("a later reconcile compares the /credits delta with the ledger and gives the verdict", async () => {
    const marker: LedgerLine = { type: "reconcile", creditsUsageMicros: 1_000_000, ledgerTotalMicros: 0, aboveWorstAttempts: [], at: TEN_MIN_AGO };
    await writeLedger([marker, reserveLine("att-0001", 55_000), settleLine("att-0001", 50_000)]);
    const net = fakeFetch([credits(1.2)]);
    const { engine } = await startEngine({}, { fetch: net.fetch });
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });

    const response = ok(await engine.handle(command("money.reconcile")));

    expect(response).toMatchObject({
      result: { status: "done", creditsDeltaMicros: 200_000, deltaUnavailable: null, ledgerDeltaMicros: 50_000, mismatch: true, closedReserves: 0 },
    });
  });

  test("lifts a settle-above-worst halt and lists the attempts it acknowledged", async () => {
    await writeLedger([reserveLine("att-0001", 50_000), settleLine("att-0001", 60_000)]);
    const { engine } = await startEngine({}, { fetch: fakeFetch([credits(0.06)]).fetch });
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });

    const response = ok(await engine.handle(command("money.reconcile")));

    expect(response).toMatchObject({ result: { status: "done", aboveWorstAttempts: ["att-0001"] } });
    expect(ok(await engine.handle(command("money.status")))).toMatchObject({ result: { halt: null } });
  });

  test("too soon after the last request it answers too-early with the wait, reads nothing and emits nothing", async () => {
    await writeLedger([reserveLine("att-0001", 55_000, new Date(NOW - 30_000).toISOString()), settleLine("att-0001", 50_000, new Date(NOW - 30_000).toISOString())]);
    const { engine, events } = await startEngine();
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    const before = events().length;

    const response = ok(await engine.handle(command("money.reconcile")));

    expect(response).toMatchObject({ result: { status: "too-early", retryAfterMs: 90_000, warnings: [] } });
    expect(events().length).toBe(before);
  });

  test("while a paid request of this engine is in flight it answers IN_FLIGHT and reads nothing", async () => {
    const { engine } = await startEngine();
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    const budget = engine.budget;
    if (budget === null) throw new Error("expected a budget");
    await budget.tryReserve({ attemptId: "att-0001", jobId: "job-0001", scope: { avatarJobId: "job-0001" }, model: "x-ai/grok-4.3", worstMicros: 0 });

    expect(await engine.handle(command("money.reconcile"))).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
  });

  test("a 401 from /credits answers AUTH_INVALID and marks the key rejected", async () => {
    await writeLedger([reserveLine("att-0001", 55_000)]);
    const { engine, events, advanceMono } = await startEngine({}, { fetch: fakeFetch([{ status: 401, body: { error: { message: "No auth credentials found" } } }]).fetch });
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    advanceMono(5 * 60_000);

    expect(await engine.handle(command("money.reconcile"))).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
    expect(events().at(-1)).toMatchObject({ type: "settings.changed", payload: { settings: { apiKey: { rejected: true } } } });
    expect(ok(await engine.handle(command("money.status")))).toMatchObject({ result: { unsettledCount: 1, reconcileNeeded: true } });
  });

  test("a 401 for the old key that lands after a key rotation does not mark the new key rejected", async () => {
    await writeLedger([reserveLine("att-0001", 55_000)]);
    let release: (step: Step) => void = () => {};
    const answered = new Promise<Step>((resolve) => (release = resolve));
    const net = fakeFetch([async () => {
      const step = await answered;
      if (typeof step === "function") throw new Error("expected a plain reply");
      return step;
    }]);
    const { engine, advanceMono } = await startEngine({}, { fetch: net.fetch });
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    advanceMono(5 * 60_000);

    const reconciling = engine.handle(command("money.reconcile"));
    await Bun.sleep(10);
    expect(net.calls[0]?.headers.Authorization).toBe(`Bearer ${KEY}`);
    engine.applyControl({ kind: "control", type: "apiKey.set", key: "sk-or-v1-rotated-key-2222" });
    release({ status: 401, body: { error: { message: "No auth credentials found" } } });

    expect(await reconciling).toMatchObject({ ok: false, error: { code: "AUTH_INVALID" } });
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: { apiKey: { last4: "2222", rejected: false } } });
  });

  test("a network failure answers NETWORK and closes nothing", async () => {
    await writeLedger([reserveLine("att-0001", 55_000)]);
    const { engine, advanceMono } = await startEngine({}, { fetch: fakeFetch([{ reject: new TypeError("fetch failed") }]).fetch });
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    advanceMono(5 * 60_000);

    expect(await engine.handle(command("money.reconcile"))).toMatchObject({ ok: false, error: { code: "NETWORK" } });
    expect(ok(await engine.handle(command("money.status")))).toMatchObject({ result: { unsettledCount: 1, reconcileNeeded: true } });
  });
});
