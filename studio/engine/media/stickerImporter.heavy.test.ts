import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { readFile, stat } from "node:fs/promises";
import { MEDIA_BYTE_CAPS } from "../../shared/engine";
import { inspectApng, STICKER_LIMITS } from "../../shared/stickers/apng";
import { buildGif, lzwCompress, type TestGifFrame } from "../../shared/stickers/gif.testkit";
import { heavyTest } from "../../testing/bunTiers";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { tempDirFor } from "../../testing/tempDir";
import { createStickerEncodeGate, createStickerEncodeSpawner, type EncodeWorkerLike } from "../stickers/encodeGate";
import { handoff } from "./photoFixtures.testkit";
import { MAX_ANIMATION_LOOP_PIXELS } from "../render/layerPass";
import { createStickerImporter } from "./stickerImporter";
useNativeGlobals();

// The own-sticker importer at the caps (3f.5), with the REAL encode worker thread and the real ffmpeg: a 480 x 480 GIF of 300 frames, which quantises
// to a loop of exactly 300 frames at 30 fps (the longest loop, on the largest canvas the render's memory rule lets that loop have: 720 x 720 is
// 166 frames, below). Heavy: the raw frames are hundreds of MiB on disk and the hand-written deflate works over all of them, so this runs in the
// weekly tier; the default tier proves the same paths on small files (stickerImporter.test.ts, encodeGate.real.test.ts).

const tmp = tempDirFor({ beforeEach, afterEach }, "studio-sticker-heavy-");
const WORKER = new URL("../stickers/stickerEncodeWorker.ts", import.meta.url);
const SIDE = 480;
const FRAMES = STICKER_LIMITS.maxLoopFrames;

function spyingGate(workers: { spawned: number; terminated: number; started: () => void }) {
  const spawn = createStickerEncodeSpawner(WORKER);
  return createStickerEncodeGate({
    timeoutMs: 600_000,
    spawnWorker: (): EncodeWorkerLike => {
      const worker = spawn();
      workers.spawned += 1;
      const terminate = worker.terminate.bind(worker);
      worker.terminate = async () => {
        workers.terminated += 1;
        return terminate();
      };
      workers.started();
      return worker;
    },
  });
}

/** `count` frames of flat colour on a `side` square, delays of 3, 3 and 4 cs repeated (about a slot a frame). */
function gifOf(count: number, side: number): Uint8Array {
  const flat = Array.from({ length: 4 }, (_, colour) => lzwCompress(new Uint8Array(side * side).fill(colour)));
  const frames: TestGifFrame[] = Array.from({ length: count }, (_, k) => ({ delayCs: [3, 3, 4][k % 3] ?? 3, indices: [], rawData: flat[k % 4] ?? new Uint8Array() }));
  return buildGif({ width: side, height: side, frames });
}

describe("the sticker importer at the caps", () => {
  // The edge of the render's memory rule (MAX_ANIMATION_LOOP_PIXELS): the biggest loops it takes are stored, for real; one frame more is refused (the
  // default tier pins that without decoding anything, stickerImporter.cap.test.ts).
  for (const [count, side] of [
    [166, 720],
    [300, 480],
  ] as const) {
    heavyTest(
      `a ${side} x ${side} sticker of ${count} frames, the largest loop the render's memory rule allows at that size, is stored whole`,
      async () => {
        expect(count * side * side).toBeLessThanOrEqual(MAX_ANIMATION_LOOP_PIXELS);
        const importer = createStickerImporter({ encode: spyingGate({ spawned: 0, terminated: 0, started: () => undefined }).encode });
        const hand = await handoff(tmp(), gifOf(count, side), { format: "gif", kind: "sticker" });
        const outcome = await importer(hand.request);
        if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);
        expect(outcome.facts.loopFrames).toBe(count);
        const inspected = inspectApng(new Uint8Array(await readFile(outcome.output?.file.path ?? "")));
        expect(inspected.ok && inspected.info.loopFrames).toBe(count);
      },
      600_000,
    );
  }

  heavyTest(
    "a 480 x 480 GIF of 300 frames is stored as an APNG of 300 frames within the 5 MB cap, and the engine's loop stays free while the worker encodes",
    async () => {
      const bytes = gifOf(FRAMES, SIDE);
      expect(bytes.length).toBeLessThan(MEDIA_BYTE_CAPS.sticker);
      const workers = { spawned: 0, terminated: 0, started: () => undefined };
      const importer = createStickerImporter({ encode: spyingGate(workers).encode });
      const hand = await handoff(tmp(), bytes, { format: "gif", kind: "sticker" });
      // The engine's own loop keeps running while the worker compresses: timers fire between the import's awaits. (No wall-clock assert: only that it did.)
      let ticks = 0;
      const ticker = setInterval(() => void ticks++, 5);
      let outcome;
      try {
        outcome = await importer(hand.request);
      } finally {
        clearInterval(ticker);
      }
      if (!outcome.ok) throw new Error(`refused: ${outcome.reason}`);
      expect(outcome.facts).toMatchObject({ width: SIDE, height: SIDE, loopFrames: FRAMES });
      expect(outcome.facts.delayFrames).toHaveLength(FRAMES);
      expect(outcome.facts.delayFrames?.every((delay) => delay === 1)).toBe(true);
      const file = outcome.output?.file.path ?? "";
      expect((await stat(file)).size).toBeLessThanOrEqual(MEDIA_BYTE_CAPS.sticker);
      const inspected = inspectApng(new Uint8Array(await readFile(file)));
      if (!inspected.ok) throw new Error(`${inspected.code}: ${inspected.detail}`);
      expect([inspected.info.frameCount, inspected.info.loopFrames, inspected.info.width, inspected.info.height]).toEqual([FRAMES, FRAMES, SIDE, SIDE]);
      expect(workers.spawned).toBe(1);
      expect(workers.terminated).toBe(1);
      expect(ticks).toBeGreaterThan(5);
    },
    600_000,
  );

  heavyTest(
    "a cancel while the worker is encoding ends its thread and answers cancelled, and nothing is stored",
    async () => {
      const bytes = gifOf(FRAMES, SIDE);
      let begun: () => void = () => undefined;
      const encoding = new Promise<void>((resolve) => (begun = resolve));
      const workers = { spawned: 0, terminated: 0, started: () => begun() };
      const importer = createStickerImporter({ encode: spyingGate(workers).encode });
      const hand = await handoff(tmp(), bytes, { format: "gif", kind: "sticker" });
      const running = importer(hand.request);
      await encoding;
      hand.controller.abort();
      expect(await running).toEqual({ ok: false, reason: "cancelled" });
      expect(workers.terminated).toBe(1);
      const out = hand.works[1]?.path;
      expect(out === undefined ? false : await stat(out).then(() => true, () => false)).toBe(false);
    },
    600_000,
  );
});
