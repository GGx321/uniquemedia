import { describe, expect, test } from "bun:test";
import type { AvatarDescriptor, AvatarTraits } from "./avatar";
import {
  COMMAND_TYPES,
  ENGINE_COMMAND_TYPES,
  MAIN_ONLY_COMMANDS,
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
  JobState,
  MoneyStatus,
  PhotoSummary,
  RunRequest,
  Settings,
} from "./state";

// ---------- fixtures ----------

const BOOT = "boot-00000001";
const API_KEY = `sk-or-v1-${"0a".repeat(32)}`;

const keyStatus: ApiKeyStatus = { stored: true, last4: "3f2a", encryptionAvailable: true, rejected: false };

const settings: Settings = {
  apiKey: keyStatus,
  monthlyBudgetMicros: 10_000_000,
  libraryPath: "/Users/alex/Studio/library",
  imageModel: "x-ai/grok-imagine-image-2.0",
  textModel: "x-ai/grok-4.3",
  concurrency: { network: 6 },
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
const draft: Draft = { avatarId: DRAFT_ID, traits, descriptor, candidates, estimate };

const avatar: AvatarSummary = {
  avatarId: "avatar-0001",
  name: "Лиза",
  descriptor,
  masterPhotoId: "photo-0001",
  createdAt: "2026-09-24T10:00:00Z",
  status: "active",
  photoCount: 0,
};

const job: JobState = {
  kind: "avatar.candidates",
  jobId: "job-00000001",
  avatarId: DRAFT_ID,
  status: "running",
  done: 1,
  total: 4,
};

const runRequest: RunRequest = { avatarId: "avatar-0001", count: 20, categories: ["home", "travel"], resolution: "1k" };

const photo: PhotoSummary = {
  photoId: "photo-0002",
  avatarId: "avatar-0001",
  runId: "run-00000001",
  category: "home",
  resolution: "1k",
  createdAt: "2026-09-24T11:00:00Z",
};

const progressEvent: EventMessage = {
  v: 1,
  id: "evt-00000007",
  kind: "event",
  seq: 7,
  bootId: BOOT,
  type: "job.progress",
  payload: { jobId: "job-00000001", done: 1, total: 4 },
};

type CommandCase<T extends CommandType> = { payload: CommandPayload<T>; result: CommandResult<T> };

const commandCases: { [T in CommandType]: CommandCase<T> } = {
  "settings.get": { payload: {}, result: settings },
  "settings.setApiKey": { payload: { key: API_KEY }, result: keyStatus },
  "settings.clearApiKey": {
    payload: {},
    result: { stored: false, last4: null, encryptionAvailable: true, rejected: false },
  },
  "settings.setBudget": { payload: { monthlyBudgetMicros: 10_000_000 }, result: settings },
  "settings.setLibraryPath": { payload: { path: "/Users/alex/Studio/library" }, result: settings },
  "settings.setModels": {
    payload: { imageModel: "x-ai/grok-imagine-image-2.0", textModel: "x-ai/grok-4.3" },
    result: settings,
  },
  "settings.setConcurrency": { payload: { network: 6 }, result: settings },
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
  "avatars.list": { payload: {}, result: { avatars: [avatar], unreadableAvatars: 0 } },
  "avatars.estimate": { payload: { traits }, result: estimate },
  "avatars.estimateCandidates": { payload: { avatarId: DRAFT_ID }, result: { ...estimate, expectedMicros: 198_000, worstMicros: 227_000 } },
  "avatars.createDraft": { payload: { traits, acceptedWorstMicros: 230_000 }, result: { draft: { ...draft, candidates: [] } } },
  "avatars.generateCandidates": { payload: { avatarId: DRAFT_ID, acceptedWorstMicros: 230_000 }, result: { jobId: "job-00000001" } },
  "avatars.cancel": { payload: { jobId: "job-00000001" }, result: { jobId: "job-00000001" } },
  "avatars.pick": {
    payload: { avatarId: DRAFT_ID, photoId: "photo-0101", name: "Лиза" },
    result: { avatar: { ...avatar, avatarId: DRAFT_ID, masterPhotoId: "photo-0101" } },
  },
  "avatars.archive": { payload: { avatarId: "avatar-0001" }, result: { avatar: { ...avatar, status: "archived" } } },
  "runs.estimate": { payload: runRequest, result: { estimate } },
  "runs.start": {
    payload: { ...runRequest, acceptedWorstMicros: 3_330_000 },
    result: { runId: "run-00000001", jobId: "job-00000002" },
  },
  "runs.cancel": { payload: { runId: "run-00000001" }, result: { runId: "run-00000001" } },
  "runs.resume": { payload: { runId: "run-00000001" }, result: { runId: "run-00000001", jobId: "job-00000003" } },
  "photos.list": { payload: { avatarId: "avatar-0001" }, result: { photos: [photo] } },
  "engine.snapshot": {
    payload: {},
    result: {
      bootId: BOOT,
      lastSeq: 7,
      settings,
      money,
      avatars: [avatar],
      drafts: [draft],
      unreadableAvatars: 1,
      jobs: [job],
      librarySwitchGeneration: 2,
      notices: [notice],
    },
  },
  "engine.events": { payload: { afterSeq: 6, bootId: BOOT }, result: { gap: false, events: [progressEvent] } },
};

const eventCases: { [T in EventType]: EventPayload<T> } = {
  "job.progress": { jobId: "job-00000001", done: 2, total: 4 },
  "job.done": {
    jobId: "job-00000001",
    result: { kind: "avatar.candidates", avatarId: DRAFT_ID, candidates, rejectedByAgeCheck: 1, failedSlots: [{ slot: 4, reason: "age-rejected" }] },
  },
  "job.failed": { jobId: "job-00000001", error: { code: "AUTH_INVALID", detail: "401 from OpenRouter" } },
  "job.cancelled": { jobId: "job-00000001" },
  "money.changed": { status: money },
  "money.reconcileNeeded": { reasons: ["open-reserves"], unsettledMicros: 55_000 },
  "settings.changed": { settings: { ...settings, apiKey: { ...keyStatus, rejected: true } }, librarySwitchGeneration: 2 },
  "avatar.changed": { avatar },
  "draft.changed": { draft },
  "engine.error": { error: { code: "INTERNAL" } },
  "engine.notice": { notice },
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

const command = (type: string, payload: unknown) => ({ v: 1, id: "msg-00000001", kind: "command", type, payload });
const okResponse = (type: string, result: unknown) => ({
  v: 1,
  id: "msg-00000001",
  kind: "response",
  type,
  ok: true,
  result,
});
const event = (type: string, payload: unknown, seq: unknown = 1) => ({
  v: 1,
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
        "settings.setBudget",
        "settings.setLibraryPath",
        "settings.setModels",
        "settings.setConcurrency",
        "money.status",
        "money.reconcile",
        "avatars.list",
        "avatars.estimate",
        "avatars.estimateCandidates",
        "avatars.createDraft",
        "avatars.generateCandidates",
        "avatars.cancel",
        "avatars.pick",
        "avatars.archive",
        "runs.estimate",
        "runs.start",
        "runs.cancel",
        "runs.resume",
        "photos.list",
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

  test("only the API key commands are handled by main alone", () => {
    const actual: string[] = [...MAIN_ONLY_COMMANDS].sort();
    expect(actual).toEqual(["settings.clearApiKey", "settings.setApiKey"]);
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
    const msg = { v: 1, id: crypto.randomUUID(), kind: "command", type, payload: c.payload };
    expectRoundTrip(msg);
  });

  test.each(commandEntries)("%s success response survives JSON and parses back unchanged", (type, c) => {
    const msg = { v: 1, id: crypto.randomUUID(), kind: "response", type, ok: true, result: c.result };
    expectRoundTrip(msg);
  });

  test.each(commandEntries)("%s error response survives JSON and parses back unchanged", (type) => {
    const msg = {
      v: 1,
      id: crypto.randomUUID(),
      kind: "response",
      type,
      ok: false,
      error: { code: "NETWORK", detail: "ECONNRESET" },
    };
    expectRoundTrip(msg);
  });

  test.each(eventEntries)("%s event survives JSON and parses back unchanged", (type, payload) => {
    const msg = { v: 1, id: crypto.randomUUID(), kind: "event", seq: 42, bootId: BOOT, type, payload };
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

  test.each([0, 2, "1", null, 1.0000001])("rejects protocol version %p", (v) => {
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

  test("a response whose result belongs to another command is rejected", () => {
    expect(reasonOf(okResponse("settings.setApiKey", settings))).toContain("result");
  });

  test("an error response with an unknown code is rejected", () => {
    const msg = { v: 1, id: "msg-00000001", kind: "response", type: "money.status", ok: false, error: { code: "E_TOO_BAD" } };
    expect(reasonOf(msg)).toContain("error.code");
  });

  test("an error response for an unknown command type is rejected", () => {
    const msg = { v: 1, id: "msg-00000001", kind: "response", type: "money.spend", ok: false, error: { code: "INTERNAL" } };
    expect(reasonOf(msg)).toContain("type");
  });

  test("an error response whose detail carries the key arrives with the key stripped", () => {
    const msg = {
      v: 1,
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
    const result = { bootId: BOOT, lastSeq: 7, settings, money, avatars: [avatar], unreadableAvatars: 0, jobs: [job], notices: [] };
    expect(reasonOf(okResponse("engine.snapshot", result))).toContain("result.drafts");
  });

  test("an engine.snapshot response without the count of avatars it could not read is rejected", () => {
    const result = { bootId: BOOT, lastSeq: 7, settings, money, avatars: [avatar], drafts: [draft], jobs: [job], notices: [] };
    expect(reasonOf(okResponse("engine.snapshot", result))).toContain("result.unreadableAvatars");
  });

  test.each([-1, 1.5])("rejects an avatars.list answer that counts %p unreadable avatars", (unreadableAvatars) => {
    expect(reasonOf(okResponse("avatars.list", { avatars: [avatar], unreadableAvatars }))).toContain("result.unreadableAvatars");
  });

  test("an engine.snapshot response without the pending notices is rejected", () => {
    const result = { bootId: BOOT, lastSeq: 7, settings, money, avatars: [avatar], drafts: [draft], unreadableAvatars: 0, jobs: [job] };
    expect(reasonOf(okResponse("engine.snapshot", result))).toContain("result.notices");
  });

  test("an engine.snapshot response that repeats a notice is rejected", () => {
    const result = { bootId: BOOT, lastSeq: 7, settings, money, avatars: [], drafts: [], unreadableAvatars: 0, jobs: [], notices: [notice, notice] };
    expect(reasonOf(okResponse("engine.snapshot", result))).toContain("result.notices");
  });

  test("a snapshot restores a finished candidates job with its result", () => {
    const done = { ...job, status: "done", done: 4, result: eventCases["job.done"].result };
    const result = { bootId: BOOT, lastSeq: 7, settings, money, avatars: [], drafts: [draft], unreadableAvatars: 0, jobs: [done], librarySwitchGeneration: 0, notices: [] };
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
    const result = { bootId: BOOT, lastSeq: 0, settings, money: unavailable, avatars: [], drafts: [], unreadableAvatars: 0, jobs: [], librarySwitchGeneration: 0, notices: [] };
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
    expect(reasonOf(event("job.progress", { jobId: "job-00000001", done: 5, total: 4 }))).toContain("payload.done");
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
    expect(reasonOf(event("job.cancelled", {}))).toContain("payload.jobId");
  });
});

// ---------- robustness ----------

describe("parseMessage never throws", () => {
  test("on an otherwise valid command whose payload getter throws", () => {
    const hostile = {
      v: 1,
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

  test("avatars.generateCandidates no longer answers with an estimate after spending started", () => {
    const result = { jobId: "job-00000001", estimate };
    expect(parseMessage(okResponse("avatars.generateCandidates", result)).ok).toBe(false);
  });

  test("a PRICE_CHANGED refusal parses as an error response", () => {
    const msg = { v: 1, id: "msg-00000001", kind: "response", type: "avatars.createDraft", ok: false, error: { code: "PRICE_CHANGED" } };
    expect(parseMessage(msg).ok).toBe(true);
  });
});

// ---------- answering what could not be parsed ----------

describe("error responses for unparseable commands", () => {
  const validation = { code: "VALIDATION" as const, detail: "type: unknown command" };

  test("an error response may carry a null type", () => {
    const msg = { v: 1, id: "msg-00000001", kind: "response", type: null, ok: false, error: validation };
    expect(parseMessage(msg).ok).toBe(true);
  });

  test("an error response may carry a null id", () => {
    const msg = { v: 1, id: null, kind: "response", type: null, ok: false, error: validation };
    expect(parseMessage(msg).ok).toBe(true);
  });

  test("a success response may not carry a null type", () => {
    expect(parseMessage(okResponse("money.status", money)).ok).toBe(true);
    expect(parseMessage({ ...okResponse("money.status", money), type: null }).ok).toBe(false);
  });

  test("errorResponseFor keeps the command's id when only the type is unknown", () => {
    const input = command("settings.delete", {});
    expect(errorResponseFor(input, validation)).toEqual({
      v: 1,
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
    const r = parseEngineCommand({ ...command("money.status", {}), v: 2 });
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
