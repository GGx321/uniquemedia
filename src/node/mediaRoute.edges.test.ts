import { test, expect } from "bun:test";
import {
  resolveEdgeMode,
  routeForKind,
  uniquifyRoute,
  type Backends,
  type MediaBackend,
  type PhotoBackend,
} from "./mediaRoute";
import type { MediaInfo, Operation, Recipe, StartOptions } from "../core/types";
import type { PhotoRecipe } from "../core/photo/types";
import type { DeviceProfile } from "../core/deviceProfile";

/**
 * `auto` has to be answered before the sampler runs, because the sampler is a
 * pure function of numbers and never opens a file. These tests pin where that
 * answer comes from and what it costs: the decision reads the gray frame the
 * pipeline already extracts, and the padding colour — the one thing that needs
 * a second ffmpeg call — is only paid for when the answer is `fit`, and only
 * once for the whole batch however many copies it produces.
 */

const photoInfo: MediaInfo = {
  kind: "photo",
  durationSec: 0,
  width: 1080,
  height: 1920,
  hasAudio: false,
};

const videoInfo: MediaInfo = {
  kind: "video",
  durationSec: 5,
  width: 1080,
  height: 1920,
  hasAudio: true,
};

const NOW = 1_780_000_000_000;

/** A 64x64 gray frame whose outer band is one flat colour: padding it back
 *  would be invisible, so `auto` must choose to preserve the edge. */
function flatEdgedFrame(): Uint8Array {
  const g = new Uint8Array(64 * 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) {
      const outer = x < 3 || y < 3 || x >= 61 || y >= 61;
      g[y * 64 + x] = outer ? 0 : 60 + ((x * 11 + y * 7) % 150);
    }
  }
  return g;
}

/** A 64x64 gray frame whose outer band varies everywhere: a flat border would
 *  read as a border, so `auto` must keep cropping. */
function busyEdgedFrame(): Uint8Array {
  const g = new Uint8Array(64 * 64);
  for (let y = 0; y < 64; y++) {
    for (let x = 0; x < 64; x++) g[y * 64 + x] = 100 + (((x * 31 + y * 17) % 25) - 12);
  }
  return g;
}

class FakePhotoBackend implements PhotoBackend {
  rendered: PhotoRecipe[] = [];
  edgeColorCalls = 0;
  constructor(private readonly sourceFrame: Uint8Array) {}
  async probe(): Promise<MediaInfo> {
    return photoInfo;
  }
  async render(_i: string, _info: MediaInfo, recipe: PhotoRecipe): Promise<void> {
    this.rendered.push(recipe);
  }
  async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
    // The source answers with the frame under test; a rendered copy answers
    // with something far enough away that verification passes first time.
    if (input === "SOURCE") return Array.from({ length: count }, () => this.sourceFrame);
    const copy = new Uint8Array(64 * 64);
    for (let i = 0; i < copy.length; i++) copy[i] = (i * 37) % 256;
    return Array.from({ length: count }, () => copy);
  }
  async sampleEdgeColor(): Promise<string> {
    this.edgeColorCalls++;
    return "0x123456";
  }
  async extractThumbnail(): Promise<string> {
    return "data:image/jpeg;base64,";
  }
  async applyDeviceMetadata(_o: string, _p: DeviceProfile): Promise<void> {}
  cancel(): void {}
  async warmup(): Promise<void> {}
  async replace(): Promise<void> {}
  async discard(): Promise<void> {}
}

class FakeVideoBackend implements MediaBackend<Recipe> {
  rendered: Recipe[] = [];
  async probe(): Promise<MediaInfo> {
    return videoInfo;
  }
  async render(_i: string, _info: MediaInfo, recipe: Recipe): Promise<void> {
    this.rendered.push(recipe);
  }
  async extractGrayFrames(input: string, count: number): Promise<Uint8Array[]> {
    const f = new Uint8Array(64 * 64);
    if (input !== "SOURCE") for (let i = 0; i < f.length; i++) f[i] = (i * 37) % 256;
    return Array.from({ length: count }, () => f);
  }
  async extractThumbnail(): Promise<string> {
    return "data:image/jpeg;base64,";
  }
  cancel(): void {}
  async warmup(): Promise<void> {}
  async replace(): Promise<void> {}
  async discard(): Promise<void> {}
}

function backendsWith(frame: Uint8Array): { backends: Backends; photo: FakePhotoBackend; video: FakeVideoBackend } {
  const photo = new FakePhotoBackend(frame);
  const video = new FakeVideoBackend();
  return { backends: { video, photo }, photo, video };
}

const base: StartOptions = {
  strength: 1.0,
  exportFormat: "original",
  allowMirror: false,
  targetDistance: 20,
  identity: "engine",
  edgeMode: "auto",
};

const opFor = (recipe: PhotoRecipe, id: string): Operation | undefined =>
  recipe.ops.find((o) => o.id === id);

async function runPhoto(
  frame: Uint8Array,
  opts: StartOptions,
  count = 1
): Promise<FakePhotoBackend> {
  const { backends, photo } = backendsWith(frame);
  const route = routeForKind("photo", backends);
  await uniquifyRoute(route, "SOURCE", opts, count, {
    seedBase: 1,
    nowMs: NOW,
    interThreshold: 0,
    outputPath: (i) => `copy_${i + 1}.jpg`,
  });
  return photo;
}

test("auto preserves the edge when the frame's border is flat", () => {
  return runPhoto(flatEdgedFrame(), base).then((photo) => {
    expect(opFor(photo.rendered[0], "fitpad")).toBeDefined();
    expect(opFor(photo.rendered[0], "pancrop")).toBeUndefined();
  });
});

test("auto keeps cropping when the frame's border is busy", async () => {
  const photo = await runPhoto(busyEdgedFrame(), base);
  expect(opFor(photo.rendered[0], "pancrop")).toBeDefined();
  expect(opFor(photo.rendered[0], "fitpad")).toBeUndefined();
});

test("a padded copy is filled with the colour measured off the image", async () => {
  const photo = await runPhoto(flatEdgedFrame(), base);
  expect(opFor(photo.rendered[0], "fitpad")?.params.padColor).toBe("0x123456");
});

test("cropping costs no extra decode: the colour is never measured", async () => {
  // The pad colour is a second ffmpeg invocation. A run that is going to crop
  // has no use for it, and paying for it anyway would be a per-batch cost for
  // a value nothing reads.
  const photo = await runPhoto(busyEdgedFrame(), base);
  expect(photo.edgeColorCalls).toBe(0);
});

test("the padding colour is measured once for the batch, not once per copy", async () => {
  const photo = await runPhoto(flatEdgedFrame(), base, 5);
  expect(photo.rendered.length).toBeGreaterThanOrEqual(5);
  expect(photo.edgeColorCalls).toBe(1);
});

test("an explicit crop overrides a frame auto would have padded", async () => {
  const photo = await runPhoto(flatEdgedFrame(), { ...base, edgeMode: "crop" });
  expect(opFor(photo.rendered[0], "pancrop")).toBeDefined();
  expect(photo.edgeColorCalls).toBe(0);
});

test("an explicit fit overrides a frame auto would have cropped", async () => {
  const photo = await runPhoto(busyEdgedFrame(), { ...base, edgeMode: "fit" });
  expect(opFor(photo.rendered[0], "fitpad")?.params.padColor).toBe("0x123456");
});

test("the sampler is handed a decided mode, never `auto`", async () => {
  // Whatever the host asked for, exactly one of the two window ops reaches the
  // recipe. An `auto` that leaked through would have to be answered by a
  // sampler that has never seen the image.
  for (const edgeMode of ["auto", "crop", "fit"] as const) {
    for (const frame of [flatEdgedFrame(), busyEdgedFrame()]) {
      const photo = await runPhoto(frame, { ...base, edgeMode });
      const hasFit = opFor(photo.rendered[0], "fitpad") !== undefined;
      const hasCrop = opFor(photo.rendered[0], "pancrop") !== undefined;
      expect(hasFit !== hasCrop).toBe(true);
    }
  }
});

test("a video batch ignores the edge mode entirely", async () => {
  // `edgeMode` rides along on the shared options, but a clip is re-framed by
  // its export format and has no edge decision to make.
  const { backends, video } = backendsWith(flatEdgedFrame());
  const route = routeForKind("video", backends);
  await uniquifyRoute(route, "SOURCE", { ...base, edgeMode: "fit" }, 1, {
    seedBase: 1,
    nowMs: NOW,
    outputPath: (i) => `clip_${i + 1}.mp4`,
  });
  expect(video.rendered.length).toBe(1);
  expect(video.rendered[0].video.some((o) => o.id === "fitpad")).toBe(false);
});

test("an absent --edges falls back to what the host asked for", () => {
  expect(resolveEdgeMode(undefined, "auto")).toBe("auto");
  expect(resolveEdgeMode(undefined, "crop")).toBe("crop");
});

test("--edges takes every mode the type allows", () => {
  expect(resolveEdgeMode("crop", "auto")).toBe("crop");
  expect(resolveEdgeMode("fit", "auto")).toBe("fit");
  expect(resolveEdgeMode("auto", "crop")).toBe("auto");
});

test("--edges rejects a mode it does not know, naming what was asked for", () => {
  // Left unchecked, an unrecognised mode is simply not "fit" and the run
  // quietly crops — the exact damage the flag exists to prevent, reported as
  // success. Same reason --format is parsed rather than cast.
  const err = (() => {
    try {
      resolveEdgeMode("pad", "auto");
      return null;
    } catch (e: unknown) {
      return e;
    }
  })();
  expect(err).toBeInstanceOf(Error);
  expect(err instanceof Error ? err.message : "").toContain("pad");
});
