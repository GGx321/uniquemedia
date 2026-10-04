import { describe, expect, test } from "bun:test";
import { EventMessage } from "../../shared/engine";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { Normalizer, Transcript, type Recorded } from "./testing/transcript";
useNativeGlobals();

// Fix round 3, M3: the transcript checks an import's progress numbers on whichever engine sent them (the rules themselves are in
// progress.test.ts), and says which imports were announced queued.

function progress(jobId: string, done: number, total = 100, queued = false): EventMessage {
  return EventMessage.parse({
    v: 5,
    id: `evt-${jobId}-${done}-${queued ? "q" : "r"}`,
    kind: "event",
    seq: 1,
    bootId: "boot-00000001",
    type: "job.progress",
    payload: { kind: "import", jobId, mediaKind: "photo", name: "a.jpg", mediaId: null, done, total, ...(queued ? { queued: true } : {}) },
  });
}

function transcriptOver(events: EventMessage[]): Transcript {
  const rig: Recorded = { send: async () => ({ ok: true, result: {} }), events: () => events, advance: async () => undefined, settle: async () => undefined };
  return new Transcript(rig, new Normalizer());
}

describe("the transcript's check of an import's progress", () => {
  test("lets a sound story through", async () => {
    const events: EventMessage[] = [];
    const t = transcriptOver(events);
    events.push(progress("job-00000001", 0), progress("job-00000002", 0, 100, true), progress("job-00000001", 100));
    await expect(t.settle()).resolves.toBeUndefined();
  });

  test("throws for a job that goes back, so the scenario fails on whichever engine sent it", async () => {
    const events: EventMessage[] = [];
    const t = transcriptOver(events);
    events.push(progress("job-00000001", 0), progress("job-00000001", 60), progress("job-00000001", 40));
    await expect(t.settle()).rejects.toThrow(/goes back/);
  });

  test("throws for a queued announcement that is not a job's first", async () => {
    const events: EventMessage[] = [];
    const t = transcriptOver(events);
    events.push(progress("job-00000001", 0), progress("job-00000001", 0, 100, true));
    await expect(t.settle()).rejects.toThrow(/queued/);
  });

  test("remembers which imports were announced queued, as aliases", async () => {
    const events: EventMessage[] = [];
    const t = transcriptOver(events);
    events.push(progress("job-00000001", 0), progress("job-00000002", 0, 100, true));
    expect(t.announcedQueued()).toEqual(["job#2"]);
  });
});
