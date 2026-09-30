import type { z } from "zod";
import { COLLAGE_CELL_COUNT, type MontageShape } from "../shared/engine";

// The render specs of the packaged E2E (plan 3a.9, `smoke-engine.ts`): five pairwise 4 s specs that between them cover every
// clip kind Studio renders today (a photo, a collage; an own video is slice 3f), every collage size and every motion, and one
// mixed 15 s timeline, the longest a montage may be. Data only, built over photo ids the smoke hands in.

type Shape = z.infer<typeof MontageShape>;
type Motion = "kenburns" | "pan" | "static";
type Layout = keyof typeof COLLAGE_CELL_COUNT;

interface ClipPlan {
  readonly layout: "photo" | Layout;
  readonly motion: Motion;
  readonly durationMs: number;
  /** A collage only: its cells enter one after another. */
  readonly stagger?: boolean;
}

export interface SmokeSpecPlan {
  /** Names the spec in the smoke's output. */
  readonly name: string;
  readonly clips: readonly ClipPlan[];
  /** One scene photo per cell: one photo goes into one video. */
  readonly photoCount: number;
}

const cellsOf = (layout: ClipPlan["layout"]): number => (layout === "photo" ? 1 : COLLAGE_CELL_COUNT[layout]);

function plan(name: string, clips: readonly ClipPlan[]): SmokeSpecPlan {
  return { name, clips, photoCount: clips.reduce((sum, clip) => sum + cellsOf(clip.layout), 0) };
}

/** Each 4 s in one clip. The motions are spread so none depends on a single kind: Ken Burns on a photo and on a collage, a pan on a photo and on a collage, static on a collage (and in the mixed timeline, on a photo). */
export const PAIRWISE_SPECS: readonly SmokeSpecPlan[] = [
  plan("photo-kenburns", [{ layout: "photo", motion: "kenburns", durationMs: 4_000 }]),
  plan("photo-pan", [{ layout: "photo", motion: "pan", durationMs: 4_000 }]),
  plan("collage2-static", [{ layout: "collage2", motion: "static", durationMs: 4_000, stagger: false }]),
  plan("collage3-kenburns-stagger", [{ layout: "collage3", motion: "kenburns", durationMs: 4_000, stagger: true }]),
  plan("collage4-pan", [{ layout: "collage4", motion: "pan", durationMs: 4_000, stagger: false }]),
];

/** 15 s in five 3 s clips: every kind, every collage size and every motion in one timeline. */
export const MIXED_SPEC: SmokeSpecPlan = plan("mixed-15s", [
  { layout: "photo", motion: "static", durationMs: 3_000 },
  { layout: "collage2", motion: "kenburns", durationMs: 3_000, stagger: false },
  { layout: "photo", motion: "pan", durationMs: 3_000 },
  { layout: "collage3", motion: "static", durationMs: 3_000, stagger: true },
  { layout: "collage4", motion: "pan", durationMs: 3_000, stagger: false },
]);

/** How many scene photos the library must hold for every spec to have its own. */
export const SMOKE_PHOTOS_NEEDED: number = [...PAIRWISE_SPECS, MIXED_SPEC].reduce((sum, p) => sum + p.photoCount, 0);

const FOCUS = { x: 0.5, y: 0.4 } as const;

/** The spec over `photoIds`, in cell order. Every cell carries its focus, so no render waits on the face gate. */
export function smokeSpec(spec: SmokeSpecPlan, avatarId: string, photoIds: readonly string[]): Shape {
  if (photoIds.length !== spec.photoCount) throw new Error(`${spec.name} needs ${spec.photoCount} photos, got ${photoIds.length}`);
  let next = 0;
  const cell = (): { photo: { source: "scene"; photoId: string }; focus: { x: number; y: number } } => {
    const photoId = photoIds[next++];
    if (photoId === undefined) throw new Error("ran out of photos");
    return { photo: { source: "scene", photoId }, focus: { ...FOCUS } };
  };
  const clips = spec.clips.map((clip, i): Shape["clips"][number] => {
    const clipId = `clip-${spec.name}-${String(i + 1).padStart(2, "0")}`.slice(0, 64);
    if (clip.layout === "photo") return { clipId, kind: "photo", cell: cell(), motion: clip.motion, durationMs: clip.durationMs, transitionIn: "cut" };
    return {
      clipId,
      kind: "collage",
      layout: clip.layout,
      cells: Array.from({ length: COLLAGE_CELL_COUNT[clip.layout] }, cell),
      motion: clip.motion,
      stagger: clip.stagger ?? false,
      durationMs: clip.durationMs,
      transitionIn: "cut",
    };
  });
  return { schemaVersion: 1, avatarId, clips, layers: [], music: null, seed: 7 };
}
