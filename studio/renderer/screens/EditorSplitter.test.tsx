import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { act, fireEvent, screen } from "@testing-library/react";
import type { MontageDraft } from "../../shared/engine";
import type { MockEngine } from "../engine/mockEngine";
import { PHOTO_IDS } from "../engine/mockEngine.testkit";
import { flush } from "../testing";
import { MEDIA_WIDTH, MEDIA_WIDTH_KEY, PROPS_PX, STAGE_ROOM_PX } from "./montage/panelWidth";
import { asAnotherWindow, makeDraft, MIA, openDrafts, studio } from "./montage/screenKit";
import { photoClip } from "./montage/testkit";

// The owner's feedback (2026-10-05): the left panel (Фото / Мои / Музыка / GIF / Текст) is resized by the border between it and the stage. The
// border is a splitter: dragged, keyed (a focusable separator) or double-clicked back to the default; the width is the viewer's own, kept in
// localStorage, and the editor works the same when that storage is not there.

const [P1, P2] = [PHOTO_IDS[0] ?? "", PHOTO_IDS[1] ?? ""];

const splitter = (): HTMLElement => screen.getByRole("separator", { name: "Ширина панели медиа" });
const panel = (): HTMLElement => screen.getByRole("complementary", { name: "Медиа" });
const now = (): number => Number(splitter().getAttribute("aria-valuenow"));
const drawn = (): string => panel().style.width;

beforeEach(() => localStorage.removeItem(MEDIA_WIDTH_KEY));
const restores: (() => void)[] = [];
afterEach(() => {
  for (const restore of restores.splice(0)) restore();
  localStorage.removeItem(MEDIA_WIDTH_KEY);
});

async function openDraft(client: Parameters<typeof makeDraft>[0], engine: MockEngine): Promise<void> {
  const made = await makeDraft(client, MIA.avatarId, []);
  const spec: MontageDraft = { ...made.spec, clips: [P1, P2].map((photoId, i) => photoClip(i, photoId, 2_000)) };
  const saved = await asAnotherWindow(() => client.request("montages.save", { montageId: made.montageId, spec, name: null }));
  if (!saved.ok) throw new Error(`montages.save: ${saved.error.code}`);
  await openDrafts();
  await screen.findByRole("heading", { level: 3, name: /Mia/ });
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();
  expect(engine.calls.length).toBeGreaterThan(0);
}

async function editor(): Promise<void> {
  const { client, engine } = await studio();
  await openDraft(client, engine);
}

/** Leaves the editor and opens the draft again: a new editor reads the stored width anew. */
async function reopen(): Promise<void> {
  await openDrafts();
  fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
  await screen.findByRole("region", { name: "Таймлайн" });
  await flush();
}

/** A pointer drag of the splitter by `dx` screen px; "cancel" ends it as the system taking the pointer. */
function dragBy(dx: number, pointerId: number, end: "up" | "cancel" | null = "up"): void {
  fireEvent.pointerDown(splitter(), { pointerId, button: 0, clientX: 500, clientY: 300 });
  act(() => {
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId, clientX: 500 + dx / 2, clientY: 300, buttons: 1 }));
    window.dispatchEvent(new PointerEvent("pointermove", { pointerId, clientX: 500 + dx, clientY: 300, buttons: 1 }));
    if (end !== null) window.dispatchEvent(new PointerEvent(end === "up" ? "pointerup" : "pointercancel", { pointerId, clientX: 500 + dx, clientY: 300 }));
  });
}

/** The editor's body laid out `width` px wide from now on (the test DOM lays nothing out): a stand-in ResizeObserver reports it. */
function layOutBody(width: number): { resize: (next: number) => void } {
  const real = globalThis.ResizeObserver;
  const live = new Set<{ report: ResizeObserverCallback; targets: Element[]; self: ResizeObserver }>();
  let current = width;
  class Laid {
    readonly #entry: { report: ResizeObserverCallback; targets: Element[]; self: ResizeObserver };
    constructor(report: ResizeObserverCallback) {
      this.#entry = { report, targets: [], self: this as unknown as ResizeObserver };
      live.add(this.#entry);
    }
    observe(target: Element): void {
      this.#entry.targets.push(target);
      this.#entry.report([{ target, contentRect: { width: current, height: 700 } } as unknown as ResizeObserverEntry], this.#entry.self);
    }
    unobserve(): void {}
    disconnect(): void {
      live.delete(this.#entry);
    }
  }
  globalThis.ResizeObserver = Laid as unknown as typeof ResizeObserver;
  restores.push(() => {
    globalThis.ResizeObserver = real;
  });
  return {
    resize(next: number): void {
      current = next;
      act(() => {
        for (const entry of live) entry.report(entry.targets.map((target) => ({ target, contentRect: { width: next, height: 700 } }) as unknown as ResizeObserverEntry), entry.self);
      });
    },
  };
}

describe("the splitter between the media panel and the stage", () => {
  test("a focusable vertical separator for the panel, at the artboard's 280 px with nothing stored", async () => {
    await editor();
    const bar = splitter();
    expect(bar.getAttribute("aria-orientation")).toBe("vertical");
    expect(bar.tabIndex).toBe(0);
    expect([bar.getAttribute("aria-valuenow"), bar.getAttribute("aria-valuemin"), bar.getAttribute("aria-valuemax")]).toEqual([String(MEDIA_WIDTH.default), String(MEDIA_WIDTH.min), String(MEDIA_WIDTH.max)]);
    expect(bar.getAttribute("aria-controls")).toBe(panel().id);
    expect(drawn()).toBe("280px");
  });

  test("dragged, the panel follows the pointer; the width is kept for the next editor", async () => {
    await editor();
    dragBy(80, 1, null);
    expect(now()).toBe(360);
    expect(drawn()).toBe("360px");
    // Nothing is stored until the drag is let go.
    expect(localStorage.getItem(MEDIA_WIDTH_KEY)).toBeNull();
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 1, clientX: 580, clientY: 300 }));
    });
    expect(localStorage.getItem(MEDIA_WIDTH_KEY)).toBe("360");
    await reopen();
    expect(now()).toBe(360);
    expect(drawn()).toBe("360px");
  });

  test("a drag past either end stops there", async () => {
    await editor();
    dragBy(-1_000, 2);
    expect(now()).toBe(MEDIA_WIDTH.min);
    dragBy(5_000, 3);
    expect(now()).toBe(MEDIA_WIDTH.max);
    expect(localStorage.getItem(MEDIA_WIDTH_KEY)).toBe(String(MEDIA_WIDTH.max));
  });

  test("a cancelled drag (the system took the pointer) puts the width back and stores nothing", async () => {
    await editor();
    dragBy(120, 4, "cancel");
    expect(now()).toBe(MEDIA_WIDTH.default);
    expect(drawn()).toBe("280px");
    expect(localStorage.getItem(MEDIA_WIDTH_KEY)).toBeNull();
  });

  test("keys: → and ← by 16 px (⇧ 64), Home and End to the ends, Enter back to the default; each step kept", async () => {
    await editor();
    fireEvent.keyDown(splitter(), { key: "ArrowRight" });
    expect(now()).toBe(296);
    fireEvent.keyDown(splitter(), { key: "ArrowRight", shiftKey: true });
    expect(now()).toBe(360);
    expect(localStorage.getItem(MEDIA_WIDTH_KEY)).toBe("360");
    fireEvent.keyDown(splitter(), { key: "ArrowLeft" });
    expect(now()).toBe(344);
    fireEvent.keyDown(splitter(), { key: "End" });
    expect(now()).toBe(MEDIA_WIDTH.max);
    fireEvent.keyDown(splitter(), { key: "Home" });
    expect(now()).toBe(MEDIA_WIDTH.min);
    fireEvent.keyDown(splitter(), { key: "ArrowLeft" });
    expect(now()).toBe(MEDIA_WIDTH.min);
    fireEvent.keyDown(splitter(), { key: "Enter" });
    expect(now()).toBe(MEDIA_WIDTH.default);
    expect(localStorage.getItem(MEDIA_WIDTH_KEY)).toBeNull();
  });

  test("a key the splitter does not use is left alone (not prevented)", async () => {
    await editor();
    expect(fireEvent.keyDown(splitter(), { key: "ArrowUp" })).toBe(true);
    expect(now()).toBe(MEDIA_WIDTH.default);
  });

  test("a double click goes back to the default and forgets the stored width", async () => {
    localStorage.setItem(MEDIA_WIDTH_KEY, "420");
    await editor();
    expect(now()).toBe(420);
    fireEvent.doubleClick(splitter());
    expect(now()).toBe(MEDIA_WIDTH.default);
    expect(drawn()).toBe("280px");
    expect(localStorage.getItem(MEDIA_WIDTH_KEY)).toBeNull();
  });

  test("a stored width the window has no room for is drawn narrower, and comes back when the window grows", async () => {
    localStorage.setItem(MEDIA_WIDTH_KEY, "500");
    const body = layOutBody(1_000);
    await editor();
    const room = 1_000 - PROPS_PX - STAGE_ROOM_PX;
    expect([now(), Number(splitter().getAttribute("aria-valuemax"))]).toEqual([room, room]);
    expect(drawn()).toBe(`${room}px`);
    body.resize(2_000);
    expect(now()).toBe(500);
    expect(splitter().getAttribute("aria-valuemax")).toBe(String(MEDIA_WIDTH.max));
    // The viewer's choice is not overwritten by the narrow window.
    expect(localStorage.getItem(MEDIA_WIDTH_KEY)).toBe("500");
  });

  // Review round 1 (LOW 3): the drag started from the width DRAWN (held to a narrow window), so a press that never moved stored that narrowed
  // width over the viewer's choice, and a cancelled drag put the narrowed width back as the choice.
  test("a press that does not move stores nothing: the viewer's wider choice survives a narrow window", async () => {
    localStorage.setItem(MEDIA_WIDTH_KEY, "560");
    const body = layOutBody(968);
    await editor();
    const room = 968 - PROPS_PX - STAGE_ROOM_PX;
    expect(now()).toBe(room);
    fireEvent.pointerDown(splitter(), { pointerId: 6, button: 0, clientX: 500, clientY: 300 });
    act(() => {
      window.dispatchEvent(new PointerEvent("pointerup", { pointerId: 6, clientX: 500, clientY: 300 }));
    });
    expect(localStorage.getItem(MEDIA_WIDTH_KEY)).toBe("560");
    body.resize(2_000);
    expect(now()).toBe(560);
  });

  test("a cancelled drag in a narrow window puts back the viewer's choice, not the narrowed width", async () => {
    localStorage.setItem(MEDIA_WIDTH_KEY, "500");
    const body = layOutBody(1_000);
    await editor();
    dragBy(-30, 7, "cancel");
    expect(now()).toBe(1_000 - PROPS_PX - STAGE_ROOM_PX);
    body.resize(2_000);
    expect(now()).toBe(500);
    expect(localStorage.getItem(MEDIA_WIDTH_KEY)).toBe("500");
  });

  test("while the draft loads, the panel's stand-in is already at the width it will be drawn at (held to the window)", async () => {
    localStorage.setItem(MEDIA_WIDTH_KEY, "560");
    layOutBody(968);
    const { client, engine } = await studio();
    const made = await makeDraft(client, MIA.avatarId, [P1, P2]);
    await openDrafts();
    await screen.findByRole("heading", { level: 3, name: /Mia/ });
    engine.delayNext("montages.get", 60_000);
    fireEvent.click(screen.getByRole("button", { name: "Открыть" }));
    await flush();
    const stub = document.querySelector(".editor-loading .ed-media");
    if (!(stub instanceof HTMLElement)) throw new Error(`no loading stand-in for ${made.montageId}`);
    expect(stub.style.width).toBe(`${968 - PROPS_PX - STAGE_ROOM_PX}px`);
  });

  test("the properties panel's width the room is counted with is the stylesheet's", async () => {
    const css = await Bun.file(new URL("../montage.css", import.meta.url)).text();
    const rule = /\n\.ed-props \{([^}]*)\}/.exec(css)?.[1] ?? "";
    expect(/\bwidth: (\d+)px;/.exec(rule)?.[1]).toBe(String(PROPS_PX));
  });

  test("with the storage blocked (every access throws), the editor opens at the default and the splitter still works", async () => {
    const original = Object.getOwnPropertyDescriptor(window, "localStorage");
    Object.defineProperty(window, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("storage is disabled", "SecurityError");
      },
    });
    restores.push(() => {
      if (original !== undefined) Object.defineProperty(window, "localStorage", original);
    });
    await editor();
    expect(now()).toBe(MEDIA_WIDTH.default);
    dragBy(40, 5);
    expect(now()).toBe(320);
    fireEvent.doubleClick(splitter());
    expect(now()).toBe(MEDIA_WIDTH.default);
  });

  test("with a storage whose reads and writes throw, the same", async () => {
    const reads = spyOn(Storage.prototype, "getItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    const writes = spyOn(Storage.prototype, "setItem").mockImplementation(() => {
      throw new DOMException("quota", "QuotaExceededError");
    });
    restores.push(
      () => reads.mockRestore(),
      () => writes.mockRestore(),
    );
    await editor();
    expect(now()).toBe(MEDIA_WIDTH.default);
    fireEvent.keyDown(splitter(), { key: "ArrowRight" });
    expect(now()).toBe(296);
  });
});
