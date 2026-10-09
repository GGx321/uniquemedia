import { describe, expect, test } from "bun:test";
import {
  LaunchDraft,
  LaunchEntryId,
  LaunchPreview,
  LaunchSummary,
  LaunchView,
  LOG_KINDS,
  LogLine,
  MAX_LISTED_LAUNCHES,
  PaidHold,
} from "./autopilot";
import { raiseBudgetToMicros } from "../autopilot/money";
import { OkResponse, Snapshot } from "./commands";
import { EventMessage } from "./events";
import { parseEngineCommand } from "./messages";
import { LaunchId, LaunchVideoKey } from "./primitives";
import { PROTOCOL_VERSION } from "./envelope";
import {
  A,
  B,
  LAUNCH,
  SET,
  NOW,
  LATER,
  draftSettings,
  draft,
  holdAt,
  HOLDS,
  LOG_SAMPLES,
  logLine,
  avatarRow,
  view,
  viewWith,
  summary,
  video,
  previewRow,
  preview,
  previewWith,
} from "./autopilot.fixtures";

// Stage 4, S4.1: the contract of the batch autopilot (plan §9, amended by §18). Every rejection test below first checks that the
// unmutated base is accepted, so a test cannot pass only because the command or the field does not exist.

const command = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "command", type, payload });
const accepts = (type: string, payload: unknown): boolean => parseEngineCommand(command(type, payload)).ok;
const answers = (type: string, result: unknown): boolean => OkResponse.safeParse({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type, ok: true, result }).success;

/** A rejection test: the base is accepted, the mutation is not. */
function rejects(type: string, base: Record<string, unknown>, patch: Record<string, unknown>): void {
  expect(accepts(type, base)).toBe(true);
  expect(accepts(type, { ...base, ...patch })).toBe(false);
}

// ---------- ids ----------

describe("launch ids", () => {
  test("a launch id is `launch-` and a path-safe body of 8 to 57 characters", () => {
    expect(LaunchId.safeParse(LAUNCH).success).toBe(true);
    expect(LaunchId.safeParse(`launch-${"a".repeat(57)}`).success).toBe(true);
    for (const bad of ["launch-short", `launch-${"a".repeat(58)}`, "run-0a1b2c3d4e5f", "LAUNCH-0a1b2c3d4e5f", "launch-0a1b2c3d/../x", "launch-0a1b2c3d.json", "../launch-0a1b2c3d", "launch-0a1b 2c3d", "launch--0a1b2c3d", ""]) {
      expect(LaunchId.safeParse(bad).success).toBe(false);
    }
  });

  test("a video key is the avatar's place in the launch and the video's number", () => {
    expect(LaunchVideoKey.safeParse("0-1").success).toBe(true);
    expect(LaunchVideoKey.safeParse("49-50").success).toBe(true);
    for (const bad of ["", "a-1", "1", "1-", "-1", "1-2-3", "100-1", "1-1000", "50-1", "1-51", "1-0", "0-0", "../1", "1_2"]) expect(LaunchVideoKey.safeParse(bad).success).toBe(false);
  });

  test("an entry id is 16 lowercase hex characters and never a name or a path", () => {
    expect(LaunchEntryId.safeParse("0123456789abcdef").success).toBe(true);
    for (const bad of ["0123456789ABCDEF", "0123456789abcde", "0123456789abcdef0", "../../etc/passwd", "a/b", "launch-0a1b2c3d4e5f.json", "~/x", "C:\\x", "0123456789abcde\n", " 0123456789abcdef", "0123456789abcdeg", ""]) {
      expect(LaunchEntryId.safeParse(bad).success).toBe(false);
    }
  });

  test("autopilot.removeUnreadable takes an entry id and nothing else: a name or a path is refused", () => {
    expect(accepts("autopilot.removeUnreadable", { entryId: "0123456789abcdef" })).toBe(true);
    expect(accepts("autopilot.removeUnreadable", { entryId: "0123456789abcdef", path: "/etc/passwd" })).toBe(false);
    expect(accepts("autopilot.removeUnreadable", { entryId: "launch-0a1b2c3d4e5f.json" })).toBe(false);
    expect(accepts("autopilot.removeUnreadable", { entryId: "../../quarantine" })).toBe(false);
    expect(accepts("autopilot.removeUnreadable", { name: "launch-0a1b2c3d4e5f.json" })).toBe(false);
    expect(accepts("autopilot.removeUnreadable", {})).toBe(false);
  });

  test("pause, stop and get name a launch by a well-formed id", () => {
    for (const type of ["autopilot.pause", "autopilot.stop", "autopilot.get"]) {
      expect(accepts(type, { launchId: LAUNCH })).toBe(true);
      expect(accepts(type, { launchId: "../launch" })).toBe(false);
      expect(accepts(type, { launchId: "launch-x" })).toBe(false);
      expect(accepts(type, {})).toBe(false);
      expect(accepts(type, { launchId: LAUNCH, extra: 1 })).toBe(false);
    }
  });
});

// ---------- the draft ----------

describe("LaunchDraft", () => {
  test("accepts a full draft and round-trips through JSON", () => {
    const parsed = LaunchDraft.parse(draft);
    expect(LaunchDraft.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  const refused: [string, Record<string, unknown>][] = [
    ["a mix that sums to 99", { mix: { single: 69, collage: 20, slides: 10 } }],
    ["a mix that sums to 101", { mix: { single: 71, collage: 20, slides: 10 } }],
    ["a fractional share", { mix: { single: 70.5, collage: 19.5, slides: 10 } }],
    ["a negative share", { mix: { single: 110, collage: -10, slides: 0 } }],
    ["no avatar", { avatarIds: [] }],
    ["51 avatars", { avatarIds: Array.from({ length: 51 }, (_, i) => `avatar-${String(i).padStart(8, "0")}`) }],
    ["the same avatar twice", { avatarIds: [A, A] }],
    ["an avatar id that is a path", { avatarIds: ["../avatar"] }],
    ["0 videos per avatar", { videosPerAvatar: 0 }],
    ["51 videos per avatar", { videosPerAvatar: 51 }],
    ["1.5 videos per avatar", { videosPerAvatar: 1.5 }],
    ["no category", { categories: [] }],
    ["21 categories", { categories: [...["home", "travel", "shoot", "glam", "fit"], ...Array.from({ length: 16 }, (_, i) => `cat-custom${String(i).padStart(3, "0")}`)] }],
    ["a category twice", { categories: ["home", "home"] }],
    ["an unknown category", { categories: ["beach"] }],
    ["a negative plan seed", { planSeed: -1 }],
    ["a plan seed past 32 bits", { planSeed: 4_294_967_296 }],
    ["a fractional plan seed", { planSeed: 1.5 }],
    ["a missing plan seed", { planSeed: undefined }],
    ["a text setting (no text this stage)", { text: true }],
    ["a toggle that is not a boolean", { stickers: "yes" }],
  ];
  test.each(refused)("refuses %s", (_name, patch) => {
    expect(LaunchDraft.safeParse(draft).success).toBe(true);
    expect(LaunchDraft.safeParse({ ...draft, ...patch }).success).toBe(false);
  });

  test("accepts the boundaries: 50 avatars, 50 videos, 20 categories, seed 0 and 2^32-1, a one-shape mix", () => {
    const fifty = Array.from({ length: 50 }, (_, i) => `avatar-${String(i).padStart(8, "0")}`);
    const twenty = [...["home", "travel", "shoot", "glam", "fit"], ...Array.from({ length: 15 }, (_, i) => `cat-custom${String(i).padStart(3, "0")}`)];
    expect(LaunchDraft.safeParse({ ...draft, avatarIds: fifty, videosPerAvatar: 50, categories: twenty }).success).toBe(true);
    expect(LaunchDraft.safeParse({ ...draft, planSeed: 0 }).success).toBe(true);
    expect(LaunchDraft.safeParse({ ...draft, planSeed: 4_294_967_295 }).success).toBe(true);
    expect(LaunchDraft.safeParse({ ...draft, mix: { single: 100, collage: 0, slides: 0 } }).success).toBe(true);
    expect(LaunchDraft.safeParse({ ...draft, mix: { single: 0, collage: 0, slides: 100 } }).success).toBe(true);
  });
});

describe("autopilot.estimate and autopilot.start", () => {
  test("the estimate takes a draft without a plan seed (the preview draws one) and with one (a refresh keeps it)", () => {
    expect(accepts("autopilot.estimate", { draft: draftSettings })).toBe(true);
    expect(accepts("autopilot.estimate", { draft })).toBe(true);
    expect(accepts("autopilot.estimate", { draft: { ...draftSettings, mix: { single: 50, collage: 20, slides: 10 } } })).toBe(false);
    expect(accepts("autopilot.estimate", { draft: { ...draftSettings, avatarIds: [] } })).toBe(false);
    expect(accepts("autopilot.estimate", {})).toBe(false);
  });

  test("the start needs the plan seed of the preview, so it plans the same videos", () => {
    expect(accepts("autopilot.start", { draft, acceptedWorstMicros: 4_140_000 })).toBe(true);
    expect(accepts("autopilot.start", { draft: draftSettings, acceptedWorstMicros: 4_140_000 })).toBe(false);
  });

  test("the accepted worst case is whole micro-dollars: no fraction, no negative, no string, nothing past the launch bound", () => {
    const base = { draft, acceptedWorstMicros: 4_140_000 };
    rejects("autopilot.start", base, { acceptedWorstMicros: 4_140_000.5 });
    rejects("autopilot.start", base, { acceptedWorstMicros: -1 });
    rejects("autopilot.start", base, { acceptedWorstMicros: "4140000" });
    rejects("autopilot.start", base, { acceptedWorstMicros: Number.NaN });
    rejects("autopilot.start", base, { acceptedWorstMicros: Number.POSITIVE_INFINITY });
    rejects("autopilot.start", base, { acceptedWorstMicros: 10_000_000_001 });
    rejects("autopilot.start", base, { acceptedWorstMicros: undefined });
    expect(accepts("autopilot.start", { draft, acceptedWorstMicros: 10_000_000_000 })).toBe(true);
    expect(accepts("autopilot.start", { draft, acceptedWorstMicros: 0 })).toBe(true);
  });
});

describe("autopilot.resume", () => {
  const base = { launchId: LAUNCH, acceptedRemainingMicros: 2_930_000 };

  test("carries the remaining worst the owner accepted, in whole micro-dollars within the launch bound", () => {
    expect(accepts("autopilot.resume", base)).toBe(true);
    expect(accepts("autopilot.resume", { ...base, acceptedRemainingMicros: 0 })).toBe(true);
    expect(accepts("autopilot.resume", { ...base, acceptedRemainingMicros: 10_000_000_000 })).toBe(true);
    rejects("autopilot.resume", base, { acceptedRemainingMicros: 10_000_000_001 });
    rejects("autopilot.resume", base, { acceptedRemainingMicros: -5 });
    rejects("autopilot.resume", base, { acceptedRemainingMicros: 2.93 });
    rejects("autopilot.resume", base, { acceptedRemainingMicros: "2930000" });
    rejects("autopilot.resume", base, { acceptedRemainingMicros: undefined });
  });

  test("names the launch by a well-formed id", () => {
    rejects("autopilot.resume", base, { launchId: "../launch" });
    rejects("autopilot.resume", base, { extra: true });
  });
});

describe("autopilot.continueAfterReview", () => {
  const base = { launchId: LAUNCH, avatarId: A, sceneSetId: SET, revision: 3 };

  test("names the launch, the avatar, the set and the revision the owner saw", () => {
    expect(accepts("autopilot.continueAfterReview", base)).toBe(true);
    rejects("autopilot.continueAfterReview", base, { revision: 0 });
    rejects("autopilot.continueAfterReview", base, { revision: 1.5 });
    rejects("autopilot.continueAfterReview", base, { sceneSetId: "../set" });
    rejects("autopilot.continueAfterReview", base, { launchId: "nope" });
    rejects("autopilot.continueAfterReview", base, { avatarId: "../a" });
  });
});

describe("empty payloads", () => {
  test("autopilot.list takes nothing", () => {
    expect(accepts("autopilot.list", {})).toBe(true);
    expect(accepts("autopilot.list", { limit: 5 })).toBe(false);
  });
});

// ---------- the paid hold ----------

describe("PaidHold: a strict union by reason", () => {
  test.each(Object.entries(HOLDS))("accepts a %s hold and round-trips it", (_reason, hold) => {
    const parsed = PaidHold.parse(hold);
    expect(PaidHold.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  test("covers exactly the reasons of the plan's table (§4.6)", () => {
    expect(Object.keys(HOLDS).sort()).toEqual(["budget", "credits", "halt", "internal", "key", "network", "price", "price-unavailable"]);
  });

  test("counters survive a reconcile and a «Продолжить», so a fourth drop and a fourth price retry are legal states", () => {
    expect(PaidHold.safeParse({ reason: "network", ...holdAt, detail: { drops: 4, attempt: 2, nextAt: null } }).success).toBe(true);
    expect(PaidHold.safeParse({ reason: "network", ...holdAt, detail: { drops: 9, attempt: 0, nextAt: null } }).success).toBe(true);
    expect(PaidHold.safeParse({ reason: "price-unavailable", ...holdAt, detail: { attempt: 4, nextAt: null } }).success).toBe(true);
  });

  test("a price hold at compose or «Дописать» names the need and what is left", () => {
    for (const stage of ["compose", "rewrite"]) {
      expect(PaidHold.safeParse({ reason: "price", ...holdAt, detail: { stage, needMicros: 75_000, leftMicros: 40_000 } }).success).toBe(true);
    }
  });

  test("a network hold that waits for a reconcile has no next retry; one that retries has a time", () => {
    expect(PaidHold.safeParse({ reason: "network", ...holdAt, detail: { drops: 3, attempt: 2, nextAt: null } }).success).toBe(true);
    expect(PaidHold.safeParse({ reason: "price-unavailable", ...holdAt, detail: { attempt: 3, nextAt: null } }).success).toBe(true);
  });

  test("a detail of another reason is refused for every reason", () => {
    const reasons = Object.keys(HOLDS);
    for (const reason of reasons) {
      expect(PaidHold.safeParse(HOLDS[reason]).success).toBe(true);
      for (const other of reasons.filter((r) => r !== reason)) {
        const detail = (HOLDS[other] as { detail: unknown }).detail;
        // Two reasons may share an empty or an identical detail by design (credits and key): that is the same detail, not a wrong pairing.
        if (JSON.stringify(detail) === JSON.stringify((HOLDS[reason] as { detail: unknown }).detail)) continue;
        expect(PaidHold.safeParse({ reason, ...holdAt, detail }).success).toBe(false);
      }
    }
  });

  const bad: [string, unknown][] = [
    ["an unknown reason", { reason: "weather", ...holdAt, detail: {} }],
    ["a missing detail", { reason: "budget", ...holdAt }],
    ["a missing time", { reason: "credits", detail: {} }],
    ["a detail with an extra key (credits)", { reason: "credits", ...holdAt, detail: { why: "no money" } }],
    ["a detail with an extra key (budget)", { reason: "budget", ...holdAt, detail: { freeMicros: 1, needMicros: 2, kind: "new-slice", extra: 1 } }],
    ["a budget hold with a float amount", { reason: "budget", ...holdAt, detail: { freeMicros: 1.5, needMicros: 2, kind: "new-slice" } }],
    ["a budget hold with a negative amount", { reason: "budget", ...holdAt, detail: { freeMicros: -1, needMicros: 2, kind: "new-slice" } }],
    ["a budget hold of an unknown kind", { reason: "budget", ...holdAt, detail: { freeMicros: 1, needMicros: 2, kind: "whole-launch" } }],
    ["a network hold with no drops", { reason: "network", ...holdAt, detail: { drops: 0, attempt: 0, nextAt: null } }],
    ["a network hold that names a next retry without a retry", { reason: "network", ...holdAt, detail: { drops: 1, attempt: 0, nextAt: LATER } }],
    ["a price-unavailable hold with attempt 0", { reason: "price-unavailable", ...holdAt, detail: { attempt: 0, nextAt: LATER } }],
    ["a slice price hold that does not shrink", { reason: "price", ...holdAt, detail: { stage: "slice", fromPhotos: 5, toPhotos: 5 } }],
    ["a slice price hold that grows", { reason: "price", ...holdAt, detail: { stage: "slice", fromPhotos: 5, toPhotos: 6 } }],
    ["a price hold with no stage", { reason: "price", ...holdAt, detail: { fromPhotos: 5, toPhotos: 0 } }],
    ["a compose price hold that carries photos", { reason: "price", ...holdAt, detail: { stage: "compose", fromPhotos: 5, toPhotos: 0 } }],
    ["a compose price hold whose room covers the need", { reason: "price", ...holdAt, detail: { stage: "compose", needMicros: 100, leftMicros: 100 } }],
    ["a price hold of an unknown stage", { reason: "price", ...holdAt, detail: { stage: "draw", needMicros: 100, leftMicros: 1 } }],
    ["a halt of another code", { reason: "halt", ...holdAt, detail: { code: "NETWORK" } }],
    ["an internal hold of an unknown kind", { reason: "internal", ...holdAt, detail: { kind: "unreadable-set" } }],
    ["a time that is not a date", { reason: "credits", at: "yesterday", detail: {} }],
  ];
  test.each(bad)("refuses %s", (_name, hold) => {
    expect(PaidHold.safeParse(HOLDS["credits"]).success).toBe(true);
    expect(PaidHold.safeParse(hold).success).toBe(false);
  });
});

// ---------- the log ----------

describe("LogLine", () => {
  test("the kinds are the 23 rows of the design's log sheet (the plan counted 22), the 13 more the artboards draw (holds, a busy avatar, a restart, scenes being written, a dropped render) and the library-unknown wait (S4.6c2)", () => {
    expect<string[]>([...LOG_KINDS].sort()).toEqual(Object.keys(LOG_SAMPLES).sort());
    expect(LOG_KINDS.length).toBe(37);
  });

  test.each(Object.keys(LOG_SAMPLES))("accepts a %s line and round-trips it", (kind) => {
    const parsed = LogLine.parse(logLine(kind));
    expect(LogLine.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  test("a line may name an avatar; the id is checked", () => {
    expect(LogLine.safeParse(logLine("photo", { avatarId: A })).success).toBe(true);
    expect(LogLine.safeParse(logLine("photo", { avatarId: "../x" })).success).toBe(false);
  });

  test("an unknown kind, a missing field, an extra field and free text from the engine are all refused", () => {
    expect(LogLine.safeParse(logLine("photo")).success).toBe(true);
    expect(LogLine.safeParse(logLine("weather")).success).toBe(false);
    expect(LogLine.safeParse({ at: NOW, kind: "photo", done: 9 }).success).toBe(false);
    expect(LogLine.safeParse(logLine("photo", { extra: 1 })).success).toBe(false);
    expect(LogLine.safeParse(logLine("photo", { text: "фото 9 из 14" })).success).toBe(false);
    expect(LogLine.safeParse({ kind: "paused" }).success).toBe(false);
    expect(LogLine.safeParse(logLine("paused", { at: "noon" })).success).toBe(false);
  });

  test("money in a line is whole non-negative micro-dollars", () => {
    expect(LogLine.safeParse(logLine("stopped")).success).toBe(true);
    expect(LogLine.safeParse(logLine("stopped", { spentMicros: 1.5 })).success).toBe(false);
    expect(LogLine.safeParse(logLine("stopped", { spentMicros: -1 })).success).toBe(false);
    expect(LogLine.safeParse(logLine("start", { acceptedMicros: "4" })).success).toBe(false);
  });

  test("a skipped line names a reason, and only a failure-rate skip counts its photos", () => {
    expect(LogLine.safeParse(logLine("skipped", { reason: "archived", failed: undefined, total: undefined })).success).toBe(true);
    expect(LogLine.safeParse(logLine("skipped", { reason: "archived" })).success).toBe(false);
    expect(LogLine.safeParse(logLine("skipped", { failed: undefined, total: undefined })).success).toBe(false);
    expect(LogLine.safeParse(logLine("skipped", { reason: "weather", failed: undefined, total: undefined })).success).toBe(false);
    expect(LogLine.safeParse(logLine("skipped", { failed: 6, total: 5 })).success).toBe(false);
  });

  test("a degrade can lose no video: a smaller one (slides of 5 to a collage of 4) still lacks photos", () => {
    expect(LogLine.safeParse(logLine("degrade", { fewerVideos: 0, missingPhotos: 1 })).success).toBe(true);
    expect(LogLine.safeParse(logLine("degrade", { fewerVideos: 0, missingPhotos: 0 })).success).toBe(false);
  });

  test("a photo can fail by the cap, or by no answer, as well as by a gate", () => {
    for (const cause of ["face", "duplicate", "age", "moderation", "provider", "limit", "no-answer"]) expect(LogLine.safeParse(logLine("photo-failed", { cause })).success).toBe(true);
    expect(LogLine.safeParse(logLine("photo-failed", { cause: "weather" })).success).toBe(false);
  });

  test("the retries of a network drop are not capped at two: the counters live on", () => {
    expect(LogLine.safeParse(logLine("network-retry", { attempt: 3, attempts: 3 })).success).toBe(true);
    expect(LogLine.safeParse(logLine("network-retry", { attempt: 3, attempts: 2 })).success).toBe(false);
  });

  test("the hold lines carry the same typed detail as the hold itself", () => {
    expect(LogLine.safeParse(logLine("hold-price", { detail: { stage: "compose", needMicros: 75_000, leftMicros: 40_000 } })).success).toBe(true);
    expect(LogLine.safeParse(logLine("hold-price", { detail: { stage: "slice", fromPhotos: 5, toPhotos: 5 } })).success).toBe(false);
    expect(LogLine.safeParse(logLine("hold-halt", { code: "NETWORK" })).success).toBe(false);
    expect(LogLine.safeParse(logLine("app-restarted", { cause: "owner" })).success).toBe(false);
    expect(LogLine.safeParse(logLine("hold-export", { exportReason: "weather" })).success).toBe(false);
  });

  test("a price shrink shrinks, and a retry is a second attempt at the earliest", () => {
    expect(LogLine.safeParse(logLine("price-shrink", { toPhotos: 5 })).success).toBe(false);
    expect(LogLine.safeParse(logLine("photo-retry", { attempt: 1 })).success).toBe(false);
    expect(LogLine.safeParse(logLine("photo-retry", { attempt: 4 })).success).toBe(false);
  });

  test("a face score is a cosine", () => {
    expect(LogLine.safeParse(logLine("photo", { faceCos: 1.2 })).success).toBe(false);
    expect(LogLine.safeParse(logLine("photo", { faceCos: undefined })).success).toBe(true);
  });

  test("a finished video is at most 10 s", () => {
    expect(LogLine.safeParse(logLine("video-done", { durationMs: 10_000 })).success).toBe(true);
    expect(LogLine.safeParse(logLine("video-done", { durationMs: 10_001 })).success).toBe(false);
    expect(LogLine.safeParse(logLine("video-done", { key: "../1" })).success).toBe(false);
  });
});

// ---------- the live view ----------

describe("LaunchView", () => {
  test("accepts a running launch and round-trips it", () => {
    const parsed = LaunchView.parse(view);
    expect(LaunchView.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
  });

  test.each(["running", "pausing", "paused", "stopping", "done", "stopped"])("status %s is a state of a launch", (status) => {
    const over: Record<string, unknown> = { status };
    if (status === "paused") over.paused = { cause: "owner", at: NOW };
    if (status === "done" || status === "stopped") over.endedAt = LATER;
    expect(LaunchView.safeParse(viewWith(over)).success).toBe(true);
  });

  test("an unknown status is refused", () => {
    expect(LaunchView.safeParse(viewWith({ status: "sleeping" })).success).toBe(false);
  });

  test.each(["owner", "quit", "engine-restart"])("a launch paused by %s names when", (cause) => {
    expect(LaunchView.safeParse(viewWith({ status: "paused", paused: { cause, at: NOW } })).success).toBe(true);
  });

  test("a pause is present exactly when the launch is paused, and its cause is one of three", () => {
    expect(LaunchView.safeParse(viewWith({ status: "paused", paused: { cause: "owner", at: NOW } })).success).toBe(true);
    expect(LaunchView.safeParse(viewWith({ status: "paused", paused: null })).success).toBe(false);
    expect(LaunchView.safeParse(viewWith({ paused: { cause: "owner", at: NOW } })).success).toBe(false);
    expect(LaunchView.safeParse(viewWith({ status: "paused", paused: { cause: "restart", at: NOW } })).success).toBe(false);
  });

  test("a launch has ended exactly when it is done or stopped", () => {
    expect(LaunchView.safeParse(viewWith({ status: "done", endedAt: LATER })).success).toBe(true);
    expect(LaunchView.safeParse(viewWith({ status: "stopped", endedAt: LATER })).success).toBe(true);
    expect(LaunchView.safeParse(viewWith({ status: "done", endedAt: null })).success).toBe(false);
    expect(LaunchView.safeParse(viewWith({ status: "stopping", endedAt: LATER })).success).toBe(false);
    expect(LaunchView.safeParse(viewWith({ endedAt: LATER })).success).toBe(false);
  });

  test("a launch carries the hold it waits on, whole", () => {
    expect(LaunchView.safeParse(viewWith({ paidHold: HOLDS["budget"] })).success).toBe(true);
    expect(LaunchView.safeParse(viewWith({ paidHold: { reason: "budget", ...holdAt, detail: {} } })).success).toBe(false);
    expect(
      LaunchView.safeParse(viewWith({ freeHold: { reason: "export", at: NOW, detail: { exportReason: "not-enough-space", neededBytes: 9_000_000, freeBytes: 6_000_000 } } })).success,
    ).toBe(true);
    expect(LaunchView.safeParse(viewWith({ freeHold: { reason: "export", at: NOW, detail: { exportReason: "missing", neededBytes: null, freeBytes: null } } })).success).toBe(true);
    expect(LaunchView.safeParse(viewWith({ freeHold: { reason: "export", at: NOW, detail: { exportReason: "missing", neededBytes: 9_000_000, freeBytes: 6_000_000 } } })).success).toBe(false);
    expect(LaunchView.safeParse(viewWith({ freeHold: { reason: "weather", at: NOW, detail: {} } })).success).toBe(false);
  });

  test("the planned worst never exceeds what the click accepted, and the expected never exceeds the worst", () => {
    expect(LaunchView.safeParse(viewWith({ plannedWorstMicros: 4_139_999, remainingMicros: 2_929_999 })).success).toBe(true);
    expect(LaunchView.safeParse(viewWith({ plannedWorstMicros: 4_140_001, remainingMicros: 2_930_001 })).success).toBe(false);
    expect(LaunchView.safeParse(viewWith({ plannedExpectedMicros: 4_140_001 })).success).toBe(false);
  });

  test("the remaining worst is the planned worst less what was spent, never below zero", () => {
    expect(LaunchView.safeParse(viewWith({ remainingMicros: 2_930_001 })).success).toBe(false);
    expect(LaunchView.safeParse(viewWith({ remainingMicros: 0, spentMicros: 4_140_000 })).success).toBe(true);
    expect(LaunchView.safeParse(viewWith({ remainingMicros: 0, spentMicros: 4_200_000 })).success).toBe(true);
    expect(LaunchView.safeParse(viewWith({ remainingMicros: -1, spentMicros: 4_200_000 })).success).toBe(false);
  });

  test("the plan's photos are the library's and the new ones", () => {
    expect(LaunchView.safeParse(viewWith({ plan: { videos: 20, photos: 56, fromLibrary: 37, toGenerate: 18 } })).success).toBe(false);
  });

  test("what is in flight is a count and whole micro-dollars", () => {
    expect(LaunchView.safeParse(viewWith({ inFlight: { requests: 0, openMicros: 0 } })).success).toBe(true);
    expect(LaunchView.safeParse(viewWith({ inFlight: { requests: -1, openMicros: 0 } })).success).toBe(false);
    expect(LaunchView.safeParse(viewWith({ inFlight: { requests: 1, openMicros: 0.5 } })).success).toBe(false);
    expect(LaunchView.safeParse(viewWith({ inFlight: { requests: 1 } })).success).toBe(false);
  });

  describe("unsettled: the open reserves with no request out (S4.6v)", () => {
    test("is optional, so a view from before it stays valid", () => {
      expect("unsettled" in view).toBe(false);
      expect(LaunchView.safeParse(view).success).toBe(true);
    });

    test("is a count and whole micro-dollars", () => {
      expect(LaunchView.safeParse(viewWith({ unsettled: { requests: 2, openMicros: 140_000 } })).success).toBe(true);
      expect(LaunchView.safeParse(viewWith({ unsettled: { requests: -1, openMicros: 0 } })).success).toBe(false);
      expect(LaunchView.safeParse(viewWith({ unsettled: { requests: 1, openMicros: 0.5 } })).success).toBe(false);
      expect(LaunchView.safeParse(viewWith({ unsettled: { requests: 1 } })).success).toBe(false);
      expect(LaunchView.safeParse(viewWith({ unsettled: { requests: 1, openMicros: 1, extra: 1 } })).success).toBe(false);
    });

    test("money without a request is no reserve", () => {
      expect(LaunchView.safeParse(viewWith({ unsettled: { requests: 0, openMicros: 1 } })).success).toBe(false);
    });

    test("it and what is in flight together never exceed what the launch spent, because both are inside it: a reserve counted twice shows here", () => {
      // spent 1_210_000, in flight 280_000: 930_000 is the most that can be left unsettled.
      expect(LaunchView.safeParse(viewWith({ unsettled: { requests: 3, openMicros: 930_000 } })).success).toBe(true);
      expect(LaunchView.safeParse(viewWith({ unsettled: { requests: 3, openMicros: 930_001 } })).success).toBe(false);
    });

    test("alone it may use all of the spent sum, with nothing in flight", () => {
      expect(LaunchView.safeParse(viewWith({ inFlight: { requests: 0, openMicros: 0 }, unsettled: { requests: 5, openMicros: 1_210_000 } })).success).toBe(true);
      expect(LaunchView.safeParse(viewWith({ inFlight: { requests: 0, openMicros: 0 }, unsettled: { requests: 5, openMicros: 1_210_001 } })).success).toBe(false);
    });
  });

  test.each(["reconcile-required", "halt", "ledger", "key", "budget", "network", "internal"])("a resume can be blocked by %s", (resumeBlockedBy) => {
    expect(LaunchView.safeParse(viewWith({ resumeBlockedBy })).success).toBe(true);
  });

  test("credits, price and price-unavailable never block a resume (§18.7): the click is admitted and the answer decides", () => {
    expect(LaunchView.safeParse(viewWith({ resumeBlockedBy: null })).success).toBe(true);
    for (const reason of ["credits", "price", "price-unavailable", "weather"]) expect(LaunchView.safeParse(viewWith({ resumeBlockedBy: reason })).success).toBe(false);
  });

  test("the log tail is at most 20 lines", () => {
    const line = logLine("paused");
    expect(LaunchView.safeParse(viewWith({ logTail: Array.from({ length: 20 }, () => line) })).success).toBe(true);
    expect(LaunchView.safeParse(viewWith({ logTail: Array.from({ length: 21 }, () => line) })).success).toBe(false);
  });

  test("the rows are the draft's avatars, each once", () => {
    expect(LaunchView.safeParse(viewWith({ avatars: [avatarRow(A)] })).success).toBe(false);
    expect(LaunchView.safeParse(viewWith({ avatars: [avatarRow(A), avatarRow(A)] })).success).toBe(false);
    expect(LaunchView.safeParse(viewWith({ avatars: [avatarRow(A), avatarRow("avatar-other-0003")] })).success).toBe(false);
  });

  test("the waiting-for-music count is a count", () => {
    expect(LaunchView.safeParse(viewWith({ waitingMusic: 3 })).success).toBe(true);
    expect(LaunchView.safeParse(viewWith({ waitingMusic: -1 })).success).toBe(false);
  });

  test("a view with a field of the engine's that the contract lacks is refused", () => {
    expect(LaunchView.safeParse(viewWith({ extra: 1 })).success).toBe(false);
  });
});

describe("LaunchView avatar rows", () => {
  const rowOf = (over: Record<string, unknown>) => LaunchView.safeParse(viewWith({ avatars: [avatarRow(A, over), avatarRow(B)] })).success;

  test.each(["planned", "composing", "awaiting-review", "approved-waiting", "drawing", "montage", "done"])("phase %s needs nothing else", (phase) => {
    expect(rowOf({ phase })).toBe(true);
  });

  test("an unknown phase is refused", () => {
    expect(rowOf({ phase: "sleeping" })).toBe(false);
  });

  test.each(["avatar-busy", "open-set", "paid-hold", "library-unknown"])("a waiting avatar names why: %s", (reason) => {
    expect(rowOf({ phase: "waiting", waiting: { reason } })).toBe(true);
  });

  test("waiting is present exactly in the waiting phase, with a known reason", () => {
    expect(rowOf({ phase: "waiting", waiting: null })).toBe(false);
    expect(rowOf({ phase: "drawing", waiting: { reason: "avatar-busy" } })).toBe(false);
    expect(rowOf({ phase: "waiting", waiting: { reason: "weather" } })).toBe(false);
  });

  test.each(["archived", "master-unusable", "face-gate-unavailable", "descriptor-invalid", "set-unreadable"])("a skipped avatar names why: %s", (reason) => {
    expect(rowOf({ phase: "skipped", skipped: { reason } })).toBe(true);
  });

  test("a skip by failure rate counts its photos; no other skip does", () => {
    expect(rowOf({ phase: "skipped", skipped: { reason: "failure-rate", failed: 3, total: 5 } })).toBe(true);
    expect(rowOf({ phase: "skipped", skipped: { reason: "failure-rate" } })).toBe(false);
    expect(rowOf({ phase: "skipped", skipped: { reason: "archived", failed: 3, total: 5 } })).toBe(false);
    expect(rowOf({ phase: "skipped", skipped: { reason: "failure-rate", failed: 6, total: 5 } })).toBe(false);
  });

  test("skipped is present exactly in the skipped phase", () => {
    expect(rowOf({ phase: "skipped", skipped: null })).toBe(false);
    expect(rowOf({ phase: "drawing", skipped: { reason: "archived" } })).toBe(false);
  });

  test("a set is named with its revision, or with neither", () => {
    expect(rowOf({ sceneSetId: SET, setRevision: 1 })).toBe(true);
    expect(rowOf({ sceneSetId: SET, setRevision: null })).toBe(false);
    expect(rowOf({ sceneSetId: null, setRevision: 3 })).toBe(false);
    expect(rowOf({ setRevision: 0 })).toBe(false);
  });

  test("the scene counts need a set, and the figures are consistent", () => {
    expect(rowOf({ sceneSetId: null, setRevision: null, scenes: 14, scenesWithoutText: null, continuePhotos: null })).toBe(false);
    expect(rowOf({ scenes: 14, scenesWithoutText: 15 })).toBe(false);
    expect(rowOf({ scenes: 14, continuePhotos: 15 })).toBe(false);
    expect(rowOf({ scenes: 14, scenesWithoutText: 2, continuePhotos: 12 })).toBe(true);
  });

  test("progress never counts past its total", () => {
    expect(rowOf({ photos: { done: 15, total: 14 } })).toBe(false);
    expect(rowOf({ montage: { done: 11, total: 10 } })).toBe(false);
    expect(rowOf({ videos: { done: 11, total: 10 } })).toBe(false);
    expect(rowOf({ photos: { done: 14, total: 14 } })).toBe(true);
  });

  test("a slice is numbered inside its total", () => {
    expect(rowOf({ slice: { index: 4, total: 4 } })).toBe(true);
    expect(rowOf({ slice: { index: 5, total: 4 } })).toBe(false);
    expect(rowOf({ slice: { index: 0, total: 4 } })).toBe(false);
    expect(rowOf({ slice: null })).toBe(true);
  });

  test("videos that were dropped say how many and why", () => {
    for (const reason of ["not-enough-photos", "render-failed", "avatar-gone", "launch-stopped", "avatar-skipped"]) expect(rowOf({ dropped: { count: 2, reason } })).toBe(true);
    expect(rowOf({ dropped: { count: 0, reason: "render-failed" } })).toBe(false);
    expect(rowOf({ dropped: { count: 2, reason: "weather" } })).toBe(false);
    expect(rowOf({ dropped: { count: 2 } })).toBe(false);
  });

  test("the draw allocation is the avatar's share of the limit for «в пределах запуска · до $Y», or null with nothing to draw", () => {
    expect(rowOf({ drawAllocationMicros: 1_050_000 })).toBe(true);
    expect(rowOf({ drawAllocationMicros: null })).toBe(true);
    expect(rowOf({ drawAllocationMicros: 1.5 })).toBe(false);
    expect(rowOf({ drawAllocationMicros: -1 })).toBe(false);
    expect(rowOf({ drawAllocationMicros: undefined })).toBe(false);
  });

  test("the numbers the Stop dialog reads are counts", () => {
    expect(rowOf({ undrawnScenes: 40, resumableSlots: 9, waitingMusic: 3 })).toBe(true);
    expect(rowOf({ undrawnScenes: -1 })).toBe(false);
    expect(rowOf({ resumableSlots: 1.5 })).toBe(false);
    expect(rowOf({ waitingMusic: -1 })).toBe(false);
  });
});

// ---------- the summary, the list, the detail ----------

describe("LaunchSummary and autopilot.list", () => {
  test("a summary carries the avatars and the planned worst (the «из» on every screen is W′)", () => {
    const parsed = LaunchSummary.parse(summary);
    expect(LaunchSummary.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(LaunchSummary.safeParse({ ...summary, avatarIds: undefined }).success).toBe(false);
    expect(LaunchSummary.safeParse({ ...summary, plannedWorstMicros: undefined }).success).toBe(false);
  });

  test("a summary keeps its counts consistent", () => {
    expect(LaunchSummary.safeParse({ ...summary, avatarCount: 3 }).success).toBe(false);
    expect(LaunchSummary.safeParse({ ...summary, videosDone: 21 }).success).toBe(false);
    expect(LaunchSummary.safeParse({ ...summary, plannedWorstMicros: 4_140_001 }).success).toBe(false);
    expect(LaunchSummary.safeParse({ ...summary, status: "done" }).success).toBe(false);
    expect(LaunchSummary.safeParse({ ...summary, status: "done", endedAt: LATER }).success).toBe(true);
  });

  const unreadable = { entryId: "0123456789abcdef", reason: "invalid" };

  test("the list answers summaries and unreadable entries by opaque id", () => {
    expect(answers("autopilot.list", { launches: [summary], unreadable: [unreadable] })).toBe(true);
    expect(answers("autopilot.list", { launches: [], unreadable: [] })).toBe(true);
    for (const reason of ["invalid", "too-new", "io-error"]) expect(answers("autopilot.list", { launches: [], unreadable: [{ entryId: "0123456789abcdef", reason }] })).toBe(true);
    expect(answers("autopilot.list", { launches: [], unreadable: [{ entryId: "launch-0a1b2c3d4e5f.json", reason: "invalid" }] })).toBe(false);
    expect(answers("autopilot.list", { launches: [], unreadable: [{ entryId: "0123456789abcdef", reason: "weather" }] })).toBe(false);
    expect(answers("autopilot.list", { launches: [summary] })).toBe(false);
  });

  test("the list is bounded at 200 launches", () => {
    expect(MAX_LISTED_LAUNCHES).toBe(200);
    expect(answers("autopilot.list", { launches: Array.from({ length: 200 }, () => summary), unreadable: [] })).toBe(true);
    expect(answers("autopilot.list", { launches: Array.from({ length: 201 }, () => summary), unreadable: [] })).toBe(false);
    expect(answers("autopilot.list", { launches: [], unreadable: Array.from({ length: 201 }, () => unreadable) })).toBe(false);
  });
});

describe("autopilot.get", () => {
  const detail = (over: Record<string, unknown> = {}) => ({ launch: view, log: [logLine("paused")], videos: [video("0-1")], ...over });

  test("answers the launch, its log and its videos", () => {
    expect(answers("autopilot.get", detail())).toBe(true);
    expect(answers("autopilot.get", detail({ videos: [], log: [] }))).toBe(true);
    expect(answers("autopilot.get", { launch: view, log: [] })).toBe(false);
  });

  test("the log is at most 500 lines", () => {
    expect(answers("autopilot.get", detail({ log: Array.from({ length: 500 }, () => logLine("paused")) }))).toBe(true);
    expect(answers("autopilot.get", detail({ log: Array.from({ length: 501 }, () => logLine("paused")) }))).toBe(false);
  });

  test("a finished video is whole: file, length, size and track; a published one says when", () => {
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { publishedAt: LATER })] }))).toBe(true);
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { videoId: null })] }))).toBe(false);
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { bytes: null })] }))).toBe(false);
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { durationMs: null })] }))).toBe(false);
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { track: null })] }))).toBe(false);
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { durationMs: 10_001 })] }))).toBe(false);
  });

  test("a rendering video has its file id and no size yet", () => {
    expect(answers("autopilot.get", detail({ videos: [video("0-2", { state: "rendering", bytes: null, publishedAt: null })] }))).toBe(true);
    expect(answers("autopilot.get", detail({ videos: [video("0-2", { state: "rendering", bytes: null, videoId: null })] }))).toBe(false);
    expect(answers("autopilot.get", detail({ videos: [video("0-2", { state: "rendering", bytes: null, publishedAt: LATER })] }))).toBe(false);
  });

  test("a video waiting for music has no file and no track", () => {
    const waiting = { state: "waiting-music", videoId: null, bytes: null, durationMs: null, track: null };
    expect(answers("autopilot.get", detail({ videos: [video("0-3", waiting)] }))).toBe(true);
    expect(answers("autopilot.get", detail({ videos: [video("0-3", { ...waiting, videoId: "video-0000000b" })] }))).toBe(false);
    expect(answers("autopilot.get", detail({ videos: [video("0-3", { ...waiting, track: { source: "own", title: "x.m4a", artist: null } })] }))).toBe(false);
  });

  test("a dropped video may have had a file id (its render was submitted), but never a size", () => {
    const dropped = { state: "dropped", videoId: "video-0000000d", bytes: null, durationMs: null, track: null, dropReason: "render-failed" };
    expect(answers("autopilot.get", detail({ videos: [video("0-4", dropped)] }))).toBe(true);
    expect(answers("autopilot.get", detail({ videos: [video("0-4", { ...dropped, bytes: 1_000 })] }))).toBe(false);
  });

  test("a dropped video names why, and only a dropped one does", () => {
    const dropped = { state: "dropped", videoId: null, bytes: null, durationMs: null, track: null, dropReason: "not-enough-photos" };
    expect(answers("autopilot.get", detail({ videos: [video("0-4", dropped)] }))).toBe(true);
    expect(answers("autopilot.get", detail({ videos: [video("0-4", { ...dropped, dropReason: null })] }))).toBe(false);
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { dropReason: "render-failed" })] }))).toBe(false);
    expect(answers("autopilot.get", detail({ videos: [video("0-4", { ...dropped, dropReason: "weather" })] }))).toBe(false);
  });

  test("a shape has its own sizes: one photo, a collage of 2 to 4, slides of 5 to 7", () => {
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { shape: "single", size: 1 })] }))).toBe(true);
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { shape: "slides", size: 7 })] }))).toBe(true);
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { shape: "single", size: 3 })] }))).toBe(false);
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { shape: "collage", size: 5 })] }))).toBe(false);
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { shape: "slides", size: 4 })] }))).toBe(false);
    expect(LogLine.safeParse(logLine("video-done", { shape: "slides", size: 3 })).success).toBe(false);
  });

  test("a state outside the four, a shape outside the three, a duplicate key and a size outside 1..7 are refused", () => {
    expect(answers("autopilot.get", detail())).toBe(true);
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { state: "planned" })] }))).toBe(false);
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { shape: "reel" })] }))).toBe(false);
    expect(answers("autopilot.get", detail({ videos: [video("0-1"), video("0-1", { videoId: "video-0000000c" })] }))).toBe(false);
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { size: 8 })] }))).toBe(false);
    expect(answers("autopilot.get", detail({ videos: [video("0-1", { size: 0 })] }))).toBe(false);
  });
});

describe("the other autopilot answers", () => {
  test("start, pause, resume and stop answer the launch", () => {
    for (const type of ["autopilot.start", "autopilot.pause", "autopilot.resume", "autopilot.stop"] as const) {
      expect(answers(type, { launch: view })).toBe(true);
      expect(answers(type, {})).toBe(false);
    }
  });

  test("continueAfterReview says whether the draw starts now or waits for «Продолжить»", () => {
    expect(answers("autopilot.continueAfterReview", { launch: view, draw: "started" })).toBe(true);
    expect(answers("autopilot.continueAfterReview", { launch: view, draw: "waits-for-resume" })).toBe(true);
    expect(answers("autopilot.continueAfterReview", { launch: view, draw: "maybe" })).toBe(false);
    expect(answers("autopilot.continueAfterReview", { launch: view })).toBe(false);
  });

  test("removeUnreadable answers nothing", () => {
    expect(answers("autopilot.removeUnreadable", {})).toBe(true);
    expect(answers("autopilot.removeUnreadable", { removed: true })).toBe(false);
  });
});

// ---------- the preview ----------

describe("LaunchPreview", () => {
  test("accepts a preview and round-trips it", () => {
    const parsed = LaunchPreview.parse(preview);
    expect(LaunchPreview.parse(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
    expect(answers("autopilot.estimate", { preview })).toBe(true);
  });

  test("the fixed pieces of the estimate: price source and its date", () => {
    expect(LaunchPreview.safeParse(previewWith({ estimate: { ...preview.estimate, prices: "fallback" } })).success).toBe(true);
    expect(LaunchPreview.safeParse(previewWith({ estimate: { ...preview.estimate, prices: "guess" } })).success).toBe(false);
    expect(LaunchPreview.safeParse(previewWith({ estimate: { ...preview.estimate, expectedMicros: 3_000_001 } })).success).toBe(false);
    expect(LaunchPreview.safeParse(previewWith({ estimate: { ...preview.estimate, worstMicros: 3_000_000.5 } })).success).toBe(false);
  });

  test("the balance and the free disk are optional knowledge: null is a normal answer", () => {
    expect(LaunchPreview.safeParse(previewWith({ balance: null })).success).toBe(true);
    expect(LaunchPreview.safeParse(previewWith({ disk: { neededBytes: 9_000_000, freeBytes: null } })).success).toBe(true);
    expect(LaunchPreview.safeParse(previewWith({ balance: { micros: -1, asOf: NOW } })).success).toBe(false);
    expect(LaunchPreview.safeParse(previewWith({ balance: { micros: 1, asOf: "now" } })).success).toBe(false);
  });

  describe("the month's fit follows from its numbers (§4.4)", () => {
    const monthOf = (freeMicros: number, fit: string) => {
      const room = { budgetMicros: 10_000_000, committedMicros: 10_000_000 - freeMicros, freeMicros };
      return { ...room, fit, raiseToMicros: raiseBudgetToMicros(room, preview.estimate.worstMicros) };
    };
    const fitted = (freeMicros: number, fit: string) => LaunchPreview.safeParse(previewWith({ month: monthOf(freeMicros, fit) })).success;

    test("fits when the room covers the worst case", () => {
      expect(fitted(3_000_000, "fits")).toBe(true);
      expect(fitted(2_999_999, "fits")).toBe(false);
    });

    test("fits-expected when the room covers the expected cost and not the worst", () => {
      expect(fitted(2_999_999, "fits-expected")).toBe(true);
      expect(fitted(700_000, "fits-expected")).toBe(true);
      expect(fitted(3_000_000, "fits-expected")).toBe(false);
      expect(fitted(699_999, "fits-expected")).toBe(false);
    });

    test("short when the room is below the expected cost", () => {
      expect(fitted(699_999, "short")).toBe(true);
      expect(fitted(700_000, "short")).toBe(false);
    });

    test("a free launch always fits", () => {
      const free = previewWith({
        estimate: { expectedMicros: 0, worstMicros: 0, prices: "live", pricesAsOf: "2026-10-08" },
        month: { budgetMicros: 10_000_000, committedMicros: 10_000_000, freeMicros: 0, fit: "fits", raiseToMicros: null },
      });
      expect(LaunchPreview.safeParse(free).success).toBe(true);
    });

    test("the raise «поднимите бюджет до $X» is the engine's: the budget in whole dollars that covers the worst case, null when it fits", () => {
      // W $3.00 with $2.999999 free: committed $7.000001 + W = $10.000001 → $11.
      expect(monthOf(2_999_999, "fits-expected").raiseToMicros).toBe(11_000_000);
      expect(fitted(2_999_999, "fits-expected")).toBe(true);
      expect(LaunchPreview.safeParse(previewWith({ month: { ...monthOf(2_999_999, "fits-expected"), raiseToMicros: 10_000_000 } })).success).toBe(false);
      expect(LaunchPreview.safeParse(previewWith({ month: { ...monthOf(2_999_999, "fits-expected"), raiseToMicros: 10_500_000 } })).success).toBe(false);
      expect(LaunchPreview.safeParse(previewWith({ month: { ...monthOf(3_000_000, "fits"), raiseToMicros: 3_000_000 } })).success).toBe(false);
      expect(LaunchPreview.safeParse(previewWith({ month: { ...monthOf(699_999, "short"), raiseToMicros: null } })).success).toBe(false);
      const { raiseToMicros: _gone, ...without } = preview.month;
      expect(LaunchPreview.safeParse(previewWith({ month: without })).success).toBe(false);
    });

    test("an unknown fit and a room that is not budget less committed are refused", () => {
      expect(fitted(3_000_000, "plenty")).toBe(false);
      expect(LaunchPreview.safeParse(previewWith({ month: { ...preview.month, freeMicros: 8_360_001 } })).success).toBe(false);
      expect(LaunchPreview.safeParse(previewWith({ month: { budgetMicros: 1_000_000, committedMicros: 2_000_000, freeMicros: 0, fit: "short", raiseToMicros: 5_000_000 } })).success).toBe(true);
    });
  });

  test("the rows: shapes add up to the videos, and every figure is a count", () => {
    const rows = (over: Record<string, unknown>) => LaunchPreview.safeParse(previewWith({ avatars: [previewRow(A, over), previewRow(B, { free: 4, fromLibrary: 4, toGenerate: 10, busy: true })] })).success;
    expect(rows({})).toBe(true);
    expect(rows({ shapes: { single: 7, collage: 2, slides: 2 } })).toBe(false);
    expect(rows({ videos: 51, shapes: { single: 51, collage: 0, slides: 0 } })).toBe(false);
    expect(rows({ free: -1 })).toBe(false);
    expect(rows({ toGenerate: 1.5 })).toBe(false);
    expect(rows({ busy: "yes" })).toBe(false);
  });

  test("the totals are the sums over the rows that are not blocked (a blocked avatar counts for nothing)", () => {
    expect(LaunchPreview.safeParse(previewWith({ totals: { ...preview.totals, videos: 19 } })).success).toBe(false);
    expect(LaunchPreview.safeParse(previewWith({ totals: { ...preview.totals, fromLibrary: 17, photosNeeded: 27 } })).success).toBe(false);
    expect(LaunchPreview.safeParse(previewWith({ totals: { ...preview.totals, photosNeeded: 29 } })).success).toBe(false);
    const blocked = previewWith({
      avatars: [previewRow(A), previewRow(B, { blocked: "too-many-photos", videos: 10, fromLibrary: 0, toGenerate: 104, free: 0 })],
      totals: { videos: 10, photosNeeded: 14, fromLibrary: 14, toGenerate: 0 },
      blockers: [{ code: "too-many-photos", avatarId: B }],
    });
    expect(LaunchPreview.safeParse(blocked).success).toBe(true);
  });

  test("an avatar-level blocker names its avatar and a launch-level one names none", () => {
    for (const code of ["open-set", "too-many-photos", "usage-unknown"]) {
      expect(LaunchPreview.safeParse(previewWith({ blockers: [{ code, avatarId: A }] })).success).toBe(true);
      expect(LaunchPreview.safeParse(previewWith({ blockers: [{ code }] })).success).toBe(false);
    }
    for (const code of ["launch-active", "launch-unreadable", "no-key", "nothing-enabled", "reconcile-required", "halt", "ledger", "export-unavailable"]) {
      expect(LaunchPreview.safeParse(previewWith({ blockers: [{ code }] })).success).toBe(true);
      expect(LaunchPreview.safeParse(previewWith({ blockers: [{ code, avatarId: A }] })).success).toBe(false);
    }
    expect(LaunchPreview.safeParse(previewWith({ blockers: [{ code: "weather" }] })).success).toBe(false);
  });

  test("a blocked row says why, from the three avatar reasons", () => {
    const row = (blocked: unknown) => LaunchPreview.safeParse(previewWith({ avatars: [previewRow(A, { blocked }), previewRow(B, { free: 4, fromLibrary: 4, toGenerate: 10, busy: true })] })).success;
    expect(row("open-set")).toBe(false);
    // A blocked row leaves the totals: the base totals still count it, so the preview is refused until they agree.
    const consistent = (blocked: string) =>
      LaunchPreview.safeParse(
        previewWith({
          avatars: [previewRow(A, { blocked, fromLibrary: 0, toGenerate: 0 }), previewRow(B, { free: 4, fromLibrary: 4, toGenerate: 10, busy: true })],
          totals: { videos: 10, photosNeeded: 14, fromLibrary: 4, toGenerate: 10 },
          blockers: [{ code: blocked, avatarId: A }],
        }),
      ).success;
    for (const blocked of ["open-set", "too-many-photos", "usage-unknown"]) expect(consistent(blocked)).toBe(true);
    expect(row("weather")).toBe(false);
  });

  test("the usage of an avatar is the contract's own, with its reasons", () => {
    const usage = { state: "unknown", reasons: ["index-stale"] };
    const rowB = previewRow(B, { free: 4, fromLibrary: 4, toGenerate: 10, busy: true });
    // An avatar whose usage cannot be trusted gives no library photos (§18.6): free and fromLibrary are 0, and the plan generates what it needs.
    const unknownA = previewRow(A, { usage, free: 0, fromLibrary: 0, toGenerate: 10 });
    const totals = { videos: 20, photosNeeded: 24, fromLibrary: 4, toGenerate: 20 };
    expect(LaunchPreview.safeParse(previewWith({ avatars: [unknownA, rowB], totals })).success).toBe(true);
    expect(LaunchPreview.safeParse(previewWith({ avatars: [previewRow(A, { usage, free: 31, fromLibrary: 14 }), rowB] })).success).toBe(false);
    expect(LaunchPreview.safeParse(previewWith({ avatars: [previewRow(A, { usage, free: 0, fromLibrary: 14, toGenerate: 0 }), rowB], totals: { ...totals, fromLibrary: 18, toGenerate: 10, photosNeeded: 28 } })).success).toBe(false);
    expect(LaunchPreview.safeParse(previewWith({ avatars: [previewRow(A, { usage, free: 31, fromLibrary: 0, toGenerate: 10 }), rowB], totals })).success).toBe(false);
    expect(LaunchPreview.safeParse(previewWith({ avatars: [previewRow(A, { usage: { state: "unknown", reasons: [] } }), previewRow(B)] })).success).toBe(false);
  });

  test("the music line names the quota left and how the trends will be refreshed", () => {
    for (const autoRefresh of ["will", "not-needed", "no-quota", "no-key"]) expect(LaunchPreview.safeParse(previewWith({ music: { ...preview.music, autoRefresh } })).success).toBe(true);
    expect(LaunchPreview.safeParse(previewWith({ music: { ...preview.music, autoRefresh: "maybe" } })).success).toBe(false);
    expect(LaunchPreview.safeParse(previewWith({ music: { ...preview.music, quotaRemaining: null } })).success).toBe(true);
    expect(LaunchPreview.safeParse(previewWith({ music: { ...preview.music, quotaRemaining: 31 } })).success).toBe(false);
    expect(LaunchPreview.safeParse(previewWith({ music: { ...preview.music, candidates: -1 } })).success).toBe(false);
  });

  test("the per-shape prices are micro-dollars", () => {
    expect(LaunchPreview.safeParse(previewWith({ perShapeExpectedMicros: { single: 70_000, collage: 210_000.5, slides: 350_000 } })).success).toBe(false);
    expect(LaunchPreview.safeParse(previewWith({ perShapeExpectedMicros: { single: 70_000, collage: 210_000 } })).success).toBe(false);
  });
});

// ---------- events and the snapshot ----------

describe("autopilot.changed and Snapshot.autopilot", () => {
  const event = (payload: unknown) => ({ v: PROTOCOL_VERSION, id: "evt-00000001", kind: "event", seq: 1, bootId: "boot-00000001", type: "autopilot.changed", payload });

  test("the event carries the whole launch", () => {
    expect(EventMessage.safeParse(event({ launch: view })).success).toBe(true);
    expect(EventMessage.safeParse(event({})).success).toBe(false);
    expect(EventMessage.safeParse(event({ launch: { ...view, status: "sleeping" } })).success).toBe(false);
    expect(EventMessage.safeParse(event({ launch: view, extra: 1 })).success).toBe(false);
  });

  test("the snapshot may carry the active launch, null or nothing (an older producer)", () => {
    expect(Snapshot.shape.autopilot.safeParse(view).success).toBe(true);
    expect(Snapshot.shape.autopilot.safeParse(null).success).toBe(true);
    expect(Snapshot.shape.autopilot.safeParse(undefined).success).toBe(true);
    expect(Snapshot.shape.autopilot.safeParse({ ...view, status: "sleeping" }).success).toBe(false);
  });
});
