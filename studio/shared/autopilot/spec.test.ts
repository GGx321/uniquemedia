import { describe, expect, test } from "bun:test";
import { LAUNCH_MAX_VIDEO_MS, shapeSizeFits, type VideoShape } from "../engine/autopilot";
import { MontageSpec } from "../engine/montage";
import { reelsSafeZones, zonesHit } from "../montage/safeZones";
import { STICKER_MANIFEST } from "../stickers/manifest";
import { AUTOPILOT_MAX_TOTAL_MS, autopilotSpec, autopilotTotalMs, videoSeed, type AutopilotSpecInput, type AutopilotSpecOptions } from "./spec";

const AVATAR = "avatar-auto-0001";
const MUSIC = { source: "trending", trackId: "track-auto-0001", startMs: 1500 } as const;
const OFF: AutopilotSpecOptions = { stickers: false, previousStickerId: null, captionSource: null };
const ON: AutopilotSpecOptions = { stickers: true, previousStickerId: null, captionSource: null };

const photoIds = (n: number): string[] => Array.from({ length: n }, (_, i) => `photo-auto-${String(i + 1).padStart(3, "0")}`);

/** Every (shape, size) the generator accepts. */
const SHAPES: readonly { readonly shape: VideoShape; readonly size: number }[] = [
  { shape: "single", size: 1 },
  { shape: "collage", size: 2 },
  { shape: "collage", size: 3 },
  { shape: "collage", size: 4 },
  { shape: "slides", size: 5 },
  { shape: "slides", size: 6 },
  { shape: "slides", size: 7 },
];

const inputOf = (shape: VideoShape, size: number, seed: number, options: AutopilotSpecOptions = OFF): AutopilotSpecInput => ({
  avatarId: AVATAR,
  shape,
  photoIds: photoIds(size),
  seed,
  music: MUSIC,
  options,
});

const totalOf = (spec: MontageSpec): number => spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0);

/** Seeds spread over the whole uint32 range, deterministic, with both ends included. */
const SEED_COUNT = 10_000;
const seedAt = (i: number): number => (i === 0 ? 0 : i === 1 ? 4_294_967_295 : Math.imul(i, 2_654_435_761) >>> 0);

describe("A8: every autopilot spec is at most 10 s and valid", () => {
  test("the generator's limit is the contract's launch limit", () => {
    expect(AUTOPILOT_MAX_TOTAL_MS).toBe(LAUNCH_MAX_VIDEO_MS);
    expect(AUTOPILOT_MAX_TOTAL_MS).toBe(10_000);
  });

  test(`holds over every shape and ${SEED_COUNT} seeds: at most 10 000 ms, and a valid MontageSpec`, () => {
    let checked = 0;
    for (let i = 0; i < SEED_COUNT; i++) {
      const seed = seedAt(i);
      for (const { shape, size } of SHAPES) {
        const spec = autopilotSpec(inputOf(shape, size, seed, i % 2 === 0 ? ON : OFF));
        const total = totalOf(spec);
        if (total > 10_000) throw new Error(`${shape}/${size} seed ${seed}: ${total} ms`);
        if (!MontageSpec.safeParse(spec).success) throw new Error(`${shape}/${size} seed ${seed}: not a valid MontageSpec`);
        checked++;
      }
    }
    expect(checked).toBe(SEED_COUNT * SHAPES.length);
  });

  test("a video of exactly 10 000 ms exists for a single and for a collage, and is accepted", () => {
    for (const { shape, size } of [SHAPES[0], SHAPES[1]]) {
      if (shape === undefined || size === undefined) throw new Error("shape table");
      const seed = Array.from({ length: SEED_COUNT }, (_, i) => seedAt(i)).find((s) => autopilotTotalMs(shape, size, s) === 10_000);
      expect(seed).toBeDefined();
      const spec = autopilotSpec(inputOf(shape, size, seed ?? 0));
      expect(totalOf(spec)).toBe(10_000);
      expect(MontageSpec.safeParse(spec).success).toBe(true);
    }
  });

  test("autopilotTotalMs is the spec's total, for every shape and many seeds", () => {
    for (let i = 0; i < 500; i++) {
      for (const { shape, size } of SHAPES) expect(totalOf(autopilotSpec(inputOf(shape, size, seedAt(i))))).toBe(autopilotTotalMs(shape, size, seedAt(i)));
    }
  });
});

describe("durations by shape (plan §6.1)", () => {
  const totals = (shape: VideoShape, size: number): number[] => Array.from({ length: 2000 }, (_, i) => autopilotTotalMs(shape, size, seedAt(i)));

  test("a single lasts 6.0 to 10.0 s in 0.5 s steps, and the seed uses the whole range", () => {
    const all = totals("single", 1);
    expect(all.every((ms) => ms >= 6_000 && ms <= 10_000 && ms % 500 === 0)).toBe(true);
    expect(new Set(all)).toEqual(new Set([6000, 6500, 7000, 7500, 8000, 8500, 9000, 9500, 10000]));
  });

  test.each([2, 3, 4])("a collage of %i lasts 7.0 to 10.0 s in 0.5 s steps, and the seed uses the whole range", (size) => {
    const all = totals("collage", size);
    expect(all.every((ms) => ms >= 7_000 && ms <= 10_000 && ms % 500 === 0)).toBe(true);
    expect(new Set(all)).toEqual(new Set([7000, 7500, 8000, 8500, 9000, 9500, 10000]));
  });

  test.each([5, 6, 7])("slides of %i give each photo 1.2 to 1.4 s (the whole video clamped to 4 to 10 s)", (size) => {
    for (let i = 0; i < 500; i++) {
      const spec = autopilotSpec(inputOf("slides", size, seedAt(i)));
      expect(spec.clips).toHaveLength(size);
      for (const clip of spec.clips) expect(clip.durationMs >= 1_200 && clip.durationMs <= 1_400).toBe(true);
      expect(totalOf(spec)).toBeGreaterThanOrEqual(4_000);
    }
  });

  test("every duration is on the 100 ms grid", () => {
    for (let i = 0; i < 300; i++) for (const { shape, size } of SHAPES) for (const clip of autopilotSpec(inputOf(shape, size, seedAt(i))).clips) expect(clip.durationMs % 100).toBe(0);
  });
});

describe("clips", () => {
  test("a single is one photo clip with the photo, no focus yet", () => {
    const spec = autopilotSpec(inputOf("single", 1, 11));
    expect(spec.clips).toHaveLength(1);
    expect(spec.clips[0]).toMatchObject({ kind: "photo", cell: { photo: { source: "scene", photoId: "photo-auto-001" }, focus: null } });
  });

  test.each([2, 3, 4])("a collage of %i is one collage clip, staggered, cells in the photos' order", (size) => {
    const spec = autopilotSpec(inputOf("collage", size, 11));
    expect(spec.clips).toHaveLength(1);
    const clip = spec.clips[0];
    expect(clip).toMatchObject({ kind: "collage", layout: `collage${size}`, stagger: true, motion: "kenburns" });
    if (clip?.kind !== "collage") throw new Error("collage expected");
    expect(clip.cells.map((c) => (c.photo?.source === "scene" ? c.photo.photoId : null))).toEqual(photoIds(size));
    expect(clip.cells.every((c) => c.focus === null)).toBe(true);
  });

  test.each([5, 6, 7])("slides of %i are %i photo clips in the photos' order", (size) => {
    const spec = autopilotSpec(inputOf("slides", size, 11));
    expect(spec.clips.map((c) => (c.kind === "photo" && c.cell.photo?.source === "scene" ? c.cell.photo.photoId : null))).toEqual(photoIds(size));
    expect(spec.clips.every((c) => c.kind === "photo" && c.cell.focus === null)).toBe(true);
  });

  test("the spec's own seed is the video's seed, and the avatar is the avatar", () => {
    const spec = autopilotSpec(inputOf("single", 1, 4321));
    expect(spec.seed).toBe(4321);
    expect(spec.avatarId).toBe(AVATAR);
    expect(spec.schemaVersion).toBe(1);
  });

  test("a single uses Ken Burns mostly and pan sometimes, by seed", () => {
    const motions = Array.from({ length: 2000 }, (_, i) => autopilotSpec(inputOf("single", 1, seedAt(i))).clips[0]).map((c) => (c?.kind === "photo" ? c.motion : "?"));
    const kenburns = motions.filter((m) => m === "kenburns").length;
    const pan = motions.filter((m) => m === "pan").length;
    expect(kenburns + pan).toBe(2000);
    expect(kenburns).toBeGreaterThan(pan);
    expect(pan).toBeGreaterThan(100);
  });

  test("a collage always uses Ken Burns", () => {
    for (let i = 0; i < 500; i++) expect(autopilotSpec(inputOf("collage", 3, seedAt(i))).clips[0]).toMatchObject({ motion: "kenburns" });
  });

  test("slides pick their motion per clip: one video can mix Ken Burns and pan", () => {
    const mixed = Array.from({ length: 500 }, (_, i) => autopilotSpec(inputOf("slides", 7, seedAt(i)))).some((spec) => new Set(spec.clips.map((c) => (c.kind === "photo" ? c.motion : "?"))).size > 1);
    expect(mixed).toBe(true);
  });

  test("the seed changes the video: many seeds give many different specs", () => {
    const distinct = new Set(Array.from({ length: 300 }, (_, i) => JSON.stringify(autopilotSpec(inputOf("slides", 6, seedAt(i))))));
    expect(distinct.size).toBeGreaterThan(250);
  });
});

describe("same input, same spec", () => {
  test.each([...SHAPES])("$shape of $size is identical on every call", ({ shape, size }) => {
    const first = autopilotSpec(inputOf(shape, size, 987_654, ON));
    for (let i = 0; i < 5; i++) expect(autopilotSpec(inputOf(shape, size, 987_654, ON))).toEqual(first);
  });

  test("the generator does not change its input", () => {
    const input = inputOf("slides", 6, 77, ON);
    const before = JSON.stringify(input);
    autopilotSpec(input);
    expect(JSON.stringify(input)).toBe(before);
  });
});

describe("music", () => {
  test("a trending track is carried into the spec as given", () => {
    expect(autopilotSpec(inputOf("single", 1, 5)).music).toEqual({ source: "trending", trackId: "track-auto-0001", startMs: 1500 });
  });

  test("an own track is carried into the spec as given", () => {
    const input = { ...inputOf("single", 1, 5), music: { source: "own", mediaId: "media-auto-0001", startMs: 0 } } as const;
    expect(autopilotSpec(input).music).toEqual({ source: "own", mediaId: "media-auto-0001", startMs: 0 });
  });

  test("a spec is never silent", () => {
    for (let i = 0; i < 200; i++) for (const { shape, size } of SHAPES) expect(autopilotSpec(inputOf(shape, size, seedAt(i))).music).not.toBeNull();
  });
});

describe("A9: no text layer, ever", () => {
  test("with stickers off a spec has no layers at all", () => {
    for (let i = 0; i < 300; i++) for (const { shape, size } of SHAPES) expect(autopilotSpec(inputOf(shape, size, seedAt(i), OFF)).layers).toEqual([]);
  });

  test("with stickers on, over every shape and many seeds, no layer is text", () => {
    for (let i = 0; i < 1000; i++) {
      for (const { shape, size } of SHAPES) {
        const spec = autopilotSpec(inputOf(shape, size, seedAt(i), ON));
        if (spec.layers.some((layer) => layer.kind === "text")) throw new Error(`text layer at seed ${seedAt(i)}`);
      }
    }
  });
});

describe("A9: stickers follow the launch toggle", () => {
  const stickerOf = (spec: MontageSpec) => {
    const layer = spec.layers[0];
    if (layer?.kind !== "sticker") throw new Error("a sticker layer expected");
    return layer;
  };

  test("on gives exactly one built-in sticker layer that spans the whole video", () => {
    const spec = autopilotSpec(inputOf("slides", 6, 31, ON));
    expect(spec.layers).toHaveLength(1);
    const layer = stickerOf(spec);
    expect(layer.sticker.source).toBe("builtin");
    expect(layer.startMs).toBe(0);
    expect(layer.endMs).toBe(totalOf(spec));
  });

  test("the sticker is one of the built-in set, never an own one, over many seeds", () => {
    const ids = new Set(STICKER_MANIFEST.map((s) => s.id));
    for (let i = 0; i < 1000; i++) {
      const sticker = stickerOf(autopilotSpec(inputOf("single", 1, seedAt(i), ON))).sticker;
      expect(sticker.source === "builtin" && ids.has(sticker.stickerId)).toBe(true);
    }
  });

  test("the sticker is never the avatar's previous one", () => {
    for (const previous of STICKER_MANIFEST.map((s) => s.id)) {
      for (let i = 0; i < 300; i++) {
        const sticker = stickerOf(autopilotSpec(inputOf("collage", 2, seedAt(i), { ...ON, previousStickerId: previous }))).sticker;
        if (sticker.source === "builtin" && sticker.stickerId === previous) throw new Error(`repeated ${previous} at seed ${seedAt(i)}`);
      }
    }
  });

  test("the seed varies the sticker: more than half of the set shows up", () => {
    const seen = new Set(Array.from({ length: 1000 }, (_, i) => stickerOf(autopilotSpec(inputOf("single", 1, seedAt(i), ON))).sticker).map((s) => (s.source === "builtin" ? s.stickerId : "own")));
    expect(seen.size).toBeGreaterThan(STICKER_MANIFEST.length / 2);
  });

  test("an unknown previous sticker id changes nothing", () => {
    expect(autopilotSpec(inputOf("single", 1, 9, { ...ON, previousStickerId: "no-such-sticker" }))).toEqual(autopilotSpec(inputOf("single", 1, 9, ON)));
  });

  test("the size is 0.18 to 0.24 and the sticker sits on one of four anchors clear of the Reels zones", () => {
    const anchors = new Set<string>();
    for (let i = 0; i < 1000; i++) {
      const layer = stickerOf(autopilotSpec(inputOf("single", 1, seedAt(i), ON)));
      expect(layer.size).toBeGreaterThanOrEqual(0.18);
      expect(layer.size).toBeLessThanOrEqual(0.24);
      anchors.add(`${layer.x}/${layer.y}`);
      // the box in frame pixels (1080 x 1920); the sticker is square
      const w = layer.size * 1080;
      const box = { x: layer.x * 1080 - w / 2, y: layer.y * 1920 - w / 2, w, h: w };
      expect(zonesHit(box, reelsSafeZones())).toEqual([]);
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(1080);
    }
    expect(anchors.size).toBe(4);
  });
});

describe("what the generator refuses (RangeError)", () => {
  test.each([
    ["a single with two photos", "single", 2],
    ["a single with no photos", "single", 0],
    ["a collage with one photo", "collage", 1],
    ["a collage with five photos", "collage", 5],
    ["slides with four photos", "slides", 4],
    ["slides with eight photos", "slides", 8],
  ] as const)("%s", (_name, shape, size) => {
    expect(shapeSizeFits(shape, size)).toBe(false);
    expect(() => autopilotSpec(inputOf(shape, size, 1))).toThrow(RangeError);
  });

  test("a photo used twice", () => {
    expect(() => autopilotSpec({ ...inputOf("collage", 2, 1), photoIds: ["photo-auto-001", "photo-auto-001"] })).toThrow(RangeError);
  });

  test.each([-1, 1.5, 4_294_967_296, Number.NaN])("a seed that is not a uint32 (%p)", (seed) => {
    expect(() => autopilotSpec(inputOf("single", 1, seed))).toThrow(RangeError);
    expect(() => autopilotTotalMs("single", 1, seed)).toThrow(RangeError);
  });

  test("autopilotTotalMs refuses a size the shape does not have", () => {
    expect(() => autopilotTotalMs("slides", 8, 1)).toThrow(RangeError);
  });

  test("the boundary sizes are accepted: 1, 2, 4, 5 and 7", () => {
    for (const [shape, size] of [["single", 1], ["collage", 2], ["collage", 4], ["slides", 5], ["slides", 7]] as const) expect(() => autopilotSpec(inputOf(shape, size, 1))).not.toThrow();
  });
});

describe("videoSeed", () => {
  test("is a uint32, and the same for the same arguments", () => {
    const seed = videoSeed(12345, AVATAR, "1-3");
    expect(Number.isInteger(seed) && seed >= 0 && seed <= 4_294_967_295).toBe(true);
    expect(videoSeed(12345, AVATAR, "1-3")).toBe(seed);
  });

  test("changes with the plan seed, the avatar and the video key", () => {
    const base = videoSeed(12345, AVATAR, "1-3");
    expect(videoSeed(12346, AVATAR, "1-3")).not.toBe(base);
    expect(videoSeed(12345, "avatar-auto-0002", "1-3")).not.toBe(base);
    expect(videoSeed(12345, AVATAR, "1-4")).not.toBe(base);
  });

  test("does not confuse a shifted boundary between the avatar and the key", () => {
    expect(videoSeed(1, "avatar-aaaa-0001", "1-2")).not.toBe(videoSeed(1, "avatar-aaaa-00011", "-2"));
  });

  test("refuses a plan seed that is not a uint32", () => {
    expect(() => videoSeed(-1, AVATAR, "1-1")).toThrow(RangeError);
    expect(() => videoSeed(4_294_967_296, AVATAR, "1-1")).toThrow(RangeError);
  });
});
