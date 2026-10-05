import { afterEach, expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { EngineClient } from "../engine/client";
import { MockEngine, mockEngineClient } from "../engine/mockEngine";
import { EngineProvider } from "../engine/react";
import { ManualScheduler } from "../engine/scheduler";
import { Portrait } from "./Portrait";

// The large-screen audit (H2): a library picture is never drawn noticeably past its own pixels (lib/imageFit.ts). Once a portrait has
// loaded, it is held to its cap for the screen's pixel ratio. A picture that cannot fill its frame within that cap is drawn at the cap,
// centred over a blurred copy of itself, so the frame keeps its shape; one that can is drawn as before, filling the frame.

const AVATAR = "avatar-mia-0001";
const PHOTO = "photo-mia-master";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

/** The screen's pixel ratio for this test. */
function pixelRatio(value: number): void {
  const own = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => value });
  restores.push(() => {
    if (own !== undefined) Object.defineProperty(window, "devicePixelRatio", own);
    else Reflect.deleteProperty(window, "devicePixelRatio");
  });
}

/** Lays the portrait's frame out at `size` (the test DOM lays nothing out); `resize` reports a new size, as a window resize does. */
function frameOf(initial: { width: number; height: number }): { resize: (size: { width: number; height: number }) => void } {
  const real = globalThis.ResizeObserver;
  const state = { size: initial };
  const live = new Set<{ report: ResizeObserverCallback; targets: Element[]; self: ResizeObserver }>();
  const entry = (target: Element) => ({ target, contentRect: { width: state.size.width, height: state.size.height } }) as unknown as ResizeObserverEntry;
  class Laid {
    readonly #own: { report: ResizeObserverCallback; targets: Element[]; self: ResizeObserver };
    constructor(report: ResizeObserverCallback) {
      this.#own = { report, targets: [], self: this as unknown as ResizeObserver };
      live.add(this.#own);
    }
    observe(target: Element): void {
      this.#own.targets.push(target);
      this.#own.report([entry(target)], this.#own.self);
    }
    unobserve(): void {}
    disconnect(): void {
      live.delete(this.#own);
    }
  }
  globalThis.ResizeObserver = Laid as unknown as typeof ResizeObserver;
  restores.push(() => {
    globalThis.ResizeObserver = real;
  });
  return {
    resize(size) {
      state.size = size;
      act(() => {
        for (const own of live) own.report(own.targets.map(entry), own.self);
      });
    },
  };
}

/** The real client's kind over the mock: the portrait then asks for its picture instead of drawing a placeholder. */
function asWindow(client: EngineClient): EngineClient {
  return { ...client, kind: "window" };
}

function renderPortrait(photoId: string = PHOTO): { show: (next: string) => void; unmount: () => void } {
  const engine = new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0 });
  const client = asWindow(mockEngineClient(engine));
  const tree = (id: string) => (
    <EngineProvider client={client}>
      <Portrait avatarId={AVATAR} photoId={id} label="Мастер-портрет: Mia" />
    </EngineProvider>
  );
  const { rerender, unmount } = render(tree(photoId));
  return { show: (next) => rerender(tree(next)), unmount };
}

/** A stand-in `matchMedia` whose queries are told when their ratio stops matching; `listening` lists the queries still heard. */
function mediaQueries(): { listening: () => string[]; fire: () => void } {
  const realMatch = window.matchMedia;
  const queries: { media: string; change: (() => void) | null }[] = [];
  window.matchMedia = ((media: string) => {
    const query = { media, change: null as (() => void) | null };
    queries.push(query);
    return {
      media,
      matches: true,
      addEventListener: (_: string, listener: () => void) => {
        query.change = listener;
      },
      removeEventListener: () => {
        query.change = null;
      },
    } as unknown as MediaQueryList;
  }) as typeof window.matchMedia;
  restores.push(() => {
    window.matchMedia = realMatch;
  });
  const heard = () => queries.filter((q) => q.change !== null);
  return {
    listening: () => heard().map((q) => q.media),
    fire: () => act(() => heard()[0]?.change?.()),
  };
}

function picture(): HTMLImageElement {
  const img = screen.getByRole("img", { name: "Мастер-портрет: Mia" });
  if (!(img instanceof HTMLImageElement)) throw new Error("the portrait is not an <img>");
  return img;
}

/** The picture finishes loading with its own pixel size. */
function load(img: HTMLImageElement, width: number, height: number): void {
  Object.defineProperty(img, "naturalWidth", { configurable: true, value: width });
  Object.defineProperty(img, "naturalHeight", { configurable: true, value: height });
  fireEvent.load(img);
}

const frame = (img: HTMLImageElement): Element => {
  const span = img.closest(".portrait");
  if (span === null) throw new Error("no portrait frame");
  return span;
};
const backdrop = (img: HTMLImageElement): Element | null => frame(img).querySelector(".portrait-backdrop");

test("nothing is capped before the picture has loaded", () => {
  pixelRatio(2);
  frameOf({ width: 212, height: 224 });
  renderPortrait();
  const img = picture();
  expect(img.style.maxWidth).toBe("");
  expect(img.style.maxHeight).toBe("");
  expect(frame(img).getAttribute("data-fit")).toBeNull();
  expect(backdrop(img)).toBeNull();
});

test("a small picture on a 2× screen is held to its cap, centred over a blurred copy of itself", () => {
  pixelRatio(2);
  frameOf({ width: 212, height: 224 });
  renderPortrait();
  const img = picture();
  load(img, 246, 281);

  expect(img.style.maxWidth).toBe("153.75px");
  expect(img.style.maxHeight).toBe("175.625px");
  expect(frame(img).getAttribute("data-fit")).toBe("capped");
  const copy = backdrop(img);
  if (!(copy instanceof HTMLImageElement)) throw new Error("no backdrop picture");
  expect(copy.getAttribute("src")).toBe(img.getAttribute("src"));
  // Decoration only: the portrait is still one picture with one name.
  expect(copy.getAttribute("alt")).toBe("");
  expect(copy.getAttribute("aria-hidden")).toBe("true");
  expect(screen.getAllByRole("img")).toHaveLength(1);
});

test("a picture large enough for its frame fills it as before: capped far past the frame, no band, no backdrop", () => {
  pixelRatio(2);
  frameOf({ width: 212, height: 224 });
  renderPortrait();
  const img = picture();
  load(img, 864, 1152);

  expect(img.style.maxWidth).toBe("540px");
  expect(img.style.maxHeight).toBe("720px");
  expect(frame(img).getAttribute("data-fit")).toBeNull();
  expect(backdrop(img)).toBeNull();
});

test("the same small picture on a 1× screen still fills the same frame", () => {
  pixelRatio(1);
  frameOf({ width: 212, height: 224 });
  renderPortrait();
  const img = picture();
  load(img, 246, 281);

  expect(img.style.maxWidth).toBe("307.5px");
  expect(frame(img).getAttribute("data-fit")).toBeNull();
  expect(backdrop(img)).toBeNull();
});

test("a window moved to a screen of another pixel ratio re-caps the picture", () => {
  let ratio = 1;
  const own = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => ratio });
  restores.push(() => {
    if (own !== undefined) Object.defineProperty(window, "devicePixelRatio", own);
    else Reflect.deleteProperty(window, "devicePixelRatio");
  });
  const media = mediaQueries();
  frameOf({ width: 212, height: 224 });
  renderPortrait();
  const img = picture();
  load(img, 246, 281);
  expect(img.style.maxWidth).toBe("307.5px");
  expect(frame(img).getAttribute("data-fit")).toBeNull();

  ratio = 2;
  expect(media.listening()).toEqual(["(resolution: 1dppx)"]);
  media.fire();

  expect(img.style.maxWidth).toBe("153.75px");
  expect(frame(img).getAttribute("data-fit")).toBe("capped");
  expect(media.listening()).toEqual(["(resolution: 2dppx)"]);
});

test("a picture short on one side only is held on that side and still gets the band", () => {
  pixelRatio(2);
  frameOf({ width: 212, height: 224 });
  renderPortrait();
  const img = picture();
  // A wide, low picture: its cap (250 × 93.75) is wider than the frame but far from its height.
  load(img, 400, 150);

  expect(img.style.maxWidth).toBe("250px");
  expect(img.style.maxHeight).toBe("93.75px");
  expect(frame(img).getAttribute("data-fit")).toBe("capped");
  expect(backdrop(img)).not.toBeNull();
});

test("the pixel-ratio query is dropped once no portrait is left on screen", () => {
  pixelRatio(2);
  const media = mediaQueries();
  frameOf({ width: 212, height: 224 });
  const view = renderPortrait();
  expect(media.listening()).toEqual(["(resolution: 2dppx)"]);

  view.unmount();
  expect(media.listening()).toEqual([]);
});

test("another photo in the same place is a new picture: it waits for its own size, never borrows the last one's cap", () => {
  pixelRatio(2);
  frameOf({ width: 212, height: 224 });
  const view = renderPortrait();
  const first = picture();
  load(first, 246, 281);
  expect(frame(first).getAttribute("data-fit")).toBe("capped");

  view.show("photo-mia-second");
  const second = picture();
  // A fresh element: the old picture is never left on screen, uncapped, while the new one loads.
  expect(second).not.toBe(first);
  expect(second.getAttribute("src")).toContain("photo-mia-second");
  expect(second.style.maxWidth).toBe("");
  expect(frame(second).getAttribute("data-fit")).toBeNull();
  expect(backdrop(second)).toBeNull();

  load(second, 864, 1152);
  expect(second.style.maxWidth).toBe("540px");
  expect(frame(second).getAttribute("data-fit")).toBeNull();
});

test("a picture that will not load falls back to the placeholder, with no backdrop left behind", () => {
  pixelRatio(2);
  frameOf({ width: 212, height: 224 });
  renderPortrait();
  const img = picture();
  load(img, 246, 281);
  expect(backdrop(img)).not.toBeNull();

  fireEvent.error(img);

  const stand = screen.getByRole("img", { name: "Мастер-портрет: Mia" });
  expect(stand.tagName).toBe("SPAN");
  expect(stand.classList.contains("portrait-placeholder")).toBe(true);
  expect(document.querySelector(".portrait-backdrop")).toBeNull();
  expect(document.querySelector("img")).toBeNull();
});

test("the band follows the frame: a frame that grows past the cap gets it, one that shrinks back loses it", () => {
  pixelRatio(2);
  const layout = frameOf({ width: 120, height: 130 });
  renderPortrait();
  const img = picture();
  load(img, 246, 281);
  expect(frame(img).getAttribute("data-fit")).toBeNull();

  layout.resize({ width: 212, height: 224 });
  expect(frame(img).getAttribute("data-fit")).toBe("capped");
  expect(backdrop(img)).not.toBeNull();

  layout.resize({ width: 150, height: 170 });
  expect(frame(img).getAttribute("data-fit")).toBeNull();
  expect(backdrop(img)).toBeNull();
});
