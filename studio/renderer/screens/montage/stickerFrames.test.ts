import { describe, expect, test } from "bun:test";
import { type StickerFrames, StickerFrameCache } from "./stickerFrames";

// 3d.4: a sticker's frames are decoded once per picture (WebCodecs `ImageDecoder` in the real window) and shared by every layer
// that shows it; the decoder is released when the last of them goes (a layer deleted, the clip changed, the editor closed). A
// decoder holds the whole file and its frame buffers, so none may outlive the preview.

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
  const opened: { url: string; resolve: (frames: StickerFrames | null) => void; frames: ReturnType<typeof fakeFrames> }[] = [];
  const open = (url: string): Promise<StickerFrames | null> =>
    new Promise((resolve) => {
      opened.push({ url, resolve, frames: fakeFrames() });
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
    const first = cache.acquire("data:a");
    const second = cache.acquire("data:a");
    expect(opened).toHaveLength(1);
    await answer(0);
    expect(await first).toBe(await second);
  });

  test("released by every layer, the decoder is closed; released by one of two, it is not", async () => {
    const { open, opened, answer } = opener();
    const cache = new StickerFrameCache(open);
    void cache.acquire("data:a");
    void cache.acquire("data:a");
    await answer(0);
    cache.release("data:a");
    expect(opened[0]?.frames.closed).toBe(0);
    cache.release("data:a");
    expect(opened[0]?.frames.closed).toBe(1);
  });

  test("released before it finished opening, it is closed as soon as it opens", async () => {
    const { open, opened, answer } = opener();
    const cache = new StickerFrameCache(open);
    void cache.acquire("data:a");
    cache.release("data:a");
    await answer(0);
    expect(opened[0]?.frames.closed).toBe(1);
  });

  test("asked for again after it was closed, it is opened afresh", async () => {
    const { open, opened, answer } = opener();
    const cache = new StickerFrameCache(open);
    void cache.acquire("data:a");
    await answer(0);
    cache.release("data:a");
    void cache.acquire("data:a");
    expect(opened).toHaveLength(2);
  });

  test("different pictures have their own decoders", () => {
    const { open, opened } = opener();
    const cache = new StickerFrameCache(open);
    void cache.acquire("data:a");
    void cache.acquire("data:b");
    expect(opened.map((o) => o.url)).toEqual(["data:a", "data:b"]);
  });

  test("closeAll releases every decoder still held (the editor closing)", async () => {
    const { open, opened, answer } = opener();
    const cache = new StickerFrameCache(open);
    void cache.acquire("data:a");
    void cache.acquire("data:b");
    await answer(0);
    await answer(1);
    cache.closeAll();
    expect(opened.map((o) => o.frames.closed)).toEqual([1, 1]);
  });

  test("a release of a picture never acquired changes nothing", () => {
    const cache = new StickerFrameCache(opener().open);
    expect(() => cache.release("data:none")).not.toThrow();
  });
});
