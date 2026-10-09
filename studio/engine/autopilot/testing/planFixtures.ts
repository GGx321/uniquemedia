import type { LaunchDraft } from "../../../shared/engine/autopilot";
import type { PlanAvatarInput, PlanInput, PlanPhoto } from "../planner";

// Fixtures for the launch planner's tests: a draft, an avatar, photos with a controlled PDQ distance. Not part of the product.

/** mulberry32: a small seeded generator, so a property test replays exactly. */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

export function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

/** A random 256-bit hash as 64 hex characters; two of them differ in about 128 bits. */
export function randomPdq(next: () => number): string {
  let hex = "";
  for (let i = 0; i < 64; i++) hex += Math.floor(next() * 16).toString(16);
  return hex;
}

/** `hash` with exactly `bits` bits flipped (bits 0..255, from the front), so the Hamming distance to `hash` is `bits`. */
export function flipBits(hash: string, bits: number): string {
  const bytes = hexToBytes(hash);
  for (let i = 0; i < bits; i++) bytes[Math.floor(i / 8)] = (bytes[Math.floor(i / 8)] ?? 0) ^ (1 << (i % 8));
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

export function draft(extra: Partial<LaunchDraft> = {}): LaunchDraft {
  return {
    avatarIds: ["mia"],
    videosPerAvatar: 10,
    mix: { single: 70, collage: 20, slides: 10 },
    categories: ["home"],
    poses: { profile: false, back: false },
    library: true,
    generate: true,
    sceneReview: false,
    stickers: false,
    planSeed: 1,
    ...extra,
  };
}

let counter = 0;
export function photo(extra: Partial<PlanPhoto> & { avatarId?: string } = {}): PlanPhoto {
  counter += 1;
  return {
    id: `photo-${String(counter).padStart(6, "0")}`,
    avatarId: "mia",
    category: "home",
    pdq: undefined,
    faceCos: undefined,
    eligible: true,
    rejected: false,
    reserved: false,
    usedIn: [],
    ...extra,
  };
}

/** `n` free photos of one category with pairwise far-apart hashes. */
export function distinctPhotos(n: number, extra: Partial<PlanPhoto> = {}, seed = 7): PlanPhoto[] {
  const next = rng(seed);
  return Array.from({ length: n }, () => photo({ pdq: randomPdq(next), ...extra }));
}

export function avatar(photos: readonly PlanPhoto[], extra: Partial<PlanAvatarInput> = {}): PlanAvatarInput {
  return { avatarId: "mia", usage: { state: "ok" }, hasOpenSet: false, draftsKnown: true, photos, ...extra };
}

export function input(parts: { draft?: Partial<LaunchDraft>; avatars: readonly PlanAvatarInput[]; held?: readonly string[]; customPoses?: PlanInput["customPoses"] }): PlanInput {
  const ids = parts.avatars.map((a) => a.avatarId);
  return {
    draft: draft({ avatarIds: ids, ...parts.draft }),
    avatars: parts.avatars,
    draftHeldPhotoIds: new Set(parts.held ?? []),
    customPoses: parts.customPoses ?? new Map(),
  };
}
