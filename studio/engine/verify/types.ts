// The output verifier's public types (plan slice 3a.7). Reasons are stable
// codes: callers (the commit in 3a.8b, the packaged smoke in 3a.9) branch on
// `code`, and `message` is for the log only.

export const VERIFY_REASON_CODES = [
  // I/O bounds
  "FILE_TOO_LARGE",
  "FILE_TRUNCATED",
  // The box walk
  "BOX_OUT_OF_BOUNDS",
  "BOX_BAD_SIZE",
  "BOX_ZERO_SIZE",
  "BOX_TOO_LARGE",
  "TOO_MANY_BOXES",
  "STRUCTURE_UNRECOGNISED",
  "MISSING_BOX",
  "DUPLICATE_BOX",
  "FTYP_NOT_FIRST",
  "NOT_FASTSTART",
  // The metadata allowlist (invariant 14)
  "UNKNOWN_BOX",
  "UUID_BOX",
  "XMP_BOX",
  "PROVENANCE_BOX",
  "CHAPTER_BOX",
  "EXIF_BOX",
  "LOCATION_BOX",
  "DATE_BOX",
  "FREE_BOX_NOT_EMPTY",
  "FTYP_BRAND_NOT_ALLOWED",
  "METADATA_KEY_NOT_ALLOWED",
  "METADATA_VALUE_NOT_ALLOWED",
  "NONZERO_TIMESTAMP",
  "FIELD_NOT_CANONICAL",
  "TEXT_IN_INDEX",
  "SOURCE_METADATA_STRING",
  // The structure (invariant 20, A4)
  "UNEXPECTED_TRACKS",
  "MISSING_TRACK",
  "VIDEO_FORMAT_WRONG",
  "AUDIO_FORMAT_WRONG",
  "COLOUR_TAG_WRONG",
  "FRAME_COUNT_MISMATCH",
  "MEDIA_DATA_MISMATCH",
  "DURATION_MISMATCH",
] as const;

export type VerifyReasonCode = (typeof VERIFY_REASON_CODES)[number];

export interface VerifyReason {
  readonly code: VerifyReasonCode;
  /** Human-readable, for the log. Quotes at most 32 characters of any file value and never a caller's `forbiddenStrings`. */
  readonly message: string;
  /** The box path the reason is about (`moov/trak/mdia/hdlr`), when there is one. */
  readonly path?: string;
}

export type VerifyResult = { readonly ok: true } | { readonly ok: false; readonly reasons: readonly VerifyReason[] };

export interface VerifyExpected {
  /** The exact number of video frames: the sum of the timeline's frames (invariant 20). */
  readonly frames: number;
  /**
   * Strings that must not appear anywhere in the file, for example the EXIF
   * Artist or Copyright of the source photos. Each must be at least
   * `MIN_FORBIDDEN_STRING_BYTES` long, or a chance match in the video data
   * would fail a clean file.
   */
  readonly forbiddenStrings?: readonly string[];
}

export interface VerifyOptions {
  /** Refuse (as `FILE_TOO_LARGE`) a file above this many bytes. Defaults to `MAX_OUTPUT_BYTES`. */
  readonly maxBytes?: number;
}

/**
 * The most a valid output can weigh, with headroom. The longest timeline is 15 s; at the 3500 kbit/s
 * VBV cap that is 6.6 MB, plus one 7000 kbit buffer (0.9 MB) and 192 kbit/s audio (0.4 MB): about
 * 7.8 MB. 64 MiB is 8 times that, and bounds what the whole-file string scan has to read.
 */
export const MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

/** A forbidden string shorter than this is refused as a caller mistake. */
export const MIN_FORBIDDEN_STRING_BYTES = 6;

/** Thrown for a problem with the file itself, never for a problem in its content. */
export class VerifyIoError extends Error {
  constructor(
    readonly kind: "not_found" | "not_a_file" | "read_failed",
    readonly path: string,
    options?: { cause?: unknown }
  ) {
    super(`cannot read ${path}: ${kind}`, options);
    this.name = "VerifyIoError";
  }
}
