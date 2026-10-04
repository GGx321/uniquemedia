// Regenerates the mezzanine fixture of Stage 3's 3f.3b: `bun --no-env-file studio/engine/videos/testing/fixtures/generate.ts`.
//
// `ramp-96x192-90f.mp4` is a MEZZANINE, a file as the library stores an own video: made by 3f.3a's REAL importer (`createVideoImporter`), from 90 raw frames written here, so its
// content is exact. Frame `i` carries its number in binary as eight vertical stripes, black or white (`rampFrames`), which survives any lossy encode; a test reads a frame's number back
// (`frameNumbersOf`), and so can tell exactly WHICH frames a clip of it plays. 96 x 192 (a 1:2 portrait), 3 s, constant 30 fps, H.264 BT.709 limited, no audio.
// The bytes are pinned by size and sha256 in `index.ts`; run this on the machine that made them only when the importer's encode changes, and update `index.ts`.

import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { mezzanineOf, rampFrames } from "../mezzanineKit";

const here = fileURLToPath(new URL(".", import.meta.url));
const work = mkdtempSync(join(tmpdir(), "studio-mezzanine-fixtures-"));
try {
  const made = await mezzanineOf(work, "media-0000001", rampFrames(96, 192, 90));
  const bytes = readFileSync(made.path);
  writeFileSync(join(here, "ramp-96x192-90f.mp4"), bytes);
  console.log(`ramp-96x192-90f.mp4: ${bytes.byteLength} bytes, sha256 ${createHash("sha256").update(bytes).digest("hex")}, ${made.durationMs} ms`);
} finally {
  rmSync(work, { recursive: true, force: true });
}
