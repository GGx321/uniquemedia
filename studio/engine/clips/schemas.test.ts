import { describe, expect, test } from "bun:test";
import { CLIPS_DIR, CLIP_RECORD_SCHEMA_VERSION, isFromNewerVersion, VIDEOS_DIR } from "../library/layout";
import { ClipJournalLine, ClipRecord, parseClipJournalLine } from "./schemas";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// Stage 5, 5b.1, S5.V1 (plan s5b1 §5.3, §8): where clips live on disk and the shape of what is written there. The record is the commit (I5.53); the journal is
// append-only, one fsynced line per event (I5.45). Both are read from disk, so both are strict: a file that does not parse is not a record.

const AT = "2026-10-13T10:00:00.000Z";
const ID = "clip-0000001";

const motion = { source: "scene", label: "Как в сцене", text: "she slowly lifts the cup" };
const request = { model: "kling", quality: "std", seconds: 5, fallback: "auto" };
const face = { verdict: "match", p75: 0.71, frames: 11 };
const attempt = { attemptId: `${ID}:video#1`, providerJobId: "job-abc123", outcome: "completed", providerCostMicros: 420_000, costSource: "usage" };
const exported = { rootId: "root-00000001", relPath: "Nini/2026-10-13_clip_001.mp4", profile: "1080p30-interp", at: AT, bytes: 4_000_000, sha256: "a".repeat(64) };

const base = { schemaVersion: 1, id: ID, avatarId: "avatar-aaaa-0001", sourcePhotoId: "photo-0001", createdAt: AT, seen: false, motion, request, recovered: false, exports: [] as unknown[] };
const ready = {
  ...base,
  provider: { model: "kling-std", attempts: [attempt] },
  outcome: { status: "ready", file: `${ID}.mp4`, posterFile: `${ID}.poster.jpg`, width: 720, height: 1280, durationMs: 5_000, fps: 24, bytes: 6_000_000, sha256: "b".repeat(64), face },
};
const failed = {
  ...base,
  provider: { model: "kling-std", attempts: [{ attemptId: `${ID}:video#1`, outcome: "refused", providerCostMicros: 0, costSource: "proof" }] },
  outcome: { status: "failed", reason: "refused-free" },
};

describe("CLIPS_DIR", () => {
  test("is `clips`, beside `videos` in the avatar's folder", () => {
    expect(CLIPS_DIR).toBe("clips");
    expect(CLIPS_DIR).not.toBe(VIDEOS_DIR);
  });

  test("the record's schema version is 1, and a newer one is recognised as newer", () => {
    expect(CLIP_RECORD_SCHEMA_VERSION).toBe(1);
    expect(isFromNewerVersion({ schemaVersion: 2 }, CLIP_RECORD_SCHEMA_VERSION)).toBe(true);
    expect(isFromNewerVersion({ schemaVersion: 1 }, CLIP_RECORD_SCHEMA_VERSION)).toBe(false);
  });
});

describe("ClipRecord", () => {
  test("a ready clip parses", () => {
    expect(ClipRecord.safeParse(ready).success).toBe(true);
  });

  test("a failed clip parses", () => {
    expect(ClipRecord.safeParse(failed).success).toBe(true);
  });

  test("schemaVersion is 1 and nothing else (a newer record is refused, never half-read)", () => {
    expect(ClipRecord.safeParse({ ...ready, schemaVersion: 2 }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, schemaVersion: 0 }).success).toBe(false);
    const { schemaVersion: _version, ...none } = ready;
    expect(ClipRecord.safeParse(none).success).toBe(false);
  });

  test("it is strict: a key it does not know is refused", () => {
    expect(ClipRecord.safeParse({ ...ready, extra: 1 }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, outcome: { ...ready.outcome, extra: 1 } }).success).toBe(false);
  });

  test("it has no money field: the cost is read from the ledger when the clip is listed (I5.49)", () => {
    for (const key of ["cost", "costMicros", "spentMicros", "billedMicros"]) expect(ClipRecord.safeParse({ ...ready, [key]: 420_000 }).success).toBe(false);
  });

  test("the file names are the clip id's own, so a record can never point outside the clips folder", () => {
    expect(ClipRecord.safeParse({ ...ready, outcome: { ...ready.outcome, file: "../../other.mp4" } }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, outcome: { ...ready.outcome, file: "clip-0000002.mp4" } }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, outcome: { ...ready.outcome, posterFile: "/etc/passwd" } }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, outcome: { ...ready.outcome, posterFile: `${ID}.mp4` } }).success).toBe(false);
  });

  test("the ids are the library's: a path character is refused", () => {
    expect(ClipRecord.safeParse({ ...ready, id: "../clip" }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, avatarId: "a/b" }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, sourcePhotoId: "photo 1" }).success).toBe(false);
  });

  test("a ready clip needs every fact of its file", () => {
    for (const key of ["file", "posterFile", "width", "height", "durationMs", "fps", "bytes", "sha256", "face"]) {
      const { [key]: _removed, ...rest } = ready.outcome as Record<string, unknown>;
      expect(ClipRecord.safeParse({ ...ready, outcome: rest }).success).toBe(false);
    }
  });

  test("the file facts are positive whole numbers and the sha256 is 64 lowercase hex characters", () => {
    expect(ClipRecord.safeParse({ ...ready, outcome: { ...ready.outcome, width: 0 } }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, outcome: { ...ready.outcome, bytes: 1.5 } }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, outcome: { ...ready.outcome, durationMs: -1 } }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, outcome: { ...ready.outcome, sha256: "B".repeat(64) } }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, outcome: { ...ready.outcome, fps: 0 } }).success).toBe(false);
  });

  test("a failed clip names its reason and carries no file facts", () => {
    expect(ClipRecord.safeParse({ ...failed, outcome: { status: "failed" } }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...failed, outcome: { status: "failed", reason: "melted" } }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...failed, outcome: { ...failed.outcome, file: `${ID}.mp4` } }).success).toBe(false);
  });

  test("a failed clip may carry the time a download can still be retried, for a paid failure only", () => {
    for (const reason of ["download-failed", "invalid-file", "disk-full"]) {
      expect(ClipRecord.safeParse({ ...failed, outcome: { status: "failed", reason, retryDownloadUntil: "2026-10-13T11:00:00.000Z" } }).success).toBe(true);
    }
    expect(ClipRecord.safeParse({ ...failed, outcome: { status: "failed", reason: "refused-free", retryDownloadUntil: "2026-10-13T11:00:00.000Z" } }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...failed, outcome: { status: "failed", reason: "download-failed", retryDownloadUntil: "tomorrow" } }).success).toBe(false);
  });

  test("a failed clip has nothing exported", () => {
    expect(ClipRecord.safeParse({ ...failed, exports: [exported] }).success).toBe(false);
  });

  test("a ready clip lists its exports, each with the profile that made the file", () => {
    for (const profile of ["1080p30-interp", "1080p30-dup", "1080p24"]) {
      expect(ClipRecord.safeParse({ ...ready, exports: [{ ...exported, profile }] }).success).toBe(true);
    }
    expect(ClipRecord.safeParse({ ...ready, exports: [{ ...exported, profile: "reencode-1080p30" }] }).success).toBe(false);
  });

  test("an export line is written once: the computed file state never lands on disk", () => {
    expect(ClipRecord.safeParse({ ...ready, exports: [{ ...exported, fileState: "present" }] }).success).toBe(false);
  });

  test("an export line holds a relative path, never an absolute one", () => {
    expect(ClipRecord.safeParse({ ...ready, exports: [{ ...exported, relPath: "/Users/alex/Studio/export/Nini/x.mp4" }] }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, exports: [{ ...exported, relPath: "../x_clip_001.mp4" }] }).success).toBe(false);
  });

  test("the provider block names the model and its attempts (none, one, or Kling then Grok)", () => {
    expect(ClipRecord.safeParse({ ...ready, provider: { model: "kling-std", attempts: [] } }).success).toBe(true);
    const grok = { attemptId: `${ID}:video#2`, providerJobId: "job-def456", outcome: "completed", costSource: "usage" };
    const refused = { attemptId: `${ID}:video#1`, outcome: "refused", costSource: "proof" };
    expect(ClipRecord.safeParse({ ...ready, provider: { model: "grok", attempts: [refused, grok] } }).success).toBe(true);
    expect(ClipRecord.safeParse({ ...ready, provider: { model: "grok", attempts: [refused, grok, grok] } }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, provider: { model: "seedance", attempts: [] } }).success).toBe(false);
  });

  test("an attempt's outcome and cost source are closed sets", () => {
    for (const outcome of ["completed", "failed", "cancelled", "expired", "refused", "uncertain", "late"]) {
      expect(ClipRecord.safeParse({ ...ready, provider: { model: "kling-std", attempts: [{ ...attempt, outcome }] } }).success).toBe(true);
    }
    for (const costSource of ["usage", "generation", "proof", "worst", "none"]) {
      expect(ClipRecord.safeParse({ ...ready, provider: { model: "kling-std", attempts: [{ ...attempt, costSource }] } }).success).toBe(true);
    }
    expect(ClipRecord.safeParse({ ...ready, provider: { model: "kling-std", attempts: [{ ...attempt, outcome: "billed" }] } }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, provider: { model: "kling-std", attempts: [{ ...attempt, costSource: "guess" }] } }).success).toBe(false);
  });

  test("the provider's job id is an opaque token, never a URL or a path", () => {
    expect(ClipRecord.safeParse({ ...ready, provider: { model: "kling-std", attempts: [{ ...attempt, providerJobId: "https://openrouter.ai/x" }] } }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, provider: { model: "kling-std", attempts: [{ ...attempt, providerJobId: "../x" }] } }).success).toBe(false);
  });

  test("the provider's cost is a whole number of micro-dollars", () => {
    expect(ClipRecord.safeParse({ ...ready, provider: { model: "kling-std", attempts: [{ ...attempt, providerCostMicros: 420_000.5 }] } }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, provider: { model: "kling-std", attempts: [{ ...attempt, providerCostMicros: -1 }] } }).success).toBe(false);
  });

  test("the request and the motion are what the owner chose", () => {
    expect(ClipRecord.safeParse({ ...ready, request: { ...request, seconds: 7 } }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, motion: { ...motion, text: "" } }).success).toBe(false);
  });
});

// Stage 5, 5b.2, S5.WB1 (plan s5b2 I5.63, r2 change L9): the record of a batch member carries the batch id, so the «Клипы» tab's header counts from records once the member jobs leave KEEP_FINISHED.
// Additive and optional: a record written by 5b.1 has none and parses unchanged, at the same schema version.
describe("ClipRecord.batchId", () => {
  const BATCH = "batch-00000001";

  test("a record written before 5b.2 parses and gains no key, ready or failed", () => {
    expect("batchId" in ClipRecord.parse(ready)).toBe(false);
    expect("batchId" in ClipRecord.parse(failed)).toBe(false);
  });

  // The batch header survives KEEP_FINISHED and a restart from records alone: the window counts members by DISTINCT batchIndex (a 429 requeue gives two records for one photo) and says
  // «не снимались N» as batchSize minus the members that have a record.
  const TRIO = { batchId: BATCH, batchIndex: 3, batchSize: 10 };

  test("the trio batchId, batchIndex and batchSize parses together, ready or failed, at schema version 1", () => {
    expect(ClipRecord.parse({ ...ready, ...TRIO })).toMatchObject({ schemaVersion: 1, ...TRIO });
    expect(ClipRecord.parse({ ...failed, ...TRIO })).toMatchObject(TRIO);
  });

  test("any partial trio is refused", () => {
    for (const key of Object.keys(TRIO)) {
      const { [key]: _gone, ...two } = TRIO as Record<string, unknown>;
      expect(ClipRecord.safeParse({ ...ready, ...two }).success).toBe(false);
      expect(ClipRecord.safeParse({ ...ready, [key]: (TRIO as Record<string, unknown>)[key] }).success).toBe(false);
    }
  });

  test("the place is one-based and within the size; the size is one to twenty", () => {
    expect(ClipRecord.safeParse({ ...ready, ...TRIO, batchIndex: 10 }).success).toBe(true);
    expect(ClipRecord.safeParse({ ...ready, ...TRIO, batchIndex: 11 }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, ...TRIO, batchIndex: 0 }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, batchId: BATCH, batchIndex: 20, batchSize: 20 }).success).toBe(true);
    expect(ClipRecord.safeParse({ ...ready, batchId: BATCH, batchIndex: 1, batchSize: 21 }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, ...TRIO, batchIndex: 1.5 }).success).toBe(false);
  });

  test("a batch id is an id: a path or an empty string is refused", () => {
    expect(ClipRecord.safeParse({ ...ready, ...TRIO, batchId: "../batch" }).success).toBe(false);
    expect(ClipRecord.safeParse({ ...ready, ...TRIO, batchId: "" }).success).toBe(false);
  });
});

describe("the journal lines", () => {
  const requested = { type: "requested", clipId: ID, photoId: "photo-0001", request, motion, acceptedWorstMicros: 850_000, at: AT };
  const submitted = { type: "submitted", attemptId: `${ID}:video#1`, model: "kling", providerJobId: "job-abc123", at: AT };
  const ended = { type: "ended", attemptId: `${ID}:video#1`, status: "completed", providerCostMicros: 420_000, costSource: "usage", at: AT };
  const downloaded = { type: "downloaded", sha256: "c".repeat(64), bytes: 6_000_000 };

  test("requested, submitted, ended and downloaded parse", () => {
    for (const line of [requested, submitted, ended, downloaded]) expect(ClipJournalLine.safeParse(line).success).toBe(true);
  });

  test("each line is strict", () => {
    for (const line of [requested, submitted, ended, downloaded]) expect(ClipJournalLine.safeParse({ ...line, extra: 1 }).success).toBe(false);
  });

  test("requested carries the accepted worst case as whole micro-dollars", () => {
    expect(ClipJournalLine.safeParse({ ...requested, acceptedWorstMicros: 850_000.5 }).success).toBe(false);
    expect(ClipJournalLine.safeParse({ ...requested, acceptedWorstMicros: -1 }).success).toBe(false);
    const { acceptedWorstMicros: _worst, ...none } = requested;
    expect(ClipJournalLine.safeParse(none).success).toBe(false);
  });

  test("submitted names the attempt, the model and the provider's job", () => {
    expect(ClipJournalLine.safeParse({ ...submitted, model: "grok" }).success).toBe(true);
    expect(ClipJournalLine.safeParse({ ...submitted, model: "seedance" }).success).toBe(false);
    const { providerJobId: _job, ...none } = submitted;
    expect(ClipJournalLine.safeParse(none).success).toBe(false);
  });

  test("ended takes each of the seven statuses and no other", () => {
    for (const status of ["completed", "failed", "cancelled", "expired", "refused", "uncertain", "late"]) expect(ClipJournalLine.safeParse({ ...ended, status }).success).toBe(true);
    expect(ClipJournalLine.safeParse({ ...ended, status: "done" }).success).toBe(false);
  });

  test("ended carries its time: the hold of a late completed (terminal + 2 min) is read from it after a restart", () => {
    const { at: _at, ...noAt } = ended;
    expect(ClipJournalLine.safeParse(noAt).success).toBe(false);
    expect(ClipJournalLine.safeParse({ ...ended, at: "later" }).success).toBe(false);
  });

  test("ended may name the reason a POST was refused, and only a known fail reason (VR item 2: a restart reads it)", () => {
    const refusedAtPost = { type: "ended", attemptId: `${ID}:video#1`, status: "failed", costSource: "none", at: AT };
    expect(ClipJournalLine.safeParse({ ...refusedAtPost, failReason: "rate-limited" }).success).toBe(true);
    expect(ClipJournalLine.safeParse(refusedAtPost).success).toBe(true);
    expect(ClipJournalLine.safeParse({ ...refusedAtPost, failReason: "rate limited" }).success).toBe(false);
  });

  test("ended's failReason is exactly what a refused POST can name: lost, refused-paid and the other reasons are refused", () => {
    const refusedAtPost = { type: "ended", attemptId: `${ID}:video#1`, status: "failed", costSource: "none", at: AT };
    for (const failReason of ["rate-limited", "key-invalid", "no-credits", "bad-request"]) expect(ClipJournalLine.safeParse({ ...refusedAtPost, failReason }).success).toBe(true);
    for (const failReason of ["lost", "refused-paid", "refused-free", "submit-uncertain", "provider-error", "late"]) expect(ClipJournalLine.safeParse({ ...refusedAtPost, failReason }).success).toBe(false);
  });

  test("ended's provider cost is optional and its cost source is required", () => {
    const { providerCostMicros: _cost, ...noCost } = ended;
    expect(ClipJournalLine.safeParse(noCost).success).toBe(true);
    const { costSource: _source, ...noSource } = ended;
    expect(ClipJournalLine.safeParse(noSource).success).toBe(false);
  });

  test("downloaded carries the file's hash and size", () => {
    expect(ClipJournalLine.safeParse({ ...downloaded, sha256: "nope" }).success).toBe(false);
    expect(ClipJournalLine.safeParse({ ...downloaded, bytes: 0 }).success).toBe(false);
  });

  test("a time, where a line has one, is a real time", () => {
    expect(ClipJournalLine.safeParse({ ...requested, at: "now" }).success).toBe(false);
    expect(ClipJournalLine.safeParse({ ...submitted, at: "now" }).success).toBe(false);
  });
});

describe("parseClipJournalLine: an unknown line is skipped, not fatal", () => {
  test("a known line gives the line", () => {
    expect(parseClipJournalLine({ type: "downloaded", sha256: "c".repeat(64), bytes: 10 })).toEqual({ type: "downloaded", sha256: "c".repeat(64), bytes: 10 });
  });

  test("a line of a kind this build does not know gives null", () => {
    expect(parseClipJournalLine({ type: "enhanced", sha256: "c".repeat(64) })).toBeNull();
  });

  test("a known kind with a broken body gives null too, and never throws", () => {
    expect(parseClipJournalLine({ type: "submitted", attemptId: "x" })).toBeNull();
  });

  test("anything that is not an object gives null", () => {
    for (const raw of [null, undefined, 5, "text", [], true]) expect(parseClipJournalLine(raw)).toBeNull();
  });
});
