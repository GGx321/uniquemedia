import { test, expect, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBackends,
  outputName,
  resolveExportFormat,
  resolveIdentityMode,
  routeForInput,
  routeForKind,
  uniquifyRoute,
  type Backends,
  type MediaBackend,
  type PhotoBackend,
} from "./mediaRoute";
import { FfmpegExecutor } from "./ffmpegExecutor";
import { PhotoExecutor } from "./photoExecutor";
import { sampleRecipe } from "../core/sampler";
import { samplePhotoRecipe } from "../core/photo/sampler";
import { sampleDeviceProfile } from "../core/deviceProfile";
import { makeTestClip, makeTestHeif, makeTestPhoto } from "./testClip";
import type { IdentityMode, MediaInfo, Recipe, StartOptions } from "../core/types";
import type { PhotoRecipe } from "../core/photo/types";
import type { DeviceProfile } from "../core/deviceProfile";

const videoInfo: MediaInfo = {
  kind: "video",
  durationSec: 5,
  width: 1080,
  height: 1920,
  hasAudio: true,
};

const photoInfo: MediaInfo = {
  kind: "photo",
  durationSec: 0,
  width: 1440,
  height: 1080,
  hasAudio: false,
};

/** A fixed instant, so a batch's spoofed capture dates are reproducible.
 *  `RouteBatchConfig` requires it: a host with no clock is not a case worth
 *  supporting, and the one that omitted the field dated its output to 1969. */
const NOW = 1_780_000_000_000;

/** More set bytes => larger PDQ distance from an all-zero frame. */
function frameOfDistance(d: number): Uint8Array {
  const f = new Uint8Array(64 * 64);
  for (let i = 0; i < d * 30; i++) f[i] = 255;
  return f;
}

/** Records what the pipeline asked of it. Stands in for a real executor so the
 *  routing decision can be exercised without spawning ffmpeg. */
class FakeBackend<R> implements MediaBackend<R> {
  rendered: R[] = [];
  frameCounts: number[] = [];
  outputs: string[] = [];
  constructor(private readonly info: MediaInfo) {}
  async probe(): Promise<MediaInfo> {
    return this.info;
  }
  async render(_input: string, _info: MediaInfo, recipe: R, output: string): Promise<void> {
    this.rendered.push(recipe);
    this.outputs.push(output);
  }
  async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
    this.frameCounts.push(count);
    const frame = input === "SOURCE" ? new Uint8Array(64 * 64) : frameOfDistance(5);
    return Array.from({ length: count }, () => frame);
  }
  async extractThumbnail(): Promise<string> {
    return "data:image/jpeg;base64,";
  }
  /** Only the photo backend is ever asked for this; the video half of the union
   *  never reaches it. A single fake serves both, so it is answered here. */
  async sampleEdgeColor(): Promise<string> {
    return "0x000000";
  }
  async applyIdentity(output: string, identity: IdentityMode, profile: DeviceProfile): Promise<void> {
    this.metadataCalls.push({ output, identity, profile });
  }
  metadataCalls: Array<{ output: string; identity: IdentityMode; profile: DeviceProfile }> = [];
  cancel(): void {}
  async warmup(): Promise<void> {}
  async replace(): Promise<void> {}
  async discard(): Promise<void> {}
}

function fakeBackends(): { backends: Backends; video: FakeBackend<Recipe>; photo: FakeBackend<PhotoRecipe> & PhotoBackend } {
  const video = new FakeBackend<Recipe>(videoInfo);
  const photo = new FakeBackend<PhotoRecipe>(photoInfo);
  return { backends: { video, photo }, video, photo };
}

const opts: StartOptions = {
  strength: 1.0,
  exportFormat: "original",
  allowMirror: false,
  targetDistance: 30,
  identity: "engine",
  edgeMode: "crop",
};

test("routes a photo to the photo backend and the photo sampler", () => {
  const { backends, photo } = fakeBackends();
  const route = routeForKind("photo", backends);
  expect(route.kind).toBe("photo");
  expect(route.executor).toBe(photo);
  expect(route.sampleRecipe).toBe(samplePhotoRecipe);
});

test("a photo renders one frame per copy, because a still has one frame", () => {
  const { backends } = fakeBackends();
  expect(routeForKind("photo", backends).framesPerCopy).toBe(1);
});

test("routes a video to the video backend and the video sampler", () => {
  const { backends, video } = fakeBackends();
  const route = routeForKind("video", backends);
  expect(route.kind).toBe("video");
  expect(route.executor).toBe(video);
  expect(route.sampleRecipe).toBe(sampleRecipe);
});

test("a video keeps the four-frames-per-copy default", () => {
  const { backends } = fakeBackends();
  expect(routeForKind("video", backends).framesPerCopy).toBe(4);
});

test("a photo with no --format keeps the original framing", () => {
  // `reels` would crop a 1440x1080 still into a 1080x1920 column and throw half
  // the picture away. The PDQ distance goes UP when that happens, so the metric
  // reads it as a success — which is exactly why the default has to be per kind.
  const { backends } = fakeBackends();
  expect(resolveExportFormat(undefined, routeForKind("photo", backends))).toBe("original");
});

test("a video with no --format still gets reels, the shipped default", () => {
  const { backends } = fakeBackends();
  expect(resolveExportFormat(undefined, routeForKind("video", backends))).toBe("reels");
});

test("an explicit --format beats the photo default", () => {
  const { backends } = fakeBackends();
  expect(resolveExportFormat("reels", routeForKind("photo", backends))).toBe("reels");
});

test("an explicit --format beats the video default", () => {
  const { backends } = fakeBackends();
  expect(resolveExportFormat("square", routeForKind("video", backends))).toBe("square");
});

test("rejects a format it does not know, naming what was asked for", () => {
  // Left unchecked this reached EXPORT_DIMS as a missing key and destructured
  // undefined — a stack trace that says nothing about the flag that caused it.
  const { backends } = fakeBackends();
  const err = (() => {
    try {
      resolveExportFormat("portrait", routeForKind("photo", backends));
      return null;
    } catch (e: unknown) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(Error);
  expect(err instanceof Error ? err.message : "").toContain("portrait");
});

test("names a photo copy with a .jpg extension", () => {
  const { backends } = fakeBackends();
  expect(outputName("holiday", 0, routeForKind("photo", backends))).toBe("holiday_1.jpg");
});

test("names a video copy with an .mp4 extension", () => {
  const { backends } = fakeBackends();
  expect(outputName("holiday", 0, routeForKind("video", backends))).toBe("holiday_1.mp4");
});

test("the shipped backends are the real ffmpeg and photo executors", () => {
  const backends = createBackends();
  expect(backends.video).toBeInstanceOf(FfmpegExecutor);
  expect(backends.photo).toBeInstanceOf(PhotoExecutor);
});

test("uniquifyRoute asks a photo executor for exactly one frame per copy", async () => {
  const { backends, photo } = fakeBackends();
  const route = routeForKind("photo", backends);
  await uniquifyRoute(route, "SOURCE", opts, 1, {
    seedBase: 1,
    nowMs: NOW,
    outputPath: (i) => outputName("still", i, route),
  });
  expect(photo.frameCounts.every((c) => c === 1)).toBe(true);
});

test("uniquifyRoute hands the photo executor a photo recipe", async () => {
  const { backends, photo } = fakeBackends();
  const route = routeForKind("photo", backends);
  await uniquifyRoute(route, "SOURCE", opts, 1, {
    seedBase: 1,
    nowMs: NOW,
    outputPath: (i) => outputName("still", i, route),
  });
  expect(photo.rendered.length).toBe(1);
  // Built from the RESOLVED options: `edgeMode` is answered before the sampler
  // runs, and the recipe that reaches the executor is the one that answer made.
  expect(photo.rendered[0]).toEqual(samplePhotoRecipe({ ...opts, edge: { mode: "crop" } }, 1, 1));
  expect(photo.outputs[0]).toBe("still_1.jpg");
});

test("uniquifyRoute reports the verification result of every copy", async () => {
  const { backends } = fakeBackends();
  const route = routeForKind("photo", backends);
  const results = await uniquifyRoute(route, "SOURCE", opts, 2, {
    seedBase: 1,
    nowMs: NOW,
    interThreshold: 0,
    outputPath: (i) => outputName("still", i, route),
  });
  expect(results.map((r) => r.index)).toEqual([0, 1]);
  expect(results.every((r) => r.verify.passed)).toBe(true);
});

test("the host's clock is what dates the spoofed capture of every copy", async () => {
  // The link the Electron host was missing: a config that states the time, all
  // the way down to the EXIF that gets written. Pinned against the generator so
  // a batch stays reproducible from its seed and clock alone.
  const { backends, photo } = fakeBackends();
  const route = routeForKind("photo", backends);
  await uniquifyRoute(route, "SOURCE", { ...opts, identity: "iphone" }, 2, {
    seedBase: 7,
    nowMs: NOW,
    interThreshold: 0,
    outputPath: (i) => outputName("still", i, route),
  });
  expect(photo.metadataCalls.map((c) => c.output)).toEqual(["still_1.jpg", "still_2.jpg"]);
  expect(photo.metadataCalls.map((c) => c.identity)).toEqual(["iphone", "iphone"]);
  expect(photo.metadataCalls[0].profile).toEqual(sampleDeviceProfile(7, NOW));
  expect(photo.metadataCalls[1].profile).toEqual(sampleDeviceProfile(1007, NOW));
});

test("a start payload without the audio flag renders video with the audio dropped", async () => {
  // The renderer omits `keepTrendAudio` for a still. If the file turns out to be
  // footage after all, the flag must resolve to a definite `false` rather than
  // reach the sampler as undefined.
  const { backends, video } = fakeBackends();
  const route = routeForKind("video", backends);
  await uniquifyRoute(route, "SOURCE", opts, 1, {
    seedBase: 1,
    nowMs: NOW,
    outputPath: (i) => outputName("clip", i, route),
  });
  expect(video.rendered[0].keepTrendAudio).toBe(false);
});

test("a start payload carrying the audio flag passes it through to the video sampler", async () => {
  const { backends, video } = fakeBackends();
  const route = routeForKind("video", backends);
  await uniquifyRoute(route, "SOURCE", { ...opts, keepTrendAudio: true }, 1, {
    seedBase: 1,
    nowMs: NOW,
    outputPath: (i) => outputName("clip", i, route),
  });
  expect(video.rendered[0].keepTrendAudio).toBe(true);
});

test("a start payload without the black-first-frame flag renders video with it off", async () => {
  // Same shape as the audio flag: the photo UI never sends it, and a file that
  // turns out to be footage must reach the sampler with a definite `false`.
  const { backends, video } = fakeBackends();
  const route = routeForKind("video", backends);
  await uniquifyRoute(route, "SOURCE", opts, 1, {
    seedBase: 1,
    nowMs: NOW,
    outputPath: (i) => outputName("clip", i, route),
  });
  expect(video.rendered[0].blackFirstFrame).toBe(false);
});

test("a start payload carrying the black-first-frame flag passes it through to the video sampler", async () => {
  const { backends, video } = fakeBackends();
  const route = routeForKind("video", backends);
  await uniquifyRoute(route, "SOURCE", { ...opts, blackFirstFrame: true }, 1, {
    seedBase: 1,
    nowMs: NOW,
    outputPath: (i) => outputName("clip", i, route),
  });
  expect(video.rendered[0].blackFirstFrame).toBe(true);
});

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "uniq-route-"));
});
afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

test("routeForInput picks the photo route for a still on disk", async () => {
  const still = join(dir, "still.jpg");
  makeTestPhoto(still);
  const { backends, photo } = fakeBackends();
  const route = await routeForInput(still, backends);
  expect(route.kind).toBe("photo");
  expect(route.executor).toBe(photo);
});

test("routeForInput surfaces an unopenable format instead of choosing a route", async () => {
  // Guards the composition, not detectMediaKind: the HEIC message tells the
  // user to convert the file, and a route that swallowed it would leave the
  // dropzone silently doing nothing.
  const heif = join(dir, "shot.heic");
  makeTestHeif(heif);
  const { backends } = fakeBackends();
  const err = await routeForInput(heif, backends).then(
    () => null,
    (e: unknown) => e
  );
  expect(err).toBeInstanceOf(Error);
  expect(err instanceof Error ? err.message : "").toContain("HEIC");
});

test("routeForInput picks the video route for a clip on disk", async () => {
  const clip = join(dir, "clip.mp4");
  makeTestClip(clip);
  const { backends, video } = fakeBackends();
  const route = await routeForInput(clip, backends);
  expect(route.kind).toBe("video");
  expect(route.executor).toBe(video);
});

test("an absent --identity falls back to what the host asked for", () => {
  expect(resolveIdentityMode(undefined, "iphone")).toBe("iphone");
  expect(resolveIdentityMode(undefined, "engine")).toBe("engine");
});

test("--identity takes every mode the type allows", () => {
  expect(resolveIdentityMode("engine", "iphone")).toBe("engine");
  expect(resolveIdentityMode("iphone", "engine")).toBe("iphone");
  expect(resolveIdentityMode("clean", "iphone")).toBe("clean");
});

test("--identity rejects a mode it does not know, naming what was asked for and what is allowed", () => {
  // Same reason as --format and --edges: an unrecognised mode that reached
  // the graph would simply not be "iphone" and would ship as engine, with
  // the encoder's signature on it, reported as success.
  const err = (() => {
    try {
      resolveIdentityMode("apple", "iphone");
      return null;
    } catch (e: unknown) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(Error);
  const message = err instanceof Error ? err.message : "";
  expect(message).toContain("apple");
  expect(message).toContain("engine, iphone, clean");
});

test("uniquifyRoute hands the post-pass phase report through to the host", async () => {
  // Every fake copy carries the same frame, so the post-pass fires and the
  // host is told where it is: the Electron UI reads this to say what the batch
  // is still doing once every card is green.
  const { backends } = fakeBackends();
  const route = routeForKind("photo", backends);
  const phases: Array<[number, number]> = [];
  await uniquifyRoute(route, "SOURCE", opts, 2, {
    seedBase: 1,
    nowMs: NOW,
    outputPath: (i) => outputName("still", i, route),
    onPostPass: (done, total) => phases.push([done, total]),
  });
  // The fake never separates the two copies, so copy 1 is regenerated until
  // the cap of `count` rounds and the phase stops there: nothing settled
  // beyond the reference copy, and honestly so.
  expect(phases).toEqual([[0, 2], [1, 2]]);
});
