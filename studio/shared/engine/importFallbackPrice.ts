/**
 * T6c review round 2, L8: the import job's own price at the dated fallback
 * table (plan.ts's `importJobEstimate`, priced against `PriceBook.fallback()`
 * as of 2026-09-24) — shared here so nothing keeps its own copy that could
 * silently drift from the real engine's own computation: the renderer's mock
 * (mockEngine.ts's whole-job estimate), the renderer's own static UI text before any photo is even
 * picked (AvatarsScreen.tsx's import tile), and the engine's own test
 * (plan.test.ts) all read the same numbers from here instead of three
 * separate literals. Live prices (the common case) differ; this is only ever
 * the dated fallback table's own number.
 */
export const IMPORT_FALLBACK_PRICE = {
  /** One vision describe attempt alone (1_800 in / 650 out tokens typical; ceilings 7K in / 3K out). */
  describe: { expectedMicros: 3_875, worstMicros: 16_250 },
  /** The whole job: up to two describe attempts (plan.ts's IMPORT_DESCRIBE_MAX_ATTEMPTS), no age check. */
  whole: { expectedMicros: 3_875, worstMicros: 32_500 },
  asOf: "2026-09-24",
} as const;

/**
 * One image age check alone at the dated fallback table (658 in / 335 out tokens typical; ceilings 2.2K in / 1K out on grok-4.3): what the
 * Settings hint for the photo runs' own `imageAgeCheck` toggle quotes. Not part of an import (owner decision 2026-10-05); plan.test.ts pins it
 * against the real AGE_CHECK_CALL computation.
 */
export const AGE_CHECK_FALLBACK_PRICE = { expectedMicros: 1_660, worstMicros: 5_250 } as const;
