import type { Estimate } from "../engine";
import { MAX_COMPOSE_SCENES } from "../engine/scenes";

// Stage 4 (plan §4.2, §4.3, invariant A18): the launch estimate. ONE pure function shared by the engine's preview and start and by the mock, linear in the counts.
// It takes unit prices, not a price book: the engine reads them from its own estimates (`engine/autopilot/prices.ts`, built on `composeEstimate` and
// `runEstimateFromScenes`), the mock passes fixed ones, so neither can drift from the other. Whole micro-dollars throughout.

/** The most new photos one avatar can need in a launch: the set's own limit (`MAX_COMPOSE_SCENES`), also the most a compose plans (plan §4.5). */
export const MAX_GENERATED_PER_AVATAR = MAX_COMPOSE_SCENES;

/**
 * What one photo and one scene cost, at one set of prices.
 * - `photoWorstMicros`: a photo's worst case, every attempt of its slot at the dearest model of the route (`estimateRun` for one photo with no writer).
 * - `photoExpectedMicros`: one attempt on the primary model, an age check when it is on.
 * - `writerCeilingMicros`, `writerChunkSlots`, `writerMaxAttempts`: the writer's call, its chunk and its attempts per chunk (the compose's worst case).
 * - `writerTypicalMicros[n]`: what the writer costs for n scenes at its typical tokens, n = 0..100. A table, not a rate: a call's cost is rounded up per call,
 *   so it is not exactly linear, and the launch's figure must equal the engine's compose estimate to the micro-dollar.
 */
export interface LaunchUnitPrices {
  photoWorstMicros: number;
  photoExpectedMicros: number;
  writerCeilingMicros: number;
  writerChunkSlots: number;
  writerMaxAttempts: number;
  writerTypicalMicros: readonly number[];
  prices: Estimate["prices"];
  pricesAsOf: string;
}

/** How many new photos one avatar's plan needs (`n_a`). */
export interface AvatarNeed {
  avatarId: string;
  photos: number;
}

export interface AvatarEstimate {
  avatarId: string;
  photos: number;
  composeWorstMicros: number;
  drawWorstMicros: number;
  worstMicros: number;
  composeExpectedMicros: number;
  drawExpectedMicros: number;
  expectedMicros: number;
}

export interface LaunchEstimate {
  avatars: AvatarEstimate[];
  /** W: the sum of the avatars' worst cases. */
  worstMicros: number;
  /** E: the sum of the avatars' expected costs. */
  expectedMicros: number;
  prices: Estimate["prices"];
  pricesAsOf: string;
}

function checkMicros(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative whole number of micro-dollars, got ${value}`);
}

function checkPhotos(photos: number): void {
  if (!Number.isInteger(photos) || photos < 0 || photos > MAX_GENERATED_PER_AVATAR) {
    throw new RangeError(`an avatar needs 0..${MAX_GENERATED_PER_AVATAR} new photos, got ${photos}`);
  }
}

function safe(value: number): number {
  if (!Number.isSafeInteger(value)) throw new RangeError("launch estimate is out of range");
  return value;
}

/** The compose of `photos` scenes at worst: chunks of `writerChunkSlots`, each asked `writerMaxAttempts` times at the ceiling (`writerWorstMicros`). */
export function composeWorstMicros(unit: LaunchUnitPrices, photos: number): number {
  checkPhotos(photos);
  return safe(Math.ceil(photos / unit.writerChunkSlots) * unit.writerMaxAttempts * unit.writerCeilingMicros);
}

/**
 * The launch's expected cost and worst case, per avatar and in total (plan §4.2). Per avatar with n new photos:
 * worst = composeWorst(n) + n × photoWorst, expected = writerTypical(n) + n × photoExpected. For one avatar and n in 1..100 this equals
 * `composeEstimate(n) + runEstimateFromScenes(n)` on the same price book (A18, pinned in engine/autopilot/prices.test.ts).
 */
export function launchEstimate(needs: readonly AvatarNeed[], unit: LaunchUnitPrices): LaunchEstimate {
  checkMicros("photoWorstMicros", unit.photoWorstMicros);
  checkMicros("photoExpectedMicros", unit.photoExpectedMicros);
  checkMicros("writerCeilingMicros", unit.writerCeilingMicros);
  if (!Number.isInteger(unit.writerChunkSlots) || unit.writerChunkSlots < 1) throw new RangeError(`writerChunkSlots must be a positive integer, got ${unit.writerChunkSlots}`);
  if (!Number.isInteger(unit.writerMaxAttempts) || unit.writerMaxAttempts < 1) throw new RangeError(`writerMaxAttempts must be a positive integer, got ${unit.writerMaxAttempts}`);
  const avatars = needs.map((need): AvatarEstimate => {
    checkPhotos(need.photos);
    const writerTypical = unit.writerTypicalMicros[need.photos];
    if (writerTypical === undefined) throw new RangeError(`the writer's price table has no entry for ${need.photos} scenes`);
    checkMicros("writerTypicalMicros", writerTypical);
    const composeWorst = composeWorstMicros(unit, need.photos);
    const drawWorst = safe(need.photos * unit.photoWorstMicros);
    const drawExpected = safe(need.photos * unit.photoExpectedMicros);
    // The compose is never expected to cost more than its worst case (the engine's `composeEstimate` caps it the same way).
    const composeExpected = Math.min(writerTypical, composeWorst);
    return {
      avatarId: need.avatarId,
      photos: need.photos,
      composeWorstMicros: composeWorst,
      drawWorstMicros: drawWorst,
      worstMicros: safe(composeWorst + drawWorst),
      composeExpectedMicros: composeExpected,
      drawExpectedMicros: drawExpected,
      expectedMicros: safe(composeExpected + drawExpected),
    };
  });
  return {
    avatars,
    worstMicros: safe(avatars.reduce((sum, a) => sum + a.worstMicros, 0)),
    expectedMicros: safe(avatars.reduce((sum, a) => sum + a.expectedMicros, 0)),
    prices: unit.prices,
    pricesAsOf: unit.pricesAsOf,
  };
}

/** What one avatar may spend: its compose (and its own «Дописать» after a stop) and the draw of its photos, in slices. */
export interface AvatarAllocation {
  avatarId: string;
  composeMicros: number;
  drawMicros: number;
}

export type LaunchAllocation =
  | { ok: true; avatars: AvatarAllocation[]; plannedWorstMicros: number }
  | { ok: false; reason: "PRICE_CHANGED"; plannedWorstMicros: number; acceptedMicros: number };

/**
 * Splits the recomputed worst case W′ into compose and draw parts per avatar (plan §4.3). `W′ > accepted` is PRICE_CHANGED (free: the UI asks again and needs a new
 * click); otherwise each avatar gets exactly its compose worst case and its draw worst case, so Σ allocated = W′ ≤ accepted. A cap is never raised to fit.
 */
export function allocateLaunch(estimate: LaunchEstimate, acceptedMicros: number): LaunchAllocation {
  checkMicros("acceptedMicros", acceptedMicros);
  if (estimate.worstMicros > acceptedMicros) {
    return { ok: false, reason: "PRICE_CHANGED", plannedWorstMicros: estimate.worstMicros, acceptedMicros };
  }
  return {
    ok: true,
    avatars: estimate.avatars.map((a) => ({ avatarId: a.avatarId, composeMicros: a.composeWorstMicros, drawMicros: a.drawWorstMicros })),
    plannedWorstMicros: estimate.worstMicros,
  };
}
