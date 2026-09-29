// The output verifier (plan slice 3a.7): a finished MP4 is accepted only if
// it is the engine's own output (invariant 14) with the exact length
// (invariant 20). Called on the temp file before the commit (Commit row,
// step 2).
export { AUDIO_OVER_MS, AUDIO_UNDER_MS, MOVIE_TOLERANCE_MS, VIDEO_TOLERANCE_MS } from "./structure";
export {
  MAX_OUTPUT_BYTES,
  MIN_FORBIDDEN_STRING_BYTES,
  VERIFY_REASON_CODES,
  VerifyIoError,
  type VerifyExpected,
  type VerifyOptions,
  type VerifyReason,
  type VerifyReasonCode,
  type VerifyResult,
} from "./types";
export { verifyAndHashMp4, verifyRenderedMp4, type VerifiedFile } from "./verifyMp4";
