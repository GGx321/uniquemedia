import { describe, expect, test } from "bun:test";
import { PROTOCOL_VERSION } from "./envelope";
import { EngineError } from "./errors";
import * as errorTexts from "./errorMessagesRu";
import { parseMessage } from "./messages";
import { AvatarSummary, JobCancelled, JobFailed, JobProgress, JobResult, JobState } from "./state";
import * as contract from ".";

// Stage 5, S5.3a: the «reference portrait» contract. Everything is driven through the contract's public doors (a command message, a response, a job event, a snapshot's
// job), so a schema that is wrong or missing fails here for the reason it would fail in production.

const AVATAR = "avatar-0001";
const OTHER_AVATAR = "avatar-0002";
const JOB = "job-00000001";

const command = (type: string, payload: unknown) => ({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "command", type, payload });
const okResponse = (type: string, result: unknown) => ({ v: PROTOCOL_VERSION, id: "msg-00000001", kind: "response", type, ok: true, result });

function reasonOf(input: unknown): string {
  const r = parseMessage(input);
  if (r.ok) throw new Error("expected the message to be rejected");
  return r.reason;
}

const summary = {
  avatarId: AVATAR,
  name: "Nini",
  descriptor: { age: 25, text: "25-year-old woman, hazel eyes" },
  masterPhotoId: "photo-0010",
  createdAt: "2026-10-11T10:00:00.000Z",
  status: "active",
  photoCount: 0,
  videoCount: 0,
  eligibleUnusedCount: 0,
  usage: { state: "ok" },
};

const candidate = (photoId: string, likeness: number, avatarId = AVATAR) => ({ avatarId, photoId, likeness });
const photoIds = (n: number) => Array.from({ length: n }, (_, i) => `photo-${String(100 + i).padStart(4, "0")}`);

describe("the five portrait commands", () => {
  test("avatars.estimatePortraits takes an empty payload and answers an estimate", () => {
    expect(parseMessage(command("avatars.estimatePortraits", {})).ok).toBe(true);
    expect(parseMessage(command("avatars.estimatePortraits", { avatarId: AVATAR })).ok).toBe(false);
  });

  test("avatars.generatePortraits needs the worst case the owner accepted", () => {
    expect(parseMessage(command("avatars.generatePortraits", { avatarId: AVATAR, acceptedWorstMicros: 300_000 })).ok).toBe(true);
    expect(reasonOf(command("avatars.generatePortraits", { avatarId: AVATAR }))).toContain("payload.acceptedWorstMicros");
  });

  test("avatars.generatePortraits answers the job it started and nothing else", () => {
    expect(parseMessage(okResponse("avatars.generatePortraits", { jobId: JOB })).ok).toBe(true);
    expect(parseMessage(okResponse("avatars.generatePortraits", { jobId: JOB, extra: 1 })).ok).toBe(false);
  });

  test("avatars.portraits, pickPortrait and discardPortraits name the avatar (and the photo) and nothing more", () => {
    expect(parseMessage(command("avatars.portraits", { avatarId: AVATAR })).ok).toBe(true);
    expect(parseMessage(command("avatars.pickPortrait", { avatarId: AVATAR, photoId: "photo-0101" })).ok).toBe(true);
    expect(parseMessage(command("avatars.discardPortraits", { avatarId: AVATAR })).ok).toBe(true);
    expect(reasonOf(command("avatars.pickPortrait", { avatarId: AVATAR }))).toContain("payload.photoId");
    expect(parseMessage(command("avatars.portraits", { avatarId: AVATAR, path: "/etc/passwd" })).ok).toBe(false);
  });

  test("avatars.pickPortrait answers the avatar as it now stands", () => {
    expect(parseMessage(okResponse("avatars.pickPortrait", { avatar: { ...summary, masterPhotoId: "photo-0101" } })).ok).toBe(true);
    expect(parseMessage(okResponse("avatars.pickPortrait", {})).ok).toBe(false);
  });

  test("avatars.discardPortraits answers how many it removed", () => {
    expect(parseMessage(okResponse("avatars.discardPortraits", { avatarId: AVATAR, removed: 4 })).ok).toBe(true);
    expect(parseMessage(okResponse("avatars.discardPortraits", { avatarId: AVATAR, removed: -1 })).ok).toBe(false);
  });

  test("avatars.cancel and the sleep gate know the new commands: only the paid one is held while the Mac sleeps", () => {
    expect(contract.SLEEP_CLASS["avatars.generatePortraits"]).toBe("held");
    for (const free of ["avatars.estimatePortraits", "avatars.portraits", "avatars.pickPortrait", "avatars.discardPortraits"] as const) {
      expect(contract.SLEEP_CLASS[free]).toBe("free");
    }
  });
});

describe("avatars.portraits (the list)", () => {
  const list = (over: object) => okResponse("avatars.portraits", { avatarId: AVATAR, masterPhotoId: "photo-0010", sourcePhotoId: "photo-0010", masterLikeness: null, candidates: [], ...over });

  test("accepts a source photo, no master likeness and no candidates", () => {
    expect(parseMessage(list({})).ok).toBe(true);
  });

  test("accepts candidates with their likeness and a master that is a portrait", () => {
    expect(parseMessage(list({ masterPhotoId: "photo-0011", masterLikeness: 0.72, candidates: [candidate("photo-0101", 0.76), candidate("photo-0102", 0.55)] })).ok).toBe(true);
  });

  test("a wizard avatar has no source photo: sourcePhotoId null with no candidates is the answer", () => {
    expect(parseMessage(list({ sourcePhotoId: null })).ok).toBe(true);
  });

  test("refuses a candidate list for an avatar with no source photo", () => {
    expect(parseMessage(list({ sourcePhotoId: null, candidates: [candidate("photo-0101", 0.7)] })).ok).toBe(false);
  });

  test("holds exactly 15 candidates and refuses 16", () => {
    expect(parseMessage(list({ candidates: photoIds(15).map((id) => candidate(id, 0.7)) })).ok).toBe(true);
    expect(parseMessage(list({ candidates: photoIds(16).map((id) => candidate(id, 0.7)) })).ok).toBe(false);
  });

  test("refuses a likeness under the 0.55 gate and one above 1", () => {
    expect(parseMessage(list({ candidates: [candidate("photo-0101", 0.5499)] })).ok).toBe(false);
    expect(parseMessage(list({ candidates: [candidate("photo-0101", 1.0000001)] })).ok).toBe(false);
    expect(parseMessage(list({ candidates: [candidate("photo-0101", 1)] })).ok).toBe(true);
  });

  test("refuses a candidate that belongs to another avatar", () => {
    expect(parseMessage(list({ candidates: [candidate("photo-0101", 0.7, OTHER_AVATAR)] })).ok).toBe(false);
  });

  test("refuses the same photo listed twice", () => {
    expect(parseMessage(list({ candidates: [candidate("photo-0101", 0.7), candidate("photo-0101", 0.6)] })).ok).toBe(false);
  });

  test("refuses a key the contract does not know", () => {
    expect(parseMessage(list({ path: "/x" })).ok).toBe(false);
  });

  test("refuses the source photo listed as a candidate", () => {
    expect(parseMessage(list({ candidates: [candidate("photo-0010", 0.7)] })).ok).toBe(false);
  });

  test("refuses the master listed as a candidate", () => {
    expect(parseMessage(list({ masterPhotoId: "photo-0101", masterLikeness: 0.7, candidates: [candidate("photo-0101", 0.7)] })).ok).toBe(false);
  });

  // S5.3c: the master's likeness is null exactly when there is nothing to compare it with: the master IS the source photo, or the avatar has no source (a wizard avatar).
  test("refuses a likeness for a master that is the source photo", () => {
    expect(parseMessage(list({ masterLikeness: 0.9 })).ok).toBe(false);
  });

  test("refuses a missing likeness for a portrait master", () => {
    expect(parseMessage(list({ masterPhotoId: "photo-0011", masterLikeness: null })).ok).toBe(false);
  });

  test("refuses a likeness for an avatar with no source photo", () => {
    expect(parseMessage(list({ sourcePhotoId: null, masterLikeness: 0.7 })).ok).toBe(false);
  });

  // S5.3c: a portrait master whose photo is gone while the source is alive. The list still answers (the owner's way out is to make the source the master again) and says so.
  test("a missing master is marked, has no likeness, and leaves the source and the candidates", () => {
    const gone = { masterPhotoId: "photo-0011", masterLikeness: null, masterMissing: true };
    expect(parseMessage(list({ ...gone, candidates: [candidate("photo-0101", 0.7)] })).ok).toBe(true);
  });

  test("a missing master with a likeness, with no source, or that is the source is refused", () => {
    expect(parseMessage(list({ masterPhotoId: "photo-0011", masterLikeness: 0.7, masterMissing: true })).ok).toBe(false);
    expect(parseMessage(list({ masterPhotoId: "photo-0011", sourcePhotoId: null, masterLikeness: null, masterMissing: true })).ok).toBe(false);
    expect(parseMessage(list({ masterLikeness: null, masterMissing: true })).ok).toBe(false);
  });

  test("masterMissing is only ever true", () => {
    expect(parseMessage(list({ masterPhotoId: "photo-0011", masterLikeness: null, masterMissing: false })).ok).toBe(false);
  });

  test("names the master, which is the source or a portrait", () => {
    expect(parseMessage(list({ masterPhotoId: "photo-0010" })).ok).toBe(true);
    expect(parseMessage(okResponse("avatars.portraits", { avatarId: AVATAR, sourcePhotoId: null, masterLikeness: null, candidates: [] })).ok).toBe(false);
  });
});

describe("the avatar.portraits job", () => {
  const ref = { kind: "avatar.portraits", jobId: JOB, avatarId: AVATAR };

  test("job.progress counts the slots and never passes the total", () => {
    expect(JobProgress.safeParse({ ...ref, done: 2, total: 5 }).success).toBe(true);
    expect(JobProgress.safeParse({ ...ref, done: 6, total: 5 }).success).toBe(false);
  });

  test("job.failed and job.cancelled carry the job's identity", () => {
    expect(JobFailed.safeParse({ ...ref, error: { code: "BUDGET_EXCEEDED" } }).success).toBe(true);
    expect(JobCancelled.safeParse(ref).success).toBe(true);
    expect(JobCancelled.safeParse({ kind: "avatar.portraits", jobId: JOB }).success).toBe(false);
  });

  test("a snapshot restores a running job and a done job whose result is its own", () => {
    expect(JobState.safeParse({ ...ref, status: "running", done: 1, total: 5 }).success).toBe(true);
    const result = { kind: "avatar.portraits", avatarId: AVATAR, candidates: [candidate("photo-0101", 0.76)], failedSlots: [{ slot: 2, reason: "no-face" }] };
    expect(JobState.safeParse({ ...ref, status: "done", done: 5, total: 5, result }).success).toBe(true);
  });

  test("a done job whose result names another avatar is refused", () => {
    const result = { kind: "avatar.portraits", avatarId: OTHER_AVATAR, candidates: [], failedSlots: [] };
    expect(JobState.safeParse({ ...ref, status: "done", done: 5, total: 5, result }).success).toBe(false);
  });

  test("a done job cannot carry a candidates result, nor a portraits job a candidates one", () => {
    const candidatesResult = { kind: "avatar.candidates", avatarId: AVATAR, candidates: [], rejectedByAgeCheck: 0, failedSlots: [] };
    expect(JobState.safeParse({ ...ref, status: "done", done: 5, total: 5, result: candidatesResult }).success).toBe(false);
  });
});

describe("PortraitsResult", () => {
  const result = (over: object) => ({ kind: "avatar.portraits", avatarId: AVATAR, candidates: [], failedSlots: [], ...over });
  const parses = (value: unknown) => JobResult.safeParse(value).success;

  test("a batch where nothing passed is a result: no candidates, every slot explained", () => {
    const failedSlots = [
      { slot: 1, reason: "unlike", likeness: 0.48 },
      { slot: 2, reason: "no-face" },
      { slot: 3, reason: "multiple-faces" },
      { slot: 4, reason: "age-rejected" },
      { slot: 5, reason: "failed", error: { code: "MODERATION_REFUSED" }, reserveLeftOpen: false },
    ];
    expect(parses(result({ failedSlots }))).toBe(true);
  });

  test("accepts at most five candidates and refuses six", () => {
    expect(parses(result({ candidates: photoIds(5).map((id) => candidate(id, 0.7)) }))).toBe(true);
    expect(parses(result({ candidates: photoIds(6).map((id) => candidate(id, 0.7)) }))).toBe(false);
  });

  test("candidates and failed slots together are at most the five slots", () => {
    const failedSlots = [1, 2, 3].map((slot) => ({ slot, reason: "no-face" }));
    expect(parses(result({ candidates: photoIds(2).map((id) => candidate(id, 0.7)), failedSlots }))).toBe(true);
    expect(parses(result({ candidates: photoIds(3).map((id) => candidate(id, 0.7)), failedSlots }))).toBe(false);
  });

  test("refuses slot 0 and slot 6", () => {
    expect(parses(result({ failedSlots: [{ slot: 0, reason: "no-face" }] }))).toBe(false);
    expect(parses(result({ failedSlots: [{ slot: 6, reason: "no-face" }] }))).toBe(false);
    expect(parses(result({ failedSlots: [{ slot: 5, reason: "no-face" }] }))).toBe(true);
  });

  test("refuses a repeated slot", () => {
    expect(parses(result({ failedSlots: [{ slot: 2, reason: "no-face" }, { slot: 2, reason: "multiple-faces" }] }))).toBe(false);
  });

  test("refuses a candidate of another avatar", () => {
    expect(parses(result({ candidates: [candidate("photo-0101", 0.7, OTHER_AVATAR)] }))).toBe(false);
  });

  test("refuses the same photo twice among the candidates", () => {
    expect(parses(result({ candidates: [candidate("photo-0101", 0.7), candidate("photo-0101", 0.6)] }))).toBe(false);
  });

  test("refuses a candidate under the gate or above 1", () => {
    expect(parses(result({ candidates: [candidate("photo-0101", 0.54)] }))).toBe(false);
    expect(parses(result({ candidates: [candidate("photo-0101", 1.01)] }))).toBe(false);
  });

  test("an unlike slot carries a likeness under the gate, never at or over it", () => {
    expect(parses(result({ failedSlots: [{ slot: 1, reason: "unlike", likeness: 0.55 }] }))).toBe(false);
    expect(parses(result({ failedSlots: [{ slot: 1, reason: "unlike", likeness: 0.5499 }] }))).toBe(true);
    expect(parses(result({ failedSlots: [{ slot: 1, reason: "unlike" }] }))).toBe(false);
  });

  test("a failed slot says whether its reserve was left open", () => {
    expect(parses(result({ failedSlots: [{ slot: 1, reason: "failed", error: { code: "TIMEOUT" } }] }))).toBe(false);
    expect(parses(result({ failedSlots: [{ slot: 1, reason: "failed", error: { code: "TIMEOUT" }, reserveLeftOpen: true }] }))).toBe(true);
  });

  test("a reason outside the closed set is refused", () => {
    expect(parses(result({ failedSlots: [{ slot: 1, reason: "ugly" }] }))).toBe(false);
  });
});

describe("EngineError.portraitReason", () => {
  test.each(["not-imported", "too-many-candidates", "not-a-candidate"])("VALIDATION carries the reason %s", (portraitReason) => {
    expect(EngineError.safeParse({ code: "VALIDATION", portraitReason }).success).toBe(true);
  });

  test("a reason outside the closed set is refused", () => {
    expect(EngineError.safeParse({ code: "VALIDATION", portraitReason: "looks-wrong" }).success).toBe(false);
  });

  test("a reason on any other code is refused", () => {
    expect(EngineError.safeParse({ code: "IN_FLIGHT", portraitReason: "not-imported" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "MASTER_FACE_UNUSABLE", portraitReason: "not-imported" }).success).toBe(false);
  });

  // S5.3c: the source photo that is missing is an INTERNAL failure the window must be able to word; it is the one reason that is not a VALIDATION.
  test("source-unavailable is carried by INTERNAL, and only by INTERNAL", () => {
    expect(EngineError.safeParse({ code: "INTERNAL", portraitReason: "source-unavailable" }).success).toBe(true);
    expect(EngineError.safeParse({ code: "VALIDATION", portraitReason: "source-unavailable" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "NOT_FOUND", portraitReason: "source-unavailable" }).success).toBe(false);
  });

  test("the other reasons are refused on INTERNAL", () => {
    for (const portraitReason of ["not-imported", "too-many-candidates", "not-a-candidate"]) {
      expect(EngineError.safeParse({ code: "INTERNAL", portraitReason }).success).toBe(false);
    }
  });

  test("source-unavailable beside another reason is refused", () => {
    expect(EngineError.safeParse({ code: "INTERNAL", portraitReason: "source-unavailable", descriptorReason: "stale" }).success).toBe(false);
  });

  test("a refusal has one reason: a portrait reason beside any other reason is refused", () => {
    const portraitReason = "not-imported";
    expect(EngineError.safeParse({ code: "VALIDATION", portraitReason, descriptorReason: "stale" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "VALIDATION", portraitReason, categoryReason: "limit" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "VALIDATION", portraitReason, sceneReason: "set-used" }).success).toBe(false);
    expect(EngineError.safeParse({ code: "VALIDATION", portraitReason, launchReason: "open-set" }).success).toBe(false);
  });

  test("a bare VALIDATION still parses (the reason is optional)", () => {
    expect(EngineError.safeParse({ code: "VALIDATION" }).success).toBe(true);
  });
});

describe("the Russian texts of the portrait reasons", () => {
  test("each reason has a text of its own, and none is the general VALIDATION text", () => {
    const table = errorTexts.PORTRAIT_REASONS_RU;
    const reasons = ["not-imported", "too-many-candidates", "not-a-candidate", "source-unavailable"] as const;
    const texts = reasons.map((reason) => table[reason]);
    expect(new Set(texts).size).toBe(reasons.length);
    for (const text of texts) {
      expect(text.length).toBeGreaterThan(10);
      expect(text).not.toBe(errorTexts.ERROR_MESSAGES_RU.VALIDATION);
    }
  });

  test("the source-unavailable text is the owner's way to the library folder", () => {
    expect(errorTexts.PORTRAIT_REASONS_RU["source-unavailable"]).toBe("Исходное фото недоступно — проверьте папку библиотеки.");
  });

  test("the too-many-candidates text says the limit is 15 and that nothing was spent", () => {
    expect(errorTexts.PORTRAIT_REASONS_RU["too-many-candidates"]).toContain("15");
    expect(errorTexts.PORTRAIT_REASONS_RU["too-many-candidates"]).toContain("Ничего не потрачено");
  });
});

describe("what S5.3a must not move", () => {
  test("the protocol stays at 5", () => {
    expect(PROTOCOL_VERSION).toBe(5);
  });

  test("AvatarSummary keeps exactly the keys it had", () => {
    expect(Object.keys(AvatarSummary.shape).sort()).toEqual(
      ["avatarId", "body", "bodyProposal", "createdAt", "descriptor", "eligibleUnusedCount", "masterPhotoId", "name", "photoCount", "status", "usage", "videoCount"].sort(),
    );
  });

  test("an avatar listed without the optional fields serialises byte for byte as before", () => {
    const parsed = AvatarSummary.parse(summary);
    expect(JSON.stringify(parsed)).toBe(JSON.stringify(summary));
  });

  test("the job kinds keep their old members and gain avatar.portraits", () => {
    expect(contract.JobKind.options).toEqual(expect.arrayContaining(["avatar.candidates", "run", "render", "import", "scenes", "avatar.portraits"]));
  });
});
