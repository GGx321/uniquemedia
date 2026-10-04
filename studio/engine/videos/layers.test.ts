import { afterEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Layer } from "../../shared/engine/montage";
import { FRAME_H, FRAME_W, layerRange, stickerBox, textBox } from "../../shared/montage";
import { stickerById } from "../../shared/stickers/manifest";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { buildLayerPass } from "../render";
import { RenderFailure } from "../renderQueue/queue";
import type { CaptionRequest } from "../text/caption/types";
import { RasterError } from "../text/rasterTypes";
import type { PreviewGate } from "../text/preview";
import type { GateCaption } from "../text/worker/textGate";
import { flatApng } from "../media/stickerFixtures.testkit";
import { resolveLayers, type LayerDeps } from "./layers";
import type { OwnStickerSource } from "./ownStickers";
import { StickerAssetError, type StickerAssets } from "./stickerAssets";
useNativeGlobals();

// The layers of a spec become the render's overlay inputs (plan 3b.6): each text layer is drawn by the engine's own rasteriser
// (the very function behind `montages.textPreview`), each built-in sticker is read from the verified set, both are placed by the
// shared geometry (`textBox`, `stickerBox`, `layerRange`), and both are written into the JOB's own folder under fixed names. The
// renderer names no path: a layer is data, and every file ffmpeg opens is one the engine made.

const JOB = "/work/render-tmp/job-00000001";
const signal = new AbortController().signal;

const text = (k: number, over: Partial<Extract<Layer, { kind: "text" }>> = {}): Extract<Layer, { kind: "text" }> => ({
  layerId: `layer-t${k}`,
  kind: "text",
  startMs: 300,
  endMs: 2_100,
  value: `caption ${k}`,
  font: "manrope",
  style: "plaque",
  color: "#ffffff",
  x: 0.5,
  y: 0.195,
  scale: 1,
  ...over,
});

const sticker = (k: number, over: Partial<Extract<Layer, { kind: "sticker" }>> = {}): Extract<Layer, { kind: "sticker" }> => ({
  layerId: `layer-s${k}`,
  kind: "sticker",
  startMs: 0,
  endMs: 3_000,
  sticker: { source: "builtin", stickerId: "heart-pulse" },
  x: 0.741,
  y: 0.333,
  size: 0.203,
  ...over,
});

const PNG = (k: number) => Uint8Array.from([137, 80, 78, 71, k, k, k]);
const APNG = Uint8Array.from([137, 80, 78, 71, 9, 9, 9, 9]);

interface Rig {
  readonly deps: LayerDeps;
  readonly asked: Array<{ request: CaptionRequest; signal: AbortSignal | undefined }>;
}

function rig(over: { caption?: (request: CaptionRequest) => Promise<GateCaption>; read?: StickerAssets["read"]; writeFile?: LayerDeps["writeFile"] } = {}): Rig {
  const asked: Rig["asked"] = [];
  let n = 0;
  const gate: PreviewGate = {
    caption: async (request, options) => {
      asked.push({ request, signal: options?.signal });
      if (over.caption !== undefined) return over.caption(request);
      n += 1;
      return { png: PNG(n), width: 700 + n, height: 120 + n, layout: { fontSize: 56, lines: [request.value], width: 700 + n, height: 120 + n }, workerMs: 1 };
    },
  };
  const stickers: StickerAssets = { read: over.read ?? (async () => ({ bytes: APNG, loopFrames: 24, width: 320, height: 320 })) };
  return { asked, deps: { gate, stickers, ...(over.writeFile === undefined ? {} : { writeFile: over.writeFile }) } };
}

const failureOf = async (p: Promise<unknown>): Promise<RenderFailure> => {
  const error = await p.then(() => undefined, (e: unknown) => e);
  if (!(error instanceof RenderFailure)) throw new Error(`expected a RenderFailure, got ${String(error)}`);
  return error;
};

describe("resolveLayers: no layers", () => {
  test("gives no overlay, draws nothing and writes nothing", async () => {
    const r = rig();
    const resolved = await resolveLayers([], JOB, r.deps, signal);
    expect(resolved.overlays).toEqual([]);
    expect(r.asked).toEqual([]);
  });
});

describe("resolveLayers: a text layer", () => {
  test("asks the rasteriser for exactly the layer's drawing fields, under the job's signal", async () => {
    const r = rig();
    const layer = text(1, { value: "sunday reset ☀️", font: "oswald", style: "outline", color: "#ffd166", scale: 1.5 });
    await resolveLayers([layer], JOB, r.deps, signal);
    expect(r.asked).toEqual([{ request: { value: "sunday reset ☀️", font: "oswald", style: "outline", color: "#ffd166", scale: 1.5 }, signal }]);
  });

  test("is a PNG overlay in the job folder, never scaled, over the layer's own frames", async () => {
    const layer = text(1, { startMs: 300, endMs: 2_100 });
    const { overlays } = await resolveLayers([layer], JOB, rig().deps, signal);
    expect(overlays).toEqual([{ path: join(JOB, "text-00.png"), format: "png", box: textBox(layer, { w: 701, h: 121 }), resize: false, startFrame: 9, endFrame: 63 }]);
    expect(layerRange(layer)).toMatchObject({ startFrame: 9, endFrame: 63 });
  });

  test("is centred where the layer says, on the raster's size", async () => {
    const layer = text(1, { x: 0.5, y: 0.5 });
    const { overlays } = await resolveLayers([layer], JOB, rig().deps, signal);
    const box = overlays[0]?.box;
    expect(box).toEqual({ x: 190, y: 900, w: 701, h: 121 });
    expect((box?.x ?? 0) + (box?.w ?? 0) / 2).toBeCloseTo(FRAME_W / 2, -1);
  });

  test.each([
    ["the top-left corner", 0, 0],
    ["the bottom-right corner", 1, 1],
    ["the top edge", 0.5, 0],
    ["the right edge", 1, 0.5],
  ] as const)("keeps the box inside the frame, on an even offset, at %s", async (_name, x, y) => {
    const { overlays } = await resolveLayers([text(1, { x, y })], JOB, rig().deps, signal);
    const box = overlays[0]?.box;
    expect(box?.x).toBeGreaterThanOrEqual(0);
    expect(box?.y).toBeGreaterThanOrEqual(0);
    expect((box?.x ?? 0) + (box?.w ?? 0)).toBeLessThanOrEqual(FRAME_W);
    expect((box?.y ?? 0) + (box?.h ?? 0)).toBeLessThanOrEqual(FRAME_H);
    expect((box?.x ?? 1) % 2).toBe(0);
    expect((box?.y ?? 1) % 2).toBe(0);
  });

  test("a rasteriser's caption rule is TEXT_INVALID with the rule, as the preview answers it", async () => {
    const r = rig({ caption: () => Promise.reject(new RasterError("CAPTION_INVALID", "a character outside the charset", { captionIssue: "charset" })) });
    const failure = await failureOf(resolveLayers([text(1)], JOB, r.deps, signal));
    expect(failure.engineError).toMatchObject({ code: "TEXT_INVALID", captionIssue: "charset" });
  });

  test("a rasteriser timeout is RENDER_FAILED with the hint to shrink the caption", async () => {
    const r = rig({ caption: () => Promise.reject(new RasterError("RENDER_TIMEOUT", "too slow")) });
    const failure = await failureOf(resolveLayers([text(1)], JOB, r.deps, signal));
    expect(failure.engineError.code).toBe("RENDER_FAILED");
    expect(failure.engineError.detail).toContain("уменьшите размер или смените стиль");
  });

  test("an error that is not the rasteriser's is not dressed up: it propagates as it is", async () => {
    const boom = new Error("boom");
    const r = rig({ caption: () => Promise.reject(boom) });
    expect(await resolveLayers([text(1)], JOB, r.deps, signal).then(() => undefined, (e: unknown) => e)).toBe(boom);
  });

  test("an aborted job draws nothing", async () => {
    const stop = new AbortController();
    stop.abort(new Error("cancelled"));
    const r = rig();
    expect(await resolveLayers([text(1)], JOB, r.deps, stop.signal).then(() => undefined, (e: unknown) => (e instanceof Error ? e.message : e))).toBe("cancelled");
    expect(r.asked).toEqual([]);
  });
});

describe("resolveLayers: a built-in sticker", () => {
  test("is an APNG overlay in the job folder, scaled to its box, with its STORED loop period and its own size", async () => {
    const layer = sticker(1, { startMs: 600, endMs: 2_400, size: 0.3 });
    const { overlays } = await resolveLayers([layer], JOB, rig().deps, signal);
    expect(overlays).toEqual([
      {
        path: join(JOB, "sticker-00.apng"),
        format: "apng",
        box: stickerBox(layer),
        resize: true,
        startFrame: 18,
        endFrame: 72,
        loopFrames: 24,
        sourceSize: { w: 320, h: 320 },
      },
    ]);
  });

  test("takes its loop period from the verified set, not from the layer or the manifest alone", async () => {
    const r = rig({ read: async () => ({ bytes: APNG, loopFrames: 36, width: 320, height: 320 }) });
    const { overlays } = await resolveLayers([sticker(1)], JOB, r.deps, signal);
    expect(overlays[0]?.loopFrames).toBe(36);
  });

  test("is square, its width a fraction of the frame width", async () => {
    const { overlays } = await resolveLayers([sticker(1, { size: 0.6 })], JOB, rig().deps, signal);
    expect(overlays[0]?.box).toMatchObject({ w: 648, h: 648 });
  });

  test("reads the sticker by its id, so the layer's text names no path", async () => {
    const seen: string[] = [];
    const r = rig({ read: async (id) => (seen.push(id), { bytes: APNG, loopFrames: stickerById(id)?.loopFrames ?? 24, width: 320, height: 320 }) });
    await resolveLayers([sticker(1, { sticker: { source: "builtin", stickerId: "star-spin" } })], JOB, r.deps, signal);
    expect(seen).toEqual(["star-spin"]);
  });

  test("a sticker the set cannot vouch for fails the render with its reason and no path", async () => {
    const r = rig({ read: () => Promise.reject(new StickerAssetError("tampered", "sticker heart-pulse is not the file the catalogue lists")) });
    const failure = await failureOf(resolveLayers([sticker(1)], JOB, r.deps, signal));
    expect(failure.engineError.code).toBe("RENDER_FAILED");
    expect(failure.engineError.detail).toContain("tampered");
    expect(failure.engineError.detail).not.toContain("/");
  });

});

// 3f.5: an own sticker is read as a built-in one is, from a copy the render verified (the record's size and sha256 on the exact bytes, the strict
// APNG reader, the record's canvas and loop), and written into the job's folder like the others. Its box is sized from ITS canvas, which need not be square.
describe("resolveLayers: an own sticker", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const folder = (): string => (dir = mkdtempSync(join(tmpdir(), "studio-own-layers-")));

  const ownLayer = (k: number, mediaId: string, over: Partial<Extract<Layer, { kind: "sticker" }>> = {}) => sticker(k, { sticker: { source: "own", mediaId }, ...over });

  /** A stored own sticker: a real two-frame APNG of 12 x 8, one slot a frame, at a path in a folder of its own. */
  function stored(mediaId: string, over: Partial<OwnStickerSource> = {}, bytes: Uint8Array = flatApng([[255, 0, 0, 255], [0, 255, 0, 255]], { width: 12, height: 8 })): OwnStickerSource {
    const path = join(folder(), `${mediaId}.png`);
    writeFileSync(path, bytes);
    return { mediaId, path, sha256: createHash("sha256").update(bytes).digest("hex"), bytes: bytes.length, width: 12, height: 8, loopFrames: 2, ...over };
  }

  const sourcesOf = (...list: OwnStickerSource[]): ReadonlyMap<string, OwnStickerSource> => new Map(list.map((s) => [s.mediaId, s]));

  test("is an APNG overlay in the job folder, scaled to its box, with the STORED loop and its own canvas", async () => {
    const own = stored("media-0000001");
    const layer = ownLayer(1, "media-0000001", { startMs: 600, endMs: 2_400, size: 0.3 });
    const { overlays } = await resolveLayers([layer], JOB, rig().deps, signal, sourcesOf(own));
    expect(overlays).toEqual([
      { path: join(JOB, "sticker-00.apng"), format: "apng", box: stickerBox(layer, { w: 12, h: 8 }), resize: true, startFrame: 18, endFrame: 72, loopFrames: 2, sourceSize: { w: 12, h: 8 } },
    ]);
  });

  test("its box follows its canvas: a 12 x 8 sticker is wider than it is high", async () => {
    const own = stored("media-0000001");
    const { overlays } = await resolveLayers([ownLayer(1, "media-0000001", { size: 0.6 })], JOB, rig().deps, signal, sourcesOf(own));
    expect(overlays[0]?.box).toMatchObject({ w: 648, h: 432 });
  });

  test("the overlay names a file in the job folder, never the library file", async () => {
    const own = stored("media-0000001");
    const { overlays } = await resolveLayers([ownLayer(1, "media-0000001")], JOB, rig().deps, signal, sourcesOf(own));
    expect(overlays[0]?.path.startsWith(JOB)).toBe(true);
    expect(overlays[0]?.path).not.toBe(own.path);
  });

  test("stages the verified bytes under the overlay's name, byte for byte", async () => {
    const own = stored("media-0000001");
    const job = folder();
    const resolved = await resolveLayers([ownLayer(1, "media-0000001")], job, rig().deps, signal, sourcesOf(own));
    await resolved.stage(job);
    expect(new Uint8Array(readFileSync(join(job, "sticker-00.apng")))).toEqual(new Uint8Array(readFileSync(own.path)));
  });

  test("a change to the library file after it was verified does not reach the staged copy", async () => {
    const own = stored("media-0000001");
    const job = folder();
    const resolved = await resolveLayers([ownLayer(1, "media-0000001")], job, rig().deps, signal, sourcesOf(own));
    const before = new Uint8Array(readFileSync(own.path));
    writeFileSync(own.path, new Uint8Array(own.bytes).fill(3));
    await resolved.stage(job);
    expect(new Uint8Array(readFileSync(join(job, "sticker-00.apng")))).toEqual(before);
  });

  test("keeps the spec's order beside text and built-in layers, each file named after its place", async () => {
    const own = stored("media-0000001");
    const { overlays } = await resolveLayers([text(1), ownLayer(2, "media-0000001"), sticker(3)], JOB, rig().deps, signal, sourcesOf(own));
    expect(overlays.map((o) => o.path)).toEqual([join(JOB, "text-00.png"), join(JOB, "sticker-01.apng"), join(JOB, "sticker-02.apng")]);
  });

  test("two layers that use one media each get their own file", async () => {
    const own = stored("media-0000001");
    const { overlays } = await resolveLayers([ownLayer(1, "media-0000001"), ownLayer(2, "media-0000001")], JOB, rig().deps, signal, sourcesOf(own));
    expect(overlays.map((o) => o.path)).toEqual([join(JOB, "sticker-00.apng"), join(JOB, "sticker-01.apng")]);
  });

  test("what it gives is what the layer pass accepts", async () => {
    const own = stored("media-0000001");
    const { overlays } = await resolveLayers([ownLayer(1, "media-0000001", { x: 1, y: 1, startMs: 1_500, endMs: 3_000 })], JOB, rig().deps, signal, sourcesOf(own));
    expect(() => buildLayerPass({ layers: overlays, totalFrames: 90, clipDir: JOB })).not.toThrow();
  });

  test("a file whose bytes are not the record's fails the render, with no path and no media id", async () => {
    const own = stored("media-0000001");
    writeFileSync(own.path, new Uint8Array(own.bytes).fill(1));
    const failure = await failureOf(resolveLayers([ownLayer(1, "media-0000001")], JOB, rig().deps, signal, sourcesOf(own)));
    expect(failure.engineError.code).toBe("RENDER_FAILED");
    expect(JSON.stringify(failure.engineError)).not.toContain(own.path);
    expect(JSON.stringify(failure.engineError)).not.toContain("media-0000001");
  });

  test("a sticker whose loop is not the record's fails the render", async () => {
    const own = stored("media-0000001", { loopFrames: 9 });
    expect((await failureOf(resolveLayers([ownLayer(1, "media-0000001")], JOB, rig().deps, signal, sourcesOf(own)))).engineError.code).toBe("RENDER_FAILED");
  });

  test("a layer whose media the admission did not hold fails the render rather than rendering without it", async () => {
    const failure = await failureOf(resolveLayers([ownLayer(1, "media-0000001")], JOB, rig().deps, signal, sourcesOf()));
    expect(failure.engineError.code).toBe("RENDER_FAILED");
  });

  test("with no own stickers given at all, an own layer fails the render the same way", async () => {
    expect((await failureOf(resolveLayers([ownLayer(1, "media-0000001")], JOB, rig().deps, signal))).engineError.code).toBe("RENDER_FAILED");
  });

  test("a cancel stops it before the file is read", async () => {
    const own = stored("media-0000001");
    const controller = new AbortController();
    controller.abort(new Error("stopped"));
    await expect(resolveLayers([ownLayer(1, "media-0000001")], JOB, rig().deps, controller.signal, sourcesOf(own))).rejects.toThrow("stopped");
  });
});

describe("resolveLayers: z-order and names", () => {
  test("keeps the spec's order, and names each file after its layer's place in it", async () => {
    const { overlays } = await resolveLayers([text(1), sticker(2), text(3)], JOB, rig().deps, signal);
    expect(overlays.map((o) => o.path)).toEqual([join(JOB, "text-00.png"), join(JOB, "sticker-01.apng"), join(JOB, "text-02.png")]);
  });

  test("draws the text layers one after another in order", async () => {
    const r = rig();
    await resolveLayers([text(1), sticker(2), text(3)], JOB, r.deps, signal);
    expect(r.asked.map((a) => a.request.value)).toEqual(["caption 1", "caption 3"]);
  });

  test("what it gives is what the layer pass accepts: a text, a sticker and a window ending on the last frame", async () => {
    const layers = [text(1, { startMs: 0, endMs: 3_000 }), sticker(2, { x: 1, y: 1, startMs: 1_500, endMs: 3_000 }), text(3, { x: 0, y: 0 })];
    const { overlays } = await resolveLayers(layers, JOB, rig().deps, signal);
    expect(() => buildLayerPass({ layers: overlays, totalFrames: 90, clipDir: JOB })).not.toThrow();
  });
});

describe("resolveLayers: staging the files", () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });
  const folder = (): string => (dir = mkdtempSync(join(tmpdir(), "studio-layers-")));

  test("writes each text PNG and sticker copy under the name its overlay has, byte for byte", async () => {
    const job = folder();
    const resolved = await resolveLayers([text(1), sticker(2)], job, rig().deps, signal);
    await resolved.stage(job);
    expect(new Uint8Array(readFileSync(join(job, "text-00.png")))).toEqual(PNG(1));
    expect(new Uint8Array(readFileSync(join(job, "sticker-01.apng")))).toEqual(APNG);
  });

  test("never overwrites: a file already there is an error, not replaced", async () => {
    const job = folder();
    writeFileSync(join(job, "text-00.png"), "planted");
    const resolved = await resolveLayers([text(1)], job, rig().deps, signal);
    await expect(resolved.stage(job)).rejects.toThrow();
    expect(readFileSync(join(job, "text-00.png"), "utf8")).toBe("planted");
  });

  test("stages only into the job's own folder", async () => {
    const job = folder();
    const resolved = await resolveLayers([text(1)], job, rig().deps, signal);
    await expect(resolved.stage(join(job, "other"))).rejects.toThrow(TypeError);
  });

  test("with no layers it writes nothing and does not need the folder to exist", async () => {
    const resolved = await resolveLayers([], "/nowhere/at/all", rig().deps, signal);
    await expect(resolved.stage("/nowhere/at/all")).resolves.toBeUndefined();
  });
});
