import { describe, expect, test } from "bun:test";
import { COLLAGE_CELL_COUNT, MontageSpec } from "../shared/engine";
import { videoKindOf } from "../engine/videos/service";
import { LAYERED_SPEC, MIXED_SPEC, PAIRWISE_SPECS, SMOKE_PHOTOS_NEEDED, smokeSpec, type SmokeSpecPlan } from "./renderSmokeSpecs";
import { montageIssues } from "../shared/engine/montage";
import { notYetSupportedIssues } from "../shared/montage/notYetSupported";
import { stickerIssues } from "../shared/stickers/stickerIssues";
import { useNativeGlobals } from "../testing/nativeGlobals";
useNativeGlobals();

// The packaged E2E's render specs (plan 3a.9): five pairwise 4 s specs that between them cover every clip kind Studio can
// render today, every collage size and every motion, and one mixed 15 s timeline. They are data only; the smoke feeds them
// to `videos.render`.

const ALL = [...PAIRWISE_SPECS, MIXED_SPEC, LAYERED_SPEC];
const photoIds = (plan: SmokeSpecPlan): string[] => Array.from({ length: plan.photoCount }, (_, i) => `photo-${plan.name}-${i}`);
const specOf = (plan: SmokeSpecPlan) => smokeSpec(plan, "avatar-0001", photoIds(plan));

describe("the pairwise specs", () => {
  test("there are five, each exactly 4 s of one clip", () => {
    expect(PAIRWISE_SPECS).toHaveLength(5);
    for (const plan of PAIRWISE_SPECS) {
      const spec = specOf(plan);
      expect(spec.clips).toHaveLength(1);
      expect(spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0)).toBe(4_000);
    }
  });

  test("cover a photo clip and every collage size", () => {
    const shapes: string[] = ALL.flatMap((plan) => specOf(plan).clips.map((clip) => (clip.kind === "collage" ? clip.layout : clip.kind)));
    for (const wanted of ["photo", "collage2", "collage3", "collage4"]) expect(shapes).toContain(wanted);
  });

  test("cover every motion, in the 4 s specs alone", () => {
    const motions = new Set(PAIRWISE_SPECS.flatMap((plan) => specOf(plan).clips.map((clip) => (clip.kind === "video" ? "static" : clip.motion))));
    expect([...motions].sort()).toEqual(["kenburns", "pan", "static"]);
  });

  test("give each spec a file-name kind of its own, so the exported names tell them apart", () => {
    const kinds = PAIRWISE_SPECS.map((plan) => videoKindOf(specOf(plan).clips));
    expect(kinds).toEqual(["photo", "photo", "collage2", "collage3", "collage4"]);
  });
});

describe("the mixed timeline", () => {
  test("is 15 s, the longest a montage may be, of several kinds of clip", () => {
    const spec = specOf(MIXED_SPEC);
    expect(spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0)).toBe(15_000);
    expect(new Set(spec.clips.map((clip) => clip.kind)).size).toBeGreaterThan(1);
    expect(videoKindOf(spec.clips)).toBe("mix");
  });

  test("uses a collage of every size and every motion", () => {
    const clips = specOf(MIXED_SPEC).clips;
    const layouts = clips.flatMap((clip) => (clip.kind === "collage" ? [clip.layout] : []));
    expect(layouts.sort()).toEqual(["collage2", "collage3", "collage4"]);
    expect(new Set(clips.map((clip) => (clip.kind === "video" ? "static" : clip.motion)))).toEqual(new Set(["kenburns", "pan", "static"]));
  });
});

describe("every spec", () => {
  test("is a complete montage the contract accepts, with the engine's own structural rules", () => {
    for (const plan of ALL) expect(() => MontageSpec.parse(specOf(plan))).not.toThrow();
  });

  test("has as many photos as it asks for, each clip's cells matching its layout", () => {
    for (const plan of ALL) {
      const cells = specOf(plan).clips.reduce((sum, clip) => sum + (clip.kind === "photo" ? 1 : clip.kind === "collage" ? COLLAGE_CELL_COUNT[clip.layout] : 0), 0);
      expect(cells).toBe(plan.photoCount);
    }
  });

  test("names its photos explicitly with a focus point, so no render waits on the face gate", () => {
    for (const plan of ALL) {
      for (const clip of specOf(plan).clips) {
        const cells = clip.kind === "photo" ? [clip.cell] : clip.kind === "collage" ? clip.cells : [];
        for (const cell of cells) expect(cell.focus).not.toBeNull();
      }
    }
  });

  test("never asks for music or an own video, which the engine refuses as not yet supported", () => {
    for (const plan of ALL) {
      const spec = specOf(plan);
      expect(spec.music).toBeNull();
      expect(spec.clips.some((clip) => clip.kind === "video")).toBe(false);
    }
  });

  test("asks for layers only in the one layered spec", () => {
    for (const plan of ALL) expect(specOf(plan).layers.length > 0).toBe(plan === LAYERED_SPEC);
  });

  test("refuses to be built over the wrong number of photos", () => {
    expect(() => smokeSpec(PAIRWISE_SPECS[2] as SmokeSpecPlan, "avatar-0001", ["photo-only-one"])).toThrow();
  });
});

test("the library needs one scene photo per cell of every spec: no photo is shared, because one photo goes into one video", () => {
  expect(SMOKE_PHOTOS_NEEDED).toBe(ALL.reduce((sum, plan) => sum + plan.photoCount, 0));
  expect(SMOKE_PHOTOS_NEEDED).toBe(1 + 1 + 2 + 3 + 4 + 11 + 2);
});

describe("the layered timeline (3b.6, the packaged render with a real caption and a built-in sticker)", () => {
  const spec = specOf(LAYERED_SPEC);

  test("is 15 s, the longest a montage may be, so its peak memory is the render's worst: two photo clips and nothing else", () => {
    expect(spec.clips.reduce((sum, clip) => sum + clip.durationMs, 0)).toBe(15_000);
    expect(spec.clips.every((clip) => clip.kind === "photo")).toBe(true);
  });

  test("has one text layer, drawn by the real rasteriser, and one built-in sticker", () => {
    expect(spec.layers.map((l) => l.kind)).toEqual(["text", "sticker"]);
    const sticker = spec.layers[1];
    expect(sticker?.kind === "sticker" ? sticker.sticker.source : null).toBe("builtin");
  });

  test("uses the heaviest text style, a shadow («Без фона»), with an emoji, and a large sticker", () => {
    const [text, sticker] = spec.layers;
    expect(text?.kind === "text" ? text.style : null).toBe("none");
    expect(text?.kind === "text" ? text.value : "").toMatch(/\p{Extended_Pictographic}/u);
    expect(sticker?.kind === "sticker" ? sticker.size : 0).toBeGreaterThanOrEqual(0.4);
  });

  test("is refused by nothing: no structural issue, no N9, a sticker the set has", () => {
    expect([...montageIssues(spec, "spec"), ...notYetSupportedIssues(spec), ...stickerIssues(spec)]).toEqual([]);
  });

  test("keeps its layers inside the timeline, each at least 300 ms", () => {
    for (const layer of spec.layers) {
      expect(layer.endMs).toBeLessThanOrEqual(15_000);
      expect(layer.endMs - layer.startMs).toBeGreaterThanOrEqual(300);
    }
  });
});
