import { describe, expect, test } from "bun:test";
import { makeMock, unwrap } from "./mockEngine.testkit";

// 3f.1: the mock answers `media.pickImport` as main and the engine do together: a dialog (the mock's own control, `pickMediaNext`) and a
// verdict per file. The mock names files by DISPLAY NAME only: it holds no path and answers none. The parity suite
// (studio/engine/parity) plays the same stories against the real engine.

describe("media.pickImport", () => {
  test("a dialog nobody scripted is a cancel", async () => {
    const mock = makeMock();
    expect(await unwrap(mock.client.request("media.pickImport", { kind: "photo" }))).toEqual({ picked: false });
  });

  test("a cancelled dialog answers picked: false", async () => {
    const mock = makeMock();
    mock.engine.pickMediaNext(null);
    expect(await unwrap(mock.client.request("media.pickImport", { kind: "photo" }))).toEqual({ picked: false });
  });

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

  test("a pick is used once: the next dialog is a cancel again", async () => {
    const mock = makeMock();
    mock.engine.pickMediaNext([{ name: "a.jpg", reason: "empty" }]);
    await unwrap(mock.client.request("media.pickImport", { kind: "photo" }));
    expect(await unwrap(mock.client.request("media.pickImport", { kind: "photo" }))).toEqual({ picked: false });
  });

  test("the window cannot name a file: a payload with a path is refused", async () => {
    const mock = makeMock();
    const answer = await mock.client.request("media.pickImport", { kind: "photo", path: "/etc/passwd" } as never);
    expect(answer.ok).toBe(false);
  });

  test("an answer holds no path, whatever name a test scripted", async () => {
    const mock = makeMock();
    mock.engine.pickMediaNext([{ name: "summer.jpg", reason: "format" }]);
    const text = JSON.stringify(await unwrap(mock.client.request("media.pickImport", { kind: "any" })));
    expect(text.includes("/")).toBe(false);
    expect(text.includes("\\")).toBe(false);
  });
});
