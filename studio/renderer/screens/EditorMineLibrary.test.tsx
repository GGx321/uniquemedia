import { afterEach, describe, expect, test } from "bun:test";
import { act, fireEvent, screen, within } from "@testing-library/react";
import type { MontageDraft } from "../../shared/engine";
import type { EngineClient } from "../engine/client";
import { callsOf, flush } from "../testing";
import {
  heldListings,
  IDS,
  media,
  mineStudio,
  nextSave,
  openMine,
  PHOTO,
  plain,
  preview,
  section,
  seedMine,
  tabListings,
} from "./montage/mineScreenKit";
import { asAnotherWindow } from "./montage/screenKit";
import { collageClip, photoClip } from "./montage/testkit";

// 3f.6 round 1: what the review found unpinned. The tab's listing (M3: a resync lists again, a change that lands before the answer is kept,
// a stale answer is never shown, another library shows nothing of the old one), the placing rules on the screen (M4), one sound at a time
// across the editor (L5) and the live posters (M1).

const stickerName = (name: string) => new RegExp(`^Стикер ${name.replace(".", "\\.")}`);

/** Forces the store to take its snapshot again (a seq gap): the events catch-up fails, so it falls back to a snapshot. */
async function resync(engine: Parameters<typeof seedMine>[0]): Promise<void> {
  engine.failNext("engine.events", { code: "INTERNAL" });
  await act(async () => {
    window.dispatchEvent(new Event("online"));
  });
  await flush();
}

/** The photo and video tiles shown; none while the section is not there (the tab is listing). */
function photoTiles(): string[] {
  const shown = within(media()).queryByRole("region", { name: "Фото и видео" });
  if (shown === null) return [];
  return within(shown)
    .queryAllByRole("button")
    .flatMap((b) => {
      const label = b.getAttribute("aria-label") ?? "";
      return label.startsWith("Фото ") || label.startsWith("Видео ") ? [label.split(":")[0] ?? ""] : [];
    });
}

describe("the tab's listing (round 1, M3)", () => {
  test("a snapshot taken again lists the library again: a file stored in the gap appears", async () => {
    const { engine, client } = await mineStudio();
    seedMine(engine);
    await openMine(engine, client);
    const before = tabListings(engine);
    engine.seedOwnMedia([{ kind: "photo", name: "gap.jpg", bytes: 1_000 }]);
    await resync(engine);
    expect(tabListings(engine)).toBe(before + 1);
    expect(within(section("Фото и видео")).getByRole("button", { name: /^Фото gap\.jpg/ })).toBeDefined();
  });

  test("a change that lands before the listing's answer is kept: a file deleted meanwhile does not come back", async () => {
    const box: { gate?: ReturnType<typeof heldListings> } = {};
    const { engine, client } = await mineStudio((base) => {
      box.gate = heldListings(base);
      return box.gate.client;
    });
    seedMine(engine);
    const held = box.gate;
    if (held === undefined) throw new Error("no gate");
    held.hold(true);
    await openMine(engine, client);
    expect(held.waiting()).toBe(1);
    await asAnotherWindow(() => client.request("media.delete", { mediaId: PHOTO }));
    await act(async () => held.release(0));
    await flush();
    expect(photoTiles().some((t) => t.includes("croissant"))).toBe(false);
    expect(photoTiles().some((t) => t.includes("latte-pour"))).toBe(true);
  });

});

describe("a cancel the engine refuses (round 1, L1)", () => {
  test("the tile goes back to its percent, the refusal is said, and its own ✕ works again", async () => {
    const { engine, client } = await mineStudio();
    await openMine(engine, client);
    engine.holdImports(true);
    engine.pickMediaNext([{ name: "street-walk.mp4", accept: { kind: "video", bytes: 5_000 } }]);
    fireEvent.click(within(media()).getByRole("button", { name: /Добавить файлы/ }));
    await flush();
    engine.failNext("media.cancelImport", { code: "INTERNAL", detail: "the cancel could not be sent" });
    fireEvent.click(within(section("Фото и видео")).getByRole("button", { name: "Отменить добавление street-walk.mp4" }));
    await flush();
    expect(plain(within(media()).getByRole("alert").textContent)).toContain("Не удалось отменить");
    const tile = within(section("Фото и видео")).getByRole("listitem", { name: /^Видео street-walk\.mp4/ });
    expect(plain(tile.textContent)).toContain("0 %");
    expect(within(section("Фото и видео")).getByRole("button", { name: "Отменить добавление street-walk.mp4" }).hasAttribute("disabled")).toBe(false);
  });
});

describe("placing on the screen (round 1, M4)", () => {
  test("an own photo dropped on an empty cell fills it, and its face is asked of the engine", async () => {
    const { engine, client } = await mineStudio();
    seedMine(engine);
    await openMine(engine, client, { clips: [collageClip(0, [IDS[0] ?? "", null], 4_000, false), photoClip(1, IDS[1] ?? "", 2_000)] });
    fireEvent.dragStart(within(section("Фото и видео")).getByRole("button", { name: /^Фото croissant\.jpg/ }));
    const empty = within(preview()).getByLabelText("Кадр 1, ячейка 2: пустая");
    fireEvent.dragOver(empty);
    expect(empty.className).toContain("pv-cell-drop");
    fireEvent.drop(empty);
    await flush();
    const saved = await nextSave(engine);
    const first = saved.clips[0];
    expect(first?.kind === "collage" ? first.cells[1]?.photo : null).toEqual({ source: "own", mediaId: PHOTO });
    expect(callsOf(engine, "montages.focus").map((c) => c.payload.photo)).toEqual([{ source: "own", mediaId: PHOTO }]);
  });

  test("with 10 stickers the sticker tiles are off and say why; a click adds nothing", async () => {
    const { engine, client } = await mineStudio();
    seedMine(engine);
    const sticker = (i: number): MontageDraft["layers"][number] => ({ layerId: `layer-${String(i + 1).padStart(3, "0")}`, startMs: 0, endMs: 1_000, kind: "sticker", sticker: { source: "builtin", stickerId: "heart-pulse" }, x: 0.5, y: 0.5, size: 0.2 });
    await openMine(engine, client, { layers: Array.from({ length: 10 }, (_, i) => sticker(i)) });
    const tile = within(section("Стикеры")).getByRole("button", { name: stickerName("underline.gif") });
    expect(tile.hasAttribute("disabled")).toBe(true);
    expect(tile.getAttribute("title")).toBe("Не больше 10 стикеров в одном видео — уберите один, чтобы добавить другой.");
    expect(plain(within(section("Стикеры")).getByRole("status").textContent)).toBe("Не больше 10 стикеров в одном видео — уберите один, чтобы добавить другой.");
    fireEvent.click(tile);
    await flush();
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
  });

  test("a video under 0.1 s and a track shorter than the montage are off in the UI: the video can be neither clicked nor dragged", async () => {
    const { engine, client } = await mineStudio();
    seedMine(engine);
    await openMine(engine, client);
    const blink = within(section("Фото и видео")).getByRole("button", { name: /^Видео blink\.mov/ });
    expect(blink.hasAttribute("disabled")).toBe(true);
    expect(blink.getAttribute("draggable")).toBe("false");
    const short = within(section("Музыка")).getByRole("button", { name: /^voice-note\.m4a/ });
    expect(short.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(short);
    await flush();
    expect(callsOf(engine, "montages.save")).toHaveLength(0);
  });
});

/** The real client's kind over the mock: the media URLs (posters, a track to listen to) are then made. */
const asWindow = (client: EngineClient): EngineClient => ({ ...client, kind: "window" });

describe("one sound at a time across the editor (round 1, L5)", () => {

});

describe("video posters (rounds 1 and 2, M1)", () => {
  const original: unknown = Reflect.get(globalThis, "IntersectionObserver");
  afterEach(() => {
    Reflect.set(globalThis, "IntersectionObserver", original);
  });

  /**
   * Observers as a scrolled list reports them (happy-dom's never report): the tile at place `i` among the video tiles is visible when `visible(i)`
   * and in the margin observer's zone when `near(i)`, judged by each observer's own margin. `move` says it again for a new scroll.
   */
  function scrolled(visible: (i: number) => boolean, near: (i: number) => boolean) {
    const all: { margin: string; targets: Element[]; callback: (entries: { target: Element; isIntersecting: boolean }[]) => void }[] = [];
    let view = { visible, near };
    const place = (target: Element): number => [...document.querySelectorAll("[data-poster]")].indexOf(target);
    const judge = (margin: string, target: Element): boolean => (margin === "0px" ? view.visible(place(target)) : view.near(place(target)));
    class Scrolled {
      readonly #me: (typeof all)[number];
      constructor(callback: (entries: { target: Element; isIntersecting: boolean }[]) => void, options: { rootMargin?: string }) {
        this.#me = { margin: options.rootMargin ?? "0px", targets: [], callback };
        all.push(this.#me);
      }
      observe(target: Element): void {
        this.#me.targets.push(target);
        queueMicrotask(() => this.#me.callback([{ target, isIntersecting: judge(this.#me.margin, target) }]));
      }
      unobserve(): void {}
      disconnect(): void {
        this.#me.targets = [];
      }
    }
    Reflect.set(globalThis, "IntersectionObserver", Scrolled);
    return {
      move(next: { visible: (i: number) => boolean; near: (i: number) => boolean }): void {
        view = next;
        for (const observer of all) observer.callback(observer.targets.map((target) => ({ target, isIntersecting: judge(observer.margin, target) })));
      },
    };
  }

  /** The places `from` (included) to `to` (excluded). */
  const within = (from: number, to: number) => (i: number): boolean => i >= from && to > i;
  const seedVideos = (engine: Parameters<typeof seedMine>[0], n: number): void =>
    engine.seedOwnMedia(Array.from({ length: n }, (_, i) => ({ kind: "video" as const, name: `v${String(i).padStart(2, "0")}.mov`, bytes: 1_000, facts: { width: 1080, height: 1920, durationMs: 6_000, sourceFps: 30 } })));
  const tiles = (): Element[] => [...section("Фото и видео").querySelectorAll("[data-poster]")];
  const isLive = (tile: Element): boolean => tile.querySelector("video") !== null;

  test("scrolled to the middle of 80 videos: every visible tile holds its poster, and the nearest margin tiles the rest of the 24", async () => {
    scrolled(within(30, 50), within(10, 70));
    const { engine, client } = await mineStudio(asWindow);
    seedVideos(engine, 80);
    await openMine(engine, client);
    await flush();
    const all = tiles();
    expect(all).toHaveLength(80);
    expect(all.slice(30, 50).every(isLive)).toBe(true);
    expect(all.filter(isLive)).toHaveLength(24);
    expect([28, 29, 50, 51].every((i) => isLive(all[i] ?? document.body))).toBe(true);
    expect(isLive(all[10] ?? document.body)).toBe(false);
  });

});
