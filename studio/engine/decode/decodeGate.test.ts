import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { createDecodeGate, DecodeWorkerError, type DecodeWorkerLike } from "./decodeGate";
useNativeGlobals();

// The own-photo decode gate (3f.2 fix round 1, H1): the engine's WASM JPEG/PNG decode of a picture the owner picked runs in a
// `worker_thread`, so the engine's event loop stays free, a cancel or a timeout ENDS the worker (synchronous WASM cannot be interrupted any
// other way), and the WASM memory, which only ever grows, goes back with the worker when it is idle. The worker here is scripted: nothing
// below depends on how long a real decode takes.

class FakeWorker implements DecodeWorkerLike {
  readonly posted: { message: unknown; transfer: readonly unknown[] }[] = [];
  terminated = 0;
  #message: ((value: unknown) => void)[] = [];
  #error: ((error: Error) => void)[] = [];
  #exit: ((code: number) => void)[] = [];

  postMessage(message: unknown, transfer: readonly Transferable[] = []): void {
    this.posted.push({ message, transfer });
  }
  on(event: "message" | "error" | "exit", listener: never): this {
    if (event === "message") this.#message.push(listener);
    else if (event === "error") this.#error.push(listener);
    else this.#exit.push(listener);
    return this;
  }
  async terminate(): Promise<number> {
    this.terminated++;
    for (const listener of this.#exit) listener(1);
    return 1;
  }
  /** The worker answers the request it was last given. */
  answer(width: number, height: number, byteLength = width * height * 4): void {
    const last = this.posted.at(-1)?.message as { id: number };
    for (const listener of this.#message) listener({ type: "decoded", id: last.id, width, height, data: new ArrayBuffer(byteLength) });
  }
  refuse(text: string): void {
    const last = this.posted.at(-1)?.message as { id: number };
    for (const listener of this.#message) listener({ type: "failed", id: last.id, message: text });
  }
  say(message: unknown): void {
    for (const listener of this.#message) listener(message);
  }
  crash(): void {
    for (const listener of this.#error) listener(new Error("the worker died"));
  }
}

function gateWith(options: { idleRecycleMs?: number; timeoutMs?: number; bigResultBytes?: number } = {}) {
  const workers: FakeWorker[] = [];
  const gate = createDecodeGate({
    spawnWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    idleRecycleMs: options.idleRecycleMs ?? 60_000,
    timeoutMs: options.timeoutMs ?? 60_000,
    ...(options.bigResultBytes === undefined ? {} : { bigResultBytes: options.bigResultBytes }),
  });
  return { gate, workers };
}

const signal = (): AbortSignal => new AbortController().signal;
const bytes = (n = 4): Uint8Array => new Uint8Array(n).fill(7);
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("createDecodeGate: a decode", () => {
  test("starts no worker until the first decode", () => {
    const { workers } = gateWith();
    expect(workers).toHaveLength(0);
  });

  test("hands the picture's bytes to the worker and answers the pixels it decoded", async () => {
    const { gate, workers } = gateWith();
    const decoding = gate.decode(bytes(), signal());
    await tick();
    workers[0]?.answer(2, 3);
    const image = await decoding;
    expect([image.format, image.width, image.height, image.data.length]).toEqual(["rgba", 2, 3, 24]);
  });

  test("transfers the buffer instead of copying it when the bytes are the whole buffer", async () => {
    const { gate, workers } = gateWith();
    const source = bytes(16);
    const decoding = gate.decode(source, signal());
    await tick();
    expect(workers[0]?.posted[0]?.transfer).toHaveLength(1);
    workers[0]?.answer(1, 1);
    await decoding;
  });

  test("copies a view into a larger buffer, and leaves the caller's buffer alone", async () => {
    const { gate, workers } = gateWith();
    const whole = new Uint8Array(32).fill(1);
    const decoding = gate.decode(whole.subarray(8, 16), signal());
    await tick();
    expect(whole.buffer.byteLength).toBe(32);
    const sent = workers[0]?.posted[0]?.message as { bytes: ArrayBuffer };
    expect(sent.bytes.byteLength).toBe(8);
    workers[0]?.answer(1, 1);
    await decoding;
  });

  test("a picture the worker could not read rejects with its message, and the worker lives on for the next one", async () => {
    const { gate, workers } = gateWith();
    const first = gate.decode(bytes(), signal());
    await tick();
    workers[0]?.refuse("not a JPEG");
    await expect(first).rejects.toThrow("not a JPEG");
    const second = gate.decode(bytes(), signal());
    await tick();
    workers[0]?.answer(1, 1);
    await second;
    expect(workers).toHaveLength(1);
    expect(workers[0]?.terminated).toBe(0);
  });

  test("one decode at a time: the second is posted only when the first is answered", async () => {
    const { gate, workers } = gateWith();
    const first = gate.decode(bytes(), signal());
    const second = gate.decode(bytes(), signal());
    await tick();
    expect(workers[0]?.posted).toHaveLength(1);
    workers[0]?.answer(1, 1);
    await first;
    await tick();
    expect(workers[0]?.posted).toHaveLength(2);
    workers[0]?.answer(1, 1);
    await second;
  });

  test("an answer with the wrong id, or of a shape the contract does not take, is not acted on: the worker is ended and the decode fails", async () => {
    for (const reply of [{ type: "decoded", id: 999, width: 1, height: 1, data: new ArrayBuffer(4) }, { type: "decoded", id: 0, width: 1, height: 1, data: new ArrayBuffer(3) }, { type: "nonsense" }, "text"]) {
      const { gate, workers } = gateWith();
      const decoding = gate.decode(bytes(), signal());
      await tick();
      const id = (workers[0]?.posted[0]?.message as { id: number }).id;
      workers[0]?.say(typeof reply === "object" && "id" in reply && reply.id === 0 ? { ...reply, id } : reply);
      await expect(decoding).rejects.toBeInstanceOf(DecodeWorkerError);
      expect(workers[0]?.terminated).toBe(1);
    }
  });
});

describe("createDecodeGate: stopping a decode", () => {
  test("an abort during the decode ENDS the worker and rejects with the signal's reason, without waiting for the worker", async () => {
    const { gate, workers } = gateWith();
    const controller = new AbortController();
    const decoding = gate.decode(bytes(), controller.signal);
    await tick();
    controller.abort(new Error("cancelled by the owner"));
    await expect(decoding).rejects.toThrow("cancelled by the owner");
    expect(workers[0]?.terminated).toBe(1);
  });

  test("a signal that is already aborted starts no worker", async () => {
    const { gate, workers } = gateWith();
    const controller = new AbortController();
    controller.abort(new Error("already"));
    await expect(gate.decode(bytes(), controller.signal)).rejects.toThrow("already");
    expect(workers).toHaveLength(0);
  });

  test("the next decode after an abort gets a fresh worker", async () => {
    const { gate, workers } = gateWith();
    const controller = new AbortController();
    const first = gate.decode(bytes(), controller.signal);
    await tick();
    controller.abort(new Error("stop"));
    await first.catch(() => undefined);
    const second = gate.decode(bytes(), signal());
    await tick();
    expect(workers).toHaveLength(2);
    workers[1]?.answer(1, 1);
    await second;
  });

  test("an abort of a decode that is still WAITING its turn rejects it without touching the worker that is busy", async () => {
    const { gate, workers } = gateWith();
    const first = gate.decode(bytes(), signal());
    const controller = new AbortController();
    const second = gate.decode(bytes(), controller.signal);
    await tick();
    controller.abort(new Error("changed my mind"));
    await expect(second).rejects.toThrow("changed my mind");
    expect(workers[0]?.terminated).toBe(0);
    workers[0]?.answer(1, 1);
    await first;
    expect(workers[0]?.posted).toHaveLength(1);
  });

  test("a decode that runs past its time limit ends the worker and fails as a worker problem, not as a bad picture", async () => {
    const { gate, workers } = gateWith({ timeoutMs: 20 });
    const error = await gate.decode(bytes(), signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(DecodeWorkerError);
    expect(workers[0]?.terminated).toBe(1);
  });

  test("a worker that dies mid-decode fails the decode as a worker problem, and the next decode starts a new one", async () => {
    const { gate, workers } = gateWith();
    const first = gate.decode(bytes(), signal());
    await tick();
    workers[0]?.crash();
    await expect(first).rejects.toBeInstanceOf(DecodeWorkerError);
    const second = gate.decode(bytes(), signal());
    await tick();
    expect(workers).toHaveLength(2);
    workers[1]?.answer(1, 1);
    await second;
  });
});

describe("createDecodeGate: giving the memory back", () => {
  test("an idle worker is ended after the idle time, and the next decode starts a fresh one", async () => {
    const { gate, workers } = gateWith({ idleRecycleMs: 15 });
    const first = gate.decode(bytes(), signal());
    await tick();
    workers[0]?.answer(1, 1);
    await first;
    while (workers[0]?.terminated === 0) await tick();
    expect(workers[0]?.terminated).toBe(1);
    const second = gate.decode(bytes(), signal());
    await tick();
    expect(workers).toHaveLength(2);
    workers[1]?.answer(1, 1);
    await second;
  });

  test("the worker is not ended while a decode is running, however long the idle time was", async () => {
    const { gate, workers } = gateWith({ idleRecycleMs: 5 });
    const decoding = gate.decode(bytes(), signal());
    for (let i = 0; i < 20; i++) await tick();
    expect(workers[0]?.terminated).toBe(0);
    workers[0]?.answer(1, 1);
    await decoding;
  });

  test("a big result ends the worker at once: its WASM memory is the part that does not shrink", async () => {
    const { gate, workers } = gateWith({ bigResultBytes: 100 });
    const decoding = gate.decode(bytes(), signal());
    await tick();
    workers[0]?.answer(10, 10);
    await decoding;
    expect(workers[0]?.terminated).toBe(1);
  });

  test("a small result keeps the worker for the next decode", async () => {
    const { gate, workers } = gateWith({ bigResultBytes: 1000 });
    const decoding = gate.decode(bytes(), signal());
    await tick();
    workers[0]?.answer(2, 2);
    await decoding;
    expect(workers[0]?.terminated).toBe(0);
  });

  test("dispose ends the worker, and a decode after it starts a new one", async () => {
    const { gate, workers } = gateWith();
    const decoding = gate.decode(bytes(), signal());
    await tick();
    workers[0]?.answer(1, 1);
    await decoding;
    await gate.dispose();
    expect(workers[0]?.terminated).toBe(1);
  });
});

describe("createDecodeGate: what it does not keep (fix round 2)", () => {
  // That the gate does not keep the last decoded picture alive needs a precise GC, which Bun's is not: it is decodeGate.node-test.ts, under Electron's Node.

  test("a worker that was already replaced says nothing about the present: its message is ignored", async () => {
    const { gate, workers } = gateWith();
    const controller = new AbortController();
    const first = gate.decode(bytes(), controller.signal);
    await tick();
    controller.abort(new Error("stop"));
    await first.catch(() => undefined);
    const second = gate.decode(bytes(), signal());
    await tick();
    const id = (workers[1]?.posted[0]?.message as { id: number }).id;
    workers[0]?.say({ type: "failed", id, message: "from the stale worker" });
    workers[1]?.answer(1, 1);
    expect((await second).width).toBe(1);
    expect(workers[1]?.terminated).toBe(0);
  });

  test("a replaced worker that fails or exits later does not fail the decode that is running now", async () => {
    const { gate, workers } = gateWith();
    const controller = new AbortController();
    const first = gate.decode(bytes(), controller.signal);
    await tick();
    controller.abort(new Error("stop"));
    await first.catch(() => undefined);
    const second = gate.decode(bytes(), signal());
    await tick();
    workers[0]?.crash();
    workers[1]?.answer(1, 1);
    expect((await second).width).toBe(1);
  });

  test("the next worker is spawned only after the one that was ended has finished ending (a thread ended while it loads prints an error otherwise)", async () => {
    let release: () => void = () => undefined;
    const slow = new Promise<void>((resolve) => (release = resolve));
    const workers: FakeWorker[] = [];
    const order: string[] = [];
    const gate = createDecodeGate({
      spawnWorker: () => {
        const worker = new FakeWorker();
        const index = workers.length;
        if (index === 0) worker.terminate = async () => (order.push("ending"), await slow, order.push("ended"), 1);
        order.push(`spawn ${index}`);
        workers.push(worker);
        return worker;
      },
      idleRecycleMs: 60_000,
      timeoutMs: 60_000,
    });
    const controller = new AbortController();
    const first = gate.decode(bytes(), controller.signal);
    await tick();
    controller.abort(new Error("stop"));
    // The abort itself does not wait for the worker to end.
    await expect(first).rejects.toThrow("stop");
    const second = gate.decode(bytes(), signal());
    for (let turn = 0; turn < 5; turn++) await tick();
    expect(order).toEqual(["spawn 0", "ending"]);
    release();
    await tick();
    await tick();
    expect(order).toEqual(["spawn 0", "ending", "ended", "spawn 1"]);
    workers[1]?.answer(1, 1);
    await second;
  });
});
