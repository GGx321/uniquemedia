import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EventMessage, ResponseMessage } from "../shared/engine";
import type { EngineInit } from "./control";
import { Engine, engineErrorFrom, resolveOpenRouterBaseUrl } from "./engine";
import { Ledger } from "./money/ledger";
import { MoneyError } from "./money/errors";

const NOW = Date.parse("2026-09-24T12:00:00.000Z");
const BOOT_ID = "boot-0000-aaaa";
const KEY = "sk-or-v1-0123456789abcdef-wxyz";

let dir = "";
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "studio-engine-"));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function init(overrides: Partial<EngineInit> = {}): EngineInit {
  return {
    kind: "control",
    type: "init",
    ledgerPath: join(dir, "ledger.jsonl"),
    settings: {
      monthlyBudgetMicros: 10_000_000,
      libraryPath: join(dir, "library"),
      imageModel: "x-ai/grok-imagine-image-2.0",
      textModel: "x-ai/grok-4.3",
      concurrency: { network: 6 },
    },
    encryptionAvailable: true,
    ...overrides,
  };
}

async function startEngine(overrides: Partial<EngineInit> = {}) {
  const posted: unknown[] = [];
  let n = 0;
  const engine = await Engine.start(init(overrides), {
    bootId: BOOT_ID,
    clock: () => NOW,
    monotonic: () => 0,
    newId: () => `id-${String(++n).padStart(8, "0")}`,
    post: (message) => posted.push(message),
  });
  return { engine, posted };
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

describe("Engine command dispatch", () => {
  test("engine.snapshot carries the bootId, settings and money status", async () => {
    const { engine } = await startEngine();
    const response = ok(await engine.handle(command("engine.snapshot")));
    if (response.type !== "engine.snapshot") throw new Error("wrong type");
    expect(response.result.bootId).toBe(BOOT_ID);
    expect(response.result.lastSeq).toBe(0);
    expect(response.result.settings.libraryPath).toBe(join(dir, "library"));
    expect(response.result.money).toEqual({
      month: "2026-09",
      spentMicros: 0,
      monthlyBudgetMicros: 10_000_000,
      unsettledMicros: 0,
      unsettledCount: 0,
      reconcileNeeded: false,
      reconcileReasons: [],
    });
    expect(response.result.avatars).toEqual([]);
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
    const response = await engine.handle(command("avatars.list"));
    expect(ResponseMessage.safeParse(response).success).toBe(true);
    expect(response).toMatchObject({ ok: false, type: "avatars.list", error: { code: "INTERNAL", detail: "avatars.list is not implemented yet" } });
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
  test("apiKey.set makes settings report the last four chars, never the key", async () => {
    const { engine, posted } = await startEngine();
    await engine.receive({ kind: "control", type: "apiKey.set", key: KEY });
    expect(posted).toEqual([]);
    expect(engine.apiKey).toBe(KEY);

    const response = ok(await engine.handle(command("settings.get")));
    if (response.type !== "settings.get") throw new Error("wrong type");
    expect(response.result.apiKey).toEqual({ stored: true, last4: "wxyz", encryptionAvailable: true, rejected: false });
    expect(JSON.stringify(response)).not.toContain(KEY);
  });

  test("apiKey.clear forgets the key", async () => {
    const { engine } = await startEngine();
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    engine.applyControl({ kind: "control", type: "apiKey.clear" });
    expect(engine.apiKey).toBeNull();
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

describe("money.status over the ledger", () => {
  test("counts this month's settles and flags reserves left open by an earlier process", async () => {
    const ledger = await Ledger.open(join(dir, "ledger.jsonl"));
    const at = new Date(NOW - 60_000).toISOString();
    const reserve = { type: "reserve" as const, jobId: "job-0001", scope: { avatarJobId: "job-0001" }, model: "x-ai/grok-imagine-image-2.0", at };
    await ledger.append({ ...reserve, attemptId: "att-0001", worstMicros: 55_000 });
    await ledger.append({ type: "settle", attemptId: "att-0001", costMicros: 50_000, estimated: false, at });
    await ledger.append({ ...reserve, attemptId: "att-0002", worstMicros: 55_000 });

    const { engine } = await startEngine();
    const response = ok(await engine.handle(command("money.status")));
    expect(response).toMatchObject({
      type: "money.status",
      result: {
        month: "2026-09",
        spentMicros: 50_000,
        unsettledMicros: 55_000,
        unsettledCount: 1,
        reconcileNeeded: true,
        reconcileReasons: ["open-reserves"],
      },
    });
  });

  test("a torn last line needs a reconcile", async () => {
    await writeFile(join(dir, "ledger.jsonl"), '{"type":"reserve","attem');
    const { engine } = await startEngine();
    const response = ok(await engine.handle(command("money.status")));
    expect(response).toMatchObject({ result: { reconcileNeeded: true, reconcileReasons: ["torn-ledger-line"] } });
  });

  test("a corrupt ledger answers LEDGER_CORRUPT and emits engine.error, but the engine keeps serving", async () => {
    await writeFile(join(dir, "ledger.jsonl"), "garbage line\n{}\n");
    const { engine, posted } = await startEngine();

    expect(posted).toHaveLength(1);
    const event = EventMessage.parse(posted[0]);
    expect(event).toMatchObject({ type: "engine.error", seq: 1, bootId: BOOT_ID, payload: { error: { code: "LEDGER_CORRUPT" } } });

    expect(await engine.handle(command("money.status"))).toMatchObject({ ok: false, error: { code: "LEDGER_CORRUPT" } });
    expect(await engine.handle(command("engine.snapshot"))).toMatchObject({ ok: false, error: { code: "LEDGER_CORRUPT" } });
    ok(await engine.handle(command("settings.get")));

    const events = ok(await engine.handle(command("engine.events", { afterSeq: 0, bootId: BOOT_ID })));
    expect(events).toMatchObject({ result: { gap: false, events: [{ type: "engine.error", seq: 1 }] } });
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
  test("markKeyRejected marks the key rejected in settings and the snapshot and emits engine.error AUTH_INVALID once", async () => {
    const { engine, posted } = await startEngine();
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    engine.markKeyRejected();
    engine.markKeyRejected();

    expect(posted).toHaveLength(1);
    expect(EventMessage.parse(posted[0])).toMatchObject({ type: "engine.error", payload: { error: { code: "AUTH_INVALID" } } });
    expect(JSON.stringify(posted)).not.toContain(KEY);

    const settings = ok(await engine.handle(command("settings.get")));
    expect(settings).toMatchObject({ result: { apiKey: { stored: true, last4: "wxyz", rejected: true } } });
    const snapshot = ok(await engine.handle(command("engine.snapshot")));
    expect(snapshot).toMatchObject({ result: { lastSeq: 1, settings: { apiKey: { rejected: true } } } });
  });

  test("a new key clears the rejection", async () => {
    const { engine } = await startEngine();
    engine.applyControl({ kind: "control", type: "apiKey.set", key: KEY });
    engine.markKeyRejected();
    engine.applyControl({ kind: "control", type: "apiKey.set", key: "sk-or-v1-rotated-key-9876" });
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: { apiKey: { last4: "9876", rejected: false } } });
  });

  test("without a key there is nothing to reject", async () => {
    const { engine, posted } = await startEngine();
    engine.markKeyRejected();
    expect(posted).toEqual([]);
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: { apiKey: { stored: false, rejected: false } } });
  });
});

describe("settings.update from main", () => {
  test("replaces the settings the engine reports", async () => {
    const { engine } = await startEngine();
    const next = { ...init().settings, textModel: "x-ai/grok-5", concurrency: { network: 3 } };
    await engine.receive({ kind: "control", type: "settings.update", settings: next });
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: next });
  });

  test("a new monthly budget applies to money.status", async () => {
    const { engine } = await startEngine();
    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, monthlyBudgetMicros: 25_000_000 } });
    expect(ok(await engine.handle(command("money.status")))).toMatchObject({ result: { monthlyBudgetMicros: 25_000_000 } });
  });

  test("an invalid update changes nothing", async () => {
    const { engine } = await startEngine();
    await engine.receive({ kind: "control", type: "settings.update", settings: { ...init().settings, monthlyBudgetMicros: -1 } });
    expect(ok(await engine.handle(command("settings.get")))).toMatchObject({ result: { monthlyBudgetMicros: 10_000_000 } });
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
  test("a notice is emitted as an engine.error in the engine's own stream", async () => {
    const { engine, posted } = await startEngine();
    await engine.receive({ kind: "control", type: "notice", error: { code: "INTERNAL", detail: "settings.json was reset" } });
    expect(posted).toHaveLength(1);
    expect(EventMessage.parse(posted[0])).toMatchObject({
      type: "engine.error",
      seq: 1,
      bootId: BOOT_ID,
      payload: { error: { code: "INTERNAL", detail: "settings.json was reset" } },
    });
  });
});

describe("library.open from main", () => {
  function libraryOpen(path: string, callId = "call-00000001") {
    return { kind: "control", type: "library.open", callId, path };
  }

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
});
