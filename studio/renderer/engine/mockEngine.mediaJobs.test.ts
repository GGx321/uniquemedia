import { describe, expect, test } from "bun:test";
import { type EventMessage } from "../../shared/engine";
import { makeMock, unwrap, type Mock } from "./mockEngine.testkit";

// 3f.1b: the mock's own media. An accepted file starts an import job on the mock's clock, ends in a record (listed, deleted, announced
// with `media.changed`), and a cancelled job stores nothing: as the engine does (the parity suite holds the two side by side). The mock
// holds no file and no path: the dialog's script names files by display name.

const photo = { name: "lake.jpg", accept: { kind: "photo", bytes: 120 } } as const;

async function pick(mock: Mock, files: Parameters<Mock["engine"]["pickMediaNext"]>[0], kind: "photo" | "video" | "any" = "photo") {
  mock.engine.pickMediaNext(files);
  return unwrap(mock.client.request("media.pickImport", { kind }));
}

const importEvents = (mock: Mock): EventMessage[] => mock.events.filter((e) => e.type === "job.progress" || e.type === "job.done" || e.type === "job.cancelled" || e.type === "job.failed" || e.type === "media.changed");

describe("a picked file the script accepts", () => {
  test("starts a job: its id is answered, it is announced at zero of the file's size, and nothing is stored yet", async () => {
    const mock = makeMock();
    const answer = await pick(mock, [photo]);
    expect(answer).toMatchObject({ picked: true, refused: [], skipped: 0 });
    if (!answer.picked) throw new Error("not picked");
    const [jobId] = answer.jobIds;
    expect(answer.jobIds).toHaveLength(1);
    const events = importEvents(mock);
    expect(events).toHaveLength(1);
    expect(events[0]?.payload).toEqual({ kind: "import", jobId, mediaKind: "photo", name: "lake.jpg", mediaId: null, done: 0, total: 120 });
    expect(await unwrap(mock.client.request("media.list", {}))).toEqual({ media: [], total: 0 });
  });

});

describe("media.delete", () => {
  test("removes the record and says so, once", async () => {
    const mock = makeMock();
    await pick(mock, [photo]);
    mock.scheduler.runAll();
    const [media] = (await unwrap(mock.client.request("media.list", {}))).media;
    if (media === undefined) throw new Error("nothing stored");
    const mark = mock.events.length;
    expect(await unwrap(mock.client.request("media.delete", { mediaId: media.mediaId }))).toEqual({ mediaId: media.mediaId });
    expect(mock.events.slice(mark).map((e) => e.payload)).toEqual([{ change: "removed", mediaId: media.mediaId }]);
    expect((await unwrap(mock.client.request("media.list", {}))).total).toBe(0);
  });

});

// The 3f.1b review: the engine holds the library for an import (L-2, probe P7) and queues the jobs that wait for their turn.
describe("a library switch while an import runs", () => {
  test("is refused IN_FLIGHT, as the engine refuses it, and goes through once the job is over", async () => {
    const mock = makeMock();
    mock.engine.holdImports(true);
    await pick(mock, [photo]);
    expect(await mock.client.request("settings.setLibraryPath", { path: "/Users/someone/OtherLibrary" })).toMatchObject({ ok: false, error: { code: "IN_FLIGHT" } });
    mock.engine.holdImports(false);
    mock.scheduler.runAll();
    expect(await mock.client.request("settings.setLibraryPath", { path: "/Users/someone/OtherLibrary" })).toMatchObject({ ok: true });
  });

});

