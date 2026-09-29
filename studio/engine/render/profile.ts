import { FPS } from "../../shared/montage";

// The fixed encoder and colour settings (plan: "Fixed decisions", rows Output
// format, Render pipeline, Metadata; SP1). Constants, so a test can pin each
// and the graph builders share one source.
//
// Invariant 20: nothing here terminates an output by `-frames:v`, `-t` or
// `-shortest`. Length comes from the graph (exact frame counts, exact audio
// samples), and the runner and verifier check it.

/** Every ffmpeg call caps the filter threads, so pass-1 memory stops depending on the core count (SP1). */
export const FILTER_THREAD_ARGS: readonly string[] = ["-filter_threads", "2", "-filter_complex_threads", "2"];

/** The encoder's tags: BT.709, limited range. */
export const COLOUR_TAG_ARGS: readonly string[] = ["-colorspace", "bt709", "-color_primaries", "bt709", "-color_trc", "bt709", "-color_range", "tv"];

/**
 * Tags the frames BT.709 limited range. It goes AFTER the swscale conversion
 * (which strips or rewrites the tags) and before anything that reads them,
 * such as `zscale`, which fails on untagged frames (SP3).
 */
export const FRAME_TAGS = "setparams=colorspace=bt709:color_primaries=bt709:color_trc=bt709:range=tv";

/**
 * A photo (a full-range BT.601 JPEG, `yuvj420p(pc, bt470bg)`) to limited-range
 * BT.709 4:2:0, tagged. SP1 measured it within 0.96 / 1.60 / 1.54 code values
 * (Y/Cb/Cr) of the exact BT.709 value on a chart; a bare `format=yuv420p`
 * is up to 27.6 codes off (invariant 36).
 */
export const PHOTO_COLOUR_CHAIN = `scale=in_range=pc:in_color_matrix=bt601:out_range=tv:out_color_matrix=bt709,format=yuv420p,${FRAME_TAGS}`;

/**
 * An RGBA overlay (a text PNG, a sticker, an APNG) to limited-range BT.709
 * with alpha. Left to the auto-inserted scaler it would be converted with the
 * BT.601 matrix and drift up to 14.6 codes (invariant 36).
 */
export const OVERLAY_COLOUR_CHAIN = "format=rgba,scale=in_range=full:out_range=tv:out_color_matrix=bt709,format=yuva420p";

/** The pass-1 intermediate: near-lossless x264 (CRF 8, ultrafast), on 2 threads, constant 30 fps, tagged. */
export const INTERMEDIATE_VIDEO_ARGS: readonly string[] = [
  "-c:v", "libx264", "-preset", "ultrafast", "-crf", "8", "-pix_fmt", "yuv420p",
  ...COLOUR_TAG_ARGS,
  "-r", String(FPS), "-fps_mode", "cfr", "-threads", "2",
];

/** The delivered video: H.264 High, medium, CRF 20 under a 3500k cap with a 2 s VBV window, 2 s GOP, constant 30 fps, tagged. */
export const FINAL_VIDEO_ARGS: readonly string[] = [
  "-c:v", "libx264", "-profile:v", "high", "-preset", "medium", "-crf", "20",
  "-maxrate", "3500k", "-bufsize", "7000k", "-g", "60", "-keyint_min", "30", "-threads", "2",
  "-pix_fmt", "yuv420p",
  ...COLOUR_TAG_ARGS,
  "-r", String(FPS), "-fps_mode", "cfr",
];

/** The delivered audio: AAC-LC (the native encoder), 48 kHz stereo, 192 kbit/s. */
export const FINAL_AUDIO_ARGS: readonly string[] = ["-c:a", "aac", "-b:a", "192k", "-ar", "48000", "-ac", "2"];

/** MP4 with the index up front. */
export const CONTAINER_ARGS: readonly string[] = ["-movflags", "+faststart"];

/**
 * The metadata rule (invariant 14): nothing is copied from any input, and
 * there are no chapters. No `bitexact` (the encoder's own signature is part of
 * the accepted engine identity) and no `creation_time`.
 */
export const METADATA_ARGS: readonly string[] = ["-map_metadata", "-1", "-map_chapters", "-1"];
