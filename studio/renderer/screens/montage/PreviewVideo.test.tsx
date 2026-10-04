import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, render } from "@testing-library/react";
import type { MontageDraft } from "../../../shared/engine";
import { FRAME_H, FRAME_W, videoClipCrop } from "../../../shared/montage";
import type { EngineClient } from "../../engine/client";
import { MockEngine, mockEngineClient } from "../../engine/mockEngine";
import { EngineProvider } from "../../engine/react";
import { ManualScheduler } from "../../engine/scheduler";
import { fakeFrameClock } from "./clock.testkit";
import type { OwnVideo, VideoLookup } from "./ownVideos";
import { PlayheadStore } from "./playhead";
import { PreviewVideo } from "./PreviewVideo";
import { draftSpec, photoClip, videoClip } from "./testkit";

// 3f.3b: the own video clip's `<video>` in the preview. It plays the clip's mezzanine through main's media route by id, always muted, cropped as the render
// crops it; at rest it is paused on the exact stored frame of the playhead (and lands on the last one a scrub asked for), while the montage plays it plays in
// step with the clock; it never fights a seek, never retries a refused play, and stops when it goes. Where there is no picture (the dev mock, a deleted
// file, a file the element cannot open) a stand-in of the same place is drawn instead.

const MEDIA = "media-00000007";
const WIDE: OwnVideo = { mediaId: MEDIA, name: "street-walk.mp4", width: 1_080, height: 608, durationMs: 14_000, sourceFps: 29.97, hdrToSdr: false };
const KNOWN: VideoLookup = { state: "known", video: WIDE };
/** 2 s of a photo, then 2 s of the video from 1.8 s into it. */
const SPEC: MontageDraft = draftSpec([photoClip(0, "photo-mia-0001", 2_000), { ...videoClip(1, 2_000, 1_800), mediaId: MEDIA }]);
const CROP = videoClipCrop({ w: 1_080, h: 608 }, null);

/** The real client's addresses over the mock's answers (its media are main's routes). */
const windowClient = () => ({ ...mockEngineClient(new MockEngine({ scheduler: new ManualScheduler() })), kind: "window" as const });
const mockClient = () => mockEngineClient(new MockEngine({ scheduler: new ManualScheduler() }));

const mounted: (() => void)[] = [];
afterEach(() => {
  for (const unmount of mounted.splice(0)) unmount();
});

/** The `<video>` with its media calls recorded: the test DOM plays nothing. */
function recordVideo(element: HTMLVideoElement, options: { readyState?: number; refuse?: boolean; abortFirst?: boolean } = {}) {
  const calls: string[] = [];
  let aborts = options.abortFirst === true ? 1 : 0;
  element.load = () => void calls.push("load");
  let time = 0;
  let paused = true;
  let seeking = false;
  let rate = 1;
  Object.defineProperty(element, "currentTime", {
    get: () => time,
    set: (value: number) => {
      time = value;
      calls.push(`seek ${Math.round(value * 30 * 100) / 100}f`);
    },
  });
  Object.defineProperty(element, "paused", { get: () => paused });
  Object.defineProperty(element, "duration", { get: () => 14 });
  Object.defineProperty(element, "seeking", { get: () => seeking });
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
    // A pause that lands before the start does: the browser rejects that play() with AbortError.
    if (aborts > 0) {
      aborts -= 1;
      return Promise.reject(new DOMException("The play() request was interrupted by a call to pause().", "AbortError"));
    }
    return Promise.resolve();
  };
  element.pause = () => {
    if (!paused) calls.push("pause");
    paused = true;
  };
  return {
    calls,
    at: (seconds: number) => (time = seconds),
    /** A seek under way until `land` (the element fires `seeked` then). */
    hold: () => (seeking = true),
    land: () => {
      seeking = false;
      act(() => {
        element.dispatchEvent(new Event("seeked"));
      });
    },
  };
}

function mount(options: { client?: EngineClient; mediaId?: string; video?: VideoLookup; playhead?: PlayheadStore; window?: typeof CROP | null; spec?: MontageDraft; peekFrame?: number | null } = {}) {
  const playhead = options.playhead ?? new PlayheadStore(fakeFrameClock().clock);
  playhead.setTotal(4_000);
  const view = render(
    <EngineProvider client={options.client ?? windowClient()}>
      <PreviewVideo
        spec={options.spec ?? SPEC}
        playhead={playhead}
        mediaId={options.mediaId ?? MEDIA}
        video={options.video ?? KNOWN}
        window={options.window === undefined ? CROP : options.window}
        sourceFrame={54}
        peekFrame={options.peekFrame ?? null}
      />
    </EngineProvider>,
  );
  mounted.push(() => view.unmount());
  return { view, playhead, element: view.container.querySelector("video") };
}

function videoOf(element: HTMLVideoElement | null): HTMLVideoElement {
  if (element === null) throw new Error("no video element");
  return element;
}

describe("the element", () => {
  test("plays the clip's mezzanine by its media id through main's route, muted, without controls, placed where the render's crop puts it", () => {
    const element = videoOf(mount().element);
    expect(element.getAttribute("src")).toBe(`studio-media://media/${MEDIA}`);
    expect(element.muted).toBe(true);
    expect(element.defaultMuted).toBe(true);
    expect(element.hasAttribute("controls")).toBe(false);
    // The whole video, so that the frame (its parent) shows exactly the crop: 1080 / 342 of the frame wide, shifted by the crop's x.
    expect(Number.parseFloat(element.style.width)).toBeCloseTo((1_080 / CROP.w) * 100, 6);
    expect(Number.parseFloat(element.style.height)).toBeCloseTo((608 / CROP.h) * 100, 6);
    expect(Number.parseFloat(element.style.left)).toBeCloseTo((-CROP.x / CROP.w) * 100, 6);
    expect(FRAME_W / FRAME_H).toBeCloseTo(CROP.w / CROP.h, 2);
  });

  test("the dev mock has no picture: a stand-in at the same place, with the file's name, its stored size and the frame on screen; never a broken element", () => {
    const { view } = mount({ client: mockClient() });
    expect(view.container.querySelector("video") === null).toBe(true);
    const ground = view.container.querySelector<HTMLElement>(".pv-video-ground");
    expect(Number.parseFloat(ground?.style.width ?? "")).toBeCloseTo((1_080 / CROP.w) * 100, 6);
    expect(view.container.textContent).toContain("street-walk.mp4");
    expect(view.container.textContent).toContain("1080×608 · 0:01.8");
  });

  test("a video the library no longer holds says so; one not known yet is the bare ground; neither gets an element", () => {
    const gone = mount({ video: { state: "gone" }, window: null });
    expect(gone.view.container.querySelector("video") === null).toBe(true);
    expect(gone.view.container.textContent).toContain("Файла больше нет");
    expect(gone.view.container.textContent).toContain("Это видео удалили из «Моих» — уберите этот кадр.");
    const unknown = mount({ video: { state: "unknown" }, window: null });
    expect(unknown.view.container.querySelector("video") === null).toBe(true);
    expect(unknown.view.container.querySelector(".pv-video-ground") !== null).toBe(true);
    expect(unknown.view.container.textContent).toBe("");
  });

  test("a file the element cannot open is a stand-in that says so, not a broken element", () => {
    const { view, element } = mount();
    act(() => {
      videoOf(element).dispatchEvent(new Event("error"));
    });
    expect(view.container.querySelector("video") === null).toBe(true);
    expect(view.container.textContent).toContain("Видео не открылось");
  });

  test("an id that breaks the contract builds no address: no element (a draft corrupted on its way; the preview never makes a path of it)", () => {
    const { view } = mount({ mediaId: "../../etc/passwd" });
    expect(view.container.querySelector("video") === null).toBe(true);
  });
});

describe("at rest: the exact stored frame", () => {
  test("on the clip's frames the element is sought to the middle of the frame the render puts there, and left there", () => {
    const fake = fakeFrameClock();
    const playhead = new PlayheadStore(fake.clock);
    const { element } = mount({ playhead });
    const video = recordVideo(videoOf(element));
    act(() => playhead.seek(2_400));
    // The clip's frame 12 is the video's 54 + 12.
    expect(video.calls).toEqual(["seek 66.5f"]);
    act(() => playhead.seek(2_400));
    expect(video.calls).toEqual(["seek 66.5f"]);
  });

  test("a scrub never seeks over a seek under way, and lands on the last frame it asked for once that seek ends", () => {
    const playhead = new PlayheadStore(fakeFrameClock().clock);
    const { element } = mount({ playhead });
    const video = recordVideo(videoOf(element));
    act(() => playhead.seek(2_100));
    video.hold();
    act(() => playhead.seek(2_200));
    act(() => playhead.seek(2_300));
    expect(video.calls).toEqual(["seek 57.5f"]);
    video.land();
    expect(video.calls).toEqual(["seek 57.5f", "seek 63.5f"]);
  });

  test("a new trim shows its frame at once, the playhead unmoved", () => {
    const playhead = new PlayheadStore(fakeFrameClock().clock);
    const { view, element } = mount({ playhead });
    const video = recordVideo(videoOf(element));
    act(() => playhead.seek(2_000));
    const trimmed: MontageDraft = { ...SPEC, clips: [SPEC.clips[0] ?? photoClip(0, "photo-mia-0001"), { ...videoClip(1, 2_000, 3_000), mediaId: MEDIA }] };
    view.rerender(
      <EngineProvider client={windowClient()}>
        <PreviewVideo spec={trimmed} playhead={playhead} mediaId={MEDIA} video={KNOWN} window={CROP} sourceFrame={90} peekFrame={null} />
      </EngineProvider>,
    );
    expect(video.calls).toEqual(["seek 54.5f", "seek 90.5f"]);
  });

  test("off the video's clip (a photo on screen) it waits, paused", () => {
    const fake = fakeFrameClock();
    const playhead = new PlayheadStore(fake.clock);
    const { element } = mount({ playhead });
    const video = recordVideo(videoOf(element));
    act(() => playhead.seek(1_000));
    expect(video.calls).toEqual([]);
  });
});

describe("playing", () => {
  test("starts at the clip's place in the video and plays; kept in step; paused with the playhead", () => {
    const fake = fakeFrameClock();
    const playhead = new PlayheadStore(fake.clock);
    const { element } = mount({ playhead });
    const video = recordVideo(videoOf(element));
    act(() => playhead.seek(2_000));
    act(() => playhead.toggle());
    expect(video.calls).toEqual(["seek 54.5f", "seek 54f", "play"]);
    // In step with the clock: nothing to do.
    video.at(1.8 + 0.5);
    act(() => fake.advance(500));
    expect(video.calls).toHaveLength(3);
    // Far behind: moved.
    act(() => fake.advance(500));
    expect(video.calls.at(-1)).toBe("seek 84f");
    // Stopped on 3.0 s: the clip's frame 30, the video's 84, which it already shows.
    act(() => playhead.toggle());
    expect(video.calls.slice(-2)).toEqual(["seek 84f", "pause"]);
  });

  test("a file the element refuses to play is not tried again on every frame", async () => {
    const fake = fakeFrameClock();
    const playhead = new PlayheadStore(fake.clock);
    const { element } = mount({ playhead });
    const video = recordVideo(videoOf(element), { refuse: true });
    act(() => playhead.seek(2_000));
    act(() => playhead.toggle());
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    for (let i = 0; i < 5; i++) act(() => fake.advance(100));
    expect(video.calls).toEqual(["seek 54.5f", "seek 54f", "play"]);
  });

  test("the preview closing (the element going) stops it and lets its decoder go (fix round 1, L2: no source, loaded again)", () => {
    const fake = fakeFrameClock();
    const playhead = new PlayheadStore(fake.clock);
    const { view, element } = mount({ playhead });
    const video = recordVideo(videoOf(element));
    act(() => playhead.seek(2_000));
    act(() => playhead.toggle());
    view.unmount();
    expect(video.calls.slice(-2)).toEqual(["pause", "load"]);
    expect(videoOf(element).hasAttribute("src")).toBe(false);
  });

  test("a play() the clock's own pause interrupts (AbortError) is no refusal: the next play is tried, and at rest it still seeks (fix round 1, L5)", async () => {
    const fake = fakeFrameClock();
    const playhead = new PlayheadStore(fake.clock);
    const { element } = mount({ playhead });
    const video = recordVideo(videoOf(element), { abortFirst: true });
    act(() => playhead.seek(2_000));
    act(() => playhead.toggle());
    act(() => playhead.toggle());
    await act(async () => {
      for (let i = 0; i < 5; i++) await Promise.resolve();
    });
    act(() => playhead.seek(2_400));
    expect(video.calls.at(-1)).toBe("seek 66.5f");
    act(() => playhead.toggle());
    expect(video.calls.at(-1)).toBe("play");
  });

  test("a cut to a part that starts 0.2 s later in the video is a jump: the element is moved there at the cut (fix round 1, M2)", () => {
    const fake = fakeFrameClock();
    const playhead = new PlayheadStore(fake.clock);
    // Two parts of the video: 0–2 s, then from 2.2 s.
    const split: MontageDraft = draftSpec([{ ...videoClip(0, 2_000, 0), mediaId: MEDIA }, { ...videoClip(1, 2_000, 2_200), mediaId: MEDIA }]);
    const { element } = mount({ playhead, spec: split });
    const video = recordVideo(videoOf(element));
    act(() => playhead.seek(1_500));
    act(() => playhead.toggle());
    // In step through A…
    video.at(1.5 + 0.4);
    act(() => fake.advance(400));
    const before = video.calls.length;
    // …and at B's first frame the element is still at A's 2.0 s: moved to 2.2 s, not nudged.
    video.at(2.0);
    act(() => fake.advance(100));
    expect(video.calls.slice(before)).toEqual(["seek 66f"]);
  });

  test("a seek that took long while playing leads the next one by as much, so a slow decoder lands where the clock is (fix round 1, the open question)", () => {
    let now = 1_000;
    const clock = spyOn(performance, "now").mockImplementation(() => now);
    try {
      const fake = fakeFrameClock();
      const playhead = new PlayheadStore(fake.clock);
      const split: MontageDraft = draftSpec([{ ...videoClip(0, 2_000, 0), mediaId: MEDIA }, { ...videoClip(1, 2_000, 2_200), mediaId: MEDIA }]);
      const { element } = mount({ playhead, spec: split });
      const target = videoOf(element);
      const video = recordVideo(target);
      act(() => playhead.seek(1_500));
      act(() => playhead.toggle());
      // The start's seek, while playing, takes 340 ms.
      video.hold();
      act(() => {
        target.dispatchEvent(new Event("seeking"));
      });
      now += 340;
      video.land();
      // At B's first frame the jump is sought 340 ms ahead of 2.2 s.
      video.at(2.0);
      act(() => fake.advance(500));
      expect(video.calls.at(-1)).toBe("seek 76.2f");
    } finally {
      clock.mockRestore();
    }
  });

  test("the start of a slide or an edge being dragged in «Обрезка» is shown at once, whatever the playhead; let go, the playhead's frame is back (fix round 1, L8)", () => {
    const playhead = new PlayheadStore(fakeFrameClock().clock);
    const { view, element } = mount({ playhead });
    const video = recordVideo(videoOf(element));
    act(() => playhead.seek(2_000));
    const peek = (frame: number | null): void =>
      view.rerender(
        <EngineProvider client={windowClient()}>
          <PreviewVideo spec={SPEC} playhead={playhead} mediaId={MEDIA} video={KNOWN} window={CROP} sourceFrame={54} peekFrame={frame} />
        </EngineProvider>,
      );
    peek(160);
    expect(video.calls.at(-1)).toBe("seek 160.5f");
    peek(null);
    expect(video.calls.at(-1)).toBe("seek 54.5f");
  });

  test("an element that failed before its listener could hear it (a fast 404) is a stand-in, not a blank frame (fix round 1, L1)", () => {
    const failed = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, "error");
    Object.defineProperty(HTMLMediaElement.prototype, "error", { configurable: true, get: () => ({ code: 4, message: "not found" }) });
    try {
      const { view } = mount();
      expect(view.container.querySelector("video") === null).toBe(true);
      expect(view.container.textContent).toContain("Видео не открылось");
    } finally {
      if (failed === undefined) Reflect.deleteProperty(HTMLMediaElement.prototype, "error");
      else Object.defineProperty(HTMLMediaElement.prototype, "error", failed);
    }
  });
});
