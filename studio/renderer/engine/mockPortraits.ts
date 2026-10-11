import type { AvatarPortraits, AvatarSummary, EngineError, Estimate, FailedPortraitSlot, ImageAgeCheck } from "../../shared/engine";
import { PORTRAIT_CANDIDATES_MAX, PORTRAITS_PER_BATCH } from "../../shared/engine";

// The mock's reference portraits (Stage 5, S5.3c): an imported avatar's «source» photo, the pending portraits drawn from it, and the master's likeness to it. The commands and the job
// are in mockEngine.ts (they need its clock, its money and its events); this module holds what they share: the price, the deterministic outcome table of a batch, and the state.

/**
 * One image with one reference at the plan's figure: grok-imagine-image-quality at 1K ($0.05) plus the input image ($0.01). The engine prices the same at that model
 * (`portraitsEstimate`, pinned by mockEngine.portraits.test.ts); the mock does not look at the settings' model.
 */
export const MOCK_PORTRAIT_IMAGE_MICROS = 60_000;

/** The age check's share of one paid image when it is on: the engine's ceiling, and its expected figure (what 5 × (image + check) adds to the expected cost). */
export const MOCK_PORTRAIT_AGE_MICROS = { expected: 1_660, worst: 5_250 } as const;

/** The batch's price at the mock's figures: five slots, and the age check on every paid one when it is on. Never above the worst case, never below the expected. */
export function mockPortraitsEstimate(imageAgeCheck: ImageAgeCheck, pricesAsOf: string): Estimate {
  const age = imageAgeCheck === "on" ? MOCK_PORTRAIT_AGE_MICROS : { expected: 0, worst: 0 };
  return {
    expectedMicros: PORTRAITS_PER_BATCH * (MOCK_PORTRAIT_IMAGE_MICROS + age.expected),
    worstMicros: PORTRAITS_PER_BATCH * (MOCK_PORTRAIT_IMAGE_MICROS + age.worst),
    prices: "live",
    pricesAsOf,
  };
}

/**
 * What one slot of a mock batch comes to:
 * - `pass`: the face is hers at `likeness`; the image is kept (paid, and age-checked when that is on).
 * - `unlike`: the face is not hers (a likeness under the gate); paid, dropped, no age check.
 * - `no-face` / `multiple-faces`: the same, for an image with no face or several.
 * - `refused`: the model refused it (moderation): free.
 * - `age-rejected`: it ranked as hers, and the age check dropped it: paid twice.
 */
export type MockPortraitSlot =
  | { kind: "pass"; likeness: number }
  | { kind: "unlike"; likeness: number }
  | { kind: "no-face" }
  | { kind: "multiple-faces" }
  | { kind: "refused" }
  | { kind: "age-rejected" }
  /**
   * S5.3d review L6, DEMO and tests only (never in `MOCK_PORTRAIT_SLOTS`, which the parity rig plays): the slot could not finish, with `error`, and its
   * money as the engine would settle it — `open` (a timeout or a lost connection: the reserve waits for a reconcile at the worst), `paid` (the image
   * was billed), `free` (nothing sent, or a non-2xx settled at 0).
   */
  | { kind: "failed"; error: EngineError; settle: "open" | "paid" | "free" };

/**
 * The deterministic outcome of the five slots of a mock batch, in slot order. Exported for the parity rig: its scripted face gate and its fake OpenRouter tell the real engine the same
 * story, so the two transcripts can be equal. Three pass (0.76, 0.72, 0.61), one is not hers (0.48), and the model refuses the last.
 */
export const MOCK_PORTRAIT_SLOTS: readonly MockPortraitSlot[] = [
  { kind: "pass", likeness: 0.76 },
  { kind: "pass", likeness: 0.72 },
  { kind: "pass", likeness: 0.61 },
  { kind: "unlike", likeness: 0.48 },
  { kind: "refused" },
];

/**
 * DEMO only (review L6): the dev build's Ava plays this, so 16e (a batch that ended with paid failures) can be seen in the mock: three portraits, and two
 * slots OpenRouter did not answer in time, their reserves left open until a reconcile. The parity rig never plays it.
 */
export const MOCK_PORTRAIT_SLOTS_SOME_FAILED: readonly MockPortraitSlot[] = [
  { kind: "pass", likeness: 0.76 },
  { kind: "pass", likeness: 0.72 },
  { kind: "pass", likeness: 0.61 },
  { kind: "failed", error: { code: "TIMEOUT", detail: "the image request timed out after 180 s" }, settle: "open" },
  { kind: "failed", error: { code: "TIMEOUT", detail: "the image request timed out after 180 s" }, settle: "open" },
];

/** What the mock's model says when it refuses an image: a moderation refusal carries the provider's own message (the parity rig's fake OpenRouter says the same words). */
export const MOCK_PORTRAIT_REFUSAL: EngineError = { code: "MODERATION_REFUSED", detail: "HTTP 400: xAI blocked this request through content moderation." };

/** What a test or a story seeds for one avatar: its imported photo, the likeness of a portrait master, and the pending portraits. */
export interface MockPortraitSeed {
  avatarId: string;
  /** The avatar's imported photo: the avatar's master until a portrait is picked. */
  sourcePhotoId: string;
  /** Set when the avatar's master is a portrait: its likeness to the source. Absent when the master is the source. */
  masterLikeness?: number;
  /** The pending portraits (at most `PORTRAIT_CANDIDATES_MAX`). */
  candidates?: readonly { photoId: string; likeness: number }[];
}

/** One avatar's portraits as the mock keeps them. */
export interface MockPortraitState {
  sourcePhotoId: string;
  masterLikeness: number | null;
  pending: { photoId: string; likeness: number }[];
}

export function portraitStateOf(seed: MockPortraitSeed): MockPortraitState {
  return { sourcePhotoId: seed.sourcePhotoId, masterLikeness: seed.masterLikeness ?? null, pending: (seed.candidates ?? []).slice(0, PORTRAIT_CANDIDATES_MAX).map((c) => ({ ...c })) };
}

/** Best likeness first, ties by photo id: the order every list of portraits uses. */
export function byLikeness(a: { photoId: string; likeness: number }, b: { photoId: string; likeness: number }): number {
  return b.likeness - a.likeness || (a.photoId < b.photoId ? -1 : a.photoId > b.photoId ? 1 : 0);
}

/** `avatars.portraits`' answer for a saved avatar; an avatar with no source (a wizard avatar) lists none. */
export function portraitsView(avatar: AvatarSummary, state: MockPortraitState | undefined): AvatarPortraits {
  const base = { avatarId: avatar.avatarId, masterPhotoId: avatar.masterPhotoId };
  if (state === undefined) return { ...base, sourcePhotoId: null, masterLikeness: null, candidates: [] };
  const masterIsSource = avatar.masterPhotoId === state.sourcePhotoId;
  return {
    ...base,
    sourcePhotoId: state.sourcePhotoId,
    masterLikeness: masterIsSource ? null : state.masterLikeness,
    candidates: [...state.pending].sort(byLikeness).map((c) => ({ avatarId: avatar.avatarId, photoId: c.photoId, likeness: c.likeness })),
  };
}

/** The slots a finished batch reports as having given no candidate, in slot order. */
export function failedSlotOf(slot: number, outcome: MockPortraitSlot): FailedPortraitSlot | null {
  switch (outcome.kind) {
    case "pass":
      return null;
    case "unlike":
      return { slot, reason: "unlike", likeness: outcome.likeness };
    case "no-face":
    case "multiple-faces":
      return { slot, reason: outcome.kind };
    case "age-rejected":
      return { slot, reason: "age-rejected" };
    case "refused":
      return { slot, reason: "failed", error: { ...MOCK_PORTRAIT_REFUSAL }, reserveLeftOpen: false };
    case "failed":
      return { slot, reason: "failed", error: { ...outcome.error }, reserveLeftOpen: outcome.settle === "open" };
  }
}
