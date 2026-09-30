import { describe, expect, test } from "bun:test";
import type { FlushResult } from "./autosave";
import { DraftFlushes } from "./flushes";
import { montageOf, version } from "./testkit";

// 3d.2 review, open question (b): an editor that closes sends its unsaved edit on the way out, and the same draft
// opened again must read it only once that save answered; a save that failed then is said on the reopen.

function deferred() {
  let resolve: (result: FlushResult) => void = () => undefined;
  const promise = new Promise<FlushResult>((r) => (resolve = r));
  return { promise, resolve };
}

const settle = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

describe("the flushes of closed editors", () => {
  test("a draft with no flush on its way opens at once, with nothing lost", async () => {
    expect(await new DraftFlushes().settle("montage-0000001")).toBeNull();
  });

  test("the reopen waits for the old editor's save to answer", async () => {
    const flushes = new DraftFlushes();
    const old = deferred();
    flushes.track("montage-0000001", old.promise);
    let opened = false;
    void flushes.settle("montage-0000001").then(() => (opened = true));
    await settle();
    expect(opened).toBe(false);

    old.resolve({ ok: true, montage: montageOf(version(1)) });
    await settle();
    expect(opened).toBe(true);
  });

  test("a save that failed on the way out is told once, to the next open of that draft", async () => {
    const flushes = new DraftFlushes();
    flushes.track("montage-0000001", Promise.resolve({ ok: false, error: { code: "LIBRARY_UNAVAILABLE" } }));
    await settle();
    expect(await flushes.settle("montage-0000002")).toBeNull();
    expect(await flushes.settle("montage-0000001")).toEqual({ code: "LIBRARY_UNAVAILABLE" });
    expect(await flushes.settle("montage-0000001")).toBeNull();
  });

  test("a draft deleted meanwhile is not a lost edit: there is nothing to reopen", async () => {
    const flushes = new DraftFlushes();
    flushes.track("montage-0000001", Promise.resolve({ ok: false, error: { code: "NOT_FOUND" } }));
    expect(await flushes.settle("montage-0000001")).toBeNull();
  });

  test("a newer close of the same draft is the one waited for", async () => {
    const flushes = new DraftFlushes();
    const first = deferred();
    const second = deferred();
    flushes.track("montage-0000001", first.promise);
    flushes.track("montage-0000001", second.promise);
    let opened = false;
    void flushes.settle("montage-0000001").then(() => (opened = true));
    first.resolve({ ok: true, montage: montageOf(version(1)) });
    await settle();
    expect(opened).toBe(false);
    second.resolve({ ok: true, montage: montageOf(version(2)) });
    await settle();
    expect(opened).toBe(true);
  });
});
