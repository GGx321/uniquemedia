import { describe, expect, test } from "bun:test";
import { makeMock, unwrap } from "./mockEngine.testkit";

// 3f.1: the mock answers `media.pickImport` as main and the engine do together: a dialog (the mock's own control, `pickMediaNext`) and a
// verdict per file. The mock names files by DISPLAY NAME only: it holds no path and answers none. The parity suite
// (studio/engine/parity) plays the same stories against the real engine.

describe("media.pickImport", () => {

  test("scripted files are listed by name and reason, in the order they were picked", async () => {
    const mock = makeMock();
    mock.engine.pickMediaNext([
      { name: "summer.jpg", reason: "not-yet-supported" },
      { name: "notes.jpg", reason: "format" },
      { name: "album", reason: "not-a-file" },
    ]);
    expect(await unwrap(mock.client.request("media.pickImport", { kind: "photo" }))).toEqual({
      picked: true,
      jobIds: [],
      skipped: 0,
      refused: [
        { name: "summer.jpg", reason: "not-yet-supported" },
        { name: "notes.jpg", reason: "format" },
        { name: "album", reason: "not-a-file" },
      ],
    });
  });

});
