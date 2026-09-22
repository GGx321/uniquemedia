import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  resolveFirstFrameMode,
  routeForKind,
  uniquifyRoute,
  type Backends,
  type MediaBackend,
  type PhotoBackend,
} from "./mediaRoute";
import { samplePhotoRecipe } from "../core/photo/sampler";
import { makeTestClip, makeTestHeif, makeTestPhoto } from "./testClip";
import type { IdentityMode, MediaInfo, Recipe, StartOptions } from "../core/types";
import type { PhotoRecipe } from "../core/photo/types";
import type { DeviceProfile } from "../core/deviceProfile";

/**
 * `firstFrame: "photo"` needs a file the sampler cannot open, so the route
 * resolves the cover before the batch the way it resolves a still's edge
 * mode: probe it, decide `auto` from its pixels, and hand the sampler numbers.
 * The boundary is also where a request that cannot be honoured is refused —
 * with a sentence that says what to do, before anything is rendered.
 */

const videoInfo: MediaInfo = { kind: "video", durationSec: 5, width: 1080, height: 1920, hasAudio: true };
const coverInfo: MediaInfo = { kind: "photo", durationSec: 0, width: 1440, height: 1080, hasAudio: false };

const NOW = 1_780_000_000_000;

/** More set bytes => larger PDQ distance from an all-zero frame. */
function frameOfDistance(d: number): Uint8Array {
  const f = new Uint8Array(64 * 64);
  for (let i = 0; i < d * 30; i++) f[i] = 255;
  return f;
}

/** A 64x64 frame whose border varies everywhere, so `auto` keeps cropping. */
function busyEdgedFrame(): Uint8Array {
  const g = new Uint8Array(64 * 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) g[y * 64 + x] = 100 + (((x * 31 + y * 17) % 25) - 12);
  }
  return g;
}

class FakeBackend<R> implements MediaBackend<R> {
  rendered: R[] = [];
  probed: string[] = [];
  grayFramesOf: string[] = [];
  edgeColorCalls = 0;
  constructor(private readonly info: MediaInfo) {}
  async probe(input: string): Promise<MediaInfo> {
    this.probed.push(input);
    return this.info;
  }
  async render(_input: string, _info: MediaInfo, recipe: R): Promise<void> {
    this.rendered.push(recipe);
  }
  async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
    this.grayFramesOf.push(input);
    const frame =
      input === "SOURCE" ? new Uint8Array(64 * 64) : input.endsWith(".jpg") ? busyEdgedFrame() : frameOfDistance(5);
    return Array.from({ length: count }, () => frame);
  }
  async extractThumbnail(): Promise<string> {
    return "data:image/jpeg;base64,";
  }
  async sampleEdgeColor(): Promise<string> {
    this.edgeColorCalls++;
    return "0x102030";
  }
  async applyIdentity(_o: string, _i: IdentityMode, _p: DeviceProfile): Promise<void> {}
  cancel(): void {}
  async warmup(): Promise<void> {}
  async replace(): Promise<void> {}
  async discard(): Promise<void> {}
}

function fakeBackends(): { backends: Backends; video: FakeBackend<Recipe>; photo: FakeBackend<PhotoRecipe> & PhotoBackend } {
  const video = new FakeBackend<Recipe>(videoInfo);
  const photo = new FakeBackend<PhotoRecipe>(coverInfo);
  return { backends: { video, photo }, video, photo };
}

const opts: StartOptions = {
  strength: 1.0,
  exportFormat: "reels",
  allowMirror: false,
  targetDistance: 30,
  identity: "engine",
  edgeMode: "auto",
};

let dir: string;
let still: string;
let clip: string;
let heif: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-route-ff-"));
  still = join(dir, "cover.jpg");
  clip = join(dir, "clip.mp4");
  heif = join(dir, "cover.heic");
  makeTestPhoto(still, 320, 240);
  makeTestClip(clip);
  makeTestHeif(heif);
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

async function rejection(run: () => Promise<unknown>): Promise<string> {
  const err = await run().then(() => null, (e: unknown) => e);
  expect(err).toBeInstanceOf(Error);
  return err instanceof Error ? err.message : "";
}

function firstFrameOf(recipe: Recipe): Recipe["firstFrame"] {
  return recipe.firstFrame;
}

// ── --first-frame parsing ───────────────────────────────────────────────────

test("an absent --first-frame falls back to what the host asked for", () => {
  expect(resolveFirstFrameMode(undefined, "off")).toBe("off");
  expect(resolveFirstFrameMode(undefined, "black")).toBe("black");
});

test("--first-frame takes every mode the type allows", () => {
  expect(resolveFirstFrameMode("off", "black")).toBe("off");
  expect(resolveFirstFrameMode("black", "off")).toBe("black");
  expect(resolveFirstFrameMode("photo", "off")).toBe("photo");
});

test("--first-frame rejects a mode it does not know, naming what was asked for and what is allowed", () => {
  // Same reason as --format, --edges and --identity: an unrecognised mode
  // that reached the sampler would simply not be `photo` and the copy would
  // open on the footage, reported as success.
  const err = (() => {
    try {
      resolveFirstFrameMode("cover", "off");
      return null;
    } catch (e: unknown) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(Error);
  const message = err instanceof Error ? err.message : "";
  expect(message).toContain("cover");
  expect(message).toContain("off, black, photo");
});

test("a first-frame mode the route does not know is refused, never treated as off", async () => {
  // The Electron payload is not parsed on its way in, so a mode is whatever
  // string the renderer sent. `Object.assign` is how such a value reaches a
  // `StartOptions` without a cast: TypeScript intersects the two and keeps
  // the narrow type, exactly as it trusts the IPC bridge. Unchecked, "cover"
  // would fall through `mode !== "photo"` and ship as off, reported as done.
  const { backends, video } = fakeBackends();
  const route = routeForKind("video", backends);
  const hostile: StartOptions = Object.assign({ ...opts }, { firstFrame: "cover" });
  const message = await rejection(() =>
    uniquifyRoute(route, "SOURCE", hostile, 1, { seedBase: 1, nowMs: NOW, outputPath: () => "c.mp4" })
  );
  expect(message).toContain("cover");
  expect(message).toContain("off, black, photo");
  expect(video.rendered).toEqual([]);
});

// ── the modes that need no file ─────────────────────────────────────────────

test("a start payload without a first-frame mode renders video with it off", async () => {
  // The photo UI never sends it; a file that turns out to be footage must
  // reach the sampler with a definite mode rather than undefined.
  const { backends, video } = fakeBackends();
  const route = routeForKind("video", backends);
  await uniquifyRoute(route, "SOURCE", opts, 1, { seedBase: 1, nowMs: NOW, outputPath: () => "c.mp4" });
  expect(firstFrameOf(video.rendered[0])).toEqual({ mode: "off" });
});

test("a start payload asking for a black first frame passes the mode to the sampler", async () => {
  const { backends, video } = fakeBackends();
  const route = routeForKind("video", backends);
  await uniquifyRoute(route, "SOURCE", { ...opts, firstFrame: "black" }, 1, {
    seedBase: 1, nowMs: NOW, outputPath: () => "c.mp4",
  });
  expect(firstFrameOf(video.rendered[0])).toEqual({ mode: "black" });
});

test("off and black never touch the still backend", async () => {
  const { backends, photo } = fakeBackends();
  const route = routeForKind("video", backends);
  await uniquifyRoute(route, "SOURCE", { ...opts, firstFrame: "black", coverPath: still }, 1, {
    seedBase: 1, nowMs: NOW, outputPath: () => "c.mp4",
  });
  expect(photo.probed).toEqual([]);
  expect(photo.grayFramesOf).toEqual([]);
});

// ── the boundary ────────────────────────────────────────────────────────────

test("photo mode without a cover is refused before anything renders, saying what to pass", async () => {
  const { backends, video } = fakeBackends();
  const route = routeForKind("video", backends);
  const message = await rejection(() =>
    uniquifyRoute(route, "SOURCE", { ...opts, firstFrame: "photo", coverPath: null }, 1, {
      seedBase: 1, nowMs: NOW, outputPath: () => "c.mp4",
    })
  );
  expect(message).toContain("--cover");
  expect(message).toContain("photo");
  expect(video.rendered).toEqual([]);
});

test("photo mode with the cover field absent is refused the same way", async () => {
  const { backends } = fakeBackends();
  const route = routeForKind("video", backends);
  const message = await rejection(() =>
    uniquifyRoute(route, "SOURCE", { ...opts, firstFrame: "photo" }, 1, {
      seedBase: 1, nowMs: NOW, outputPath: () => "c.mp4",
    })
  );
  expect(message).toContain("--cover");
});

test("a cover that does not exist is refused, naming the path", async () => {
  const { backends, video } = fakeBackends();
  const route = routeForKind("video", backends);
  const missing = join(dir, "nope.jpg");
  const message = await rejection(() =>
    uniquifyRoute(route, "SOURCE", { ...opts, firstFrame: "photo", coverPath: missing }, 1, {
      seedBase: 1, nowMs: NOW, outputPath: () => "c.mp4",
    })
  );
  expect(message).toContain(missing);
  expect(message.toLowerCase()).toContain("cover");
  expect(video.rendered).toEqual([]);
});

test("a cover that is footage is refused: the first frame takes a still", async () => {
  const { backends, video } = fakeBackends();
  const route = routeForKind("video", backends);
  const message = await rejection(() =>
    uniquifyRoute(route, "SOURCE", { ...opts, firstFrame: "photo", coverPath: clip }, 1, {
      seedBase: 1, nowMs: NOW, outputPath: () => "c.mp4",
    })
  );
  expect(message).toContain(clip);
  expect(message.toLowerCase()).toContain("still");
  expect(video.rendered).toEqual([]);
});

test("a HEIC cover surfaces the convert-it advice, not a demuxer dump", async () => {
  const { backends } = fakeBackends();
  const route = routeForKind("video", backends);
  const message = await rejection(() =>
    uniquifyRoute(route, "SOURCE", { ...opts, firstFrame: "photo", coverPath: heif }, 1, {
      seedBase: 1, nowMs: NOW, outputPath: () => "c.mp4",
    })
  );
  expect(message).toContain("HEIC");
  expect(message).toContain("JPEG");
});

// ── the resolved cover ──────────────────────────────────────────────────────

test("a readable cover reaches the sampler resolved: its path, its probed size, its recipe from the copy's seed", async () => {
  const { backends, video } = fakeBackends();
  const route = routeForKind("video", backends);
  await uniquifyRoute(route, "SOURCE", { ...opts, firstFrame: "photo", coverPath: still }, 1, {
    seedBase: 7, nowMs: NOW, outputPath: () => "c.mp4",
  });
  // The fake's gray frame for a .jpg is busy at the edge, so `auto` crops.
  expect(firstFrameOf(video.rendered[0])).toEqual({
    mode: "photo",
    path: still,
    info: coverInfo,
    recipe: samplePhotoRecipe(
      {
        strength: 1.0,
        exportFormat: "original",
        allowMirror: false,
        targetDistance: 30,
        identity: "engine",
        edge: { mode: "crop" },
      },
      7,
      1
    ),
  });
});

test("the cover's size comes from the still backend's probe of the cover, not of the source", async () => {
  const { backends, photo, video } = fakeBackends();
  const route = routeForKind("video", backends);
  await uniquifyRoute(route, "SOURCE", { ...opts, firstFrame: "photo", coverPath: still }, 1, {
    seedBase: 1, nowMs: NOW, outputPath: () => "c.mp4",
  });
  expect(photo.probed).toEqual([still]);
  expect(video.probed).toEqual(["SOURCE"]);
});

test("the cover's edge is decided from the cover's own pixels", async () => {
  const { backends, photo } = fakeBackends();
  const route = routeForKind("video", backends);
  await uniquifyRoute(route, "SOURCE", { ...opts, firstFrame: "photo", coverPath: still }, 1, {
    seedBase: 1, nowMs: NOW, outputPath: () => "c.mp4",
  });
  expect(photo.grayFramesOf).toEqual([still]);
});

test("an explicit fit edge pads the cover with the colour measured off it", async () => {
  const { backends, photo, video } = fakeBackends();
  const route = routeForKind("video", backends);
  await uniquifyRoute(route, "SOURCE", { ...opts, edgeMode: "fit", firstFrame: "photo", coverPath: still }, 1, {
    seedBase: 1, nowMs: NOW, outputPath: () => "c.mp4",
  });
  expect(photo.edgeColorCalls).toBe(1);
  const ff = firstFrameOf(video.rendered[0]);
  if (ff.mode !== "photo") throw new Error(`first frame is ${ff.mode}`);
  expect(ff.recipe.ops.find((o) => o.id === "fitpad")?.params.padColor).toBe("0x102030");
});

test("the cover is resolved once for the batch, however many copies it produces", async () => {
  const { backends, photo, video } = fakeBackends();
  const route = routeForKind("video", backends);
  await uniquifyRoute(route, "SOURCE", { ...opts, edgeMode: "fit", firstFrame: "photo", coverPath: still }, 3, {
    seedBase: 1, nowMs: NOW, interThreshold: 0, outputPath: (i) => `c${i}.mp4`,
  });
  expect(video.rendered.length).toBe(3);
  expect(photo.probed).toEqual([still]);
  expect(photo.edgeColorCalls).toBe(1);
});

test("each copy of the batch opens on its own draw of the cover", async () => {
  const { backends, video } = fakeBackends();
  const route = routeForKind("video", backends);
  await uniquifyRoute(route, "SOURCE", { ...opts, firstFrame: "photo", coverPath: still }, 2, {
    seedBase: 1, nowMs: NOW, interThreshold: 0, outputPath: (i) => `c${i}.mp4`,
  });
  const [a, b] = video.rendered.map(firstFrameOf);
  if (a.mode !== "photo" || b.mode !== "photo") throw new Error("expected photo covers");
  expect(a.recipe).not.toEqual(b.recipe);
  expect(a.path).toBe(b.path);
});

test("the photo route ignores the first-frame fields, because a still has one frame", async () => {
  // Photo mode without a cover would be refused on the video route; on the
  // photo route there is no first frame to fill, so nothing is checked and
  // the recipe is the plain photo recipe.
  const { backends, photo } = fakeBackends();
  const route = routeForKind("photo", backends);
  const stillOpts: StartOptions = { ...opts, exportFormat: "original", edgeMode: "crop" };
  await uniquifyRoute(route, "SOURCE", { ...stillOpts, firstFrame: "photo", coverPath: null }, 1, {
    seedBase: 1, nowMs: NOW, outputPath: () => "s.jpg",
  });
  expect(photo.rendered[0]).toEqual(
    samplePhotoRecipe({ ...stillOpts, edge: { mode: "crop" } }, 1, 1)
  );
  expect("firstFrame" in photo.rendered[0]).toBe(false);
});

test("the video route carries the still backend, which is what reads the cover", () => {
  const { backends, photo } = fakeBackends();
  const route = routeForKind("video", backends);
  expect(route.kind).toBe("video");
  if (route.kind !== "video") return;
  expect(route.stills).toBe(photo);
});
