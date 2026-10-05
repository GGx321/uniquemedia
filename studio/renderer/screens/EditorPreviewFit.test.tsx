import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import type { MontageDraft } from "../../shared/engine";
import { FRAME_H, FRAME_W, type Rect, stickerBox } from "../../shared/montage";
import type { MockEngine } from "../engine/mockEngine";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import { callsOf, flush } from "../testing";
import { AUTOSAVE_DEBOUNCE_MS } from "./montage/autosave";
import { dragLayerCentre } from "./montage/previewDrag";
import * as previewFrameModule from "./montage/previewFrame";
import { asAnotherWindow, makeDraft, MIA, openDrafts, studio } from "./montage/screenKit";
import { photoClip, stickerLayer } from "./montage/testkit";

// The owner's feedback (2026-10-05): in a maximised window the preview stayed a small fixed rectangle. It now fits the stage (the preview area),
// live as the window resizes: 9:16 exactly, never overflowing, clear of «Подсказки», never more physical pixels than the render has (the
// large-screen audit: 540 × 960 CSS px on a 2× screen), and refitted when the window moves to a screen of another pixel ratio. The overlays
// scale with it, and a layer stored in montage coordinates lands on the same spot at any size: a drag of the pointer moves it by the same
// montage distance the frame's own scale says.

const [P1, P2] = [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? ""];
const preview = (): HTMLElement => screen.getByRole("region", { name: "Превью" });
const frame = (): HTMLElement => {
  const node = preview().querySelector(".ed-frame");
  if (!(node instanceof HTMLElement)) throw new Error("no frame");
  return node;
};
const drawn = (): [string, string] => [frame().style.width, frame().style.height];

const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0).reverse()) restore();
});

async function openDraft(engine: MockEngine, client: Parameters<typeof makeDraft>[0], patch: Partial<MontageDraft> = {}): Promise<void> {
  const made = await makeDraft(client, MIA.avatarId, []);
  const spec: MontageDraft = { ...made.spec, clips: [P1, P2].map((photoId, i) => photoClip(i, photoId, 2_000)), ...patch };
  const saved = await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec, name: null }));
  if (!saved.ok) throw new Error(`montages.save: ${saved.error.code}`);
  await openDrafts();
  await screen.findByRole("heading", { level: 3, name: /Mia/ });
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();
  for (let i = engine.calls.length - 1; i >= 0; i--) if (engine.calls[i]?.type === "montages.save") engine.calls.splice(i, 1);
}

/** The screen's pixel ratio for this test. */
function pixelRatio(value: number): void {
  const own = Object.getOwnPropertyDescriptor(window, "devicePixelRatio");
  Object.defineProperty(window, "devicePixelRatio", { configurable: true, get: () => value });
  restores.push(() => {
    if (own !== undefined) Object.defineProperty(window, "devicePixelRatio", own);
    else Reflect.deleteProperty(window, "devicePixelRatio");
  });
}

/**
 * The editor laid out with the preview area's content box `stage` (the test DOM lays nothing out): a stand-in ResizeObserver reports it for the
 * preview area and a wide, unremarkable box for anything else observed. `relayout` reports the boxes again, as a window resize does.
 */
function layOut(initial: { w: number; h: number }): { stage: { w: number; h: number }; relayout: () => void } {
  const real = globalThis.ResizeObserver;
  const state = { stage: initial };
  const live = new Set<{ report: ResizeObserverCallback; targets: Element[]; self: ResizeObserver }>();
  const rectOf = (target: Element) => (target.classList.contains("ed-preview") ? { width: state.stage.w, height: state.stage.h } : { width: 1_700, height: 200 });
  const entry = (target: Element) => ({ target, contentRect: rectOf(target) }) as unknown as ResizeObserverEntry;
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
    get stage() {
      return state.stage;
    },
    set stage(next) {
      state.stage = next;
    },
    relayout(): void {
      act(() => {
        for (const own of live) own.report(own.targets.map(entry), own.self);
      });
    },
  };
}

type Watched = { readonly target: Node; readonly options: MutationObserverInit };

/**
 * A MutationObserver that reports on cue. happy-dom's holds its callback only through a WeakRef, so it falls silent at the first garbage
 * collection, which a test as long as an editor's makes likely. Each observer still drives a real one (so `waitFor` keeps its cue), and
 * `change(type, target)` reports a change of that kind to every observer that asked for it there: on the target, or on an ancestor with `subtree`.
 */
function watchMutations(): { change: (type: "childList" | "characterData", target: Node) => void } {
  const real = globalThis.MutationObserver;
  const live = new Set<{ report: MutationCallback; watched: Watched[]; self: MutationObserver }>();
  class Watching {
    readonly #real: MutationObserver;
    readonly #own: { report: MutationCallback; watched: Watched[]; self: MutationObserver };
    constructor(report: MutationCallback) {
      this.#real = new real(report);
      this.#own = { report, watched: [], self: this as unknown as MutationObserver };
      live.add(this.#own);
    }
    observe(target: Node, options: MutationObserverInit = {}): void {
      this.#real.observe(target, options);
      this.#own.watched.push({ target, options });
    }
    disconnect(): void {
      this.#real.disconnect();
      this.#own.watched = [];
      live.delete(this.#own);
    }
    takeRecords(): MutationRecord[] {
      return this.#real.takeRecords();
    }
  }
  globalThis.MutationObserver = Watching as unknown as typeof MutationObserver;
  restores.push(() => {
    globalThis.MutationObserver = real;
  });
  const asks = ({ target, options }: Watched, type: "childList" | "characterData", at: Node): boolean =>
    options[type] === true && (target === at || (options.subtree === true && target.contains(at)));
  return {
    change(type, at) {
      act(() => {
        for (const own of live) if (own.watched.some((w) => asks(w, type, at))) own.report([{ type, target: at } as unknown as MutationRecord], own.self);
      });
    },
  };
}

describe("the preview fits the stage", () => {
  test("as tall as a wide stage, 9:16 exactly; the overlays' scale goes with it", async () => {
    pixelRatio(1);
    layOut({ w: 1_500, h: 880 });
    const { client, engine } = await studio();
    await openDraft(engine, client);
    expect(drawn()).toEqual(["495px", "880px"]);
    expect(Number(frame().style.getPropertyValue("--pv-k"))).toBeCloseTo(495 / 306, 6);
  });

  test("on a 2× screen never past 540 × 960 CSS px of the 1080 × 1920 montage, however large the stage", async () => {
    pixelRatio(2);
    layOut({ w: 3_000, h: 2_000 });
    const { client, engine } = await studio();
    await openDraft(engine, client);
    expect(drawn()).toEqual(["540px", "960px"]);
  });

  test("a resize of the window refits it live", async () => {
    pixelRatio(1);
    const laid = layOut({ w: 1_500, h: 880 });
    const { client, engine } = await studio();
    await openDraft(engine, client);
    laid.stage = { w: 800, h: 600 };
    laid.relayout();
    expect(drawn()).toEqual(["333px", "592px"]);
    laid.stage = { w: 300, h: 1_200 };
    laid.relayout();
    expect(drawn()).toEqual(["297px", "528px"]);
  });

  test("moved to a screen of another pixel ratio, it is refitted to that screen's cap", async () => {
    pixelRatio(1);
    const lists: { query: string; listeners: Set<() => void> }[] = [];
    const realMatch = window.matchMedia;
    window.matchMedia = (query: string): MediaQueryList => {
      const list = { query, listeners: new Set<() => void>() };
      lists.push(list);
      return {
        matches: true,
        media: query,
        onchange: null,
        addEventListener: (_type: string, listener: () => void) => list.listeners.add(listener),
        removeEventListener: (_type: string, listener: () => void) => list.listeners.delete(listener),
        addListener: () => {},
        removeListener: () => {},
        dispatchEvent: () => true,
      } as unknown as MediaQueryList;
    };
    restores.push(() => {
      window.matchMedia = realMatch;
    });
    layOut({ w: 3_000, h: 2_000 });
    const { client, engine } = await studio();
    await openDraft(engine, client);
    expect(drawn()).toEqual(["1080px", "1920px"]);
    const watching = lists.filter((l) => l.query.includes("resolution") && l.listeners.size > 0);
    expect(watching.map((l) => l.query)).toEqual(["(resolution: 1dppx)"]);
    pixelRatio(2);
    act(() => {
      for (const listener of watching.flatMap((l) => [...l.listeners])) listener();
    });
    expect(drawn()).toEqual(["540px", "960px"]);
  });

  test("review r1 MEDIUM-2: with room above the frame the notices' dock stays in it; a frame as tall as the stage leaves the dock over it", async () => {
    pixelRatio(2);
    const laid = layOut({ w: 800, h: 1_400 });
    const { client, engine } = await studio();
    await openDraft(engine, client);
    const area = (): HTMLElement | null => document.querySelector<HTMLElement>(".ed-preview");
    // Held to 540 × 960 on a 2× screen: (1400 − 960) / 2 = 220 px above it.
    expect(drawn()).toEqual(["540px", "960px"]);
    expect(area()?.dataset.dock).toBe("above");
    expect(area()?.style.getPropertyValue("--pv-room")).toBe("220px");
    laid.stage = { w: 800, h: 600 };
    laid.relayout();
    expect(area()?.dataset.dock).toBe("over");
  });

  test("review r3 LOW-1: the dock's inset from the stage's top is the one its placement counts, and above the frame it is held to the room under it", async () => {
    pixelRatio(2);
    layOut({ w: 800, h: 1_400 });
    const { client, engine } = await studio();
    await openDraft(engine, client);
    // One number for both sides: the script writes the inset it counts (`dockPlacement`), the stylesheet draws the dock with it.
    expect(document.querySelector<HTMLElement>(".ed-preview")?.style.getPropertyValue("--pv-dock-inset")).toBe("10px");
    const css = await Bun.file(new URL("../montage.css", import.meta.url)).text();
    const rule = (selector: string): string => css.split(`\n${selector} {`)[1]?.split("}")[0] ?? "";
    expect(rule(".ed-dock")).toContain("top: var(--pv-dock-inset);");
    expect(rule(".ed-dock")).toContain("max-height: calc(100% - 2 * var(--pv-dock-inset));");
    expect(rule('.ed-preview[data-dock="above"] > .ed-dock')).toContain("max-height: calc(var(--pv-room) - var(--pv-dock-inset));");
  });

  test("review r3 LOW-2: a text that changes in place in the dock (no card comes or goes) places the dock again", async () => {
    pixelRatio(2);
    layOut({ w: 800, h: 1_400 });
    const watch = watchMutations();
    const { client, engine } = await studio();
    await openDraft(engine, client);
    const area = (): HTMLElement | null => document.querySelector<HTMLElement>(".ed-preview");
    const dock = area()?.querySelector<HTMLElement>(":scope > .ed-dock");
    if (dock === null || dock === undefined) throw new Error("no dock");
    let height = 100;
    Object.defineProperty(dock, "scrollHeight", { configurable: true, get: () => height });
    const line = document.createTextNode("Не удалось сохранить");
    dock.append(line);
    watch.change("childList", dock);
    // 220 px above the 540 × 960 frame: 100 px under the 10 px inset fits.
    expect(area()?.dataset.dock).toBe("above");
    // React changes a line in place (a notice's text, «Ещё N»'s count) by setting its text node's data: no child comes or goes. Wrapped onto
    // more lines, it no longer fits the room at all.
    height = 230;
    line.data = "Не удалось сохранить черновик: библиотека недоступна, проверьте диск и сохраните ещё раз";
    watch.change("characterData", line);
    expect(area()?.dataset.dock).toBe("over");
  });

  // Review round 1 (LOW 4): every pixel of a splitter drag re-rendered the frame and every layer on it, even when the fitted size stayed.
  test("a resize that leaves the fitted size as it is re-renders nothing of the frame", async () => {
    pixelRatio(1);
    const laid = layOut({ w: 1_500, h: 880 });
    const { client, engine } = await studio();
    await openDraft(engine, client);
    const renders = spyOn(previewFrameModule, "visibleLayers");
    restores.push(() => renders.mockRestore());
    // Still as tall as the stage: the same 495 × 880.
    laid.stage = { w: 1_400, h: 880 };
    laid.relayout();
    laid.stage = { w: 1_100, h: 887 };
    laid.relayout();
    expect(drawn()).toEqual(["495px", "880px"]);
    expect(renders).toHaveBeenCalledTimes(0);
    // A size that changes the fit does re-render it.
    laid.stage = { w: 1_100, h: 600 };
    laid.relayout();
    expect(drawn()).toEqual(["333px", "592px"]);
    expect(renders.mock.calls.length).toBeGreaterThan(0);
  });

  test("not laid out (no ResizeObserver report): the stylesheet's own size stands", async () => {
    const { client, engine } = await studio();
    await openDraft(engine, client);
    expect(drawn()).toEqual(["", ""]);
  });

  test("the «Подсказки» block keeps its side clear: the frame narrows by it on both sides and stays centred", async () => {
    pixelRatio(1);
    const laid = layOut({ w: 600, h: 1_000 });
    const { client, engine } = await studio();
    await openDraft(engine, client);
    expect(drawn()).toEqual(["558px", "992px"]);
    const hints = within(preview()).getByRole("group", { name: "Подсказки" });
    Object.defineProperty(hints, "getBoundingClientRect", { configurable: true, value: () => DOMRect.fromRect({ x: 14, y: 880, width: 128, height: 110 }) });
    Object.defineProperty(preview(), "getBoundingClientRect", { configurable: true, value: () => DOMRect.fromRect({ x: 0, y: 0, width: 600, height: 1_000 }) });
    laid.relayout();
    // 142 px of hints and a 12 px gap on each side: 600 − 2 × 154 = 292 px, so 32 steps of 9 × 16.
    expect(drawn()).toEqual(["288px", "512px"]);
  });
});

describe("montage coordinates at any size (no drift between the preview and the render)", () => {
  const heart = { ...stickerLayer(0, 0, 4_000), sticker: { source: "builtin" as const, stickerId: "heart-pulse" }, x: 0.5, y: 0.5, size: 0.2 };
  const layerHit = (): HTMLElement => within(preview()).getByRole("button", { name: "Стикер 1: Сердце" });

  /** The box a preview element is drawn in, in frame pixels (its style is in percent of the 1080 × 1920 frame). */
  function drawnBox(node: HTMLElement | null): Rect {
    const style = node?.style;
    const at = (value: string | undefined, of: number): number => Math.round((Number.parseFloat(value ?? "NaN") / 100) * of * 1000) / 1000;
    return { x: at(style?.left, FRAME_W), y: at(style?.top, FRAME_H), w: at(style?.width, FRAME_W), h: at(style?.height, FRAME_H) };
  }
  const exact = (box: Rect): Rect => ({ x: Math.round(box.x * 1000) / 1000, y: Math.round(box.y * 1000) / 1000, w: Math.round(box.w * 1000) / 1000, h: Math.round(box.h * 1000) / 1000 });

  test("a layer is drawn in the same montage box whatever the preview's size", async () => {
    pixelRatio(1);
    const laid = layOut({ w: 1_500, h: 880 });
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [heart] });
    expect(drawnBox(layerHit().parentElement)).toEqual(exact(stickerBox(heart)));
    laid.stage = { w: 400, h: 500 };
    laid.relayout();
    expect(drawnBox(layerHit().parentElement)).toEqual(exact(stickerBox(heart)));
  });

  test("on a 540 px preview a drag of 27 × 18 px moves the layer 54 × 36 montage px (2 per pointer px), saved once", async () => {
    pixelRatio(2);
    layOut({ w: 3_000, h: 2_000 });
    const { client, engine } = await studio();
    await openDraft(engine, client, { layers: [heart] });
    expect(drawn()).toEqual(["540px", "960px"]);
    // The frame as laid out: the pointer's pixel is worth FRAME_W / 540 = 2 montage pixels.
    Object.defineProperty(frame(), "getBoundingClientRect", { configurable: true, value: () => DOMRect.fromRect({ x: 100, y: 50, width: 540, height: 960 }) });
    fireEvent.pointerDown(layerHit(), { pointerId: 31, button: 0, clientX: 300, clientY: 300 });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointermove", { pointerId: 31, clientX: 327, clientY: 318, buttons: 1 }));
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 31, clientX: 327, clientY: 318 }));
    });
    const expected = dragLayerCentre(stickerBox(heart), { dx: 54, dy: 36 });
    await waitFor(() => expect(callsOf(engine, "montages.save").length).toBeGreaterThan(0), { timeout: AUTOSAVE_DEBOUNCE_MS * 4 });
    expect(callsOf(engine, "montages.save").at(-1)?.payload.spec.layers[0]).toMatchObject({ x: expected.x, y: expected.y, size: 0.2 });
  });
});
