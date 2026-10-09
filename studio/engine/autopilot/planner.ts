import { hammingDistance } from "../../../src/core/pdq/hamming";
import type { AvatarBlockerCode, LaunchDraft, VideoShape } from "../../shared/engine/autopilot";
import { orderCategories, type CategoryPoses, type CategoryRef, type ScenePose } from "../../shared/engine/categories";
import { MAX_COMPOSE_SCENES } from "../../shared/engine/scenes";
import type { AvatarUsage } from "../../shared/engine/state";
import { defaultQaConfig } from "../runs/config";

// Stage 4 launch planner (plan §5, §6.2, §6.4): pure and deterministic from the draft's seed. The orchestrator (S4.6) reads the library into `PlanInput`,
// calls `planLaunch` for the preview and the start, and `assignGenerated` after each slice. Nothing here touches a disk, a clock or a random source.

/** One library photo as the planner sees it: the sidecar's facts that matter and the library's verdict on the other axes (`Library.photoStates`). */
export interface PlanPhoto {
  id: string;
  avatarId: string;
  /** `source.category` of a generated photo; undefined for an imported one (it never matches a category). */
  category: string | undefined;
  /** PDQ hash as lowercase hex, when the QA stored one. */
  pdq: string | undefined;
  /** Stored by the face gate; undefined for profile, back and photos whose gate was skipped. */
  faceCos: number | undefined;
  eligible: boolean;
  rejected: boolean;
  reserved: boolean;
  usedIn: readonly string[];
}

export interface PlanAvatarInput {
  avatarId: string;
  usage: AvatarUsage;
  /** The avatar has an open scene set of the owner's own: a plan that needs new photos cannot start. */
  hasOpenSet: boolean;
  /** All the avatar's photos, with their states (the planner does the filtering itself). */
  photos: readonly PlanPhoto[];
}

export interface PlanInput {
  draft: LaunchDraft;
  avatars: readonly PlanAvatarInput[];
  /** Photos held by any saved montage draft (S4.5c `photoIdsInDrafts`). */
  draftHeldPhotoIds: ReadonlySet<string>;
  /** Angles of the custom categories that have their own; a category absent here uses the draft's toggles. */
  customPoses: ReadonlyMap<CategoryRef, CategoryPoses>;
}

export type VideoSource = "library" | "generated";

export interface PlannedVideo {
  /** `<avatar position 0-49>-<video 1-50>`. */
  key: string;
  shape: VideoShape;
  size: number;
  source: VideoSource;
  category: CategoryRef;
  /** The library photos of a library video, in cell order; empty for a generated one until `assignGenerated`. */
  photoIds: readonly string[];
}

export interface DroppedVideo {
  key: string;
  shape: VideoShape;
  reason: "not-enough-photos";
}

export interface GenerateNeed {
  category: CategoryRef;
  count: number;
  poses: readonly ScenePose[];
}

export interface AvatarPlan {
  avatarId: string;
  blocked: AvatarBlockerCode | null;
  usage: AvatarUsage;
  /** Free photos in the chosen categories (0 when the usage cannot be trusted). */
  free: number;
  shapes: Record<VideoShape, number>;
  videos: readonly PlannedVideo[];
  dropped: readonly DroppedVideo[];
  fromLibrary: number;
  toGenerate: number;
  /** The explicit split for compose: exact photos per category, in the seeded order. */
  generate: readonly GenerateNeed[];
}

export interface LaunchPlan {
  avatars: readonly AvatarPlan[];
  /** Over the avatars that are not blocked. */
  totals: { videos: number; photosNeeded: number; fromLibrary: number; toGenerate: number };
}

const SHAPE_ORDER: readonly VideoShape[] = ["single", "collage", "slides"];
/** Shapes in the order the library fills them: slides need the most same-category photos (§5.3.1). */
const FILL_ORDER: readonly VideoShape[] = ["slides", "collage", "single"];
const SIZE_RANGE: Record<"collage" | "slides", { min: number; max: number }> = { collage: { min: 2, max: 4 }, slides: { min: 5, max: 7 } };
/** A generated video asks for a fixed number of photos: variety from the library is free, a generated photo is paid (§5.3.4). */
const GENERATED_SIZE: Record<VideoShape, number> = { single: 1, collage: 3, slides: 5 };
const BASE_POSES: readonly ScenePose[] = ["front", "three-quarter"];

/** Two photos of one video must be further apart than the run gate's own threshold. */
const NEAR_DUPLICATE_DISTANCE = defaultQaConfig().pdq.maxHammingDistance;

// ---------- seeded randomness ----------

function fnv1a(...parts: readonly (string | number)[]): number {
  let hash = 0x811c9dc5;
  for (const char of parts.join("\u0000")) {
    hash ^= char.codePointAt(0) ?? 0;
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

/** mulberry32. */
function randomFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function shuffled<T>(items: readonly T[], next: () => number): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

// ---------- the mix ----------

/** The mix applied to a count by largest remainder in integer arithmetic; a tie goes to the earlier of single, collage, slides (§5.2). */
export function mixCounts(videos: number, mix: LaunchDraft["mix"]): Record<VideoShape, number> {
  const scaled = SHAPE_ORDER.map((shape) => videos * mix[shape]);
  const counts = scaled.map((value) => Math.floor(value / 100));
  let left = videos - counts.reduce((sum, count) => sum + count, 0);
  const byRemainder = SHAPE_ORDER.map((_, index) => index).sort((a, b) => ((scaled[b] ?? 0) % 100) - ((scaled[a] ?? 0) % 100) || a - b);
  for (const index of byRemainder) {
    if (left <= 0) break;
    counts[index] = (counts[index] ?? 0) + 1;
    left -= 1;
  }
  return { single: counts[0] ?? 0, collage: counts[1] ?? 0, slides: counts[2] ?? 0 };
}

// ---------- photos ----------

function hashOf(photo: PlanPhoto): Uint8Array | null {
  const hex = photo.pdq;
  if (hex === undefined || !/^(?:[0-9a-f]{2})+$/.test(hex)) return null;
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < bytes.length; i++) bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return bytes;
}

/** A photo with no stored hash (or one of another length) counts as distinct: nothing is known against it. */
function nearDuplicates(a: PlanPhoto, b: PlanPhoto): boolean {
  const x = hashOf(a);
  const y = hashOf(b);
  if (x === null || y === null || x.length !== y.length) return false;
  return hammingDistance(x, y) <= NEAR_DUPLICATE_DISTANCE;
}

const faceKey = (photo: PlanPhoto): number => photo.faceCos ?? Number.NEGATIVE_INFINITY;

/** For collages and slides: photos without a stored face match first, then the lowest, so the verified faces stay for the singles (§5.3.3). Stable. */
const forGroups = (photos: readonly PlanPhoto[]): PlanPhoto[] => [...photos].sort((a, b) => faceKey(a) - faceKey(b));

/** Up to `size` photos, none a near-duplicate of another, taken in the order given. */
function pickGroup(ordered: readonly PlanPhoto[], size: number): PlanPhoto[] {
  const chosen: PlanPhoto[] = [];
  for (const candidate of ordered) {
    if (chosen.length === size) break;
    if (chosen.every((taken) => !nearDuplicates(taken, candidate))) chosen.push(candidate);
  }
  return chosen;
}

/** The highest stored face match; the first of equals (a photo without one is the last resort). */
function bestForSingle(photos: readonly PlanPhoto[]): PlanPhoto | undefined {
  let best: PlanPhoto | undefined;
  for (const candidate of photos) if (best === undefined || faceKey(candidate) > faceKey(best)) best = candidate;
  return best;
}

function uniqueById(photos: readonly PlanPhoto[]): PlanPhoto[] {
  const seen = new Map<string, PlanPhoto>();
  for (const photo of photos) if (!seen.has(photo.id)) seen.set(photo.id, photo);
  return [...seen.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// ---------- keys ----------

function keyParts(key: string): [number, number] {
  const [avatar, video] = key.split("-");
  return [Number(avatar), Number(video)];
}
const byKey = (a: { key: string }, b: { key: string }): number => {
  const [aa, av] = keyParts(a.key);
  const [ba, bv] = keyParts(b.key);
  return aa - ba || av - bv;
};

// ---------- the plan ----------

interface Slot {
  key: string;
  shape: VideoShape;
}

function posesFor(category: CategoryRef, input: PlanInput): readonly ScenePose[] {
  const own = input.customPoses.get(category);
  if (own !== undefined) return [...own];
  const { profile, back } = input.draft.poses;
  return [...BASE_POSES, ...(profile ? (["profile"] as const) : []), ...(back ? (["back"] as const) : [])];
}

function poolOf(avatar: PlanAvatarInput, input: PlanInput): PlanPhoto[] {
  if (avatar.usage.state !== "ok") return [];
  const chosen = new Set<string>(input.draft.categories);
  return uniqueById(
    avatar.photos.filter(
      (p) =>
        p.avatarId === avatar.avatarId &&
        p.eligible &&
        !p.rejected &&
        !p.reserved &&
        p.usedIn.length === 0 &&
        !input.draftHeldPhotoIds.has(p.id) &&
        p.category !== undefined &&
        chosen.has(p.category),
    ),
  );
}

function planAvatar(position: number, avatar: PlanAvatarInput, input: PlanInput): AvatarPlan {
  const { draft } = input;
  const pool = poolOf(avatar, input);
  const next = randomFrom(fnv1a(draft.planSeed, avatar.avatarId));
  const counts = mixCounts(draft.videosPerAvatar, draft.mix);
  const slots: Slot[] = shuffled(
    SHAPE_ORDER.flatMap((shape) => Array.from({ length: counts[shape] }, () => shape)),
    next,
  ).map((shape, index) => ({ key: `${position}-${index + 1}`, shape }));
  const categories = shuffled(orderCategories(draft.categories), next);

  const planned: PlannedVideo[] = [];
  const unfilled: Slot[] = [];

  // Library first: slides, then collages, then singles, by key.
  const left = new Map<string, PlanPhoto[]>(categories.map((c) => [c, shuffled(pool.filter((p) => p.category === c), next)]));
  const takeFrom = (category: string, taken: readonly PlanPhoto[]): void => {
    const ids = new Set(taken.map((p) => p.id));
    left.set(category, (left.get(category) ?? []).filter((p) => !ids.has(p.id)));
  };
  let rotation = 0;
  for (const shape of FILL_ORDER) {
    for (const slot of slots.filter((s) => s.shape === shape).sort(byKey)) {
      if (!draft.library) {
        unfilled.push(slot);
        continue;
      }
      if (shape === "single") {
        const best = bestForSingle(categories.flatMap((c) => left.get(c) ?? []));
        const category = categories.find((c) => c === best?.category);
        if (best === undefined || category === undefined) {
          unfilled.push(slot);
          continue;
        }
        takeFrom(category, [best]);
        planned.push({ key: slot.key, shape, size: 1, source: "library", category, photoIds: [best.id] });
        continue;
      }
      const { min, max } = SIZE_RANGE[shape];
      const desired = min + Math.floor(next() * (max - min + 1));
      const start = rotation++ % Math.max(1, categories.length);
      const order = [...categories.slice(start), ...categories.slice(0, start)];
      // The full draw in the first category that can give it; failing that, the largest group any category can give, down to the shape's smallest.
      const groups = order.map((category) => ({ category, group: pickGroup(forGroups(left.get(category) ?? []), desired) }));
      const found = groups.find((g) => g.group.length === desired) ?? groups.find((g) => g.group.length >= min);
      if (found === undefined) {
        unfilled.push(slot);
        continue;
      }
      takeFrom(found.category, found.group);
      planned.push({ key: slot.key, shape, size: found.group.length, source: "library", category: found.category, photoIds: found.group.map((p) => p.id) });
    }
  }

  // What the library could not fill: generated, or dropped when generation is off. The categories go round in their seeded order, slides first.
  const dropped: DroppedVideo[] = [];
  let turn = 0;
  for (const shape of FILL_ORDER) {
    for (const slot of unfilled.filter((s) => s.shape === shape).sort(byKey)) {
      const category = categories[turn % categories.length];
      if (!draft.generate || category === undefined) {
        dropped.push({ key: slot.key, shape, reason: "not-enough-photos" });
        continue;
      }
      turn += 1;
      planned.push({ key: slot.key, shape, size: GENERATED_SIZE[shape], source: "generated", category, photoIds: [] });
    }
  }

  const videos = planned.sort(byKey);
  const generate: GenerateNeed[] = categories
    .map((category) => ({ category, count: videos.filter((v) => v.source === "generated" && v.category === category).reduce((sum, v) => sum + v.size, 0) }))
    .filter((need) => need.count > 0)
    .map((need) => ({ ...need, poses: posesFor(need.category, input) }));
  const toGenerate = generate.reduce((sum, need) => sum + need.count, 0);
  const fromLibrary = videos.filter((v) => v.source === "library").reduce((sum, v) => sum + v.size, 0);

  // One reason is reported: unreadable usage first (nothing about the avatar can be trusted), then the limit, then the open set.
  let blocked: AvatarBlockerCode | null = null;
  if (avatar.usage.state !== "ok" && draft.library) blocked = "usage-unknown";
  else if (toGenerate > MAX_COMPOSE_SCENES) blocked = "too-many-photos";
  else if (toGenerate > 0 && avatar.hasOpenSet) blocked = "open-set";

  const shapeCount = (shape: VideoShape): number => videos.filter((v) => v.shape === shape).length;
  return {
    avatarId: avatar.avatarId,
    blocked,
    usage: avatar.usage,
    free: pool.length,
    shapes: { single: shapeCount("single"), collage: shapeCount("collage"), slides: shapeCount("slides") },
    videos,
    dropped: dropped.sort(byKey),
    fromLibrary,
    toGenerate,
    generate,
  };
}

export function planLaunch(input: PlanInput): LaunchPlan {
  const known = new Map(input.avatars.map((a) => [a.avatarId, a]));
  const avatars = input.draft.avatarIds.map((id, position) => {
    const avatar = known.get(id);
    if (avatar === undefined) throw new RangeError(`no plan input for avatar ${id}`);
    return planAvatar(position, avatar, input);
  });
  const counted = avatars.filter((a) => a.blocked === null);
  const sum = (pick: (a: AvatarPlan) => number): number => counted.reduce((total, a) => total + pick(a), 0);
  const fromLibrary = sum((a) => a.fromLibrary);
  const toGenerate = sum((a) => a.toGenerate);
  return { avatars, totals: { videos: sum((a) => a.videos.length), photosNeeded: fromLibrary + toGenerate, fromLibrary, toGenerate } };
}

export interface ShapeChange {
  key: string;
  from: { shape: VideoShape; size: number };
  to: { shape: VideoShape; size: number };
}

export interface GeneratedAssignment {
  /** The videos that got their photos (their shape and size may be smaller than planned), by key. */
  videos: readonly PlannedVideo[];
  dropped: readonly DroppedVideo[];
  changes: readonly ShapeChange[];
  /** Photos the plan wanted and did not get (for the log's `degrade` line). */
  missingPhotos: number;
}

/**
 * After a slice (or after review removals): put the arrived photos into the avatar's generated videos by category and key, under the pdq and face rules.
 * Where a category is short the lowest keys are filled first, so the shortage lands on the highest: slides of 5 become a collage of what is there (2 to 4),
 * a collage of 3 becomes 2, a video that cannot get two photos (or a single that gets none) is dropped (§6.4). Photos left over stay free.
 */
export function assignGenerated(videos: readonly PlannedVideo[], arrived: readonly PlanPhoto[]): GeneratedAssignment {
  const left = new Map<string, PlanPhoto[]>();
  for (const photo of uniqueById(arrived)) {
    // The list may be the whole slice again after review removals: a photo the owner rejected since, or one no longer eligible or used, never goes in.
    // `reserved` is not tested: the launch's own photos are reserved by its renders.
    if (photo.category === undefined || !photo.eligible || photo.rejected || photo.usedIn.length > 0) continue;
    left.set(photo.category, [...(left.get(photo.category) ?? []), photo]);
  }
  const assigned: PlannedVideo[] = [];
  const dropped: DroppedVideo[] = [];
  const changes: ShapeChange[] = [];
  let missingPhotos = 0;
  for (const video of [...videos].sort(byKey)) {
    const available = left.get(video.category) ?? [];
    let shape: VideoShape = video.shape;
    let chosen: PlanPhoto[];
    if (video.shape === "single") {
      const best = bestForSingle(available);
      chosen = best === undefined ? [] : [best];
    } else {
      chosen = pickGroup(forGroups(available), video.size);
      if (chosen.length < SIZE_RANGE.collage.min) chosen = [];
      else if (chosen.length < video.size) shape = "collage";
    }
    if (chosen.length === 0) {
      dropped.push({ key: video.key, shape: video.shape, reason: "not-enough-photos" });
      missingPhotos += video.size;
      continue;
    }
    const taken = new Set(chosen.map((p) => p.id));
    left.set(video.category, available.filter((p) => !taken.has(p.id)));
    assigned.push({ ...video, shape, size: chosen.length, photoIds: chosen.map((p) => p.id) });
    missingPhotos += video.size - chosen.length;
    if (chosen.length !== video.size) changes.push({ key: video.key, from: { shape: video.shape, size: video.size }, to: { shape, size: chosen.length } });
  }
  return { videos: assigned, dropped, changes, missingPhotos };
}
