import { CAPTION_FINGERPRINT_LAYERS, CAPTION_LAYER_HASHES, hashOf } from "./fingerprint";
import type { CaptionRequest } from "./types";

/**
 * The caption known-answer test the engine runs at load, after the text self-test (selfTest.ts): ONE pinned caption with an
 * emoji, drawn through the same gate the engine's captions use. The text self-test draws no emoji, so without this the emoji
 * reader (opened inside the worker from the bundled font) would first be used by a person's caption. The other fourteen layers
 * of the fingerprint stay in the tests: they take seconds, this takes a few tens of milliseconds.
 */
export const CAPTION_SELF_TEST_KEY = "manrope/plaque";

/** Rejects, naming the layer and both hashes, when the gate does not draw the pinned caption to the pinned bytes; passes the gate's own failure through. */
export async function assertCaptionSelfTest(gate: { caption(request: CaptionRequest): Promise<{ png: Uint8Array }> }): Promise<void> {
  const layer = CAPTION_FINGERPRINT_LAYERS.find((entry) => entry.key === CAPTION_SELF_TEST_KEY);
  const expected = CAPTION_LAYER_HASHES[CAPTION_SELF_TEST_KEY];
  if (layer === undefined || expected === undefined) throw new Error(`caption self-test: no pinned layer ${CAPTION_SELF_TEST_KEY}`);
  const actual = hashOf((await gate.caption(layer.request)).png);
  if (actual !== expected) throw new Error(`caption self-test: ${CAPTION_SELF_TEST_KEY} drew ${actual}, expected ${expected}`);
}
