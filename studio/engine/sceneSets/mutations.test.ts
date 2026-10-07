import { describe, expect, test } from "bun:test";
import type { StoredSceneSet } from "../library/sceneSets";
import { sampleSet } from "../library/testing/sceneSetSample";
import { beginWrite, withChunkGivenUp, withChunkWritten, withWriteFinished, withWriteStopped } from "./mutations";
import { useNativeGlobals } from "../../testing/nativeGlobals";
useNativeGlobals();

// CS.4a: the changes a write makes to its set's record, as pure functions. The record is rewritten by the store (revision, atomic); these say what changes.

function stored(over: Partial<StoredSceneSet> = {}): StoredSceneSet {
  return { schemaVersion: 1, revision: 3, createdAt: "2026-10-07T10:00:00.000Z", updatedAt: "2026-10-07T10:00:00.000Z", ...sampleSet({ count: 30 }), ...over };
}

describe("beginWrite", () => {
  test("records the next write under its job, and counts it", () => {
    const set = stored({ write: { k: 1, kind: "compose", jobId: "job-aaaa-0001", stoppedBy: "network" }, writes: 1 });
    const next = beginWrite(set, { kind: "unwritten", jobId: "job-aaaa-0002" });
    expect(next.write).toEqual({ k: 2, kind: "unwritten", jobId: "job-aaaa-0002" });
    expect(next.writes).toBe(2);
  });

  test("a write that did not stop leaves no old outcome behind", () => {
    const next = beginWrite(stored({ write: { k: 1, kind: "compose", jobId: "job-aaaa-0001", stoppedBy: "failed", stoppedError: { code: "AUTH_INVALID" } }, writes: 1 }), { kind: "unwritten", jobId: "job-aaaa-0002" });
    expect(next.write).not.toHaveProperty("stoppedBy");
    expect(next.write).not.toHaveProperty("stoppedError");
  });

  test("changes nothing else", () => {
    const set = stored();
    const next = beginWrite(set, { kind: "unwritten", jobId: "job-aaaa-0002" });
    expect({ ...next, write: null, writes: 0 }).toEqual({ ...set, write: null, writes: 0 });
  });
});

describe("withChunkWritten", () => {
  test("gives each named scene its sentence, as the writer's, not the owner's", () => {
    const next = withChunkWritten(stored(), new Map([[1, "First."], [2, "Second."]]));
    expect(next.scenes.slice(0, 2).map((s) => [s.text, s.edited])).toEqual([["First.", false], ["Second.", false]]);
    expect(next.scenes[2]?.text).toBeNull();
  });

  test("never overwrites a text the owner typed meanwhile", () => {
    const set = stored();
    const typed = { ...set, scenes: set.scenes.map((s) => (s.sceneId === 1 ? { ...s, text: "Mine.", edited: true } : s)) };
    const next = withChunkWritten(typed, new Map([[1, "The writer's."], [2, "Second."]]));
    expect(next.scenes[0]).toMatchObject({ text: "Mine.", edited: true });
    expect(next.scenes[1]?.text).toBe("Second.");
  });

  test("a sentence for a scene the set does not have is ignored", () => {
    const set = stored();
    expect(withChunkWritten(set, new Map([[999, "Nobody's."]])).scenes).toEqual(set.scenes);
  });
});

describe("withChunkGivenUp", () => {
  test("records the verdict on the chunk and on no other", () => {
    const next = withChunkGivenUp(stored(), 1, "refused");
    expect(next.chunks.map((c) => c.gaveUp)).toEqual(["refused", undefined]);
  });

  test("a chunk the set does not have changes nothing", () => {
    const set = stored();
    expect(withChunkGivenUp(set, 9, "rejected").chunks).toEqual(set.chunks);
  });
});

describe("withWriteStopped", () => {
  test("keeps why the write stopped, with the error of a failure", () => {
    const set = stored({ write: { k: 1, kind: "compose", jobId: "job-aaaa-0001" }, writes: 1 });
    expect(withWriteStopped(set, { stoppedBy: "rate-limited" }).write).toEqual({ k: 1, kind: "compose", jobId: "job-aaaa-0001", stoppedBy: "rate-limited" });
    expect(withWriteStopped(set, { stoppedBy: "failed", error: { code: "AUTH_INVALID", detail: "401" } }).write).toMatchObject({ stoppedBy: "failed", stoppedError: { code: "AUTH_INVALID" } });
  });

  test("a set with no write recorded stays as it is", () => {
    const set = stored();
    expect(withWriteStopped(set, { stoppedBy: "network" })).toEqual(set);
  });
});

describe("withWriteFinished", () => {
  test("clears the recorded write: nothing is left to resume", () => {
    expect(withWriteFinished(stored({ write: { k: 1, kind: "compose", jobId: "job-aaaa-0001" }, writes: 1 })).write).toBeNull();
  });

  test("keeps how many writes were started", () => {
    expect(withWriteFinished(stored({ write: { k: 2, kind: "unwritten", jobId: "job-aaaa-0001" }, writes: 2 })).writes).toBe(2);
  });
});
