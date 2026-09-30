import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { MASTER } from "../engine/face/fixtures/expected";
import { ffmpegPath } from "../node/ffmpegBinary";
import { POOL_IMAGE_WIDTH, servedPoolImagePng } from "./distinctPattern";

// T7b's own E2E proof (task item 4, the packaged-app smoke). Today the mock
// OpenRouter's run images (distinctPattern.ts's checkerboards and rotated
// stripes) carry no face at all, so with the face gate on, every
// front/three-quarter slot would retry then fail forever — the mock cannot
// prove the gate actually runs in a packaged app without serving something
// it can detect and match a face in. This module composites a real fixture
// face (studio/engine/face/fixtures) onto each of distinctPattern.ts's own
// PDQ-distinct backgrounds: distinctPattern.test.ts's own extension proves
// the result stays PDQ-distinct (the composite's low-frequency structure is
// dominated by the varying background, not the fixed face patch) AND is
// face-detectable/matching through the real gate — the same "one function
// both the mock and its own proof call" precedent distinctPattern.ts's own
// header names for servedPoolImagePng.

export const FIXTURES_DIR = join(import.meta.dirname, "..", "engine", "face", "fixtures", "images");
/** Composited into every mock run image (mockOpenRouter.ts's `faceFixture` option) and served as the mock avatar's own master/candidate portrait — real bytes on disk, the same fixture parity.test.ts already pins to the OpenCV/nativeImage numbers. */
export const FACE_FIXTURE_PATH = join(FIXTURES_DIR, MASTER.file);

/**
 * A fixed headshot-like framing within the pool's own POOL_IMAGE_WIDTH x
 * POOL_IMAGE_HEIGHT canvas (distinctPattern.ts): chosen once and checked
 * empirically (distinctPattern.test.ts's own extension) to keep every
 * composite's similarity to the master around 0.90 (well above the gate's
 * 0.55 hybrid threshold) while its own pairwise PDQ distance stays well
 * above the pool's own 40-bit bar.
 */
export const FACE_PATCH_WIDTH = 130;
export const FACE_PATCH_HEIGHT = 170;
export const FACE_PATCH_X = Math.round((POOL_IMAGE_WIDTH - FACE_PATCH_WIDTH) / 2);
export const FACE_PATCH_Y = 20;

/** Why an ffmpeg spawn failed: an empty stderr with a null status is a spawn that never ran to its end (a spawn error, EPIPE on the piped input, a timeout, a signal), and this says which. */
function spawnFailure(result: ReturnType<typeof spawnSync>): string {
  const code = result.error !== undefined && "code" in result.error ? String(result.error.code) : "none";
  const error = result.error === undefined ? "" : ` (${result.error.message})`;
  return `error ${code}${error}, status ${String(result.status)}, signal ${String(result.signal)}; stderr: ${result.stderr?.toString() ?? ""}`;
}

/**
 * Composites `faceImagePath` (a real image file on disk — this runs only in
 * the harness/test process, never in the engine, so a plain ffmpeg file
 * input is fine) onto `servedPoolImagePng(index)`'s own background via
 * ffmpeg's `overlay` filter: a real, valid, non-animated PNG (or, with
 * `format: "jpeg"`, a real baseline JPEG — L9: production's own image model
 * returns JPEG, and the mock served only PNG before this, so the packaged
 * E2E smoke never actually exercised the engine's WASM JPEG decode path,
 * only its PNG one).
 */
export function facePoolImagePng(index: number, faceImagePath: string = FACE_FIXTURE_PATH, format: "png" | "jpeg" = "png"): Uint8Array {
  const background = servedPoolImagePng(index);
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0",
    "-i", faceImagePath,
    "-filter_complex", `[1:v]scale=${FACE_PATCH_WIDTH}:${FACE_PATCH_HEIGHT}[face];[0:v][face]overlay=${FACE_PATCH_X}:${FACE_PATCH_Y}`,
    "-frames:v", "1",
    "-f", "image2pipe", "-c:v", format === "jpeg" ? "mjpeg" : "png",
    ...(format === "jpeg" ? ["-q:v", "3"] : []),
    "pipe:1",
  ];
  const result = spawnSync(ffmpegPath(), args, { input: Buffer.from(background), maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg (${ffmpegPath()}) could not composite a face pool image (index ${index}): ${spawnFailure(result)}`);
  }
  return new Uint8Array(result.stdout);
}

/**
 * L9: exactly `servedPoolImagePng(index)`'s own background, with NO face
 * composited — a deterministic, genuine "no face detected" for the real
 * gate (measured directly: `{ kind: "no-face", faces: 0 }`), unlike trying
 * to land a composited different-person's face in the gross-drift range by
 * luck (measured: the fixture impostor composited at this patch size scores
 * 0.647, comfortably inside "match" — the hybrid policy's own point is that
 * it does NOT reject a look-alike). `mockOpenRouter.ts`'s `faceMismatchOnce`
 * option serves this for exactly one pool slot, so exactly one run image is
 * a real, provable clear-failure the gate must retry. `format: "jpeg"`
 * re-encodes the same background as a real baseline JPEG (a plain ffmpeg
 * passthrough, no face filter) so it stays byte-consistent with the rest of
 * a JPEG-mode pool — the mock's own `media_type` must never claim a format
 * the bytes are not.
 */
export function facePoolNoFacePng(index: number, format: "png" | "jpeg" = "png"): Uint8Array {
  const background = servedPoolImagePng(index);
  if (format === "png") return background;
  const args = [
    "-hide_banner",
    "-loglevel", "error",
    "-f", "image2pipe", "-vcodec", "png", "-i", "pipe:0",
    "-frames:v", "1",
    "-f", "image2pipe", "-c:v", "mjpeg", "-q:v", "3",
    "pipe:1",
  ];
  const result = spawnSync(ffmpegPath(), args, { input: Buffer.from(background), maxBuffer: 32 * 1024 * 1024, timeout: 30_000 });
  if (result.status !== 0) {
    throw new Error(`ffmpeg (${ffmpegPath()}) could not re-encode a no-face pool image (index ${index}) as JPEG: ${spawnFailure(result)}`);
  }
  return new Uint8Array(result.stdout);
}
