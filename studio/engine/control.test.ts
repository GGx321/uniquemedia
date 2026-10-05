import { describe, expect, test } from "bun:test";
import { COMMAND_DEADLINE_MS, EngineInit, EngineReply, HostCall, MAX_DELETE_VIDEO_FILES, MAX_IMPORT_PHOTO_BYTES } from "./control";
import { MAX_RECORD_FILES_READ } from "./videos/listing";
import { AVATAR_DELETE_PREPARE_DEADLINE_MS, EXPORT_CHECK_TIMEOUT_MS, LIST_BUDGET_MS } from "./videos/timeouts";
import { IMPORT_DESCRIBE_MAX_ATTEMPTS } from "./avatars/plan";
import { PRICE_FETCH_TIMEOUT_MS } from "./money/prices";
import { MAX_ATTEMPT_MS } from "./openrouter/transport";
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

  test("stickerDir is optional, and accepts an absolute path", () => {
    expect(EngineInit.safeParse(base).success).toBe(true);
    expect(EngineInit.safeParse({ ...base, stickerDir: "/app/studio/assets/stickers" }).success).toBe(true);
  });

  test.each(["", "assets/stickers", "../stickers"])("stickerDir refuses %p, which is not absolute", (stickerDir) => {
    expect(EngineInit.safeParse({ ...base, stickerDir }).success).toBe(false);
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
    expect(EngineReply.safeParse({ ...reply, exportFolder: { rootId: "root-00000001", resolved: 3, elsewhere: 0, incomplete: false } }).success).toBe(true);
    // the counts say whether they are whole: a reply that does not say is refused
    expect(EngineReply.safeParse({ ...reply, exportFolder: { rootId: "root-00000001", resolved: 3, elsewhere: 0 } }).success).toBe(false);
    expect(EngineReply.safeParse({ ...reply, exportFolder: { rootId: "root-00000001", resolved: -1, elsewhere: 0, incomplete: false } }).success).toBe(false);
    expect(EngineReply.safeParse({ ...reply, exportFolder: { rootId: "../root", resolved: 0, elsewhere: 0, incomplete: false } }).success).toBe(false);
  });
});

// 3f.1 (invariant 34): main's dialog names a path; it reaches the engine over the control channel only, never from the window.
describe("HostCall media.import and its reply", () => {
  const call = {
    kind: "control" as const,
    type: "media.import" as const,
    callId: "call-00000001",
    pick: "photo" as const,
    name: "summer.jpg",
    expected: { dev: "16777234", ino: "9876543210", size: "4096", mtimeNs: "1700000000123456789", birthtimeNs: "1600000000000000000" },
  };
  const absolute = process.platform === "win32" ? "C:\\Users\\me\\summer.jpg" : "/Users/me/summer.jpg";

  test("takes an absolute path, a pick kind, a display name and the identity main saw", () => {
    expect(HostCall.safeParse({ ...call, path: absolute }).success).toBe(true);
    expect(HostCall.safeParse({ ...call, path: absolute, pick: "any" }).success).toBe(true);
  });

  test("refuses a relative path, a drive-relative one and a path that climbs out with ..", () => {
    for (const path of ["summer.jpg", "./summer.jpg", "C:summer.jpg", "/Users/me/../you/summer.jpg", "..\\x.jpg", ""]) {
      expect(HostCall.safeParse({ ...call, path }).success).toBe(false);
    }
  });

  test("takes Windows drive and UNC paths, read by the same rule on every platform", () => {
    expect(HostCall.safeParse({ ...call, path: "D:\\Reels\\a.jpg" }).success).toBe(true);
    expect(HostCall.safeParse({ ...call, path: "d:/Reels/a.jpg" }).success).toBe(true);
    expect(HostCall.safeParse({ ...call, path: "\\\\server\\share\\a.jpg" }).success).toBe(true);
  });

  test("refuses a path with a NUL byte", () => {
    expect(HostCall.safeParse({ ...call, path: "/Users/me/a.jpg\0.png" }).success).toBe(false);
  });

  test("needs the whole identity, and an identity that is not unsigned decimal numbers is refused", () => {
    const { expected: _gone, ...without } = call;
    expect(HostCall.safeParse({ ...without, path: absolute }).success).toBe(false);
    expect(HostCall.safeParse({ ...call, path: absolute, expected: { ...call.expected, dev: "x" } }).success).toBe(false);
    expect(HostCall.safeParse({ ...call, path: absolute, expected: { ...call.expected, ino: "-1" } }).success).toBe(false);
    expect(HostCall.safeParse({ ...call, path: absolute, expected: { ...call.expected, extra: 1 } }).success).toBe(false);
  });

  test("refuses an unknown pick kind and a field it does not know", () => {
    expect(HostCall.safeParse({ ...call, path: absolute, pick: "document" }).success).toBe(false);
    expect(HostCall.safeParse({ ...call, path: absolute, bytes: new Uint8Array(1) }).success).toBe(false);
  });

  test("the name is a display text: no control character, at most 120", () => {
    expect(HostCall.safeParse({ ...call, path: absolute, name: "a\nb.jpg" }).success).toBe(false);
    expect(HostCall.safeParse({ ...call, path: absolute, name: "a".repeat(121) }).success).toBe(false);
  });

  test("the reply carries a job id, or a refusal with its reason, and nothing else", () => {
    const reply = { kind: "control" as const, type: "reply" as const, callId: "call-00000001" };
    expect(EngineReply.safeParse({ ...reply, mediaJobId: "job-00000001" }).success).toBe(true);
    expect(EngineReply.safeParse({ ...reply, error: { code: "VALIDATION", detail: "not a photo" }, mediaReason: "format" }).success).toBe(true);
    expect(EngineReply.safeParse({ ...reply, mediaReason: "heic?" }).success).toBe(false);
    expect(EngineReply.safeParse({ ...reply, mediaJobId: "no" }).success).toBe(false);
  });
});

// An import's only paid call is the describe job (at most IMPORT_DESCRIBE_MAX_ATTEMPTS attempts): since the 2026-10-05 removal of its age
// check the deadline holds no room for a third attempt, so main does not wait on a call the engine can no longer be making.
describe("COMMAND_DEADLINE_MS['avatars.importAvatar'] covers the describe attempts and no age check", () => {
  test("a price load, then exactly the describe attempts at their slowest, plus the fixed slack", () => {
    expect(COMMAND_DEADLINE_MS["avatars.importAvatar"]).toBe(PRICE_FETCH_TIMEOUT_MS + IMPORT_DESCRIBE_MAX_ATTEMPTS * MAX_ATTEMPT_MS + 30_000);
  });
});

// «Удалить аватар»: main-only control messages. Main asks the engine what goes (`avatar.deletePrepare`), moves the avatar's folder to the system
// Trash, and tells the engine whether it went (`avatar.deleteFinish`). The renderer is never in this: it only names an avatar.
describe("HostCall: avatar.deletePrepare and avatar.deleteFinish", () => {
  const prepare = { kind: "control" as const, type: "avatar.deletePrepare" as const, callId: "call-00000001", avatarId: "avatar-0001" };
  const finish = { kind: "control" as const, type: "avatar.deleteFinish" as const, callId: "call-00000002", avatarId: "avatar-0001", outcome: "trashed" as const };

  test("a prepare names an avatar and nothing else", () => {
    expect(HostCall.safeParse(prepare).success).toBe(true);
    expect(HostCall.safeParse({ ...prepare, path: "/x" }).success).toBe(false);
    expect(HostCall.safeParse({ ...prepare, avatarId: "../x" }).success).toBe(false);
  });

  test("a finish says whether the avatar's folder went to the Trash or stayed", () => {
    expect(HostCall.safeParse(finish).success).toBe(true);
    expect(HostCall.safeParse({ ...finish, outcome: "kept" }).success).toBe(true);
    expect(HostCall.safeParse({ ...finish, outcome: "deleted" }).success).toBe(false);
    expect(HostCall.safeParse({ ...finish, outcome: undefined }).success).toBe(false);
  });
});

describe("EngineReply.deletePlan", () => {
  const reply = { kind: "control" as const, type: "reply" as const, callId: "call-00000001" };
  const plan = { avatarId: "avatar-0001", libraryRoot: "/data/library", folder: "/data/library/avatars/avatar-0001", exportRoot: "/home/a/Studio/export", files: ["/home/a/Studio/export/mia/2026-10-05_photo_001.mp4"], unlisted: 0 };

  test("carries the avatar's folder and its video files, as absolute paths", () => {
    expect(EngineReply.safeParse({ ...reply, deletePlan: plan }).success).toBe(true);
  });

  test("the export root may be absent: no video file can be resolved then", () => {
    expect(EngineReply.safeParse({ ...reply, deletePlan: { ...plan, exportRoot: null, files: [] } }).success).toBe(true);
  });

  test("refuses a relative path and a path with a .. segment", () => {
    expect(EngineReply.safeParse({ ...reply, deletePlan: { ...plan, folder: "avatars/avatar-0001" } }).success).toBe(false);
    expect(EngineReply.safeParse({ ...reply, deletePlan: { ...plan, files: ["/home/a/Studio/export/../secret.mp4"] } }).success).toBe(false);
  });

  test("refuses more files than one delete moves", () => {
    const files = Array.from({ length: MAX_DELETE_VIDEO_FILES + 1 }, (_, i) => `/home/a/Studio/export/mia/v${i}.mp4`);
    expect(EngineReply.safeParse({ ...reply, deletePlan: { ...plan, files } }).success).toBe(false);
  });

  test("refuses a key it does not know", () => {
    expect(EngineReply.safeParse({ ...reply, deletePlan: { ...plan, extra: 1 } }).success).toBe(false);
  });
});

describe("MAX_DELETE_VIDEO_FILES", () => {
  test("is the number of record files one read takes, so the plan can list every file the engine can find", () => {
    expect(MAX_DELETE_VIDEO_FILES).toBe(MAX_RECORD_FILES_READ);
  });
});

describe("COMMAND_DEADLINE_MS['avatars.deletePreview']", () => {
  test("outwaits the engine's own bounded look at the export folder and the record files", () => {
    expect(COMMAND_DEADLINE_MS["avatars.deletePreview"]).toBe(AVATAR_DELETE_PREPARE_DEADLINE_MS);
    expect(AVATAR_DELETE_PREPARE_DEADLINE_MS).toBeGreaterThan(LIST_BUDGET_MS + EXPORT_CHECK_TIMEOUT_MS);
  });
});
