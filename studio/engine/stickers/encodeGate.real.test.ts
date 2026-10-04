import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { inspectApng } from "../../shared/stickers/apng";
import { decodeFrames } from "../../scripts/stickers/apngDecode.testkit";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { createStickerEncodeGate, createStickerEncodeSpawner } from "./encodeGate";
import { EncodeTooLargeError, EncodeWorkerError } from "./encodeErrors";
useNativeGlobals();

// The REAL encode worker (stickerEncodeWorker.ts, from source) behind the real gate: the wire format, a raw file read frame by frame, and what the
// worker does with a file that is not the size it was told. The scripted-worker tests are in encodeGate.test.ts.

const WORKER = new URL("./stickerEncodeWorker.ts", import.meta.url);
const dir = tempDirFor({ beforeEach, afterEach }, "studio-sticker-encode-");
const W = 9;
const H = 5;

const gate = (timeoutMs = 60_000) => createStickerEncodeGate({ spawnWorker: createStickerEncodeSpawner(WORKER), timeoutMs });
const signal = (): AbortSignal => new AbortController().signal;

function frame(n: number): Uint8Array {
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < out.length; i++) out[i] = (i * 3 + n * 53 + (i >> 2)) & 255;
  return out;
}

async function rawFile(frames: Uint8Array[]): Promise<string> {
  const path = join(dir(), "raw.rgba");
  await writeFile(path, Buffer.concat(frames));
  return path;
}

describe("the real encode worker", () => {
  test("writes the frames of a raw file as an APNG whose pixels are the file's and whose delays are the slots", async () => {
    const frames = [frame(0), frame(1), frame(2)];
    const rawPath = await rawFile(frames);
    const bytes = await gate().encode({ rawPath, width: W, height: H, slots: [3, 0, 2], maxBytes: 1 << 20 }, signal());
    const inspected = inspectApng(bytes);
    if (!inspected.ok) throw new Error(inspected.code);
    expect(inspected.info.frames.map((f) => f.delayFrames)).toEqual([3, 2]);
    const decoded = decodeFrames(bytes, W, H);
    expect([Buffer.from(decoded[0] ?? new Uint8Array()).equals(Buffer.from(frames[0] ?? new Uint8Array())), Buffer.from(decoded[1] ?? new Uint8Array()).equals(Buffer.from(frames[2] ?? new Uint8Array()))]).toEqual([true, true]);
  });

  test("a raw file that is not the size of its frames fails the job, and the next job still works", async () => {
    const short = await rawFile([frame(0), frame(1).subarray(0, 10)]);
    await expect(gate().encode({ rawPath: short, width: W, height: H, slots: [1, 1], maxBytes: 1 << 20 }, signal())).rejects.toBeInstanceOf(EncodeWorkerError);
    const good = await rawFile([frame(0), frame(1)]);
    expect((await gate().encode({ rawPath: good, width: W, height: H, slots: [1, 1], maxBytes: 1 << 20 }, signal())).length).toBeGreaterThan(0);
  });

  test("a raw file with bytes beyond its frames fails the job: it is not what was judged", async () => {
    const long = await rawFile([frame(0), frame(1), Uint8Array.of(1)]);
    await expect(gate().encode({ rawPath: long, width: W, height: H, slots: [1, 1], maxBytes: 1 << 20 }, signal())).rejects.toBeInstanceOf(EncodeWorkerError);
  });

  test("a raw file that is not there fails the job", async () => {
    await expect(gate().encode({ rawPath: join(dir(), "missing.rgba"), width: W, height: H, slots: [1], maxBytes: 1 << 20 }, signal())).rejects.toBeInstanceOf(EncodeWorkerError);
  });

  test("a file that passes the byte limit is EncodeTooLargeError", async () => {
    let seed = 99;
    const noise = (): Uint8Array => Uint8Array.from({ length: W * H * 4 }, () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) >> 16) & 255);
    const rawPath = await rawFile(Array.from({ length: 30 }, noise));
    await expect(gate().encode({ rawPath, width: W, height: H, slots: Array.from({ length: 30 }, () => 1), maxBytes: 1000 }, signal())).rejects.toBeInstanceOf(EncodeTooLargeError);
  });

  test("a cancel ends the thread and rejects with its reason", async () => {
    const rawPath = await rawFile([frame(0), frame(1)]);
    const controller = new AbortController();
    const encoding = gate().encode({ rawPath, width: W, height: H, slots: [1, 1], maxBytes: 1 << 20 }, controller.signal);
    controller.abort(new Error("cancelled by the owner"));
    await expect(encoding).rejects.toThrow("cancelled by the owner");
  });
});
