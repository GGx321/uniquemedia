import { describe, expect, test } from "bun:test";
import { type EventMessage } from "../../shared/engine";
import { makeMock, unwrap, type Mock } from "./mockEngine.testkit";

// 3f.3a: a video has an importer, and an importer can refuse a file AFTER its copy (a codec, a length, a size): the job then ends failed with
// MEDIA_UNSUPPORTED and the importer's reason, and stores nothing. The mock plays that as the engine does (the parity suite holds the two
// side by side): the same events in the same order, with no record and no `media.changed`.

const refused = { name: "clip.mov", accept: { kind: "video", bytes: 5000, failWith: "codec" } } as const;

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

});
