import { describe, expect, test } from "bun:test";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { EncodeTooLargeError, EncodeWorkerError } from "./encodeErrors";
import { createStickerEncodeGate, type EncodeWorkerLike } from "./encodeGate";
useNativeGlobals();

// The own-sticker encode gate (3f.5): compressing an owner's animation takes tens of seconds, so it runs in a `worker_thread`. A cancel or a time
// limit ENDS the thread; one thread per job, ended when the job is over. The worker here is scripted.

class FakeWorker implements EncodeWorkerLike {
  readonly posted: unknown[] = [];
  terminated = 0;
  #message: ((value: unknown) => void)[] = [];
  #error: ((error: Error) => void)[] = [];
  #exit: ((code: number) => void)[] = [];

  postMessage(message: unknown): void {
    this.posted.push(message);
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
  get id(): number {
    return (this.posted.at(-1) as { id: number }).id;
  }
  encoded(bytes = 8, id = this.id): void {
    for (const listener of this.#message) listener({ type: "encoded", id, apng: new ArrayBuffer(bytes) });
  }
  failed(reason: "too-large" | "failed", id = this.id): void {
    for (const listener of this.#message) listener({ type: "failed", id, reason, message: "text from the worker" });
  }
  say(message: unknown): void {
    for (const listener of this.#message) listener(message);
  }
  crash(): void {
    for (const listener of this.#error) listener(new Error("the worker died"));
  }
}

const JOB = { rawPath: "/work/raw.rgba", width: 4, height: 4, slots: [1, 2], maxBytes: 1000 };

function gateWith(options: { timeoutMs?: number } = {}) {
  const workers: FakeWorker[] = [];
  const gate = createStickerEncodeGate({
    spawnWorker: () => {
      const worker = new FakeWorker();
      workers.push(worker);
      return worker;
    },
    timeoutMs: options.timeoutMs ?? 60_000,
  });
  return { gate, workers };
}

const signal = (): AbortSignal => new AbortController().signal;
const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("createStickerEncodeGate", () => {
  test("starts no worker until the first job", () => {
    expect(gateWith().workers).toHaveLength(0);
  });

  test("hands the worker the job and answers the bytes it wrote", async () => {
    const { gate, workers } = gateWith();
    const encoding = gate.encode(JOB, signal());
    await tick();
    expect(workers[0]?.posted[0]).toMatchObject({ type: "encode", rawPath: JOB.rawPath, width: 4, height: 4, slots: [1, 2], maxBytes: 1000 });
    workers[0]?.encoded(16);
    expect((await encoding).length).toBe(16);
  });

  test("ends the worker once the job is over, so each job has a thread of its own", async () => {
    const { gate, workers } = gateWith();
    const first = gate.encode(JOB, signal());
    await tick();
    workers[0]?.encoded();
    await first;
    expect(workers[0]?.terminated).toBe(1);
    const second = gate.encode(JOB, signal());
    await tick();
    workers[1]?.encoded();
    await second;
    expect(workers).toHaveLength(2);
  });

  test("a worker that says the file is too large rejects with EncodeTooLargeError, and is ended", async () => {
    const { gate, workers } = gateWith();
    const encoding = gate.encode(JOB, signal());
    await tick();
    workers[0]?.failed("too-large");
    await expect(encoding).rejects.toBeInstanceOf(EncodeTooLargeError);
    expect(workers[0]?.terminated).toBe(1);
  });

  test("a worker that failed rejects with EncodeWorkerError, and its own text is not passed on", async () => {
    const { gate, workers } = gateWith();
    const encoding = gate.encode(JOB, signal());
    await tick();
    workers[0]?.failed("failed");
    const error = await encoding.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EncodeWorkerError);
    expect(String((error as Error).message)).not.toContain("text from the worker");
  });

  test("an answer larger than the byte limit is refused as too large, whatever the worker says", async () => {
    const { gate, workers } = gateWith();
    const encoding = gate.encode({ ...JOB, maxBytes: 10 }, signal());
    await tick();
    workers[0]?.encoded(11);
    await expect(encoding).rejects.toBeInstanceOf(EncodeTooLargeError);
  });

  test("a job that is already cancelled rejects with the reason and starts no worker", async () => {
    const { gate, workers } = gateWith();
    const controller = new AbortController();
    controller.abort(new Error("cancelled by the owner"));
    await expect(gate.encode(JOB, controller.signal)).rejects.toThrow("cancelled by the owner");
    expect(workers).toHaveLength(0);
  });

  test("a cancel in the middle ENDS the worker and rejects with the reason", async () => {
    const { gate, workers } = gateWith();
    const controller = new AbortController();
    const encoding = gate.encode(JOB, controller.signal);
    await tick();
    controller.abort(new Error("cancelled by the owner"));
    await expect(encoding).rejects.toThrow("cancelled by the owner");
    expect(workers[0]?.terminated).toBe(1);
  });

  test("an answer that arrives after a cancel is ignored", async () => {
    const { gate, workers } = gateWith();
    const controller = new AbortController();
    const encoding = gate.encode(JOB, controller.signal);
    await tick();
    controller.abort(new Error("cancelled"));
    workers[0]?.encoded();
    await expect(encoding).rejects.toThrow("cancelled");
  });

  test("a job that runs past its time limit ends its worker and rejects with EncodeWorkerError", async () => {
    const { gate, workers } = gateWith({ timeoutMs: 20 });
    const error = await gate.encode(JOB, signal()).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(EncodeWorkerError);
    expect(workers[0]?.terminated).toBe(1);
  });

  test("a worker that crashes rejects with EncodeWorkerError", async () => {
    const { gate, workers } = gateWith();
    const encoding = gate.encode(JOB, signal());
    await tick();
    workers[0]?.crash();
    await expect(encoding).rejects.toBeInstanceOf(EncodeWorkerError);
  });

  test("a worker that exits without answering rejects with EncodeWorkerError", async () => {
    const { gate, workers } = gateWith();
    const encoding = gate.encode(JOB, signal());
    await tick();
    await workers[0]?.terminate();
    await expect(encoding).rejects.toBeInstanceOf(EncodeWorkerError);
  });

  test("an answer to another request is not trusted: the worker is ended and the job fails", async () => {
    const { gate, workers } = gateWith();
    const encoding = gate.encode(JOB, signal());
    await tick();
    workers[0]?.encoded(8, 999);
    await expect(encoding).rejects.toBeInstanceOf(EncodeWorkerError);
    expect(workers[0]?.terminated).toBe(1);
  });

  test("an answer of the wrong shape is not trusted either", async () => {
    const { gate, workers } = gateWith();
    const encoding = gate.encode(JOB, signal());
    await tick();
    workers[0]?.say({ type: "encoded", id: workers[0]?.id, apng: "not a buffer" });
    await expect(encoding).rejects.toBeInstanceOf(EncodeWorkerError);
    expect(workers[0]?.terminated).toBe(1);
  });

  test("a worker that cannot be started rejects with EncodeWorkerError", async () => {
    const gate = createStickerEncodeGate({
      spawnWorker: () => {
        throw new Error("no thread");
      },
      timeoutMs: 1000,
    });
    await expect(gate.encode(JOB, signal())).rejects.toBeInstanceOf(EncodeWorkerError);
  });

  test("a job that breaks the protocol's rules is refused before any worker starts", async () => {
    const { gate, workers } = gateWith();
    await expect(gate.encode({ ...JOB, slots: [0, 0] }, signal())).rejects.toBeInstanceOf(EncodeWorkerError);
    await expect(gate.encode({ ...JOB, width: 100_000 }, signal())).rejects.toBeInstanceOf(EncodeWorkerError);
    expect(workers).toHaveLength(0);
  });
});
