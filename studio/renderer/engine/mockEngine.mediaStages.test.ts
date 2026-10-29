import { describe, expect, test } from "bun:test";
import { JobProgress, type EventMessage } from "../../shared/engine";
import { makeMock, typesOf, unwrap, type Mock } from "./mockEngine.testkit";

// 3f.6: the mock plays the import's two stages as the engine does: the copy in bytes, then (for a file whose script says it has a prepare) the
// importer's own units from zero of their own total, never full before the record is stored. A file whose script says nothing of it plays exactly
// as before (the parity suite's older stories and the 3f.1b tests hold that), so the stage is opt-in: `accept.prepare`.

const video = { name: "walk.mov", accept: { kind: "video", bytes: 5000, facts: { durationMs: 2000, sourceFps: 60, hdrToSdr: true }, prepare: {} } } as const;

async function pick(mock: Mock, files: Parameters<Mock["engine"]["pickMediaNext"]>[0], kind: "photo" | "video" | "audio" | "sticker" | "any" = "video") {
  mock.engine.pickMediaNext(files);
  return unwrap(mock.client.request("media.pickImport", { kind }));
}

const progressOf = (mock: Mock): Extract<JobProgress, { kind: "import" }>[] =>
  mock.events.flatMap((e: EventMessage) => {
    if (e.type !== "job.progress") return [];
    const p = JobProgress.parse(e.payload);
    return p.kind === "import" ? [p] : [];
  });
const importEvents = (mock: Mock): EventMessage[] => mock.events.filter((e) => e.type === "job.progress" || e.type === "job.done" || e.type === "job.cancelled" || e.type === "job.failed" || e.type === "media.changed");

describe("a file whose script has a prepare stage", () => {
  test("plays the copy to its total, then the prepare from zero of the importer's own units, then the record", async () => {
    const mock = makeMock();
    await pick(mock, [video]);
    mock.scheduler.runAll();
    const progress = progressOf(mock);
    const stages = progress.map((p) => p.stage ?? "copy");
    const firstPrepare = stages.indexOf("prepare");

    expect(firstPrepare).toBeGreaterThan(0);
    expect(progress[firstPrepare - 1]).toMatchObject({ done: 5000, total: 5000 });
    expect(progress[firstPrepare]).toMatchObject({ stage: "prepare", done: 0 });
    expect(stages.slice(firstPrepare).every((s) => s === "prepare")).toBe(true);
    expect(typesOf(importEvents(mock)).slice(-2)).toEqual(["media.changed", "job.done"]);
  });

});

