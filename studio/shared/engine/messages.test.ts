import { describe, expect, test } from "bun:test";
import type { AvatarDescriptor, AvatarTraits } from "./avatar";
import type { MontageDraft } from "./montage";
import type { VideoSummary } from "./video";
import {
  COMMAND_TYPES,
  ENGINE_COMMAND_TYPES,
  MAIN_ONLY_COMMANDS,
  MAX_UNREADABLE_AVATARS,
  type CommandPayload,
  type CommandResult,
  type CommandType,
} from "./commands";
import { EVENT_TYPES, type EventMessage, type EventPayload, type EventType } from "./events";
import { errorResponseFor, parseEngineCommand, parseMessage } from "./messages";
import type {
  ApiKeyStatus,
  AvatarSummary,
  Candidate,
  Draft,
  EngineNotice,
  Estimate,
  MoneyStatus,
  MusicKeyStatus,
  MusicStatus,
  PhotoSummary,
  RunRequest,
  RunSummary,
  Settings,
  UnreadableAvatar,
} from "./state";
import { JobState } from "./state";
import { PROTOCOL_VERSION } from ".";

// ---------- fixtures ----------

const BOOT = "boot-00000001";
const API_KEY = `sk-or-v1-${"0a".repeat(32)}`;

const keyStatus: ApiKeyStatus = { stored: true, last4: "3f2a", encryptionAvailable: true, rejected: false };

const MUSIC_KEY = "Zq7-vKt9-Wm2x-Lp4s-0000";
const musicKeyStatus: MusicKeyStatus = { stored: true, last4: "0000", rejected: false };

const musicStatus: MusicStatus = {
  listFetchedAt: "2026-09-27T20:42:44.190Z",
  trackCount: 30,
  bytesOnDisk: 0,
  sentLast31d: 2,
  limit: 30,
  serverRemaining: 28,
  nextFreeAt: "2026-10-28T20:42:44.190Z",
  refresh: { state: "idle" },
};

const settings: Settings = {
  apiKey: keyStatus,
  musicKey: musicKeyStatus,
  monthlyBudgetMicros: 10_000_000,
  libraryPath: "/Users/alex/Studio/library",
  imageModel: "x-ai/grok-imagine-image-2.0",
  textModel: "x-ai/grok-4.3",
  concurrency: { network: 6 },
  imageAgeCheck: "off",
  exportPath: "/Users/alex/Studio/export",
  renderConcurrency: "auto",
};

const money: MoneyStatus = {
  ledger: "open",
  month: "2026-09",
  spentMicros: 1_250_000,
  monthlyBudgetMicros: 10_000_000,
  unsettledMicros: 0,
  unsettledCount: 0,
  reconcileNeeded: false,
  reconcileReasons: [],
  halt: null,
};

const notice: EngineNotice = {
  noticeId: "notice-0001",
  code: "engine-restarted",
  detail: "the engine exited unexpectedly (code 9); restarting it",
  at: "2026-09-24T10:00:00.000Z",
  count: 1,
};

const estimate: Estimate = { expectedMicros: 200_000, worstMicros: 230_000, prices: "live", pricesAsOf: "2026-09-24" };

const traits: AvatarTraits = {
  age: 25,
  ethnicity: "european",
  skinTone: "light-olive",
  hairColor: "chestnut",
  hairLength: "shoulder",
  hairTexture: "wavy",
  eyeColor: "hazel",
  build: "athletic",
  marks: ["freckles"],
  vibe: "approachable, coffee, travel, books",
};

const descriptor: AvatarDescriptor = {
  age: 25,
  text: "25-year-old woman, light olive skin, hazel eyes, light freckles across the nose, shoulder-length wavy chestnut hair, slim athletic build.",
};

// A draft is an avatar with status "draft"; its candidates are photos of that avatar.
const DRAFT_ID = "avatar-0002";
const candidates: Candidate[] = ["photo-0101", "photo-0102", "photo-0103"].map((photoId) => ({
  avatarId: DRAFT_ID,
  photoId,
}));
const draft: Draft = { avatarId: DRAFT_ID, traits, descriptor, candidates, hiddenBelowThreshold: 0, estimate };

const avatar: AvatarSummary = {
  avatarId: "avatar-0001",
  name: "Лиза",
  descriptor,
  masterPhotoId: "photo-0001",
  createdAt: "2026-09-24T10:00:00Z",
  status: "active",
  photoCount: 0,
  videoCount: 0,
  eligibleUnusedCount: 0,
};

const job: JobState = {
  kind: "avatar.candidates",
  jobId: "job-00000001",
  avatarId: DRAFT_ID,
  status: "running",
  done: 1,
  total: 4,
};

const unreadable: UnreadableAvatar = { avatarId: "avatar-0009", name: "Zoe", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" };

const runRequest: RunRequest = { avatarId: "avatar-0001", count: 20, categories: ["home", "travel"], poses: { profile: true, back: false } };

const runSummary: RunSummary = {
  runId: "run-00000001",
  avatarId: "avatar-0001",
  createdAt: "2026-09-24T11:00:00.000Z",
  total: 20,
  done: 12,
  failed: 1,
  open: 7,
  capMicros: 3_385_000,
  committedMicros: 1_200_000,
  running: false,
  resumable: true,
  capExhausted: false,
  remainingWorstMicros: 1_650_000,
};

const photo: PhotoSummary = {
  photoId: "photo-0002",
  avatarId: "avatar-0001",
  runId: "run-00000001",
  category: "home",
  createdAt: "2026-09-24T11:00:00Z",
  qa: { faceCos: 0.81, age: { adult: true, confidence: 0.95 } },
  used: true,
  usedIn: ["video-00000001"],
  rejected: false,
  reserved: false,
  eligible: true,
};

// A photo made before T7b's face gate, or with the image age check off: no
// qa fields at all, additive and optional on PhotoSummary itself.
const photoWithoutQa: PhotoSummary = {
  photoId: "photo-0003",
  avatarId: "avatar-0001",
  runId: "run-00000001",
  category: "travel",
  createdAt: "2026-09-24T11:05:00Z",
  used: false,
  usedIn: [],
  rejected: false,
  reserved: false,
  eligible: true,
};

const video: VideoSummary = {
  videoId: "video-00000001",
  avatarId: "avatar-0001",
  kind: "photo",
  durationMs: 8_000,
  bytes: 3_100_000,
  createdAt: "2026-09-29T12:00:00.000Z",
  relPath: "Mia/2026-09-29_photo_001.mp4",
  fileState: "present",
  montageId: "montage-00000001",
  photoCount: 1,
  music: null,
  hasPoster: true,
};

const montageDraft: MontageDraft = {
  schemaVersion: 1,
  avatarId: "avatar-0001",
  clips: [
    {
      clipId: "clip-0001",
      durationMs: 8_000,
      transitionIn: "cut",
      kind: "photo",
      cell: { photo: { source: "scene", photoId: "photo-0002" }, focus: { x: 0.5, y: 0.38 } },
      motion: "kenburns",
    },
  ],
  layers: [],
  music: null,
  seed: 7,
};

const emptyDraft: MontageDraft = { ...montageDraft, clips: [] };

const progressEvent: EventMessage = {
  v: PROTOCOL_VERSION,
  id: "evt-00000007",
  kind: "event",
  seq: 7,
  bootId: BOOT,
  type: "job.progress",
  payload: { kind: "avatar.candidates", jobId: "job-00000001", avatarId: DRAFT_ID, done: 1, total: 4 },
};

type CommandCase<T extends CommandType> = { payload: CommandPayload<T>; result: CommandResult<T> };

const commandCases: { [T in CommandType]: CommandCase<T> } = {
  "settings.get": { payload: {}, result: settings },
  "settings.setApiKey": { payload: { key: API_KEY }, result: keyStatus },
  "settings.clearApiKey": {
    payload: {},
    result: { stored: false, last4: null, encryptionAvailable: true, rejected: false },
  },
  "settings.setMusicKey": { payload: { key: MUSIC_KEY }, result: musicKeyStatus },
  "settings.clearMusicKey": { payload: {}, result: { stored: false, last4: null, rejected: false } },
  "settings.setBudget": { payload: { monthlyBudgetMicros: 10_000_000 }, result: settings },
  "settings.setLibraryPath": { payload: { path: "/Users/alex/Studio/library" }, result: settings },
  "settings.setModels": {
    payload: { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" },
    result: settings,
  },
  "settings.setConcurrency": { payload: { network: 6 }, result: settings },
  "settings.setImageAgeCheck": { payload: { imageAgeCheck: "on" }, result: settings },
  "money.status": { payload: {}, result: money },
  "money.reconcile": {
    payload: {},
    result: {
      status: "done",
      creditsDeltaMicros: 210_000,
      deltaUnavailable: null,
      ledgerDeltaMicros: 230_000,
      mismatch: true,
      closedReserves: 2,
      aboveWorstAttempts: [],
      tornLineMoved: false,
      warnings: [],
    },
  },
  "avatars.list": { payload: {}, result: { avatars: [avatar], unreadableAvatars: [unreadable], unreadableTotal: 1 } },
  "avatars.estimate": { payload: { traits }, result: estimate },
  "avatars.estimateCandidates": { payload: { avatarId: DRAFT_ID }, result: { ...estimate, expectedMicros: 198_000, worstMicros: 227_000 } },
  "avatars.estimateRewriteDescriptor": { payload: { avatarId: "avatar-0009" }, result: { ...estimate, expectedMicros: 2_625, worstMicros: 27_500 } },
  "avatars.createDraft": { payload: { traits, acceptedWorstMicros: 230_000 }, result: { draft: { ...draft, candidates: [] } } },
  "avatars.generateCandidates": { payload: { avatarId: DRAFT_ID, acceptedWorstMicros: 230_000 }, result: { jobId: "job-00000001" } },
  "avatars.cancel": { payload: { jobId: "job-00000001" }, result: { jobId: "job-00000001" } },
  "avatars.pick": {
    payload: { avatarId: DRAFT_ID, photoId: "photo-0101", name: "Лиза" },
    result: { avatar: { ...avatar, avatarId: DRAFT_ID, masterPhotoId: "photo-0101" } },
  },
  "avatars.archive": { payload: { avatarId: "avatar-0001" }, result: { avatar: { ...avatar, status: "archived" } } },
  "avatars.rewriteDescriptor": { payload: { avatarId: "avatar-0009", acceptedWorstMicros: 27_500 }, result: { avatarId: "avatar-0009" } },
  "avatars.pickImportPhoto": { payload: {}, result: { picked: true, stagingId: "staging-0001", width: 1024, height: 1365 } },
  "avatars.estimateImport": { payload: { stagingId: "staging-0001" }, result: { ...estimate, expectedMicros: 6_500, worstMicros: 42_000 } },
  "avatars.importAvatar": {
    payload: { stagingId: "staging-0001", name: "Лиза", confirmedAiPersona: true, acceptedWorstMicros: 42_000 },
    result: { avatar },
  },
  "runs.estimate": { payload: runRequest, result: { estimate } },
  "runs.start": {
    payload: { ...runRequest, acceptedWorstMicros: 3_330_000 },
    result: { runId: "run-00000001", jobId: "job-00000002" },
  },
  "runs.cancel": { payload: { runId: "run-00000001" }, result: { runId: "run-00000001" } },
  "runs.estimateResume": { payload: { runId: "run-00000001" }, result: { estimate: { ...estimate, expectedMicros: 500_000, worstMicros: 1_650_000 } } },
  "runs.resume": { payload: { runId: "run-00000001", acceptedWorstMicros: 1_650_000 }, result: { runId: "run-00000001", jobId: "job-00000003" } },
  "runs.list": { payload: {}, result: { runs: [runSummary] } },
  "photos.list": { payload: { avatarId: "avatar-0001" }, result: { photos: [photo, photoWithoutQa], skippedTotal: 1 } },
  "photos.setRejected": {
    payload: { avatarId: "avatar-0001", photoId: "photo-0003", rejected: true },
    result: { photo: { ...photoWithoutQa, rejected: true, eligible: false } },
  },
  "videos.render": { payload: { montageId: "montage-00000001" }, result: { jobId: "job-00000004", videoId: "video-00000002" } },
  "videos.cancel": { payload: { jobId: "job-00000004" }, result: { jobId: "job-00000004" } },
  "videos.list": { payload: { avatarId: "avatar-0001" }, result: { videos: [video] } },
  "videos.delete": { payload: { videoId: "video-00000001", mode: "video" }, result: { videoId: "video-00000001", fileDeleted: true, fileState: "present" } },
  "videos.reveal": { payload: { videoId: "video-00000001" }, result: { videoId: "video-00000001" } },
  "settings.setExportPath": { payload: {}, result: { picked: true, settings, rootId: "root-00000001", resolved: 3, elsewhere: 1, incomplete: false } },
  "settings.exportDisplay": { payload: {}, result: { display: "~/Studio/export" } },
  "export.check": { payload: {}, result: { exportStatus: { status: "unavailable", reason: "missing" } } },
  "music.status": { payload: {}, result: musicStatus },
  "music.refresh": { payload: { confirm: true }, result: { status: { ...musicStatus, refresh: { state: "running", done: 0, total: 1 } } } },
  "music.list": {
    payload: {},
    result: {
      tracks: [{ trackId: "4199287736976977", title: "Espresso", artist: "Sabrina Carpenter", durationMs: 175_000, explicit: false, highlights: [{ ms: 42_000, likelyDefault: false }, { ms: 1_500, likelyDefault: true }], hasCover: true }],
    },
  },
  "music.peaks": {
    payload: { track: { source: "trending", trackId: "4199287736976977" }, startMs: 0, durationMs: 15_000, bars: 16 },
    result: { peaks: Array.from({ length: 16 }, (_, i) => i * 60) },
  },
  "montages.create": {
    payload: { avatarId: "avatar-0001", photoIds: ["photo-0002"] },
    result: { montage: { montageId: "montage-00000001", name: null, spec: montageDraft, updatedAt: "2026-09-29T12:00:00.000Z" } },
  },
  "montages.get": {
    payload: { montageId: "montage-00000001" },
    result: { montage: { montageId: "montage-00000001", name: "Кафе и город", spec: montageDraft, updatedAt: "2026-09-29T12:00:00.000Z" }, issues: [{ code: "photo-unavailable", path: ["clips", 0, "cell"] }] },
  },
  "montages.list": {
    payload: { avatarId: "avatar-0001" },
    result: {
      items: [{ montage: { montageId: "montage-00000001", name: null, spec: montageDraft, updatedAt: "2026-09-29T12:00:00.000Z" }, issues: [], videoCount: 2 }],
      total: 1,
      skippedTotal: 0,
    },
  },
  "montages.save": {
    payload: { montageId: "montage-00000001", spec: montageDraft, name: "Кафе и город" },
    result: { montage: { montageId: "montage-00000001", name: "Кафе и город", spec: montageDraft, updatedAt: "2026-09-29T12:05:00.000Z" } },
  },
  "montages.delete": { payload: { montageId: "montage-00000001" }, result: { montageId: "montage-00000001" } },
  "montages.focus": {
    payload: { avatarId: "avatar-0001", photo: { source: "scene", photoId: "photo-0002" } },
    result: { focus: { x: 0.5, y: 0.31 } },
  },
  "montages.textPreview": {
    payload: {
      avatarId: "avatar-0001",
      layer: { kind: "text", layerId: "layer-00000001", startMs: 0, endMs: 3000, value: "sunday reset", font: "manrope", style: "plaque", color: "#ffffff", x: 0.5, y: 0.195, scale: 1 },
    },
    result: { previewId: "preview-00000001", width: 640, height: 130 },
  },
  "engine.snapshot": {
    payload: {},
    result: {
      bootId: BOOT,
      lastSeq: 7,
      settings,
      money,
      avatars: [avatar],
      drafts: [draft],
      unreadableAvatars: [unreadable],
      unreadableTotal: 1,
      jobs: [job],
      librarySwitchGeneration: 2,
      exportStatus: { status: "unavailable", reason: "missing" },
      notices: [notice],
    },
  },
  "engine.events": { payload: { afterSeq: 6, bootId: BOOT }, result: { gap: false, events: [progressEvent] } },
};

const eventCases: { [T in EventType]: EventPayload<T> } = {
  "job.progress": { kind: "avatar.candidates", jobId: "job-00000001", avatarId: DRAFT_ID, done: 2, total: 4 },
  "job.done": {
    jobId: "job-00000001",
    result: { kind: "avatar.candidates", avatarId: DRAFT_ID, candidates, rejectedByAgeCheck: 1, failedSlots: [{ slot: 4, reason: "age-rejected" }] },
  },
  "job.failed": { kind: "run", jobId: "job-00000001", runId: "run-00000001", avatarId: "avatar-0001", error: { code: "AUTH_INVALID", detail: "401 from OpenRouter" } },
  "job.cancelled": { kind: "avatar.candidates", jobId: "job-00000001", avatarId: DRAFT_ID },
  "money.changed": { status: money },
  "money.reconcileNeeded": { reasons: ["open-reserves"], unsettledMicros: 55_000 },
  "settings.changed": { settings: { ...settings, apiKey: { ...keyStatus, rejected: true } }, librarySwitchGeneration: 2 },
  "avatar.changed": { avatar },
  "draft.changed": { draft },
  "engine.error": { error: { code: "INTERNAL" } },
  "engine.notice": { notice },
  "video.changed": { change: "upserted", video },
  "montage.changed": { change: "upserted", montage: { montageId: "montage-00000001", name: null, spec: montageDraft, updatedAt: "2026-09-29T12:00:00.000Z" } },
  "export.status": { exportStatus: { status: "unavailable", reason: "missing" } },
  "music.changed": { status: { ...musicStatus, refresh: { state: "running", done: 1, total: 31 } } },
};

// ---------- helpers ----------

/** Sends the message through JSON (as IPC would) and expects it back unchanged. */
function expectRoundTrip(message: object): void {
  const r = parseMessage(JSON.parse(JSON.stringify(message)));
  const back: unknown = r.ok ? r.message : r.reason;
  expect(back).toEqual(message);
}

function reasonOf(input: unknown): string {
  const r = parseMessage(input);
  if (r.ok) throw new Error("expected the message to be rejected");
  return r.reason;
}

const command = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "command", type, payload });
const okResponse = (type: string, result: unknown) => ({
  v: PROTOCOL_VERSION,
  id: "msg-00000001",
  kind: "response",
  type,
  ok: true,
  result,
});
const event = (type: string, payload: unknown, seq: unknown = 1) => ({
  v: PROTOCOL_VERSION,
  id: "evt-00000001",
  kind: "event",
  seq,
  bootId: BOOT,
  type,
  payload,
});

// ---------- the contract's surface ----------

describe("contract surface", () => {
  test("the command set is exactly the one the stage 2 plan names", () => {
    const actual: string[] = [...COMMAND_TYPES].sort();
    expect(actual).toEqual(
      [
        "settings.get",
        "settings.setApiKey",
        "settings.clearApiKey",
        "settings.setMusicKey",
        "settings.clearMusicKey",
        "settings.setBudget",
        "settings.setLibraryPath",
        "settings.setExportPath",
        "settings.exportDisplay",
        "settings.setModels",
        "settings.setConcurrency",
        "settings.setImageAgeCheck",
        "money.status",
        "money.reconcile",
        "avatars.list",
        "avatars.estimate",
        "avatars.estimateCandidates",
        "avatars.estimateRewriteDescriptor",
        "avatars.createDraft",
        "avatars.generateCandidates",
        "avatars.cancel",
        "avatars.pick",
        "avatars.archive",
        "avatars.rewriteDescriptor",
        "avatars.pickImportPhoto",
        "avatars.estimateImport",
        "avatars.importAvatar",
        "runs.estimate",
        "runs.start",
        "runs.cancel",
        "runs.estimateResume",
        "runs.resume",
        "runs.list",
        "photos.list",
        "photos.setRejected",
        "videos.render",
        "videos.cancel",
        "videos.list",
        "videos.delete",
        "videos.reveal",
        "music.status",
        "music.refresh",
        "music.list",
        "music.peaks",
        "montages.create",
        "montages.get",
        "montages.list",
        "montages.save",
        "montages.delete",
        "montages.focus",
        "montages.textPreview",
        "export.check",
        "engine.snapshot",
        "engine.events",
      ].sort(),
    );
  });

  test("the event set is exactly the one the stage 2 plan names", () => {
    const actual: string[] = [...EVENT_TYPES].sort();
    expect(actual).toEqual(
      [
        "job.progress",
        "job.done",
        "job.failed",
        "job.cancelled",
        "money.changed",
        "money.reconcileNeeded",
        "settings.changed",
        "avatar.changed",
        "draft.changed",
        "engine.error",
        "engine.notice",
        "video.changed",
        "montage.changed",
        "export.status",
        "music.changed",
      ].sort(),
    );
  });

  test("the command fixtures cover every command type", () => {
    const covered: string[] = Object.keys(commandCases).sort();
    const all: string[] = [...COMMAND_TYPES].sort();
    expect(covered).toEqual(all);
  });

  test("the event fixtures cover every event type", () => {
    const covered: string[] = Object.keys(eventCases).sort();
    const all: string[] = [...EVENT_TYPES].sort();
    expect(covered).toEqual(all);
  });

  test("only the key commands, the dialogs («import photo», «export folder») and «show in folder» are handled by main alone", () => {
    const actual: string[] = [...MAIN_ONLY_COMMANDS].sort();
    expect(actual).toEqual([
      "avatars.pickImportPhoto",
      "settings.clearApiKey",
      "settings.clearMusicKey",
      "settings.exportDisplay",
      "settings.setApiKey",
      "settings.setExportPath",
      "settings.setMusicKey",
      "videos.reveal",
    ]);
  });

  test("the protocol is at version 5: render jobs, video records and the Stage 3 fields", () => {
    expect(PROTOCOL_VERSION).toBe(5);
  });

  test("the engine accepts every command except the main-only ones", () => {
    const engine: string[] = [...ENGINE_COMMAND_TYPES].sort();
    const expected: string[] = COMMAND_TYPES.filter((t) => !MAIN_ONLY_COMMANDS.includes(t)).sort();
    expect(engine).toEqual(expected);
  });
});

// ---------- round trips ----------

describe("round trip", () => {
  const commandEntries = Object.entries(commandCases);
  const eventEntries = Object.entries(eventCases);

  test.each(commandEntries)("%s command survives JSON and parses back unchanged", (type, c) => {
    const msg = { v: PROTOCOL_VERSION, id: crypto.randomUUID(), kind: "command", type, payload: c.payload };
    expectRoundTrip(msg);
  });

  test.each(commandEntries)("%s success response survives JSON and parses back unchanged", (type, c) => {
    const msg = { v: PROTOCOL_VERSION, id: crypto.randomUUID(), kind: "response", type, ok: true, result: c.result };
    expectRoundTrip(msg);
  });

  test.each(commandEntries)("%s error response survives JSON and parses back unchanged", (type) => {
    const msg = {
      v: PROTOCOL_VERSION,
      id: crypto.randomUUID(),
      kind: "response",
      type,
      ok: false,
      error: { code: "NETWORK", detail: "ECONNRESET" },
    };
    expectRoundTrip(msg);
  });

  test.each(eventEntries)("%s event survives JSON and parses back unchanged", (type, payload) => {
    const msg = { v: PROTOCOL_VERSION, id: crypto.randomUUID(), kind: "event", seq: 42, bootId: BOOT, type, payload };
    expectRoundTrip(msg);
  });

  test("an engine.events response that reports a gap parses", () => {
    expect(parseMessage(okResponse("engine.events", { gap: true })).ok).toBe(true);
  });
});

// ---------- envelope ----------

describe("envelope", () => {
  test.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "settings.get"],
    ["a number", 42],
    ["a boolean", true],
    ["an empty array", []],
    ["an array holding a valid command", [command("settings.get", {})]],
  ])("rejects %s", (_label, input) => {
    expect(reasonOf(input)).toContain("object");
  });

  test.each([0, PROTOCOL_VERSION - 1, PROTOCOL_VERSION + 1, "1", null, 1.0000001])("rejects protocol version %p", (v) => {
    expect(reasonOf({ ...command("settings.get", {}), v })).toMatch(/version/);
  });

  test("rejects a message without a protocol version", () => {
    const { v: _v, ...noVersion } = command("settings.get", {});
    expect(reasonOf(noVersion)).toMatch(/version/);
  });

  test("rejects an unknown kind", () => {
    expect(reasonOf({ ...command("settings.get", {}), kind: "notification" })).toContain("kind");
  });

  test("rejects an unknown command type", () => {
    expect(reasonOf(command("settings.delete", {}))).toContain("type");
  });

  test("rejects an unknown event type", () => {
    expect(reasonOf(event("job.paused", { jobId: "job-00000001" }))).toContain("type");
  });

  test("rejects an extra envelope field", () => {
    expect(reasonOf({ ...command("settings.get", {}), extra: 1 })).toContain("extra");
  });

  test("rejects a command without an id", () => {
    const { id: _id, ...noId } = command("settings.get", {});
    expect(reasonOf(noId)).toContain("id");
  });

  test.each(["MSG-00000001", "../../etc/passwd", "msg/00000001", "msg\\0000001", "msg.00000001", "short"])(
    "rejects the message id %p",
    (id) => {
      expect(reasonOf({ ...command("settings.get", {}), id })).toContain("id");
    },
  );

  test("rejects a command that carries a seq", () => {
    expect(reasonOf({ ...command("settings.get", {}), seq: 1 })).toContain("seq");
  });

  test("rejects an event without a bootId", () => {
    const { bootId: _b, ...noBoot } = event("engine.error", { error: { code: "INTERNAL" } });
    expect(reasonOf(noBoot)).toContain("bootId");
  });

  test.each(["BOOT-00000001", "../boot-0001", "boot"])("rejects the event bootId %p", (bootId) => {
    expect(reasonOf({ ...event("engine.error", { error: { code: "INTERNAL" } }), bootId })).toContain("bootId");
  });

  test("rejects a command that carries a bootId in its envelope", () => {
    expect(reasonOf({ ...command("settings.get", {}), bootId: BOOT })).toContain("bootId");
  });

  test("rejects an event without a seq", () => {
    const { seq: _seq, ...noSeq } = event("engine.error", { error: { code: "INTERNAL" } });
    expect(reasonOf(noSeq)).toContain("seq");
  });

  test.each([0, -1, 1.5, "1"])("rejects the event seq %p", (seq) => {
    expect(reasonOf(event("engine.error", { error: { code: "INTERNAL" } }, seq))).toContain("seq");
  });

  test("rejects a response that carries both a result and an error", () => {
    const msg = { ...okResponse("money.status", money), error: { code: "INTERNAL" } };
    expect(parseMessage(msg).ok).toBe(false);
  });
});

// ---------- payloads and results ----------

describe("payloads", () => {
  test("rejects an extra payload field", () => {
    expect(reasonOf(command("settings.get", { verbose: true }))).toContain("payload");
  });

  test("rejects a command without a payload", () => {
    const { payload: _p, ...noPayload } = command("settings.get", {});
    expect(reasonOf(noPayload)).toContain("payload");
  });

  test.each([
    ["a float", 12.5],
    ["a negative amount", -1],
    ["a dollar string", "10.00"],
  ])("rejects a budget given as %s", (_label, monthlyBudgetMicros) => {
    expect(reasonOf(command("settings.setBudget", { monthlyBudgetMicros }))).toContain("payload.monthlyBudgetMicros");
  });

  test("accepts a zero budget", () => {
    expect(parseMessage(command("settings.setBudget", { monthlyBudgetMicros: 0 })).ok).toBe(true);
  });

  test("rejects the old monthlyMicros budget name", () => {
    expect(reasonOf(command("settings.setBudget", { monthlyMicros: 0 }))).toContain("payload");
  });

  test.each([20, 36])("rejects a draft for age %p", (age) => {
    const payload = { traits: { ...traits, age }, acceptedWorstMicros: 230_000 };
    expect(reasonOf(command("avatars.createDraft", payload))).toContain("payload.traits.age");
  });

  test.each([21, 35])("accepts a draft for age %p", (age) => {
    const payload = { traits: { ...traits, age }, acceptedWorstMicros: 230_000 };
    expect(parseMessage(command("avatars.createDraft", payload)).ok).toBe(true);
  });

  test.each(["../avatar-0001", "avatars/avatar-0001", "Avatar-0001", "/etc/passwd"])(
    "rejects the avatar id %p",
    (avatarId) => {
      expect(reasonOf(command("avatars.archive", { avatarId }))).toContain("payload.avatarId");
    },
  );

  test("rejects a pick that still sends a language: on-video text is English only", () => {
    const payload = { avatarId: DRAFT_ID, photoId: "photo-0101", name: "Liza", language: "en" };
    expect(reasonOf(command("avatars.pick", payload))).toContain("language");
  });

  test("rejects a pick that still uses draftId and candidateId", () => {
    const payload = { draftId: DRAFT_ID, candidateId: "photo-0101", name: "Liza" };
    expect(parseMessage(command("avatars.pick", payload)).ok).toBe(false);
  });

  test("rejects a pick of a photo id with path characters", () => {
    const payload = { avatarId: DRAFT_ID, photoId: "../photo-0101", name: "Liza" };
    expect(reasonOf(command("avatars.pick", payload))).toContain("payload.photoId");
  });

  test("rejects an engine.events request without the caller's bootId", () => {
    expect(reasonOf(command("engine.events", { afterSeq: 6 }))).toContain("payload.bootId");
  });

  test("rejects an engine.events request with a malformed bootId", () => {
    expect(reasonOf(command("engine.events", { afterSeq: 6, bootId: "Boot/1" }))).toContain("payload.bootId");
  });

  test("rejects an engine.events request for a negative seq", () => {
    expect(reasonOf(command("engine.events", { afterSeq: -1 }))).toContain("payload.afterSeq");
  });

  test("avatars.estimateCandidates prices an existing draft by its id, never by traits", () => {
    expect(reasonOf(command("avatars.estimateCandidates", { traits }))).toContain("payload");
  });

  test("rejects avatars.estimateCandidates for an avatar id with path characters", () => {
    expect(reasonOf(command("avatars.estimateCandidates", { avatarId: "../avatar-0002" }))).toContain("payload.avatarId");
  });
});

describe("results", () => {
  test("a settings.setApiKey response cannot contain the key", () => {
    const result = { ...keyStatus, key: API_KEY };
    expect(reasonOf(okResponse("settings.setApiKey", result))).toContain("key");
  });

  test("a settings.get response cannot smuggle the key inside apiKey", () => {
    const result = { ...settings, apiKey: { ...keyStatus, key: API_KEY } };
    expect(parseMessage(okResponse("settings.get", result)).ok).toBe(false);
  });

  test("a settings.setMusicKey response cannot contain the key", () => {
    const result = { ...musicKeyStatus, key: MUSIC_KEY };
    expect(reasonOf(okResponse("settings.setMusicKey", result))).toContain("key");
  });

  test("a settings.get response cannot smuggle the key inside musicKey", () => {
    const result = { ...settings, musicKey: { ...musicKeyStatus, key: MUSIC_KEY } };
    expect(parseMessage(okResponse("settings.get", result)).ok).toBe(false);
  });

  test("a response whose result belongs to another command is rejected", () => {
    expect(reasonOf(okResponse("settings.setApiKey", settings))).toContain("result");
  });

  test("an error response with an unknown code is rejected", () => {
    const msg = { v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type: "money.status", ok: false, error: { code: "E_TOO_BAD" } };
    expect(reasonOf(msg)).toContain("error.code");
  });

  test("an error response for an unknown command type is rejected", () => {
    const msg = { v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type: "money.spend", ok: false, error: { code: "INTERNAL" } };
    expect(reasonOf(msg)).toContain("type");
  });

  test("an error response whose detail carries the key arrives with the key stripped", () => {
    const msg = {
      v: PROTOCOL_VERSION,
      id: "msg-00000001",
      kind: "response",
      type: "settings.setApiKey",
      ok: false,
      error: { code: "AUTH_INVALID", detail: `refused ${API_KEY}` },
    };
    const r = parseMessage(msg);
    expect(r.ok).toBe(true);
    expect(JSON.stringify(r)).not.toContain(API_KEY);
  });

  test("an engine.snapshot response without the engine's bootId is rejected", () => {
    const result = { lastSeq: 7, settings, money, avatars: [avatar], drafts: [draft], jobs: [job] };
    expect(reasonOf(okResponse("engine.snapshot", result))).toContain("result.bootId");
  });

  test("an engine.snapshot response without drafts is rejected", () => {
    const result = { bootId: BOOT, lastSeq: 7, settings, money, avatars: [avatar], unreadableAvatars: [], jobs: [job], notices: [] };
    expect(reasonOf(okResponse("engine.snapshot", result))).toContain("result.drafts");
  });

  test("an engine.snapshot response without the avatars it could not read is rejected", () => {
    const result = { bootId: BOOT, lastSeq: 7, settings, money, avatars: [avatar], drafts: [draft], jobs: [job], notices: [] };
    expect(reasonOf(okResponse("engine.snapshot", result))).toContain("result.unreadableAvatars");
  });

  test.each([0, -1, {}, [{ avatarId: "avatar-0009", reason: "descriptor-invalid", detail: "its stored descriptor no longer fits today's rules" }, "not-an-entry"]])(
    "rejects an avatars.list answer whose unreadableAvatars is %p, not a list of entries",
    (unreadableAvatars) => {
      expect(reasonOf(okResponse("avatars.list", { avatars: [avatar], unreadableAvatars }))).toContain("result.unreadableAvatars");
    },
  );

  test("rejects an unreadable-avatar entry whose reason is unknown, and one missing its detail", () => {
    expect(reasonOf(okResponse("avatars.list", { avatars: [], unreadableAvatars: [{ avatarId: null, reason: "no-such-reason", detail: "x" }] }))).toContain(
      "unreadableAvatars",
    );
    expect(reasonOf(okResponse("avatars.list", { avatars: [], unreadableAvatars: [{ avatarId: "avatar-0009", reason: "descriptor-invalid" }] }))).toContain(
      "unreadableAvatars",
    );
  });

  test("rejects an unreadable-avatar entry whose detail is not one of the fixed sentences (L4): it can never echo the descriptor or the vibe", () => {
    expect(
      reasonOf(
        okResponse("avatars.list", {
          avatars: [],
          unreadableAvatars: [{ avatarId: "avatar-0009", reason: "descriptor-invalid", detail: "a young woman with hazel eyes" }],
        }),
      ),
    ).toContain("unreadableAvatars");
  });

  test("an unreadable-avatar entry's avatarId may be null: it is not always recoverable", () => {
    const result = { avatars: [], unreadableAvatars: [{ avatarId: null, name: null, reason: "manifest-unreadable", detail: "its manifest file could not be read or parsed" }], unreadableTotal: 1 };
    expect(parseMessage(okResponse("avatars.list", result)).ok).toBe(true);
  });

  test("the unreadable-avatars list is bounded at MAX_UNREADABLE_AVATARS", () => {
    const entry = { avatarId: null, name: null, reason: "manifest-unreadable" as const, detail: "its manifest file could not be read or parsed" };
    const atLimit = { avatars: [], unreadableAvatars: Array.from({ length: MAX_UNREADABLE_AVATARS }, () => entry), unreadableTotal: MAX_UNREADABLE_AVATARS };
    const overLimit = { avatars: [], unreadableAvatars: Array.from({ length: MAX_UNREADABLE_AVATARS + 1 }, () => entry), unreadableTotal: MAX_UNREADABLE_AVATARS + 1 };
    expect(parseMessage(okResponse("avatars.list", atLimit)).ok).toBe(true);
    expect(reasonOf(okResponse("avatars.list", overLimit))).toContain("result.unreadableAvatars");
  });

  test("unreadableTotal (L1) may exceed the list's own length: the list is cut, the total is not", () => {
    const entry = { avatarId: null, name: null, reason: "manifest-unreadable" as const, detail: "its manifest file could not be read or parsed" };
    const result = { avatars: [], unreadableAvatars: [entry], unreadableTotal: MAX_UNREADABLE_AVATARS + 40 };
    expect(parseMessage(okResponse("avatars.list", result)).ok).toBe(true);
  });

  test("rejects a negative or fractional unreadableTotal", () => {
    expect(reasonOf(okResponse("avatars.list", { avatars: [], unreadableAvatars: [], unreadableTotal: -1 }))).toContain("result.unreadableTotal");
    expect(reasonOf(okResponse("avatars.list", { avatars: [], unreadableAvatars: [], unreadableTotal: 1.5 }))).toContain("result.unreadableTotal");
  });

  test("an engine.snapshot response without the pending notices is rejected", () => {
    const result = { bootId: BOOT, lastSeq: 7, settings, money, avatars: [avatar], drafts: [draft], unreadableAvatars: [], jobs: [job] };
    expect(reasonOf(okResponse("engine.snapshot", result))).toContain("result.notices");
  });

  test("an engine.snapshot response that repeats a notice is rejected", () => {
    const result = { bootId: BOOT, lastSeq: 7, settings, money, avatars: [], drafts: [], unreadableAvatars: [], jobs: [], notices: [notice, notice] };
    expect(reasonOf(okResponse("engine.snapshot", result))).toContain("result.notices");
  });

  test("a snapshot restores a finished candidates job with its result", () => {
    const done = { ...job, status: "done", done: 4, result: eventCases["job.done"].result };
    const result = { bootId: BOOT, lastSeq: 7, settings, money, avatars: [], drafts: [draft], unreadableAvatars: [], unreadableTotal: 0, jobs: [done], librarySwitchGeneration: 0, exportStatus: { status: "ok" }, notices: [] };
    expect(parseMessage(okResponse("engine.snapshot", result)).ok).toBe(true);
  });

  test("a snapshot taken while the ledger cannot be read still parses, with the cause and no amounts", () => {
    const unavailable = {
      ledger: "unavailable",
      month: "2026-09",
      monthlyBudgetMicros: 10_000_000,
      reconcileNeeded: false,
      reconcileReasons: [],
      halt: { cause: "LEDGER_CORRUPT", detail: "ledger.jsonl:3 is not valid JSON" },
    };
    const result = { bootId: BOOT, lastSeq: 0, settings, money: unavailable, avatars: [], drafts: [], unreadableAvatars: [], unreadableTotal: 0, jobs: [], librarySwitchGeneration: 0, exportStatus: { status: "ok" }, notices: [] };
    expect(parseMessage(okResponse("engine.snapshot", result)).ok).toBe(true);
  });

  test("engine.events rejects events out of seq order", () => {
    const later = { ...progressEvent, id: "evt-00000008", seq: 8 };
    const result = { gap: false, events: [later, progressEvent] };
    expect(reasonOf(okResponse("engine.events", result))).toContain("result.events");
  });

  test("engine.events rejects a repeated seq", () => {
    const result = { gap: false, events: [progressEvent, { ...progressEvent, id: "evt-00000099" }] };
    expect(parseMessage(okResponse("engine.events", result)).ok).toBe(false);
  });
});

describe("events", () => {
  test("rejects progress past the total", () => {
    expect(reasonOf(event("job.progress", { kind: "avatar.candidates", jobId: "job-00000001", avatarId: DRAFT_ID, done: 5, total: 4 }))).toContain("payload.done");
  });

  // The renderer must not have to guess a job's avatar (store.ts's job.progress
  // handler reads it straight off the event) — so it is required, not optional.
  test("rejects job.progress without an avatarId", () => {
    expect(reasonOf(event("job.progress", { kind: "avatar.candidates", jobId: "job-00000001", done: 1, total: 4 }))).toContain("avatarId");
  });

  test("rejects more than four candidates in one job", () => {
    const five = ["photo-0101", "photo-0102", "photo-0103", "photo-0104", "photo-0105"].map((photoId) => ({
      avatarId: DRAFT_ID,
      photoId,
    }));
    const payload = {
      jobId: "job-00000001",
      result: { kind: "avatar.candidates", avatarId: DRAFT_ID, candidates: five, rejectedByAgeCheck: 0, failedSlots: [] },
    };
    expect(reasonOf(event("job.done", payload))).toContain("payload.result.candidates");
  });

  test("rejects a candidate without the photo id the UI needs for studio-media://", () => {
    const payload = {
      jobId: "job-00000001",
      result: { kind: "avatar.candidates", avatarId: DRAFT_ID, candidates: [{ avatarId: DRAFT_ID }], rejectedByAgeCheck: 0, failedSlots: [] },
    };
    expect(reasonOf(event("job.done", payload))).toContain("photoId");
  });

  test("rejects a float amount in money.reconcileNeeded", () => {
    const payload = { reasons: ["open-reserves"], unsettledMicros: 0.055 };
    expect(reasonOf(event("money.reconcileNeeded", payload))).toContain("payload.unsettledMicros");
  });

  test("rejects money.reconcileNeeded without any reason", () => {
    const payload = { reasons: [], unsettledMicros: 55_000 };
    expect(reasonOf(event("money.reconcileNeeded", payload))).toContain("payload.reasons");
  });

  test("accepts money.reconcileNeeded with both reasons", () => {
    const payload = { reasons: ["open-reserves", "torn-ledger-line"], unsettledMicros: 55_000 };
    expect(parseMessage(event("money.reconcileNeeded", payload)).ok).toBe(true);
  });

  test("settings.changed cannot carry the key itself", () => {
    const payload = { settings: { ...settings, apiKey: { ...keyStatus, key: API_KEY } } };
    expect(reasonOf(event("settings.changed", payload))).toContain("payload.settings.apiKey");
  });

  test("settings.changed carries the whole settings, not a patch", () => {
    expect(reasonOf(event("settings.changed", { settings: { apiKey: keyStatus } }))).toContain("payload.settings");
  });

  test("avatar.changed rejects a draft: drafts change through draft.changed", () => {
    expect(reasonOf(event("avatar.changed", { avatar: { ...avatar, status: "draft" } }))).toContain("payload.avatar.status");
  });

  test("draft.changed rejects a candidate of another avatar", () => {
    const stray = { ...draft, candidates: [{ avatarId: "avatar-0009", photoId: "photo-0101" }] };
    expect(reasonOf(event("draft.changed", { draft: stray }))).toContain("payload.draft.candidates");
  });

  test("engine.notice rejects an error code as the notice code: a notice is not a generic error", () => {
    expect(reasonOf(event("engine.notice", { notice: { ...notice, code: "INTERNAL" } }))).toContain("payload.notice.code");
  });

  test("rejects job.cancelled without the job id", () => {
    expect(reasonOf(event("job.cancelled", { kind: "avatar.candidates", avatarId: DRAFT_ID }))).toContain("payload.jobId");
  });

  // Job events say whose job they are (owner-facing gap: a run that failed before its first progress
  // was invisible in every other window, and the renderer guessed kind, run and avatar).
  test.each(["job.progress", "job.failed", "job.cancelled"] as const)("%s rejects a payload without a kind", (type) => {
    const base = { jobId: "job-00000001", avatarId: DRAFT_ID, done: 1, total: 4, error: { code: "INTERNAL" } };
    const payload = type === "job.progress" ? { jobId: base.jobId, avatarId: base.avatarId, done: 1, total: 4 } : type === "job.failed" ? { jobId: base.jobId, avatarId: base.avatarId, error: base.error } : { jobId: base.jobId, avatarId: base.avatarId };
    expect(reasonOf(event(type, payload))).toContain("kind");
  });

  test.each(["job.progress", "job.failed", "job.cancelled"] as const)("%s of a run rejects a payload without its runId", (type) => {
    const payload =
      type === "job.progress"
        ? { kind: "run", jobId: "job-00000002", avatarId: "avatar-0001", done: 1, total: 4 }
        : type === "job.failed"
          ? { kind: "run", jobId: "job-00000002", avatarId: "avatar-0001", error: { code: "INTERNAL" } }
          : { kind: "run", jobId: "job-00000002", avatarId: "avatar-0001" };
    expect(reasonOf(event(type, payload))).toContain("runId");
  });
});

// ---------- robustness ----------

describe("parseMessage never throws", () => {
  test("on an otherwise valid command whose payload getter throws", () => {
    const hostile = {
      v: PROTOCOL_VERSION,
      id: "msg-00000001",
      kind: "command",
      type: "settings.get",
      get payload(): object {
        throw new Error("boom");
      },
    };
    expect(parseMessage(hostile).ok).toBe(false);
  });

  test("on a proxy whose every trap throws", () => {
    const trap = () => {
      throw new Error("trap");
    };
    const hostile = new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap, getPrototypeOf: trap });
    expect(parseMessage(hostile).ok).toBe(false);
  });

  test.each([10n, Symbol("x"), () => 1])("on the exotic value %p", (input) => {
    expect(parseMessage(input).ok).toBe(false);
  });
});

describe("rejection reasons", () => {
  test("never echo a submitted API key", () => {
    const badKey = "sk-or-v1-secret with-a-space";
    const reason = reasonOf(command("settings.setApiKey", { key: badKey }));
    expect(reason).toContain("payload.key");
    expect(reason).not.toContain("secret");
  });

  test("never echo a submitted music key", () => {
    const reason = reasonOf(command("settings.setMusicKey", { key: "Zq7-vKt9 Wm2x-Lp4s-0000" }));
    expect(reason).toContain("payload.key");
    expect(reason).not.toContain("Wm2x");
  });

  test("strip a field name that looks like a key", () => {
    const reason = reasonOf(command("settings.get", { "sk-or-v1-deadbeefcafebabe": 1 }));
    expect(reason).not.toContain("deadbeefcafebabe");
  });

  test("stay within the 500-char error detail limit", () => {
    const payload = Object.fromEntries(Array.from({ length: 1000 }, (_, i) => [`field${i}`, i]));
    const reason = reasonOf(command("settings.get", payload));
    expect(reason.length).toBeGreaterThan(0);
    expect(reason.length).toBeLessThanOrEqual(500);
  });
});

// ---------- estimate before spend ----------

describe("estimate before spend", () => {
  test("avatars.estimate needs only the traits and answers expected and worst case", () => {
    expect(parseMessage(okResponse("avatars.estimate", estimate)).ok).toBe(true);
  });

  test("avatars.estimate rejects an expected cost above the worst case", () => {
    const result = { ...estimate, expectedMicros: estimate.worstMicros + 1 };
    expect(parseMessage(okResponse("avatars.estimate", result)).ok).toBe(false);
  });

  test("avatars.createDraft is refused without the worst case the user accepted", () => {
    expect(reasonOf(command("avatars.createDraft", { traits }))).toContain("payload.acceptedWorstMicros");
  });

  test("avatars.generateCandidates is refused without the worst case the user accepted", () => {
    expect(reasonOf(command("avatars.generateCandidates", { avatarId: DRAFT_ID }))).toContain(
      "payload.acceptedWorstMicros",
    );
  });

  test.each([0.23, -1, "230000"])("rejects an accepted worst case of %p", (acceptedWorstMicros) => {
    const payload = { avatarId: DRAFT_ID, acceptedWorstMicros };
    expect(reasonOf(command("avatars.generateCandidates", payload))).toContain("payload.acceptedWorstMicros");
  });

  test("runs.start is refused without the worst case the user accepted", () => {
    expect(reasonOf(command("runs.start", runRequest))).toContain("payload.acceptedWorstMicros");
  });

  test("runs.resume is refused without the remaining worst case the user accepted", () => {
    expect(reasonOf(command("runs.resume", { runId: "run-00000001" }))).toContain("payload.acceptedWorstMicros");
  });

  test("avatars.generateCandidates no longer answers with an estimate after spending started", () => {
    const result = { jobId: "job-00000001", estimate };
    expect(parseMessage(okResponse("avatars.generateCandidates", result)).ok).toBe(false);
  });

  test("a PRICE_CHANGED refusal parses as an error response", () => {
    const msg = { v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type: "avatars.createDraft", ok: false, error: { code: "PRICE_CHANGED" } };
    expect(parseMessage(msg).ok).toBe(true);
  });
});

// ---------- answering what could not be parsed ----------

describe("error responses for unparseable commands", () => {
  const validation = { code: "VALIDATION" as const, detail: "type: unknown command" };

  test("an error response may carry a null type", () => {
    const msg = { v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type: null, ok: false, error: validation };
    expect(parseMessage(msg).ok).toBe(true);
  });

  test("an error response may carry a null id", () => {
    const msg = { v: PROTOCOL_VERSION, id: null, kind: "response", type: null, ok: false, error: validation };
    expect(parseMessage(msg).ok).toBe(true);
  });

  test("a success response may not carry a null type", () => {
    expect(parseMessage(okResponse("money.status", money)).ok).toBe(true);
    expect(parseMessage({ ...okResponse("money.status", money), type: null }).ok).toBe(false);
  });

  test("errorResponseFor keeps the command's id when only the type is unknown", () => {
    const input = command("settings.delete", {});
    expect(errorResponseFor(input, validation)).toEqual({
      v: PROTOCOL_VERSION,
      id: "msg-00000001",
      kind: "response",
      type: null,
      ok: false,
      error: validation,
    });
  });

  test("errorResponseFor keeps a known type", () => {
    const input = command("settings.setBudget", { monthlyBudgetMicros: 1.5 });
    const r = errorResponseFor(input, validation);
    expect([r.id, r.type]).toEqual(["msg-00000001", "settings.setBudget"]);
  });

  test("errorResponseFor drops an id that fails the id rule", () => {
    const r = errorResponseFor({ ...command("settings.get", {}), id: "../../x" }, validation);
    expect(r.id).toBeNull();
  });

  test.each([
    ["null", null],
    ["a string", "junk"],
    ["an array", [1, 2]],
  ])("errorResponseFor answers %s with a null id and type", (_label, input) => {
    const r = errorResponseFor(input, validation);
    expect([r.id, r.type]).toEqual([null, null]);
  });

  test("errorResponseFor never throws on a hostile input", () => {
    const trap = () => {
      throw new Error("trap");
    };
    const hostile = new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
    const r = errorResponseFor(hostile, validation);
    expect([r.id, r.type]).toEqual([null, null]);
  });

  test("what errorResponseFor builds is itself a valid message", () => {
    const r = errorResponseFor(command("settings.delete", {}), validation);
    expect(parseMessage(r).ok).toBe(true);
  });
});

// ---------- the engine's own parser ----------

describe("parseEngineCommand", () => {
  test("accepts an engine command", () => {
    const r = parseEngineCommand(command("money.status", {}));
    expect(r.ok).toBe(true);
  });

  test.each(["settings.setApiKey", "settings.clearApiKey"])("rejects the main-only command %s", (type) => {
    const payload = type === "settings.setApiKey" ? { key: API_KEY } : {};
    const r = parseEngineCommand(command(type, payload));
    expect(r.ok ? "" : r.reason).toContain("type");
  });

  test.each(["settings.setMusicKey", "settings.clearMusicKey"])("rejects the main-only command %s", (type) => {
    const payload = type === "settings.setMusicKey" ? { key: MUSIC_KEY } : {};
    const r = parseEngineCommand(command(type, payload));
    expect(r.ok ? "" : r.reason).toContain("type");
  });

  test("never echoes a music key sent to the engine by mistake", () => {
    const r = parseEngineCommand(command("settings.setMusicKey", { key: MUSIC_KEY }));
    expect(JSON.stringify(r)).not.toContain(MUSIC_KEY);
  });

  test("never echoes a key sent to the engine by mistake", () => {
    const r = parseEngineCommand(command("settings.setApiKey", { key: API_KEY }));
    expect(JSON.stringify(r)).not.toContain(API_KEY);
  });

  test("rejects a response: the engine only takes commands", () => {
    expect(parseEngineCommand(okResponse("money.status", money)).ok).toBe(false);
  });

  test("rejects an event: the engine only takes commands", () => {
    expect(parseEngineCommand(event("engine.error", { error: { code: "INTERNAL" } })).ok).toBe(false);
  });

  test("rejects an unknown protocol version", () => {
    const r = parseEngineCommand({ ...command("money.status", {}), v: PROTOCOL_VERSION + 1 });
    expect(r.ok ? "" : r.reason).toMatch(/version/);
  });

  test("never throws on a hostile input", () => {
    const trap = () => {
      throw new Error("trap");
    };
    const hostile = new Proxy({}, { get: trap, has: trap, ownKeys: trap, getOwnPropertyDescriptor: trap });
    expect(parseEngineCommand(hostile).ok).toBe(false);
  });
});

// ---------- Stage 3: videos, photos.setRejected, montages.create ----------

describe("Stage 3 payloads", () => {
  const send = (type: string, payload: unknown) => parseMessage(command(type, payload)).ok;

  test("videos.render takes a saved montage", () => {
    expect(send("videos.render", { montageId: "montage-00000001" })).toBe(true);
  });

  test("videos.render takes a spec, for a headless caller", () => {
    expect(send("videos.render", { spec: montageDraft })).toBe(true);
  });

  test("videos.render refuses a montage and a spec together", () => {
    expect(send("videos.render", { montageId: "montage-00000001", spec: montageDraft })).toBe(false);
  });

  test("videos.render refuses neither", () => {
    expect(send("videos.render", {})).toBe(false);
  });

  test("videos.render lets a structurally invalid spec through, so the engine answers MONTAGE_INVALID with its issues", () => {
    const tooShort = { ...montageDraft, clips: [{ ...montageDraft.clips[0], durationMs: 3_900 }] };
    expect(send("videos.render", { spec: tooShort })).toBe(true);
    expect(send("videos.render", { spec: emptyDraft })).toBe(true);
  });

  test("videos.render refuses a spec whose shape is broken", () => {
    const broken = { ...montageDraft, clips: [{ ...montageDraft.clips[0], durationMs: 3_950 }] };
    expect(send("videos.render", { spec: broken })).toBe(false);
    expect(send("videos.render", { spec: { ...montageDraft, title: "x" } })).toBe(false);
  });

  test("videos.render refuses a montageId that breaks the id pattern", () => {
    expect(send("videos.render", { montageId: "../montage" })).toBe(false);
  });

  test("videos.cancel, videos.delete and videos.reveal each name one id", () => {
    expect(send("videos.cancel", { jobId: "job-00000004" })).toBe(true);
    expect(send("videos.delete", { videoId: "video-00000001", mode: "video" })).toBe(true);
    expect(send("videos.delete", { videoId: "video-00000001", mode: "record" })).toBe(true);
    expect(send("videos.reveal", { videoId: "video-00000001" })).toBe(true);
    expect(send("videos.delete", {})).toBe(false);
    // the owner's intent is part of the request: «Удалить» (the file too) or «Удалить запись» (never the file)
    expect(send("videos.delete", { videoId: "video-00000001" })).toBe(false);
    expect(send("videos.delete", { videoId: "video-00000001", mode: "everything" })).toBe(false);
    expect(send("videos.reveal", { videoId: "video-00000001", path: "/tmp" })).toBe(false);
  });

  test("settings.setExportPath is sent with no payload: the folder is picked in main's own dialog, never named by the window (K18)", () => {
    expect(send("settings.setExportPath", {})).toBe(true);
    expect(send("settings.setExportPath", { path: "/Volumes/Reels" })).toBe(false);
  });

  test("settings.setExportPath answers either a cancel or the picked folder with its counts", () => {
    const ok = (result: unknown) => parseMessage({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type: "settings.setExportPath", ok: true, result }).ok;
    expect(ok({ picked: false })).toBe(true);
    expect(ok({ picked: true, settings, rootId: "root-00000001", resolved: 0, elsewhere: 0, incomplete: true })).toBe(true);
    // a cancel carries nothing else, and a pick carries every part of the answer
    expect(ok({ picked: false, resolved: 0 })).toBe(false);
    expect(ok({ picked: true, settings, rootId: "root-00000001", resolved: 3, incomplete: false })).toBe(false);
    // the counts say whether they are whole: a pick that does not say is refused
    expect(ok({ picked: true, settings, rootId: "root-00000001", resolved: 3, elsewhere: 0 })).toBe(false);
    expect(ok({ picked: true, settings, rootId: "root-00000001", resolved: -1, elsewhere: 0, incomplete: false })).toBe(false);
    expect(ok({ picked: true, settings, rootId: "../root", resolved: 0, elsewhere: 0, incomplete: false })).toBe(false);
  });

  test("settings.exportDisplay and export.check take no payload", () => {
    expect(send("settings.exportDisplay", {})).toBe(true);
    expect(send("settings.exportDisplay", { path: "/tmp" })).toBe(false);
    expect(send("export.check", {})).toBe(true);
    expect(send("export.check", { force: true })).toBe(false);
  });

  test("videos.list names an avatar", () => {
    expect(send("videos.list", { avatarId: "avatar-0001" })).toBe(true);
    expect(send("videos.list", {})).toBe(false);
  });

  test("photos.setRejected names the avatar, the photo and the mark to set", () => {
    expect(send("photos.setRejected", { avatarId: "avatar-0001", photoId: "photo-0003", rejected: false })).toBe(true);
    expect(send("photos.setRejected", { avatarId: "avatar-0001", photoId: "photo-0003" })).toBe(false);
    expect(send("photos.setRejected", { avatarId: "avatar-0001", photoId: "photo-0003", rejected: "yes" })).toBe(false);
  });
});

describe("montages.create", () => {
  const photoIds = (n: number) => Array.from({ length: n }, (_, k) => `photo-${String(k + 1).padStart(4, "0")}`);
  const send = (payload: unknown) => parseMessage(command("montages.create", payload)).ok;

  test("with no photo it creates an empty draft: «Новый монтаж»", () => {
    expect(send({ avatarId: "avatar-0001", photoIds: [] })).toBe(true);
  });

  test("1 photo is accepted", () => {
    expect(send({ avatarId: "avatar-0001", photoIds: photoIds(1) })).toBe(true);
  });

  test("20 photos are accepted: the clip cap", () => {
    expect(send({ avatarId: "avatar-0001", photoIds: photoIds(20) })).toBe(true);
  });

  test("21 photos are refused", () => {
    expect(send({ avatarId: "avatar-0001", photoIds: photoIds(21) })).toBe(false);
  });

  test("the same photo twice is refused: a scene photo appears once per montage", () => {
    expect(send({ avatarId: "avatar-0001", photoIds: ["photo-0001", "photo-0001"] })).toBe(false);
  });

  test("a photo id that breaks the id pattern is refused", () => {
    expect(send({ avatarId: "avatar-0001", photoIds: ["../photo"] })).toBe(false);
  });

  test("a missing photoIds is refused: an empty list is the way to ask for an empty draft", () => {
    expect(send({ avatarId: "avatar-0001" })).toBe(false);
  });

  test("its result carries a draft that may have no clips", () => {
    const empty = { montage: { montageId: "montage-00000001", name: "Новый монтаж", spec: emptyDraft, updatedAt: "2026-09-29T12:00:00.000Z" } };
    expect(parseMessage(okResponse("montages.create", empty)).ok).toBe(true);
  });

  test("its result refuses a draft that breaks the draft's structure", () => {
    const twice = { ...montageDraft, clips: [...montageDraft.clips, { ...montageDraft.clips[0], clipId: "clip-0002" }] };
    const result = { montage: { montageId: "montage-00000001", name: "Монтаж", spec: twice, updatedAt: "2026-09-29T12:00:00.000Z" } };
    expect(parseMessage(okResponse("montages.create", result)).ok).toBe(false);
  });

  test("its result refuses an empty name", () => {
    const result = { montage: { montageId: "montage-00000001", name: "", spec: emptyDraft, updatedAt: "2026-09-29T12:00:00.000Z" } };
    expect(parseMessage(okResponse("montages.create", result)).ok).toBe(false);
  });
});

describe("montages.get, list, save, delete, focus", () => {
  const stored = { montageId: "montage-00000001", name: null, spec: montageDraft, updatedAt: "2026-09-29T12:00:00.000Z" };
  const issues = (n: number) => Array.from({ length: n }, () => ({ code: "photo-unavailable", path: ["clips", 0, "cell"] }));
  const send = (type: string, payload: unknown) => parseMessage(command(type, payload)).ok;
  const answer = (type: string, result: unknown) => parseMessage(okResponse(type, result)).ok;

  test("get takes a montage id and refuses a broken one", () => {
    expect(send("montages.get", { montageId: "montage-00000001" })).toBe(true);
    expect(send("montages.get", { montageId: "../montage" })).toBe(false);
    expect(send("montages.get", {})).toBe(false);
  });

  test("get answers the draft and at most 64 issues", () => {
    expect(answer("montages.get", { montage: stored, issues: issues(64) })).toBe(true);
    expect(answer("montages.get", { montage: stored, issues: issues(65) })).toBe(false);
  });

  test("get's answer carries its issues even when there are none", () => {
    expect(answer("montages.get", { montage: stored, issues: [] })).toBe(true);
    expect(answer("montages.get", { montage: stored })).toBe(false);
  });

  test("list takes an optional avatar: no avatar means every avatar", () => {
    expect(send("montages.list", {})).toBe(true);
    expect(send("montages.list", { avatarId: "avatar-0001" })).toBe(true);
    expect(send("montages.list", { avatarId: "../avatar" })).toBe(false);
  });

  test("list answers at most 200 drafts, with the real total beside them", () => {
    const item = { montage: stored, issues: [], videoCount: 0 };
    expect(answer("montages.list", { items: Array.from({ length: 200 }, () => item), total: 250, skippedTotal: 0 })).toBe(true);
    expect(answer("montages.list", { items: Array.from({ length: 201 }, () => item), total: 201, skippedTotal: 0 })).toBe(false);
  });

  test("list counts the draft files it could not read", () => {
    expect(answer("montages.list", { items: [], total: 0, skippedTotal: 3 })).toBe(true);
    expect(answer("montages.list", { items: [], total: 0, skippedTotal: -1 })).toBe(false);
  });

  test("save takes a draft that may be incomplete, and a name or null", () => {
    expect(send("montages.save", { montageId: "montage-00000001", spec: emptyDraft, name: null })).toBe(true);
    expect(send("montages.save", { montageId: "montage-00000001", spec: montageDraft, name: "Кафе" })).toBe(true);
  });

  test("save refuses an empty name: null is the way to clear it", () => {
    expect(send("montages.save", { montageId: "montage-00000001", spec: montageDraft, name: "" })).toBe(false);
  });

  test("save refuses a spec that breaks the draft's structure", () => {
    const twice = { ...montageDraft, clips: [...montageDraft.clips, { ...montageDraft.clips[0], clipId: "clip-0002" }] };
    expect(send("montages.save", { montageId: "montage-00000001", spec: twice, name: null })).toBe(false);
  });

  test("save needs every field", () => {
    expect(send("montages.save", { montageId: "montage-00000001", spec: montageDraft })).toBe(false);
    expect(send("montages.save", { montageId: "montage-00000001", name: null })).toBe(false);
  });

  test("delete answers the id it removed", () => {
    expect(send("montages.delete", { montageId: "montage-00000001" })).toBe(true);
    expect(answer("montages.delete", { montageId: "montage-00000001" })).toBe(true);
  });

  test("focus takes an avatar and a photo reference, and answers a point or null", () => {
    expect(send("montages.focus", { avatarId: "avatar-0001", photo: { source: "scene", photoId: "photo-0002" } })).toBe(true);
    expect(send("montages.focus", { avatarId: "avatar-0001", photo: { source: "own", mediaId: "media-0002" } })).toBe(true);
    expect(answer("montages.focus", { focus: null })).toBe(true);
    expect(answer("montages.focus", { focus: { x: 1, y: 0 } })).toBe(true);
    expect(answer("montages.focus", { focus: { x: 1.1, y: 0 } })).toBe(false);
  });

  test("focus refuses a bare photo id: the source says which store it is from", () => {
    expect(send("montages.focus", { avatarId: "avatar-0001", photo: "photo-0002" })).toBe(false);
    expect(send("montages.focus", { photo: { source: "scene", photoId: "photo-0002" } })).toBe(false);
  });

  const textLayer = { kind: "text", layerId: "layer-00000001", startMs: 0, endMs: 3000, value: "sunday reset", font: "manrope", style: "plaque", color: "#ffffff", x: 0.5, y: 0.195, scale: 1 };

  test("textPreview takes an avatar and a whole text layer, and answers an id and the raster size", () => {
    expect(send("montages.textPreview", { avatarId: "avatar-0001", layer: textLayer })).toBe(true);
    expect(answer("montages.textPreview", { previewId: "preview-00000001", width: 640, height: 130 })).toBe(true);
  });

  test("textPreview refuses a sticker layer, a caption over the contract's limits and a colour that is not lowercase #rrggbb", () => {
    expect(send("montages.textPreview", { avatarId: "avatar-0001", layer: { ...textLayer, kind: "sticker" } })).toBe(false);
    expect(send("montages.textPreview", { avatarId: "avatar-0001", layer: { ...textLayer, value: "x".repeat(61) } })).toBe(false);
    expect(send("montages.textPreview", { avatarId: "avatar-0001", layer: { ...textLayer, color: "#FFFFFF" } })).toBe(false);
    expect(send("montages.textPreview", { avatarId: "avatar-0001", layer: { ...textLayer, scale: 2.5 } })).toBe(false);
  });

  test("textPreview needs the avatar and the layer", () => {
    expect(send("montages.textPreview", { layer: textLayer })).toBe(false);
    expect(send("montages.textPreview", { avatarId: "avatar-0001" })).toBe(false);
  });

  test("textPreview answers a whole positive raster size and an id, nothing else", () => {
    expect(answer("montages.textPreview", { previewId: "preview-00000001", width: 0, height: 130 })).toBe(false);
    expect(answer("montages.textPreview", { previewId: "preview-00000001", width: 640.5, height: 130 })).toBe(false);
    expect(answer("montages.textPreview", { previewId: "../etc", width: 640, height: 130 })).toBe(false);
    expect(answer("montages.textPreview", { previewId: "preview-00000001", width: 640, height: 130, path: "/tmp/x.png" })).toBe(false);
  });

  test("create answers a draft with no name", () => {
    expect(answer("montages.create", { montage: { ...stored, name: null } })).toBe(true);
  });

  test("montage.changed says a draft was saved, or that it is gone", () => {
    expect(parseMessage(event("montage.changed", { change: "upserted", montage: stored })).ok).toBe(true);
    expect(parseMessage(event("montage.changed", { change: "removed", montageId: "montage-00000001", avatarId: "avatar-0001" })).ok).toBe(true);
  });

  test("montage.changed refuses an upsert without its draft, a removal without its avatar and a change it does not know", () => {
    expect(parseMessage(event("montage.changed", { change: "upserted" })).ok).toBe(false);
    expect(parseMessage(event("montage.changed", { change: "removed", montageId: "montage-00000001" })).ok).toBe(false);
    expect(parseMessage(event("montage.changed", { change: "renamed", montage: stored })).ok).toBe(false);
  });

  test("export.status carries the folder's status, and nothing else", () => {
    expect(parseMessage(event("export.status", { exportStatus: { status: "ok" } })).ok).toBe(true);
    expect(parseMessage(event("export.status", { exportStatus: { status: "unavailable", reason: "not-writable" } })).ok).toBe(true);
    expect(parseMessage(event("export.status", { exportStatus: { status: "unavailable" } })).ok).toBe(false);
    expect(parseMessage(event("export.status", { status: "ok" })).ok).toBe(false);
  });
});

describe("Stage 3 results and events", () => {
  test("videos.list answers at most 500 records", () => {
    const some = Array.from({ length: 500 }, () => video);
    expect(parseMessage(okResponse("videos.list", { videos: some })).ok).toBe(true);
    expect(parseMessage(okResponse("videos.list", { videos: [...some, video] })).ok).toBe(false);
  });

  test("video.changed also says a record is gone", () => {
    const removed = { change: "removed", videoId: "video-00000001", avatarId: "avatar-0001" };
    expect(parseMessage(event("video.changed", removed)).ok).toBe(true);
  });

  test("video.changed refuses a change it does not know", () => {
    expect(parseMessage(event("video.changed", { change: "renamed", video })).ok).toBe(false);
  });

  test("video.changed refuses an upsert without its record", () => {
    expect(parseMessage(event("video.changed", { change: "upserted" })).ok).toBe(false);
  });

  test("job.progress of a render carries the video, the avatar and the montage", () => {
    const progress = { kind: "render", jobId: "job-00000004", videoId: "video-00000002", avatarId: "avatar-0001", montageId: null, done: 30, total: 240 };
    expect(parseMessage(event("job.progress", progress)).ok).toBe(true);
  });

  test("job.done of a render carries its result", () => {
    const result = { kind: "render", videoId: "video-00000002", avatarId: "avatar-0001", bytes: 3_100_000, durationMs: 8_000, videoKind: "photo", relPath: "Mia/2026-09-29_photo_001.mp4" };
    expect(parseMessage(event("job.done", { jobId: "job-00000004", result })).ok).toBe(true);
  });

  test("an error response for videos.render can name the photos it cannot use", () => {
    const msg = {
      v: PROTOCOL_VERSION,
      id: "msg-00000001",
      kind: "response",
      type: "videos.render",
      ok: false,
      error: { code: "PHOTO_UNAVAILABLE", issues: [{ code: "photo-unavailable", path: ["clips", 0, "cell"] }] },
    };
    expect(parseMessage(msg).ok).toBe(true);
  });

  test("job.failed of a render can say the export folder is unusable, and why", () => {
    const failed = {
      kind: "render",
      jobId: "job-00000004",
      videoId: "video-00000002",
      avatarId: "avatar-0001",
      montageId: "montage-00000001",
      error: { code: "EXPORT_UNAVAILABLE", exportReason: "missing" },
    };
    expect(parseMessage(event("job.failed", failed)).ok).toBe(true);
  });

  // 3a.8b.2: the render queue's raw error `cause` (a Node system error carries `path`, `dest` and `spawnargs`, the whole
  // argv with the owner's photo paths) must never travel. The job.* payloads are strict, so an event that still carries
  // one is refused by main's schema check (EngineHost drops it) and cannot reach a window.
  const renderRef = { kind: "render", jobId: "job-00000004", videoId: "video-00000002", avatarId: "avatar-0001", montageId: null };
  test.each([
    ["job.progress", { ...renderRef, done: 3, total: 120 }],
    ["job.failed", { ...renderRef, error: { code: "RENDER_FAILED", detail: "ffmpeg exited with code 1" } }],
    ["job.cancelled", renderRef],
    ["job.done", { jobId: "job-00000004", result: { kind: "render", videoId: "video-00000002", avatarId: "avatar-0001", bytes: 10, durationMs: 4000, videoKind: "photo", relPath: "Mia/2026-09-29_photo_001.mp4" } }],
  ])("%s of a render is strict: a `cause`, `spawnargs` or `path` next to its fields is refused", (type, payload) => {
    expect(parseMessage(event(type, payload)).ok).toBe(true);
    for (const extra of [{ cause: { spawnargs: ["-i", "/Users/owner/photo.jpg"] } }, { spawnargs: ["-i", "/Users/owner/photo.jpg"] }, { path: "/Users/owner/photo.jpg" }]) {
      expect(parseMessage(event(type, { ...(payload as object), ...extra })).ok).toBe(false);
    }
  });

  // The «сохранение» phase: past the commit's point of no return a cancel is ignored, so the window disables Cancel.
  test("a render's job.progress and its snapshot state can say it is saving; another kind of job cannot", () => {
    expect(parseMessage(event("job.progress", { ...renderRef, done: 119, total: 120, saving: true })).ok).toBe(true);
    expect(parseMessage(event("job.progress", { ...renderRef, done: 119, total: 120, saving: "yes" })).ok).toBe(false);
    expect(parseMessage(event("job.progress", { kind: "run", jobId: "job-00000004", runId: "run-00000001", avatarId: "avatar-0001", done: 1, total: 4, saving: true })).ok).toBe(false);
    const snapshotJob = { ...renderRef, status: "running", done: 119, total: 120, saving: true };
    expect(JobState.safeParse(snapshotJob).success).toBe(true);
    expect(JobState.safeParse({ ...snapshotJob, kind: "avatar.candidates", videoId: undefined, montageId: undefined }).success).toBe(false);
  });

  // 3d.6: a queued render and a running one at zero look the same on the wire, so the engine says which one the announcement is.
  test("a render's job.progress can say it is still queued (waiting for a slot); another kind of job cannot, nor can a saving one", () => {
    expect(parseMessage(event("job.progress", { ...renderRef, done: 0, total: 120, queued: true })).ok).toBe(true);
    expect(parseMessage(event("job.progress", { ...renderRef, done: 0, total: 120, queued: false })).ok).toBe(true);
    expect(parseMessage(event("job.progress", { ...renderRef, done: 0, total: 120, queued: "yes" })).ok).toBe(false);
    expect(parseMessage(event("job.progress", { ...renderRef, done: 0, total: 120, queued: true, saving: true })).ok).toBe(false);
    expect(parseMessage(event("job.progress", { ...renderRef, done: 5, total: 120, queued: true })).ok).toBe(false);
    expect(parseMessage(event("job.progress", { kind: "run", jobId: "job-00000004", runId: "run-00000001", avatarId: "avatar-0001", done: 0, total: 4, queued: true })).ok).toBe(false);
  });

  test("the error inside job.failed is strict too: no `cause` next to its code", () => {
    const payload = { ...renderRef, error: { code: "RENDER_FAILED", cause: { spawnargs: ["-i", "/Users/owner/photo.jpg"] } } };
    expect(parseMessage(event("job.failed", payload)).ok).toBe(false);
  });

  test("an error response for videos.render can carry the montage's issues", () => {
    const msg = {
      v: PROTOCOL_VERSION,
      id: "msg-00000001",
      kind: "response",
      type: "videos.render",
      ok: false,
      error: { code: "MONTAGE_INVALID", issues: [{ code: "duration-too-short", path: ["clips"] }] },
    };
    expect(parseMessage(msg).ok).toBe(true);
  });

  test("a snapshot can list a queued render", () => {
    const queued = { kind: "render", jobId: "job-00000004", videoId: "video-00000002", avatarId: "avatar-0001", montageId: null, status: "queued", done: 0, total: 240 };
    const snapshot = {
      bootId: BOOT,
      lastSeq: 7,
      settings,
      money,
      avatars: [avatar],
      drafts: [],
      unreadableAvatars: [],
      unreadableTotal: 0,
      jobs: [queued],
      librarySwitchGeneration: 0,
      exportStatus: { status: "ok" },
      notices: [],
    };
    expect(parseMessage(okResponse("engine.snapshot", snapshot)).ok).toBe(true);
    const { exportStatus: _e, ...without } = snapshot;
    expect(parseMessage(okResponse("engine.snapshot", without)).ok).toBe(false);
  });
});
