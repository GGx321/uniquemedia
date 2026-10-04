import { afterEach, describe, expect, test } from "bun:test";
import type { EngineClient } from "../../engine/client";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import { mockStickerBytes } from "../../engine/mockStickers";
import { ManualScheduler } from "../../engine/scheduler";
import { openWithImageDecoder, type StickerFrames, StickerFrameCache, stickerFramesFrom } from "./stickerFrames";

// 3d.4: a sticker's frames are decoded once per picture by WebCodecs `ImageDecoder` and shared by every layer that shows it; the
// decoder is released when the last of them goes (a layer deleted, the clip changed, the editor closed). A decoder holds the whole
// file and its frame buffers, so none may outlive the preview. Review round 1: the bytes come from main over IPC
// (`stickers.bytes`), never from a read of the media scheme; the decoder is made with `colorSpaceConversion: "none"` (the 3b.5
// hand-off: Chrome applies a PNG's gAMA / iCCP by default, ffmpeg ignores them).

function fakeFrames(): StickerFrames & { closed: number } {
  const frames = {
    frameCount: 24,
    closed: 0,
    frame: () => Promise.resolve(null),
    close(): void {
      frames.closed += 1;
    },
  };
  return frames;
}

/** An opener the test answers by hand: one pending open per call. */
function opener() {
  const opened: { key: string; resolve: (frames: StickerFrames | null) => void; frames: ReturnType<typeof fakeFrames> }[] = [];
  const open = (key: string): Promise<StickerFrames | null> =>
    new Promise((resolve) => {
      opened.push({ key, resolve, frames: fakeFrames() });
    });
  const answer = async (index: number): Promise<void> => {
    const entry = opened[index];
    entry?.resolve(entry.frames);
    for (let i = 0; i < 5; i++) await Promise.resolve();
  };
  return { open, opened, answer };
}

describe("the sticker frame cache", () => {
  test("two layers of the same sticker share one decoder", async () => {
    const { open, opened, answer } = opener();
    const cache = new StickerFrameCache(open);
    const first = cache.acquire("heart-pulse");
    const second = cache.acquire("heart-pulse");
    expect(opened).toHaveLength(1);
    await answer(0);
    expect(await first).toBe(await second);
  });

  test("released by every layer, the decoder is closed; released by one of two, it is not", async () => {
    const { open, opened, answer } = opener();
    const cache = new StickerFrameCache(open);
    void cache.acquire("heart-pulse");
    void cache.acquire("heart-pulse");
    await answer(0);
    cache.release("heart-pulse");
    expect(opened[0]?.frames.closed).toBe(0);
    cache.release("heart-pulse");
    expect(opened[0]?.frames.closed).toBe(1);
  });

  test("released before it finished opening, it is closed as soon as it opens", async () => {
    const { open, opened, answer } = opener();
    const cache = new StickerFrameCache(open);
    void cache.acquire("heart-pulse");
    cache.release("heart-pulse");
    await answer(0);
    expect(opened[0]?.frames.closed).toBe(1);
  });

  test("asked for again after it was closed, it is opened afresh", async () => {
    const { open, opened, answer } = opener();
    const cache = new StickerFrameCache(open);
    void cache.acquire("heart-pulse");
    await answer(0);
    cache.release("heart-pulse");
    void cache.acquire("heart-pulse");
    expect(opened).toHaveLength(2);
  });

  test("different stickers have their own decoders", () => {
    const { open, opened } = opener();
    const cache = new StickerFrameCache(open);
    void cache.acquire("heart-pulse");
    void cache.acquire("star-spin");
    expect(opened.map((o) => o.key)).toEqual(["heart-pulse", "star-spin"]);
  });

  test("closeAll releases every decoder still held (the editor closing)", async () => {
    const { open, opened, answer } = opener();
    const cache = new StickerFrameCache(open);
    void cache.acquire("heart-pulse");
    void cache.acquire("star-spin");
    await answer(0);
    await answer(1);
    cache.closeAll();
    expect(opened.map((o) => o.frames.closed)).toEqual([1, 1]);
  });

  test("a release of a sticker never acquired changes nothing", () => {
    const cache = new StickerFrameCache(opener().open);
    expect(() => cache.release("heart-pulse")).not.toThrow();
  });
});

// ---------- the window's decoder ----------

interface FakeDecoderControl {
  /** The init each decoder was made with. */
  readonly inits: ImageDecoderInit[];
  /** How many decoders were closed. */
  closed: number;
  /** The frame indexes asked of `decode`. */
  readonly decoded: number[];
  supported: boolean;
  readyFails: boolean;
}

/** A stand-in for WebCodecs' `ImageDecoder` (the test DOM has none), recording what it is asked. */
function installImageDecoder(frameCount = 24): FakeDecoderControl {
  const control: FakeDecoderControl = { inits: [], closed: 0, decoded: [], supported: true, readyFails: false };
  class FakeImageDecoder {
    static isTypeSupported(): Promise<boolean> {
      return Promise.resolve(control.supported);
    }
    readonly tracks: { ready: Promise<void>; selectedTrack: { frameCount: number } };
    readonly completed: Promise<void>;
    constructor(init: ImageDecoderInit) {
      control.inits.push(init);
      this.tracks = { ready: control.readyFails ? Promise.reject(new Error("broken file")) : Promise.resolve(), selectedTrack: { frameCount } };
      this.completed = Promise.resolve();
    }
    decode(options: { frameIndex: number }): Promise<{ image: { close(): void } }> {
      control.decoded.push(options.frameIndex);
      return Promise.resolve({ image: { close: () => undefined } });
    }
    close(): void {
      control.closed += 1;
    }
  }
  Object.defineProperty(globalThis, "ImageDecoder", { value: FakeImageDecoder, configurable: true, writable: true });
  return control;
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "ImageDecoder");
});

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

describe("openWithImageDecoder", () => {
  test("makes the decoder from the bytes as a PNG, with the colours untouched (colorSpaceConversion: none)", async () => {
    const control = installImageDecoder();
    const frames = await openWithImageDecoder(PNG);
    expect(frames?.frameCount).toBe(24);
    expect(control.inits).toHaveLength(1);
    const init = control.inits[0];
    expect([init?.type, init?.colorSpaceConversion]).toEqual(["image/png", "none"]);
    expect(init?.data instanceof Uint8Array ? [...init.data] : null).toEqual([...PNG]);
  });

  test("a frame index past the frames is the last frame; a decoded frame is handed over to be closed", async () => {
    const control = installImageDecoder(24);
    const frames = await openWithImageDecoder(PNG);
    const frame = await frames?.frame(30);
    expect(control.decoded).toEqual([23]);
    expect(typeof frame?.close).toBe("function");
  });

  test("a file the decoder cannot read (its tracks never get ready) is closed and gives no frames", async () => {
    const control = installImageDecoder();
    control.readyFails = true;
    expect(await openWithImageDecoder(PNG)).toBe(null);
    expect(control.closed).toBe(1);
  });

  test("a window without ImageDecoder, or one that does not take PNG, decodes nothing (the picture itself is shown)", async () => {
    expect(await openWithImageDecoder(PNG)).toBe(null);
    const control = installImageDecoder();
    control.supported = false;
    expect(await openWithImageDecoder(PNG)).toBe(null);
    expect(control.inits).toHaveLength(0);
  });

  test("closed, it decodes nothing more, and a close is idempotent", async () => {
    const control = installImageDecoder();
    const frames = await openWithImageDecoder(PNG);
    frames?.close();
    frames?.close();
    expect(await frames?.frame(0)).toBe(null);
    expect([control.closed, control.decoded.length]).toEqual([1, 0]);
  });
});

describe("stickerFramesFrom: the bytes come from main over IPC", () => {
  const mock = (): EngineClient => mockEngineClient(new MockEngine({ scheduler: new ManualScheduler() }));

  test("asks stickers.bytes for the sticker and decodes exactly the bytes main answered", async () => {
    const control = installImageDecoder();
    const client = mock();
    const asked: string[] = [];
    const spy: EngineClient = { ...client, request: (type, payload) => (asked.push(type), client.request(type, payload)) };
    const frames = await stickerFramesFrom(spy)("heart-pulse");
    expect(frames === null).toBe(false);
    expect(asked).toEqual(["stickers.bytes"]);
    const data = control.inits[0]?.data;
    expect(data instanceof Uint8Array ? [...data] : null).toEqual([...(mockStickerBytes("heart-pulse") ?? [])]);
  });

  test("a sticker main does not hold (NOT_FOUND) decodes nothing", async () => {
    const control = installImageDecoder();
    expect(await stickerFramesFrom(mock())("sticker-nowhere")).toBe(null);
    expect(control.inits).toHaveLength(0);
  });
});
