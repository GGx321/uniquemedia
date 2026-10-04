import { fileURLToPath } from "node:url";

// The mezzanine fixture of 3f.3b, pinned by size and sha256 (`fixtures.test.ts` checks both). `generate.ts` makes it again (and prints the numbers below).
// Test-only: never imported by production code.

export interface MezzanineFixture {
  readonly file: string;
  readonly bytes: number;
  readonly sha256: string;
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  /** What the importer's record would say: `round(frames * 1000 / 30)`. */
  readonly durationMs: number;
}

/** 96 x 192, 90 frames, 3 s: frame `i` is a flat grey of luma `16 + 2 * i` (see `generate.ts`). */
export const RAMP: MezzanineFixture = {
  file: fileURLToPath(new URL("ramp-96x192-90f.mp4", import.meta.url)),
  bytes: 4273,
  sha256: "97e46623e2488f84c8dd36aa271c56d520eab6a53d4d4856a3172de993678735",
  width: 96,
  height: 192,
  frames: 90,
  durationMs: 3_000,
};
