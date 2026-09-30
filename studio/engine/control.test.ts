import { describe, expect, test } from "bun:test";
import { COMMAND_DEADLINE_MS, EngineInit, EngineReply, HostCall, MAX_IMPORT_PHOTO_BYTES } from "./control";
import { PRICE_FETCH_TIMEOUT_MS } from "./money/prices";
import { REFERENCE_TIMEOUT_MS } from "./runs/timeouts";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// T6c review round 2, L3: bytes crossing this boundary must never be
// unbounded — main already caps its own read at the very same number
// (importFlow.ts), but the contract does not trust that it is the only
// possible sender, or that it never regresses.
describe("HostCall: import.stagePhoto's bytes are bounded (L3)", () => {
  const base = { kind: "control" as const, type: "import.stagePhoto" as const, callId: "call-00000001" };

  test("exactly at the cap parses", () => {
    expect(HostCall.safeParse({ ...base, bytes: new Uint8Array(MAX_IMPORT_PHOTO_BYTES) }).success).toBe(true);
  });

  test("one byte over the cap is rejected", () => {
    expect(HostCall.safeParse({ ...base, bytes: new Uint8Array(MAX_IMPORT_PHOTO_BYTES + 1) }).success).toBe(false);
  });
});

// runs.start answers only after everything it awaits: the price load (one
// timeout), then the master's own look before a run exists (`preflightMaster`:
// loadMaster, then prepareGates, each bounded by REFERENCE_TIMEOUT_MS). Main
// must not answer INTERNAL while the engine goes on to create and launch a
// paid run: the user would click again and pay twice.
describe("COMMAND_DEADLINE_MS['runs.start'] covers the worst awaited path", () => {
  test("a price load, then both bounded steps of the master's preflight, with room to spare", () => {
    const deadline = COMMAND_DEADLINE_MS["runs.start"] ?? 0;
    expect(deadline).toBeGreaterThan(PRICE_FETCH_TIMEOUT_MS + 2 * REFERENCE_TIMEOUT_MS);
  });

  test("runs.resume does no preflight: it keeps the estimate's deadline", () => {
    expect(COMMAND_DEADLINE_MS["runs.resume"]).toBe(PRICE_FETCH_TIMEOUT_MS + 15_000);
  });
});

describe("EngineInit.defaultExportPath", () => {
  const settings = {
    monthlyBudgetMicros: 10_000_000,
    libraryPath: "/data/library",
    imageModel: "x-ai/grok-imagine-image-2.0",
    textModel: "x-ai/grok-4.3",
    concurrency: { network: 6 },
    imageAgeCheck: "off",
    exportPath: "/home/a/Studio/export",
    renderConcurrency: "auto",
  };
  const base = { kind: "control", type: "init", ledgerPath: "/data/ledger.jsonl", defaultLibraryPath: "/data/library", rawDir: "/data/raw", settings, encryptionAvailable: true, notices: [] };

  test("is optional: an init without it is still valid", () => {
    expect(EngineInit.safeParse(base).success).toBe(true);
  });

  test("accepts an absolute path", () => {
    expect(EngineInit.safeParse({ ...base, defaultExportPath: "/home/a/Studio/export" }).success).toBe(true);
  });

  test.each(["", "Studio/export", "../export"])("refuses %p, which is not absolute", (defaultExportPath) => {
    expect(EngineInit.safeParse({ ...base, defaultExportPath }).success).toBe(false);
  });

  test("renderTmpDir is optional, and accepts an absolute path", () => {
    expect(EngineInit.safeParse({ ...base, renderTmpDir: "/data/render-tmp" }).success).toBe(true);
  });

  test.each(["", "render-tmp", "../render-tmp"])("renderTmpDir refuses %p, which is not absolute", (renderTmpDir) => {
    expect(EngineInit.safeParse({ ...base, renderTmpDir }).success).toBe(false);
  });

  test("ffmpegEnv is optional, and accepts a record of strings", () => {
    expect(EngineInit.safeParse({ ...base, ffmpegEnv: { PATH: "/usr/bin", TMPDIR: "/tmp" } }).success).toBe(true);
  });

  test("ffmpegEnv refuses a value that is not a string", () => {
    expect(EngineInit.safeParse({ ...base, ffmpegEnv: { PATH: 1 } }).success).toBe(false);
  });
});

// 3e.3: the owner's pick of the export folder reaches the engine as a call with an absolute path, and its reply says what
// the folder is. The reply is held to the contract like every message that leaves the engine.
describe("HostCall export.choose and its reply", () => {
  const call = { kind: "control" as const, type: "export.choose" as const, callId: "call-00000001" };

  test("takes an absolute path", () => {
    expect(HostCall.safeParse({ ...call, path: process.platform === "win32" ? "D:\\Reels" : "/Volumes/Reels" }).success).toBe(true);
  });

  test("refuses a relative path, and a path that climbs out with ..", () => {
    expect(HostCall.safeParse({ ...call, path: "Reels" }).success).toBe(false);
    expect(HostCall.safeParse({ ...call, path: "/Volumes/Reels/../Other" }).success).toBe(false);
  });

  test("the reply carries the folder's id with its counts, and refuses a count that is negative or an id that is not one", () => {
    const reply = { kind: "control" as const, type: "reply" as const, callId: "call-00000001" };
    expect(EngineReply.safeParse({ ...reply, exportFolder: { rootId: "root-00000001", resolved: 3, elsewhere: 0 } }).success).toBe(true);
    expect(EngineReply.safeParse({ ...reply, exportFolder: { rootId: "root-00000001", resolved: -1, elsewhere: 0 } }).success).toBe(false);
    expect(EngineReply.safeParse({ ...reply, exportFolder: { rootId: "../root", resolved: 0, elsewhere: 0 } }).success).toBe(false);
  });
});
