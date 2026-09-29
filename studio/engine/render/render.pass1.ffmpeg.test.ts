import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Clip } from "../../shared/engine/montage";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { probeVideo, type Probed } from "./ffmpeg.testkit";
import { buildPass1 } from "./pass1";
import { makeWorkDir, removeDir, runPass1 } from "./render.testkit";
import type { PhotoResolver } from "./types";
useNativeGlobals();

// REAL ffmpeg (the bundled build), pass 1 only: every clip kind renders to an
// intermediate with exactly the frames the spec asks for. SLOW: it renders
// nine 0.5 to 2 s clips (S14: clips of at most 2 s) at 1080x1920 (about 15 s in all).

const FIXTURES = join(import.meta.dir, "../face/fixtures/images");
const PHOTO_FILES = ["render-best-home-1.jpg", "render-median-travel-2.jpg", "render-worst-fitness-3.jpg", "master.jpg"].map((n) => join(FIXTURES, n));

// The four fixtures are 720x1280 JPEGs (master.jpg is another size, checked below by the probe of the render itself).
const resolvePhoto: PhotoResolver = (ref) => {
  const id = ref.source === "scene" ? ref.photoId : ref.mediaId;
  const n = Number(id.split("-").at(-1)) % 3;
  return { path: PHOTO_FILES[n] ?? PHOTO_FILES[0] ?? "", width: 720, height: 1280 };
};

const scene = (id: string) => ({ photo: { source: "scene" as const, photoId: id }, focus: { x: 0.4, y: 0.35 } });
const collage = (clipId: string, layout: "collage2" | "collage3" | "collage4", durationMs: number, motion: "kenburns" | "pan" | "static", stagger: boolean): Clip => ({
  clipId,
  durationMs,
  transitionIn: "cut",
  kind: "collage",
  layout,
  cells: Array.from({ length: { collage2: 2, collage3: 3, collage4: 4 }[layout] }, (_, k) => scene(`p-${k}`)),
  motion,
  stagger,
});
const photo = (clipId: string, durationMs: number, motion: "kenburns" | "pan" | "static"): Clip => ({ clipId, durationMs, transitionIn: "cut", kind: "photo", cell: scene("p-1"), motion });

const CASES: Array<{ name: string; clip: Clip; frames: number }> = [
  { name: "photo, Ken Burns", clip: photo("photo-kb", 2000, "kenburns"), frames: 60 },
  { name: "photo, pan", clip: photo("photo-pan", 2000, "pan"), frames: 60 },
  { name: "photo, static", clip: photo("photo-static", 2000, "static"), frames: 60 },
  { name: "collage 2, Ken Burns, staggered", clip: collage("c2", "collage2", 2000, "kenburns", true), frames: 60 },
  { name: "collage 3, Ken Burns, staggered", clip: collage("c3", "collage3", 2000, "kenburns", true), frames: 60 },
  { name: "collage 4, Ken Burns, staggered", clip: collage("c4", "collage4", 2000, "kenburns", true), frames: 60 },
  { name: "collage 4, pan, not staggered", clip: collage("c4-pan", "collage4", 2000, "pan", false), frames: 60 },
  { name: "collage 4, static, staggered", clip: collage("c4-static", "collage4", 2000, "static", true), frames: 60 },
  { name: "the shortest collage 4, 500 ms, staggered", clip: collage("c4-short", "collage4", 500, "kenburns", true), frames: 15 },
];

let dir: string;
const probes = new Map<string, Probed>();
const counts = new Map<string, number>();

beforeAll(async () => {
  dir = makeWorkDir("pass1");
  const jobs = buildPass1({ seed: 5, clips: CASES.map((c) => c.clip), resolvePhoto, clipDir: dir });
  await runPass1(jobs);
  for (const [i, job] of jobs.entries()) {
    const name = CASES[i]?.name ?? "";
    const p = await probeVideo(job.output);
    probes.set(name, p);
    counts.set(name, Number(p.streams.find((s) => s.codec_type === "video")?.nb_read_frames));
  }
}, 180_000);

afterAll(() => removeDir(dir));

const videoOf = (name: string) => probes.get(name)?.streams.find((s) => s.codec_type === "video");

describe("pass 1 on real ffmpeg: exact frame counts", () => {
  test.each(CASES)("$name: holds exactly the frames its duration asks for", ({ name, frames }) => {
    expect(counts.get(name)).toBe(frames);
  });
});

describe("pass 1 on real ffmpeg: the intermediate's format", () => {
  test.each(CASES)("$name: is 1080x1920 at a constant 30 fps in yuv420p", ({ name }) => {
    const v = videoOf(name);
    expect({ w: v?.width, h: v?.height, fps: v?.r_frame_rate, avg: v?.avg_frame_rate, pix: v?.pix_fmt }).toEqual({ w: 1080, h: 1920, fps: "30/1", avg: "30/1", pix: "yuv420p" });
  });

  test.each(CASES)("$name: is tagged BT.709 limited range", ({ name }) => {
    const v = videoOf(name);
    expect({ range: v?.color_range, space: v?.color_space, trc: v?.color_transfer, prim: v?.color_primaries }).toEqual({ range: "tv", space: "bt709", trc: "bt709", prim: "bt709" });
  });
});
