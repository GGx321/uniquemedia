import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { createDecodeGate } from "./decodeGate";
import { SMOKE_TEST_JPEG, SMOKE_TEST_PNG } from "./realBackend";
import { createDecodeWorkerSpawner } from "./spawn";
useNativeGlobals();

// The REAL decode worker (photoDecodeWorker.ts, from source) behind the real gate: the wire format, the codecs loading inside the thread, a
// picture that cannot be read, a cap, a cancel, and the next decode after each. The scripted-worker tests are in decodeGate.test.ts.

const WORKER = new URL("./photoDecodeWorker.ts", import.meta.url);
const NODE_MODULES_DIR = join(import.meta.dir, "../../../node_modules");

function realGate(maxPixels = 16_777_216, options: { idleRecycleMs?: number } = {}) {
  return createDecodeGate({
    spawnWorker: createDecodeWorkerSpawner(WORKER, { nodeModulesDir: NODE_MODULES_DIR, maxPixels }),
    idleRecycleMs: options.idleRecycleMs ?? 60_000,
    timeoutMs: 60_000,
  });
}

const copy = (bytes: Uint8Array): Uint8Array => bytes.slice();
const signal = (): AbortSignal => new AbortController().signal;

describe("the real decode worker", () => {
  test("decodes a JPEG and a PNG, one after the other, in the same thread", async () => {
    const gate = realGate();
    try {
      const jpeg = await gate.decode(copy(SMOKE_TEST_JPEG), signal());
      const png = await gate.decode(copy(SMOKE_TEST_PNG), signal());
      expect([jpeg.format, jpeg.width, jpeg.height, jpeg.data.length]).toEqual(["rgba", 2, 2, 16]);
      expect([png.width, png.height, png.data.length]).toEqual([2, 2, 16]);
    } finally {
      await gate.dispose();
    }
  });

  test("a picture that cannot be read rejects with a plain error, and the thread decodes the next one", async () => {
    const gate = realGate();
    try {
      await expect(gate.decode(Uint8Array.from([0xff, 0xd8, 0xff, 1, 2, 3, 4, 5, 6, 7, 8, 9]), signal())).rejects.toThrow();
      expect((await gate.decode(copy(SMOKE_TEST_PNG), signal())).width).toBe(2);
    } finally {
      await gate.dispose();
    }
  });

  test("a picture over the worker's own pixel cap is refused inside it, before the codec", async () => {
    const gate = realGate(3);
    try {
      await expect(gate.decode(copy(SMOKE_TEST_PNG), signal())).rejects.toThrow(/pixel cap/);
    } finally {
      await gate.dispose();
    }
  });

  test("a cancel rejects with its reason, and the next decode gets a new thread that works", async () => {
    const gate = realGate();
    try {
      const controller = new AbortController();
      const decoding = gate.decode(copy(SMOKE_TEST_JPEG), controller.signal);
      controller.abort(new Error("cancelled by the owner"));
      await expect(decoding).rejects.toThrow("cancelled by the owner");
      expect((await gate.decode(copy(SMOKE_TEST_JPEG), signal())).height).toBe(2);
    } finally {
      await gate.dispose();
    }
  });

  test("after the idle time the thread is gone and the next decode starts another", async () => {
    const gate = realGate(16_777_216, { idleRecycleMs: 20 });
    try {
      await gate.decode(copy(SMOKE_TEST_PNG), signal());
      await new Promise<void>((resolve) => setTimeout(resolve, 80));
      expect((await gate.decode(copy(SMOKE_TEST_PNG), signal())).width).toBe(2);
    } finally {
      await gate.dispose();
    }
  });
});
