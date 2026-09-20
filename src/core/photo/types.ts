import type { ExportFormat, Operation, PhotoCopyOptions } from "../types";

/**
 * An `EdgeMode` with `auto` already decided — and, for `fit`, the colour its
 * padding is filled with already measured off the image.
 *
 * The two travel together on purpose: a fit render without a colour would pad
 * with a default black that is right for one kind of picture and wrong for the
 * rest, and the mistake would only ever show up as a visible border on someone
 * else's screen. As a union it cannot be written down.
 */
export type ResolvedEdge = { mode: "crop" } | { mode: "fit"; padColor: string };

/**
 * What the photo sampler actually takes.
 *
 * `auto` has to be resolved where the pixels are, and the sampler is a pure
 * function of numbers that never opens a file. Replacing `edgeMode` with the
 * resolved form rather than adding beside it is what stops the sampler from
 * being handed an `auto` it has no way to answer.
 */
export interface ResolvedPhotoOptions extends Omit<PhotoCopyOptions, "edgeMode"> {
  edge: ResolvedEdge;
}

export type Subsampling = "420" | "444";

/** A still has no temporal axis: no segments, no fps/gop/CRF — just a spatial
 *  filter chain plus the JPEG encode, which is itself part of the fingerprint. */
export interface PhotoRecipe {
  seed: number;
  intensity: number; // 1.0 baseline; raised by the auto-strengthen loop
  exportFormat: ExportFormat;
  ops: Operation[];
  encode: { quality: number; subsampling: Subsampling };
}
