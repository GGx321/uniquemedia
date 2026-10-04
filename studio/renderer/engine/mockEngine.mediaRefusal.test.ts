import { describe, expect, test } from "bun:test";
import { JobState, MediaSummary, type EventMessage } from "../../shared/engine";
import { makeMock, typesOf, unwrap, type Mock } from "./mockEngine.testkit";

// 3f.3a: a video has an importer, and an importer can refuse a file AFTER its copy (a codec, a length, a size): the job then ends failed with
// MEDIA_UNSUPPORTED and the importer's reason, and stores nothing. The mock plays that as the engine does (the parity suite holds the two
// side by side): the same events in the same order, with no record and no `media.changed`.

const refused = { name: "clip.mov", accept: { kind: "video", bytes: 5000, refuse: "codec" } } as const;
const photo = { name: "lake.jpg", accept: { kind: "photo", bytes: 120 } } as const;

async function pick(mock: Mock, files: Parameters<Mock["engine"]["pickMediaNext"]>[0]) {
  mock.engine.pickMediaNext(files);
  return unwrap(mock.client.request("media.pickImport", { kind: "any" }));
}

const importEvents = (mock: Mock): EventMessage[] => mock.events.filter((e) => e.type === "job.progress" || e.type === "job.done" || e.type === "job.cancelled" || e.type === "job.failed" || e.type === "media.changed");

describe("a file the importer refuses after its copy", () => {
  test("starts like any job: its id is answered and it is announced at zero", async () => {
    const mock = makeMock();
    const answer = await pick(mock, [refused]);
    expect(answer).toMatchObject({ picked: true, refused: [], skipped: 0 });
    if (!answer.picked) throw new Error("not picked");
    expect(answer.jobIds).toHaveLength(1);
    expect(importEvents(mock)[0]?.payload).toEqual({ kind: "import", jobId: answer.jobIds[0], mediaKind: "video", name: "clip.mov", mediaId: null, done: 0, total: 5000 });
  });

  test("ends in the engine's order: progress at the total, then job.failed with the reason; no record, no media.changed", async () => {
    const mock = makeMock();
    const answer = await pick(mock, [refused]);
    if (!answer.picked) throw new Error("not picked");
    mock.scheduler.runAll();
    const events = importEvents(mock);
    expect(typesOf(events)).toEqual(["job.progress", "job.progress", "job.failed"]);
    expect(events[1]?.payload).toMatchObject({ kind: "import", done: 5000, total: 5000 });
    expect(events[2]?.payload).toEqual({
      kind: "import",
      jobId: answer.jobIds[0],
      mediaKind: "video",
      name: "clip.mov",
      mediaId: null,
      error: { code: "MEDIA_UNSUPPORTED", mediaReason: "codec", detail: "the file was refused: codec" },
    });
    expect(await unwrap(mock.client.request("media.list", {}))).toEqual({ media: [], total: 0 });
  });

  test("is a failed import in the snapshot, with its error, and fits the contract", async () => {
    const mock = makeMock();
    await pick(mock, [refused]);
    mock.scheduler.runAll();
    const job = (await unwrap(mock.client.request("engine.snapshot", {}))).jobs.find((j) => j.kind === "import");
    expect(JobState.safeParse(job).success).toBe(true);
    expect(job).toMatchObject({ kind: "import", status: "failed", mediaId: null, error: { code: "MEDIA_UNSUPPORTED", mediaReason: "codec" } });
  });

  test("gives the turn to the next job, which still ends in its record", async () => {
    const mock = makeMock();
    await pick(mock, [refused, photo]);
    mock.scheduler.runAll();
    const listed = await unwrap(mock.client.request("media.list", {}));
    expect(listed.total).toBe(1);
    expect(MediaSummary.parse(listed.media[0])).toMatchObject({ kind: "photo", name: "lake.jpg" });
    expect(typesOf(importEvents(mock))).toContain("job.failed");
    expect(typesOf(importEvents(mock)).at(-1)).toBe("job.done");
  });

  test("a cancel that comes first ends it cancelled, not failed, like any job", async () => {
    const mock = makeMock();
    const answer = await pick(mock, [refused]);
    if (!answer.picked) throw new Error("not picked");
    await unwrap(mock.client.request("media.cancelImport", { jobId: answer.jobIds[0] ?? "" }));
    mock.scheduler.runAll();
    expect(typesOf(importEvents(mock))).toEqual(["job.progress", "job.cancelled"]);
  });

  test("the refusal says nothing of a path", async () => {
    const mock = makeMock();
    await pick(mock, [refused]);
    mock.scheduler.runAll();
    expect(JSON.stringify(importEvents(mock))).not.toMatch(/[\\/]/);
  });
});
