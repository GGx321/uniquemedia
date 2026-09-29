import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import type { Cell, Clip, Focus } from "../../shared/engine/montage";
import {
  cellMotionGeometry,
  cellReveal,
  clipMotionPlan,
  collageRects,
  FRAME_H,
  FRAME_W,
  msToFrames,
  type Size,
} from "../../shared/montage";
import { mulberry32, randInt } from "../../shared/montage/random.testkit";
import { randomSpec } from "../../shared/montage/specGen.testkit";
import { useNativeGlobals } from "../../testing/nativeGlobals";
import { assertSafeFilterGraph } from "./filterString";
import { buildPass1 } from "./pass1";
import { COLOUR_TAG_ARGS, FILTER_THREAD_ARGS, INTERMEDIATE_VIDEO_ARGS, PHOTO_COLOUR_CHAIN } from "./profile";
import { RenderGraphError, type PhotoRef, type PhotoResolver, type PhotoSource } from "./types";
import { zoompanFilter } from "./zoompan";
useNativeGlobals();

const CLIP_DIR = "/work/render-tmp/job-1";
const SEED = 7;

const sizes = new Map<string, Size>();
const resolver =
  (defaultSize: Size = { w: 720, h: 1280 }): PhotoResolver =>
  (ref: PhotoRef): PhotoSource | undefined => {
    const id = ref.source === "scene" ? ref.photoId : ref.mediaId;
    const size = sizes.get(id) ?? defaultSize;
    return { path: `/work/photos/${id}.jpg`, width: size.w, height: size.h };
  };

const scene = (photoId: string, focus: Focus | null = { x: 0.3, y: 0.6 }): Cell => ({ photo: { source: "scene", photoId }, focus });

function photoClip(clipId: string, durationMs: number, motion: "kenburns" | "pan" | "static", focus: Focus | null = { x: 0.3, y: 0.6 }): Clip {
  return { clipId, durationMs, transitionIn: "cut", kind: "photo", cell: scene(`photo-${clipId}`, focus), motion };
}

function collageClip(clipId: string, layout: "collage2" | "collage3" | "collage4", durationMs: number, motion: "kenburns" | "pan" | "static", stagger: boolean): Clip {
  const n = { collage2: 2, collage3: 3, collage4: 4 }[layout];
  return {
    clipId,
    durationMs,
    transitionIn: "cut",
    kind: "collage",
    layout,
    cells: Array.from({ length: n }, (_, k) => scene(`photo-${clipId}-${k}`, { x: 0.2 + 0.1 * k, y: 0.5 })),
    motion,
    stagger,
  };
}

function build(clips: Clip[], resolvePhoto: PhotoResolver = resolver()) {
  return buildPass1({ seed: SEED, clips, resolvePhoto, clipDir: CLIP_DIR });
}

function graphOf(argv: readonly string[]): string {
  const i = argv.indexOf("-filter_complex");
  const graph = argv[i + 1];
  if (i < 0 || graph === undefined) throw new Error("no -filter_complex in argv");
  return graph;
}

function inputsOf(argv: readonly string[]): string[] {
  return argv.flatMap((a, i) => (a === "-i" ? [argv[i + 1] ?? ""] : []));
}

function first<T>(items: readonly T[]): T {
  const item = items[0];
  if (item === undefined) throw new Error("expected at least one item");
  return item;
}

describe("buildPass1: jobs", () => {
  test("makes one job per clip, named clip-NN.mkv inside the job folder", () => {
    const jobs = build([photoClip("a", 2000, "static"), photoClip("b", 1000, "static"), photoClip("c", 500, "static")]);
    expect(jobs.map((j) => j.fileName)).toEqual(["clip-00.mkv", "clip-01.mkv", "clip-02.mkv"]);
    expect(jobs.map((j) => j.output)).toEqual(["clip-00.mkv", "clip-01.mkv", "clip-02.mkv"].map((n) => join(CLIP_DIR, n)));
    expect(jobs.map((j) => j.index)).toEqual([0, 1, 2]);
    expect(jobs.map((j) => j.clipId)).toEqual(["a", "b", "c"]);
  });

  test("records the frames each intermediate must hold: 3 per 100 ms", () => {
    const jobs = build([photoClip("a", 2000, "static"), photoClip("b", 500, "static"), photoClip("c", 15000, "static")]);
    expect(jobs.map((j) => j.frames)).toEqual([60, 15, 450]);
  });

  test("numbers 20 clips with two digits", () => {
    const jobs = build(Array.from({ length: 20 }, (_, i) => photoClip(`c${i}`, 500, "static")));
    expect(jobs[19]?.fileName).toBe("clip-19.mkv");
  });

  test("is pure: the same input gives the same argv", () => {
    const clips = [collageClip("a", "collage3", 2000, "kenburns", true)];
    expect(build(clips)).toEqual(build(clips));
  });

  test("refuses an empty clip list", () => {
    expect(() => build([])).toThrow(RenderGraphError);
  });
});

describe("buildPass1: argv", () => {
  const job = first(build([photoClip("a", 2000, "kenburns")]));

  test("starts quiet and non-interactive, and overwrites its own temp file", () => {
    expect(job.argv.slice(0, 3)).toEqual(["-hide_banner", "-nostdin", "-y"]);
  });

  test("caps the filter threads before the first input", () => {
    const at = job.argv.indexOf("-filter_threads");
    expect(job.argv.slice(at, at + 4)).toEqual([...FILTER_THREAD_ARGS]);
    expect(at).toBeLessThan(job.argv.indexOf("-i"));
  });

  test("encodes with the intermediate profile, tags included", () => {
    const at = job.argv.indexOf("-c:v");
    expect(job.argv.slice(at, at + INTERMEDIATE_VIDEO_ARGS.length)).toEqual([...INTERMEDIATE_VIDEO_ARGS]);
    const tagAt = job.argv.indexOf("-colorspace");
    expect(job.argv.slice(tagAt, tagAt + COLOUR_TAG_ARGS.length)).toEqual([...COLOUR_TAG_ARGS]);
  });

  test("always sets 30 fps constant frame rate", () => {
    expect(job.argv).toContain("-r");
    expect(job.argv[job.argv.indexOf("-r") + 1]).toBe("30");
    expect(job.argv[job.argv.indexOf("-fps_mode") + 1]).toBe("cfr");
  });

  test("maps the graph's one output and writes the intermediate last", () => {
    expect(job.argv[job.argv.indexOf("-map") + 1]).toBe("[v]");
    expect(job.argv.at(-1)).toBe(job.output);
  });

  test("gives ffmpeg the photo by absolute path with -i, not by name in the graph", () => {
    expect(inputsOf(job.argv)).toEqual(["/work/photos/photo-a.jpg"]);
  });

  test("never ends the output by frames, time or shortest (invariant 20)", () => {
    const jobs = build([photoClip("a", 2000, "kenburns"), collageClip("b", "collage4", 500, "pan", true), photoClip("c", 1000, "static")]);
    for (const j of jobs) {
      for (const bad of ["-frames:v", "-frames", "-t", "-to", "-shortest"]) expect(j.argv).not.toContain(bad);
    }
  });
});

describe("buildPass1: a photo clip", () => {
  const geo = cellMotionGeometry({ w: FRAME_W, h: FRAME_H }, { w: 720, h: 1280 }, { x: 0.3, y: 0.6 });

  test("converts colour first, then cuts the even cover-crop exactly, then upscales to the capped canvas", () => {
    const graph = graphOf(first(build([photoClip("a", 2000, "kenburns")])).argv);
    const convAt = graph.indexOf(PHOTO_COLOUR_CHAIN);
    const cropAt = graph.indexOf(`crop=${geo.crop.w}:${geo.crop.h}:${geo.crop.x}:${geo.crop.y}:exact=1`);
    const scaleAt = graph.indexOf(`scale=${geo.canvas.w}:${geo.canvas.h}:flags=lanczos`);
    expect(convAt).toBeGreaterThan(-1);
    expect(cropAt).toBeGreaterThan(convAt);
    expect(scaleAt).toBeGreaterThan(cropAt);
  });

  test("moves with the zoompan of the clip's own plan, from the same geometry", () => {
    const clip = photoClip("a", 2000, "kenburns");
    const plan = clipMotionPlan(SEED, clip.kind === "photo" ? clip : (() => { throw new Error("photo"); })());
    if (plan.kind === "static") throw new Error("kenburns is not static");
    const graph = graphOf(first(build([clip])).argv);
    expect(graph).toContain(zoompanFilter(plan, geo.canvas, geo.anchor, 60, { w: FRAME_W, h: FRAME_H }));
  });

  test("gives two clips with different ids the pan direction their own ids select", () => {
    const clips = Array.from({ length: 24 }, (_, i) => photoClip(`pan-clip-${i}`, 1000, "pan"));
    const graphs = build(clips).map((j) => graphOf(j.argv));
    const distinct = new Set(graphs.map((g) => /zoompan=z='[^']*':x='[^']*':y='[^']*'/.exec(g)?.[0]));
    expect(distinct.size).toBeGreaterThan(1);
  });

  test("ends the cell on one square-pixel output labelled v", () => {
    const graph = graphOf(first(build([photoClip("a", 2000, "kenburns")])).argv);
    expect(graph.endsWith("setsar=1[v]")).toBe(true);
  });

  test("a static photo is one scale to the frame and a still repeated with settb and setpts=N", () => {
    const graph = graphOf(first(build([photoClip("a", 2000, "static")])).argv);
    expect(graph).toContain(`scale=${FRAME_W}:${FRAME_H}:flags=lanczos,loop=loop=59:size=1,settb=1/30,setpts=N`);
    expect(graph).not.toContain("zoompan");
  });

  test("never uses setpts on the image demuxer's 1/25 time base", () => {
    for (const motion of ["static", "kenburns", "pan"] as const) {
      expect(graphOf(first(build([photoClip("a", 2000, motion)])).argv)).not.toContain("N/(30*TB)");
    }
  });

  test("tags the frames after the swscale conversion and never reaches for zscale", () => {
    const graph = graphOf(first(build([photoClip("a", 2000, "kenburns")])).argv);
    expect(graph.indexOf("setparams=")).toBeGreaterThan(graph.indexOf("scale=in_range=pc"));
    expect(graph).not.toContain("zscale");
  });

  test("a missing focus uses the geometry module's fallback, not a number of the builder's own", () => {
    const g = cellMotionGeometry({ w: FRAME_W, h: FRAME_H }, { w: 720, h: 1280 }, null);
    const graph = graphOf(first(build([photoClip("a", 2000, "static", null)])).argv);
    expect(graph).toContain(`crop=${g.crop.w}:${g.crop.h}:${g.crop.x}:${g.crop.y}:exact=1`);
  });

  test("a large own photo is scaled to the capped canvas, never to 4x its own size", () => {
    sizes.set("photo-big", { w: 4000, h: 6000 });
    const clip: Clip = { clipId: "big", durationMs: 1000, transitionIn: "cut", kind: "photo", cell: scene("photo-big", { x: 0.5, y: 0.4 }), motion: "kenburns" };
    const g = cellMotionGeometry({ w: FRAME_W, h: FRAME_H }, { w: 4000, h: 6000 }, { x: 0.5, y: 0.4 });
    const graph = graphOf(first(build([clip])).argv);
    expect(g.canvas.w).toBeLessThanOrEqual(2880);
    expect(graph).toContain(`scale=${g.canvas.w}:${g.canvas.h}:flags=lanczos`);
    sizes.delete("photo-big");
  });
});

describe("buildPass1: a collage clip", () => {
  test("lays a black base of the frame's size and the clip's length under the cells", () => {
    const graph = graphOf(first(build([collageClip("a", "collage3", 3100, "kenburns", true)])).argv);
    expect(graph).toContain(`color=c=black:s=${FRAME_W}x${FRAME_H}:r=30:d=3.1,format=yuv420p,`);
  });

  test.each(["collage2", "collage3", "collage4"] as const)("%s: overlays each cell at its rectangle, in reading order", (layout) => {
    const graph = graphOf(first(build([collageClip("a", layout, 2000, "static", false)])).argv);
    const rects = collageRects(layout);
    let prev = "bg";
    rects.forEach((r, k) => {
      expect(graph).toContain(`[${prev}][c${k}]overlay=x=${r.x}:y=${r.y}:format=yuv420[o${k}]`);
      prev = `o${k}`;
    });
    expect(graph.endsWith(`[${prev}]setsar=1[v]`)).toBe(true);
  });

  test.each(["collage2", "collage3", "collage4"] as const)("%s: takes one photo input per cell, in cell order", (layout) => {
    const job = first(build([collageClip("a", layout, 2000, "static", false)]));
    const n = collageRects(layout).length;
    expect(inputsOf(job.argv)).toEqual(Array.from({ length: n }, (_, k) => `/work/photos/photo-a-${k}.jpg`));
  });

  test.each(["collage2", "collage3", "collage4"] as const)("%s: sizes every cell's motion to its own rectangle", (layout) => {
    const clip = collageClip("a", layout, 2000, "kenburns", false);
    const graph = graphOf(first(build([clip])).argv);
    for (const r of collageRects(layout)) expect(graph).toContain(`:s=${r.w}x${r.h}:fps=30`);
  });

  test("never ends the overlay early: the black base sets the length, not eof_action=endall (SP1)", () => {
    for (const layout of ["collage2", "collage3", "collage4"] as const) {
      expect(graphOf(first(build([collageClip("a", layout, 2000, "kenburns", true)])).argv)).not.toContain("eof_action");
    }
  });

  test("with stagger, fades cell k in over one step from k steps, by frame numbers from the geometry module", () => {
    const graph = graphOf(first(build([collageClip("a", "collage4", 2000, "static", true)])).argv);
    for (let k = 0; k < 4; k++) {
      const r = cellReveal(k, 4, 2000, true);
      expect(graph).toContain(`[raw${k}]format=yuva420p,fade=t=in:s=${r.startFrame}:n=${r.frames}:alpha=1[c${k}]`);
    }
  });

  test("a 500 ms collage of four staggers with the clamped 3-frame step", () => {
    const graph = graphOf(first(build([collageClip("a", "collage4", 500, "static", true)])).argv);
    expect(graph).toContain("fade=t=in:s=9:n=3:alpha=1");
  });

  test("without stagger, adds no fade at all", () => {
    expect(graphOf(first(build([collageClip("a", "collage3", 2000, "kenburns", false)])).argv)).not.toContain("fade=");
  });

  test("keeps the same colour chain and crop for every cell as for a photo", () => {
    const graph = graphOf(first(build([collageClip("a", "collage2", 2000, "kenburns", false)])).argv);
    expect(graph.split(PHOTO_COLOUR_CHAIN).length - 1).toBe(2);
    const cellSizes = collageRects("collage2");
    cellSizes.forEach((r, k) => {
      const g = cellMotionGeometry({ w: r.w, h: r.h }, { w: 720, h: 1280 }, { x: 0.2 + 0.1 * k, y: 0.5 });
      expect(graph).toContain(`crop=${g.crop.w}:${g.crop.h}:${g.crop.x}:${g.crop.y}:exact=1`);
    });
  });

  test("a static collage repeats each still with settb and setpts=N", () => {
    const graph = graphOf(first(build([collageClip("a", "collage3", 2000, "static", false)])).argv);
    expect(graph.split("loop=loop=59:size=1,settb=1/30,setpts=N").length - 1).toBe(3);
  });
});

describe("buildPass1: refusals", () => {
  test("refuses an own video clip with a clear pointer to slice 3f", () => {
    const clip: Clip = { clipId: "v", durationMs: 2000, transitionIn: "cut", kind: "video", mediaId: "media-1", trimStartMs: 0, focus: null };
    try {
      build([clip]);
      throw new Error("expected a throw");
    } catch (e) {
      expect(e).toBeInstanceOf(RenderGraphError);
      expect(e instanceof RenderGraphError && e.code).toBe("VIDEO_CLIP_UNSUPPORTED");
      expect(String(e)).toContain("3f");
    }
  });

  test("refuses an empty cell", () => {
    const clip: Clip = { clipId: "a", durationMs: 2000, transitionIn: "cut", kind: "photo", cell: { photo: null, focus: null }, motion: "static" };
    expect(() => build([clip])).toThrow(expect.objectContaining({ code: "CELL_EMPTY" }));
  });

  test("refuses a photo the resolver does not know, naming the reference and not a path", () => {
    expect(() => build([photoClip("a", 2000, "static")], () => undefined)).toThrow(expect.objectContaining({ code: "PHOTO_UNRESOLVED" }));
  });

  test("refuses a relative photo path", () => {
    const relative: PhotoResolver = () => ({ path: "photos/a.jpg", width: 720, height: 1280 });
    expect(() => build([photoClip("a", 2000, "static")], relative)).toThrow(expect.objectContaining({ code: "PATH_NOT_ABSOLUTE" }));
  });

  test("refuses a relative job folder", () => {
    expect(() => buildPass1({ seed: SEED, clips: [photoClip("a", 2000, "static")], resolvePhoto: resolver(), clipDir: "render-tmp/job-1" })).toThrow(
      expect.objectContaining({ code: "PATH_NOT_ABSOLUTE" }),
    );
  });

  test("refuses a photo whose size is not whole positive pixels", () => {
    const bad: PhotoResolver = () => ({ path: "/work/a.jpg", width: 0, height: 1280 });
    expect(() => build([photoClip("a", 2000, "static")], bad)).toThrow(RangeError);
  });

  test("refuses a duration that is not a whole number of frames, rather than rounding it", () => {
    expect(() => build([photoClip("a", 2050, "static")])).toThrow(RangeError);
  });
});

describe("buildPass1: invariant 16, no text or path in -filter_complex", () => {
  const NASTY_PATHS = ["/tmp/we ird/na'me;rm -rf.jpg", "/tmp/[x]:y,z=1\\.jpg", "/tmp/$(id)`id`.jpg", "/tmp/%{localtime}.jpg", "/tmp/фото é.jpg"];

  test("keeps paths out of the graph and the graph inside the strict charset, for 200 random specs", () => {
    const rand = mulberry32(20260929);
    for (let i = 0; i < 200; i++) {
      const spec = randomSpec(rand);
      const clips = spec.clips.filter((c) => c.kind !== "video");
      if (clips.length === 0) continue;
      const paths = new Map<string, PhotoSource>();
      let n = 0;
      const resolvePhoto: PhotoResolver = (ref) => {
        const id = ref.source === "scene" ? ref.photoId : ref.mediaId;
        let found = paths.get(id);
        if (!found) {
          const path = NASTY_PATHS[n++ % NASTY_PATHS.length] ?? "/tmp/x.jpg";
          found = { path: `${path}.${id}.jpg`, width: randInt(rand, 2, 6000), height: randInt(rand, 2, 6000) };
          paths.set(id, found);
        }
        return found;
      };
      for (const job of buildPass1({ seed: spec.seed, clips, resolvePhoto, clipDir: CLIP_DIR })) {
        const graph = graphOf(job.argv);
        assertSafeFilterGraph(graph);
        for (const p of paths.values()) expect(graph).not.toContain(p.path);
        expect(graph).not.toContain(job.clipId);
        expect(graph).not.toContain(CLIP_DIR);
      }
    }
  });
});
