import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, render } from "@testing-library/react";
import type { MontageDraft } from "../../../shared/engine";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import { EngineProvider } from "../../engine/react";
import { ManualScheduler } from "../../engine/scheduler";
import { fakeFrameClock } from "./clock.testkit";
import { PlayheadStore } from "./playhead";
import { PreviewAudio } from "./PreviewAudio";
import { StickerCanvas } from "./StickerCanvas";
import { type DecodedFrame, type StickerFrames, StickerFrameCache } from "./stickerFrames";
import { draftSpec } from "./testkit";

// 3d.4: two parts of the preview tested on their own. The sticker canvas draws the frame the playhead's tick picks, decoded by the
// editor's shared decoder, closes each decoded frame once drawn, never draws a late decode over a newer one, and releases its
// decoder when it goes. The music element follows the playhead clock: started at the track's place, moved when far off, paused with it.

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
});

const settle = async (): Promise<void> => {
  await act(async () => {
    for (let i = 0; i < 10; i++) await Promise.resolve();
  });
};

/** A canvas context that records what was drawn. */
function recordCanvas(): { drawn: unknown[] } {
  const drawn: unknown[] = [];
  const context = { clearRect: () => undefined, drawImage: (image: unknown) => drawn.push(image) };
  const spy = spyOn(HTMLCanvasElement.prototype, "getContext").mockImplementation(() => context as never);
  restores.push(() => spy.mockRestore());
  return { drawn };
}

/** Decoded frames answered by hand, each one recording whether it was closed. */
function fakeDecoder() {
  const asked: { index: number; resolve: () => void; frame: DecodedFrame & { closed: boolean } }[] = [];
  let closed = 0;
  const frames: StickerFrames = {
    frameCount: 24,
    frame: (index) =>
      new Promise<DecodedFrame | null>((resolve) => {
        const frame = {
          image: { index } as unknown as CanvasImageSource,
          closed: false,
          close(): void {
            frame.closed = true;
          },
        };
        asked.push({ index, resolve: () => resolve(frame), frame });
      }),
    close: () => {
      closed += 1;
    },
  };
  return { frames, asked, closedCount: () => closed };
}

describe("the sticker canvas", () => {
  test("draws the frame it is told, from the shared decoder, and closes each decoded frame once drawn", async () => {
    const { drawn } = recordCanvas();
    const decoder = fakeDecoder();
    const cache = new StickerFrameCache(() => Promise.resolve(decoder.frames));
    const view = render(<StickerCanvas cache={cache} stickerId="heart-pulse" url="data:sticker" frameIndex={3} side={320} />);
    await settle();
    expect(decoder.asked.map((a) => a.index)).toEqual([3]);
    act(() => decoder.asked[0]?.resolve());
    await settle();
    expect(drawn).toEqual([{ index: 3 }]);
    expect(decoder.asked[0]?.frame.closed).toBe(true);
    view.rerender(<StickerCanvas cache={cache} stickerId="heart-pulse" url="data:sticker" frameIndex={4} side={320} />);
    await settle();
    expect(decoder.asked.map((a) => a.index)).toEqual([3, 4]);
    expect(view.container.querySelector("canvas")?.getAttribute("data-frame")).toBe("4");
  });

  test("a decode that lands after a newer one is not drawn over it (and is still closed)", async () => {
    const { drawn } = recordCanvas();
    const decoder = fakeDecoder();
    const cache = new StickerFrameCache(() => Promise.resolve(decoder.frames));
    const view = render(<StickerCanvas cache={cache} stickerId="heart-pulse" url="data:sticker" frameIndex={5} side={320} />);
    await settle();
    view.rerender(<StickerCanvas cache={cache} stickerId="heart-pulse" url="data:sticker" frameIndex={6} side={320} />);
    await settle();
    act(() => decoder.asked[1]?.resolve());
    await settle();
    act(() => decoder.asked[0]?.resolve());
    await settle();
    expect(drawn).toEqual([{ index: 6 }]);
    expect(decoder.asked.map((a) => a.frame.closed)).toEqual([true, true]);
  });

  test("its decoder is released when it goes (the last canvas of the picture closes it)", async () => {
    recordCanvas();
    const decoder = fakeDecoder();
    const cache = new StickerFrameCache(() => Promise.resolve(decoder.frames));
    const one = render(<StickerCanvas cache={cache} stickerId="heart-pulse" url="data:sticker" frameIndex={0} side={320} />);
    const two = render(<StickerCanvas cache={cache} stickerId="heart-pulse" url="data:sticker" frameIndex={0} side={320} />);
    await settle();
    one.unmount();
    expect(decoder.closedCount()).toBe(0);
    two.unmount();
    expect(decoder.closedCount()).toBe(1);
  });

  test("where the window cannot decode the picture, the picture itself is shown", async () => {
    const cache = new StickerFrameCache(() => Promise.resolve(null));
    const view = render(<StickerCanvas cache={cache} stickerId="heart-pulse" url="data:image/png;base64,AA==" frameIndex={0} side={320} />);
    await settle();
    expect(view.container.querySelector("img")?.getAttribute("src")).toBe("data:image/png;base64,AA==");
    expect(view.container.querySelector("canvas") === null).toBe(true);
  });
});

describe("the music element", () => {
  const MUSIC: MontageDraft["music"] = { source: "trending", trackId: "track-espresso-01", startMs: 42_000 };

  /** The real client's addresses over the mock's answers (its media are main's routes). */
  function windowClient() {
    return { ...mockEngineClient(new MockEngine({ scheduler: new ManualScheduler() })), kind: "window" as const };
  }

  /** The `<audio>` with its media calls recorded: the test DOM plays nothing. `refuse` makes `play()` reject as a file it cannot play. */
  function recordAudio(element: HTMLAudioElement, options: { readyState?: number; refuse?: boolean } = {}) {
    const calls: string[] = [];
    let time = 0;
    let paused = true;
    let rate = 1;
    Object.defineProperty(element, "currentTime", {
      get: () => time,
      set: (value: number) => {
        time = value;
        calls.push(`seek ${value}`);
      },
    });
    Object.defineProperty(element, "paused", { get: () => paused });
    Object.defineProperty(element, "duration", { get: () => 180 });
    Object.defineProperty(element, "seeking", { get: () => false });
    Object.defineProperty(element, "readyState", { get: () => options.readyState ?? 4 });
    Object.defineProperty(element, "playbackRate", {
      get: () => rate,
      set: (value: number) => {
        rate = value;
        calls.push(`rate ${value}`);
      },
    });
    element.play = () => {
      calls.push("play");
      if (options.refuse === true) return Promise.reject(new DOMException("no decoder for this file", "NotSupportedError"));
      paused = false;
      return Promise.resolve();
    };
    element.pause = () => {
      paused = true;
      calls.push("pause");
    };
    return { calls, at: (seconds: number) => (time = seconds) };
  }

  function mount(playhead: PlayheadStore) {
    return render(
      <EngineProvider client={windowClient()}>
        <PreviewAudio spec={draftSpec(4, { music: MUSIC })} playhead={playhead} />
      </EngineProvider>,
    );
  }

  test("plays the stored track from its start plus the playhead, follows the clock, pauses with it", async () => {
    const fake = fakeFrameClock();
    const playhead = new PlayheadStore(fake.clock);
    playhead.setTotal(8_000);
    const spec = draftSpec(4, { music: MUSIC });
    const view = render(
      <EngineProvider client={windowClient()}>
        <PreviewAudio spec={spec} playhead={playhead} />
      </EngineProvider>,
    );
    const element = view.container.querySelector("audio");
    if (element === null) throw new Error("no audio element");
    expect(element.getAttribute("src")).toBe("studio-media://track/track-espresso-01");
    const audio = recordAudio(element);
    playhead.seek(1_000);
    expect(audio.calls).toEqual([]);
    act(() => playhead.toggle());
    expect(audio.calls).toEqual(["seek 43", "play"]);
    // The element kept time with the clock: nothing to do.
    audio.at(43.5);
    act(() => fake.advance(500));
    expect(audio.calls).toEqual(["seek 43", "play"]);
    // Far behind (a slow start): moved to its place.
    act(() => fake.advance(500));
    expect(audio.calls.at(-1)).toBe("seek 44");
    act(() => playhead.toggle());
    expect(audio.calls.at(-1)).toBe("pause");
  });

  test("a slow start (too little data yet) is not moved again on every frame", async () => {
    const fake = fakeFrameClock();
    const playhead = new PlayheadStore(fake.clock);
    playhead.setTotal(8_000);
    const view = mount(playhead);
    const element = view.container.querySelector("audio");
    if (element === null) throw new Error("no audio element");
    const audio = recordAudio(element, { readyState: 1 });
    act(() => playhead.toggle());
    for (let i = 0; i < 10; i++) act(() => fake.advance(100));
    expect(audio.calls).toEqual(["seek 42", "play"]);
  });

  test("a file the element refuses to play is not tried again on every frame: no more seeks, no more plays", async () => {
    const fake = fakeFrameClock();
    const playhead = new PlayheadStore(fake.clock);
    playhead.setTotal(8_000);
    const view = mount(playhead);
    const element = view.container.querySelector("audio");
    if (element === null) throw new Error("no audio element");
    const audio = recordAudio(element, { refuse: true });
    act(() => playhead.toggle());
    await settle();
    for (let i = 0; i < 5; i++) act(() => fake.advance(100));
    expect(audio.calls).toEqual(["seek 42", "play"]);
  });

  test("the editor closing (the element going) stops the music", async () => {
    const fake = fakeFrameClock();
    const playhead = new PlayheadStore(fake.clock);
    playhead.setTotal(8_000);
    const view = mount(playhead);
    const element = view.container.querySelector("audio");
    if (element === null) throw new Error("no audio element");
    const audio = recordAudio(element);
    act(() => playhead.toggle());
    view.unmount();
    expect(audio.calls.at(-1)).toBe("pause");
  });

  test("no music, or the dev mock (which stores no audio): no element at all", () => {
    const playhead = new PlayheadStore(fakeFrameClock().clock);
    const none = render(
      <EngineProvider client={windowClient()}>
        <PreviewAudio spec={draftSpec(2)} playhead={playhead} />
      </EngineProvider>,
    );
    expect(none.container.querySelector("audio") === null).toBe(true);
    const mock = render(
      <EngineProvider client={mockEngineClient(new MockEngine({ scheduler: new ManualScheduler() }))}>
        <PreviewAudio spec={draftSpec(2, { music: MUSIC })} playhead={playhead} />
      </EngineProvider>,
    );
    expect(mock.container.querySelector("audio") === null).toBe(true);
  });
});
