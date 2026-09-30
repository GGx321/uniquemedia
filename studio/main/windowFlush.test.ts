import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../testing/nativeGlobals";
import { createWindowFlush, type FlushOutcome, type FlushTarget } from "./windowFlush";
useNativeGlobals();

// Before quitting, main asks every window to save what its owner is editing and waits for each to say how it went
// (3d.2 review, HIGH 2; re-review: the answer carries whether the window saved). Each ask carries its own id, so only
// that window's answer to that ask counts.

function target(gone = false) {
  const sent: string[] = [];
  const t: FlushTarget = { send: (id) => void sent.push(id), isGone: () => gone };
  return { t, sent };
}

function ids(): () => string {
  let n = 0;
  return () => `flush-${String(++n).padStart(4, "0")}`;
}

const settle = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe("asking the windows to save", () => {
  test("with no window there is nothing to wait for: saved", async () => {
    const flush = createWindowFlush({ targets: () => [], newId: ids(), timeoutMs: 1_000 });
    expect(await flush.request()).toBe("saved");
  });

  test("every window is asked once, and the wait ends only when each of them answered", async () => {
    const a = target();
    const b = target();
    const flush = createWindowFlush({ targets: () => [a.t, b.t], newId: ids(), timeoutMs: 1_000 });
    const seen: { outcome: FlushOutcome | null } = { outcome: null };
    void flush.request().then((o) => (seen.outcome = o));
    expect(a.sent).toEqual(["flush-0001"]);
    expect(b.sent).toEqual(["flush-0002"]);

    flush.acknowledge({ id: "flush-0001", ok: true });
    await settle();
    expect(seen.outcome).toBeNull();

    flush.acknowledge({ id: "flush-0002", ok: true });
    await settle();
    expect(seen.outcome).toBe("saved");
  });

  test("a window that could not save refuses the quit", async () => {
    const a = target();
    const b = target();
    const flush = createWindowFlush({ targets: () => [a.t, b.t], newId: ids(), timeoutMs: 1_000 });
    const outcome = flush.request();
    flush.acknowledge({ id: "flush-0001", ok: true });
    flush.acknowledge({ id: "flush-0002", ok: false });
    expect(await outcome).toBe("refused");
  });

  test("an answer to an ask that was never made, a repeated answer, or one that is not {id, ok} changes nothing", async () => {
    const a = target();
    const b = target();
    const flush = createWindowFlush({ targets: () => [a.t, b.t], newId: ids(), timeoutMs: 1_000 });
    const seen: { outcome: FlushOutcome | null } = { outcome: null };
    void flush.request().then((o) => (seen.outcome = o));

    flush.acknowledge({ id: "flush-9999", ok: true });
    flush.acknowledge("flush-0002");
    flush.acknowledge({ id: "flush-0002" });
    flush.acknowledge({ id: 2, ok: true });
    flush.acknowledge({ id: "flush-0001", ok: true });
    flush.acknowledge({ id: "flush-0001", ok: true });
    await settle();
    expect(seen.outcome).toBeNull();
  });

  test("a closed or crashed window is not asked, and not waited for", async () => {
    const open = target();
    const gone = target(true);
    const flush = createWindowFlush({ targets: () => [open.t, gone.t], newId: ids(), timeoutMs: 1_000 });
    const outcome = flush.request();
    expect(gone.sent).toEqual([]);
    flush.acknowledge({ id: open.sent[0], ok: true });
    expect(await outcome).toBe("saved");
  });

  test("a window whose send throws (it closed meanwhile) is not waited for", async () => {
    const broken: FlushTarget = {
      send: () => {
        throw new Error("Object has been destroyed");
      },
      isGone: () => false,
    };
    const flush = createWindowFlush({ targets: () => [broken], newId: ids(), timeoutMs: 1_000 });
    expect(await flush.request()).toBe("saved");
  });

  test("a window that does not answer in time: the wait ends as timed out, and its late answer is ignored", async () => {
    const a = target();
    const flush = createWindowFlush({ targets: () => [a.t], newId: ids(), timeoutMs: 20 });
    const outcome = flush.request();
    await wait(40);
    expect(await outcome).toBe("timeout");
    // The ask is forgotten: a second quit's asks are the only ones that count.
    flush.acknowledge({ id: a.sent[0], ok: false });
    const again = flush.request();
    flush.acknowledge({ id: a.sent[1], ok: true });
    expect(await again).toBe("saved");
  });
});
