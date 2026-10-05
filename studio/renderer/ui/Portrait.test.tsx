import { afterEach, expect, test } from "bun:test";
import { act, fireEvent, render, screen } from "@testing-library/react";
import type { EngineClient } from "../engine/client";
import { MockEngine, mockEngineClient } from "../engine/mockEngine";
import { EngineProvider } from "../engine/react";
import { ManualScheduler } from "../engine/scheduler";
import { Portrait } from "./Portrait";
import { MEDIA_RETRY_DELAY_MS } from "./useMediaRetry";

// The large-screen audit (H2): a library picture is never drawn noticeably past its own pixels (lib/imageFit.ts). Once a portrait has
// loaded, its frame is measured against the picture's cap for the screen's pixel ratio. A picture that cannot fill its frame within
// that cap is drawn at the cap, centred over a blurred copy of itself, so the frame keeps its shape; one that can (or nearly can:
// a few pixels short) is drawn as before, filling the frame.

const AVATAR = "avatar-mia-0001";
const PHOTO = "photo-mia-master";
const LABEL = "Мастер-портрет: Mia";

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

/** The screen's pixel ratio for this test; `set` moves it (the window went to another screen). */
function pixelRatio(value: number): { set: (next: number) => void } {
  let ratio = value;
  const own = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => ratio });
  restores.push(() => {
    if (own !== undefined) Object.defineProperty(window, "devicePixelRatio", own);
    else Reflect.deleteProperty(window, "devicePixelRatio");
  });
  return {
    set: (next) => {
      ratio = next;
    },
  };
}

type Size = { width: number; height: number };

/**
 * Lays every portrait frame out at `size` (the test DOM lays nothing out): `clientWidth` / `clientHeight` of a `.portrait`, read
 * when the picture loads, and a stand-in ResizeObserver. The real observer reports after layout, asynchronously; with `async` the
 * stand-in reports only on `deliver()`, otherwise at once on `observe`. `resize` lays the frames out anew and reports it.
 */
function layOut(initial: Size, { async = false }: { async?: boolean } = {}) {
  const state = { size: initial, made: 0 };
  const live = new Set<{ report: ResizeObserverCallback; targets: Set<Element>; self: ResizeObserver }>();
  const entry = (target: Element) => ({ target, contentRect: { width: state.size.width, height: state.size.height } }) as unknown as ResizeObserverEntry;
  const realObserver = globalThis.ResizeObserver;
  class Laid {
    readonly #own: { report: ResizeObserverCallback; targets: Set<Element>; self: ResizeObserver };
    constructor(report: ResizeObserverCallback) {
      state.made += 1;
      this.#own = { report, targets: new Set(), self: this as unknown as ResizeObserver };
      live.add(this.#own);
    }
    observe(target: Element): void {
      this.#own.targets.add(target);
      if (!async) this.#own.report([entry(target)], this.#own.self);
    }
    unobserve(target: Element): void {
      this.#own.targets.delete(target);
    }
    disconnect(): void {
      this.#own.targets.clear();
      live.delete(this.#own);
    }
  }
  globalThis.ResizeObserver = Laid as unknown as typeof ResizeObserver;
  const sized = (side: "clientWidth" | "clientHeight") => {
    const own = Object.getOwnPropertyDescriptor(HTMLElement.prototype, side);
    Object.defineProperty(HTMLElement.prototype, side, {
      configurable: true,
      get(this: HTMLElement) {
        if (this.classList.contains("portrait")) return side === "clientWidth" ? state.size.width : state.size.height;
        return own?.get?.call(this) ?? 0;
      },
    });
    restores.push(() => {
      if (own !== undefined) Object.defineProperty(HTMLElement.prototype, side, own);
    });
  };
  sized("clientWidth");
  sized("clientHeight");
  restores.push(() => {
    globalThis.ResizeObserver = realObserver;
  });
  const deliver = () =>
    act(() => {
      for (const own of live) if (own.targets.size > 0) own.report([...own.targets].map(entry), own.self);
    });
  return {
    resize(size: Size): void {
      state.size = size;
      deliver();
    },
    deliver,
    /** How many observers were ever made, and how many still watch something. */
    made: () => state.made,
    watching: () => [...live].reduce((n, own) => n + own.targets.size, 0),
  };
}

/** The real client's kind over the mock: the portrait then asks for its picture instead of drawing a placeholder. */
function asWindow(client: EngineClient): EngineClient {
  return { ...client, kind: "window" };
}

/** Portraits of `photoIds`, each labelled with its id; `show` swaps the set, as a list that changes would. */
function renderPortraits(photoIds: readonly string[]): { show: (next: readonly string[]) => void; unmount: () => void } {
  const engine = new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0 });
  const client = asWindow(mockEngineClient(engine));
  const tree = (ids: readonly string[]) => (
    <EngineProvider client={client}>
      {ids.map((id) => (
        <Portrait key={id} avatarId={AVATAR} photoId={id} label={`Фото ${id}`} />
      ))}
    </EngineProvider>
  );
  const { rerender, unmount } = render(tree(photoIds));
  return { show: (next) => rerender(tree(next)), unmount };
}

/** Waits out the pause before a failed picture is asked for again. */
const retryPause = (): Promise<void> => act(() => new Promise<void>((resolve) => setTimeout(resolve, MEDIA_RETRY_DELAY_MS + 60)));

/** One portrait whose photo id can change in place (a draft card's last candidate). */
function renderPortrait(photoId: string = PHOTO): { show: (next: string) => void; unmount: () => void } {
  const engine = new MockEngine({ scheduler: new ManualScheduler(), latencyMs: 0 });
  const client = asWindow(mockEngineClient(engine));
  const tree = (id: string) => (
    <EngineProvider client={client}>
      <Portrait avatarId={AVATAR} photoId={id} label={LABEL} />
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

function picture(label: string = LABEL): HTMLImageElement {
  const img = screen.getByRole("img", { name: label });
  if (!(img instanceof HTMLImageElement)) throw new Error(`«${label}» is not an <img>`);
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
// Booleans and strings, never the node: a failing matcher on a DOM node prints its whole graph and hangs the shard (testing/domMatchers.ts).
const hasBackdrop = (img: HTMLImageElement): boolean => backdrop(img) !== null;
const fit = (img: HTMLImageElement): string | null => frame(img).getAttribute("data-fit");
const capped = (img: HTMLImageElement): [string, string] => [img.style.maxWidth, img.style.maxHeight];

test("nothing is measured or capped before the picture has loaded", () => {
  pixelRatio(2);
  const layout = layOut({ width: 212, height: 224 });
  renderPortrait();
  const img = picture();
  expect(capped(img)).toEqual(["", ""]);
  expect(fit(img)).toBeNull();
  expect(hasBackdrop(img)).toBe(false);
  expect(layout.watching()).toBe(0);
});

test("a small picture on a 2× screen is held to its cap, centred over a blurred copy of itself", () => {
  pixelRatio(2);
  layOut({ width: 212, height: 224 });
  renderPortrait();
  const img = picture();
  load(img, 246, 281);

  expect(capped(img)).toEqual(["153.75px", "175.625px"]);
  expect(fit(img)).toBe("capped");
  const copy = backdrop(img);
  if (!(copy instanceof HTMLImageElement)) throw new Error("no backdrop picture");
  expect(copy.getAttribute("src")).toBe(img.getAttribute("src"));
  // Decoration only: the portrait is still one picture with one name.
  expect(copy.getAttribute("alt")).toBe("");
  expect(copy.getAttribute("aria-hidden")).toBe("true");
  expect(screen.getAllByRole("img")).toHaveLength(1);
});

test("the band is decided as the picture loads, before the frame's observer has reported anything", () => {
  pixelRatio(2);
  const layout = layOut({ width: 212, height: 224 }, { async: true });
  renderPortrait();
  const img = picture();
  load(img, 246, 281);

  // No report yet: the frame was measured on the spot, so the first frame drawn is already the print over its backdrop.
  expect(fit(img)).toBe("capped");
  expect(hasBackdrop(img)).toBe(true);
  layout.deliver();
  expect(fit(img)).toBe("capped");
});

test("a picture large enough for its frame fills it as before: no cap on its box, no band, no backdrop", () => {
  pixelRatio(2);
  layOut({ width: 212, height: 224 });
  renderPortrait();
  const img = picture();
  load(img, 864, 1152);

  expect(capped(img)).toEqual(["", ""]);
  expect(fit(img)).toBeNull();
  expect(hasBackdrop(img)).toBe(false);
});

test("the same small picture on a 1× screen still fills the same frame", () => {
  pixelRatio(1);
  layOut({ width: 212, height: 224 });
  renderPortrait();
  const img = picture();
  load(img, 246, 281);

  expect(capped(img)).toEqual(["", ""]);
  expect(fit(img)).toBeNull();
  expect(hasBackdrop(img)).toBe(false);
});

test("a picture a few pixels short of its frame fills it: a thin band would read as a sizing bug, not as a print", () => {
  // A Windows screen at 150 %: the 246 × 281 master's cap is 205 × 234, 7 px narrower than the card's photo.
  pixelRatio(1.5);
  layOut({ width: 212, height: 224 });
  renderPortrait();
  const img = picture();
  load(img, 246, 281);

  expect(capped(img)).toEqual(["", ""]);
  expect(fit(img)).toBeNull();
  expect(hasBackdrop(img)).toBe(false);
});

test("a picture short on one side only is held on that side and still gets the band", () => {
  pixelRatio(2);
  layOut({ width: 212, height: 224 });
  renderPortrait();
  const img = picture();
  // A wide, low picture: its cap (250 × 93.75) is wider than the frame but far from its height.
  load(img, 400, 150);

  expect(capped(img)).toEqual(["250px", "93.75px"]);
  expect(fit(img)).toBe("capped");
  expect(hasBackdrop(img)).toBe(true);
});

test("a window moved to a screen of another pixel ratio re-caps the picture", () => {
  const ratio = pixelRatio(1);
  const media = mediaQueries();
  layOut({ width: 212, height: 224 });
  renderPortrait();
  const img = picture();
  load(img, 246, 281);
  expect(fit(img)).toBeNull();

  ratio.set(2);
  expect(media.listening()).toEqual(["(resolution: 1dppx)"]);
  media.fire();

  expect(capped(img)).toEqual(["153.75px", "175.625px"]);
  expect(fit(img)).toBe("capped");
  expect(media.listening()).toEqual(["(resolution: 2dppx)"]);
});

test("the pixel ratio is followed only while a loaded picture depends on it: not before, and not after the last portrait goes", () => {
  pixelRatio(2);
  const media = mediaQueries();
  layOut({ width: 212, height: 224 });
  const view = renderPortrait();
  // Nothing drawn yet (or a placeholder, or a picture that never loads): no query of its own, beside the editor preview's.
  expect(media.listening()).toEqual([]);

  load(picture(), 246, 281);
  expect(media.listening()).toEqual(["(resolution: 2dppx)"]);

  view.unmount();
  expect(media.listening()).toEqual([]);
});

test("portraits share one pixel-ratio query, which outlives any one of them", () => {
  const ratio = pixelRatio(1);
  const media = mediaQueries();
  layOut({ width: 212, height: 224 });
  const view = renderPortraits(["photo-mia-one", "photo-mia-two"]);
  load(picture("Фото photo-mia-one"), 246, 281);
  load(picture("Фото photo-mia-two"), 246, 281);
  expect(media.listening()).toEqual(["(resolution: 1dppx)"]);

  view.show(["photo-mia-two"]);
  expect(media.listening()).toEqual(["(resolution: 1dppx)"]);

  ratio.set(2);
  media.fire();
  const left = picture("Фото photo-mia-two");
  expect(capped(left)).toEqual(["153.75px", "175.625px"]);
  expect(fit(left)).toBe("capped");
});

test("one observer watches every loaded portrait's frame, and lets go of each as it leaves", () => {
  pixelRatio(2);
  const layout = layOut({ width: 212, height: 224 });
  const view = renderPortraits(["photo-mia-one", "photo-mia-two", "photo-mia-three"]);
  for (const id of ["photo-mia-one", "photo-mia-two", "photo-mia-three"]) load(picture(`Фото ${id}`), 864, 1152);

  expect(layout.made()).toBe(1);
  expect(layout.watching()).toBe(3);

  view.show(["photo-mia-two"]);
  expect(layout.watching()).toBe(1);
  view.unmount();
  expect(layout.watching()).toBe(0);
});

test("the band follows the frame, and the backdrop stays the same element through it (hidden, not remade, while filled)", () => {
  pixelRatio(2);
  const layout = layOut({ width: 120, height: 130 });
  renderPortrait();
  const img = picture();
  load(img, 246, 281);
  expect(fit(img)).toBeNull();
  expect(hasBackdrop(img)).toBe(false);

  layout.resize({ width: 212, height: 224 });
  expect(fit(img)).toBe("capped");
  expect(capped(img)).toEqual(["153.75px", "175.625px"]);
  const kept = backdrop(img);
  expect(kept === null).toBe(false);

  layout.resize({ width: 150, height: 170 });
  expect(fit(img)).toBeNull();
  expect(capped(img)).toEqual(["", ""]);
  expect(backdrop(img) === kept).toBe(true);

  layout.resize({ width: 212, height: 224 });
  expect(fit(img)).toBe("capped");
  expect(backdrop(img) === kept).toBe(true);
});

test("another photo in the same place is a new picture: it waits for its own size, never borrows the last one's band", () => {
  pixelRatio(2);
  layOut({ width: 212, height: 224 });
  const view = renderPortrait();
  const first = picture();
  load(first, 246, 281);
  expect(fit(first)).toBe("capped");

  view.show("photo-mia-second");
  const second = picture();
  // A fresh element: the old picture is never left on screen, uncapped, while the new one loads.
  expect(second === first).toBe(false);
  expect(second.getAttribute("src")).toContain("photo-mia-second");
  expect(capped(second)).toEqual(["", ""]);
  expect(fit(second)).toBeNull();
  expect(hasBackdrop(second)).toBe(false);

  load(second, 864, 1152);
  expect(capped(second)).toEqual(["", ""]);
  expect(fit(second)).toBeNull();
});

test("a picture that will not load falls back to the placeholder, with no backdrop left behind", async () => {
  pixelRatio(2);
  layOut({ width: 212, height: 224 });
  renderPortrait();
  const img = picture();
  load(img, 246, 281);
  expect(hasBackdrop(img)).toBe(true);

  // One failure is a second try after a pause (a busy or slow disk answers 503/504); only the second is the placeholder (useMediaRetry.ts).
  fireEvent.error(img);
  expect(picture().tagName).toBe("IMG");
  await retryPause();
  fireEvent.error(picture());

  const stand = screen.getByRole("img", { name: LABEL });
  expect(stand.tagName).toBe("SPAN");
  expect(stand.classList.contains("portrait-placeholder")).toBe(true);
  expect(document.querySelector(".portrait-backdrop") === null).toBe(true);
  expect(document.querySelector("img") === null).toBe(true);
});

test("a photo that would not load does not hold back the next one in the same place", async () => {
  pixelRatio(2);
  layOut({ width: 212, height: 224 });
  const view = renderPortrait();
  fireEvent.error(picture());
  await retryPause();
  fireEvent.error(picture());
  expect(screen.getByRole("img", { name: LABEL }).tagName).toBe("SPAN");

  view.show("photo-mia-second");
  const next = picture();
  expect(next.getAttribute("src")).toContain("photo-mia-second");
});
