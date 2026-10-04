import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";
import { createDecodeGate, type DecodeWorkerLike } from "./decodeGate";

// What the own-photo decode gate does not keep (3f.2 fix round 2), under ELECTRON'S NODE (V8, precise GC). The same check under Bun
// was flaky by construction: JavaScriptCore scans the stack conservatively, so a stale pointer can keep a dropped buffer alive
// (it failed on Windows CI). V8 does not, so a retained buffer here is the gate's doing and nothing else.
// Bundled and run by studio/scripts/electronNodeTests.ts; named `.node-test.ts` so `bun test` never loads it.

class FakeWorker implements DecodeWorkerLike {
  #message: ((value: unknown) => void)[] = [];
  lastId = -1;
  postMessage(message: unknown): void {
    this.lastId = (message as { id: number }).id;
  }
  on(event: "message" | "error" | "exit", listener: never): this {
    if (event === "message") this.#message.push(listener);
    return this;
  }
  async terminate(): Promise<number> {
    return 0;
  }
  answer(width: number, height: number): void {
    for (const listener of this.#message) listener({ type: "decoded", id: this.lastId, width, height, data: new ArrayBuffer(width * height * 4) });
  }
}

/** One macrotask: a `WeakRef` target stays alive until the end of the job that made or read it. */
const macrotask = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/** V8's `gc`, without a flag on the runner: the flag is switched on here, and the function is read from a fresh context. */
function exposeGc(): () => void {
  setFlagsFromString("--expose-gc");
  const gc: unknown = runInNewContext("gc");
  assert.equal(typeof gc, "function", "V8 did not expose gc");
  return gc as () => void;
}

describe("createDecodeGate: what it does not keep (fix round 2)", () => {
  test("the last decoded picture is not kept alive by the gate once the caller has dropped it", async () => {
    const gc = exposeGc();
    const workers: FakeWorker[] = [];
    const gate = createDecodeGate({
      spawnWorker: () => {
        const worker = new FakeWorker();
        workers.push(worker);
        return worker;
      },
      idleRecycleMs: 60_000,
      timeoutMs: 60_000,
    });
    // The picture lives only inside this function: what outlives it is a weak reference to its pixel buffer (1 MiB).
    const reference = await (async () => {
      const decoding = gate.decode(new Uint8Array(4).fill(7), new AbortController().signal);
      await macrotask();
      workers[0]?.answer(512, 512);
      const image = await decoding;
      return new WeakRef(image.data.buffer);
    })();
    for (let turn = 0; turn < 5; turn++) {
      await macrotask();
      gc();
    }
    assert.equal(reference.deref(), undefined, "the gate still holds the last decoded picture");
    await gate.dispose();
  });
});
